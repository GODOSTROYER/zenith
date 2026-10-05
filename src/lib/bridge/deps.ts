/**
 * Bridge I/O ports. Production imports heavyweight clients only when called.
 * The browser guard is structural: RequestState has no header/origin proof.
 * It refuses integrations, Navigator and calls outside route(), including MCP
 * bearer requests. A verified browser marker in ActionContext remains an
 * integration follow-up; this does not claim live session re-verification.
 */
import type { ActionContext } from "@/lib/actions/core";
import type { Broker } from "@/lib/capabilities/platform";
import type { BrowserSessionProof } from "@/lib/capabilities/types";
import type { Sql } from "@/lib/controlplane/types";
import type { ConnectionResolver, ProviderConnection } from "@/lib/credentials/types";
import type { DeployWorkflowInput } from "@/lib/workflows/types";
import type { DestroyWorkflowInput } from "@/lib/workflows/definitions/destroy";
import { executionPlaneReadiness, type ExecutionReadiness } from "@/lib/bridge/readiness";

export interface WorkflowGateway {
  startDeploy(input: DeployWorkflowInput): Promise<unknown>;
  startDestroy?(input: DestroyWorkflowInput): Promise<unknown>;
  signalApproval(operationId: string): Promise<{ delivered: true } | { delivered: false; reason: "not_found" }>;
  cancelOperation(operationId: string): Promise<{ delivered: true } | { delivered: false; reason: "not_found" }>;
}

export interface BridgeDeps {
  broker(): Promise<Broker>;
  workflows: WorkflowGateway;
  readiness(provider: string): Promise<ExecutionReadiness>;
  platformConnection(workspaceId: string, id: string): Promise<Pick<ProviderConnection, "status"> | null>;
  browserSession(ctx: ActionContext): Promise<BrowserSessionProof | undefined>;
  teardownSession(ctx: ActionContext): Promise<BrowserSessionProof | undefined>;
  connectionSql(): Promise<Sql>;
  credentialBroker(resolveConnection: ConnectionResolver): Promise<{
    verifyConnection(id: string, opts: { workspaceId: string }): Promise<{ ok: boolean; detail: string }>;
  }>;
  /**
   * Observe-only verification for GCP, Azure, OCI and Kubernetes connections
   * (PROD-LIFE-01). `candidate` presents a staged rotation config under the live
   * connection's id; the stored row is not changed.
   */
  providerBroker(sql: Sql, candidate?: { workspaceId: string; connectionId: string; config: ProviderConnection["config"] }): Promise<{
    verifyConnection(id: string, opts: { workspaceId: string }): Promise<{ ok: boolean; detail: string }>;
  }>;
}

const defaults: BridgeDeps = {
  broker: async () => (await import("@/lib/capabilities/platform")).platformBroker(),
  workflows: {
    startDeploy: async (input) => (await import("./workflow-start")).startDeploymentWorkflow(input),
    startDestroy: async (input) => (await import("./workflow-start")).startDestroyWorkflow(input),
    signalApproval: async (id) => (await import("@/lib/workflows/client")).signalApproval(id),
    cancelOperation: async (id) => (await import("@/lib/workflows/client")).cancelOperation(id),
  },
  readiness: executionPlaneReadiness,
  teardownSession: async (ctx) => (await import("./teardown-session")).teardownBrowserSession(ctx),
  platformConnection: async (workspaceId, id) => {
    const { platformDb, repos } = await import("@/lib/controlplane/db");
    return repos.connections.get(await platformDb(), workspaceId, id);
  },
  browserSession: async (ctx) => {
    if (ctx.actor.type !== "user" || ctx.integration) return undefined;
    const [{ currentRequest }, { isSupabaseConfigured }, { hostedMode }] = await Promise.all([
      import("@/lib/server/request"), import("@/lib/supabase/env"), import("@/lib/hosted/config"),
    ]);
    const state = currentRequest();
    if (!state) return undefined;
    const verified = isSupabaseConfigured()
      ? state.user?.id === ctx.actor.id && state.member?.id === ctx.actor.id && state.member.workspaceId === ctx.workspaceId
      : !hostedMode() && ctx.actor.id === "local";
    return verified ? { method: "browser_session", subject: ctx.actor.id, verifiedAtMs: Date.now() } : undefined;
  },
  connectionSql: async () => (await import("@/lib/controlplane/db")).platformDb(),
  credentialBroker: async (resolveConnection) => {
    const { AwsCredentialBroker } = await import("@/lib/credentials/aws/broker");
    return new AwsCredentialBroker({ resolveConnection });
  },
  providerBroker: async (sql, candidate) => {
    const { platformCredentialBroker } = await import("@/lib/platform/credentials");
    return platformCredentialBroker(sql, candidate ? { verifyCandidate: candidate } : {});
  },
};

type G = typeof globalThis & { __zenithBridgeDeps?: Partial<BridgeDeps> };
export const bridgeDeps = (): BridgeDeps => ({ ...defaults, ...(globalThis as G).__zenithBridgeDeps });
export function setBridgeDepsForTests(deps: Partial<BridgeDeps> | null): void {
  (globalThis as G).__zenithBridgeDeps = deps ?? undefined;
}
