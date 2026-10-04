/** Permanent CodeBuild launch claims and immutable receipts; never cleanup permission. */
import { immutableSourceSnapshot, sourceSnapshotDigest, sourceSnapshotSetDigest, sourceRecipeMatches, type ApprovedSourceSnapshot } from "@/lib/execution/source-snapshot";
import { digest } from "@/lib/controlplane/digest";
import type { Sql } from "@/lib/controlplane/types";
import type { Broker } from "@/lib/capabilities/platform";
import type { BrokerDeps } from "@/lib/capabilities/ports";
import type { AutonomyLevel } from "@/lib/policy";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { assertFence } from "./leases";
import { textArray } from "../sql";

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Address = z.string().regex(/^[a-z_]+\/[A-Za-z0-9_.-]{1,128}$/);
const Binding = z.object({
  workspaceId: Id, operationId: Id, environmentId: Id,
  serviceAddress: Address, serviceSpecDigest: Hash,
  pipelineAddress: Address, pipelineSpecDigest: Hash,
  accountId: z.string().regex(/^\d{12}$/), region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/),
  projectArn: z.string().regex(/^arn:aws:codebuild:[a-z0-9-]+:\d{12}:project\/[A-Za-z0-9_-]{1,255}$/),
  projectName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/),
  sourceBucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  sourceKey: z.string().max(512), sourceDigest: Hash, settingsDigest: Hash, executedSettingsDigest: Hash,
}).strict();
export type BuildLaunchBinding = z.infer<typeof Binding>;
export type BuildTerminalStatus = "SUCCEEDED" | "FAILED" | "FAULT" | "TIMED_OUT" | "STOPPED";
export interface BuildLaunch {
  workspace_id: string; operation_id: string; service_address: string; environment_id: string; attempt_id: string;
  binding: BuildLaunchBinding; binding_digest: string; proposal_digest: string; input_digest: string; plan_digest: string;
  phase: "dispatched" | "accepted" | "terminal"; build_id: string | null; request_ids: string[] | null;
  terminal_status: BuildTerminalStatus | null; provider_finished_at: string | null; observed_at: string | null;
  terminal_request_id: string | null;
}
export class BuildLaunchError extends Error {
  readonly code = "build_launch_unconfirmed";
  constructor() { super("Build launch authority or outcome is unconfirmed. Inspect its retained receipt; another build will not be started."); }
}
function refuse(): never { throw new BuildLaunchError(); }
function bindingOf(raw: BuildLaunchBinding): BuildLaunchBinding {
  const parsed = Binding.safeParse(raw);
  if (!parsed.success) refuse();
  const b = parsed.data;
  if (b.projectArn !== `arn:aws:codebuild:${b.region}:${b.accountId}:project/${b.projectName}`
    || !b.pipelineAddress.startsWith("build_pipeline/") || !/^(container_service|scheduled_job)\//.test(b.serviceAddress)
    || [".",".."].includes(b.serviceAddress.split("/")[1])
    || b.sourceKey!==`zenith/${b.environmentId}/${b.serviceAddress.split("/")[1]}/${b.sourceDigest}.zip`) refuse();
  return Object.freeze(b);
}
function checked(row: BuildLaunch): BuildLaunch {
  const binding = bindingOf(row.binding);
  if (row.binding_digest !== digest(binding) || row.workspace_id !== binding.workspaceId || row.operation_id !== binding.operationId
    || row.environment_id !== binding.environmentId || row.service_address !== binding.serviceAddress) refuse();
  return { ...row, binding };
}

type AuthorityDependencies = Readonly<Omit<BrokerDeps, "store">>;
const AUTHORITY_DEADLINE_MS = 8_000;

/** Test adapters retain their actual evaluator/ports, never their SQL store. */
function captureDependencies(broker: Broker): AuthorityDependencies {
  const { scopes, roles, signer, clock, policy, issuer, newId } = broker.deps;
  return Object.freeze({ scopes, roles, signer, clock, policy, issuer, newId });
}

