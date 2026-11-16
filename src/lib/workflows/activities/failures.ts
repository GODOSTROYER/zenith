/**
 * Activity-side failure helpers: how an activity tells the workflow what kind of
 * failure it hit. Workflow code never sees the control plane's error classes;
 * it sees a Temporal `ApplicationFailure` whose `type` is one of FAILURE_TYPES
 * (types.ts), and `definitions/failures.ts` maps that to a final status.
 *
 * Node-side module: it may import controlplane / tofu types. It must never be
 * imported from `definitions/` (the workflow sandbox).
 *
 * Messages must not contain secret values; the workflow scrubs and truncates
 * what it records, but that is defense in depth, not the mechanism.
 */

import { ApplicationFailure, CancelledFailure } from "@temporalio/activity";
import { LeaseLostError } from "@/lib/controlplane/types";
import { TofuPlanChangedError } from "@/lib/tofu/types";
import { EffectTombstonedError, EffectUnresolvedError } from "@/lib/effects/ledger";
import { FAILURE_TYPES } from "../types";

const nonRetryable = (message: string, type: string): ApplicationFailure => ApplicationFailure.create({ message, type, nonRetryable: true });

/** The fence moved or the lease expired. Non-retryable; `uncertain` if anything may have acted. */
export const leaseLost = (message: string): ApplicationFailure => nonRetryable(message, FAILURE_TYPES.leaseLost);

/** Another live holder owns the lease. Nothing acted. */
export const leaseBusy = (message: string): ApplicationFailure => nonRetryable(message, FAILURE_TYPES.leaseBusy);

/** The re-plan differs from the approved plan. Nothing was applied; re-approval required. */
export const planChanged = (message: string): ApplicationFailure => nonRetryable(message, FAILURE_TYPES.planChanged);

/**
 * The step ran to a clean, definitive failure (tofu exited non-zero, a
 * capability reported "not ok"). Use it only when the activity knows how it
 * ended; a crash, timeout or unclassified error must stay a plain error so a
 * mutating step is finalized as `uncertain`.
 */
export const stepFailed = (message: string): ApplicationFailure => nonRetryable(message, FAILURE_TYPES.stepFailed);

/** The activity is a stub in this worker build. */
export const notImplemented = (activity: string): ApplicationFailure =>
  nonRetryable(`Activity ${activity} is not implemented in this worker build; nothing was changed.`, FAILURE_TYPES.notImplemented);

/**
 * Translate a control-plane error into the failure the workflow understands.
 * Anything unrecognized is returned unchanged: it stays retryable (and, for a
 * mutating step, ends `uncertain`).
 */
export function toTemporalFailure(err: unknown): unknown {
  if (err instanceof ApplicationFailure || err instanceof CancelledFailure) return err;
  if (err instanceof LeaseLostError) return leaseLost(err.message);
  if (err instanceof TofuPlanChangedError) return planChanged(err.message);
  // An unresolved external effect must never be retried by the activity policy: the ledger refuses every replay.
  if (err instanceof EffectUnresolvedError || err instanceof EffectTombstonedError) return stepFailed(err.message);
  return err;
}

type AsyncFn = (...args: never[]) => Promise<unknown>;

/** Wrap every activity so control-plane errors cross the Temporal boundary as typed failures. */
export function withFailureMapping<T extends { [K in keyof T]: AsyncFn }>(activities: T): T {
  const wrapped = {} as T;
  for (const name of Object.keys(activities) as (keyof T)[]) {
    const fn = activities[name] as unknown as (...args: unknown[]) => Promise<unknown>;
    wrapped[name] = (async (...args: unknown[]) => {
      try {
        return await fn(...args);
      } catch (err) {
        throw toTemporalFailure(err);
      }
    }) as unknown as T[keyof T];
  }
  return wrapped;
}
