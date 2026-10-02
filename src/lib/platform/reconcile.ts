/** Reconciliation ports: reads obtain broker authorization; repairs remain proposals. */
import type { Sql } from "@/lib/controlplane/types";
import { platformBroker, type Broker } from "@/lib/capabilities/platform";
import { CredentialDeniedError, type CredentialBroker } from "@/lib/credentials/types";
import { workerStoreScope, executionHolder, CLAIM_LEASE_MS } from "@/lib/execution";
import { createPlatformReconcilePorts } from "@/lib/reconcile/platform";
import { RECONCILER_PRINCIPAL } from "@/lib/reconcile/types";
import { startDayTwo } from "@/lib/workflows/client";
import { assertFence } from "@/lib/controlplane/db/repos/leases";

export function composeReconcilePorts(db: Sql, credentials: CredentialBroker, getBroker: () => Promise<Broker> = platformBroker) {
  return createPlatformReconcilePorts({
    db,
    broker: {
      propose: (proposal) => workerStoreScope(async () => {
        const result = await (await getBroker()).propose(proposal.request, proposal.principal, { origin: proposal.origin, via: "reconciler", correlationId: proposal.correlationId });
        return { outcome: result.decision.outcome, operationId: result.operation.id };
      }),
    },
    async withObserveSession(req, fn) {
      req.signal.throwIfAborted();
      if (!req.connectionId) throw new CredentialDeniedError("Reconciliation has no verified connection.");
      const auth = await workerStoreScope(async () => (await getBroker()).authorizeRead({ capability: "infrastructure.observe", scope: { workspaceId: req.workspaceId, projectId: req.projectId, environmentId: req.environmentId }, input: {} }, RECONCILER_PRINCIPAL, { audience: "worker", ctx: { origin: "reconciler", via: "reconciler" } }));
      if (auth.decision.outcome !== "allow" || !auth.claims) throw new CredentialDeniedError("Policy refused reconciliation observation.");
      // The read has no owning operation. Credential event FK must not be a
      // synthetic read-grant id: the sink below handles that explicitly.
      return credentials.withSession({ connectionId: req.connectionId, grant: auth.claims, purpose: "observe" }, async (session) => {
        req.signal.throwIfAborted();
        return fn(session);
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
