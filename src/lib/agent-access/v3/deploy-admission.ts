/** Product association for MCP deploys. Native broker and start intents retain authority. */
import { z } from "zod/v4";
import { withMutationGate } from "@/lib/actions/mutation-gate";
import { platformBroker } from "@/lib/capabilities/platform";
import type { OperationView } from "@/lib/capabilities/types";
import { parseRequest } from "@/lib/capabilities/broker";
import { BrokerError } from "@/lib/capabilities/errors";
import { digest } from "@/lib/controlplane/digest";
import { db, flushPendingAsync, isPostgres, q, save } from "@/lib/db/store";
import { loadSnapshot, pgClient } from "@/lib/db/postgres-store";
import { runWithSnapshot } from "@/lib/db/request-snapshot";
import { executionRoute } from "@/lib/bridge/deploy";
import { plannedWorkflowSteps } from "@/lib/bridge/steps";
import type { Deployment } from "@/lib/domain/types";
import { parseManifest } from "@/lib/resources/manifest-v2";
import type { DeployWorkflowInput } from "@/lib/workflows/types";
import { graphFor } from "./context";
import { McpToolError, notFound } from "./errors";
import type { AgentIdentity } from "./principal";
import type { DeployAdmissionPort, DeployAdmissionRequest, EnvironmentInfo, PreparedDeployAdmission } from "./ports";
import { estimateSummary, tryEstimate } from "./tools/estimate";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const McpDeployInput = z.object({
  operation: z.literal("deploy"), admissionVersion: z.literal(1),
  deploymentId: z.string().regex(/^mcp-deploy-[a-f0-9]{64}$/),
  revisionId: id, revisionNumber: z.number().int().positive(), connectionId: id,
  manifestDigest: hash, graphDigest: hash, environmentDigest: hash, connectionDigest: hash,
  build: z.boolean(), message: z.string().max(1000).optional(),
  estimate: z.record(z.string(), z.unknown()),
}).strict();
type ProposalInput = z.infer<typeof McpDeployInput>;
const Admission = z.object({ version: z.literal(1), workspaceId: id, integrationId: id,
  subject: id, reservationDigest: hash, input: McpDeployInput }).strict();
type AdmittedDeployment = Deployment & { mcpAdmission: z.infer<typeof Admission> };

function refuse(code = "deployment_admission_conflict"): never {
  throw new McpToolError(code, "The saved deployment admission could not be confirmed for this exact operation.", 409,
    "Inspect the saved operation and deployment. Reuse the original key only for the original request.");
}
function requester(identity: AgentIdentity): { workspaceId: string; integrationId: string; subject: string } {
  const parsed = z.object({ workspaceId: id, integrationId: id, subject: id }).safeParse(identity);
  if (!parsed.success || !Number.isFinite(Date.parse(identity.expiresAt)) || Date.parse(identity.expiresAt) <= Date.now()) refuse();
  return parsed.data;
}
/** The same actor/capability/key tuple used by broker reservation, additionally tenant bound. */
export function deploymentReservation(request: DeployAdmissionRequest): { deploymentId: string; reservationDigest: string } {
  const actor = requester(request.identity);
  if (actor.workspaceId !== request.target.workspaceId || !request.identity.projectIds.includes(request.target.projectId)
    || request.identity.environmentIds && !request.identity.environmentIds.includes(request.target.environmentId)) throw notFound();
  const reservationDigest = digest({ version: 1, ...actor, capability: "deployment.deploy", idempotencyKey: request.idempotencyKey });
  return { deploymentId: `mcp-deploy-${reservationDigest}`, reservationDigest };
}
function admission(row: Deployment): z.infer<typeof Admission> {
  if (!("mcpAdmission" in row)) refuse();
  const parsed = Admission.safeParse(row.mcpAdmission);
  if (!parsed.success) refuse();
  return parsed.data;
}
function owns(identity: AgentIdentity, operation: OperationView): void {
  const actor = requester(identity);
  if (operation.workspaceId !== actor.workspaceId || operation.principal.kind !== "integration"
    || operation.principal.id !== actor.integrationId
    || operation.principal.onBehalfOf !== actor.subject || !operation.projectId || !operation.environmentId
    || !identity.projectIds.includes(operation.projectId)
    || identity.environmentIds && !identity.environmentIds.includes(operation.environmentId)) throw notFound();
}
function rowFor(identity: AgentIdentity, operation: OperationView): { row: Deployment; input: ProposalInput } {
  owns(identity, operation);
  const parsed = McpDeployInput.safeParse(operation.proposal.input);
  if (!parsed.success || operation.capability !== "deployment.deploy") refuse("operation_input_invalid");
  const input = parsed.data;
  const row = q.deployment(input.deploymentId);
  if (!row || row.executor !== "workflow" || row.projectId !== operation.projectId
    || row.environmentId !== operation.environmentId || row.revisionId !== input.revisionId) refuse();
  const saved = admission(row);
  if (saved.workspaceId !== operation.workspaceId || saved.integrationId !== identity.integrationId || saved.subject !== identity.subject
    || digest(saved.input) !== digest(operation.proposal.input)) refuse();
  return { row, input };
}
function alive(signal: AbortSignal): void { if (signal.aborted) refuse("deployment_admission_unavailable"); }