async function canonicalDependencies(tx: Sql, signal: AbortSignal): Promise<AuthorityDependencies> {
  const [{ currentProductRoleResolver }, { platformScopeResolver }, { CredentialGrantSigner }, { systemClock }, { loadPolicyEngine }] = await Promise.all([
    import("@/lib/capabilities/current-product-roles"), import("@/lib/platform/scopes"),
    import("@/lib/capabilities/credential-signer"), import("@/lib/capabilities/ports"), import("@/lib/policy"),
  ]);
  return Object.freeze({ scopes: platformScopeResolver(tx), roles: currentProductRoleResolver({ signal }),
    signer: new CredentialGrantSigner(), clock: systemClock, policy: () => loadPolicyEngine() });
}

interface SettingsSnapshot {
  workspaceId: string; environmentId: string;
  policy: { present: boolean; version: number; params: Record<string, unknown> };
  environment: { present: boolean; version: number; autonomyLevel: AutonomyLevel; policyParams: Record<string, unknown> };
}
function freezeSnapshot<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freezeSnapshot); Object.freeze(value); }
  return value;
}
/** Fixed owning SQL reads only; no caller snapshot or default-row creation. */
async function captureSettings(tx: Sql, binding: BuildLaunchBinding): Promise<SettingsSnapshot> {
  const [policies, environments] = await Promise.all([
    tx.query<{ workspace_id: string; version: number; params: Record<string, unknown> }>(
      "select workspace_id,version,params from platform.workspace_policy where workspace_id=$1", [binding.workspaceId]),
    // The environment key is globally unique. A foreign existing row must not
    // be mistaken for an absent/default row of this workspace.
    tx.query<{ workspace_id: string; environment_id: string; version: number; autonomy_level: number; policy_params: Record<string, unknown> }>(
      "select workspace_id,environment_id,version,autonomy_level,policy_params from platform.environment_settings where environment_id=$1", [binding.environmentId]),
  ]);
  const policy=policies[0], environment=environments[0];
  if (policies.length>1 || environments.length>1
    || policy && (policy.workspace_id!==binding.workspaceId || !Number.isInteger(policy.version) || policy.version<1)
    || environment && (environment.workspace_id!==binding.workspaceId || environment.environment_id!==binding.environmentId
      || !Number.isInteger(environment.version) || environment.version<1 || !Number.isInteger(environment.autonomy_level)
      || environment.autonomy_level<0 || environment.autonomy_level>5)) refuse();
  const snapshot: SettingsSnapshot = {
    workspaceId:binding.workspaceId,environmentId:binding.environmentId,
    policy:{present:!!policy,version:policy?.version??0,params:policy?.params??{}},
    environment:{present:!!environment,version:environment?.version??0,
      autonomyLevel:(environment?.autonomy_level??1) as AutonomyLevel,policyParams:environment?.policy_params??{}},
  };
  // Detach SQL JSON objects; the evaluator cannot mutate the final CAS inputs.
  return freezeSnapshot(structuredClone(snapshot));
}
/** Exact captured state, including absence, must still hold at either final CAS. */
function settingsChecks(parameter: "$14::text::jsonb" | "$11::text::jsonb", workspace: "$1", environment: "$3" | "$6"): string {
  return `${parameter}->>'workspaceId'=${workspace} and ${parameter}->>'environmentId'=${environment}
    and (case when (${parameter}->'policy'->>'present')::boolean then exists (
      select 1 from platform.workspace_policy p where p.workspace_id=${workspace}
        and p.version=(${parameter}->'policy'->>'version')::integer and p.params=${parameter}->'policy'->'params')
      else not exists (select 1 from platform.workspace_policy p where p.workspace_id=${workspace}) end)
    and (case when (${parameter}->'environment'->>'present')::boolean then exists (
      select 1 from platform.environment_settings s where s.workspace_id=${workspace} and s.environment_id=${environment}
        and s.version=(${parameter}->'environment'->>'version')::integer
        and s.autonomy_level=(${parameter}->'environment'->>'autonomyLevel')::integer
        and s.policy_params=${parameter}->'environment'->'policyParams')
      else not exists (select 1 from platform.environment_settings s where s.environment_id=${environment}) end)`;
}

