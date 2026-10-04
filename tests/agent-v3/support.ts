/** Self-contained MCP harness. The broker/store and Ed25519 grant signer are
 * real; policy, product rows, cloud sessions and workflows are explicit fakes.
 * No live cloud, database server, Temporal server or network is required. */
import { afterEach, vi } from "vitest";
import { setDestroyReviewDispatcherForTests } from "@/lib/capabilities/destroy-review-dispatch";
afterEach(() => setDestroyReviewDispatcherForTests(undefined));
import { digest } from "@/lib/controlplane/digest";
import { parseRequest } from "@/lib/capabilities/broker";
import { BrokerError } from "@/lib/capabilities/errors";
import { graphFor } from "@/lib/agent-access/v3/context";
import { deploymentReservation, McpDeployInput } from "@/lib/agent-access/v3/deploy-admission";
import { McpToolError, notFound } from "@/lib/agent-access/v3/errors";
import { estimateSummary, tryEstimate } from "@/lib/agent-access/v3/tools/estimate";
import type { DeployAdmissionRequest } from "@/lib/agent-access/v3/ports";
import type { Principal, Scope } from "@/lib/controlplane/types";
import { CredentialGrantSigner } from "@/lib/capabilities/credential-signer";
import { MemoryBrokerStore } from "@/lib/capabilities/memory-store";
import { createBroker } from "@/lib/capabilities/platform";
import type { Clock, ResolvedAccess, ResolvedScope, RoleResolver, ScopeResolver } from "@/lib/capabilities/ports";
import { generateSigningJwk, serializePrivateJwk } from "@/lib/credentials";
import { Manifest } from "@/lib/domain/types";
import type { ObservabilityFabric, QueryResult, NormalizedLog, MetricSeries } from "@/lib/observability/types";
import type { PolicyDecision, PolicyEngine, PolicyInput } from "@/lib/policy";
import { principalFromIdentity, type AgentIdentity } from "@/lib/agent-access/v3/principal";
import type { EnvironmentInfo, McpPorts, ProjectInfo, RevisionInfo, StartedRef } from "@/lib/agent-access/v3/ports";
import { TOOL_NAMES, type ToolName } from "@/lib/agent-access/v3/contract";
import { runTool } from "@/lib/agent-access/v3/tools";

export const ids = { ws: "ws-a", foreignWs: "ws-b", project: "proj-a", foreignProject: "proj-b",
  env: "env-a", foreignEnv: "env-b", service: "svc-a", foreignService: "svc-b",
  revision: "rev-a", revision2: "rev-a2", foreignRevision: "rev-b", integration: "int-a" };
export const target = { workspaceId: ids.ws, projectId: ids.project, environmentId: ids.env };
export const ORIGIN = "http://127.0.0.1:3400";
export const bearer = "za_" + "X".repeat(43);
export const canaries = ["AKIA" + "A".repeat(16), "Bearer " + "b".repeat(32),
  "eyJ" + "c".repeat(12) + "." + "d".repeat(12) + "." + "e".repeat(12),
  "-----BEGIN PRIVATE KEY-----", "za_" + "f".repeat(43), "sk-" + "g".repeat(32), "postgres://canary:password@host"];

export class FakeClock implements Clock {
  ms = Date.now();
  now = () => new Date(this.ms);
  advance(ms: number): void { this.ms += ms; }
}
export function scriptedEngine(decide: (input: PolicyInput) => PolicyDecision): PolicyEngine {
  return { version: "mcp-test-policy", async evaluate(input) {
    return { decision: decide(input), policyVersion: "mcp-test-policy", inputDigest: digest(input), evaluatedAt: input.context.now };
  } };
}
export const allowDecision = (): PolicyDecision => ({ outcome: "allow", reasons: [{ code: "allow", message: "Test allows this." }] });
export const requireApproval = (): PolicyDecision => ({ outcome: "require_approval", reasons: [{ code: "human", message: "A human must review." }],
  approval: { count: 1, minRole: "editor", separationOfDuties: false } });
export const denyDecision = (): PolicyDecision => ({ outcome: "deny", reasons: [{ code: "denied", message: "Test denies this." }] });

