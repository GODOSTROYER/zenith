/**
 * Production implementations of the MCP v3 ports (`ports.ts`).
 *
 * What is real here, and what is a seam:
 *
 *  - `productReads` reads the product store (`db()`), filtered by workspace and
 *    project. Real.
 *  - `workflowPort` wraps `src/lib/workflows/client.ts`. Real; it needs a
 *    reachable Temporal, and says so (without leaking its address) when there
 *    is none. The workflows' ACTIVITIES are stubs in this build, so a started
 *    workflow ends `failed` with "nothing was changed" until the execution
 *    workstreams land (docs/platform/EXECUTION-WORKER.md).
 *  - `observabilityPort` runs cloud reads inside a credential-broker session
 *    when a `CredentialBroker` has been registered (`registerCredentialBroker`).
 *    None is registered by this module: the wiring of a real broker (connection
 *    resolver, audit sink, runner transport) belongs to the credentials and
 *    orchestration workstreams. Without one, AWS and Kubernetes environments
 *    answer with `unavailable` sources that say a session is missing — never an
 *    empty list.
 *  - `unavailableInvestigator` is the incident engine's port until WS-INC is
 *    wired (`registerInvestigator`).
 *  - `scope`, `origin` and `broker` reuse the v2 agent runtime's product-store
 *    scope, trusted origin and the platform broker.
 *
 * Nothing in this file is imported by the tool layer directly: `runtime.ts`
 * loads it lazily, so the tools and their tests do not pull in the product
 * store, the v2 agent runtime or Temporal.
 */
import { createBroker, platformBroker, type Broker } from "@/lib/capabilities/platform";
import { productRoleResolver } from "@/lib/capabilities/product-adapters";
import type { IntegrationDirectory } from "@/lib/capabilities/product-adapters";
import { CredentialDeniedError, type AwsSession, type CredentialBroker, type KubernetesSession, type ProviderSession } from "@/lib/credentials/types";
import { db, q, revisionManifestAsync } from "@/lib/db/store";
import { createObservabilityFabric } from "@/lib/observability/fabric";
import { sourcesForEnvironment, type SourceSessions } from "@/lib/observability/sources/factory";
import { createUnavailableSource } from "@/lib/observability/sources/unavailable";
import type { ProviderKey } from "@/lib/resources/types";
import { controlOrigin } from "../control/boundary";
import { control, inAgentScope } from "../control/runtime";
import { McpToolError } from "./errors";
import type { AgentIdentity } from "./principal";
import type {
  EnvironmentInfo,
  Investigator,
  McpPorts,
  ObservabilityPort,
  ProjectReads,
  RevisionInfo,
  WorkflowAvailability,
  WorkflowPort,
} from "./ports";

/* ---------------------------------- registry --------------------------------- */

interface Registry {
  credentialBroker?: CredentialBroker;
  investigator?: Investigator;
  observability?: ObservabilityPort;
}

type G = typeof globalThis & { __zenithMcpV3?: Registry };
const registry = (): Registry => ((globalThis as G).__zenithMcpV3 ??= {});

/** The orchestrator's plug-in point for cloud reads: the credential broker that opens scoped, short-lived sessions. */
export function registerCredentialBroker(broker: CredentialBroker | undefined, observability?: ObservabilityPort): void {
  registry().credentialBroker = broker;
  // Composition may supply a port that resolves product connection ids and
  // supports every brokered provider. Clearing the broker clears this seam too.
  registry().observability = broker ? observability : undefined;
}

/** The orchestrator's plug-in point for the incident engine (WS-INC). */
export function registerInvestigator(investigator: Investigator | undefined): void {
  registry().investigator = investigator;
}

/* ------------------------------- product reads ------------------------------- */

const PROVIDERS: ReadonlySet<string> = new Set(["aws", "gcp", "azure", "oci", "kubernetes", "zenith", "sandbox"]);

function environmentInfo(workspaceId: string, projectId: string, environmentId: string): EnvironmentInfo | null {
  const d = db();
  if (!d.projects.some((p) => p.id === projectId && p.workspaceId === workspaceId)) return null;
  const env = d.environments.find((e) => e.id === environmentId && e.projectId === projectId);
  if (!env) return null;
  const connection = q.connection(env.connectionId);
  if (!connection || connection.workspaceId !== workspaceId || !PROVIDERS.has(connection.provider)) {
    throw new McpToolError("connection_unavailable", "This environment's cloud connection is missing or not supported by MCP v3.", 409);
  }
  return {
    id: env.id,
    projectId: env.projectId,
    name: env.name,
    class: env.class,
    provider: connection.provider as ProviderKey,
    region: env.region,
    baseDomain: env.baseDomain,
    connectionId: env.connectionId,
    ...(env.deployedRevisionId ? { deployedRevisionId: env.deployedRevisionId } : {}),
  };
}