/** Private SQL fragments expand only the fixed bind addresses of these two statements. */
const INSERT_SETTINGS_AUTHORITY = settingsChecks("$14::text::jsonb", "$1", "$3");
const RECOVERY_SETTINGS_AUTHORITY = settingsChecks("$11::text::jsonb", "$1", "$6");
function approvalChecks(parameter: "$13::text::jsonb" | "$10::text::jsonb"): string {
  return `o.approval_round=(${parameter}->>'approvalRound')::integer
      and o.proposal_digest=${parameter}->>'proposalDigest' and o.plan_digest=${parameter}->>'planDigest'
      and (select count(distinct a.approver_id) from platform.approvals a where a.workspace_id=o.workspace_id and a.operation_id=o.id
        and a.id in (select jsonb_array_elements_text(${parameter}->'approvalIds')) and a.decision='approve'
        and a.approver->>'kind'='user' and a.approval_round=o.approval_round and a.proposal_digest=o.proposal_digest
        and a.consumed_at is not null and a.expires_at > clock_timestamp()) >= (${parameter}->>'requiredApprovalCount')::integer
      and (not o.approval_required or exists (select 1 from platform.approvals a where a.workspace_id=o.workspace_id and a.operation_id=o.id
        and a.id in (select jsonb_array_elements_text(${parameter}->'approvalIds')) and a.decision='approve'
        and a.approver->>'kind'='user' and a.approval_round=o.approval_round and a.proposal_digest=o.proposal_digest
        and a.consumed_at is not null and a.expires_at > clock_timestamp()))
      and not exists (select 1 from platform.approvals a where a.workspace_id=o.workspace_id and a.operation_id=o.id
        and a.approval_round=o.approval_round and a.decision='reject')`;
}
const INSERT_APPROVAL_AUTHORITY = approvalChecks("$13::text::jsonb");
const RECOVERY_APPROVAL_AUTHORITY = approvalChecks("$10::text::jsonb");
const INSERT_LIVE_AUTHORITY = `(${INSERT_SETTINGS_AUTHORITY})
      and exists (select 1 from platform.leases l where l.scope=$12 and l.fence_token=$11
      and l.expires_at > clock_timestamp() and l.released_at is null)
      and exists (select 1 from platform.operations o where o.workspace_id=$1 and o.id=$2 and o.environment_id=$3
        and o.status='running' and o.capability in ('deployment.deploy','infrastructure.apply')
        and o.expires_at > clock_timestamp() and o.lease_until > clock_timestamp() and o.lease_holder='workflow:' || o.id
        and o.lease_scope=$12 and o.fence_token=$11 and o.proposal_digest=$8 and o.input_digest=$9 and o.plan_digest=$10
        and (${INSERT_APPROVAL_AUTHORITY}))`;

