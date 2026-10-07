/**
 * The orchestration service: durable, tenant-scoped operations over a mixed run (PROD-MIX-03/04).
 * Each call loads the run, applies one pure transition, and saves it with the ledger event under
 * a version compare-and-set (bounded retries on a concurrent write). It performs no cloud calls and
 * starts no child itself: an executor asks `startChild`, which answers whether the child may run
 * now, records it as started, and the executor then drives the child workflow.
 */
import type { BrokerDeps } from "@/lib/capabilities/ports";
import { planMixedPartitions, type MixedPartitionInput } from "../mixed-partitions";
import type { ParentPlanView } from "./child-view";
import type { OutputConsumptionDecision } from "./decision";
import { MixedOrchestrationError, refuse } from "./errors";
import { evaluateOrdering, type OrderingSignals } from "./ordering-rules";
import { applyOutputs, assessOutputConsumption, validateOutput } from "./outputs";
import { resolveLivePreauthorizations, type PreauthorizationStore } from "./preauthorization";
import { applyRunEvent, createRunState, summarizeRun, RunEventSchema, type AnyRunEvent, type MixedRunState, type RunSummary } from "./run";
import type { LedgerEventKind, MixedRunStore, StoredRun } from "./run-store";
import { planTeardown, recordTeardownResult, releaseTeardownStep, verifyTeardownApproval, type TeardownApprovalPort, type TeardownPlanInput, type TeardownReport } from "./teardown";

/** Verifies a person's approval of an exact new parent digest. The platform composition refuses until a parent approval round is joined. */
export interface ParentReviewPort {
  approvedParentDigest(workspaceId: string, parentOperationId: string, approvalId: string): Promise<string | null>;
}

export interface MixedRunDeps {
  runs: MixedRunStore;
  preauthorizations: PreauthorizationStore;
  roles: BrokerDeps["roles"];
  teardownApprovals: TeardownApprovalPort;
  parentReview: ParentReviewPort;
  now: () => Date;
}

export const NO_SIGNALS: OrderingSignals = Object.freeze({ drift: [], migrationChildIds: [] });
const RETRIES = 3;

type Transition = (state: MixedRunState) => MixedRunState | Promise<MixedRunState>;

async function transact(deps: Pick<MixedRunDeps, "runs">, workspaceId: string, parentOperationId: string, kind: LedgerEventKind, childId: string | undefined, data: unknown, fn: Transition): Promise<StoredRun> {
  for (let attempt = 0; ; attempt++) {
    const stored = await deps.runs.get(workspaceId, parentOperationId);
    if (!stored) return refuse("unknown_child", parentOperationId);
    const next = await fn(stored.state);
    try {
      return await deps.runs.save(workspaceId, parentOperationId, stored.version, next, { kind, ...(childId ? { childId } : {}), data });
    } catch (error) {
      if (error instanceof MixedOrchestrationError && error.code === "conflict" && attempt < RETRIES - 1) continue;
      throw error;
    }
  }
}

export async function openMixedRun(deps: MixedRunDeps, input: { workspaceId: string; parentOperationId: string; view: ParentPlanView; expiresAt: string; childTimeoutMs: number }): Promise<RunSummary> {
  if (input.view.workspaceId !== input.workspaceId) return refuse("scope_mismatch");
  const state = createRunState(input.view, { parentOperationId: input.parentOperationId, expiresAt: input.expiresAt, childTimeoutMs: input.childTimeoutMs, now: deps.now() });
  const stored = await deps.runs.create(state, { kind: "run_created", data: { parentDigest: state.parentDigest, desiredDigest: state.desiredDigest, order: state.order, expiresAt: state.expiresAt } });
  return summarizeRun(stored.state);
}

export async function readMixedRun(deps: Pick<MixedRunDeps, "runs">, workspaceId: string, parentOperationId: string): Promise<{ summary: RunSummary; state: MixedRunState } | null> {
  const stored = await deps.runs.get(workspaceId, parentOperationId);
  return stored ? { summary: summarizeRun(stored.state), state: stored.state } : null;
}

/**
 * Record a child event. A `start` is refused unless every ordering rule allows it right now (producer drift,
 * incomplete migrations, run cancelled or expired, producers not succeeded, stale effect digest).
 */
