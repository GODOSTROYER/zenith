/** Non-executable native custody. This module never mints a grant, plan handle or child Start. */
import { isProxy } from "node:util/types";
import { z } from "zod";
import type { Sql } from "@/lib/controlplane/types";
import { digest, sha256Hex } from "@/lib/controlplane/digest";
import { isOpenedPlatformDbHandle } from "../open";
import { assertPlatformSchemaCurrent } from "../migrator";
import { json, textArray } from "../sql";
import { projectPlanReview } from "./operation-review";
import * as workflowStartIntents from "./workflow-start-intents";
import { ManifestPolicies } from "@/lib/domain/types";
import { parseManifest, isV1 } from "@/lib/resources/manifest-v2";
import { upgradeManifest } from "@/lib/resources/upgrade";
import { expandManifest } from "@/lib/resources/expand";
import type { ResourceGraph } from "@/lib/resources/types";
import { backendForConnection } from "@/lib/tofu/backends";
import { backendFile } from "@/lib/tofu/backend-config";
import { stableJson } from "@/lib/tofu/stable";
import { MAX_PLAN_BYTES } from "@/lib/tofu/runner";
import type { ProviderConnection } from "@/lib/credentials/types";

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const ObjectValue = z.record(z.string(), z.unknown());
const list = z.array(ObjectValue).max(10_000);
const Frame = z.object({ operations: list, decisions: list, approvals: list, artifacts: list, evidence: list, sources: list,
  start: list, members: list, projects: list, environments: list, revisions: list, manifests: list, connections: list,
  providers: list, settings: list, policy: list, leases: list, foreignSettings: z.boolean() }).strict();
