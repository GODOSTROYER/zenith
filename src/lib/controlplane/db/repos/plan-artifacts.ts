/** Database-only transactions. Lock order is live environment fence, operation, artifact, use. */
import type { Sql } from "@/lib/controlplane/types";
import type { PlanArtifactManifest, PlanCustodyInput } from "@/lib/tofu/engine";
import type { Sealed } from "@/lib/secrets";
import type { DispatchApprovalSnapshot } from "@/lib/execution/ports";
import type { LeaseRef } from "@/lib/workflows/types";
import { executionHolder } from "@/lib/execution/platform";
import { digest } from "@/lib/controlplane/digest";
import { assertFence } from "./leases";
import { get } from "./operations";
import { setPlanDigest } from "@/lib/controlplane/operations/execution";
import * as evidence from "./evidence";

export class PlanArtifactError extends Error {
  readonly code = "plan_artifact_unavailable";
  constructor() { super("Reviewed plan artifact is unavailable or changed; a new review is required."); }
}
export interface ArtifactAccess { custody: PlanCustodyInput; planDigest: string; lease: LeaseRef }
export interface ArtifactRow {
  workspace_id: string; operation_id: string; manifest: PlanArtifactManifest; manifest_digest: string; plan_digest: string;
  iv: string; auth_tag: string; ciphertext: string; expires_at: string;
}
export interface PublishArtifact { manifest: Readonly<PlanArtifactManifest>; sealed: Sealed; lease: LeaseRef; evidence: evidence.InsertEvidenceInput }
function refuse(): never { throw new PlanArtifactError(); }
const CUSTODY_KEYS = ["workspaceId","projectId","environmentId","operationId","proposalDigest","inputDigest","expiresAt","sourceDigest","graphDigest"] as const;
function captured(input: ArtifactAccess): ArtifactAccess {
  return Object.freeze({ custody: Object.freeze({workspaceId:input.custody.workspaceId,projectId:input.custody.projectId,environmentId:input.custody.environmentId,operationId:input.custody.operationId,proposalDigest:input.custody.proposalDigest,inputDigest:input.custody.inputDigest,expiresAt:input.custody.expiresAt,sourceDigest:input.custody.sourceDigest,graphDigest:input.custody.graphDigest}), planDigest: input.planDigest,
    lease: Object.freeze({ scope:input.lease.scope,holder:input.lease.holder,fenceToken:input.lease.fenceToken }) });
}
async function lockOwner(tx: Sql, input: ArtifactAccess, requireDigest: boolean): Promise<void> {
  const { custody: c, lease } = input;
  if (lease.scope !== `env:${c.environmentId}` || !/^[a-f0-9]{64}$/.test(input.planDigest)) refuse();
  await assertFence(tx, lease.scope, lease.fenceToken);
  const ownedLease = await tx.query("select scope from platform.leases where scope=$1 and workspace_id=$2 and holder=$3", [lease.scope, c.workspaceId, lease.holder]);
  if (!ownedLease.length) refuse();
  const rows = await tx.query<{ live: boolean; claimed: boolean; holder: string | null; lease_scope: string | null; fence_token: number | null }>(`select expires_at > clock_timestamp() as live,
    status='running' and lease_until > clock_timestamp() as claimed, lease_holder as holder, lease_scope, fence_token from platform.operations where workspace_id=$1 and id=$2 for update`, [c.workspaceId, c.operationId]);
  if (!rows[0]?.live || !rows[0].claimed || rows[0].holder !== executionHolder(c.operationId)) refuse();
  const owner=rows[0];
  if ((owner.lease_scope === null) !== (owner.fence_token === null)) refuse();
  if (owner.lease_scope !== null && (owner.lease_scope !== lease.scope || owner.fence_token !== lease.fenceToken)) refuse();
  if (owner.lease_scope === null) {
    // The workflow claims before acquiring its env lease. Bind this live claim once; never replace a recorded fence.
    const bound = await tx.query<{lease_scope:string;fence_token:number}>(`update platform.operations set lease_scope=$3,fence_token=$4 where workspace_id=$1 and id=$2
      and status='running' and lease_scope is null and fence_token is null and lease_until > clock_timestamp() and lease_holder=$5 returning lease_scope,fence_token`,
      [c.workspaceId,c.operationId,lease.scope,lease.fenceToken,executionHolder(c.operationId)]);
    if (bound[0]?.lease_scope !== lease.scope || bound[0]?.fence_token !== lease.fenceToken) refuse();
  }
  const stillLive = await tx.query(`select id from platform.operations where workspace_id=$1 and id=$2 and status='running'
    and expires_at > clock_timestamp() and lease_until > clock_timestamp() and lease_holder=$3 and lease_scope=$4 and fence_token=$5`,
    [c.workspaceId,c.operationId,executionHolder(c.operationId),lease.scope,lease.fenceToken]);
  if (!stillLive.length) refuse();
  const op = await get(tx, c.workspaceId, c.operationId);
  if (!op || op.projectId !== c.projectId || op.environmentId !== c.environmentId || op.proposalDigest !== c.proposalDigest || op.inputDigest !== c.inputDigest
    || op.expiresAt !== c.expiresAt || op.status !== "running"
    || op.planDigest && op.planDigest !== input.planDigest || requireDigest && op.planDigest !== input.planDigest) refuse();
}
export async function publish(sql: Sql, input: PublishArtifact): Promise<ArtifactRow> {
  input = { manifest: Object.freeze(JSON.parse(JSON.stringify(input.manifest)) as PlanArtifactManifest), sealed: Object.freeze({...input.sealed}),
    lease: Object.freeze({...input.lease}), evidence: JSON.parse(JSON.stringify(input.evidence)) as evidence.InsertEvidenceInput };
  const m = input.manifest;
  return sql.tx(async (tx) => {
    await lockOwner(tx, { custody: m, planDigest: m.planDigest, lease: input.lease }, false);
    const existing = await tx.query<ArtifactRow>("select * from platform.plan_artifacts where workspace_id=$1 and operation_id=$2 for update", [m.workspaceId,m.operationId]);
    if (existing.length) {
      // Re-plans can have different binary bytes with identical approved meaning. The first immutable binary wins.
      const comparable = (manifest: Readonly<PlanArtifactManifest>) => { const { rawSha256: _raw, bytes: _bytes, ...bound } = manifest; return bound; };
      if (digest(comparable(existing[0].manifest)) !== digest(comparable(m))) refuse();
      return existing[0];
    }
    const written = await setPlanDigest(tx, { workspaceId:m.workspaceId,id:m.operationId,planDigest:m.planDigest });
    if (!written && (await get(tx,m.workspaceId,m.operationId))?.planDigest !== m.planDigest) refuse();
    if (input.evidence.workspaceId !== m.workspaceId || input.evidence.operationId !== m.operationId || input.evidence.digest !== m.planDigest
      || input.evidence.simulated || input.evidence.kind !== "tofu_plan" || input.evidence.summary.planDigest !== m.planDigest) refuse();
    await evidence.insert(tx, input.evidence);
    const rows = await tx.query<ArtifactRow>(`insert into platform.plan_artifacts
      (workspace_id,operation_id,manifest,manifest_digest,plan_digest,iv,auth_tag,ciphertext,expires_at)
      values ($1,$2,$3::text::jsonb,$4,$5,$6,$7,$8,$9::timestamptz) returning *`,
      [m.workspaceId,m.operationId,JSON.stringify(m),digest(m),m.planDigest,input.sealed.iv,input.sealed.authTag,input.sealed.ciphertext,m.expiresAt]);
    await tx.query("insert into platform.plan_artifact_uses (workspace_id,operation_id) values ($1,$2)", [m.workspaceId,m.operationId]);
    return rows[0];
  });
}
interface AssociationRow {
  workspace_id:string; operation_id:string; source_operation_id:string; source_evidence_id:string;
  source_manifest_digest:string; source_raw_sha256:string; proposal_digest:string; input_digest:string; expires_at:string;
}
export interface AssociateArtifact { workspaceId:string; sourceOperationId:string; destinationOperationId:string; sourceEvidenceId:string; planDigest:string; lease:LeaseRef }
async function lockOperations(tx:Sql, workspaceId:string, ids:readonly string[]) {
  for (const id of [...new Set(ids)].sort()) await tx.query("select id from platform.operations where workspace_id=$1 and id=$2 for update",[workspaceId,id]);
}
/** Source remains authoritative. Association never imports, copies or re-seals its bytes. */
export async function associate(sql:Sql,input:AssociateArtifact):Promise<ArtifactRow> {
  input=Object.freeze({...input,lease:Object.freeze({...input.lease})});
  return sql.tx(async tx => {
    await assertFence(tx,input.lease.scope,input.lease.fenceToken);
    await lockOperations(tx,input.workspaceId,[input.sourceOperationId,input.destinationOperationId]);
    const source=await get(tx,input.workspaceId,input.sourceOperationId);
    const destination=await get(tx,input.workspaceId,input.destinationOperationId);
    const intent=source?.proposal.input as {environmentId?:string;teardownReview?:boolean}|undefined;
    const ref=(destination?.proposal as {broker?:{destroyPlan?:{operationId?:string;evidenceId?:string}}}|undefined)?.broker?.destroyPlan;
    if (!source || !destination || source.id===destination.id || source.capability!=="infrastructure.plan" || !intent?.teardownReview
      || intent.environmentId!==source.environmentId || destination.capability!=="infrastructure.destroy" || destination.status!=="awaiting_approval"
      || destination.workspaceId!==source.workspaceId || destination.projectId!==source.projectId || destination.environmentId!==source.environmentId
      || ref?.operationId!==source.id || ref.evidenceId!==input.sourceEvidenceId || destination.planDigest!==input.planDigest || source.planDigest!==input.planDigest) refuse();
    const decisions=await tx.query(`select id from platform.approvals where workspace_id=$1 and operation_id=$2 and approval_round=(select approval_round from platform.operations where workspace_id=$1 and id=$2)`,[input.workspaceId,destination.id]);
    if (decisions.length) refuse();
    const rows=await tx.query<ArtifactRow>("select * from platform.plan_artifacts where workspace_id=$1 and operation_id=$2 and expires_at > clock_timestamp() for update",[input.workspaceId,source.id]);
    const row=rows[0];
    if (!row || row.manifest_digest!==digest(row.manifest) || row.manifest.purpose!=="destroy") refuse();
    await lockOwner(tx,{custody:row.manifest,planDigest:input.planDigest,lease:input.lease},true);
    const sourceEvidence=await tx.query("select id from platform.evidence where workspace_id=$1 and operation_id=$2 and id=$3 and digest=$4 and kind='tofu_plan' and simulated=false",[input.workspaceId,source.id,input.sourceEvidenceId,input.planDigest]);
    if (!sourceEvidence.length || Date.parse(destination.expiresAt)<=Date.now()) refuse();
    const association={workspace_id:input.workspaceId,operation_id:destination.id,source_operation_id:source.id,source_evidence_id:input.sourceEvidenceId,
      source_manifest_digest:row.manifest_digest,source_raw_sha256:row.manifest.rawSha256,proposal_digest:destination.proposalDigest,input_digest:destination.inputDigest,
      expires_at:new Date(Math.min(Date.parse(destination.expiresAt),Date.parse(row.expires_at))).toISOString()};
    const existing=await tx.query<AssociationRow>("select * from platform.plan_artifact_associations where workspace_id=$1 and operation_id=$2 for update",[input.workspaceId,destination.id]);
    if (existing.length) {
      if (Object.entries(association).some(([key,value])=>existing[0][key as keyof AssociationRow]!==value)) refuse();
      return row;
    }
    if ((await tx.query("select operation_id from platform.plan_artifacts where workspace_id=$1 and operation_id=$2",[input.workspaceId,destination.id])).length) refuse();
    await tx.query(`insert into platform.plan_artifact_associations (workspace_id,operation_id,source_operation_id,source_evidence_id,source_manifest_digest,source_raw_sha256,proposal_digest,input_digest,expires_at)
      select $1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz where exists (select 1 from platform.operations where workspace_id=$1 and id=$2 and status='awaiting_approval' and expires_at > clock_timestamp()) returning operation_id`,Object.values(association)).then(rows=>{if (!rows.length) refuse();});
    await tx.query("insert into platform.plan_artifact_uses (workspace_id,operation_id) values ($1,$2)",[input.workspaceId,destination.id]);
    return row;
  });
}
export async function read(sql: Sql, input: ArtifactAccess): Promise<ArtifactRow> {
  input = captured(input);
  return sql.tx(async (tx) => {
    const associations=await tx.query<AssociationRow>("select * from platform.plan_artifact_associations where workspace_id=$1 and operation_id=$2",[input.custody.workspaceId,input.custody.operationId]);
    const association=associations[0];
    await assertFence(tx,input.lease.scope,input.lease.fenceToken);
    await lockOperations(tx,input.custody.workspaceId,[input.custody.operationId,...(association?[association.source_operation_id]:[])]);
    await lockOwner(tx,input,true);
    const sourceId=association?.source_operation_id ?? input.custody.operationId;
    const rows = await tx.query<ArtifactRow>(`select a.* from platform.plan_artifacts a where workspace_id=$1 and operation_id=$2
      and plan_digest=$3 and expires_at > clock_timestamp() for update`, [input.custody.workspaceId,sourceId,input.planDigest]);
    const row = rows[0];
    if (!row || row.manifest_digest !== digest(row.manifest)) refuse();
    if (association) {
      const source=await get(tx,input.custody.workspaceId,sourceId);
      const destination=await get(tx,input.custody.workspaceId,input.custody.operationId);
      const result=source?.result as {operationId?:string;planDigest?:string}|undefined;
      const ref=(destination?.proposal as {broker?:{destroyPlan?:{operationId?:string;evidenceId?:string}}}|undefined)?.broker?.destroyPlan;
      const live=await tx.query("select operation_id from platform.plan_artifact_associations where workspace_id=$1 and operation_id=$2 and expires_at > clock_timestamp() for update",[input.custody.workspaceId,input.custody.operationId]);
      if (!live.length || !source || source.status!=="succeeded" || result?.operationId!==input.custody.operationId || result.planDigest!==input.planDigest
        || source.planDigest!==input.planDigest || source.proposalDigest!==row.manifest.proposalDigest || source.inputDigest!==row.manifest.inputDigest
        || source.expiresAt!==row.manifest.expiresAt || ref?.operationId!==sourceId || ref.evidenceId!==association.source_evidence_id
        || row.manifest_digest!==association.source_manifest_digest || row.manifest.rawSha256!==association.source_raw_sha256 || row.manifest.purpose!=="destroy"
        || input.custody.proposalDigest!==association.proposal_digest || input.custody.inputDigest!==association.input_digest) refuse();
    }
    const originalCustody=association?{...input.custody,operationId:row.manifest.operationId,proposalDigest:row.manifest.proposalDigest,inputDigest:row.manifest.inputDigest,expiresAt:row.manifest.expiresAt}:input.custody;
    if (CUSTODY_KEYS.some(key=>row.manifest[key]!==originalCustody[key])) refuse();
    return row;
  });
}
// Checked at the CAS itself: row locks serialize mutations, not passage of time.
const LIVE_USE_AUTHORITY = `exists (select 1 from platform.operations o join platform.leases l on l.scope=o.lease_scope
  where o.workspace_id=$1 and o.id=$2 and o.status='running' and o.expires_at > clock_timestamp() and o.lease_until > clock_timestamp()
  and o.lease_holder='workflow:' || o.id and o.lease_scope='env:' || o.environment_id and o.fence_token=$5
  and (not o.approval_required or exists (select 1 from platform.approvals approved
    where approved.workspace_id=o.workspace_id and approved.operation_id=o.id and approved.approval_round=o.approval_round
      and approved.proposal_digest=o.proposal_digest and approved.decision='approve' and approved.approver->>'kind'='user'
      and approved.consumed_at is not null and approved.expires_at > clock_timestamp())) and l.workspace_id=$1 and l.holder=$4 and l.fence_token=$5 and l.expires_at > clock_timestamp())
  and (exists (select 1 from platform.plan_artifacts a where a.workspace_id=$1 and a.operation_id=$2 and a.expires_at > clock_timestamp())
  or exists (select 1 from platform.plan_artifact_associations s join platform.plan_artifacts a on a.workspace_id=s.workspace_id and a.operation_id=s.source_operation_id
    where s.workspace_id=$1 and s.operation_id=$2 and s.expires_at > clock_timestamp() and a.expires_at > clock_timestamp()))`;