export async function recordChildEvent(deps: MixedRunDeps, input: { workspaceId: string; parentOperationId: string; event: unknown; view?: ParentPlanView; signals?: OrderingSignals }): Promise<RunSummary> {
  const parsedEvent = RunEventSchema.safeParse(input.event);
  if (!parsedEvent.success) return refuse("invalid_input");
  const event: AnyRunEvent = parsedEvent.data;
  const childId = "childId" in event ? event.childId : undefined;
  const stored = await transact(deps, input.workspaceId, input.parentOperationId, event.kind, childId, event, (state) => {
    if (event.kind === "start") {
      const verdict = evaluateOrdering(state, { kind: "start_child", childId: event.childId }, input.signals ?? NO_SIGNALS);
      if (!verdict.allowed) return refuse("ordering_blocked", ...verdict.blocks.map((block) => `${block.rule}:${block.blockedBy}`));
    }
    return applyRunEvent(state, event, input.view);
  });
  return summarizeRun(stored.state);
}

/** Time-driven progress: child timeouts and approval expiry. Idempotent. */
export async function tickMixedRun(deps: Pick<MixedRunDeps, "runs" | "now">, workspaceId: string, parentOperationId: string): Promise<RunSummary> {
  const at = deps.now().toISOString();
  const stored = await transact(deps, workspaceId, parentOperationId, "tick", undefined, { at }, (state) => applyRunEvent(state, { kind: "tick", at }));
  return summarizeRun(stored.state);
}

/** Cancellation: unstarted children are cancelled now; running children are asked to stop and stay `cancel_requested` until they report. */
export async function cancelMixedRun(deps: Pick<MixedRunDeps, "runs" | "now">, workspaceId: string, parentOperationId: string): Promise<RunSummary | null> {
  if (!(await deps.runs.get(workspaceId, parentOperationId))) return null;
  const at = deps.now().toISOString();
  const stored = await transact(deps, workspaceId, parentOperationId, "cancel", undefined, { at }, (state) => applyRunEvent(state, { kind: "cancel", at }));
  return summarizeRun(stored.state);
}

/** System sweep for the housekeeping pass: tick every run whose deadline has passed. Returns counts only. */
export async function sweepDueMixedRuns(deps: Pick<MixedRunDeps, "runs" | "now">, limit = 50): Promise<{ swept: number; failed: number }> {
  const due = await deps.runs.listDue(deps.now(), limit);
  let swept = 0;
  let failed = 0;
  for (const key of due) {
    try { await tickMixedRun(deps, key.workspaceId, key.parentOperationId); swept += 1; } catch { failed += 1; }
  }
  return { swept, failed };
}

export interface ConsumeOutputsInput {
  workspaceId: string;
  parentOperationId: string;
  view: ParentPlanView;
  /** The exact planner input a person approved. */
  approvedInput: MixedPartitionInput;
  outputs: readonly unknown[];
  preauthorizationIds?: readonly string[];
  /** A person's approval of the new parent digest, when no preauthorization covers the change. */
  review?: { approvalId: string };
}

export interface ConsumeOutputsResult {
  decision: OutputConsumptionDecision;
  /** True when the consumers were rebound (unchanged, preauthorized, or reviewed). False means review is required and nothing changed. */
  applied: boolean;
  /** The planner input with the outputs applied; the next `approvedInput` once `applied` is true. */
  nextInput?: MixedPartitionInput;
  summary: RunSummary;
}

/**
 * Validate outputs, judge them against what was approved, and rebind the consuming children only with
 * sufficient authority. With `review_required` and no verified review, the run is left untouched and the
 * decision (the exact parent digest to review) is returned.
 */