/** Each read loads a fresh tenant graph. It never borrows the tool request snapshot or manifest LRU. */
async function fresh<T>(identity: AgentIdentity, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  requester(identity);
  if (!isPostgres()) refuse("deployment_admission_unavailable");
  return withMutationGate(async () => {
    const signal = AbortSignal.timeout(8_000);
    const snapshot = await loadSnapshot(pgClient(), { id: identity.subject, email: "" });
    alive(signal);
    return runWithSnapshot(snapshot, async () => {
      const members = db().members.filter(member => member.workspaceId === identity.workspaceId && member.id === identity.subject);
      if (members.length !== 1 || !["editor", "admin"].includes(members[0].role)) throw notFound();
      return work(signal);
    });
  });
}

async function capture(request: DeployAdmissionRequest, signal: AbortSignal): Promise<PreparedDeployAdmission> {
  const reservation = deploymentReservation(request), { target } = request;
  const project = q.project(target.projectId), environment = q.environment(target.environmentId), revision = q.revision(request.revisionId);
  if (!project || project.workspaceId !== target.workspaceId || !environment || environment.projectId !== project.id
    || !revision || revision.projectId !== project.id) throw notFound();
  const route = await executionRoute(environment);
  alive(signal);
  if (route.kind !== "workflow") refuse("execution_unavailable");
  const connection = route.connection;
  // This is an uncached remote row read, rather than revisionManifestAsync's LRU.
  const { data, error } = await pgClient().from("revision_manifests").select("revision_id,workspace_id,manifest")
    .eq("revision_id", revision.id).eq("workspace_id", target.workspaceId).abortSignal(signal).maybeSingle();
  alive(signal);
  if (error || !data || data.revision_id !== revision.id || data.workspace_id !== target.workspaceId) refuse("deployment_admission_unavailable");
  const parsed = parseManifest(data.manifest);
  if (!parsed.ok) refuse("operation_input_invalid");
  const manifest = parsed.manifest;
  const environmentInfo: EnvironmentInfo = { id: environment.id, projectId: project.id, name: environment.name,
    class: environment.class, provider: route.provider, region: environment.region,
    baseDomain: environment.baseDomain, connectionId: environment.connectionId };
  const graph = graphFor(manifest, environmentInfo);
  const input: ProposalInput = { operation: "deploy", admissionVersion: 1, deploymentId: reservation.deploymentId,
    revisionId: revision.id, revisionNumber: revision.number, connectionId: connection.id,
    manifestDigest: digest(data.manifest), graphDigest: graph.graphDigest,
    environmentDigest: digest({ id: environment.id, projectId: environment.projectId, name: environment.name, class: environment.class,
      region: environment.region, baseDomain: environment.baseDomain, connectionId: environment.connectionId, policies: environment.policies }),
    connectionDigest: digest({ id: connection.id, workspaceId: connection.workspaceId, provider: connection.provider, region: connection.region,
      platformConnectionId: connection.platformConnectionId }),
    build: manifest.services.some(service => service.ownership === "managed" && service.source.type === "git"),
    ...(request.message ? { message: request.message } : {}), estimate: estimateSummary(tryEstimate(graph)) };
  // Reuse canonical size/schema/secret rejection before any product mutation.
  parseRequest({ capability: "deployment.deploy", scope: target, input, idempotencyKey: request.idempotencyKey });
  return { deploymentId: reservation.deploymentId, input };
}