export async function claim(sql: Sql, input: ArtifactAccess, attemptId: string): Promise<ArtifactRow> {
  input = captured(input);
  return sql.tx(async (tx) => {
    const row = await read(tx,input);
    const changed = await tx.query(`update platform.plan_artifact_uses set phase='claimed',attempt_id=$3,holder=$4,fence_token=$5,updated_at=clock_timestamp()
      where workspace_id=$1 and operation_id=$2 and phase='ready' and (${LIVE_USE_AUTHORITY}) returning operation_id`,
      [input.custody.workspaceId,input.custody.operationId,attemptId,input.lease.holder,input.lease.fenceToken]);
    if (!changed.length) refuse();
    return row;
  });
}
export async function dispatch(sql: Sql, input: ArtifactAccess, attemptId: string, authority?: Readonly<DispatchApprovalSnapshot>): Promise<void> {
  if(authority) {
    authority=Object.freeze({...authority,approvalIds:Object.freeze([...authority.approvalIds])});
    if(authority.proposalDigest!==input.custody.proposalDigest || authority.planDigest!==input.planDigest || !Number.isInteger(authority.approvalRound)
      || !Number.isInteger(authority.requiredApprovalCount) || authority.requiredApprovalCount<0 || authority.approvalIds.length<authority.requiredApprovalCount) refuse();
  }
  input = captured(input);
  await sql.tx(async (tx) => {
    await read(tx,input);
    const changed = await tx.query(`update platform.plan_artifact_uses set phase='dispatched',updated_at=clock_timestamp()
      where workspace_id=$1 and operation_id=$2 and phase='claimed' and attempt_id=$3 and holder=$4 and fence_token=$5 and (${LIVE_USE_AUTHORITY})
      and ($6::text::jsonb is null or exists (select 1 from platform.operations o where o.workspace_id=$1 and o.id=$2
        and o.approval_round=($6::text::jsonb->>'approvalRound')::integer and o.proposal_digest=$6::text::jsonb->>'proposalDigest'
        and o.plan_digest=$6::text::jsonb->>'planDigest'
        and (select count(distinct a.approver_id) from platform.approvals a where a.workspace_id=$1 and a.operation_id=$2
          and a.id in (select jsonb_array_elements_text($6::text::jsonb->'approvalIds')) and a.decision='approve'
          and a.approver->>'kind'='user' and a.approval_round=o.approval_round and a.proposal_digest=o.proposal_digest
          and a.consumed_at is not null and a.expires_at > clock_timestamp()) >= ($6::text::jsonb->>'requiredApprovalCount')::integer
        and not exists (select 1 from platform.approvals a where a.workspace_id=$1 and a.operation_id=$2 and a.approval_round=o.approval_round and a.decision='reject')))
      returning operation_id`,
      [input.custody.workspaceId,input.custody.operationId,attemptId,input.lease.holder,input.lease.fenceToken,authority?JSON.stringify(authority):null]);
    if (!changed.length) refuse();
  });
}
/** Completion never reopens a dispatched attempt, even when its operation/fence has expired. */
export async function finish(sql: Sql, input: ArtifactAccess, attemptId: string, success: boolean): Promise<void> {
  input = captured(input);
  const update=async(tx:Sql)=> {
    const rows = await tx.query<{phase:string}>(`update platform.plan_artifact_uses set phase=case when phase='claimed' then 'ready' when $6::boolean then 'succeeded' else 'uncertain' end,
      updated_at=clock_timestamp() where workspace_id=$1 and operation_id=$2 and attempt_id=$3 and holder=$4 and fence_token=$5
      and phase in ('claimed','dispatched') and (not $6::boolean or phase='dispatched') and (not $6::boolean or (${LIVE_USE_AUTHORITY})) returning phase`,
      [input.custody.workspaceId,input.custody.operationId,attemptId,input.lease.holder,input.lease.fenceToken,success]);
    if (success && rows[0]?.phase !== "succeeded") refuse();
  };
  if (success) await sql.tx(async tx=>{await read(tx,input);await update(tx);});
  else await update(sql);
}
/** Logical expiry only. No ciphertext or legacy file is physically removed. */
export async function expire(sql: Sql, limit=100): Promise<number> {
  const candidates = await sql.query<{workspace_id:string;operation_id:string;source_operation_id:string}>(`select a.workspace_id,a.operation_id,a.operation_id as source_operation_id
    from platform.plan_artifacts a join platform.plan_artifact_uses u using(workspace_id,operation_id)
    where a.expires_at <= clock_timestamp() and u.phase in ('ready','claimed','dispatched')
    union all select a.workspace_id,a.operation_id,a.source_operation_id from platform.plan_artifact_associations a
    join platform.plan_artifact_uses u using(workspace_id,operation_id) where a.expires_at <= clock_timestamp() and u.phase in ('ready','claimed','dispatched')
    order by workspace_id,operation_id limit $1::bigint`, [Math.max(1,Math.min(1000,limit))]);
  let count=0;
  for (const c of candidates) count += await sql.tx(async tx => {
    // Maintenance needs no live authority, but follows the same fence-before-row lock order.
    const scopes=await tx.query<{lease_scope:string}>("select distinct lease_scope from platform.operations where workspace_id=$1 and id in ($2,$3) and lease_scope is not null order by lease_scope",[c.workspace_id,c.operation_id,c.source_operation_id]);
    for (const {lease_scope} of scopes) await tx.query("select scope from platform.leases where scope=$1 for update",[lease_scope]);
    await lockOperations(tx,c.workspace_id,[c.operation_id,c.source_operation_id]);
    await tx.query("select operation_id from platform.plan_artifacts where workspace_id=$1 and operation_id=$2 for update",[c.workspace_id,c.source_operation_id]);
    if (c.source_operation_id!==c.operation_id) await tx.query("select operation_id from platform.plan_artifact_associations where workspace_id=$1 and operation_id=$2 for update",[c.workspace_id,c.operation_id]);
    const changed = await tx.query(`update platform.plan_artifact_uses set phase=case when phase='dispatched' then 'uncertain' else 'expired' end,updated_at=clock_timestamp()
      where workspace_id=$1 and operation_id=$2 and phase in ('ready','claimed','dispatched') returning operation_id`,[c.workspace_id,c.operation_id]);
    return changed.length;
  });
  return count;
}