export class World implements ScopeResolver, RoleResolver {
  projects = new Map([[ids.project, ids.ws], [ids.foreignProject, ids.foreignWs]]);
  environments = new Map([[ids.env, ids.project], [ids.foreignEnv, ids.foreignProject]]);
  resources = new Map([[ids.service, ids.env], [ids.foreignService, ids.foreignEnv]]);
  members = new Map<string, ResolvedAccess["role"]>([[`${ids.ws}|bob`, "editor"], [`${ids.ws}|alice`, "admin"], [`${ids.foreignWs}|mallory`, "admin"]]);
  integrations = new Map([[`${ids.ws}|${ids.integration}`, { subject: "bob", scopes: ["read", "plan", "logs", "write"], projectIds: [ids.project], environmentIds: [ids.env] }]]);
  resolve(scope: Scope): Promise<ResolvedScope | null>;
  resolve(principal: Principal, workspaceId: string): Promise<ResolvedAccess>;
  async resolve(value: Scope | Principal, workspaceId?: string): Promise<ResolvedScope | ResolvedAccess | null> {
    if ("kind" in value) {
      const who = value.kind === "user" ? value.id : value.onBehalfOf;
      const role = this.members.get(`${workspaceId}|${who}`) ?? "none";
      if (value.kind !== "integration") return { role };
      const grant = this.integrations.get(`${workspaceId}|${value.integrationId ?? value.id}`);
      if (!grant || grant.subject !== who) return { role: "none" };
      return { role, integrationScopes: grant.scopes, allowedProjectIds: grant.projectIds, allowedEnvironmentIds: grant.environmentIds };
    }
    const s = value;
    if (![ids.ws, ids.foreignWs].includes(s.workspaceId)) return null;
    const p = s.projectId ?? (s.environmentId ? this.environments.get(s.environmentId) : undefined);
    if (p && this.projects.get(p) !== s.workspaceId) return null;
    if (s.environmentId && (!p || this.environments.get(s.environmentId) !== p)) return null;
    if (s.resourceId && (!s.environmentId || this.resources.get(s.resourceId) !== s.environmentId)) return null;
    return { scope: { ...s, ...(p ? { projectId: p } : {}) },
      ...(s.environmentId ? { environment: { id: s.environmentId, class: "production" as const, provider: "aws", region: "us-east-1" } } : {}),
      ...(s.resourceId ? { resource: { address: "service/web", kind: "container_service", stateful: false, ownership: "managed" as const, publiclyExposed: false } } : {}) };
  }
}

export function identity(extra: Partial<AgentIdentity> = {}): AgentIdentity {
  return { subject: "bob", integrationId: ids.integration, workspaceId: ids.ws, projectIds: [ids.project], environmentIds: [ids.env],
    scopes: ["read", "plan", "logs", "write"], expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), ...extra };
}
let key: Promise<Record<string, string>> | undefined;
const controlKey = () => (key ??= generateSigningJwk("EdDSA").then((k) => ({ ZENITH_CONTROL_SIGNING_JWK: serializePrivateJwk(k) })));

