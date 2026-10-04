/** Database-only transactions. Lock order is live environment fence, operation, artifact, ordered source resources, use. */
import { TERMINAL_OPERATION_STATUSES, type Sql } from "@/lib/controlplane/types";
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
import { projectPlanReview } from "./operation-review";
import type { ApprovedSourceSnapshot } from "@/lib/execution/source-snapshot";
import { textArray } from "../sql";
import { ControlStoreError } from "../errors";
import { retainPublishedPlanProductAuthority, retainClaimedPlanProductAuthority, captureClaimedPlanProductAuthority,
  claimedPlanRequiresProductComposition, withCurrentPlanDispatchRequirement, planProductDispatchPredicate, type PlanProductDispatchAuthority } from "./plan-artifact-product-authority";
import { assertFinalMcpProductTopology } from "./workflow-start-deploy-authority";

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
    try { await retainPublishedPlanProductAuthority(tx, rows[0]); } catch { refuse(); }
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

interface SourceDispatchAuthority {
  operationId: string; projectId: string; environmentId: string; manifestDigest: string; planDigest: string;
  sources: readonly ApprovedSourceSnapshot[];
  recipes: readonly { snapshot: ApprovedSourceSnapshot; snapshotDigest: string; serviceSpec: Record<string, unknown>; pipelineSpec: Record<string, unknown> }[];
  setDigest: string | null;
  evidence: { id: string; summary: Record<string, unknown> } | null;
}
const SOURCE_VIEW_FIELDS = ["executableSourceDigest", "approvedSources", "approvedSourcesTruncated", "approvedSourcesOmitted"] as const;
function sourceFields(summary: Record<string, unknown>): boolean {
  return Object.hasOwn(summary, "executableSourceDigest") || !!summary.view && typeof summary.view === "object"
    && SOURCE_VIEW_FIELDS.some(key => Object.hasOwn(summary.view as object, key));
}
/** Derived from the original owning rows after current roles, never from an apply caller or a proof callback. */
async function captureSourceDispatch(tx: Sql, row: ArtifactRow): Promise<SourceDispatchAuthority> {
  const m = row.manifest;
  const native = await tx.query<{ project_id: string; environment_id: string; service_address: string; snapshot: unknown; snapshot_digest: string }>(
    "select project_id,environment_id,service_address,snapshot,snapshot_digest from platform.approved_source_snapshots where workspace_id=$1 and operation_id=$2 order by service_address collate \"C\" limit 10001",
    [m.workspaceId, m.operationId]);
  if (native.length > 10000) refuse();
  const reviews = await tx.query<{ id: string; summary: Record<string, unknown> }>(`select id,summary from platform.evidence
    where workspace_id=$1 and operation_id=$2 and kind='tofu_plan' and not simulated and digest=$3 and summary->>'stage'='plan'
    order by created_at,id`, [m.workspaceId, m.operationId, row.plan_digest]);
  const bound = native.length > 0 || reviews.some(review => sourceFields(review.summary));
  const base = { operationId: m.operationId, projectId: m.projectId, environmentId: m.environmentId,
    manifestDigest: row.manifest_digest, planDigest: row.plan_digest };
  // Historical source-free custody is admitted only after querying native absence and every matching original review.
  if (!bound) return { ...base, sources: [], recipes: [], setDigest: null, evidence: null };
  const { immutableSourceSnapshot, sourceSnapshotDigest, sourceSnapshotSetDigest, sourceRecipeMatches } = await import("@/lib/execution/source-snapshot");
  const sources = native.map(value => {
    let snapshot: ApprovedSourceSnapshot;
    try { snapshot = immutableSourceSnapshot(value.snapshot); } catch { refuse(); }
    if (snapshot.workspaceId !== m.workspaceId || snapshot.operationId !== m.operationId || snapshot.projectId !== m.projectId
      || snapshot.environmentId !== m.environmentId || value.project_id !== m.projectId || value.environment_id !== m.environmentId
      || value.service_address !== snapshot.serviceAddress || sourceSnapshotDigest(snapshot) !== value.snapshot_digest) refuse();
    return snapshot;
  }).sort((a, b) => a.serviceAddress < b.serviceAddress ? -1 : a.serviceAddress > b.serviceAddress ? 1 : 0);
  if (!sources.length) refuse();
  const original = reviews[0], review = original && projectPlanReview(original.summary, row.plan_digest);
  const setDigest = sourceSnapshotSetDigest(sources);
  const displayed = sources.slice(0,64).map(snapshot => ({ service: snapshot.serviceAddress, commit: snapshot.commitSha,
    dockerfileDigest: snapshot.dockerfileDigest, recipeDigest: snapshot.recipeDigest, archiveDigest: snapshot.archiveDigest, archiveFormat: snapshot.archiveFormat }));
  if (!original || !review || review.view.executableSourceDigest !== setDigest
    || JSON.stringify(review.view.approvedSources) !== JSON.stringify(displayed)
    || review.view.approvedSourcesTruncated !== (sources.length > 64 ? true : undefined)
    || review.view.approvedSourcesOmitted !== (sources.length > 64 ? sources.length - 64 : undefined)) refuse();
  const addresses = [...new Set(sources.flatMap(snapshot => [snapshot.serviceAddress, snapshot.pipelineAddress]))].sort();
  const resources = await tx.query<{ address: string; kind: string; provider: string; region: string; spec_digest: string; spec: Record<string, unknown>; ownership: string; status: string }>(
    "select address,kind,provider,region,spec_digest,spec,ownership,status from platform.resources where workspace_id=$1 and project_id=$2 and environment_id=$3 and address=any($4::text[]) order by address for share",
    [m.workspaceId, m.projectId, m.environmentId, textArray(addresses)]);
  const bindings = await tx.query<{ app_id: string; installation_id: number; repository_id: number; version: number; owner: string; repo: string; revoked_at: unknown }>(
    "select app_id,installation_id,repository_id,version,owner,repo,revoked_at from platform.github_source_bindings where workspace_id=$1", [m.workspaceId]);
  const current = bindings[0];
  const recipes = sources.map(snapshot => {
    const service = resources.find(resource => resource.address === snapshot.serviceAddress), pipeline = resources.find(resource => resource.address === snapshot.pipelineAddress);
    if (!service || !pipeline || !["container_service", "scheduled_job"].includes(service.kind) || pipeline.kind !== "build_pipeline"
      || [service, pipeline].some(resource => resource.provider !== snapshot.provider || resource.region !== snapshot.region
        || resource.ownership !== "managed" || resource.status === "deleted")
      || service.spec_digest !== snapshot.serviceSpecDigest || pipeline.spec_digest !== snapshot.pipelineSpecDigest
      || !sourceRecipeMatches(snapshot, { ...service, provider: snapshot.provider, specDigest: service.spec_digest },
        { ...pipeline, provider: snapshot.provider, specDigest: pipeline.spec_digest })) refuse();
    const remembered = snapshot.githubBinding;
    if (remembered ? !current || current.revoked_at || current.app_id !== remembered.appId
      || Number(current.installation_id) !== remembered.installationId || Number(current.repository_id) !== remembered.repositoryId
      || Number(current.version) !== remembered.version || current.owner !== snapshot.owner || current.repo !== snapshot.repo : !!current) refuse();
    return { snapshot, snapshotDigest: sourceSnapshotDigest(snapshot), serviceSpec: service.spec, pipelineSpec: pipeline.spec };
  });
  return { ...base, sources, recipes, setDigest, evidence: original };
}
// This parameter is produced only by captureSourceDispatch in this transaction. Every current predicate is repeated in the final statement.
const DISPATCH_SOURCE_AUTHORITY = `exists(select 1 from platform.plan_artifacts a where a.workspace_id=$1
    and a.operation_id=$7::text::jsonb->>'operationId' and a.manifest_digest=$7::text::jsonb->>'manifestDigest'
    and a.plan_digest=$7::text::jsonb->>'planDigest')
  and coalesce((select jsonb_agg(a.snapshot order by a.service_address collate "C") from platform.approved_source_snapshots a
    where a.workspace_id=$1 and a.operation_id=$7::text::jsonb->>'operationId'),'[]'::jsonb)=$7::text::jsonb->'sources'
  and (($7::text::jsonb->>'setDigest' is null and not exists(select 1 from platform.evidence e where e.workspace_id=$1
    and e.operation_id=$7::text::jsonb->>'operationId' and e.kind='tofu_plan' and not e.simulated and e.digest=$7::text::jsonb->>'planDigest'
    and e.summary->>'stage'='plan' and (e.summary ? 'executableSourceDigest'
      or e.summary->'view' ?| array['executableSourceDigest','approvedSources','approvedSourcesTruncated','approvedSourcesOmitted'])))
    or ($7::text::jsonb->>'setDigest' is not null and exists(select 1 from platform.evidence e where e.workspace_id=$1
      and e.operation_id=$7::text::jsonb->>'operationId' and e.id=$7::text::jsonb->'evidence'->>'id'
      and e.kind='tofu_plan' and not e.simulated and e.digest=$7::text::jsonb->>'planDigest' and e.summary=$7::text::jsonb->'evidence'->'summary'
      and e.summary->>'stage'='plan' and e.summary->>'planDigest'=$7::text::jsonb->>'planDigest'
      and e.summary->>'executableSourceDigest'=$7::text::jsonb->>'setDigest')))
  and not exists(select 1 from jsonb_array_elements($7::text::jsonb->'recipes') recipe where
    not exists(select 1 from platform.approved_source_snapshots a where a.workspace_id=$1
      and a.operation_id=$7::text::jsonb->>'operationId' and a.project_id=$7::text::jsonb->>'projectId'
      and a.environment_id=$7::text::jsonb->>'environmentId' and a.service_address=recipe->'snapshot'->>'serviceAddress'
      and a.snapshot=recipe->'snapshot' and a.snapshot_digest=recipe->>'snapshotDigest')
    or not exists(select 1 from platform.resources r where r.workspace_id=$1 and r.project_id=$7::text::jsonb->>'projectId'
      and r.environment_id=$7::text::jsonb->>'environmentId' and r.address=recipe->'snapshot'->>'serviceAddress'
      and r.kind in ('container_service','scheduled_job') and r.spec_digest=recipe->'snapshot'->>'serviceSpecDigest'
      and r.spec=recipe->'serviceSpec' and r.provider=recipe->'snapshot'->>'provider' and r.region=recipe->'snapshot'->>'region'
      and r.ownership='managed' and r.status<>'deleted')
    or not exists(select 1 from platform.resources r where r.workspace_id=$1 and r.project_id=$7::text::jsonb->>'projectId'
      and r.environment_id=$7::text::jsonb->>'environmentId' and r.address=recipe->'snapshot'->>'pipelineAddress'
      and r.kind='build_pipeline' and r.spec_digest=recipe->'snapshot'->>'pipelineSpecDigest' and r.spec=recipe->'pipelineSpec'
      and r.provider=recipe->'snapshot'->>'provider' and r.region=recipe->'snapshot'->>'region' and r.ownership='managed' and r.status<>'deleted')
    or not ((recipe->'snapshot'->'githubBinding'='null'::jsonb and not exists(select 1 from platform.github_source_bindings b where b.workspace_id=$1))
      or exists(select 1 from platform.github_source_bindings b where b.workspace_id=$1 and b.revoked_at is null
        and b.owner=recipe->'snapshot'->>'owner' and b.repo=recipe->'snapshot'->>'repo'
        and b.app_id=recipe->'snapshot'->'githubBinding'->>'appId'
        and b.installation_id=(recipe->'snapshot'->'githubBinding'->>'installationId')::bigint
        and b.repository_id=(recipe->'snapshot'->'githubBinding'->>'repositoryId')::bigint
        and b.version=(recipe->'snapshot'->'githubBinding'->>'version')::integer)))`;