type NativeFrame = z.infer<typeof Frame>;
export class MixedChildAdmissionError extends Error {
  constructor(readonly code: "unavailable" | "changed" | "unsupported_parent_effects" | "nonreplayable") {
    super(code === "nonreplayable" ? "The retained mixed-child attempt is nonreplayable; inspect its original history."
      : "Mixed-child custody or independently reviewed parent effects are unavailable; no child Start is admitted.");
    this.name = "MixedChildAdmissionError";
  }
}
function refuse(code: MixedChildAdmissionError["code"] = "unavailable"): never { throw new MixedChildAdmissionError(code); }
export interface MixedChildIds { readonly workspaceId: string; readonly parentOperationId: string; readonly childOperationId: string }
function ids(sql: Sql, value: MixedChildIds): MixedChildIds {
  // No structural database branding and no supplied approval/connection/config/evidence DTO.
  if (!isOpenedPlatformDbHandle(sql, "postgres") || !value || typeof value !== "object" || isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return refuse();
  const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.length !== 3 || keys.some(key => typeof key !== "string" || !["workspaceId", "parentOperationId", "childOperationId"].includes(key))) return refuse();
  const out: Record<string, string> = {};
  for (const key of ["workspaceId", "parentOperationId", "childOperationId"]) {
    const field = descriptors[key];
    if (!field || !("value" in field) || !field.enumerable || !Id.safeParse(field.value).success) return refuse();
    out[key] = field.value as string;
  }
  if (out.parentOperationId === out.childOperationId) return refuse();
  return Object.freeze(out) as unknown as MixedChildIds;
}
const selected = (rows: Record<string, unknown>[], key: string, value: string): Record<string, unknown> => {
  const matches = rows.filter(row => row[key] === value);
  return matches.length === 1 ? matches[0] : refuse();
};
function string(value: unknown): string { return Id.parse(value); }
function hash(value: unknown): string { return Hash.parse(value); }
function plain(value: unknown): Record<string, unknown> { return ObjectValue.parse(value); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
export interface MixedChildCandidate {
  readonly format: "zenith.mixed-child-candidate.v1"; readonly workspaceId: string; readonly partitionId: string;
  readonly executionEnabled: false; readonly parentEffectCoverage: "unsupported"; readonly compilerReferenceCoverage: "unavailable";
  readonly artifactBytesAuthenticated: false; readonly connectionAuthorization: "not_minted";
  readonly nativeFrameDigest: string;
  readonly parent: Readonly<Record<string, unknown>> & { readonly operationId: string };
  readonly child: Readonly<Record<string, unknown>> & { readonly operationId: string };
  readonly nodes: readonly Readonly<Record<string, unknown>>[];
  readonly dependenciesDigest: string;
}
export interface MixedChildCustody {
  readonly workspace_id: string; readonly parent_operation_id: string; readonly child_operation_id: string;
  readonly partition_id: string; readonly descriptor: MixedChildCandidate; readonly descriptor_digest: string;
  readonly phase: "prepared" | "attempted" | "acknowledged"; readonly attempt_id: string | null; readonly run_id: string | null;
  /** Diagnostic metadata only; no raw history was independently authenticated by this slice. */
  readonly receipt_digest: string | null; readonly executionEnabled: false;
}
const Descriptor = z.object({ format: z.literal("zenith.mixed-child-candidate.v1"), workspaceId: Id, partitionId: Hash,
  executionEnabled: z.literal(false), parentEffectCoverage: z.literal("unsupported"), compilerReferenceCoverage: z.literal("unavailable"),
  artifactBytesAuthenticated: z.literal(false), connectionAuthorization: z.literal("not_minted"), nativeFrameDigest: Hash,
  parent: z.object({ operationId: Id, historyAuthenticated: z.literal(false) }).passthrough(), child: z.object({ operationId: Id }).passthrough(),
  nodes: z.array(z.object({ address: z.string().min(1).max(256), kind: z.string().max(100), nativeType: z.string().max(200),
    ownership: z.enum(["managed", "referenced"]), specDigest: Hash, parentNodeDigest: Hash, childNodeDigest: Hash,
    dependsOn: z.array(z.string().min(1).max(256)).max(1000) }).strict()).min(1).max(1000), dependenciesDigest: Hash }).strict();
function readRow(row: Record<string, unknown>, scope: MixedChildIds): MixedChildCustody {
  const descriptor = Descriptor.parse(row.descriptor);
  if (row.workspace_id !== scope.workspaceId || row.parent_operation_id !== scope.parentOperationId || row.child_operation_id !== scope.childOperationId
    || descriptor.format !== "zenith.mixed-child-candidate.v1" || descriptor.workspaceId !== scope.workspaceId
    || plain(descriptor.parent).operationId !== scope.parentOperationId || plain(descriptor.child).operationId !== scope.childOperationId
    || descriptor.executionEnabled !== false || descriptor.parentEffectCoverage !== "unsupported" || descriptor.compilerReferenceCoverage !== "unavailable"
    || descriptor.artifactBytesAuthenticated !== false || descriptor.connectionAuthorization !== "not_minted"
    || descriptor.partitionId !== row.partition_id || digest(descriptor) !== row.descriptor_digest
    || !["prepared", "attempted", "acknowledged"].includes(String(row.phase))) return refuse();
  hash(row.partition_id); hash(row.descriptor_digest);
  return freeze({ workspace_id: scope.workspaceId, parent_operation_id: scope.parentOperationId, child_operation_id: scope.childOperationId,
    partition_id: String(row.partition_id), descriptor: descriptor as unknown as MixedChildCandidate, descriptor_digest: String(row.descriptor_digest),
    phase: row.phase as MixedChildCustody["phase"], attempt_id: row.attempt_id === null ? null : String(row.attempt_id),
    run_id: row.run_id === null ? null : String(row.run_id), receipt_digest: row.receipt === null ? null : digest(row.receipt), executionEnabled: false });
}
async function read(tx: Sql, scope: MixedChildIds): Promise<MixedChildCustody | null> {
  const rows = await tx.query<Record<string, unknown>>(`select c.workspace_id,c.parent_operation_id,c.child_operation_id,c.partition_id,c.descriptor,c.descriptor_digest,
    i.phase,i.attempt_id,i.run_id,i.receipt from platform.mixed_child_custody c join platform.mixed_child_intents i
    on i.workspace_id=c.workspace_id and i.child_operation_id=c.child_operation_id
    and i.parent_operation_id=c.parent_operation_id and i.descriptor_digest=c.descriptor_digest
    where c.workspace_id=$1 and c.parent_operation_id=$2 and c.child_operation_id=$3`,
    [scope.workspaceId,scope.parentOperationId,scope.childOperationId]);
  if (rows.length > 1) return refuse();
  return rows.length ? readRow(rows[0], scope) : null;
}
/** Tenant-bound read; acknowledged row metadata is never promoted to Start/history authority. */
export async function get(sql: Sql, input: MixedChildIds): Promise<MixedChildCustody | null> {
  const scope = ids(sql, input);
  try { await assertPlatformSchemaCurrent(sql); if (!isOpenedPlatformDbHandle(sql, "postgres")) return refuse(); return await read(sql, scope); } catch (error) { if (error instanceof MixedChildAdmissionError) throw error; return refuse(); }
}
async function nativeFrame(tx: Sql, scope: MixedChildIds): Promise<NativeFrame> {
  const rows = await tx.query<{ frame: unknown }>(`select jsonb_build_object(
  'operations',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'workspace_id',o.workspace_id,'project_id',o.project_id,
    'environment_id',o.environment_id,'capability',o.capability,'principal',o.principal,'proposal',o.proposal,
    'proposal_digest',o.proposal_digest,'input_digest',o.input_digest,'plan_digest',o.plan_digest,'approval_round',o.approval_round,
    'approval_required',o.approval_required,'policy_decision_id',o.policy_decision_id,'status',o.status,'workflow_id',o.workflow_id,
    'lease_holder',o.lease_holder,'lease_scope',o.lease_scope,'fence_token',o.fence_token,
    'expires_at',o.expires_at,'live',o.expires_at>clock_timestamp(),'claimed',o.lease_until>clock_timestamp()) order by o.id collate "C")
    from platform.operations o where o.workspace_id=$1 and o.id in ($2,$3)),'[]'::jsonb),
  'decisions',coalesce((select jsonb_agg(to_jsonb(p) order by p.id collate "C") from platform.policy_decisions p
    where p.workspace_id=$1 and p.id in (select o.policy_decision_id from platform.operations o where o.workspace_id=$1 and o.id in ($2,$3))),'[]'::jsonb),
  'approvals',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'operation_id',a.operation_id,'workspace_id',a.workspace_id,
    'proposal_digest',a.proposal_digest,'approval_round',a.approval_round,'decision',a.decision,'approver',a.approver,
    'approver_id',a.approver_id,'approver_role',a.approver_role,'policy_version',a.policy_version,'consumed_at',a.consumed_at,
    'live',a.expires_at>clock_timestamp()) order by a.id collate "C") from platform.approvals a
    where a.workspace_id=$1 and a.operation_id in ($2,$3)),'[]'::jsonb),
  'artifacts',coalesce((select jsonb_agg(jsonb_build_object('operation_id',a.operation_id,'workspace_id',a.workspace_id,
    'manifest',a.manifest,'manifest_digest',a.manifest_digest,'plan_digest',a.plan_digest,'expires_at',a.expires_at,'live',a.expires_at>clock_timestamp())
    order by a.operation_id collate "C") from platform.plan_artifacts a where a.workspace_id=$1 and a.operation_id in ($2,$3)),'[]'::jsonb),
  'evidence',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'operation_id',e.operation_id,'workspace_id',e.workspace_id,
    'digest',e.digest,'summary',e.summary,'created_at',e.created_at) order by e.created_at,e.id collate "C") from platform.evidence e
    where e.workspace_id=$1 and e.operation_id in ($2,$3) and e.kind='tofu_plan' and not e.simulated and e.summary->>'stage'='plan'),'[]'::jsonb),
  'sources',coalesce((select jsonb_agg(jsonb_build_object('operation_id',s.operation_id,'service_address',s.service_address,'snapshot_digest',s.snapshot_digest)
    order by s.operation_id collate "C",s.service_address collate "C") from platform.approved_source_snapshots s
    where s.workspace_id=$1 and s.operation_id in ($2,$3)),'[]'::jsonb),
  'start',coalesce((select jsonb_agg(to_jsonb(i) order by i.operation_id collate "C") from platform.workflow_start_intents i
    where i.workspace_id=$1 and i.operation_id=$2),'[]'::jsonb),
  'members',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'workspace_id',m.workspace_id,'role',m.role) order by m.id collate "C")
    from public.members m where m.workspace_id=$1),'[]'::jsonb),
  'projects',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'workspace_id',p.workspace_id) order by p.id collate "C")
    from public.projects p where p.workspace_id=$1 and p.id in (select o.project_id from platform.operations o where o.workspace_id=$1 and o.id in ($2,$3))),'[]'::jsonb),
  'environments',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'workspace_id',e.workspace_id,'project_id',e.project_id,
    'connection_id',e.connection_id,'class',e.class,'data',jsonb_build_object('name',e.data->'name','region',e.data->'region',
    'baseDomain',e.data->'baseDomain','policies',e.data->'policies')) order by e.id collate "C") from public.environments e
    where e.workspace_id=$1 and e.id in (select o.environment_id from platform.operations o where o.workspace_id=$1 and o.id in ($2,$3))),'[]'::jsonb),
  'revisions',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'workspace_id',r.workspace_id,'project_id',r.project_id,'number',r.number)
    order by r.id collate "C") from public.revisions r where r.workspace_id=$1 and r.id in
    (select o.proposal->'input'->>'revisionId' from platform.operations o where o.workspace_id=$1 and o.id in ($2,$3))),'[]'::jsonb),
  'manifests',coalesce((select jsonb_agg(jsonb_build_object('revision_id',r.revision_id,'workspace_id',r.workspace_id,'manifest',r.manifest)
    order by r.revision_id collate "C") from public.revision_manifests r where r.workspace_id=$1 and r.revision_id in
    (select o.proposal->'input'->>'revisionId' from platform.operations o where o.workspace_id=$1 and o.id in ($2,$3))),'[]'::jsonb),
  'connections',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'workspace_id',c.workspace_id,'provider',c.provider,'data',c.data)
    order by c.id collate "C") from public.connections c where c.workspace_id=$1 and c.id in
    (select e.connection_id from public.environments e where e.workspace_id=$1 and e.id in
      (select o.environment_id from platform.operations o where o.workspace_id=$1 and o.id in ($2,$3)))),'[]'::jsonb),
  'providers',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'workspace_id',p.workspace_id,'legacy_connection_id',p.legacy_connection_id,
    'provider',p.provider,'mode',p.mode,'config',p.config,'status',p.status,'revoked_at',p.revoked_at,'created_by',p.created_by,'created_at',p.created_at) order by p.id collate "C")
    from platform.provider_connections p where p.workspace_id=$1 and p.id in
    (select c.data->>'platformConnectionId' from public.connections c where c.workspace_id=$1 and c.id in
      (select e.connection_id from public.environments e where e.workspace_id=$1 and e.id in
        (select o.environment_id from platform.operations o where o.workspace_id=$1 and o.id in ($2,$3))))),'[]'::jsonb),
  'settings',coalesce((select jsonb_agg(to_jsonb(s) order by s.environment_id collate "C") from platform.environment_settings s
    where s.workspace_id=$1 and s.environment_id in (select o.environment_id from platform.operations o where o.workspace_id=$1 and o.id in ($2,$3))),'[]'::jsonb),
  'policy',coalesce((select jsonb_agg(to_jsonb(p)) from platform.workspace_policy p where p.workspace_id=$1),'[]'::jsonb),
  'leases',coalesce((select jsonb_agg(jsonb_build_object('scope',l.scope,'workspace_id',l.workspace_id,'holder',l.holder,'fence_token',l.fence_token,
    'live',l.expires_at>clock_timestamp() and l.released_at is null) order by l.scope collate "C") from platform.leases l
    where l.workspace_id=$1 and l.scope in(select o.lease_scope from platform.operations o where o.workspace_id=$1 and o.id in ($2,$3))),'[]'::jsonb),
  'foreignSettings',exists(select 1 from platform.environment_settings s where s.workspace_id<>$1 and s.environment_id in
    (select o.environment_id from platform.operations o where o.workspace_id=$1 and o.id in ($2,$3)))
) as frame`, [scope.workspaceId,scope.parentOperationId,scope.childOperationId]);
  if (rows.length !== 1 || Buffer.byteLength(JSON.stringify(rows[0].frame)) > 2_000_000) return refuse();
  return Frame.parse(rows[0].frame);
}
function operation(frame: NativeFrame, scope: MixedChildIds, operationId: string, parent: boolean) {
  if (frame.foreignSettings) return refuse();
  const op = selected(frame.operations, "id", operationId), proposal = plain(op.proposal), input = plain(proposal.input), proposalScope = plain(proposal.scope);
  const principal = plain(op.principal);
  if (op.workspace_id !== scope.workspaceId || !Id.safeParse(op.project_id).success || !Id.safeParse(op.environment_id).success
    || !["infrastructure.apply", "deployment.deploy"].includes(String(op.capability)) || proposal.capability !== op.capability
    || principal.kind !== "user" || principal.onBehalfOf !== undefined || principal.integrationId !== undefined
    || proposalScope.workspaceId !== scope.workspaceId || proposalScope.projectId !== op.project_id || proposalScope.environmentId !== op.environment_id
    || digest(proposal) !== op.proposal_digest || digest(proposal.input) !== op.input_digest || !Hash.safeParse(op.plan_digest).success
    || op.approval_required !== true || !Number.isInteger(op.approval_round) || Number(op.approval_round) < 1 || op.live !== true
    || (parent ? op.status !== "running" || op.claimed !== true || op.lease_holder !== `workflow:${operationId}`
      : op.status !== "approved" || op.lease_holder !== null || op.fence_token !== null || op.lease_scope !== null)) return refuse();
  // A parent awaiting a child may have no environment fence. A recorded pair must still be genuine and live.
  if ((op.lease_scope === null) !== (op.fence_token === null)) return refuse();
  if (op.lease_scope !== null) {
    const lease = selected(frame.leases, "scope", String(op.lease_scope));
    if (op.lease_scope !== `env:${op.environment_id}` || lease.workspace_id !== scope.workspaceId || lease.live !== true
      || Number(lease.fence_token) !== Number(op.fence_token) || !Number.isSafeInteger(Number(op.fence_token)) || Number(op.fence_token) < 1
      || typeof lease.holder !== "string" || !lease.holder.endsWith(`:${operationId}`)
      || !/^worker:[A-Za-z0-9._-]{1,64}$/.test(lease.holder.slice(0,-operationId.length-1))) return refuse();
  }
  const member = selected(frame.members, "id", string(principal.id));
  if (member.workspace_id !== scope.workspaceId || !["editor", "admin"].includes(String(member.role))) return refuse();
  const decision = selected(frame.decisions, "id", string(op.policy_decision_id));
  const requirement = z.object({ count: z.number().int().min(1).max(50), minRole: z.enum(["editor", "admin"]), separationOfDuties: z.boolean() }).strict().parse(decision.approval);
  if (decision.workspace_id !== scope.workspaceId || decision.operation_id !== operationId || decision.outcome !== "require_approval") return refuse();
  const rank: Record<string, number> = { viewer: 0, editor: 1, admin: 2 };
  const approvals = frame.approvals.filter(a => a.operation_id === operationId && a.approval_round === op.approval_round);
  const current = approvals.filter(a => {
    const approver = plain(a.approver), m = frame.members.filter(member => member.id === a.approver_id);
    return a.workspace_id === scope.workspaceId && a.proposal_digest === op.proposal_digest && a.decision === "approve" && a.live === true
      && a.policy_version === decision.policy_version && rank[String(a.approver_role)] >= rank[requirement.minRole] && (parent ? a.consumed_at !== null : a.consumed_at === null)
      && approver.kind === "user" && approver.id === a.approver_id && approver.onBehalfOf === undefined && approver.integrationId === undefined
      && m.length === 1 && m[0].workspace_id === scope.workspaceId && rank[String(m[0].role)] >= rank[requirement.minRole]
      && (!requirement.separationOfDuties || a.approver_id !== principal.id);
  });
  if (approvals.some(a => a.decision === "reject") || new Set(current.map(a => a.approver_id)).size < requirement.count) return refuse();
  return { op, input, principal, decision, approvals: current, requirement };
}
function product(frame: NativeFrame, scope: MixedChildIds, current: ReturnType<typeof operation>) {
  const { op, input } = current;
  selected(frame.projects, "id", string(op.project_id));
  const env = selected(frame.environments, "id", string(op.environment_id)), revision = selected(frame.revisions, "id", string(input.revisionId));
  const manifest = selected(frame.manifests, "revision_id", string(input.revisionId));
  const connection = selected(frame.connections, "id", string(env.connection_id)), data = plain(env.data), connectionData = plain(connection.data);
  const provider = z.enum(["aws", "gcp", "azure", "oci"]).parse(connection.provider);
  const native = selected(frame.providers, "id", string(connectionData.platformConnectionId)), config = plain(native.config);
  if (env.workspace_id !== scope.workspaceId || env.project_id !== op.project_id || revision.workspace_id !== scope.workspaceId
    || revision.project_id !== op.project_id || manifest.workspace_id !== scope.workspaceId || connection.workspace_id !== scope.workspaceId
    || native.workspace_id !== scope.workspaceId || native.legacy_connection_id !== connection.id || native.provider !== provider
    || config.provider !== provider || config.mode !== native.mode || !["oidc_web_identity", "runner"].includes(String(native.mode))
    || provider === "oci" && native.mode !== "runner" || native.status !== "verified" || native.revoked_at !== null
    || config.region !== data.region || !Number.isInteger(revision.number) || Number(revision.number) < 1) return refuse();
  const policies = ManifestPolicies.parse(data.policies), parsed = parseManifest(manifest.manifest);
  if (!parsed.ok) return refuse();
  const environment = z.object({ id: Id, name: z.string().min(1).max(1000), class: z.enum(["production", "staging", "sandbox"]),
    provider: z.enum(["aws", "gcp", "azure", "oci"]), region: z.string().min(1).max(100), baseDomain: z.string().max(1000) }).parse({
      id: env.id, name: data.name, class: env.class, provider, region: data.region, baseDomain: data.baseDomain });
  const desired = isV1(parsed.manifest) ? upgradeManifest(parsed.manifest, { provider, region: environment.region, policies }) : parsed.manifest;
  const graph = expandManifest(desired, environment);
  if (!graph.nodes.length || graph.nodes.length > 1000 || graph.edges.length > 4000
    || graph.nodes.some(n => ["container_service", "scheduled_job", "build_pipeline"].includes(n.kind)) || frame.sources.length) return refuse();
  // Source-building and raw artifact authentication need the existing private codec/runtime; metadata is not a substitute.
  const account = config.provider === "aws" ? config.accountId : config.provider === "gcp" ? config.projectId
    : config.provider === "azure" ? config.subscriptionId : config.tenancyOcid;
  if (typeof account !== "string" || !account.length || account.length > 256) return refuse();
  const trustedConnection: ProviderConnection = { id: string(native.id), workspaceId: scope.workspaceId, legacyConnectionId: string(connection.id),
    config: config as unknown as ProviderConnection["config"], status: "verified", createdBy: string(native.created_by), createdAt: z.string().min(1).max(100).parse(native.created_at) };
  const backend = backendForConnection(trustedConnection, { workspaceId: scope.workspaceId, environmentId: environment.id });
  const file = backendFile(backend.backend, environment.region, backend.stateKey);
  return { graph, identity: { environmentId: environment.id, connectionId: trustedConnection.id, productConnectionId: connection.id,
    provider, accountId: account, region: environment.region, connectionIdentityDigest: digest(native),
    backendKind: backend.backend.kind, derivedBackendFileDigest: sha256Hex(stableJson(file.file)), stateLocationDigest: digest({ backend: backend.backend, key: backend.stateKey }) } };
}
function artifact(frame: NativeFrame, scope: MixedChildIds, current: ReturnType<typeof operation>, graph: ResourceGraph) {
  const { op } = current, artifact = selected(frame.artifacts, "operation_id", string(op.id)), manifest = plain(artifact.manifest);
  const hashes = ["sourceDigest", "graphDigest", "configDigest", "lockDigest", "backendDigest", "addressMapDigest", "planDigest", "rawSha256"];
  if (artifact.workspace_id !== scope.workspaceId || artifact.live !== true || artifact.plan_digest !== op.plan_digest
    || artifact.manifest_digest !== sha256Hex(stableJson(manifest)) || manifest.format !== "zenith.plan-artifact.v1"
    || manifest.purpose !== "deploy" || manifest.workspaceId !== scope.workspaceId || manifest.projectId !== op.project_id
    || manifest.environmentId !== op.environment_id || manifest.operationId !== op.id || manifest.proposalDigest !== op.proposal_digest
    || manifest.inputDigest !== op.input_digest || typeof manifest.expiresAt !== "string" || typeof op.expires_at !== "string"
    || typeof artifact.expires_at !== "string" || !Number.isFinite(Date.parse(manifest.expiresAt))
    || Date.parse(manifest.expiresAt) !== Date.parse(op.expires_at) || Date.parse(artifact.expires_at) !== Date.parse(op.expires_at)
    || !Number.isInteger(manifest.bytes) || Number(manifest.bytes) < 1 || Number(manifest.bytes) > MAX_PLAN_BYTES
    || manifest.planDigest !== op.plan_digest || manifest.graphDigest !== graph.graphDigest
    || hashes.some(key => !Hash.safeParse(manifest[key]).success)) return refuse();
  const reviewRows = frame.evidence.filter(e => e.operation_id === op.id && e.digest === op.plan_digest);
  if (!reviewRows.length) return refuse();
  const original = reviewRows[0], summary = plain(original.summary), review = projectPlanReview(summary, String(op.plan_digest));
  if (!review || review.view.truncated || review.view.diagnostics.some(d => d.severity === "error") || review.facts.unresolved?.length
    || summary.graphDigest !== graph.graphDigest || summary.configDigest !== manifest.configDigest || summary.lockDigest !== manifest.lockDigest
    || summary.executableSourceDigest !== undefined || review.view.approvedSources || review.view.executableSourceDigest) return refuse();
  return { planDigest: hash(op.plan_digest), approvalRound: Number(op.approval_round), proposalDigest: hash(op.proposal_digest), inputDigest: hash(op.input_digest),
    planManifestDigest: hash(artifact.manifest_digest), graphDigest: graph.graphDigest, sourceDigest: hash(manifest.sourceDigest),
    backendArtifactDigest: hash(manifest.backendDigest), rawSha256: hash(manifest.rawSha256), evidenceId: string(original.id),
    evidenceDigest: digest(original), policyDecisionDigest: digest(current.decision), approvalIds: current.approvals.map(a => string(a.id)).sort(),
    currentApprovalsDigest: digest(current.approvals), retainedRequirementDigest: digest(current.requirement) };
}
async function candidate(tx: Sql, scope: MixedChildIds, frame: NativeFrame): Promise<MixedChildCandidate> {
  const parent = operation(frame, scope, scope.parentOperationId, true), child = operation(frame, scope, scope.childOperationId, false);
  if (parent.op.project_id !== child.op.project_id || parent.op.environment_id === child.op.environment_id) return refuse();
  const history = await workflowStartIntents.get(tx, scope.workspaceId, scope.parentOperationId);
  if (!history || history.phase !== "acknowledged" || !history.attempt_id || !history.run_id || !history.evidence_digest
    || history.binding.proposalDigest !== parent.op.proposal_digest || history.binding.inputDigest !== parent.op.input_digest
    || history.binding.workflowId !== parent.op.workflow_id || history.binding.arguments.environmentId !== parent.op.environment_id) return refuse();
  const parentProduct = product(frame, scope, parent), childProduct = product(frame, scope, child);
  const parentPlan = artifact(frame, scope, parent, parentProduct.graph), childPlan = artifact(frame, scope, child, childProduct.graph);
  const providers = new Set(parentProduct.graph.nodes.filter(n => n.ownership !== "external").map(n => n.provider));
  if (providers.size < 2 || parentProduct.identity.connectionId === childProduct.identity.connectionId) return refuse();
  const nodes = childProduct.graph.nodes.map(node => {
    const matches = parentProduct.graph.nodes.filter(p => p.address === node.address);
    const original = matches[0];
    if (matches.length !== 1 || node.ownership === "external" || node.provider !== childProduct.identity.provider || node.region !== childProduct.identity.region
      || original.specDigest !== node.specDigest || original.provider !== node.provider || original.region !== node.region
      || original.kind !== node.kind || original.nativeType !== node.nativeType || original.ownership !== node.ownership
      || digest(original.dependsOn) !== digest(node.dependsOn) || node.specDigest !== digest({ kind: node.kind, provider: node.provider, region: node.region,
        nativeType: node.nativeType, ownership: node.ownership, spec: node.spec })) return refuse();
    return { address: node.address, kind: node.kind, nativeType: node.nativeType, ownership: node.ownership,
      specDigest: node.specDigest, parentNodeDigest: digest(original), childNodeDigest: digest(node), dependsOn: node.dependsOn.slice().sort() };
  }).sort((a,b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  const identity = childProduct.identity, partitionId = digest({ identity, nodes });
  return freeze({ format: "zenith.mixed-child-candidate.v1", workspaceId: scope.workspaceId, partitionId,
    executionEnabled: false, parentEffectCoverage: "unsupported", compilerReferenceCoverage: "unavailable", artifactBytesAuthenticated: false,
    connectionAuthorization: "not_minted", nativeFrameDigest: digest(frame),
    parent: { operationId: scope.parentOperationId, ...parentPlan, identity: parentProduct.identity,
      historyMetadataDigest: digest(frame.start), historyAuthenticated: false },
    child: { operationId: scope.childOperationId, ...childPlan, identity }, nodes,
    dependenciesDigest: digest({ parent: parentProduct.graph.edges, child: childProduct.graph.edges }) });
}
/** Retain metadata only. Approvals remain untouched; no executable effects or transport claim is created. */
export async function retain(sql: Sql, input: MixedChildIds): Promise<MixedChildCustody> {
  const scope = ids(sql, input);
  try {
    await assertPlatformSchemaCurrent(sql);
    if (!isOpenedPlatformDbHandle(sql, "postgres")) return refuse();
    return await sql.tx(async tx => {
      const locked = await tx.query<{ id: string }>(`select id from platform.operations where workspace_id=$1 and id=any($2::text[])
        order by id collate "C" for update`, [scope.workspaceId,textArray([scope.parentOperationId,scope.childOperationId])]);
      if (locked.length !== 2) return refuse();
      const isolation = await tx.query<{ isolation: string }>("select current_setting('transaction_isolation') as isolation");
      if (isolation[0]?.isolation !== "read committed") return refuse();
      const frame = await nativeFrame(tx, scope), descriptor = await candidate(tx, scope, frame), descriptorDigest = digest(descriptor);
      Descriptor.parse(descriptor);
      if (Buffer.byteLength(JSON.stringify(descriptor)) > 131_072) return refuse();
      // The actual existing outbox row is a separate wait. All current rows are reread after it at READ COMMITTED.
      const intent = await tx.query<{ phase: string }>(`select phase from platform.mixed_child_intents
        where workspace_id=$1 and parent_operation_id=$2 and child_operation_id=$3 for update`,
        [scope.workspaceId,scope.parentOperationId,scope.childOperationId]);
      if (intent.length && intent[0].phase !== "prepared") return refuse("nonreplayable");
      if (!isOpenedPlatformDbHandle(sql, "postgres")) return refuse();
      const fresh = await nativeFrame(tx, scope);
      if (digest(fresh) !== digest(frame)) return refuse("changed");
      // This fixed statement repeats the complete native frame in the insert snapshot. No dynamic SQL or caller predicate.
      const admitted = await tx.query<{ descriptor_digest: string }>(`with current_frame as (select jsonb_build_object(
  'operations',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'workspace_id',o.workspace_id,'project_id',o.project_id,
    'environment_id',o.environment_id,'capability',o.capability,'principal',o.principal,'proposal',o.proposal,
    'proposal_digest',o.proposal_digest,'input_digest',o.input_digest,'plan_digest',o.plan_digest,'approval_round',o.approval_round,
    'approval_required',o.approval_required,'policy_decision_id',o.policy_decision_id,'status',o.status,'workflow_id',o.workflow_id,
    'lease_holder',o.lease_holder,'lease_scope',o.lease_scope,'fence_token',o.fence_token,
    'expires_at',o.expires_at,'live',o.expires_at>clock_timestamp(),'claimed',o.lease_until>clock_timestamp()) order by o.id collate "C")
    from platform.operations o where o.workspace_id=$1 and o.id in ($2,$3)),'[]'::jsonb),
  'decisions',coalesce((select jsonb_agg(to_jsonb(p) order by p.id collate "C") from platform.policy_decisions p
    where p.workspace_id=$1 and p.id in (select o.policy_decision_id from platform.operations o where o.workspace_id=$1 and o.id in ($2,$3))),'[]'::jsonb),
  'approvals',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'operation_id',a.operation_id,'workspace_id',a.workspace_id,
    'proposal_digest',a.proposal_digest,'approval_round',a.approval_round,'decision',a.decision,'approver',a.approver,
    'approver_id',a.approver_id,'approver_role',a.approver_role,'policy_version',a.policy_version,'consumed_at',a.consumed_at,
    'live',a.expires_at>clock_timestamp()) order by a.id collate "C") from platform.approvals a
    where a.workspace_id=$1 and a.operation_id in ($2,$3)),'[]'::jsonb),
  'artifacts',coalesce((select jsonb_agg(jsonb_build_object('operation_id',a.operation_id,'workspace_id',a.workspace_id,
    'manifest',a.manifest,'manifest_digest',a.manifest_digest,'plan_digest',a.plan_digest,'expires_at',a.expires_at,'live',a.expires_at>clock_timestamp())
    order by a.operation_id collate "C") from platform.plan_artifacts a where a.workspace_id=$1 and a.operation_id in ($2,$3)),'[]'::jsonb),
  'evidence',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'operation_id',e.operation_id,'workspace_id',e.workspace_id,
    'digest',e.digest,'summary',e.summary,'created_at',e.created_at) order by e.created_at,e.id collate "C") from platform.evidence e
    where e.workspace_id=$1 and e.operation_id in ($2,$3) and e.kind='tofu_plan' and not e.simulated and e.summary->>'stage'='plan'),'[]'::jsonb),
  'sources',coalesce((select jsonb_agg(jsonb_build_object('operation_id',s.operation_id,'service_address',s.service_address,'snapshot_digest',s.snapshot_digest)
    order by s.operation_id collate "C",s.service_address collate "C") from platform.approved_source_snapshots s
    where s.workspace_id=$1 and s.operation_id in ($2,$3)),'[]'::jsonb),
  'start',coalesce((select jsonb_agg(to_jsonb(i) order by i.operation_id collate "C") from platform.workflow_start_intents i
    where i.workspace_id=$1 and i.operation_id=$2),'[]'::jsonb),
  'members',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'workspace_id',m.workspace_id,'role',m.role) order by m.id collate "C")
    from public.members m where m.workspace_id=$1),'[]'::jsonb),
  'projects',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'workspace_id',p.workspace_id) order by p.id collate "C")
    from public.projects p where p.workspace_id=$1 and p.id in (select o.project_id from platform.operations o where o.workspace_id=$1 and o.id in ($2,$3))),'[]'::jsonb),
  'environments',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'workspace_id',e.workspace_id,'project_id',e.project_id,
    'connection_id',e.connection_id,'class',e.class,'data',jsonb_build_object('name',e.data->'name','region',e.data->'region',
    'baseDomain',e.data->'baseDomain','policies',e.data->'policies')) order by e.id collate "C") from public.environments e
    where e.workspace_id=$1 and e.id in (select o.environment_id from platform.operations o where o.workspace_id=$1 and o.id in ($2,$3))),'[]'::jsonb),
  'revisions',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'workspace_id',r.workspace_id,'project_id',r.project_id,'number',r.number)
    order by r.id collate "C") from public.revisions r where r.workspace_id=$1 and r.id in
    (select o.proposal->'input'->>'revisionId' from platform.operations o where o.workspace_id=$1 and o.id in ($2,$3))),'[]'::jsonb),
  'manifests',coalesce((select jsonb_agg(jsonb_build_object('revision_id',r.revision_id,'workspace_id',r.workspace_id,'manifest',r.manifest)
    order by r.revision_id collate "C") from public.revision_manifests r where r.workspace_id=$1 and r.revision_id in
    (select o.proposal->'input'->>'revisionId' from platform.operations o where o.workspace_id=$1 and o.id in ($2,$3))),'[]'::jsonb),
  'connections',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'workspace_id',c.workspace_id,'provider',c.provider,'data',c.data)
    order by c.id collate "C") from public.connections c where c.workspace_id=$1 and c.id in
    (select e.connection_id from public.environments e where e.workspace_id=$1 and e.id in
      (select o.environment_id from platform.operations o where o.workspace_id=$1 and o.id in ($2,$3)))),'[]'::jsonb),
  'providers',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'workspace_id',p.workspace_id,'legacy_connection_id',p.legacy_connection_id,
    'provider',p.provider,'mode',p.mode,'config',p.config,'status',p.status,'revoked_at',p.revoked_at,'created_by',p.created_by,'created_at',p.created_at) order by p.id collate "C")
    from platform.provider_connections p where p.workspace_id=$1 and p.id in
    (select c.data->>'platformConnectionId' from public.connections c where c.workspace_id=$1 and c.id in
      (select e.connection_id from public.environments e where e.workspace_id=$1 and e.id in
        (select o.environment_id from platform.operations o where o.workspace_id=$1 and o.id in ($2,$3))))),'[]'::jsonb),
  'settings',coalesce((select jsonb_agg(to_jsonb(s) order by s.environment_id collate "C") from platform.environment_settings s
    where s.workspace_id=$1 and s.environment_id in (select o.environment_id from platform.operations o where o.workspace_id=$1 and o.id in ($2,$3))),'[]'::jsonb),
  'policy',coalesce((select jsonb_agg(to_jsonb(p)) from platform.workspace_policy p where p.workspace_id=$1),'[]'::jsonb),
  'leases',coalesce((select jsonb_agg(jsonb_build_object('scope',l.scope,'workspace_id',l.workspace_id,'holder',l.holder,'fence_token',l.fence_token,
    'live',l.expires_at>clock_timestamp() and l.released_at is null) order by l.scope collate "C") from platform.leases l
    where l.workspace_id=$1 and l.scope in(select o.lease_scope from platform.operations o where o.workspace_id=$1 and o.id in ($2,$3))),'[]'::jsonb),
  'foreignSettings',exists(select 1 from platform.environment_settings s where s.workspace_id<>$1 and s.environment_id in
    (select o.environment_id from platform.operations o where o.workspace_id=$1 and o.id in ($2,$3)))
) as frame)
        insert into platform.mixed_child_custody(workspace_id,parent_operation_id,child_operation_id,partition_id,descriptor,descriptor_digest)
        select $1,$2,$3,$5,$6::text::jsonb,$7 from current_frame where frame=$4::text::jsonb
        on conflict (workspace_id,child_operation_id) do nothing returning descriptor_digest`,
        [scope.workspaceId,scope.parentOperationId,scope.childOperationId,json(frame),partitionIdOf(descriptor),json(descriptor),descriptorDigest]);
      if (!admitted.length) {
        const current = await read(tx, scope);
        if (!current || current.phase !== "prepared" || current.descriptor_digest !== descriptorDigest || digest(current.descriptor) !== descriptorDigest) return refuse("changed");
        // A conflict cannot bypass the final current snapshot.
        const last = await nativeFrame(tx, scope);
        if (digest(last) !== digest(frame)) return refuse("changed");
        return current;
      }
      await tx.query(`insert into platform.mixed_child_intents(workspace_id,parent_operation_id,child_operation_id,descriptor_digest)
        values($1,$2,$3,$4) on conflict (workspace_id,child_operation_id) do nothing`,
        [scope.workspaceId,scope.parentOperationId,scope.childOperationId,descriptorDigest]);
      const result = await read(tx, scope);
      if (!result || result.phase !== "prepared" || result.descriptor_digest !== descriptorDigest) return refuse("changed");
      return result;
    });
  } catch (error) { if (error instanceof MixedChildAdmissionError) throw error; return refuse(); }
}
function partitionIdOf(descriptor: MixedChildCandidate): string { return descriptor.partitionId; }
/** There is deliberately no executable parent representation or fresh grant minting in this slice. */
export async function reserve(sql: Sql, input: MixedChildIds): Promise<never> {
  const scope = ids(sql, input), current = await get(sql, scope);
  if (current?.phase === "attempted" || current?.phase === "acknowledged") return refuse("nonreplayable");
  return refuse("unsupported_parent_effects");
}
