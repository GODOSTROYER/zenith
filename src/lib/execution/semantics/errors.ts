/** Refusal raised when the approved executable semantics no longer hold at a dispatch point. */
import { ApplicationFailure } from "@temporalio/activity";
import { FAILURE_TYPES } from "@/lib/workflows/types";
import { diffSemantics, type ExecutableSemantics, type SemanticComponentName } from "./digest";

/**
 * The approved executable semantics no longer hold. Nothing was dispatched. The failure type is the
 * same one a moved plan produces (`plan_changed`, non-retryable), so every workflow already ends it as
 * "failed, re-approval required", and the operation page already offers the reapproval path.
 */
export class SemanticsChangedError extends ApplicationFailure {
  readonly code = "semantics_changed";
  constructor(readonly changed: readonly SemanticComponentName[], stage: string) {
    super(
      `semantics_changed: ${changed.length ? changed.join(", ") : "the approved executable semantics"} changed since the approval (${stage}); nothing was dispatched. Plan again and have the new plan approved.`,
      FAILURE_TYPES.planChanged,
      true
    );
  }
}

/** Throw `SemanticsChangedError` unless `current` is exactly the approved semantics. */
export function assertSemanticsMatch(approved: ExecutableSemantics, current: ExecutableSemantics, stage: string): void {
  if (approved.digest === current.digest) return;
  throw new SemanticsChangedError(diffSemantics(approved, current), stage);
}