export async function claim(sql: Sql, input: ArtifactAccess, attemptId: string): Promise<ArtifactRow> {
  input = captured(input);
  return sql.tx(async (tx) => {
    const row = await read(tx,input);
    let productAuthority: PlanProductDispatchAuthority;
    try { productAuthority = await retainClaimedPlanProductAuthority(tx, row, input.custody.operationId, attemptId); } catch { return refuse(); }
    const owned = await tx.query(`select operation_id from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2 and phase='ready' for update`,
      [input.custody.workspaceId,input.custody.operationId]);
    if (owned.length !== 1) refuse();
    if (productAuthority.kind === "product") {
      try { await assertFinalMcpProductTopology(sql, tx); } catch { return refuse(); }
    }
    const changed = await tx.query(`update platform.plan_artifact_uses set phase='claimed',attempt_id=$3,holder=$4,fence_token=$5,updated_at=clock_timestamp()
      where workspace_id=$1 and operation_id=$2 and phase='ready' and (${LIVE_USE_AUTHORITY})
      and $6::text is null and $7::text is null
      and (${planProductDispatchPredicate(productAuthority)}) returning operation_id`,
      [input.custody.workspaceId,input.custody.operationId,attemptId,input.lease.holder,input.lease.fenceToken,null,null,JSON.stringify(productAuthority)]);
    if (!changed.length) refuse();
    return row;
  });
}
export async function dispatch(sql: Sql, input: ArtifactAccess, attemptId: string, authority?: Readonly<DispatchApprovalSnapshot>): Promise<void> {
  const originatedAuthority = authority;
  if(authority) {
    authority=Object.freeze({...authority,approvalIds:Object.freeze([...authority.approvalIds])});
    if(authority.proposalDigest!==input.custody.proposalDigest || authority.planDigest!==input.planDigest || !Number.isInteger(authority.approvalRound)
      || !Number.isInteger(authority.requiredApprovalCount) || authority.requiredApprovalCount<0 || authority.approvalIds.length<authority.requiredApprovalCount) refuse();
  }
  input = captured(input);
  await sql.tx(async (tx) => {
    const row = await read(tx,input);
    const sourceAuthority = await captureSourceDispatch(tx,row);
    let productAuthority: PlanProductDispatchAuthority;
    try { productAuthority = await captureClaimedPlanProductAuthority(tx, row, input.custody.operationId, attemptId); } catch { return refuse(); }
    // A separate post-wait statement must see revocation committed while this owning use row was blocked.
    const owned = await tx.query(`select operation_id from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2
      and phase='claimed' and attempt_id=$3 and holder=$4 and fence_token=$5 for update`,
      [input.custody.workspaceId,input.custody.operationId,attemptId,input.lease.holder,input.lease.fenceToken]);
    if (owned.length !== 1) refuse();
    if (productAuthority.kind === "product") {
      try { await assertFinalMcpProductTopology(sql, tx); } catch { return refuse(); }
      try { productAuthority = await withCurrentPlanDispatchRequirement(sql, productAuthority, originatedAuthority); } catch { return refuse(); }
    }
    const changed = await tx.query(`update platform.plan_artifact_uses set phase='dispatched',updated_at=clock_timestamp()
      where workspace_id=$1 and operation_id=$2 and phase='claimed' and attempt_id=$3 and holder=$4 and fence_token=$5 and (${LIVE_USE_AUTHORITY})
      and (${DISPATCH_SOURCE_AUTHORITY})
      and (${planProductDispatchPredicate(productAuthority)})
      and ($6::text::jsonb is null or exists (select 1 from platform.operations o where o.workspace_id=$1 and o.id=$2
        and o.approval_round=($6::text::jsonb->>'approvalRound')::integer and o.proposal_digest=$6::text::jsonb->>'proposalDigest'
        and o.plan_digest=$6::text::jsonb->>'planDigest'
        and (select count(distinct a.approver_id) from platform.approvals a where a.workspace_id=$1 and a.operation_id=$2
          and a.id in (select jsonb_array_elements_text($6::text::jsonb->'approvalIds')) and a.decision='approve'
          and a.approver->>'kind'='user' and a.approval_round=o.approval_round and a.proposal_digest=o.proposal_digest
          and a.consumed_at is not null and a.expires_at > clock_timestamp()) >= ($6::text::jsonb->>'requiredApprovalCount')::integer
        and not exists (select 1 from platform.approvals a where a.workspace_id=$1 and a.operation_id=$2 and a.approval_round=o.approval_round and a.decision='reject')))
      returning operation_id`,
      [input.custody.workspaceId,input.custody.operationId,attemptId,input.lease.holder,input.lease.fenceToken,authority?JSON.stringify(authority):null,JSON.stringify(sourceAuthority),JSON.stringify(productAuthority)]);
    if (!changed.length) refuse();
  });
}
/** Internal captured runtime lookup. It cannot grant custody or dispatch. */
export async function requiresProductComposition(sql: Sql, row: ArtifactRow, destination: string, attempt: string): Promise<boolean> {
  try { return await claimedPlanRequiresProductComposition(sql, row, destination, attempt); } catch { return refuse(); }
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

/** Explicit preview configuration, never deletion permission or an execution lifetime extension. */
export interface PlanArtifactRetentionPreviewInput {
  readonly workspaceId: string;
  readonly createdBefore: string;
  readonly limit: number;
  readonly holdOperationIds: readonly string[];
}
/** Only counts leave the store. An archive review means a possible future copy, with original custody retained. */
export interface PlanArtifactRetentionPreview {
  readonly mode: "dry-run";
  readonly scanned: number;
  readonly hasMore: boolean;
  readonly held: number;
  readonly active: number;
  readonly unresolved: number;
  readonly unavailable: number;
  readonly withinRetention: number;
  readonly archiveReview: number;
}
function retentionInput(value: PlanArtifactRetentionPreviewInput): PlanArtifactRetentionPreviewInput {
  const refuseInput = (): never => { throw new ControlStoreError("invalid_input", "Plan retention preview requires explicit bounded configuration."); };
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.getOwnPropertyNames(value).sort()) !== JSON.stringify(["createdBefore", "holdOperationIds", "limit", "workspaceId"])) return refuseInput();
  const own = (object: unknown, key: string): unknown => {
    if (!object || typeof object !== "object") return refuseInput();
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !("value" in descriptor)) return refuseInput();
    return descriptor.value;
  };
  const id = (raw: unknown): string => {
    if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(raw)) return refuseInput();
    return raw;
  };
  const workspaceId = id(own(value, "workspaceId")), createdBefore = own(value, "createdBefore"), limit = own(value, "limit");
  if (typeof createdBefore !== "string" || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdBefore)
    || !Number.isFinite(Date.parse(createdBefore)) || new Date(createdBefore).toISOString() !== createdBefore
    || typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 1000) return refuseInput();
  const rawHolds = own(value, "holdOperationIds");
  if (!Array.isArray(rawHolds)) return refuseInput();
  const length = own(rawHolds, "length");
  if (typeof length !== "number" || length > 1000) return refuseInput();
  const holds: string[] = [];
  for (let i = 0; i < length; i++) holds.push(id(own(rawHolds, String(i))));
  if (new Set(holds).size !== holds.length) return refuseInput();
  return Object.freeze({ workspaceId, createdBefore, limit, holdOperationIds: Object.freeze(holds) });
}

