/**
 * App ports for MCP cloud reads and deterministic incident investigation.
 * Authorization is supplied by the capability broker, checked against the
 * exact product scope, then used only for an observe credential session.
 * Product connection ids resolve through the workspace-scoped platform port.
 * Driver reads, signals and ledger reads are read-only; no state is persisted.
 * Missing transports yield unknown evidence. No cloud was exercised live.
 */
import { capability, isCapability } from "@/lib/capabilities/catalog";
import { productReads } from "@/lib/agent-access/v3/adapters";
import { graphFor } from "@/lib/agent-access/v3/context";
import { McpToolError, notFound } from "@/lib/agent-access/v3/errors";
import type { FabricRequest, Investigator, ObservabilityPort, ProjectReads } from "@/lib/agent-access/v3/ports";
import { repos } from "@/lib/controlplane/db";
import type { Sql } from "@/lib/controlplane/types";
import { CredentialDeniedError, type CredentialBroker, type ProviderSession } from "@/lib/credentials/types";
import { findDriver, type DriverContext } from "@/lib/drivers/types";
import { createConnectionsPort } from "@/lib/execution/platform";
import { investigate, InvestigationInputError } from "@/lib/incidents/investigate";
import type { InvestigationPorts } from "@/lib/incidents/ports";
import { createObservabilityFabric } from "@/lib/observability/fabric";
import { describeSession } from "@/lib/observability/telemetry";
import { raceAbort } from "@/lib/observability/abort";
import { sourcesForEnvironment, type SourceSessions } from "@/lib/observability/sources/factory";
import { createUnavailableSource } from "@/lib/observability/sources/unavailable";
import { kubernetesSignalGraph } from "@/lib/observability/sources/provider-scope";
import type { Observation, ResourceGraph, RuntimeState } from "@/lib/resources/types";
import type { SignalScope } from "@/lib/observability/types";

export interface AgentPortsOptions {
  reads?: ProjectReads;
  sources?: typeof sourcesForEnvironment;
  drivers?: typeof findDriver;
  now?: () => Date;
}

const READ_CAPABILITIES = new Set(["logs.read", "metrics.read", "events.read", "traces.read", "incident.investigate", "infrastructure.observe", "topology.read"]);
const sessionsOf = (session: ProviderSession): SourceSessions => {
  switch (session.provider) {
    case "aws": return { aws: session };
    case "gcp": return { gcp: session };
    case "azure": return { azure: session };
    case "kubernetes": return { kubernetes: session };
    case "oci": return { oci: session };
  }
};