export async function consumeOutputs(deps: MixedRunDeps, input: ConsumeOutputsInput): Promise<ConsumeOutputsResult> {
  const stored = await deps.runs.get(input.workspaceId, input.parentOperationId);
  if (!stored) return refuse("unknown_child", input.parentOperationId);
  if (input.view.workspaceId !== input.workspaceId) return refuse("scope_mismatch");
  const outputs = input.outputs.map((raw) => validateOutput(raw, stored.state, input.view));
  const now = deps.now();
  const candidates = await resolveLivePreauthorizations(deps, deps.preauthorizations, input.workspaceId, input.preauthorizationIds ?? [], now);
  const decision = assessOutputConsumption({ approvedInput: input.approvedInput, parentOperationId: input.parentOperationId, outputs, preauthorizations: candidates, now });
  if (decision.classification === "review_required") {
    const approvalId = input.review?.approvalId;
    const approved = approvalId ? await deps.parentReview.approvedParentDigest(input.workspaceId, input.parentOperationId, approvalId) : null;
    if (!approvalId || approved !== decision.requiredParentDigest) return { decision, applied: false, summary: summarizeRun(stored.state) };
    const result = await transact(deps, input.workspaceId, input.parentOperationId, "rebind", undefined, { classification: decision.classification, parentDigest: decision.requiredParentDigest, approvalId, consumers: decision.consumers },
      (state) => applyRunEvent(state, { kind: "rebind", decision, review: { approvalId, approvedParentDigest: approved }, at: now.toISOString() }, input.view));
    return { decision, applied: true, nextInput: applyOutputs(input.approvedInput, planMixedPartitions(input.approvedInput), outputs), summary: summarizeRun(result.state) };
  }
  if (decision.classification === "preauthorized") {
    // Reserve every use before the state changes; a lost race falls back to review with nothing recorded.
    for (const id of decision.preauthorizationIds) {
      const reserved = await deps.preauthorizations.reserveUse({ workspaceId: input.workspaceId, id, now });
      if (!reserved) return refuse("preauthorization", id);
    }
  }
  const result = await transact(deps, input.workspaceId, input.parentOperationId, "rebind", undefined,
    { classification: decision.classification, parentDigest: decision.requiredParentDigest, preauthorizationIds: decision.preauthorizationIds, consumers: decision.consumers },
    (state) => applyRunEvent(state, { kind: "rebind", decision, at: now.toISOString() }, input.view));
  return { decision, applied: true, nextInput: applyOutputs(input.approvedInput, planMixedPartitions(input.approvedInput), outputs), summary: summarizeRun(result.state) };
}

/* -------------------------------- teardown -------------------------------- */

export async function proposeTeardown(deps: MixedRunDeps, input: { workspaceId: string; parentOperationId: string; plan: Omit<TeardownPlanInput, "now"> }): Promise<TeardownReport & { stored: StoredRun }> {
  let report: TeardownReport | undefined;
  const stored = await transact(deps, input.workspaceId, input.parentOperationId, "teardown_planned", undefined, { at: deps.now().toISOString() }, (state) => {
    report = planTeardown(state, { ...input.plan, now: deps.now() });
    return report.state;
  });
  return { ...report!, stored };
}

/** Release one teardown step to the existing destroy path. Needs a verified human admin approval of the destroy operation. */
export async function releaseTeardown(deps: MixedRunDeps, input: { workspaceId: string; parentOperationId: string; childId: string; destroyOperationId: string; signals: OrderingSignals }): Promise<RunSummary> {
  const now = deps.now();
  const current = await deps.runs.get(input.workspaceId, input.parentOperationId);
  if (!current) return refuse("unknown_child", input.parentOperationId);
  const approval = await verifyTeardownApproval(deps.teardownApprovals, current.state, input.childId, input.destroyOperationId, now);
  const stored = await transact(deps, input.workspaceId, input.parentOperationId, "teardown_released", input.childId, { destroyOperationId: input.destroyOperationId, approvalId: approval.approvalId },
    (state) => releaseTeardownStep(state, input.childId, approval, input.signals, now));
  return summarizeRun(stored.state);
}

/**
 * Sync a released step with the destroy operation it was released to. The outcome is read from that
 * operation's own recorded status (succeeded, failed, uncertain), never from the caller, so nobody can
 * claim a step destroyed to unlock the steps behind it. A destroy still queued or running is not an outcome.
 */
export async function syncTeardownStep(deps: MixedRunDeps, input: { workspaceId: string; parentOperationId: string; childId: string }): Promise<RunSummary> {
  const now = deps.now();
  const current = await deps.runs.get(input.workspaceId, input.parentOperationId);
  const step = current?.state.teardown?.steps.find((item) => item.childId === input.childId);
  if (!current || !step || step.status !== "released" || !step.destroyOperationId) return refuse("illegal_transition", input.childId);
  const fact = await deps.teardownApprovals.lookup(input.workspaceId, step.destroyOperationId);
  if (!fact || fact.capability !== "infrastructure.destroy") return refuse("approval_invalid", input.childId);
  const outcome = fact.status === "succeeded" ? "destroyed" : fact.status === "failed" ? "failed" : fact.status === "uncertain" ? "uncertain" : undefined;
  if (!outcome) return refuse("illegal_transition", input.childId);
  const stored = await transact(deps, input.workspaceId, input.parentOperationId, "teardown_result", input.childId, { outcome, destroyOperationId: step.destroyOperationId },
    (state) => recordTeardownResult(state, input.childId, outcome, now));
  return summarizeRun(stored.state);
}
