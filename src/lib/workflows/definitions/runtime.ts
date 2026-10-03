/**
 * The machinery every operation workflow shares: step bookkeeping, the lease,
 * the approval gate, cancellation and the one place a final status is decided.
 *
 * Deterministic module (workflow sandbox): imports only `@temporalio/workflow`
 * and relative modules of the same kind. No clocks other than the sandbox's
 * `Date.now()` (workflow time), no randomness, no I/O.
 *
 * Invariants (each has a test in tests/workflows/):
 *
 *  1. The lease is released exactly once on every path that acquired one,
 *     including cancellation and failure, and never while a mutating activity
 *     is still running (mutating activities are cancelled with
 *     WAIT_CANCELLATION_COMPLETED).
 *  2. The workflow NEVER destroys, rolls back or compensates anything. A
 *     cancelled, failed or uncertain operation is reconciled by observation.
 *     Compensating stateful resources (databases, volumes, buckets) is
 *     deliberately not attempted anywhere in this module; only non-stateful
 *     workload rollback could ever be added, and it is out of scope here.
 *  3. The final status is written once, after the work stopped, from the
 *     classified cause (failures.ts). `uncertain` is never turned into
 *     `failed` or retried.
 *  4. Waiting for approval holds no lease. The 5-minute lease would expire
 *     during a human wait anyway, and an idle hold would block every other
 *     operation on the environment. The lease is re-acquired after the approval
 *     lands, and `final_plan` re-plans against the approved digest, so anything
 *     that changed during the wait is caught there (`plan_changed`). An approval
 *     that already exists is taken immediately and the lease is simply kept.
 *  5. Progress recording (`recordStep`) is a projection and best effort: a store
 *     hiccup must not abort a deploy. The `progress` query always has the truth.
 */

