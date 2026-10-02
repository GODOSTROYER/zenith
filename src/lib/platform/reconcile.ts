/** Reconciliation ports: reads obtain broker authorization; repairs remain proposals. */
import type { Sql } from "@/lib/controlplane/types";
import { platformBroker, type Broker } from "@/lib/capabilities/platform";
import { CredentialDeniedError, type CredentialBroker } from "@/lib/credentials/types";
import { workerStoreScope, executionHolder, CLAIM_LEASE_MS } from "@/lib/execution";
import { createPlatformReconcilePorts, loadPlatformEnvironment } from "@/lib/reconcile/platform";
import { RECONCILER_PRINCIPAL, type ObserveSessionRequest, type ReconcilePorts } from "@/lib/reconcile/types";
import { awsBootstrapContextForConnection } from "@/lib/credentials/aws/naming";
import { createConnectionsPort } from "@/lib/execution/platform";
import { digest } from "@/lib/controlplane/digest";
import { startDayTwo } from "@/lib/workflows/client";
import { assertFence } from "@/lib/controlplane/db/repos/leases";

function createAwsSnapshotLoader(db: Sql) {
  const connections = createConnectionsPort(db);
  return async (request: ObserveSessionRequest) => {
    request.signal.throwIfAborted();
    const environment = await loadPlatformEnvironment(db, request.workspaceId, request.environmentId);
    if (!environment || environment.workspaceId !== request.workspaceId || environment.environmentId !== request.environmentId || environment.projectId !== request.projectId || environment.provider !== "aws" || request.provider !== "aws" || environment.region !== request.region || !request.connectionId || environment.connection?.id !== request.connectionId || environment.connection.status !== "verified") {
      throw new CredentialDeniedError("AWS reconciliation does not match its registered environment and verified connection.");
    }
    const connection = await connections.resolve({ workspaceId: request.workspaceId, connectionId: request.connectionId });
    if (!connection || connection.id !== request.connectionId || connection.workspaceId !== request.workspaceId || connection.status !== "verified" || connection.revokedAt || connection.config.provider !== "aws" || connection.config.region !== request.region) {
      throw new CredentialDeniedError("AWS reconciliation requires its selected verified saved connection.");
    }
    const bootstrap = awsBootstrapContextForConnection(connection.config, request.region);
    request.signal.throwIfAborted();
    return { bootstrap, configDigest: digest(connection.config) };
  };
}

function assertAwsSession(session: unknown, accountId: string, region: string): asserts session is object {
  if (!session || typeof session !== "object" || !("provider" in session) || session.provider !== "aws" || !("accountId" in session) || session.accountId !== accountId || !("region" in session) || session.region !== region) {
    throw new CredentialDeniedError("AWS reconciliation session does not match its saved connection account and region.");
  }
}

/** Saved-context validation for explicitly composed adapters and contract tests. */
export function createReconcileAwsBootstrapResolver(db: Sql): NonNullable<ReconcilePorts["resolveAwsBootstrap"]> {
  const load = createAwsSnapshotLoader(db);
  return async (request, session) => {
    const snapshot = await load(request);
    assertAwsSession(session, snapshot.bootstrap.accountId, request.region);
    return snapshot.bootstrap;
  };
}

