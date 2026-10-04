/** Internal native original-plan target authority. No caller attestation is accepted. */
import { z } from "zod/v4";
import type { Sql, Principal } from "@/lib/controlplane/types";
import type { ArtifactRow } from "./plan-artifacts";
import { digest } from "@/lib/controlplane/digest";
import { isV1, parseManifest } from "@/lib/resources/manifest-v2";
import { expandManifest } from "@/lib/resources/expand";
import { upgradeManifest } from "@/lib/resources/upgrade";
import { ManifestPolicies } from "@/lib/domain/types";
import { immutableSourceSnapshot, sourceSnapshotDigest, sourceSnapshotSetDigest, sourceRecipeMatches } from "@/lib/execution/source-snapshot";
import * as evidence from "./evidence";
import * as resources from "./resources";
import { PORTABLE_KINDS, type ResourceNode } from "@/lib/resources/types";
import type { CurrentDispatchRequirement, DispatchApprovalSnapshot } from "@/lib/execution/ports";
import { isCurrentNativeLinkedCredentialFor } from "@/lib/capabilities/current-integration-grants";
import type { NativeLinkedCredentialTuple } from "@/lib/agent-access/authority/pg";
type NativeDispatchRequirement = CurrentDispatchRequirement & {
  readonly nativeCredential?: Readonly<NativeLinkedCredentialTuple>; readonly nativeCredentialRequiredScope?: string;
  readonly delegatedDestroyPlan?: Readonly<{ operationId: string; evidenceId: string }>;
};

const Id = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/), Hash = z.string().regex(/^[a-f0-9]{64}$/);
const ObjectValue = z.record(z.string(), z.unknown());
const Row = z.object({ id: Id, workspace_id: Id, data: ObjectValue }).passthrough();
const tableNames = ["workspaces", "members", "projects", "environments", "revisions", "revision_manifests", "deployments", "connections"] as const;
type TableName = typeof tableNames[number];
type Tables = Record<TableName, string | null>;
const Reconstruction = z.object({ revisionId: Id.nullable(), revisionNumber: z.number().int().positive().nullable(),
  deployedRevisionId: Id.nullable(), deploymentId: Id.nullable(), deploymentOperationId: Id.nullable() }).strict();
const Witness = z.object({ stage: z.literal("original_plan_product_authority"), version: z.literal(1),
  phase: z.enum(["published", "claimed"]), kind: z.enum(["product", "native-absence"]),
  workspaceId: Id, projectId: Id, environmentId: Id, sourceOperationId: Id, destinationOperationId: Id, attemptId: Id,
  manifestDigest: Hash, planDigest: Hash, rawSha256: Hash, purpose: z.enum(["deploy", "destroy"]), sourceDigest: Hash,
  graphDigest: Hash, configDigest: Hash, backendDigest: Hash, lockDigest: Hash, addressMapDigest: Hash,
  semanticDigest: Hash, reconstruction: Reconstruction }).strict();
type WitnessValue = z.infer<typeof Witness>;
interface Operation { id: string; workspace_id: string; project_id: string; environment_id: string; capability: string;
  principal: Principal; proposal: { input?: Record<string, unknown>; broker?: { v?: number; teardownReview?: boolean; destroyPlan?: { operationId?: string; evidenceId?: string } } } }
