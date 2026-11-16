/**
 * Failure classification: the activity error that reached the workflow -> the
 * operation's final status and a short redacted message.
 *
 * Deterministic and pure (no I/O, no clocks); it only inspects the error the
 * SDK delivered. Table-driven tests in tests/workflows/failures.test.ts.
 *
 * The table (rule order matters; the first match wins):
 *
 *   activity failure (ApplicationFailure.type)      final status
 *   ---------------------------------------------   --------------------------------------
 *   plan_changed                                    failed      re-approval required, nothing applied
 *   LeaseBusy                                       failed      another holder; nothing acted
 *   not_implemented                                 failed      stub activity; nothing acted
 *   StepFailed (clean, definitive failure)          failed      a mutating step says "may be partial"
 *   LeaseLost                                       uncertain   if the step may act OR an earlier mutating
 *                                                               step was entered; else failed
 *   timeout (start-to-close / heartbeat / ...)      uncertain   if the step may act (STEP_MAY_HAVE_ACTED);
 *   any other error, retries exhausted              failed      otherwise
 *
 * The line between the two: `uncertain` means "this step may have changed
 * something and we cannot prove what". A step that cannot change anything
 * (a plan, a verification, a build) that fails is a plain `failed`, and when an
 * earlier step had already changed the environment the message says so and that
 * nothing was rolled back. A lost lease is the exception: once anything has
 * been changed, losing the fence means another writer may now be acting, so it
 * is `uncertain` from then on.
 *
 * Nothing here ever chooses a compensating action: a failed or uncertain
 * operation is reconciled by observation, never by an automatic destroy or re-run.
 */

import { ActivityFailure, ApplicationFailure, CancelledFailure, TimeoutFailure } from "@temporalio/workflow";
import { FAILURE_TYPES, type StepName, type WorkflowTerminalStatus } from "../types";
import { MAX_DETAIL_CHARS, STEP_MAY_HAVE_ACTED } from "./policies";

/** A classified failure. */
export interface ClassifiedFailure {
  status: Extract<WorkflowTerminalStatus, "failed" | "uncertain">;
  /** short, redacted; safe for `markOperation.error` and step `detail` */
  message: string;
  /** the failure type the activity reported, when there was one */
  failureType?: string;
}

/* ------------------------------- redaction -------------------------------- */

const REDACTIONS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted private key]"],
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b/g, "[redacted access key id]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted jwt]"],
  [/\b(secret|token|password|passwd|api[_-]?key|access[_-]?key|credential)s?(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1$2[redacted]"],
];

/**
 * Bound and scrub text before it is written anywhere durable. This is defense
 * in depth: activities are required not to put secret values in errors at all.
 */
export function redactDetail(text: string, max: number = MAX_DETAIL_CHARS): string {
  let out = text.replace(/[\r\n\t]+/g, " ").trim();
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/* ------------------------------- inspection ------------------------------- */

/** The root cause behind an ActivityFailure wrapper, if any. */
function rootCause(err: unknown): unknown {
  let current: unknown = err;
  // ActivityFailure -> (ApplicationFailure | TimeoutFailure | CancelledFailure ...)
  for (let depth = 0; depth < 5 && current instanceof ActivityFailure; depth++) current = current.cause;
  return current;
}

/** The ApplicationFailure `type`, when the error carries one. */
export function failureTypeOf(err: unknown): string | undefined {
  const cause = rootCause(err);
  if (cause instanceof ApplicationFailure) return cause.type ?? undefined;
  return undefined;
}

/** A short, redacted description of what went wrong, without the SDK wrapper text. */
export function describeError(err: unknown): string {
  return redactDetail(messageOf(err));
}

function messageOf(err: unknown): string {
  const cause = rootCause(err);
  if (cause instanceof TimeoutFailure) return `activity timed out (${cause.timeoutType ?? "unknown timeout"})`;
  if (cause instanceof CancelledFailure) return "activity was cancelled";
  if (cause instanceof Error) return cause.message;
  if (err instanceof Error) return err.message;
  return "unknown error";
}

/* ------------------------------ classification ---------------------------- */

const isPlanApplyStep = (step: StepName): boolean => step === "apply_infrastructure" || step === "apply_network" || step === "apply_data";

export interface ClassifyInput {
  step: StepName;
  err: unknown;
  /** an earlier step that may have acted has been entered */
  mutationStarted: boolean;
  /** Opt-in for the patched build branch; omitted for historical replay. */
  buildMayAct?: boolean;
}

export function classifyFailure({ step, err, mutationStarted, buildMayAct = false }: ClassifyInput): ClassifiedFailure {
  const failureType = failureTypeOf(err);
  const raw = describeError(err);
  const stepMayAct = STEP_MAY_HAVE_ACTED[step] || (step === "build" && buildMayAct);
  const base = { failureType };
  const where = step === "lease" ? "lease renewal" : step;
  const earlier = mutationStarted && !stepMayAct ? " Earlier steps had already changed the environment; nothing was rolled back." : "";

  switch (failureType) {
    case FAILURE_TYPES.planChanged:
      return {
        ...base,
        status: "failed",
        message: `The infrastructure plan changed after it was reviewed; nothing was applied. A new plan and a new approval are required. (${raw})`,
      };
    case FAILURE_TYPES.leaseBusy:
      return { ...base, status: "failed", message: `The environment is busy: another operation holds its lease. Nothing was changed. (${raw})` };
    case FAILURE_TYPES.notImplemented:
      return { ...base, status: "failed", message: `${step} is not implemented in this worker build; nothing was changed. (${raw})` };
    case FAILURE_TYPES.stepFailed:
      return {
        ...base,
        status: "failed",
        message: isPlanApplyStep(step)
          ? `apply failed (partial apply; reconcile will observe the environment). (${raw})`
          : stepMayAct
            ? `${step} failed; it may have partially completed and reconcile will observe the environment. (${raw})`
            : `${step} failed.${earlier} (${raw})`,
      };
    case FAILURE_TYPES.leaseLost:
      return mutationStarted || stepMayAct
        ? {
            ...base,
            status: "uncertain",
            message: `The environment lease was lost during ${where}; work stopped and the outcome cannot be proven. Reconcile will observe the environment. (${raw})`,
          }
        : { ...base, status: "failed", message: `The environment lease was lost during ${where}, before any change was made. (${raw})` };
    default:
      return stepMayAct
        ? {
            ...base,
            status: "uncertain",
            message: `${step} did not complete cleanly and may have acted; the outcome is unknown. Reconcile will observe the environment. (${raw})`,
          }
        : { ...base, status: "failed", message: `${step} failed${earlier ? `.${earlier}` : " before any change was made."} (${raw})` };
  }
}
