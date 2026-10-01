/** Reconciliation ports: reads obtain broker authorization; repairs remain proposals. */
import type { Sql } from "@/lib/controlplane/types";
import { platformBroker, type Broker } from "@/lib/capabilities/platform";
import { CredentialDeniedError, type CredentialBroker } from "@/lib/credentials/types";
import { workerStoreScope, executionHolder, CLAIM_LEASE_MS } from "@/lib/execution";
import { createPlatformReconcilePorts } from "@/lib/reconcile/platform";
import { RECONCILER_PRINCIPAL } from "@/lib/reconcile/types";
import { startDayTwo } from "@/lib/workflows/client";

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
      const broker = await getBroker();
      const op = await broker.deps.store.getOperation(req.workspaceId, req.operationId);
      if (!op) throw new Error("Repair operation not found in this workspace.");
      if (op.status === "approved" || op.status === "queued") await workerStoreScope(() => broker.beginExecution({ workspaceId: req.workspaceId, operationId: req.operationId, holder: executionHolder(req.operationId), leaseMs: CLAIM_LEASE_MS, audience: "worker" }));
      else if (op.status !== "running") return;
      await startDayTwo({ operationId: req.operationId, workspaceId: req.workspaceId, environmentId: req.environmentId, capability: op.capability });
    },
  });
}