interface Projection { [name: string]: unknown }
interface Capture {
  kind: WitnessValue["kind"]; tables: Tables; reconstruction: z.infer<typeof Reconstruction>; semanticDigest: string;
  workspace: Projection | null; project: Projection | null; environment: Projection | null; revision: Projection | null;
  manifest: Projection | null; deployment: Projection | null; connection: Projection | null; provider: Projection | null;
  destroyResources: { baseAddresses: string[]; retained: Projection[] } | null;
  member: { id: string; workspace_id: string; role: "viewer" | "editor" | "admin" } | null;
}
export interface PlanProductDispatchAuthority extends Capture {
  artifact: { operationId: string; manifestDigest: string; manifest: ArtifactRow["manifest"] };
  witness: { id: string; digest: string; summary: WitnessValue };
  currentRequirement?: NativeDispatchRequirement;
}
const refuse = (): never => { throw new Error("Current original plan product authority is unavailable or changed."); };
function bounded<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > 2_000_000) return refuse();
  return value;
}
function one(rows: { row: unknown }[]) {
  if (rows.length !== 1) return refuse();
  const result = Row.safeParse(rows[0].row);
  return result.success ? bounded(result.data) : refuse();
}
function witnessId(row: ArtifactRow, destination: string, attempt: string): string {
  return `evd_pp_${digest([row.workspace_id, row.operation_id, destination, attempt])}`;
}
function anchors(row: ArtifactRow, destination: string, attempt: string) {
  const m = row.manifest;
  return { workspaceId: m.workspaceId, projectId: m.projectId, environmentId: m.environmentId,
    sourceOperationId: m.operationId, destinationOperationId: destination, attemptId: attempt,
    manifestDigest: row.manifest_digest, planDigest: row.plan_digest, rawSha256: m.rawSha256, purpose: m.purpose,
    sourceDigest: m.sourceDigest, graphDigest: m.graphDigest, configDigest: m.configDigest, backendDigest: m.backendDigest,
    lockDigest: m.lockDigest, addressMapDigest: m.addressMapDigest };
}
async function saved(tx: Sql, row: ArtifactRow, destination: string, attempt: string, phase: WitnessValue["phase"], required: boolean) {
  const rows = await tx.query<{ id: string; digest: string; summary: unknown }>(`select id,digest,summary from platform.evidence
    where workspace_id=$1 and operation_id=$2 and id=$3 and kind='observation' and not simulated`,
    [row.workspace_id, destination, witnessId(row, destination, attempt)]);
  if (!rows.length && !required) return undefined;
  if (rows.length !== 1) return refuse();
  const parsed = Witness.safeParse(rows[0].summary);
  if (!parsed.success || parsed.data.phase !== phase || rows[0].digest !== digest(parsed.data)
    || Object.entries(anchors(row, destination, attempt)).some(([key, value]) => Reflect.get(parsed.data, key) !== value)) return refuse();
  return { id: rows[0].id, digest: rows[0].digest, summary: parsed.data };
}
async function owningOperation(tx: Sql, row: ArtifactRow, destination: string): Promise<Operation> {
  const rows = await tx.query<Operation>(`select id,workspace_id,project_id,environment_id,capability,principal,proposal
    from platform.operations where workspace_id=$1 and id=$2`, [row.workspace_id, destination]);
  if (rows.length !== 1 || rows[0].project_id !== row.manifest.projectId || rows[0].environment_id !== row.manifest.environmentId) return refuse();
  return rows[0];
}
/** Current tuples are private SQL inputs. Only their digest and reconstruction IDs are persisted in evidence. */
async function capture(tx: Sql, row: ArtifactRow, destination: string, previous?: WitnessValue, publication = false): Promise<Capture> {
  const m = row.manifest, ws = m.workspaceId, operation = await owningOperation(tx, row, destination);
  const original = destination === m.operationId ? operation : await owningOperation(tx, row, m.operationId);
  const input = operation.proposal.input ?? {}, originalInput = original.proposal.input ?? {};
  const subject = operation.principal.kind === "user" ? operation.principal.id
    : ["integration", "navigator"].includes(operation.principal.kind) ? operation.principal.onBehalfOf : undefined;
  const available = await tx.query<Tables>(`select to_regclass('public.workspaces')::text as workspaces,to_regclass('public.members')::text as members,
    to_regclass('public.projects')::text as projects,to_regclass('public.environments')::text as environments,
    to_regclass('public.revisions')::text as revisions,to_regclass('public.revision_manifests')::text as revision_manifests,
    to_regclass('public.deployments')::text as deployments,to_regclass('public.connections')::text as connections`);
  if (available.length !== 1) return refuse();
  const tables = available[0];
  const [projects, environments, workspaces, members] = await Promise.all([
    tables.projects ? tx.query<{ row: unknown }>("select to_jsonb(p) as row from public.projects p where id=$1 and workspace_id=$2", [m.projectId, ws]) : Promise.resolve([]),
    tables.environments ? tx.query<{ row: unknown }>("select to_jsonb(e) as row from public.environments e where id=$1 and workspace_id=$2", [m.environmentId, ws]) : Promise.resolve([]),
    tables.workspaces ? tx.query<{ row: unknown }>("select to_jsonb(w) as row from public.workspaces w where id=$1 and workspace_id=$1", [ws]) : Promise.resolve([]),
    tables.members ? tx.query<{ row: unknown }>("select jsonb_build_object('id',id,'workspace_id',workspace_id,'role',role) as row from public.members where workspace_id=$1 and id=$2 limit 2", [ws, subject ?? null]) : Promise.resolve([]),
  ]);
  // Absence compatibility must not mistake a foreign occupant for an absent
  // owning scope. These fixed probes return booleans, never foreign row data.
  const foreignOwners = await Promise.all([
    tables.projects ? tx.query<{ foreign: boolean }>("select exists(select 1 from public.projects where id=$1 and workspace_id<>$2) as foreign", [m.projectId, ws]) : Promise.resolve([]),
    tables.environments ? tx.query<{ foreign: boolean }>("select exists(select 1 from public.environments where id=$1 and workspace_id<>$2) as foreign", [m.environmentId, ws]) : Promise.resolve([]),
    tables.workspaces ? tx.query<{ foreign: boolean }>("select exists(select 1 from public.workspaces where id=$1 and workspace_id<>$1) as foreign", [ws]) : Promise.resolve([]),
  ]);
  if (foreignOwners.some(rows => rows[0]?.foreign)) return refuse();
  const owningMembers = tables.members ? await tx.query<{ present: boolean }>("select exists(select 1 from public.members where workspace_id=$1) as present", [ws]) : [];
  const marked = previous?.kind === "product"
    || [input, originalInput].some(value => ["revisionId", "deploymentId", "admissionVersion"].some(key => Object.hasOwn(value, key)));
  if (!marked && !projects.length && !environments.length && !workspaces.length && !owningMembers[0]?.present) {
    // Historical native fixture compatibility has no immutable product
    // marker or current owning scope. Absence alone cannot prove old origin.
    // New product publications retain an origin witness.
    const reconstruction = { revisionId: null, revisionNumber: null, deployedRevisionId: null, deploymentId: null, deploymentOperationId: null };
    return { kind: "native-absence", tables, reconstruction, semanticDigest: digest({ kind: "native-absence", tables, workspaceId: ws,
      projectId: m.projectId, environmentId: m.environmentId }), workspace: null, project: null, environment: null,
      revision: null, manifest: null, deployment: null, connection: null, provider: null, destroyResources: null, member: null };
  }
  if (tableNames.some(name => !tables[name]) || !subject) return refuse();
  const workspace = one(workspaces), project = one(projects), environment = one(environments);
  if (workspace.id !== ws || workspace.workspace_id !== ws || project.workspace_id !== ws || environment.workspace_id !== ws
    || environment.project_id !== project.id) return refuse();
  const member = members.filter(value => {
    const parsed = z.object({ id: Id, workspace_id: Id, role: z.enum(["viewer", "editor", "admin"]) }).strict().safeParse(value.row);
    return parsed.success && parsed.data.id === subject;
  });
  if (member.length !== 1) return refuse();
  const parsedMember = z.object({ id: Id, workspace_id: Id, role: z.enum(["viewer", "editor", "admin"]) }).strict().parse(member[0].row);
  // Read publication retains custody only. A linked plan-only integration
  // may delegate deletion to exact admin approval; a human mutation requester
  // must still be an editor or admin in the current owning workspace.
  const delegated = m.purpose === "destroy" && operation.capability === "infrastructure.destroy"
    && operation.proposal.broker?.v === 1 && operation.proposal.broker.teardownReview === true
    && operation.proposal.broker.destroyPlan?.operationId === original.id
    && typeof operation.proposal.broker.destroyPlan.evidenceId === "string" && original.capability === "infrastructure.plan"
    && originalInput.teardownReview === true;
  if (parsedMember.role === "viewer" && !(publication && operation.capability === "infrastructure.plan")
    && !(delegated && operation.principal.kind === "integration")) return refuse();
  const deployed = previous ? previous.reconstruction.deployedRevisionId : environment.deployed_revision_id ?? null;
  if (m.purpose === "destroy" && (environment.deployed_revision_id ?? null) !== deployed) return refuse();
  const revisionId = previous?.reconstruction.revisionId ?? originalInput.revisionId ?? input.revisionId ?? deployed;
  const connectionId = Id.safeParse(environment.connection_id), requestedRevision = Id.safeParse(revisionId);
  if (!connectionId.success || !requestedRevision.success || originalInput.revisionId && originalInput.revisionId !== revisionId
    || input.revisionId && input.revisionId !== revisionId) return refuse();
  const [revisions, manifests, connections] = await Promise.all([
    tx.query<{ row: unknown }>("select to_jsonb(r) as row from public.revisions r where id=$1 and workspace_id=$2", [revisionId, ws]),
    tx.query<{ row: unknown }>("select to_jsonb(r) as row from public.revision_manifests r where revision_id=$1 and workspace_id=$2", [revisionId, ws]),
    tx.query<{ row: unknown }>("select to_jsonb(c) as row from public.connections c where id=$1 and workspace_id=$2", [connectionId.data, ws]),
  ]);
  const revision = one(revisions), connection = one(connections), manifestRow = manifests.length === 1 && ObjectValue.safeParse(manifests[0].row);
  const provider = z.enum(["aws", "gcp", "azure", "oci", "kubernetes", "zenith"]).safeParse(connection.provider);
  const revisionNumber = z.number().int().positive().safeParse(revision.number), platformId = Id.safeParse(connection.data.platformConnectionId);
  if (!manifestRow || !manifestRow.success || manifestRow.data.revision_id !== revision.id || manifestRow.data.workspace_id !== ws
    || revision.workspace_id !== ws || revision.project_id !== project.id || connection.workspace_id !== ws
    || !provider.success || !platformId.success || !revisionNumber.success) return refuse();
  const env = z.object({ id: Id, projectId: Id, name: z.string().max(1000), class: z.enum(["production", "staging", "sandbox"]),
    region: z.string().min(1).max(200), baseDomain: z.string().max(1000), policies: ObjectValue, provider: z.literal(provider.data) }).safeParse({
    id: environment.id, projectId: project.id, name: environment.data.name, class: environment.class,
    region: environment.data.region, baseDomain: environment.data.baseDomain, policies: environment.data.policies, provider: provider.data });
  const parsed = parseManifest(manifestRow.data.manifest);
  const policies = ManifestPolicies.safeParse(environment.data.policies);
  if (!env.success || !parsed.ok || !policies.success) return refuse();
  const desired = isV1(parsed.manifest) ? upgradeManifest(parsed.manifest, { provider: provider.data, region: env.data.region, policies: policies.data }) : parsed.manifest;
  const baseGraph = expandManifest(desired, env.data);
  let graph = baseGraph;
  let destroyResources: Capture["destroyResources"] = null;
  if (m.purpose === "destroy") {
    // Mirror execution/destroy.context: deployed desired nodes plus live
    // retained native historical nodes, in JavaScript lexical address order.
    const nodes = new Map(baseGraph.nodes.map(node => [node.address, node]));
    const retained: Projection[] = [];
    const rows = await resources.listByEnvironment(tx, ws, m.environmentId);
    if (rows.length > 10000) return refuse();
    for (const resource of rows) {
      if (nodes.has(resource.address)) continue;
      const kind = z.enum([...PORTABLE_KINDS, "provider_native"]).safeParse(resource.kind);
      if (!kind.success || resource.provider !== provider.data || resource.projectId && resource.projectId !== project.id) return refuse();
      const node: ResourceNode = { address: resource.address, kind: kind.data, provider: provider.data,
        region: resource.region ?? env.data.region, nativeType: resource.nativeType, ownership: resource.ownership,
        spec: resource.spec, origin: resource.origin, dependsOn: resource.dependsOn, specDigest: resource.specDigest,
        labels: resource.labels, ...(resource.externalId ? { externalRef: resource.externalId } : {}) };
      nodes.set(node.address, node);
      retained.push({ workspace_id: ws, project_id: resource.projectId ?? null, environment_id: m.environmentId,
        address: resource.address, kind: resource.kind, provider: resource.provider, region: resource.region ?? null,
        native_type: resource.nativeType, ownership: resource.ownership, spec: resource.spec, spec_digest: resource.specDigest,
        origin: resource.origin, depends_on: resource.dependsOn, labels: resource.labels, external_id: resource.externalId ?? null });
    }
    const all = [...nodes.values()].sort((a,b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
    retained.sort((a,b) => String(a.address) < String(b.address) ? -1 : String(a.address) > String(b.address) ? 1 : 0);
    graph = { ...baseGraph, nodes: all, graphDigest: digest({ graphDigest: baseGraph.graphDigest, nodes: all }) };
    destroyResources = { baseAddresses: baseGraph.nodes.map(node => node.address), retained };
  }
  if (graph.graphDigest !== m.graphDigest) return refuse();
  const providers = await tx.query<{ row: Projection }>(`select jsonb_build_object('id',id,'workspace_id',workspace_id,'provider',provider,
    'mode',mode,'config',config,'status',status,'revoked_at',revoked_at) as row from platform.provider_connections where id=$1 and workspace_id=$2`, [platformId.data, ws]);
  if (providers.length !== 1 || providers[0].row.provider !== provider.data || providers[0].row.status !== "verified" || providers[0].row.revoked_at !== null) return refuse();
  const sourceRows = await tx.query<{ project_id: string; environment_id: string; service_address: string; snapshot: unknown; snapshot_digest: string }>(`select project_id,environment_id,
    service_address,snapshot,snapshot_digest from platform.approved_source_snapshots where workspace_id=$1 and operation_id=$2 order by service_address collate "C" limit 10001`, [ws, m.operationId]);
  if (sourceRows.length > 10000) return refuse();
  const sources = sourceRows.map(value => {
    const source = immutableSourceSnapshot(value.snapshot), service = graph.nodes.find(node => node.address === source.serviceAddress), pipeline = graph.nodes.find(node => node.address === source.pipelineAddress);
    if (source.workspaceId !== ws || source.operationId !== m.operationId || source.projectId !== project.id || source.environmentId !== environment.id
      || value.project_id !== project.id || value.environment_id !== environment.id || value.service_address !== source.serviceAddress
      || sourceSnapshotDigest(source) !== value.snapshot_digest || !service || !pipeline || !sourceRecipeMatches(source, service, pipeline)) return refuse();
    return source;
  });
  const expected = m.purpose === "destroy" ? [] : graph.nodes.filter(node => node.ownership === "managed" && ["container_service", "scheduled_job"].includes(node.kind)
    && ObjectValue.safeParse(node.spec.artifact).success && ObjectValue.parse(node.spec.artifact).type === "built");
  if (sources.length !== expected.length || expected.some(service => sources.filter(source => source.serviceAddress === service.address).length !== 1)) return refuse();
  const currentSourceDigest = digest({ revision: { id: revision.id, number: revisionNumber.data, manifest: manifestRow.data.manifest },
    deployedRevisionId: deployed, ...(sources.length ? { executableSourceDigest: sourceSnapshotSetDigest(sources) } : {}),
    connectionId: platformId.data, connectionConfig: providers[0].row.config, provider: provider.data, region: env.data.region });
  if (currentSourceDigest !== m.sourceDigest) return refuse();
  const deploymentId = previous?.reconstruction.deploymentId ?? originalInput.deploymentId ?? input.deploymentId ?? null;
  const deploymentOperationId = previous?.reconstruction.deploymentOperationId ?? (originalInput.deploymentId ? original.id : input.deploymentId ? operation.id : null);
  let deployment: Projection | null = null;
  if (deploymentId !== null) {
    if (!Id.safeParse(deploymentId).success) return refuse();
    const current = one(await tx.query<{ row: unknown }>("select to_jsonb(d) as row from public.deployments d where id=$1 and workspace_id=$2", [deploymentId, ws]));
    if (current.workspace_id !== ws || current.project_id !== project.id || current.environment_id !== environment.id || current.revision_id !== revision.id
      || current.data.executor !== "workflow" || current.data.operationId !== deploymentOperationId) return refuse();
    deployment = { id: current.id, workspace_id: ws, project_id: project.id, environment_id: environment.id, revision_id: revision.id,
      data: { executor: current.data.executor, operationId: current.data.operationId } };
  }
  const reconstruction = Reconstruction.parse({ revisionId, revisionNumber: revisionNumber.data, deployedRevisionId: deployed, deploymentId, deploymentOperationId });
  const projection = { workspace: { id: ws, workspace_id: ws }, project: { id: project.id, workspace_id: ws },
    environment: { id: environment.id, workspace_id: ws, project_id: project.id, class: environment.class, connection_id: connection.id,
      data: { name: env.data.name, region: env.data.region, baseDomain: env.data.baseDomain, policies: env.data.policies } },
    revision: { id: revision.id, workspace_id: ws, project_id: project.id, number: revisionNumber.data },
    manifest: { revision_id: revision.id, workspace_id: ws, manifest: manifestRow.data.manifest }, deployment,
    connection: { id: connection.id, workspace_id: ws, provider: provider.data, data: { region: connection.data.region, platformConnectionId: platformId.data } },
    provider: providers[0].row, destroyResources };
  if (typeof connection.data.region !== "string") return refuse();
  return bounded({ kind: "product", tables, reconstruction, semanticDigest: digest(projection), ...projection, member: parsedMember });
}
async function writeWitness(tx: Sql, row: ArtifactRow, destination: string, attempt: string, phase: WitnessValue["phase"], current: Capture) {
  const summary = Witness.parse({ stage: "original_plan_product_authority", version: 1, phase, kind: current.kind,
    ...anchors(row, destination, attempt), semanticDigest: current.semanticDigest, reconstruction: current.reconstruction });
  const input = { id: witnessId(row, destination, attempt), workspaceId: row.workspace_id, operationId: destination,
    kind: "observation" as const, digest: digest(summary), summary, simulated: false };
  const prior = await saved(tx, row, destination, attempt, phase, false);
  if (prior) { if (prior.digest !== input.digest) return refuse(); return prior; }
  const written = await evidence.insert(tx, input);
  return { id: written.id, digest: written.digest, summary };
}
/** Publication remembers product origin before a later deletion could look like native absence. */
export async function retainPublishedPlanProductAuthority(tx: Sql, row: ArtifactRow): Promise<void> {
  const prior = await saved(tx, row, row.operation_id, "published", "published", false);
  const current = await capture(tx, row, row.operation_id, prior?.summary, true);
  if (prior && prior.summary.semanticDigest !== current.semanticDigest) return refuse();
  if (current.kind === "product") await writeWitness(tx, row, row.operation_id, "published", "published", current);
}
export async function retainClaimedPlanProductAuthority(tx: Sql, row: ArtifactRow, destination: string, attempt: string): Promise<PlanProductDispatchAuthority> {
  Id.parse(attempt);
  const origin = await saved(tx, row, row.operation_id, "published", "published", false);
  const current = await capture(tx, row, destination, origin?.summary);
  if (origin && origin.summary.semanticDigest !== current.semanticDigest) return refuse();
  const witness = await writeWitness(tx, row, destination, attempt, "claimed", current);
  return bounded({ ...current, artifact: { operationId: row.operation_id, manifestDigest: row.manifest_digest, manifest: row.manifest }, witness });
}
export async function captureClaimedPlanProductAuthority(tx: Sql, row: ArtifactRow, destination: string, attempt: string): Promise<PlanProductDispatchAuthority> {
  const witness = await saved(tx, row, destination, attempt, "claimed", true);
  if (!witness) return refuse();
  const current = await capture(tx, row, destination, witness.summary);
  if (current.kind !== witness.summary.kind || current.semanticDigest !== witness.summary.semanticDigest) return refuse();
  return bounded({ ...current, artifact: { operationId: row.operation_id, manifestDigest: row.manifest_digest, manifest: row.manifest }, witness });
}
/** Boolean internal lookup for the captured default runtime; no authority object is exposed. */
export async function claimedPlanRequiresProductComposition(sql: Sql, row: ArtifactRow, destination: string, attempt: string): Promise<boolean> {
  const witness = await saved(sql, row, destination, attempt, "claimed", true);
  return witness?.summary.kind === "product";
}
/** Requirement shape is never sufficient. Only the captured broker's exact private origin is accepted. */
export async function withCurrentPlanDispatchRequirement(sql: Sql, current: PlanProductDispatchAuthority, snapshot: Readonly<DispatchApprovalSnapshot> | undefined): Promise<PlanProductDispatchAuthority> {
  if (current.kind !== "product") return current;
  const { readCurrentDispatchRequirement } = await import("@/lib/platform/broker");
  const value = await readCurrentDispatchRequirement(snapshot, sql, current.witness.summary.workspaceId, current.witness.summary.destinationOperationId);
  const input = value?.policy.input, environmentData = ObjectValue.safeParse(current.environment?.data);
  if (!value || !input || value.operation.resource_id !== null || input.resource !== undefined || !current.environment || !current.connection || !current.member || !input.environment
    || input.environment.id !== current.environment.id || input.environment.class !== current.environment.class
    || !environmentData.success || input.environment.provider !== current.connection.provider || input.environment.region !== environmentData.data.region) return refuse();
  const principal = value.operation.principal;
  if (!principal || typeof principal !== "object") return refuse();
  const kind = Reflect.get(principal, "kind"), subject = kind === "user" ? Reflect.get(principal, "id") : Reflect.get(principal, "onBehalfOf");
  if (subject !== current.member.id || !["user", "integration"].includes(kind)) return refuse();
  if (input.principal.kind === "system") {
    if (value.operation.capability !== "infrastructure.destroy" || input.principal.id !== "teardown-review"
      || !value.delegatedDestroyPlan || value.delegatedDestroyPlan.operationId !== current.artifact.operationId
      || !value.requirement || value.requirement.minRole !== "admin" || value.requirement.count < 1
      || kind === "user" && !["editor", "admin"].includes(current.member.role)) return refuse();
  } else if (input.principal.kind !== kind || input.principal.id !== Reflect.get(principal, "id")
    || input.principal.role !== current.member.role || !["editor", "admin"].includes(current.member.role)) return refuse();
  if (kind === "integration") {
    const tuple = value.nativeCredential, requiredScope = value.nativeCredentialRequiredScope;
    if (!tuple || !requiredScope || !tuple.scopes.includes(requiredScope) || !tuple.project_ids.includes(String(current.project?.id))
      || tuple.environment_ids && !tuple.environment_ids.includes(String(current.environment.id))
      || !isCurrentNativeLinkedCredentialFor(tuple, sql, current.witness.summary.workspaceId, String(Reflect.get(principal, "id")), String(subject))) return refuse();
  } else if (value.nativeCredential) return refuse();
  return bounded({ ...current, currentRequirement: value });
}
/** All values below are re-derived by this repository. Every tuple is repeated in the final post-wait statement. */
export function planProductDispatchPredicate(current: PlanProductDispatchAuthority): string {
  const base = `exists(select 1 from platform.plan_artifacts a where a.workspace_id=$1
    and a.operation_id=$8::text::jsonb->'artifact'->>'operationId' and a.manifest_digest=$8::text::jsonb->'artifact'->>'manifestDigest'
    and a.manifest=$8::text::jsonb->'artifact'->'manifest')
    and exists(select 1 from platform.evidence e where e.workspace_id=$1 and e.operation_id=$2 and e.id=$8::text::jsonb->'witness'->>'id'
      and e.kind='observation' and not e.simulated and e.digest=$8::text::jsonb->'witness'->>'digest'
      and e.summary=$8::text::jsonb->'witness'->'summary' and e.summary->>'phase'='claimed'
      and e.summary->>'destinationOperationId'=$2 and e.summary->>'attemptId'=$3)`;
  const tables = tableNames.map(name => `to_regclass('public.${name}')::text is not distinct from $8::text::jsonb->'tables'->>'${name}'`).join(" and ");
  if (current.kind === "native-absence") {
    const absence = [current.tables.workspaces ? "not exists(select 1 from public.workspaces where id=$8::text::jsonb->'witness'->'summary'->>'workspaceId')" : "true",
      current.tables.projects ? "not exists(select 1 from public.projects where id=$8::text::jsonb->'witness'->'summary'->>'projectId')" : "true",
      current.tables.environments ? "not exists(select 1 from public.environments where id=$8::text::jsonb->'witness'->'summary'->>'environmentId')" : "true",
      current.tables.members ? "not exists(select 1 from public.members where workspace_id=$1)" : "true"].join(" and ");
    return `${base} and ${tables} and ${absence}`;
  }
  // Human dispatch does not acquire a dependency on the optional agent schema.
  // This SQL branch is selected only by the genuine privately derived tuple.
  const credential = current.currentRequirement?.nativeCredential ? `$8::text::jsonb->'currentRequirement'->'operation'->'principal'->>'kind'='integration' and exists(
      select 1 from agent.agent_credentials c where c.id=$8::text::jsonb->'currentRequirement'->'operation'->'principal'->>'id'
        and c.id=$8::text::jsonb->'currentRequirement'->'operation'->'principal'->>'integrationId'
        and c.subject=$8::text::jsonb->'member'->>'id' and c.workspace_id=$1 and c.revoked_at is null
        and c.issued_at<=to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        and c.expires_at>to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        and jsonb_build_object('id',c.id,'subject',c.subject,'workspace_id',c.workspace_id,
          'project_ids',case when jsonb_typeof(c.project_ids)='string' then (c.project_ids#>>'{}')::jsonb else c.project_ids end,
          'environment_ids',case when jsonb_typeof(c.environment_ids)='string' then (c.environment_ids#>>'{}')::jsonb else c.environment_ids end,
          'scopes',case when jsonb_typeof(c.scopes)='string' then (c.scopes#>>'{}')::jsonb else c.scopes end,
          'issued_at',c.issued_at,'expires_at',c.expires_at,'revoked_at',c.revoked_at)=$8::text::jsonb->'currentRequirement'->'nativeCredential'
        and (case when jsonb_typeof(c.project_ids)='string' then (c.project_ids#>>'{}')::jsonb else c.project_ids end) ? ($8::text::jsonb->'project'->>'id')
        and (c.environment_ids is null or (case when jsonb_typeof(c.environment_ids)='string' then (c.environment_ids#>>'{}')::jsonb else c.environment_ids end) ? ($8::text::jsonb->'environment'->>'id'))
        and (case when jsonb_typeof(c.scopes)='string' then (c.scopes#>>'{}')::jsonb else c.scopes end) ? ($8::text::jsonb->'currentRequirement'->>'nativeCredentialRequiredScope'))
` : "$8::text::jsonb->'currentRequirement'->'operation'->'principal'->>'kind'='user' and $8::text::jsonb->'member'->>'role' in ('editor','admin')";
  const requirement = current.currentRequirement ? `
    and exists(select 1 from platform.operations o where o.workspace_id=$1 and o.id=$2
      and jsonb_build_object('id',o.id,'workspace_id',o.workspace_id,'project_id',o.project_id,'environment_id',o.environment_id,'resource_id',o.resource_id,
        'capability',o.capability,'principal',o.principal,'proposal_digest',o.proposal_digest,'input_digest',o.input_digest,'plan_digest',o.plan_digest,'approval_round',o.approval_round)=$8::text::jsonb->'currentRequirement'->'operation')
    and (case when $8::text::jsonb->'currentRequirement'->'settings'->'workspace'='null'::jsonb then not exists(select 1 from platform.workspace_policy where workspace_id=$1)
      else exists(select 1 from platform.workspace_policy p where p.workspace_id=$1 and jsonb_build_object('workspace_id',p.workspace_id,'params',p.params)=$8::text::jsonb->'currentRequirement'->'settings'->'workspace') end)
    and (case when $8::text::jsonb->'currentRequirement'->'settings'->'environment'='null'::jsonb then not exists(select 1 from platform.environment_settings where environment_id=$8::text::jsonb->'environment'->>'id')
      else exists(select 1 from platform.environment_settings e where e.workspace_id=$1 and e.environment_id=$8::text::jsonb->'environment'->>'id'
        and jsonb_build_object('workspace_id',e.workspace_id,'environment_id',e.environment_id,'autonomy_level',e.autonomy_level,'policy_params',e.policy_params)=$8::text::jsonb->'currentRequirement'->'settings'->'environment') end)
    and exists(select 1 from platform.evidence e where e.workspace_id=$1 and e.operation_id=$2 and e.id=$8::text::jsonb->'currentRequirement'->'evidence'->>'id'
      and e.kind='tofu_plan' and not e.simulated and e.digest=$8::text::jsonb->'currentRequirement'->'evidence'->>'digest'
      and e.summary=$8::text::jsonb->'currentRequirement'->'evidence'->'summary'
      and e.id=(select id from platform.evidence where workspace_id=$1 and operation_id=$2 and kind='tofu_plan' and not simulated
        and digest=$8::text::jsonb->'currentRequirement'->'operation'->>'plan_digest' and summary->>'stage'='plan' order by created_at,id limit 1))
    and (${credential})
    and (case when $8::text::jsonb->'currentRequirement'->'policy'->'input'->'principal'->>'kind'='system' then exists(
      select 1 from platform.operations o join platform.operations original on original.workspace_id=o.workspace_id
        and original.id=$8::text::jsonb->'artifact'->>'operationId'
      where o.workspace_id=$1 and o.id=$2 and o.capability='infrastructure.destroy' and o.proposal->'broker'->>'v'='1'
        and o.proposal->'broker'->>'teardownReview'='true' and o.proposal->'broker'->'destroyPlan'->>'operationId'=original.id
        and o.proposal->'broker'->'destroyPlan'->>'evidenceId'=$8::text::jsonb->'currentRequirement'->'delegatedDestroyPlan'->>'evidenceId'
        and original.capability='infrastructure.plan' and original.proposal->'input'->>'teardownReview'='true'
        and exists(select 1 from platform.evidence e where e.workspace_id=$1 and e.operation_id=original.id
          and e.id=o.proposal->'broker'->'destroyPlan'->>'evidenceId' and e.kind='tofu_plan' and not e.simulated
          and e.digest=$8::text::jsonb->'artifact'->'manifest'->>'planDigest')
        and $8::text::jsonb->'currentRequirement'->'requirement'->>'minRole'='admin'
        and ($8::text::jsonb->'currentRequirement'->'requirement'->>'count')::integer>=1)
      else true end)
    and (select count(distinct m.id) from platform.approvals a join platform.operations approved_operation on approved_operation.workspace_id=a.workspace_id
      and approved_operation.id=a.operation_id and approved_operation.approval_round=a.approval_round and approved_operation.proposal_digest=a.proposal_digest
      join public.members m on m.workspace_id=a.workspace_id and m.id=a.approver_id
      where a.workspace_id=$1 and a.operation_id=$2 and a.decision='approve' and a.approver->>'kind'='user' and a.approver->>'id'=a.approver_id
      and a.approval_round=($8::text::jsonb->'currentRequirement'->'operation'->>'approval_round')::integer
      and a.proposal_digest=$8::text::jsonb->'currentRequirement'->'operation'->>'proposal_digest'
      and approved_operation.plan_digest is not distinct from $8::text::jsonb->'currentRequirement'->'operation'->>'plan_digest'
      and a.consumed_at is not null and a.expires_at>clock_timestamp()
      and m.role in ('editor','admin') and (coalesce($8::text::jsonb->'currentRequirement'->'requirement'->>'minRole','editor')<>'admin' or m.role='admin')
      and (not coalesce(($8::text::jsonb->'currentRequirement'->'requirement'->>'separationOfDuties')::boolean,false) or m.id<>$8::text::jsonb->'member'->>'id')
      and exists(select 1 from jsonb_array_elements($8::text::jsonb->'currentRequirement'->'approvals') captured where captured=to_jsonb(a)))
      >=coalesce(($8::text::jsonb->'currentRequirement'->'requirement'->>'count')::integer,0)
    and not exists(select 1 from jsonb_array_elements($8::text::jsonb->'currentRequirement'->'approvals') captured
      where not exists(select 1 from platform.approvals a join platform.operations approved_operation on approved_operation.workspace_id=a.workspace_id
      and approved_operation.id=a.operation_id and approved_operation.approval_round=a.approval_round and approved_operation.proposal_digest=a.proposal_digest
      join public.members m on m.workspace_id=a.workspace_id and m.id=a.approver_id
        where a.workspace_id=$1 and a.operation_id=$2 and to_jsonb(a)=captured and a.decision='approve'
        and a.approver->>'kind'='user' and a.approver->>'id'=m.id and a.consumed_at is not null and a.expires_at>clock_timestamp()
        and a.approval_round=($8::text::jsonb->'currentRequirement'->'operation'->>'approval_round')::integer
        and a.proposal_digest=$8::text::jsonb->'currentRequirement'->'operation'->>'proposal_digest'
        and approved_operation.plan_digest is not distinct from $8::text::jsonb->'currentRequirement'->'operation'->>'plan_digest'
        and m.role in ('editor','admin') and (coalesce($8::text::jsonb->'currentRequirement'->'requirement'->>'minRole','editor')<>'admin' or m.role='admin')
        and (not coalesce(($8::text::jsonb->'currentRequirement'->'requirement'->>'separationOfDuties')::boolean,false) or m.id<>$8::text::jsonb->'member'->>'id')))
    and not exists(select 1 from platform.approvals a where a.workspace_id=$1 and a.operation_id=$2
      and a.approval_round=($8::text::jsonb->'currentRequirement'->'operation'->>'approval_round')::integer and a.decision='reject')` : "";
  return `${base} and ${tables}
    and exists(select 1 from public.workspaces w where w.workspace_id=$1 and w.id=$8::text::jsonb->'workspace'->>'id' and jsonb_build_object('id',w.id,'workspace_id',w.workspace_id)=$8::text::jsonb->'workspace')
    and exists(select 1 from public.projects p where p.workspace_id=$1 and p.id=$8::text::jsonb->'project'->>'id' and jsonb_build_object('id',p.id,'workspace_id',p.workspace_id)=$8::text::jsonb->'project')
    and exists(select 1 from public.environments e where e.workspace_id=$1 and e.id=$8::text::jsonb->'environment'->>'id' and jsonb_build_object('id',e.id,'workspace_id',e.workspace_id,'project_id',e.project_id,
      'class',e.class,'connection_id',e.connection_id,'data',jsonb_build_object('name',e.data->'name','region',e.data->'region','baseDomain',e.data->'baseDomain','policies',e.data->'policies'))=$8::text::jsonb->'environment')
    and exists(select 1 from public.revisions r where r.workspace_id=$1 and r.id=$8::text::jsonb->'revision'->>'id' and jsonb_build_object('id',r.id,'workspace_id',r.workspace_id,'project_id',r.project_id,'number',r.number)=$8::text::jsonb->'revision')
    and exists(select 1 from public.revision_manifests m where m.workspace_id=$1 and m.revision_id=$8::text::jsonb->'manifest'->>'revision_id' and jsonb_build_object('revision_id',m.revision_id,'workspace_id',m.workspace_id,'manifest',m.manifest)=$8::text::jsonb->'manifest')
    and ($8::text::jsonb->'deployment'='null'::jsonb or exists(select 1 from public.deployments d where d.workspace_id=$1 and d.id=$8::text::jsonb->'deployment'->>'id' and jsonb_build_object('id',d.id,'workspace_id',d.workspace_id,
      'project_id',d.project_id,'environment_id',d.environment_id,'revision_id',d.revision_id,'data',jsonb_build_object('executor',d.data->'executor','operationId',d.data->'operationId'))=$8::text::jsonb->'deployment'))
    and exists(select 1 from public.connections c where c.workspace_id=$1 and c.id=$8::text::jsonb->'connection'->>'id' and jsonb_build_object('id',c.id,'workspace_id',c.workspace_id,'provider',c.provider,
      'data',jsonb_build_object('region',c.data->'region','platformConnectionId',c.data->'platformConnectionId'))=$8::text::jsonb->'connection')
    and exists(select 1 from platform.provider_connections c where c.workspace_id=$1 and c.id=$8::text::jsonb->'provider'->>'id' and c.status='verified' and c.revoked_at is null
      and jsonb_build_object('id',c.id,'workspace_id',c.workspace_id,'provider',c.provider,'mode',c.mode,'config',c.config,'status',c.status,'revoked_at',c.revoked_at)=$8::text::jsonb->'provider')
    and ($8::text::jsonb->'artifact'->'manifest'->>'purpose'<>'destroy' or exists(select 1 from public.environments e where e.workspace_id=$1
      and e.id=$8::text::jsonb->'environment'->>'id' and e.deployed_revision_id is not distinct from $8::text::jsonb->'reconstruction'->>'deployedRevisionId'))
    and ($8::text::jsonb->'destroyResources'='null'::jsonb or coalesce((select jsonb_agg(jsonb_build_object(
      'workspace_id',r.workspace_id,'project_id',r.project_id,'environment_id',r.environment_id,'address',r.address,'kind',r.kind,'provider',r.provider,
      'region',r.region,'native_type',r.native_type,'ownership',r.ownership,'spec',r.spec,'spec_digest',r.spec_digest,'origin',r.origin,
      'depends_on',r.depends_on,'labels',r.labels,'external_id',r.external_id) order by r.address collate "C")
      from platform.resources r where r.workspace_id=$1 and r.environment_id=$8::text::jsonb->'environment'->>'id' and r.status<>'deleted'
      and not exists(select 1 from jsonb_array_elements_text($8::text::jsonb->'destroyResources'->'baseAddresses') as base_address(value) where base_address.value=r.address)), '[]'::jsonb)
      =$8::text::jsonb->'destroyResources'->'retained')
    and exists(select 1 from platform.operations o join public.members m on m.workspace_id=o.workspace_id
      and m.id=case when o.principal->>'kind'='user' then o.principal->>'id' when o.principal->>'kind' in ('integration','navigator') then o.principal->>'onBehalfOf' end
      where o.workspace_id=$1 and o.id=$2 and m.role in ('viewer','editor','admin')
      and jsonb_build_object('id',m.id,'workspace_id',m.workspace_id,'role',m.role)=$8::text::jsonb->'member')${requirement}`;
}