export async function makeHarness(decide: (input: PolicyInput) => PolicyDecision = () => allowDecision()) {
  setDestroyReviewDispatcherForTests(async () => undefined);
  const world = new World();
  const clock = new FakeClock();
  const store = new MemoryBrokerStore(clock);
  let engine = scriptedEngine(decide);
  const broker = createBroker({ store, clock, roles: world, scopes: world, signer: new CredentialGrantSigner(await controlKey()), policy: async () => engine });
  const trace: string[] = [];
  const realRead = broker.authorizeRead;
  const authorizeRead = vi.spyOn(broker, "authorizeRead");
  authorizeRead.mockImplementation(async (...args) => { trace.push("authorizeRead"); return realRead(...args); });
  const realBegin = broker.beginExecution;
  const beginExecution = vi.spyOn(broker, "beginExecution");
  beginExecution.mockImplementation(async (...args) => { trace.push("beginExecution"); return realBegin(...args); });
  const getOperationDetail = vi.spyOn(broker, "getOperationDetail");
  const realPropose = broker.propose;
  const propose = vi.spyOn(broker, "propose").mockImplementation(realPropose);
  const manifest = Manifest.parse({ version: 1, services: [{ id: ids.service, name: "web-app", kind: "web", source: { type: "image", image: "example/web:v1" }, port: 3000,
    env: [{ key: "PUBLIC_MARKER", value: "config-value-never-return" }] }], resources: [], routes: [], bindings: [] });
  const projects = new Map<string, ProjectInfo>([[ids.project, { id: ids.project, workspaceId: ids.ws, name: "project-text-marker", slug: "app", workingManifest: manifest }],
    [ids.foreignProject, { id: ids.foreignProject, workspaceId: ids.foreignWs, name: "foreign", slug: "foreign", workingManifest: manifest }]]);
  const environments = new Map<string, EnvironmentInfo>([[ids.env, { id: ids.env, projectId: ids.project, name: "production", class: "production", provider: "aws", region: "us-east-1", baseDomain: "example.test", connectionId: "conn-a", deployedRevisionId: ids.revision }],
    [ids.foreignEnv, { id: ids.foreignEnv, projectId: ids.foreignProject, name: "foreign", class: "production", provider: "aws", region: "us-east-1", baseDomain: "foreign.test", connectionId: "conn-b" }]]);
  const revisions = new Map<string, RevisionInfo>([ids.revision, ids.revision2, ids.foreignRevision].map((id, i) => [id, { id, projectId: i === 2 ? ids.foreignProject : ids.project,
    number: i + 1, message: `revision-message-marker-${i}`, createdAt: clock.now().toISOString(), manifest: structuredClone(manifest) }]));
  // These maps model durable product rows and native intents explicitly. They
  // supply no PostgreSQL or Temporal acceptance evidence.
  const deployments = new Map<string, { input: Record<string, unknown>; operationId?: string; integrationId: string; subject: string }>();
  const workflowIntents = new Map<string, { phase: "prepared" | "attempted" | "acknowledged" }>();
  const workflowRefs = new Map<string, StartedRef>();
  const preparedInput = (request: DeployAdmissionRequest) => {
    const environment = environments.get(request.target.environmentId), revision = revisions.get(request.revisionId);
    if (projects.get(request.target.projectId)?.workspaceId !== request.target.workspaceId
      || !environment || environment.projectId !== request.target.projectId || !revision || revision.projectId !== request.target.projectId) throw notFound();
    const graph = graphFor(revision.manifest, environment);
    const input = { operation: "deploy", admissionVersion: 1, deploymentId: deploymentReservation(request).deploymentId,
      revisionId: revision.id, revisionNumber: revision.number, connectionId: environment.connectionId,
      manifestDigest: digest(revision.manifest), graphDigest: graph.graphDigest, environmentDigest: digest(environment),
      connectionDigest: digest({ id: environment.connectionId, provider: environment.provider }),
      build: revision.manifest.services.some(service => service.ownership === "managed" && service.source.type === "git"),
      ...(request.message ? { message: request.message } : {}), estimate: estimateSummary(tryEstimate(graph)) };
    parseRequest({ capability: "deployment.deploy", scope: request.target, input, idempotencyKey: request.idempotencyKey });
    return input;
  };
  const starts: { deploy: unknown[]; dayTwo: unknown[] } = { deploy: [], dayTwo: [] };
  const start = (kind: "deploy" | "dayTwo", input: { operationId: string }, mode: "new" | "retained") => {
    trace.push(kind === "deploy" ? "startDeploy" : "startDayTwo");
    const prior = workflowIntents.get(input.operationId);
    if (mode === "retained" && !prior) throw new McpToolError("workflow_start_unconfirmed", "Modeled claim has no retained intent.", 409);
    if (!prior) workflowIntents.set(input.operationId, { phase: "prepared" });
    let ref = workflowRefs.get(input.operationId);
    if (workflowIntents.get(input.operationId)?.phase === "attempted" && !ref) throw new McpToolError("workflow_start_unconfirmed", "Modeled original attempt is not confirmed.", 503);
    if (!ref) { ref = { workflowId: `op-${input.operationId}`, runId: `run-${input.operationId}` }; workflowRefs.set(input.operationId, ref); starts[kind].push(input); }
    workflowIntents.set(input.operationId, { phase: "acknowledged" });
    return ref;
  };
  const result = <T>(items: T[]): QueryResult<T> => ({ items, sources: ["fake-cloud"], simulated: true, truncated: true,
    unavailable: [{ source: "fake-gap", reason: "Read unavailable." }], notes: ["Fake coverage note."] });
  let insideSession = false;
  const sessionRequests: unknown[] = [];
  const logResult = result<NormalizedLog>([{ timestamp: clock.now().toISOString(), environmentId: ids.env, provider: "aws", severity: "info", message: "log-message-marker", attributes: {}, native: {} }]);
  const metricResult = result<MetricSeries>([{ metric: "cpu.utilization", provider: "aws", unit: "percent", native: {}, points: [{ timestamp: clock.now().toISOString(), value: 15 }] }]);
  const fabric: ObservabilityFabric = {
    searchLogs: vi.fn(async () => { if (!insideSession) throw new Error("Cloud read escaped session"); trace.push("cloudLogs"); return logResult; }),
    queryMetrics: vi.fn(async () => { if (!insideSession) throw new Error("Cloud read escaped session"); trace.push("cloudMetrics"); return metricResult; }),
    searchEvents: async () => result([]), searchTraces: async () => result([]),
  };
  const ports: McpPorts = {
    broker: vi.fn(async () => broker), origin: () => ORIGIN, now: clock.now, scope: async (_who, fn) => fn(),
    reads: {
      project: vi.fn(async (ws: string, p: string) => { trace.push("project"); const row = projects.get(p); return row && row.workspaceId === ws ? row : null; }),
      environment: vi.fn(async (ws: string, p: string, e: string) => { trace.push("environment"); const row = environments.get(e); return row && projects.get(p)?.workspaceId === ws && row.projectId === p ? row : null; }),
      environments: vi.fn(async (ws, p) => { trace.push("environments"); return projects.get(p)?.workspaceId === ws ? [...environments.values()].filter((e) => e.projectId === p) : []; }),
      revision: vi.fn(async (ws: string, p: string, r: string) => { trace.push("revision"); const row = revisions.get(r); return row && projects.get(p)?.workspaceId === ws && row.projectId === p ? row : null; }),
      revisions: vi.fn(async (ws, p, limit) => { trace.push("revisions"); return projects.get(p)?.workspaceId === ws ? [...revisions.values()].filter((r) => r.projectId === p).slice(0, limit) : []; }),
    },
    deployments: {
      prepare: vi.fn(async request => {
        const input = preparedInput(request);
        const check = await broker.check({ capability: "deployment.deploy", scope: request.target, input,
          idempotencyKey: request.idempotencyKey }, { kind: "integration", id: request.identity.integrationId,
          name: "Modeled authenticated integration", integrationId: request.identity.integrationId, onBehalfOf: request.identity.subject });
        if (check.decision.outcome === "deny") throw new McpToolError("policy_denied", "Modeled current policy refuses preparation.", 403);
        const saved = deployments.get(input.deploymentId);
        if (saved && (digest(saved.input) !== digest(input) || saved.subject !== request.identity.subject || saved.integrationId !== request.identity.integrationId)) {
          throw new BrokerError("idempotency_conflict", "Modeled immutable reservation conflicts.");
        }
        if (!saved) { deployments.set(input.deploymentId, { input: structuredClone(input), subject: request.identity.subject, integrationId: request.identity.integrationId }); trace.push("deployment.commit"); }
        return { deploymentId: input.deploymentId, input };
      }),
      bind: vi.fn(async (request, operation) => {
        const input = preparedInput(request), saved = deployments.get(input.deploymentId);
        if (!saved || digest(saved.input) !== digest(operation.proposal.input) || saved.operationId && saved.operationId !== operation.id) throw new McpToolError("deployment_admission_conflict", "Modeled association refuses replacement.", 409);
        saved.operationId = operation.id; trace.push("deployment.bind");
      }),
      validate: vi.fn(async (who, operation) => {
        const parsed = McpDeployInput.safeParse(operation.proposal.input);
        if (!parsed.success || !operation.projectId || !operation.environmentId) throw new McpToolError("operation_input_invalid", "Modeled deployment input is invalid.", 409);
        const input = parsed.data, saved = deployments.get(input.deploymentId);
        if (!saved || saved.operationId !== operation.id || saved.integrationId !== who.integrationId || saved.subject !== who.subject
          || digest(saved.input) !== digest(input)) throw new McpToolError("deployment_admission_conflict", "Modeled committed association is absent or foreign.", 409);
        const current = preparedInput({ identity: who, target: { workspaceId: operation.workspaceId, projectId: operation.projectId,
          environmentId: operation.environmentId }, revisionId: input.revisionId, idempotencyKey: "modeled-current-read", ...(input.message ? { message: input.message } : {}) });
        if (digest({ ...current, deploymentId: input.deploymentId }) !== digest(input)) throw new McpToolError("deployment_source_changed", "Modeled current product source differs.", 409);
        trace.push("deployment.validate");
        return { workspaceId: operation.workspaceId, operationId: operation.id, projectId: operation.projectId, environmentId: operation.environmentId,
          deploymentId: input.deploymentId, revisionId: input.revisionId, connectionId: input.connectionId, preApproved: true, build: input.build };
      }),
    },
    workflows: { available: vi.fn(async () => ({ available: true as const })), startDeploy: vi.fn(async (input, mode) => start("deploy", input, mode)),
      startDayTwo: vi.fn(async (input, mode) => start("dayTwo", input, mode)), progress: vi.fn(async () => null) },
    investigator: { available: false, reason: "Test incident engine unwired.", investigate: vi.fn(async () => { throw new Error("Unavailable engine called"); }) },
    observability: { async withFabric(request, fn) { sessionRequests.push(request); trace.push("withSession"); insideSession = true; try { return await fn(fabric); } finally { insideSession = false; } } },
  };
  const principal = principalFromIdentity(identity(), clock.ms);
  const invoke = (name: ToolName, args: unknown) => runTool(name, args, { ports, principal });
  return { world, clock, store, broker, ports, principal, trace, authorizeRead, beginExecution, getOperationDetail, propose, projects, environments, revisions,
    starts, workflowRefs, workflowIntents, deployments, fabric, sessionRequests, logResult, metricResult, invoke,
    setDecision(next: (input: PolicyInput) => PolicyDecision) { engine = scriptedEngine(next); } };
}
export type Harness = Awaited<ReturnType<typeof makeHarness>>;
export const user = (id: string): Principal => ({ kind: "user", id, name: id });
export async function approve(h: Harness, id: string, proposalDigest: string) {
  return h.broker.approve({ workspaceId: ids.ws, operationId: id, proposalDigest, approver: user("alice"), session: { method: "browser_session", subject: "alice", verifiedAtMs: Date.now() } });
}
export function argsFor(name: ToolName, operationId = "op-missing", expectedDigest = "a".repeat(64)): Record<string, unknown> {
  const base = { target: { ...target } };
  switch (name) {
    case "zenith_review_teardown": return { ...base, idempotencyKey: "intent-review-0001" };
    case "zenith_plan_change": return { ...base, revisionId: ids.revision, description: "Propose this saved change.", idempotencyKey: "intent-plan-0001" };
    case "zenith_prepare_deploy": return { ...base, revisionId: ids.revision, idempotencyKey: "intent-deploy-0001" };
    case "zenith_restart_service": return { ...base, serviceId: ids.service, idempotencyKey: "intent-restart-0001" };
    case "zenith_scale_service": return { ...base, serviceId: ids.service, replicas: 2, idempotencyKey: "intent-scale-0001" };
    case "zenith_query_metrics": return { ...base, metrics: ["cpu.utilization"] };
    case "zenith_compare_revisions": return { ...base, fromRevisionId: ids.revision, toRevisionId: ids.revision2 };
    case "zenith_execute_approved_operation": return { workspaceId: ids.ws, operationId, expectedDigest };
    case "zenith_get_operation": case "zenith_get_operation_events": return { workspaceId: ids.ws, operationId };
    default: return base;
  }
}
export const READ_TOOLS = TOOL_NAMES.filter((name) => !["zenith_execute_approved_operation", "zenith_review_teardown", "zenith_plan_change", "zenith_prepare_deploy", "zenith_restart_service", "zenith_scale_service"].includes(name));
export async function proposeDeploy(h: Harness) {
  const result = await h.invoke("zenith_prepare_deploy", argsFor("zenith_prepare_deploy"));
  if (!result.ok) throw new Error(`Proposal failed: ${result.error?.code}`);
  return { id: result.data.operationId as string, digest: result.data.proposalDigest as string };
}
