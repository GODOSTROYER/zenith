/**
 * Bookkeeping activities: the step timeline, the operation's status, and the
 * environment lease.
 *
 * recordStep / markOperation — the Deployment PROJECTION the UI follows plus the
 * ledger's operation status. Both are idempotent on their inputs (a replayed call
 * finds the state already there), and the projection is best effort by design:
 * the workflow swallows a `recordStep` failure, so nothing here may be needed for
 * correctness. `markOperation` is the one terminal write the workflow retries
 * until it lands; it is also where the operation's ledger status moves
 * (`OperationsPort.transition` maps the workflow's statuses onto the ledger's
 * state machine).
 *
 * Leases — `env:<environmentId>` for operations (holder
 * `worker:<workerId>:<operationId>`), `reconcile:<environmentId>` for reconcile
 * passes (whose id is `reconcile-<environmentId>` and which have no operation
 * row). The scope must match what the operation is about: an activity never
 * takes a lease the operation has no business holding. A busy lease raises
 * `LeaseBusyError` (nothing acted); a renewal that cannot be honoured raises
 * `LeaseLostError`, which the workflow maps to `uncertain` when anything may
 * have acted. Releasing is idempotent and tolerant: a lease that is already gone
 * is released.
 */
import type { OperationRecord } from "@/lib/controlplane/types";
import type { DeploymentStatus } from "@/lib/domain/types";
import type { ExecutionActivities, StepName, WorkflowOperationStatus } from "@/lib/workflows/types";
import { loadOperation, parseOperationInput } from "./context";
import { LeaseBusyError, LeaseLostError, StepFailedError } from "./errors";
import type { DeploymentOutcome } from "./ports";
import { scopeOf, type Runtime, type WorkScope } from "./runtime";
import { errorText, safeText } from "./text";

type StepActivities = Pick<ExecutionActivities, "recordStep" | "markOperation" | "acquireLease" | "renewLease" | "releaseLease">;

const MIN_LEASE_TTL_MS = 1_000;
const MAX_LEASE_TTL_MS = 60 * 60_000;

/** The non-terminal deployment status a step that just started implies. `undefined`: leave the status alone. */
export function deploymentStatusForStep(step: StepName): DeploymentStatus | undefined {
  switch (step) {
    case "validate":
    case "lease":
    case "credentials":
    case "plan":
    case "policy":
    case "final_plan":
      return "planning";
    case "approval":
      return "awaiting_approval";
    case "apply_network":
    case "apply_data":
    case "apply_infrastructure":
    case "build":
    case "publish":
    case "deploy":
    case "secrets":
    case "ingress":
    case "dns_tls":
    case "migrate":
    case "execute_capability":
      return "applying";
    case "verify_infrastructure":
    case "verify_application":
    case "observe":
      return "verifying";
    case "finalize":
    case "release":
      return undefined;
  }
}

const OUTCOME_OF: Partial<Record<WorkflowOperationStatus, DeploymentOutcome>> = {
  succeeded: "succeeded",
  failed: "failed",
  uncertain: "uncertain",
  cancelled: "cancelled",
  expired: "expired",
};

export function createStepActivities(rt: Runtime): StepActivities {
  return {
    async recordStep({ operationId, deploymentId, step, status, detail }) {
      const op = await rt.d.ops.get(operationId);
      if (!op?.environmentId) {
        rt.log("warn", "recordStep: operation not found; nothing was projected", { operationId });
        return;
      }
      const declared = parseOperationInput(op).deploymentId;
      const target = deploymentId ?? declared;
      if (!target) return; // a day-two operation has no deployment to project onto
      if (declared && target !== declared) {
        rt.log("warn", "recordStep: the deployment id does not match the operation's; ignored", { operationId });
        return;
      }
      await rt.d.product.recordStep({
        workspaceId: op.workspaceId,
        environmentId: op.environmentId,
        deploymentId: target,
        step,
        status,
        ...(detail ? { detail: safeText(detail, 500) } : {}),
        at: rt.iso(),
        ...(status === "running" ? { deploymentStatus: deploymentStatusForStep(step) } : {}),
      });
      // The operation is alive as long as its worker is talking about it.
      await rt.d.ops.heartbeat({ workspaceId: op.workspaceId, operationId: op.id }).catch(() => false);
    },

    async markOperation({ operationId, status, error }) {
      const op = await loadOperation(rt, operationId);
      const message = error ? safeText(error, 1000) : undefined;
      const after = await rt.d.ops.transition({ workspaceId: op.workspaceId, operationId: op.id, to: status, ...(message ? { error: message } : {}) });
      if (!after) throw new Error(`Operation ${operationId} could not be updated: it no longer exists in its workspace.`);
      if (after.status !== status) {
        // Terminal is terminal: the ledger already ended this operation (for example the reconciler marked it
        // uncertain). Say so; never pretend the requested status applied, and never retry.
        rt.log("warn", "markOperation: the ledger kept a different status", { operationId, requested: status, actual: after.status });
      }
      await projectStatus(rt, op, status, after.status, message);
    },

    async acquireLease({ operationId, scope, ttlMs }) {
      if (!Number.isFinite(ttlMs) || ttlMs < MIN_LEASE_TTL_MS || ttlMs > MAX_LEASE_TTL_MS) {
        throw new StepFailedError(`A lease ttl of ${ttlMs} ms is outside ${MIN_LEASE_TTL_MS}-${MAX_LEASE_TTL_MS} ms.`);
      }
      const owner = await leaseOwner(rt, operationId, scope);
      const lease = await rt.d.leases.acquire({ scope, holder: rt.holder(operationId), ttlMs, workspaceId: owner.workspaceId });
      if (!lease) throw new LeaseBusyError(scope);
      await rt.emit(owner.scope, "lease.acquired", `acquired:${scope}:${lease.fenceToken}`, { scope, holder: lease.holder, fenceToken: lease.fenceToken });
      return { scope: lease.scope, holder: lease.holder, fenceToken: lease.fenceToken };
    },

    async renewLease({ lease, ttlMs }) {
      const renewed = await rt.d.leases.renew(lease, ttlMs);
      if (!renewed) throw new LeaseLostError(lease.scope, lease.fenceToken);
      await touch(rt, lease.holder);
    },

    async releaseLease({ lease }) {
      const released = await rt.d.leases.release(lease);
      const operationId = operationIdOf(lease.holder);
      if (operationId) {
        const op = await rt.d.ops.get(operationId).catch(() => null);
        if (released && op) await rt.emit(scopeOf(op), "lease.released", `released:${lease.scope}:${lease.fenceToken}`, { scope: lease.scope, fenceToken: lease.fenceToken });
      }
    },
  };
}