import {
  CancellationScope,
  condition,
  defineQuery,
  defineSignal,
  isCancellation,
  log,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";
import {
  QUERIES,
  SIGNALS,
  type LeaseRef,
  type StepName,
  type StepProgress,
  type WorkflowOperationStatus,
  type WorkflowProgress,
  type WorkflowResult,
  type WorkflowTerminalStatus,
} from "../types";
import { activities } from "./activities";
import { classifyFailure, describeError, failureTypeOf, redactDetail } from "./failures";
import { APPROVAL_POLL_INTERVAL_MS, APPROVAL_TIMEOUT_MS, LEASE_TTL_MS, STEP_MAY_HAVE_ACTED } from "./policies";

const approvalRecordedSignal = defineSignal(SIGNALS.approvalRecorded);
const cancelSignal = defineSignal(SIGNALS.cancel);
const progressQuery = defineQuery<WorkflowProgress>(QUERIES.progress);

/**
 * A workflow-decided terminal outcome. Thrown from inside a step to unwind to
 * `OperationRun.run`, which writes the final status. Never leaves the workflow.
 */
export class OperationHalt extends Error {
  constructor(
    readonly status: Exclude<WorkflowTerminalStatus, "succeeded">,
    message: string
  ) {
    super(message);
    this.name = "OperationHalt";
  }
}

export interface OperationRunOptions {
  operationId: string;
  /** product-store deployment record the UI follows; forwarded to `recordStep` */
  deploymentId?: string;
  /** e.g. `env:<environmentId>` */
  leaseScope: string;
  /** the steps this workflow will report, in order */
  steps: readonly StepName[];
  /** Opt-in versioned recipes must retain unknown outcomes after cancellation. */
  preserveMutationUncertaintyOnCancellation?: boolean;
}

interface Outcome {
  status: WorkflowTerminalStatus;
  error?: string;
}

export interface StepOptions {
  /** renew the lease before running (default true when a lease is held) */
  renew?: boolean;
}

export class OperationRun {
  readonly operationId: string;
  private readonly deploymentId?: string;
  private readonly leaseScope: string;
  private readonly steps: StepProgress[];
  private status: WorkflowOperationStatus = "running";
  private lease: LeaseRef | undefined;
  /** latches once a step that may have acted has been entered */
  private mutationStarted = false;
  private buildMayAct = false;
  private buildUnconfirmed = false;
  private readonly preserveMutationUncertaintyOnCancellation: boolean;
  private approvalSignals = 0;
  private cancelRequested = false;
  private scope: CancellationScope | undefined;

  constructor(opts: OperationRunOptions) {
    this.operationId = opts.operationId;
    this.deploymentId = opts.deploymentId;
    this.leaseScope = opts.leaseScope;
    this.preserveMutationUncertaintyOnCancellation = opts.preserveMutationUncertaintyOnCancellation ?? false;
    this.steps = opts.steps.map((step) => ({ step, status: "pending" as const }));

    setHandler(progressQuery, () => this.snapshot());
    setHandler(approvalRecordedSignal, () => {
      this.approvalSignals += 1;
    });
    setHandler(cancelSignal, () => {
      this.cancelRequested = true;
      this.scope?.cancel();
    });

    const { workflowId } = workflowInfo();
    if (workflowId !== `op-${opts.operationId}`) {
      // The id is what makes a duplicate start idempotent; say so if it was bypassed.
      log.warn("workflow id does not follow op-<operationId>; duplicate starts are not deduplicated", { workflowId, operationId: opts.operationId });
    }
  }

  /* ------------------------------ progress ------------------------------- */

  snapshot(): WorkflowProgress {
    return { operationId: this.operationId, status: this.status, steps: this.steps.map((s) => ({ ...s })) };
  }

  private entry(step: StepName): StepProgress {
    const found = this.steps.find((s) => s.step === step);
    if (found) return found;
    // A step the workflow did not declare up front is still reported, at the end.
    const created: StepProgress = { step, status: "pending" };
    this.steps.push(created);
    return created;
  }

  /** Update local progress, then project it (best effort). */
  private async mark(step: StepName, status: StepProgress["status"], detail?: string): Promise<void> {
    const entry = this.entry(step);
    const now = new Date().toISOString();
    entry.status = status;
    if (status === "running") {
      entry.startedAt = now;
      delete entry.endedAt;
    }
    if (status === "done" || status === "failed" || status === "skipped") entry.endedAt = now;
    if (detail !== undefined) entry.detail = redactDetail(detail);
    try {
      await activities.recordStep({ operationId: this.operationId, deploymentId: this.deploymentId, step, status, detail: entry.detail });
    } catch (err) {
      if (isCancellation(err)) throw err;
      log.warn("recordStep failed; progress is only in the workflow query", { step, status });
    }
  }

  /** Record a step that does not run, e.g. build when images are pinned. */
  async skip(step: StepName, detail: string): Promise<void> {
    await this.mark(step, "skipped", detail);
  }

  /* -------------------------------- steps -------------------------------- */

  /** Called only by the versioned deploy branch, preserving historical replay. */
  enableDurableBuild(): void { this.buildMayAct = true; }

  /**
   * Run one step: renew the lease, record running, run `fn`, record the
   * outcome. A failure is classified into an `OperationHalt` (see failures.ts);
   * a cancellation is rethrown untouched.
   */
  async step<T>(step: StepName, fn: () => Promise<T>, describe?: (result: T) => string | undefined, opts: StepOptions = {}): Promise<T> {
    if (this.lease && opts.renew !== false) {
      try {
        await activities.renewLease({ lease: this.lease, ttlMs: LEASE_TTL_MS });
      } catch (err) {
        if (isCancellation(err)) throw err;
        throw await this.failed("lease", err);
      }
    }
    if (STEP_MAY_HAVE_ACTED[step] || (step === "build" && this.buildMayAct)) this.mutationStarted = true;
    if (step === "build" && this.buildMayAct) this.buildUnconfirmed = true;
    await this.mark(step, "running");
    let result: T;
    try {
      result = await fn();
    } catch (err) {
      throw await this.failed(step, err);
    }
    if (step === "build") this.buildUnconfirmed = false;
    // The step finished; a cancellation that arrives now must not hide that.
    await CancellationScope.nonCancellable(() => this.mark(step, "done", describe?.(result)));
    return result;
  }

  /**
   * A diagnostic step whose failure does not change the operation's outcome
   * (a deploy that verified is not undone by a failed observation). The failure
   * is still recorded on the step.
   */
  async optionalStep<T>(step: StepName, fn: () => Promise<T>, describe?: (result: T) => string | undefined): Promise<T | undefined> {
    try {
      return await this.step(step, fn, describe);
    } catch (err) {
      if (err instanceof OperationHalt) return undefined;
      throw err;
    }
  }

  /** Classify and record a failed step; returns the error to throw. */
  private async failed(step: StepName, err: unknown): Promise<unknown> {
    if (isCancellation(err)) {
      await CancellationScope.nonCancellable(() => this.mark(step, "failed", "cancelled while running"));
      return err;
    }
    if (err instanceof OperationHalt) {
      await CancellationScope.nonCancellable(() => this.mark(step, "failed", err.message));
      return err;
    }
    const classified = classifyFailure({ step, err, mutationStarted: this.mutationStarted, buildMayAct: this.buildMayAct });
    await CancellationScope.nonCancellable(() => this.mark(step, "failed", classified.message));
    return new OperationHalt(classified.status, classified.message);
  }

  /** A decided (not failed-by-error) end of the operation. */
  halt(status: OperationHalt["status"], message: string): OperationHalt {
    return new OperationHalt(status, redactDetail(message));
  }

  /* -------------------------------- lease -------------------------------- */

  requireLease(): LeaseRef {
    if (!this.lease) throw new OperationHalt("failed", "internal: a leased step ran without a lease");
    return this.lease;
  }

  /** The `lease` step. */
  async acquireLeaseStep(): Promise<LeaseRef> {
    return this.step(
      "lease",
      async () => {
        this.lease = await activities.acquireLease({ operationId: this.operationId, scope: this.leaseScope, ttlMs: LEASE_TTL_MS });
        return this.lease;
      },
      (lease) => `${lease.scope} fence ${lease.fenceToken}`,
      { renew: false }
    );
  }

  private async dropLease(): Promise<boolean> {
    const lease = this.lease;
    if (!lease) return false;
    this.lease = undefined;
    await activities.releaseLease({ lease });
    return true;
  }

  /* ------------------------------- approval ------------------------------ */

  /**
   * Get the approval. An approval that already exists is taken on the spot,
   * with the lease still held. Otherwise wait for one, lease-free (invariant 4):
   * release the lease, tell the control plane the operation is
   * `awaiting_approval`, and loop until the approval is recorded, rejected, or
   * APPROVAL_TIMEOUT_MS passes. The `approvalRecorded` signal only wakes the loop;
   * every decision comes from `checkApproval`, which also runs on
   * APPROVAL_POLL_INTERVAL_MS so a lost signal costs at most that. A fresh lease
   * (new fence token) is taken after a wait.
   */
  async approvalGate(): Promise<void> {
    let waited = false;
    await this.step(
      "approval",
      async () => {
        const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
        for (;;) {
          const seen = this.approvalSignals;
          const approval = await activities.checkApproval({ operationId: this.operationId });
          if (approval.rejected) throw new OperationHalt("failed", "The approval was rejected; nothing was changed.");
          if (approval.approved) return approval;

          if (!waited) {
            waited = true;
            try {
              await this.dropLease();
            } catch (err) {
              if (isCancellation(err)) throw err;
              // Best effort: an unreleased lease expires by itself within LEASE_TTL_MS.
              log.warn("releasing the lease before the approval wait failed; it will expire on its own");
            }
            await activities.markOperation({ operationId: this.operationId, status: "awaiting_approval" });
            this.status = "awaiting_approval";
          }

          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            throw new OperationHalt("expired", "No approval was recorded within 24 hours; the operation expired and nothing was changed.");
          }
          await condition(() => this.approvalSignals > seen, Math.min(remaining, APPROVAL_POLL_INTERVAL_MS));
        }
      },
      (approval) => (approval.approvalId ? `approved (${approval.approvalId})` : "approved"),
      { renew: false }
    );
    if (waited) {
      this.status = "running";
      await activities.markOperation({ operationId: this.operationId, status: "running" });
      await this.acquireLeaseStep();
    }
  }

  /* --------------------------------- run --------------------------------- */

  /**
   * Run `body` under a cancellable scope, then settle: write the terminal
   * status, then release the lease, both outside cancellation.
   */
  async run(body: () => Promise<void>): Promise<WorkflowResult> {
    let outcome: Outcome = { status: "succeeded" };
    const scope = new CancellationScope({ cancellable: true });
    this.scope = scope;
    if (this.cancelRequested) scope.cancel();
    try {
      await scope.run(async () => {
        await activities.markOperation({ operationId: this.operationId, status: "running" });
        await body();
      });
    } catch (err) {
      outcome = this.outcomeOf(err);
    }
    this.scope = undefined;
    return this.settle(outcome);
  }

  private outcomeOf(err: unknown): Outcome {
    if (this.buildUnconfirmed && (isCancellation(err) || (err instanceof OperationHalt && err.status === "cancelled"))) {
      return { status: "uncertain", error: "Cancellation stopped the build activity; an accepted provider build may still be running. Inspect its retained launch and provider receipt before any further write." };
    }
    if (this.preserveMutationUncertaintyOnCancellation && this.mutationStarted
      && (isCancellation(err) || (err instanceof OperationHalt && err.status === "cancelled"))) {
      return { status: "uncertain", error: "Cancellation stopped this repair after an apply attempt; its outcome is unconfirmed. Inspect this operation before any further write." };
    }
    if (isCancellation(err)) {
      const partial = this.mutationStarted
        ? " Steps that change the environment had started; nothing was rolled back or destroyed and reconcile will observe the environment."
        : "";
      return { status: "cancelled", error: `Cancelled by request.${partial}` };
    }
    if (err instanceof OperationHalt) return { status: err.status, error: err.message };
    // Not a step failure: a bug, or a bookkeeping activity (markOperation) that
    // could not run. `uncertain` only if an earlier step may have acted.
    const type = failureTypeOf(err);
    const text = `Unexpected error outside a step${type ? ` (${type})` : ""}: ${describeError(err)}`;
    return this.mutationStarted
      ? { status: "uncertain", error: `${text} Steps that change the environment had started; reconcile will observe the environment.` }
      : { status: "failed", error: text };
  }

  private async settle(outcome: Outcome): Promise<WorkflowResult> {
    let settleError: unknown;
    await CancellationScope.nonCancellable(async () => {
      try {
        if (outcome.status === "succeeded") {
          await this.mark("finalize", "running");
          await activities.markOperation({ operationId: this.operationId, status: "succeeded" });
          await this.mark("finalize", "done");
        } else {
          await activities.markOperation({ operationId: this.operationId, status: outcome.status, error: outcome.error });
        }
        this.status = outcome.status;
      } catch (err) {
        settleError = err;
      }
      await this.releaseAtEnd();
    });
    if (settleError !== undefined) throw settleError;
    return { operationId: this.operationId, status: outcome.status, ...(outcome.error ? { error: outcome.error } : {}), steps: this.snapshot().steps };
  }

  /** Release whatever lease is still held. A failed release never changes the status. */
  private async releaseAtEnd(): Promise<void> {
    if (!this.lease) {
      await this.mark("release", "skipped", "no lease held");
      return;
    }
    await this.mark("release", "running");
    try {
      await this.dropLease();
      await this.mark("release", "done");
    } catch (err) {
      const detail = classifyFailure({ step: "release", err, mutationStarted: false }).message;
      await this.mark("release", "failed", `${detail} The lease expires on its own.`);
    }
  }
}