interface SourceAuthority { snapshot:ApprovedSourceSnapshot; snapshotDigest:string; sources:ApprovedSourceSnapshot[]; setDigest:string; serviceSpec:Record<string,unknown>; pipelineSpec:Record<string,unknown> }
/** Native immutable rows only. Current binding stays MVCC-readable so revocation can commit during a role RPC. */
async function captureSource(tx:Sql,b:BuildLaunchBinding,projectId:string,nodes:readonly {address:string;spec_digest:string;spec:Record<string,unknown>}[]):Promise<SourceAuthority>{
  const rows=await tx.query<{snapshot:unknown;snapshot_digest:string}>("select snapshot,snapshot_digest from platform.approved_source_snapshots where workspace_id=$1 and operation_id=$2 and project_id=$3 and environment_id=$4 order by service_address for share",[b.workspaceId,b.operationId,projectId,b.environmentId]);
  const sources=rows.map(row=>{let s:ApprovedSourceSnapshot;try{s=immutableSourceSnapshot(row.snapshot);}catch{refuse();}
    if(sourceSnapshotDigest(s)!==row.snapshot_digest || s.workspaceId!==b.workspaceId || s.operationId!==b.operationId || s.projectId!==projectId || s.environmentId!==b.environmentId)refuse();return s;});
  const snapshot=sources.find(s=>s.serviceAddress===b.serviceAddress),service=nodes.find(n=>n.address===b.serviceAddress),pipeline=nodes.find(n=>n.address===b.pipelineAddress);
  if(!snapshot || !service || !pipeline || snapshot.archiveFormat!=="zip" || snapshot.provider!=="aws" || snapshot.region!==b.region || snapshot.archiveDigest!==b.sourceDigest
    || snapshot.serviceSpecDigest!==b.serviceSpecDigest || snapshot.pipelineSpecDigest!==b.pipelineSpecDigest || snapshot.pipelineAddress!==b.pipelineAddress
    || !sourceRecipeMatches(snapshot,{...service,provider:"aws",region:b.region,specDigest:service.spec_digest},{...pipeline,provider:"aws",region:b.region,specDigest:pipeline.spec_digest}))refuse();
  const bindings=await tx.query<{app_id:string;installation_id:string|number;repository_id:string|number;version:number;owner:string;repo:string;revoked_at:unknown}>("select app_id,installation_id,repository_id,version,owner,repo,revoked_at from platform.github_source_bindings where workspace_id=$1",[b.workspaceId]);
  const current=bindings[0],remembered=snapshot.githubBinding;
  if(remembered ? !current || current.revoked_at || current.app_id!==remembered.appId || Number(current.installation_id)!==remembered.installationId
    || Number(current.repository_id)!==remembered.repositoryId || current.version!==remembered.version || current.owner!==snapshot.owner || current.repo!==snapshot.repo : !!current)refuse();
  return freezeSnapshot(structuredClone({snapshot,snapshotDigest:sourceSnapshotDigest(snapshot),sources,setDigest:sourceSnapshotSetDigest(sources),serviceSpec:service.spec,pipelineSpec:pipeline.spec}));
}
function sourceChecks(p:"$15::text::jsonb"|"$12::text::jsonb",plan:"$10"|"$9"):string{
  const s=`${p}->'snapshot'`;
  return `exists(select 1 from platform.approved_source_snapshots a where a.workspace_id=$1 and a.operation_id=$2
      and a.project_id=${s}->>'projectId' and a.environment_id=${s}->>'environmentId' and a.service_address=${s}->>'serviceAddress'
      and a.snapshot=${s} and a.snapshot_digest=${p}->>'snapshotDigest')
    and coalesce((select jsonb_agg(a.snapshot order by a.service_address) from platform.approved_source_snapshots a where a.workspace_id=$1 and a.operation_id=$2),'[]'::jsonb)=${p}->'sources'
    and exists(select 1 from platform.evidence e where e.workspace_id=$1 and e.operation_id=$2 and e.kind='tofu_plan' and not e.simulated
      and e.summary->>'stage'='plan' and e.digest=${plan} and e.summary->>'planDigest'=${plan} and e.summary->>'executableSourceDigest'=${p}->>'setDigest')
    and exists(select 1 from platform.resources r where r.workspace_id=$1 and r.environment_id=${s}->>'environmentId' and r.project_id=${s}->>'projectId'
      and r.address=${s}->>'serviceAddress' and r.spec_digest=${s}->>'serviceSpecDigest' and r.spec=${p}->'serviceSpec' and r.provider='aws'
      and r.region=${s}->>'region' and r.ownership='managed' and r.status<>'deleted')
    and exists(select 1 from platform.resources r where r.workspace_id=$1 and r.environment_id=${s}->>'environmentId' and r.project_id=${s}->>'projectId'
      and r.address=${s}->>'pipelineAddress' and r.spec_digest=${s}->>'pipelineSpecDigest' and r.spec=${p}->'pipelineSpec' and r.provider='aws'
      and r.region=${s}->>'region' and r.ownership='managed' and r.status<>'deleted')
    and ((${s}->'githubBinding'='null'::jsonb and not exists(select 1 from platform.github_source_bindings b where b.workspace_id=$1))
      or exists(select 1 from platform.github_source_bindings b where b.workspace_id=$1 and b.revoked_at is null and b.owner=${s}->>'owner' and b.repo=${s}->>'repo'
        and b.app_id=${s}->'githubBinding'->>'appId' and b.installation_id=(${s}->'githubBinding'->>'installationId')::bigint
        and b.repository_id=(${s}->'githubBinding'->>'repositoryId')::bigint and b.version=(${s}->'githubBinding'->>'version')::integer))`;
}
const INSERT_SOURCE_AUTHORITY=sourceChecks("$15::text::jsonb","$10");
const RECOVERY_SOURCE_AUTHORITY=sourceChecks("$12::text::jsonb","$9");

/** A late read-only completion cannot continue the claim after its deadline. */
function beforeDeadline<T>(signal: AbortSignal, pending: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new BuildLaunchError()); };
    signal.addEventListener("abort", abort, { once: true });
    void pending.then(value => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(new BuildLaunchError()); else resolve(value);
    }, () => { signal.removeEventListener("abort", abort); reject(new BuildLaunchError()); });
    if (signal.aborted) abort();
  });
}