export function productReads(): ProjectReads {
  return {
    async project(workspaceId, projectId) {
      const p = db().projects.find((x) => x.id === projectId && x.workspaceId === workspaceId);
      return p ? { id: p.id, workspaceId: p.workspaceId, name: p.name, slug: p.slug, workingManifest: structuredClone(p.workingManifest) } : null;
    },
    async environment(workspaceId, projectId, environmentId) {
      return environmentInfo(workspaceId, projectId, environmentId);
    },
    async environments(workspaceId, projectId) {
      if (!db().projects.some((p) => p.id === projectId && p.workspaceId === workspaceId)) return [];
      return db()
        .environments.filter((e) => e.projectId === projectId)
        .map((e) => environmentInfo(workspaceId, projectId, e.id))
        .filter((e): e is EnvironmentInfo => e !== null);
    },
    async revision(workspaceId, projectId, revisionId): Promise<RevisionInfo | null> {
      if (!db().projects.some((p) => p.id === projectId && p.workspaceId === workspaceId)) return null;
      const r = db().revisions.find((x) => x.id === revisionId && x.projectId === projectId);
      if (!r) return null;
      const manifest = (await revisionManifestAsync(r.id)) ?? r.manifest;
      return { id: r.id, projectId: r.projectId, number: r.number, message: r.message, createdAt: r.createdAt, ...(r.deployedTo ? { deployedTo: [...r.deployedTo] } : {}), manifest: structuredClone(manifest) };
    },
    async revisions(workspaceId, projectId, limit) {
      if (!db().projects.some((p) => p.id === projectId && p.workspaceId === workspaceId)) return [];
      return q
        .revisionsOf(projectId)
        .slice(0, limit)
        .map((r) => ({ id: r.id, projectId: r.projectId, number: r.number, message: r.message, createdAt: r.createdAt, ...(r.deployedTo ? { deployedTo: [...r.deployedTo] } : {}) }));
    },
  };
}

/* -------------------------------- observability ------------------------------ */

const NEEDS_SESSION: ReadonlySet<string> = new Set(["aws", "kubernetes"]);

function sessionsFor(session: ProviderSession): SourceSessions {
  if (session.provider === "aws") return { aws: session as AwsSession };
  if (session.provider === "kubernetes") return { kubernetes: session as KubernetesSession };
  return {};
}

export interface ObservabilityOptions {
  /** the credential broker; default: the registered one, if any */
  credentialBroker?: () => CredentialBroker | undefined;
  /** the source factory; default `sourcesForEnvironment` (tests inject fakes) */
  sources?: typeof sourcesForEnvironment;
}

export function observabilityPort(options: ObservabilityOptions = {}): ObservabilityPort {
  const brokerOf = options.credentialBroker ?? (() => registry().credentialBroker);
  const sources = options.sources ?? sourcesForEnvironment;
  return {
    async withFabric({ workspaceId, environment, graph, grant }, fn) {
      const build = (sessions: SourceSessions) => createObservabilityFabric(sources({ provider: environment.provider, graph, workspaceId, sessions }));
      const broker = brokerOf();
      if (!NEEDS_SESSION.has(environment.provider) || !broker) return fn(build({}));

      let entered = false;
      try {
        // Cloud credentials exist only inside this callback. The grant is the broker's read grant for this exact read.
        return await broker.withSession({ connectionId: environment.connectionId, grant, purpose: "observe" }, async (session) => {
          entered = true;
          return fn(build(sessionsFor(session)));
        });
      } catch (error) {
        // A refusal to open the session is an answer ("the credential broker said no"), not a crash. A failure inside `fn` is not ours to swallow.
        if (!entered && error instanceof CredentialDeniedError) {
          const reason = `The credential broker refused a session (${error.reason ?? "denied"}).`;
          return fn(
            createObservabilityFabric([createUnavailableSource({ id: "credential-broker", provider: environment.provider, supports: ["log", "metric", "event", "trace"], reason })])
          );
        }
        throw error;
      }
    },
  };
}

