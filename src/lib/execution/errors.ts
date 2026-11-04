/**
 * Typed errors the execution activities throw, and how each one reaches the
 * workflow (`src/lib/workflows`, ADR-0009).
 *
 * The workflow never sees these classes. It sees a Temporal `ApplicationFailure`
 * whose `type` is one of `FAILURE_TYPES` (workflows/types.ts):
 *
 *   class                     code          ApplicationFailure.type   final status the workflow picks
 *   ------------------------  ------------  ------------------------  ----------------------------------
 *   LeaseLostError            lease_lost    LeaseLost                 uncertain if the step may have acted
 *   TofuPlanChangedError      plan_changed  plan_changed              failed, re-approval required
 *   LeaseBusyError            lease_busy    LeaseBusy                 failed, nothing acted
 *   StepFailedError           step_failed   StepFailed                failed ("may be partial" for mutating steps)
 *   anything else             —             (none: retryable)         uncertain if the step may have acted
 *
 * `LeaseLostError` (controlplane contract) and `TofuPlanChangedError` (tofu
 * contract) are converted by the worker's `withFailureMapping`
 * (workflows/activities/failures.ts). `LeaseBusyError` and `StepFailedError`
 * ARE `ApplicationFailure`s already (same `type`, `nonRetryable`), so they cross
 * the boundary unchanged and need no mapping entry — the worker wraps this
 * module's activities with `withFailureMapping` exactly like the stubs.
 *
 * Rule for throwing a `StepFailedError`: only when the activity KNOWS how the
 * step ended (tofu exited non-zero, a migration exited with a code, a build
 * failed, a precondition was refused before anything was touched). A crash, a
 * timeout or an unclassified exception must stay a plain `Error` so a mutating
 * step is finalized `uncertain`, the honest answer when the outcome is hidden.
 *
 * Messages never contain credentials, plan files or provider payloads; they
 * are built from ids, digests, counts and `safeText`-scrubbed strings.
 */
import { ApplicationFailure } from "@temporalio/activity";
import { LeaseLostError } from "@/lib/controlplane/types";
import { TofuPlanChangedError } from "@/lib/tofu/types";
import { FAILURE_TYPES } from "@/lib/workflows/types";

export { LeaseLostError, TofuPlanChangedError };

/** Another live holder owns the lease. Nothing acted. Non-retryable. */
export class LeaseBusyError extends ApplicationFailure {
  readonly code = "lease_busy";
  constructor(readonly scope: string) {
    super(`Another operation holds ${scope}; nothing was changed.`, FAILURE_TYPES.leaseBusy, true);
  }
}

/** The step ran to a clean, definitive failure. Non-retryable. */
export class StepFailedError extends ApplicationFailure {
  readonly code = "step_failed";
  constructor(message: string) {
    super(message, FAILURE_TYPES.stepFailed, true);
  }
}

/** Duck-typed so a store adapter's own error class (e.g. `ControlStoreError`) is recognized without importing it. */
export function errorCode(err: unknown): string | undefined {
  if (err !== null && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string") return (err as { code: string }).code;
  return undefined;
}
