/**
 * Recording the reviewed semantics at planning, and refusing a dispatch whose semantics moved
 * (PROD-DUR-03). Low-level on purpose: it imports no planning module, so plan.ts and apply.ts can
 * call it without a cycle. The release-step convenience that builds the workspace itself lives in
 * `operation.ts`.
 */
import { StepFailedError } from "../errors";
import type { ExecContext } from "../context";
import type { Runtime } from "../runtime";
import { collectExecutableSemantics, type CollectArgs } from "./collect";
import type { ExecutableSemantics } from "./digest";
import { assertSemanticsMatch } from "./errors";

/**
 * Compute the canonical semantics of the plan just produced and, when a store is wired, record them
 * write-once under the operation and plan digest. Returns the semantics for the plan evidence row.
 */
export async function recordReviewedSemantics(rt: Pick<Runtime, "d">, ec: ExecContext, args: CollectArgs & { planDigest: string }): Promise<ExecutableSemantics> {
  const semantics = await collectExecutableSemantics(rt, ec, args);
  const store = rt.d.semantics;
  if (store) {
    try {
      await store.record({ workspaceId: ec.workspaceId, operationId: ec.op.id, planDigest: args.planDigest, semantics });
    } catch (error) {
      if (error instanceof Error && (error as { code?: string }).code === "conflict") {
        throw new StepFailedError("The reviewed executable semantics of this plan are write-once and the new planning run differs; plan again and have the new plan approved.");
      }
      throw error;
    }
  }
  return semantics;
}

/**
 * Recompute the current semantics and require them to equal the ones recorded at review. Throws
 * `SemanticsChangedError` (type `plan_changed`: failed, reapproval required, nothing dispatched) naming
 * the components that moved. With no store wired this is a no-op; with a store, a plan that has no
 * recorded semantics is refused rather than treated as unchanged.
 */
export async function assertApprovedSemantics(rt: Pick<Runtime, "d">, ec: ExecContext, args: CollectArgs & { planDigest: string }, stage: string, opts: { operationId?: string } = {}): Promise<void> {
  const store = rt.d.semantics;
  if (!store) return;
  // A teardown operation reuses the plan another (read-only review) operation recorded; that operation holds the row.
  const approved = await store.get(ec.workspaceId, opts.operationId ?? ec.op.id, args.planDigest);
  if (!approved) throw new StepFailedError("No executable semantics were recorded for the reviewed plan, so nothing was dispatched. Plan again and have the new plan approved.");
  const current = await collectExecutableSemantics(rt, ec, args);
  assertSemanticsMatch(approved.semantics, current, stage);
}