/** Commit BEFORE StartBuild. Neither a lease expiry nor another idempotency key reopens this natural operation/service identity. */
export async function claim(sql: Sql, raw: BuildLaunchBinding, fence: { scope: string; token: number }): Promise<{ claimed: boolean; launch: BuildLaunch }> {
  return claimBuildLaunch(sql,raw,fence);
}

/** Fixed test admission only; no SQL, broker state, provider access or authority input. */
export function assertIsolatedBuildTestAdmission(): void {
  if(process.env.NODE_ENV!=="test") refuse();
}

/** Captures a real isolated broker once; callers cannot provide per-claim authority. */
export function createIsolatedBuildClaimerForTests(broker: Broker): typeof claim {
  assertIsolatedBuildTestAdmission();
  const dependencies = captureDependencies(broker);
  return (sql,raw,fence)=>{
    assertIsolatedBuildTestAdmission();
    return claimBuildLaunch(sql,raw,fence,dependencies);
  };
}

async function claimBuildLaunch(sql: Sql, raw: BuildLaunchBinding, fence: { scope: string; token: number }, isolatedDependencies?: AuthorityDependencies): Promise<{ claimed: boolean; launch: BuildLaunch }> {
  const binding = bindingOf(raw);
  fence=Object.freeze({...fence});
  if (fence.scope !== `env:${binding.environmentId}`) refuse();
  return sql.tx(async tx => {
    await assertFence(tx, fence.scope, fence.token);
    const op = await tx.query<{ proposal_digest: string; input_digest: string; plan_digest: string;project_id:string }>(`select proposal_digest,input_digest,plan_digest,project_id from platform.operations
      where workspace_id=$1 and id=$2 and environment_id=$3 and status='running'
      and capability in ('deployment.deploy','infrastructure.apply') and expires_at > clock_timestamp()
      and lease_until > clock_timestamp() and lease_holder='workflow:' || id
      and lease_scope=$4 and fence_token=$5 and plan_digest is not null
      for update`, [binding.workspaceId,binding.operationId,binding.environmentId,fence.scope,fence.token]);
    if (!op[0]) refuse();
    const operation = op[0];
    // Authorization of the concrete plan has already been consumed by the original apply.
    const used = await tx.query(`select operation_id from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2 and phase='succeeded' for share`, [binding.workspaceId,binding.operationId]);
    if (!used.length) refuse();
    const connection=await tx.query(`select c.id from platform.reconcile_state e join platform.provider_connections c
      on c.workspace_id=e.workspace_id and c.id=e.connection_id
      where e.workspace_id=$1 and e.environment_id=$2 and e.provider='aws' and e.region=$3
      and c.provider='aws' and c.status='verified' and c.config->>'accountId'=$4 and c.config->>'region'=$3 for share of e,c`,
      [binding.workspaceId,binding.environmentId,binding.region,binding.accountId]);
    if(!connection.length) refuse();
    const nodes = await tx.query<{ address: string; spec_digest: string; spec: { artifact?: { type?: string; pipeline?: string } } }>(`select address,spec_digest,spec from platform.resources
      where workspace_id=$1 and environment_id=$2 and address=any($3::text[]) and provider='aws'
      and ownership='managed' and region=$4 and status <> 'deleted' for share`,
      [binding.workspaceId,binding.environmentId,textArray([binding.serviceAddress,binding.pipelineAddress]),binding.region]);
    const service=nodes.find(n=>n.address===binding.serviceAddress), pipeline=nodes.find(n=>n.address===binding.pipelineAddress);
    if (!service || !pipeline || service.spec_digest!==binding.serviceSpecDigest || pipeline.spec_digest!==binding.pipelineSpecDigest
      || service.spec.artifact?.type!=="built" || service.spec.artifact.pipeline!==binding.pipelineAddress) refuse();
    const source=await captureSource(tx,binding,operation.project_id,nodes);
    // A receipt update can also wait on this row. Acquire that lock before the
    // final policy/role evaluation; all claimers already hold the same op lock.
    await tx.query(`select operation_id from platform.build_launches
      where workspace_id=$1 and operation_id=$2 and service_address=$3 for update`,
      [binding.workspaceId,binding.operationId,binding.serviceAddress]);
    // Evaluate only AFTER every potentially blocking lock. A pre-lock snapshot
    // cannot authorize dispatch after policy or approver roles changed in a wait.
    // Construct the fixed canonical broker internally; the process-global
    // broker's memory/registered/override store cannot authorize this claim.
    // Lazy imports avoid the DB/platform initialization cycle.
    const signal = AbortSignal.timeout(AUTHORITY_DEADLINE_MS);
    const [{ createExecutionBroker }, { createBroker }, { PlatformBrokerStore }] = await Promise.all([
      import("@/lib/platform/broker"), import("@/lib/capabilities/platform"), import("@/lib/capabilities/platform-store"),
    ]);
    const dependencies = isolatedDependencies ?? await canonicalDependencies(tx, signal);
    if (signal.aborted) refuse();
    const settings = await beforeDeadline(signal, captureSettings(tx, binding));
    const store = new PlatformBrokerStore(tx);
    // Evaluation and final SQL fencing share ONE detached owning snapshot. The
    // fixed internal reads cannot refresh/retry to a different authority state.
    store.getWorkspacePolicy = async workspaceId => {
      if (workspaceId!==settings.workspaceId) refuse();
      return {workspaceId,params:settings.policy.params,version:settings.policy.version,isDefault:!settings.policy.present};
    };
    store.getEnvironmentSettings = async (workspaceId,environmentId) => {
      if (workspaceId!==settings.workspaceId || environmentId!==settings.environmentId) refuse();
      return {workspaceId,environmentId,autonomyLevel:settings.environment.autonomyLevel,
        version:settings.environment.version,isDefault:!settings.environment.present};
    };
    const authorityBroker = createBroker({ ...dependencies, store });
    const broker = createExecutionBroker(tx, async () => authorityBroker);
    const status = await beforeDeadline(signal, broker.approvalStatus(binding.operationId));
    if(!status.approved || status.rejected || !status.dispatchApproval) refuse();
    const authority=status.dispatchApproval;
    if(!Number.isInteger(authority.approvalRound) || authority.approvalRound<0
      || !Number.isInteger(authority.requiredApprovalCount) || authority.requiredApprovalCount<0
      || !Array.isArray(authority.approvalIds) || authority.approvalIds.length<authority.requiredApprovalCount
      || authority.approvalIds.some(id=>!Id.safeParse(id).success) || new Set(authority.approvalIds).size!==authority.approvalIds.length
      || authority.proposalDigest!==operation.proposal_digest || authority.planDigest!==operation.plan_digest) refuse();
    const approval=Object.freeze({...authority,approvalIds:Object.freeze([...authority.approvalIds])});
    // Canonical role resolution can await external stores. Final CAS checks all
    // database clocks again, along with exact consumed approval identities.
    const parameters=[binding.workspaceId,binding.operationId,binding.environmentId,binding.serviceAddress,randomUUID(),JSON.stringify(binding),digest(binding),operation.proposal_digest,operation.input_digest,operation.plan_digest,fence.token,fence.scope,JSON.stringify(approval),JSON.stringify(settings),JSON.stringify(source)];
    const inserted = await tx.query<BuildLaunch>(`insert into platform.build_launches
      (workspace_id,operation_id,environment_id,service_address,attempt_id,binding,binding_digest,proposal_digest,input_digest,plan_digest,fence_token)
      select $1,$2,$3,$4,$5,$6::text::jsonb,$7,$8,$9,$10,$11 where ${INSERT_LIVE_AUTHORITY} and (${INSERT_SOURCE_AUTHORITY})
      on conflict (workspace_id,operation_id,service_address) do nothing returning *`,
      parameters);
    const rows = inserted.length ? inserted : await tx.query<BuildLaunch>(`select * from platform.build_launches
      where workspace_id=$1 and operation_id=$2 and service_address=$3
      and (${RECOVERY_SETTINGS_AUTHORITY}) and (${RECOVERY_SOURCE_AUTHORITY})
      and exists (select 1 from platform.leases l where l.scope=$4 and l.fence_token=$5
        and l.expires_at > clock_timestamp() and l.released_at is null)
      and exists (select 1 from platform.operations o where o.workspace_id=$1 and o.id=$2 and o.environment_id=$6
        and o.status='running' and o.expires_at > clock_timestamp() and o.lease_until > clock_timestamp()
        and o.lease_holder='workflow:' || o.id and o.lease_scope=$4 and o.fence_token=$5
        and o.proposal_digest=$7 and o.input_digest=$8 and o.plan_digest=$9
        and (${RECOVERY_APPROVAL_AUTHORITY})) for update`,
      [binding.workspaceId,binding.operationId,binding.serviceAddress,fence.scope,fence.token,binding.environmentId,operation.proposal_digest,operation.input_digest,operation.plan_digest,JSON.stringify(approval),JSON.stringify(settings),JSON.stringify(source)]);
    const launch=rows[0] ? checked(rows[0]) : refuse();
    if (launch.binding_digest!==digest(binding) || launch.proposal_digest!==operation.proposal_digest
      || launch.input_digest!==operation.input_digest || launch.plan_digest!==operation.plan_digest) refuse();
    return { claimed:inserted.length===1, launch };
  });
}