export function composeAgentPorts(sql: Sql, credentials: CredentialBroker, options: AgentPortsOptions = {}) {
  const reads = options.reads ?? productReads();
  const sourceFactory = options.sources ?? sourcesForEnvironment;
  const driverOf = options.drivers ?? findDriver;
  const now = options.now ?? (() => new Date());
  const connections = createConnectionsPort(sql);

  async function validate(request: FabricRequest): Promise<void> {
    const { workspaceId, environment, graph, grant } = request;
    if (!grant || grant.ws !== workspaceId || grant.proj !== environment.projectId || grant.env !== environment.id || graph.environmentId !== environment.id || grant.res) throw notFound();
    if (!READ_CAPABILITIES.has(grant.cap) || !isCapability(grant.cap) || capability(grant.cap).mutates || !Number.isFinite(grant.exp) || grant.exp <= Math.floor(now().getTime() / 1000)) {
      throw new McpToolError("policy_denied", "A current observe read grant is required.", 403);
    }
    const project = await reads.project(workspaceId, environment.projectId);
    const actual = await reads.environment(workspaceId, environment.projectId, environment.id);
    if (!project || project.id !== environment.projectId || project.workspaceId !== workspaceId || !actual || actual.id !== environment.id || actual.projectId !== environment.projectId || actual.connectionId !== environment.connectionId || actual.provider !== environment.provider) throw notFound();
  }

  async function withReadSession<T>(request: FabricRequest, fn: (session?: ProviderSession, reason?: string) => Promise<T>): Promise<T> {
    await validate(request);
    if (request.environment.provider === "sandbox") return fn();
    const connection = await connections.resolve({ workspaceId: request.workspaceId, connectionId: request.environment.connectionId });
    if (!connection) return fn(undefined, "No provider connection is available in this workspace.");
    const compatible = connection.config.provider === request.environment.provider || (request.environment.provider === "zenith" && connection.config.provider === "kubernetes");
    if (!compatible) return fn(undefined, "The provider connection does not match this environment.");
    let entered = false;
    try {
      return await credentials.withSession({ connectionId: connection.id, grant: request.grant, purpose: "observe" }, async (session) => {
        entered = true;
        if (session.provider !== connection.config.provider) return fn(undefined, "The broker session does not match the provider connection.");
        return fn(session);
      });
    } catch (error) {
      // A callback failure must never run the query a second time.
      if (entered) throw error;
      const reason = error instanceof CredentialDeniedError ? `The credential broker refused an observe session (${error.reason ?? "denied"}).` : "The credential broker could not open an observe session.";
      return fn(undefined, reason);
    }
  }

  async function recorded(request: FabricRequest) {
    const [resources, observations] = await Promise.all([
      repos.resources.listByEnvironment(sql, request.workspaceId, request.environment.id),
      repos.observations.latestObservationsByEnvironment(sql, request.workspaceId, request.environment.id),
    ]);
    return { resources: new Map(resources.map((r) => [r.address, r])), observations };
  }

  function fabricFor(request: FabricRequest, observations: readonly Observation[], session?: ProviderSession, reason?: string) {
    const sources = reason ? [createUnavailableSource({ id: "credential-broker", provider: request.environment.provider, supports: ["log", "metric", "event", "trace"], reason })]
      : sourceFactory({ provider: request.environment.provider, graph: request.graph, workspaceId: request.workspaceId, sessions: session ? sessionsOf(session) : {}, observations, purpose: request.purpose });
    const fabric = createObservabilityFabric(sources, { now, ...(describeSession(session) ? { session: describeSession(session)! } : {}) });
    const permitted = (signal: "log" | "metric" | "event" | "trace", scope: SignalScope) => {
      if (scope.workspaceId !== request.workspaceId || scope.environmentId !== request.environment.id || (scope.projectId !== undefined && scope.projectId !== request.environment.projectId)) throw notFound();
      if (request.grant.exp <= Math.floor(now().getTime() / 1000)) throw new McpToolError("policy_denied", "The observe read grant expired.", 403);
      const cap = request.grant.cap;
      if (cap !== "incident.investigate" && cap !== "infrastructure.observe" && cap !== ({ log: "logs.read", metric: "metrics.read", event: "events.read", trace: "traces.read" }[signal])) throw new McpToolError("policy_denied", "The grant does not authorize this signal read.", 403);
    };
    return {
      searchLogs: (...args: Parameters<typeof fabric.searchLogs>) => { permitted("log", args[0].scope); return fabric.searchLogs(...args); },
      queryMetrics: (...args: Parameters<typeof fabric.queryMetrics>) => { permitted("metric", args[0].scope); return fabric.queryMetrics(...args); },
      searchEvents: (...args: Parameters<typeof fabric.searchEvents>) => { permitted("event", args[0].scope); return fabric.searchEvents(...args); },
      searchTraces: (...args: Parameters<typeof fabric.searchTraces>) => { permitted("trace", args[0].scope); return fabric.searchTraces(...args); },
    };
  }

  const observability: ObservabilityPort = {
    withFabric: (request, fn) => withReadSession(request, async (session, reason) => {
      const { observations } = await recorded(request);
      return fn(fabricFor(request, observations, session, reason));
    }),
  };

  const investigator: Investigator = {
    available: true,
    async investigate(request) {
      request.signal?.throwIfAborted();
      if (request.grant?.ws !== request.workspaceId || request.grant.proj !== request.projectId || request.grant.env !== request.environmentId) throw notFound();
      if (request.grant.cap !== "incident.investigate") throw new McpToolError("policy_denied", "An incident investigation read grant is required.", 403);
      const project = await reads.project(request.workspaceId, request.projectId);
      const environment = await reads.environment(request.workspaceId, request.projectId, request.environmentId);
      if (!project || project.id !== request.projectId || project.workspaceId !== request.workspaceId || !environment || environment.id !== request.environmentId || environment.projectId !== request.projectId) throw notFound();
      const revision = environment.deployedRevisionId ? await reads.revision(request.workspaceId, request.projectId, environment.deployedRevisionId) : null;
      const graph: ResourceGraph = graphFor(revision?.manifest ?? project.workingManifest, environment);
      const scope = { workspaceId: request.workspaceId, projectId: request.projectId, environmentId: request.environmentId };
      const fabricRequest: FabricRequest = { workspaceId: request.workspaceId, environment, graph, grant: request.grant };
      return withReadSession(fabricRequest, async (session, reason) => {
        const stored = await recorded(fabricRequest);
        const fabric = fabricFor(fabricRequest, stored.observations, session, reason);
        const driverGraph = environment.provider === "kubernetes" ? kubernetesSignalGraph(graph, scope.workspaceId) : graph;
        const nodeOf = (address: string) => { const node = driverGraph.nodes.find((n) => n.address === address); if (!node) throw notFound(); return node; };
        const context = (address: string, signal?: AbortSignal): DriverContext => {
          const node = nodeOf(address);
          if (!session || node.provider !== session.provider || node.ownership === "external") throw new Error(reason ?? "No compatible observe session is available for this resource.");
          const bounded = AbortSignal.any([...(request.signal ? [request.signal] : []), ...(signal ? [signal] : [])]);
          bounded.throwIfAborted();
          return { provider: node.provider, region: node.region, ...scope, operationId: request.grant.op, session,
            signal: bounded, log: () => {},
            tags: { "zenith:workspace": scope.workspaceId, "zenith:environment": scope.environmentId, "zenith:resource": address, "zenith:managed": "true" }, now };
        };
        const ports: InvestigationPorts = {
          async observe(address, opts): Promise<Observation> {
            const node = nodeOf(address); const driver = driverOf(node.provider, node.nativeType);
            if (!driver?.observe) throw new Error("No configuration read is implemented for this resource.");
            const ctx = context(address, opts?.signal);
            return raceAbort(driver.observe(ctx, node, stored.resources.get(address)?.externalId ?? node.externalRef), ctx.signal);
          },
          async runtime(address, opts): Promise<RuntimeState> {
            const node = nodeOf(address); const driver = driverOf(node.provider, node.nativeType);
            if (!driver?.runtime) throw new Error("No runtime read is implemented for this resource.");
            const ctx = context(address, opts?.signal);
            return raceAbort(driver.runtime(ctx, node, stored.resources.get(address)?.externalId ?? node.externalRef), ctx.signal);
          },
          expected(address) {
            const node = nodeOf(address); const driver = driverOf(node.provider, node.nativeType);
            if (!driver?.expectedAttributes) throw new Error("The resource driver does not declare comparable desired attributes.");
            return driver.expectedAttributes(node);
          },
          searchLogs: (q, opts) => fabric.searchLogs({ ...q, range: request.range }, combinedSignal(request.signal, opts?.signal)),
          queryMetrics: (q, opts) => fabric.queryMetrics({ ...q, range: request.range }, combinedSignal(request.signal, opts?.signal)),
          searchEvents: (q, opts) => fabric.searchEvents({ ...q, range: request.range }, combinedSignal(request.signal, opts?.signal)),
          async recentChanges(environmentId, sinceIso) {
            if (environmentId !== scope.environmentId) throw notFound();
            const page = await repos.operations.list(sql, scope.workspaceId, { projectId: scope.projectId, environmentId }, { limit: 200 });
            if (page.nextCursor) throw new Error("Recent operation history exceeds the read limit; change coverage is unknown.");
            return page.items.filter((op) => op.startedAt && Date.parse(op.startedAt) >= Date.parse(sinceIso) && isCapability(op.capability) && capability(op.capability).mutates)
              .map((op) => ({ at: op.startedAt!, kind: op.capability === "deployment.deploy" ? "deployment" : op.capability === "infrastructure.apply" ? "apply" : op.capability,
                summary: `${op.capability}: ${op.status}; an attempt is not proof of a cloud change.`, operationId: op.id }));
          },
          drift: async (environmentId) => { if (environmentId !== scope.environmentId) throw notFound(); return repos.drift.latest(sql, scope.workspaceId, environmentId); },
          // This request carries no authenticated requester for a remediation
          // dry-run. Fail closed; never claim policy evaluated a made-up actor.
          policyDryRun: async () => { throw new Error("Remediation policy must be evaluated for the requester by the capability broker when a proposal is submitted."); },
          // Deterministic stability gate (cooldowns, attempt/blast-radius caps, windows). Read-only here; the reservation happens when a proposal is submitted.
          remediationGate: (gateRequest) => repos.incidentStability.checkRemediation(sql, { workspaceId: scope.workspaceId, environmentId: scope.environmentId, ...(request.incidentId ? { incidentId: request.incidentId } : {}), request: gateRequest, now: now() }),
          now,
        };
        try {
          const work = investigate({ graph, environment: scope, symptom: request.symptom, incidentId: request.incidentId }, ports);
          const result = request.signal ? await raceAbort(work, request.signal) : await work;
          request.signal?.throwIfAborted();
          return result;
        } catch (error) {
          if (error instanceof InvestigationInputError) throw new McpToolError("investigation_unavailable", "This environment has no supported investigation entry point.", 409);
          throw error;
        }
      });
    },
  };
  return { observability, investigator };
}

function combinedSignal(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  return a && b ? AbortSignal.any([a, b]) : a ?? b;
}