/**
 * One current owning statement, bounded to one workspace and a stable oldest-first window.
 * No manifest, ciphertext, storage key or row identity is selected into the response.
 * This snapshot is not future cleanup authority: no archive, unlink, DELETE, phase or ledger write occurs.
 */
export async function previewRetention(sql: Sql, input: PlanArtifactRetentionPreviewInput): Promise<PlanArtifactRetentionPreview> {
  const c = retentionInput(input);
  const rows = await sql.query<{ protection: string }>(`with candidates as (
    select a.operation_id, a.created_at,
      a.created_at < $2::timestamptz and a.expires_at <= clock_timestamp() as elapsed,
      o.status, u.phase,
      a.operation_id = any($3::text[]) or exists (
        select 1 from platform.plan_artifact_associations r
        where r.workspace_id=$1 and r.source_operation_id=a.operation_id and r.operation_id=any($3::text[])
      ) as held,
      exists (
        select 1 from platform.plan_artifact_associations r
        left join platform.operations d on d.workspace_id=r.workspace_id and d.id=r.operation_id
        left join platform.plan_artifact_uses du on du.workspace_id=r.workspace_id and du.operation_id=r.operation_id
        where r.workspace_id=$1 and r.source_operation_id=a.operation_id
          and (d.id is null or du.operation_id is null or not (d.status=any($5::text[]))
            or du.phase not in ('ready','claimed','dispatched','succeeded','uncertain','expired'))
      ) as related_unavailable,
      exists (
        select 1 from platform.plan_artifact_associations r join platform.operations d
          on d.workspace_id=r.workspace_id and d.id=r.operation_id
        where r.workspace_id=$1 and r.source_operation_id=a.operation_id and not (d.status=any($6::text[]))
      ) as related_active,
      exists (
        select 1 from platform.plan_artifact_associations r join platform.operations d
          on d.workspace_id=r.workspace_id and d.id=r.operation_id
        join platform.plan_artifact_uses du on du.workspace_id=r.workspace_id and du.operation_id=r.operation_id
        where r.workspace_id=$1 and r.source_operation_id=a.operation_id
          and (d.status='uncertain' or du.phase in ('claimed','dispatched','uncertain'))
      ) or exists (
        select 1 from platform.workflow_start_intents s where s.workspace_id=$1 and s.phase='attempted'
          and (s.operation_id=a.operation_id or exists (select 1 from platform.plan_artifact_associations r
            where r.workspace_id=$1 and r.source_operation_id=a.operation_id and r.operation_id=s.operation_id))
      ) or exists (
        select 1 from platform.build_launches b where b.workspace_id=$1 and b.phase<>'terminal'
          and (b.operation_id=a.operation_id or exists (select 1 from platform.plan_artifact_associations r
            where r.workspace_id=$1 and r.source_operation_id=a.operation_id and r.operation_id=b.operation_id))
      ) as related_unresolved,
      exists (select 1 from platform.plan_artifact_associations r
        where r.workspace_id=$1 and r.source_operation_id=a.operation_id and r.expires_at > clock_timestamp()) as related_live
    from platform.plan_artifacts a
    left join platform.operations o on o.workspace_id=a.workspace_id and o.id=a.operation_id
    left join platform.plan_artifact_uses u on u.workspace_id=a.workspace_id and u.operation_id=a.operation_id
    where a.workspace_id=$1 order by a.created_at,a.operation_id limit $4::bigint
  ) select case
    when held then 'held'
    when status is null or phase is null or not (status=any($5::text[]))
      or phase not in ('ready','claimed','dispatched','succeeded','uncertain','expired') or related_unavailable then 'unavailable'
    when not (status=any($6::text[])) or related_active then 'active'
    when status='uncertain' or phase in ('claimed','dispatched','uncertain') or related_unresolved then 'unresolved'
    when not elapsed or related_live then 'withinRetention'
    else 'archiveReview' end as protection from candidates order by created_at,operation_id`,
    [c.workspaceId, c.createdBefore, textArray(c.holdOperationIds), c.limit + 1,
      textArray(["proposed", "awaiting_approval", "approved", "queued", "running", ...TERMINAL_OPERATION_STATUSES]),
      textArray(TERMINAL_OPERATION_STATUSES)]);
  const counts = { held: 0, active: 0, unresolved: 0, unavailable: 0, withinRetention: 0, archiveReview: 0 };
  for (const row of rows.slice(0, c.limit)) {
    if (!Object.hasOwn(counts, row.protection)) throw new ControlStoreError("db_error", "Plan retention preview is unavailable.");
    counts[row.protection as keyof typeof counts]++;
  }
  return Object.freeze({ mode: "dry-run", scanned: Math.min(rows.length, c.limit), hasMore: rows.length > c.limit, ...counts });
}