const RequestId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
function buildIdentity(launch: BuildLaunch, buildId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,254}:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(buildId)
    || !buildId.startsWith(`${launch.binding.projectName}:`)) refuse();
}
/** A late accepted response records evidence even after lease/status loss. It grants no further mutation authority. */
export async function acknowledge(sql: Sql, raw: BuildLaunch, buildId: string, requestIds: readonly string[]): Promise<BuildLaunch> {
  const launch=checked(raw); buildIdentity(launch,buildId);
  const parsed=z.array(RequestId).min(1).max(10).safeParse(requestIds);
  if (!parsed.success) refuse();
  const rows=await sql.query<BuildLaunch>(`update platform.build_launches set phase='accepted',build_id=$6,request_ids=$7::text::jsonb,accepted_at=clock_timestamp()
    where workspace_id=$1 and operation_id=$2 and service_address=$3 and attempt_id=$4 and binding_digest=$5 and phase='dispatched' returning *`,
    [launch.workspace_id,launch.operation_id,launch.service_address,launch.attempt_id,launch.binding_digest,buildId,JSON.stringify(parsed.data)]);
  if(rows[0]) return checked(rows[0]);
  const existing=await get(sql,launch.workspace_id,launch.operation_id,buildId);
  if(!existing || existing.attempt_id!==launch.attempt_id || digest(existing.request_ids)!==digest(parsed.data)) refuse();
  return existing;
}
/** Read-only scope lookup. An arbitrary handle from another operation is never recovered. */
export async function get(sql: Sql, workspaceId: string, operationId: string, buildId: string): Promise<BuildLaunch | null> {
  const rows=await sql.query<BuildLaunch>(`select * from platform.build_launches where workspace_id=$1 and operation_id=$2 and build_id=$3`,[workspaceId,operationId,buildId]);
  return rows[0] ? checked(rows[0]) : null;
}
/** Called only by the trusted CodeBuild adapter after exact independent provider readback. No public resolution API. */
export async function observeTerminal(sql: Sql, raw: BuildLaunch, observation: { status: BuildTerminalStatus; finishedAt: Date; requestId: string }): Promise<BuildLaunch> {
  const launch=checked(raw);
  if(!launch.build_id || !["SUCCEEDED","FAILED","FAULT","TIMED_OUT","STOPPED"].includes(observation.status)
    || !Number.isFinite(observation.finishedAt.getTime()) || !RequestId.safeParse(observation.requestId).success) refuse();
  const rows=await sql.query<BuildLaunch>(`update platform.build_launches set phase='terminal',terminal_status=$6,provider_finished_at=$7::timestamptz,terminal_request_id=$8,observed_at=clock_timestamp()
    where workspace_id=$1 and operation_id=$2 and service_address=$3 and attempt_id=$4 and binding_digest=$5 and phase='accepted'
    and $7::timestamptz >= created_at and $7::timestamptz <= clock_timestamp() returning *`,
    [launch.workspace_id,launch.operation_id,launch.service_address,launch.attempt_id,launch.binding_digest,observation.status,observation.finishedAt.toISOString(),observation.requestId]);
  if(rows[0]) return checked(rows[0]);
  const existing=await get(sql,launch.workspace_id,launch.operation_id,launch.build_id);
  if(!existing || existing.phase!=="terminal" || existing.terminal_status!==observation.status
    || Date.parse(existing.provider_finished_at ?? "")!==observation.finishedAt.getTime()) refuse();
  return existing;
}
