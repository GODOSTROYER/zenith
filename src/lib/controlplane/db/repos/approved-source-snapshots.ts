/** Owning PostgreSQL persistence; no HTTP, token or caller proof callback. */
import type { PlatformDbHandle } from "../executor";
import type { Sql } from "@/lib/controlplane/types";
import { isCapturedApprovedSource } from "@/lib/platform/source-bundle";
import type { LeaseRef } from "@/lib/workflows/types";
import { immutableSourceSnapshot, sourceSnapshotDigest, sourceSnapshotSetDigest, sourceRecipeMatches, type ApprovedSourceSnapshot, type SourceScope } from "@/lib/execution/source-snapshot";
import { StepFailedError } from "@/lib/execution/errors";

export interface ApprovedSourceSnapshotStore {
  list(scope: SourceScope): Promise<ApprovedSourceSnapshot[]>;
  assertReviewed(snapshot: ApprovedSourceSnapshot): Promise<void>;
  assertCurrent(snapshot: ApprovedSourceSnapshot): Promise<void>;
  retain(snapshot: ApprovedSourceSnapshot, lease: LeaseRef): Promise<ApprovedSourceSnapshot>;
}
const stores = new WeakSet<object>();
export const isApprovedSourceSnapshotStore = (store: unknown): store is ApprovedSourceSnapshotStore => !!store && typeof store === "object" && stores.has(store);
const refuse = (): never => { throw new StepFailedError("Approved source authority changed or is unavailable; a new operation and review may be required."); };
interface Row { snapshot: unknown; snapshot_digest: string }
function read(row: Row): ApprovedSourceSnapshot {
  const s = immutableSourceSnapshot(row.snapshot);
  if (sourceSnapshotDigest(s) !== row.snapshot_digest) refuse();
  return s;
}
function scoped(scope: SourceScope): readonly string[] {
  if (Object.keys(scope).sort().join(',') !== 'environmentId,operationId,projectId,workspaceId'
    || Object.values(scope).some(v => typeof v !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(v))) refuse();
  return [scope.workspaceId, scope.operationId, scope.projectId, scope.environmentId];
}
/** Both creation and invocation require the actual owning PostgreSQL adapter. */
export function createApprovedSourceSnapshotStore(db: PlatformDbHandle): ApprovedSourceSnapshotStore {
  const backend = () => { if (db.kind !== "postgres") refuse(); };
  backend();
  const list = async (sql: Sql, scope: SourceScope) => {
    const rows = await sql.query<Row>("select snapshot,snapshot_digest from platform.approved_source_snapshots where workspace_id=$1 and operation_id=$2 and project_id=$3 and environment_id=$4 order by service_address", scoped(scope));
    return rows.map(read);
  };
  const recipe=async(tx:Sql,s:ApprovedSourceSnapshot)=>{
    const rows=await tx.query<{address:string;kind:string;provider:string;region:string;spec_digest:string;spec:Record<string,unknown>;ownership:string}>("select address,kind,provider,region,spec_digest,spec,ownership from platform.resources where workspace_id=$1 and project_id=$2 and environment_id=$3 and address in ($4,$5) order by address for share",[s.workspaceId,s.projectId,s.environmentId,s.serviceAddress,s.pipelineAddress]);
    const service=rows.find(r=>r.address===s.serviceAddress),pipeline=rows.find(r=>r.address===s.pipelineAddress);
    if(rows.length!==2 || !service || !pipeline || !["container_service","scheduled_job"].includes(service.kind) || pipeline.kind!=="build_pipeline"
      || rows.some(r=>r.provider!==s.provider || r.region!==s.region || r.ownership!=="managed")
      || service.spec_digest!==s.serviceSpecDigest || pipeline.spec_digest!==s.pipelineSpecDigest
      || !sourceRecipeMatches(s,{...service,provider:s.provider,specDigest:service.spec_digest},{...pipeline,provider:s.provider,specDigest:pipeline.spec_digest}))refuse();
  };
  const authority = async (tx: Sql, s: ApprovedSourceSnapshot): Promise<void> => {
    await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`zenith:github-binding:${s.workspaceId}`]);
    const binding = await tx.query<{ app_id:string;installation_id:number;repository_id:number;version:number;revoked_at:unknown;owner:string;repo:string }>("select app_id,installation_id,repository_id,version,revoked_at,owner,repo from platform.github_source_bindings where workspace_id=$1 for share",[s.workspaceId]);
    const b = binding[0];
    if (s.githubBinding ? !b || b.revoked_at || b.app_id !== s.githubBinding.appId || Number(b.installation_id) !== s.githubBinding.installationId
      || Number(b.repository_id) !== s.repositoryId || Number(b.version) !== s.githubBinding.version || b.owner !== s.owner || b.repo !== s.repo : !!b) refuse();
  };
  const scopeOf = (s: ApprovedSourceSnapshot): SourceScope => ({workspaceId:s.workspaceId,operationId:s.operationId,projectId:s.projectId,environmentId:s.environmentId});
  const current=async(tx:Sql,input:ApprovedSourceSnapshot,reviewed:boolean)=>{
    const s=immutableSourceSnapshot(input);
    await tx.query("select id from platform.operations where workspace_id=$1 and id=$2 for update",[s.workspaceId,s.operationId]);
    await recipe(tx,s);await authority(tx,s);const rows=await list(tx,scopeOf(s));
    if(!rows.some(r=>sourceSnapshotDigest(r)===sourceSnapshotDigest(s)))refuse();
        const accepted=await tx.query(`select o.id from platform.operations o where o.workspace_id=$1 and o.id=$2 and o.project_id=$3 and o.environment_id=$4
          and o.status='running' and o.expires_at>clock_timestamp() and o.lease_holder='workflow:' || o.id and o.lease_until>clock_timestamp()
          and exists(select 1 from platform.leases l where l.workspace_id=$1 and l.scope=o.lease_scope and l.scope='env:' || $4
            and l.fence_token=o.fence_token and l.expires_at>clock_timestamp() and l.released_at is null)
          and exists(select 1 from platform.resources r where r.workspace_id=$1 and r.environment_id=$4 and r.project_id=$3 and r.address=$5 and r.spec_digest=$6 and r.provider=$7 and r.region=$8 and r.ownership='managed' and r.status<>'deleted')
          and exists(select 1 from platform.resources r where r.workspace_id=$1 and r.environment_id=$4 and r.project_id=$3 and r.address=$9 and r.spec_digest=$10 and r.provider=$7 and r.region=$8 and r.ownership='managed' and r.status<>'deleted')
          and (($11::text::jsonb='null'::jsonb and not exists(select 1 from platform.github_source_bindings b where b.workspace_id=$1))
            or exists(select 1 from platform.github_source_bindings b where b.workspace_id=$1 and b.revoked_at is null and b.owner=$12 and b.repo=$13
              and b.app_id=$11::text::jsonb->>'appId' and b.installation_id=($11::text::jsonb->>'installationId')::bigint
              and b.repository_id=($11::text::jsonb->>'repositoryId')::bigint and b.version=($11::text::jsonb->>'version')::integer))
          and ($14::text is null or exists(select 1 from platform.evidence e where e.workspace_id=$1 and e.operation_id=$2
            and e.kind='tofu_plan' and e.simulated=false and e.summary->>'stage'='plan' and e.digest=o.plan_digest and e.summary->>'planDigest'=o.plan_digest
            and e.summary->>'executableSourceDigest'=$14))`,
          [s.workspaceId,s.operationId,s.projectId,s.environmentId,s.serviceAddress,s.serviceSpecDigest,s.provider,s.region,s.pipelineAddress,s.pipelineSpecDigest,JSON.stringify(s.githubBinding),s.owner,s.repo,reviewed?sourceSnapshotSetDigest(rows):null]);
    if(accepted.length!==1)refuse();
  };
  const store: ApprovedSourceSnapshotStore = Object.freeze<ApprovedSourceSnapshotStore>({
    async assertReviewed(input) {backend();await db.tx(tx=>current(tx,input,true));},
    async assertCurrent(input) {backend();await db.tx(tx=>current(tx,input,false));},
    async list(scope) { backend(); return list(db, scope); },
    async retain(input, lease) {
      backend();
      if(!isCapturedApprovedSource(input)) refuse();
      const s = immutableSourceSnapshot(input), hash = sourceSnapshotDigest(s);
      if (lease.scope !== `env:${s.environmentId}` || !Number.isSafeInteger(lease.fenceToken) || lease.fenceToken < 1 || !lease.holder) refuse();
      return db.tx(async tx => {
        // Same operation -> resources order as provider dispatch; no external RPC under locks.
        await tx.query("select id from platform.operations where workspace_id=$1 and id=$2 for update", [s.workspaceId,s.operationId]);
        await recipe(tx,s);
        await authority(tx,s);
        const eligible=await tx.query(`select o.id from platform.operations o where o.workspace_id=$1 and o.id=$2 and o.project_id=$3 and o.environment_id=$4
          and o.lease_scope=$5 and o.fence_token=$6 and o.status='running' and o.expires_at>clock_timestamp()
          and o.lease_holder='workflow:' || o.id and o.lease_until>clock_timestamp()
          and exists(select 1 from platform.leases l where l.workspace_id=$1 and l.scope=$5 and l.holder=$7 and l.fence_token=$6 and l.expires_at>clock_timestamp() and l.released_at is null)
          and exists(select 1 from platform.resources r where r.workspace_id=$1 and r.environment_id=$4 and r.project_id=$3 and r.address=$8 and r.spec_digest=$9 and r.provider=$10 and r.region=$11 and r.ownership='managed' and r.status<>'deleted')
          and exists(select 1 from platform.resources r where r.workspace_id=$1 and r.environment_id=$4 and r.project_id=$3 and r.address=$12 and r.spec_digest=$13 and r.provider=$10 and r.region=$11 and r.ownership='managed' and r.status<>'deleted')
          and (($14::text::jsonb='null'::jsonb and not exists(select 1 from platform.github_source_bindings b where b.workspace_id=$1))
            or exists(select 1 from platform.github_source_bindings b where b.workspace_id=$1 and b.revoked_at is null and b.owner=$15 and b.repo=$16
              and b.app_id=$14::text::jsonb->>'appId' and b.installation_id=($14::text::jsonb->>'installationId')::bigint
              and b.repository_id=($14::text::jsonb->>'repositoryId')::bigint and b.version=($14::text::jsonb->>'version')::integer))`,
          [s.workspaceId,s.operationId,s.projectId,s.environmentId,lease.scope,lease.fenceToken,lease.holder,s.serviceAddress,s.serviceSpecDigest,s.provider,s.region,s.pipelineAddress,s.pipelineSpecDigest,JSON.stringify(s.githubBinding),s.owner,s.repo]);
        if(eligible.length!==1)refuse();
        const existing = (await list(tx,scopeOf(s))).find(r => r.serviceAddress === s.serviceAddress);
        if (existing) { if (sourceSnapshotDigest(existing) !== hash) refuse(); await current(tx,existing,false); return existing; }
        const rows = await tx.query<Row>(`insert into platform.approved_source_snapshots
          (workspace_id,operation_id,project_id,environment_id,service_address,snapshot,snapshot_digest)
          select $1,$2,$3,$4,$5,$6::text::jsonb,$7
          from platform.operations o where o.workspace_id=$1 and o.id=$2 and o.project_id=$3 and o.environment_id=$4
          and o.lease_scope=$8 and o.fence_token=$10 and o.status='running' and o.plan_digest is null and o.expires_at>clock_timestamp()
          and o.lease_holder='workflow:' || o.id and o.lease_until>clock_timestamp()
          and exists(select 1 from platform.leases l where l.workspace_id=$1 and l.scope=$8 and l.holder=$9 and l.fence_token=$10
            and l.expires_at>clock_timestamp() and l.released_at is null)
          and exists(select 1 from platform.resources r where r.workspace_id=$1 and r.environment_id=$4 and r.project_id=$3 and r.address=$5 and r.spec_digest=$11 and r.provider=$12 and r.region=$13 and r.ownership='managed' and r.status<>'deleted')
          and exists(select 1 from platform.resources r where r.workspace_id=$1 and r.environment_id=$4 and r.project_id=$3 and r.address=$14 and r.spec_digest=$15 and r.provider=$12 and r.region=$13 and r.ownership='managed' and r.status<>'deleted')
          and (($16::text::jsonb='null'::jsonb and not exists(select 1 from platform.github_source_bindings b where b.workspace_id=$1))
            or exists(select 1 from platform.github_source_bindings b where b.workspace_id=$1 and b.revoked_at is null and b.owner=$17 and b.repo=$18
              and b.app_id=$16::text::jsonb->>'appId' and b.installation_id=($16::text::jsonb->>'installationId')::bigint
              and b.repository_id=($16::text::jsonb->>'repositoryId')::bigint and b.version=($16::text::jsonb->>'version')::integer))
          on conflict(workspace_id,operation_id,service_address) do nothing returning snapshot,snapshot_digest`,
        [s.workspaceId,s.operationId,s.projectId,s.environmentId,s.serviceAddress,JSON.stringify(s),hash,lease.scope,lease.holder,lease.fenceToken,s.serviceSpecDigest,s.provider,s.region,s.pipelineAddress,s.pipelineSpecDigest,JSON.stringify(s.githubBinding),s.owner,s.repo]);
        if (rows.length !== 1) refuse();
        return read(rows[0]);
      });
    },
  });
  stores.add(store); return store;
}

/** Explicit isolated model only; never a production proof/admission port. */
export function createIsolatedApprovedSourceStoreForTests(model: ApprovedSourceSnapshotStore): ApprovedSourceSnapshotStore {
  const guard=()=>{if(process.env.NODE_ENV!=="test") refuse();}; guard();
  // Capture method identity at construction, not a mutable per-call proof callback.
  const list=model.list.bind(model),retain=model.retain.bind(model),assertCurrent=model.assertCurrent.bind(model),assertReviewed=model.assertReviewed.bind(model);
  const store=Object.freeze({assertReviewed:(s:ApprovedSourceSnapshot)=>{guard();return assertReviewed(s);},list:(scope:SourceScope)=>{guard();return list(scope);},retain:(s:ApprovedSourceSnapshot,l:LeaseRef)=>{guard();return retain(s,l);},assertCurrent:(s:ApprovedSourceSnapshot)=>{guard();return assertCurrent(s);}});
  stores.add(store);return store;
}