/* ---------------------------------- incidents --------------------------------- */

export const unavailableInvestigator: Investigator = {
  available: false,
  reason: "The incident engine is not connected to MCP v3 on this deployment yet.",
  async investigate() {
    throw new McpToolError("incident_engine_unavailable", "The incident engine is not connected.", 503);
  },
};

/* ---------------------------------- workflows --------------------------------- */

const UNAVAILABLE_REASON: Record<string, string> = {
  unreachable: "The workflow engine is unreachable.",
  timeout: "The workflow engine did not answer in time.",
  namespace_not_found: "The workflow engine namespace does not exist.",
  unauthenticated: "The workflow engine refused this server's credentials.",
  error: "The workflow engine could not be reached.",
};

/** The real client, lazily imported (it pulls in the Temporal gRPC client). Reasons never carry the engine's address. */
export function workflowPort(): WorkflowPort {
  return {
    async available(): Promise<WorkflowAvailability> {
      const { temporalAvailable } = await import("@/lib/workflows/client");
      const result = await temporalAvailable();
      return result.available ? { available: true } : { available: false, reason: UNAVAILABLE_REASON[result.reason] ?? UNAVAILABLE_REASON.error };
    },
    async startDeploy(input) {
      const { startDeploy } = await import("@/lib/workflows/client");
      const started = await startDeploy(input);
      return { workflowId: started.workflowId, runId: started.runId };
    },
    async startDayTwo(input) {
      const { startDayTwo } = await import("@/lib/workflows/client");
      const started = await startDayTwo(input);
      return { workflowId: started.workflowId, runId: started.runId };
    },
    async progress(operationId) {
      const { getProgress } = await import("@/lib/workflows/client");
      return getProgress(operationId, { timeoutMs: 3_000 });
    },
  };
}

/* ----------------------------------- broker ----------------------------------- */

/**
 * OAuth-origin principals are not credentials the broker's default directory
 * knows: their grants live in the v2 journal. This wraps a broker's role
 * resolver so that an integration the base resolver does not know is asked of
 * the journal. It only ever ADDS a way to be recognised: the base answer wins,
 * a revoked or expired grant is `none`, and the human's role still caps it (the
 * same `productRoleResolver` computes it).
 */
export function withOAuthGrants(base: Broker, journalGrants: IntegrationDirectory): Broker {
  const fallback = productRoleResolver({ integrations: journalGrants });
  return createBroker({
    ...base.deps,
    roles: {
      async resolve(principal, workspaceId) {
        const known = await base.deps.roles.resolve(principal, workspaceId);
        if (known.role !== "none" || principal.kind !== "integration") return known;
        return fallback.resolve(principal, workspaceId);
      },
    },
  });
}

/** The OAuth grants of the v2 journal, as an `IntegrationDirectory`. Live on every call, so revocation is immediate. */
export const journalGrantDirectory: IntegrationDirectory = async (principal, workspaceId) => {
  if (!principal.onBehalfOf || !principal.integrationId) return null;
  const journal = (await control()).journal;
  const grants = await journal.grants(principal.onBehalfOf, workspaceId);
  const now = Date.now();
  const found = grants.find((g) => g.integrationId === principal.integrationId && g.workspaceId === workspaceId && !g.revoked && Date.parse(g.expiresAt) > now);
  return found ? { scopes: [...found.scopes], projectIds: [...found.projectIds], ...(found.environmentIds ? { environmentIds: [...found.environmentIds] } : {}) } : null;
};

/* ----------------------------------- bundle ----------------------------------- */

export function defaultPorts(): McpPorts {
  const oauthConfigured = Boolean(process.env.ZENITH_AGENT_OAUTH_ISSUER || process.env.ZENITH_AGENT_OAUTH_JWKS);
  return {
    async broker() {
      const base = await platformBroker();
      return oauthConfigured ? withOAuthGrants(base, journalGrantDirectory) : base;
    },
    reads: productReads(),
    get observability() {
      return registry().observability ?? observabilityPort();
    },
    get investigator() {
      return registry().investigator ?? unavailableInvestigator;
    },
    workflows: workflowPort(),
    origin: () => controlOrigin(),
    scope<T>(identity: AgentIdentity, fn: () => Promise<T>): Promise<T> {
      return inAgentScope(identity as unknown as Parameters<typeof inAgentScope>[0], fn);
    },
    now: () => new Date(),
  };
}