export function composeReconcilePorts(db: Sql, credentials: CredentialBroker, getBroker: () => Promise<Broker> = platformBroker) {
  const loadAwsSnapshot = createAwsSnapshotLoader(db);
  const requestScope = (request: ObserveSessionRequest) => digest([request.workspaceId, request.projectId ?? null, request.environmentId, request.provider, request.region, request.connectionId ?? null, request.correlationId]);
  const bindings = new WeakMap<object, { request: ObserveSessionRequest; captured: ObserveSessionRequest; scope: string; configDigest: string; used: boolean }>();
  const spent = new WeakSet<object>();
  return createPlatformReconcilePorts({
    db,
    async resolveAwsBootstrap(request, session) {
      if (!session || typeof session !== "object") throw new CredentialDeniedError("AWS reconciliation has no bound authorized read session.");
      const binding = bindings.get(session);
      if (!binding || binding.request !== request || binding.scope !== requestScope(request) || binding.captured.signal !== request.signal || binding.used) throw new CredentialDeniedError("AWS reconciliation context does not match its bound authorized read.");
      binding.used = true;
      const current = await loadAwsSnapshot(binding.captured);
      assertAwsSession(session, current.bootstrap.accountId, binding.captured.region);
      if (binding.scope !== requestScope(request) || binding.captured.signal !== request.signal || current.configDigest !== binding.configDigest) throw new CredentialDeniedError("AWS reconciliation connection or request changed during the authorized read.");
      return current.bootstrap;
    },
    broker: {
      propose: (proposal) => workerStoreScope(async () => {
        const result = await (await getBroker()).propose(proposal.request, proposal.principal, { origin: proposal.origin, via: "reconciler", correlationId: proposal.correlationId });
        return { outcome: result.decision.outcome, operationId: result.operation.id };
      }),
    },
    async withObserveSession(req, fn) {
      req.signal.throwIfAborted();
      if (!req.connectionId) throw new CredentialDeniedError("Reconciliation has no verified connection.");
      const captured = Object.freeze({ workspaceId: req.workspaceId, projectId: req.projectId, environmentId: req.environmentId, provider: req.provider, region: req.region, connectionId: req.connectionId, correlationId: req.correlationId, signal: req.signal });
      const beforeScope = requestScope(captured);
      const assertRequest = () => {
        captured.signal.throwIfAborted();
        if (beforeScope !== requestScope(req) || captured.signal !== req.signal) throw new CredentialDeniedError("Reconciliation request changed after authorization began.");
      };
      const scope = Object.freeze({ workspaceId: captured.workspaceId, projectId: captured.projectId, environmentId: captured.environmentId });
      const auth = await workerStoreScope(async () => (await getBroker()).authorizeRead({ capability: "infrastructure.observe", scope, input: {} }, RECONCILER_PRINCIPAL, { audience: "worker", ctx: { origin: "reconciler", via: "reconciler" } }));
      if (auth.decision.outcome !== "allow" || !auth.claims) throw new CredentialDeniedError("Policy refused reconciliation observation.");
      assertRequest();
      if (auth.claims.ws !== scope.workspaceId || auth.claims.proj !== scope.projectId || auth.claims.env !== scope.environmentId || auth.claims.cap !== "infrastructure.observe" || auth.claims.aud !== "worker") throw new CredentialDeniedError("Reconciliation read authorization does not match the captured request scope and capability.");
      const before = captured.provider === "aws" ? await loadAwsSnapshot(captured) : undefined;
      assertRequest();
      // The read has no owning operation. Credential event FK must not be a
      // synthetic read-grant id: the sink below handles that explicitly.
      return credentials.withSession({ connectionId: captured.connectionId, grant: auth.claims, purpose: "observe" }, async (session) => {
        assertRequest();
        if (!before) return fn(session);
        const current = await loadAwsSnapshot(captured);
        assertRequest();
        assertAwsSession(session, current.bootstrap.accountId, captured.region);
        if (before.configDigest !== current.configDigest || bindings.has(session) || spent.has(session)) throw new CredentialDeniedError("AWS reconciliation connection or read session changed while credentials opened.");
        bindings.set(session, { request: req, captured, scope: beforeScope, configDigest: current.configDigest, used: false });
        try { return await fn(session); }
        finally { bindings.delete(session); spent.add(session); }
      });
    },
    async startRepair(req) {
      const assertCurrent = async () => {
        req.signal?.throwIfAborted();
        if (req.fence) await assertFence(db, req.fence.scope, req.fence.token);
        req.signal?.throwIfAborted();
      };
      await assertCurrent();
      const broker = await getBroker();
      const op = await broker.deps.store.getOperation(req.workspaceId, req.operationId);
      if (!op || op.workspaceId !== req.workspaceId || op.environmentId !== req.environmentId || op.projectId !== req.projectId || op.capability !== "drift.repair" || op.principal.kind !== "system" || op.principal.id !== RECONCILER_PRINCIPAL.id)
        throw new Error("Repair operation does not match the reconciler's scoped proposal.");
      // A previous claim may already have reached Temporal. Never restart it on
      // a controller retry, even when its workflow acknowledgement was lost.
      if (op.status !== "approved" && op.status !== "queued") throw new Error("Repair operation is not available for a new dispatch; inspect its existing execution.");
      await assertCurrent();
      await workerStoreScope(() => broker.beginExecution({ workspaceId: req.workspaceId, operationId: req.operationId, holder: executionHolder(req.operationId), leaseMs: CLAIM_LEASE_MS, audience: "worker" }));
      try {
        await assertCurrent();
        await startDayTwo({ operationId: req.operationId, workspaceId: req.workspaceId, environmentId: req.environmentId, capability: op.capability });
      } catch {
        // The claim is durable. A lost start acknowledgement cannot prove that
        // no workflow ran; retain uncertainty and forbid a blind new dispatch.
        await workerStoreScope(() => broker.markUncertain({ workspaceId: req.workspaceId, operationId: req.operationId, reason: "Repair workflow dispatch is unconfirmed; inspect the existing operation before any further mutation." })).catch(() => undefined);
        throw new Error("Repair workflow dispatch is unconfirmed; inspect the existing operation.");
      }
    },
  });
}