/** The operation id a lease holder string names: `worker:<workerId>:<operationId>`. */
function operationIdOf(holder: string): string | undefined {
  const parts = holder.split(":");
  return parts[0] === "worker" && parts.length >= 3 ? parts.slice(2).join(":") : undefined;
}

async function touch(rt: Runtime, holder: string): Promise<void> {
  const operationId = operationIdOf(holder);
  if (!operationId || operationId.startsWith("reconcile-")) return;
  try {
    const op = await rt.d.ops.get(operationId);
    if (op) await rt.d.ops.heartbeat({ workspaceId: op.workspaceId, operationId: op.id });
  } catch (err) {
    rt.log("warn", "could not extend the operation's execution lease", { error: errorText(err) });
  }
}

async function leaseOwner(rt: Runtime, operationId: string, scope: string): Promise<{ workspaceId: string; scope: WorkScope }> {
  const op = await rt.d.ops.get(operationId);
  if (op) {
    if (!op.environmentId || scope !== `env:${op.environmentId}`) {
      throw new StepFailedError("The requested lease scope does not match the environment this operation acts on; refusing to take it.");
    }
    return { workspaceId: op.workspaceId, scope: scopeOf(op) };
  }
  // A reconcile pass is not an operation: its id is `reconcile-<environmentId>`.
  const match = /^reconcile-(.+)$/.exec(operationId);
  if (!match || scope !== `reconcile:${match[1]}`) throw new StepFailedError(`Operation ${safeText(operationId, 80)} was not found.`);
  const environment = await rt.d.product.resolveEnvironment(match[1]);
  if (!environment) throw new StepFailedError("The environment to reconcile was not found.");
  return {
    workspaceId: environment.workspaceId,
    scope: { id: operationId, workspaceId: environment.workspaceId, projectId: environment.projectId, environmentId: match[1], correlationId: operationId },
  };
}

/** Project an operation status onto the deployment the UI follows. Best effort for non-terminal moves; terminal moves retry via the workflow. */
async function projectStatus(rt: Runtime, op: OperationRecord, requested: WorkflowOperationStatus, actual: string, message: string | undefined): Promise<void> {
  const deploymentId = parseOperationInput(op).deploymentId;
  if (!deploymentId || !op.environmentId) return;
  const base = { workspaceId: op.workspaceId, environmentId: op.environmentId, deploymentId, at: rt.iso() };
  const outcome = OUTCOME_OF[requested];
  if (!outcome) {
    await rt.d.product.setDeploymentStatus({ ...base, status: requested === "awaiting_approval" ? "awaiting_approval" : "planning" });
    return;
  }
  // Project the status the LEDGER holds when it refused ours: the UI must not show success for an operation the ledger ended otherwise.
  const final: DeploymentOutcome = actual === requested ? outcome : actual === "uncertain" ? "uncertain" : actual === "succeeded" ? "succeeded" : "failed";
  await rt.d.product.commitOutcome({ ...base, outcome: final, ...(message ? { error: message } : {}) });
  const scope = scopeOf(op);
  if (final === "succeeded") await rt.emit(scope, "deployment.healthy", `deployment:${deploymentId}:healthy`, { deploymentId });
  else await rt.emit(scope, "deployment.unhealthy", `deployment:${deploymentId}:${final}`, { deploymentId, outcome: final });
}