export function deployAdmissionPort(): DeployAdmissionPort {
  return {
    async prepare(request) {
      return fresh(request.identity, async signal => {
        const prepared = await capture(request, signal);
        const actor = requester(request.identity);
        const checked = await (await platformBroker()).check({ capability: "deployment.deploy", scope: request.target,
          input: prepared.input, idempotencyKey: request.idempotencyKey },
        { kind: "integration", id: actor.integrationId, name: `integration ${actor.integrationId}`,
          integrationId: actor.integrationId, onBehalfOf: actor.subject }, { via: "mcp" });
        alive(signal);
        if (checked.decision.outcome === "deny") throw new McpToolError("policy_denied", "Current policy refuses this deployment preparation.", 403);
        const reservation = deploymentReservation(request);
        const existing = q.deployment(prepared.deploymentId);
        if (existing) {
          const saved = admission(existing);
          if (existing.projectId !== request.target.projectId || existing.environmentId !== request.target.environmentId
            || existing.revisionId !== request.revisionId || existing.executor !== "workflow"
            || saved.workspaceId !== actor.workspaceId || saved.integrationId !== actor.integrationId || saved.subject !== actor.subject
            || saved.reservationDigest !== reservation.reservationDigest) refuse();
          if (digest(saved.input) !== digest(prepared.input)) throw new BrokerError("idempotency_conflict", "This deployment key already reserves a different immutable request.");
          return prepared;
        }
        const environment = q.environment(request.target.environmentId)!;
        const row: AdmittedDeployment = { id: prepared.deploymentId, projectId: request.target.projectId,
          environmentId: request.target.environmentId, revisionId: request.revisionId, previousRevisionId: environment.deployedRevisionId,
          executor: "workflow", status: "planning", steps: plannedWorkflowSteps(), outputs: [],
          changeSummary: request.message ?? "MCP saved revision deployment", estCostDeltaUsd: 0,
          actor: { type: "user", id: actor.subject, name: actor.subject }, createdAt: new Date().toISOString(),
          mcpAdmission: { version: 1, ...actor, reservationDigest: reservation.reservationDigest, input: McpDeployInput.parse(prepared.input) } };
        alive(signal);
        db().deployments.push(row); save(row.projectId);
        await flushPendingAsync();
        alive(signal);
        return prepared;
      });
    },
    async bind(request, operation) {
      await fresh(request.identity, async signal => {
        const { row, input } = rowFor(request.identity, operation);
        if (deploymentReservation(request).deploymentId !== row.id || row.operationId && row.operationId !== operation.id) refuse();
        const current = await capture(request, signal);
        if (digest(current.input) !== digest(input)) refuse();
        if (row.operationId === operation.id) return;
        alive(signal);
        row.operationId = operation.id; save(row.projectId);
        await flushPendingAsync();
        alive(signal);
      });
    },
    async validate(identity, operation): Promise<DeployWorkflowInput> {
      return fresh(identity, async signal => {
        const { row, input } = rowFor(identity, operation);
        if (row.operationId !== operation.id) refuse();
        // The key is not authority here; comparison uses the retained native proposal and association.
        const current = await capture({ identity, target: { workspaceId: operation.workspaceId,
          projectId: row.projectId, environmentId: row.environmentId }, revisionId: row.revisionId,
          idempotencyKey: "mcp-current-admission-check", ...(input.message ? { message: input.message } : {}) }, signal);
        const expected = { ...current.input, deploymentId: row.id };
        if (digest(expected) !== digest(input)) refuse("deployment_source_changed");
        return { operationId: operation.id, workspaceId: operation.workspaceId, projectId: row.projectId,
          environmentId: row.environmentId, revisionId: row.revisionId, deploymentId: row.id,
          connectionId: input.connectionId, build: input.build, preApproved: true };
      });
    },
  };
}
