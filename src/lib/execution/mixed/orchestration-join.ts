/**
 * The join between the partition executor (PROD-MIX-01/02: the parent workflow and its activities) and the mixed run
 * service (PROD-MIX-03/04: typed outputs, ordering, failure and teardown state). Assembled at wave 4.
 *
 * What it guarantees, in guard order. A child acts only through the MIX-01/02 chain (parent operation running, exact
 * human-approved child set, durable start intent; semantics re-verified against the approved subplan; the child's own
 * authority, semantics, custody and effect-ledger guards inside its workflow). This module adds the run record on top
 * and never replaces any of those checks:
 *
 *  - the run is opened once per parent operation, with the parent approval's expiry as its deadline;
 *  - a `start` run event is recorded immediately BEFORE the child's broker claim (ordering rules, producers succeeded,
 *    reviewed effect digest), so a refused ordering leaves the child unclaimed;
 *  - every child transition the parent observes (succeeded, failed, uncertain, cancelled) is recorded as a run event,
 *    idempotently, so a retried or resumed activity converges on the same run state;
 *  - a consumer starts only after its incoming references are materialized by `consumeOutputs`. A changed parent digest
 *    is NOT silently rebound: it opens a review operation that binds the exact new parent digest and the original child
 *    set, and the consumer waits for a person's approval of exactly that digest (or a precise preauthorization).
 *
 * Nothing here compensates, rolls back or destroys. Values never pass through here, only digests and vault references.
 */
import { digest } from "@/lib/controlplane/digest";
import * as plans from "@/lib/controlplane/db/repos/mixed-parent-plans";
import type { Sql } from "@/lib/controlplane/types";
import {
  assertParentView, cancelMixedRun, consumeOutputs, MixedOrchestrationError, NO_SIGNALS, openMixedRun, readMixedRun, recordChildEvent, tickMixedRun, validateOutput,
  type MixedRunDeps, type MixedRunState, type OutputConsumptionDecision, type ParentPlanView, type ReferenceView,
} from "../mixed-orchestration";
import { applyOutputs } from "../mixed-orchestration/outputs";
import { planMixedPartitions } from "../mixed-partitions";
import { plannerInputOf, type ChildLauncher } from "./service";
import { MixedPlanError, type ChildReceipt, type ChildState, type MixedParentPlan, type MixedParentReviewInput } from "./types";
import { ProducerOutputError } from "./output-reader";
import type { MixedWorld } from "./world";

/** Longest the run lets one child run before it records a timeout: the run limit, just under the workflow's own wait cap. */
export const RUN_CHILD_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** Opens the human review of a changed parent digest. The production opener proposes through the capability broker. */
export interface ParentReviewOpener {
  open(input: { workspaceId: string; parentOperationId: string; review: MixedParentReviewInput }): Promise<{ operationId: string }>;
}

export interface JoinDeps {
  sql: Sql;
  world: MixedWorld;
  /** Run service dependencies (store, preauthorizations, teardown approvals, parent review verification). */
  run: MixedRunDeps;
  /** Absent means a review can never be opened: a consumer whose digest changes stays blocked, it is never rebound. */
  reviews?: ParentReviewOpener;
  now?: () => Date;
}

const nowOf = (deps: JoinDeps): Date => (deps.now ?? (() => new Date()))();
const atOf = (deps: JoinDeps): string => nowOf(deps).toISOString();

/** The reference inventory and child graph as the run service sees them, derived from the stored plan alone. */
export function parentViewOfPlan(plan: MixedParentPlan): ParentPlanView {
  const references: ReferenceView[] = plan.references.map((ref) => {
    if (!ref.producerAddress || !ref.producerOutput || !ref.consumerAddress || !ref.consumerInput || !ref.valueType) {
      throw new MixedPlanError("plan_refused", "This plan stored a reference without its declared contract; plan again before running it.", { referenceId: ref.referenceId });
    }
    return {
      id: ref.referenceId, producerChildId: ref.producerPartitionId, consumerChildId: ref.consumerPartitionId, producerAddress: ref.producerAddress, producerOutput: ref.producerOutput,
      consumerAddress: ref.consumerAddress, consumerInput: ref.consumerInput, type: ref.valueType, contractDigest: ref.contractDigest, materialized: ref.state === "available",
    };
  });
  const view: ParentPlanView = {
    workspaceId: plan.workspaceId, environmentId: plan.parentEnvironmentId, desiredDigest: plan.desiredDigest, parentDigest: plan.parentDigest,
    children: [...plan.children].sort((a, b) => (a.partitionId < b.partitionId ? -1 : a.partitionId > b.partitionId ? 1 : 0)).map((child) => ({
      id: child.partitionId, connectionId: child.authority.connectionId, provider: child.authority.provider, subplanDigest: child.subplanDigest, effectDigest: child.effectDigest,
      dependsOn: [...child.dependsOn], nodes: child.nodes.map((node) => ({ address: node.address, ownership: node.ownership, kind: node.kind })),
    })),
    references: references.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
  try { assertParentView(view); } catch (error) {
    if (error instanceof MixedOrchestrationError) throw new MixedPlanError("plan_refused", `The stored plan is not a valid run: ${error.code}.`);
    throw error;
  }
  return view;
}

/** Open the run for this parent operation (once). Its deadline is the parent approval's own expiry. */
export async function openRunForParent(deps: JoinDeps, input: { workspaceId: string; parentOperationId: string; plan: MixedParentPlan }): Promise<MixedRunState> {
  const existing = await readMixedRun(deps.run, input.workspaceId, input.parentOperationId);
  if (existing) return existing.state;
  const expiresAt = await plans.readParentApprovalExpiry(deps.sql, input.workspaceId, input.parentOperationId);
  if (!expiresAt || Date.parse(expiresAt) <= nowOf(deps).getTime()) {
    throw new MixedPlanError("approval_mismatch", "The parent approval has expired, so no child can start under it; approve a new plan.");
  }
  try {
    await openMixedRun(deps.run, { workspaceId: input.workspaceId, parentOperationId: input.parentOperationId, view: parentViewOfPlan(input.plan), expiresAt, childTimeoutMs: RUN_CHILD_TIMEOUT_MS });
  } catch (error) {
    // A concurrent opener (a retried activity) won the create: the run it made is the run.
    if (!(error instanceof MixedOrchestrationError && error.code === "conflict")) throw error;
  }
  const opened = await readMixedRun(deps.run, input.workspaceId, input.parentOperationId);
  if (!opened) throw new MixedPlanError("invalid_state", "The mixed run could not be opened.");
  return opened.state;
}

const effectApprovedFor = (state: MixedRunState, partitionId: string, planEffectDigest: string): string => {
  const rebinds = state.children[partitionId]?.rebinds ?? [];
  return rebinds.length ? rebinds[rebinds.length - 1].effectDigest : planEffectDigest;
};

/**
 * Drift (OBS-01 / reconcile) and migration (LIFE-10) observations for the ordering rules, read from the platform for this
 * plan's children. Without a signal source in the world (a contract test with fakes) the rules see none.
 */
export async function signalsFor(deps: JoinDeps, plan: MixedParentPlan) {
  if (!deps.world.orderingSignals) return NO_SIGNALS;
  const rows = await plans.listChildren(deps.sql, plan.workspaceId, plan.parentPlanId);
  const operationOf = new Map(rows.map((row) => [row.partitionId, row.childOperationId]));
  const observed = await deps.world.orderingSignals(plan.workspaceId, plan.children.map((child) => {
    const childOperationId = operationOf.get(child.partitionId);
    return { partitionId: child.partitionId, childEnvironmentId: child.childEnvironmentId, ...(childOperationId ? { childOperationId } : {}) };
  }));
  return { drift: [...observed.drift], migrationChildIds: [...observed.migrationChildIds], contractMigrationChildIds: [...(observed.contractMigrationChildIds ?? [])] };
}

/**
 * Record the `start` run event for a child about to be claimed. Idempotent: a child the run already shows in flight or
 * finished (a retried claim or start) records nothing. A refusal (ordering, expiry, cancellation, stale digest) throws
 * BEFORE the broker claim, so nothing was started.
 */
export async function recordChildStart(deps: JoinDeps, input: { workspaceId: string; parentOperationId: string; plan: MixedParentPlan; partitionId: string; healing?: boolean }): Promise<void> {
  const run = await readMixedRun(deps.run, input.workspaceId, input.parentOperationId);
  if (!run) throw new MixedPlanError("invalid_state", "The mixed run has not been opened for this parent operation.");
  const current = run.state.children[input.partitionId];
  if (!current) throw new MixedPlanError("not_found", "The partition is not part of the run.");
  // A retried claim or start of a child the run already shows running, cancelling or succeeded records nothing twice; any other state is a refusal.
  if (current.status === "running" || current.status === "cancel_requested" || current.status === "succeeded") return;
  if (current.status !== "pending") throw new MixedOrchestrationError("illegal_transition", [input.partitionId]);
  const planChild = input.plan.children.find((child) => child.partitionId === input.partitionId);
  if (!planChild) throw new MixedPlanError("not_found", "The partition is not part of this plan.");
  await recordChildEvent(deps.run, {
    workspaceId: input.workspaceId, parentOperationId: input.parentOperationId, view: parentViewOfPlan(input.plan),
    signals: input.healing ? NO_SIGNALS : await signalsFor(deps, input.plan),
    event: {
      kind: "start", childId: input.partitionId, attemptId: `att_${digest({ parentOperationId: input.parentOperationId, partitionId: input.partitionId, attempt: current.attempts + 1 }).slice(0, 32)}`,
      approvedEffectDigest: effectApprovedFor(run.state, input.partitionId, planChild.effectDigest), at: atOf(deps),
    },
  });
}

/** The real launcher, wrapped so the run records the start right before the child is claimed or (re)started. */
export function joinedLauncher(deps: JoinDeps, base: ChildLauncher, context: { workspaceId: string; parentOperationId: string; plan: MixedParentPlan }): ChildLauncher {
  const partitionOf = async (operationId: string): Promise<string> => {
    const row = (await plans.listChildren(deps.sql, context.workspaceId, context.plan.parentPlanId)).find((candidate) => candidate.childOperationId === operationId);
    if (!row) throw new MixedPlanError("child_mismatch", "The operation is not an adopted child of this plan.");
    return row.partitionId;
  };
  const record = async (operationId: string): Promise<void> => recordChildStart(deps, { ...context, partitionId: await partitionOf(operationId) });
  return {
    async claim(workspaceId, operationId) { await record(operationId); return base.claim(workspaceId, operationId); },
    async start(input) { await record(input.operationId); return base.start(input); },
  };
}

const IN_FLIGHT = new Set(["running", "cancel_requested", "timed_out", "outage"]);

/**
 * Bring the run in line with one child's durable outcome. Idempotent and safe to call from every observation: the run
 * records exactly one end event per attempt, a late success after a timeout is accepted as evidence, and a child the run
 * never saw start (a run opened late) is healed through a start event first.
 */
export async function syncChildOutcome(deps: JoinDeps, input: { workspaceId: string; parentOperationId: string; plan: MixedParentPlan; partitionId: string; state: ChildState; receipt?: ChildReceipt }): Promise<void> {
  if (input.state !== "succeeded" && input.state !== "failed" && input.state !== "uncertain" && input.state !== "cancelled") return;
  let run = await readMixedRun(deps.run, input.workspaceId, input.parentOperationId);
  if (!run) throw new MixedPlanError("invalid_state", "The mixed run has not been opened for this parent operation.");
  let current = run.state.children[input.partitionId];
  if (!current) throw new MixedPlanError("not_found", "The partition is not part of the run.");
  const settled = input.state === "succeeded" ? "succeeded" : input.state === "cancelled" ? "cancelled" : "failed";
  if (current.status === settled || (settled === "failed" && ["failed", "timed_out", "outage"].includes(current.status) && input.state !== "succeeded")) return;
  if (current.status === "pending") {
    await recordChildStart(deps, { workspaceId: input.workspaceId, parentOperationId: input.parentOperationId, plan: input.plan, partitionId: input.partitionId, healing: true });
    run = await readMixedRun(deps.run, input.workspaceId, input.parentOperationId);
    current = run!.state.children[input.partitionId];
  }
  if (!IN_FLIGHT.has(current.status)) return;
  const at = atOf(deps);
  const view = parentViewOfPlan(input.plan);
  if (input.state === "succeeded") {
    if (!input.receipt) throw new MixedPlanError("child_mismatch", "A succeeded child needs its recorded receipt.");
    await recordChildEvent(deps.run, { workspaceId: input.workspaceId, parentOperationId: input.parentOperationId, view, event: { kind: "succeed", childId: input.partitionId, receiptDigest: input.receipt.receiptDigest, at } });
    return;
  }
  if (input.state === "cancelled" && current.status === "cancel_requested") {
    await recordChildEvent(deps.run, { workspaceId: input.workspaceId, parentOperationId: input.parentOperationId, view, event: { kind: "cancel_confirmed", childId: input.partitionId, effects: "possible", at } });
    return;
  }
  if (current.status === "timed_out" || current.status === "outage") return;
  const reason = input.state === "uncertain" ? "child_uncertain" : input.state === "cancelled" ? "child_cancelled" : "child_failed";
  // The child may have reached its provider before it ended: effects stay "possible" until a reconciliation says otherwise.
  await recordChildEvent(deps.run, { workspaceId: input.workspaceId, parentOperationId: input.parentOperationId, view, event: { kind: "fail", childId: input.partitionId, reason, effects: "possible", at } });
}

/** Sync every child whose durable row is terminal but whose run record is not (a crash between observe and record). */
export async function syncAllChildren(deps: JoinDeps, input: { workspaceId: string; parentOperationId: string; plan: MixedParentPlan }): Promise<void> {
  const rows = await plans.listChildren(deps.sql, input.workspaceId, input.plan.parentPlanId);
  for (const row of rows) {
    if (!["succeeded", "failed", "uncertain", "cancelled"].includes(row.state)) continue;
    const receipt = await plans.getReceipt(deps.sql, input.workspaceId, input.plan.parentPlanId, row.partitionId);
    await syncChildOutcome(deps, { ...input, partitionId: row.partitionId, state: row.state, ...(receipt ? { receipt } : {}) });
  }
}

/** Time-driven progress (child timeouts, approval expiry) for the run; returns the run status of one child. */
export async function tickRun(deps: JoinDeps, input: { workspaceId: string; parentOperationId: string; partitionId: string }): Promise<string | undefined> {
  await tickMixedRun({ runs: deps.run.runs, now: deps.run.now }, input.workspaceId, input.parentOperationId);
  return (await readMixedRun(deps.run, input.workspaceId, input.parentOperationId))?.state.children[input.partitionId]?.status;
}

/** Cancel the run when the parent is cancelled. A missing run (never opened) is not an error. */
export async function cancelRunForParent(deps: JoinDeps, input: { workspaceId: string; parentOperationId: string }): Promise<void> {
  await cancelMixedRun({ runs: deps.run.runs, now: deps.run.now }, input.workspaceId, input.parentOperationId);
}

export type MaterializeResult =
  | { state: "ready" }
  | { state: "waiting"; reviewOperationId: string }
  | { state: "blocked"; reason: "outputs_unavailable" | "review_pending" | "approval_changed" };

async function producerOutputs(deps: JoinDeps, input: { workspaceId: string; plan: MixedParentPlan; references: readonly ReferenceView[]; state: MixedRunState }): Promise<unknown[]> {
  const source = deps.world.childTypedOutputs;
  if (!source) return [];
  const rows = await plans.listChildren(deps.sql, input.workspaceId, input.plan.parentPlanId);
  const out: unknown[] = [];
  const byProducer = new Map<string, ReferenceView[]>();
  for (const reference of input.references) byProducer.set(reference.producerChildId, [...(byProducer.get(reference.producerChildId) ?? []), reference]);
  for (const [producerId, refs] of byProducer) {
    const row = rows.find((candidate) => candidate.partitionId === producerId);
    const receipt = await plans.getReceipt(deps.sql, input.workspaceId, input.plan.parentPlanId, producerId);
    if (!row?.childOperationId || !receipt || receipt.outcome !== "succeeded") throw new MixedPlanError("child_mismatch", "A producer has no succeeded receipt to take outputs from.");
    const effectDigest = input.state.children[producerId]?.effectDigest;
    if (!effectDigest) throw new MixedPlanError("child_mismatch", "A producer has no effect digest in the run.");
    out.push(...(await source.call(deps.world, input.workspaceId, { partitionId: producerId, childOperationId: row.childOperationId, receiptDigest: receipt.receiptDigest, receipt, plan: input.plan, effectDigest },
      refs.map((ref) => ({ referenceId: ref.id, consumerChildId: ref.consumerChildId, producerAddress: ref.producerAddress, producerOutput: ref.producerOutput })))));
  }
  return out;
}

/**
 * Materialize a consumer's incoming references before it may start. A changed parent digest never rebinds on its own:
 * the decision is `unchanged`, covered by a live precise preauthorization, or it opens (once per digest) a review
 * operation and the consumer waits for a person's approval of exactly that digest.
 */
export async function materializeIncoming(deps: JoinDeps, input: { workspaceId: string; parentOperationId: string; plan: MixedParentPlan; partitionId: string }): Promise<MaterializeResult> {
  const run = await readMixedRun(deps.run, input.workspaceId, input.parentOperationId);
  if (!run) throw new MixedPlanError("invalid_state", "The mixed run has not been opened for this parent operation.");
  const child = run.state.children[input.partitionId];
  if (!child || child.status !== "pending" || child.incoming.every((entry) => entry.materialized)) return { state: "ready" };
  const view = parentViewOfPlan(input.plan);
  const missing = new Set(child.incoming.filter((entry) => !entry.materialized).map((entry) => entry.referenceId));
  if (!deps.world.childTypedOutputs) return { state: "blocked", reason: "outputs_unavailable" };
  // Every producer of this consumer succeeded in the run before its outputs are read; anything else is not read at all.
  const producers = view.references.filter((reference) => missing.has(reference.id)).map((reference) => reference.producerChildId);
  if (producers.some((producerId) => run.state.children[producerId]?.status !== "succeeded")) return { state: "ready" };

  const newRefs = view.references.filter((reference) => missing.has(reference.id));
  // The producer's outputs are read back through its own partition (output-reader.ts). Unreadable outputs end the consumer's
  // start as blocked with a fixed reason; nothing starts on a guess and nothing partial is applied.
  let newOutputs: unknown[];
  try {
    newOutputs = await producerOutputs(deps, { workspaceId: input.workspaceId, plan: input.plan, references: newRefs, state: run.state });
  } catch (error) {
    if (error instanceof ProducerOutputError) return { state: "blocked", reason: "outputs_unavailable" };
    throw error;
  }
  // The reviewed planner input includes outputs that earlier consumers already took (their effect digests moved with review or preauthorization).
  const prior = view.references.filter((reference) => !missing.has(reference.id) && run.state.children[reference.consumerChildId]?.incoming.find((entry) => entry.referenceId === reference.id)?.materialized && !reference.materialized);
  const base = await plannerInputOf({ world: deps.world }, input.plan);
  let approvedInput = base;
  if (prior.length) {
    let earlier: unknown[];
    try { earlier = await producerOutputs(deps, { workspaceId: input.workspaceId, plan: input.plan, references: prior, state: run.state }); } catch (error) {
      if (error instanceof ProducerOutputError) return { state: "blocked", reason: "outputs_unavailable" };
      throw error;
    }
    const validated = earlier.map((raw) => validateOutput(raw, run.state, view));
    approvedInput = applyOutputs(base, planMixedPartitions(base), validated);
  }
  if (planMixedPartitions(approvedInput).parentDigest !== run.state.parentDigest) throw new MixedOrchestrationError("stale_digest", [child.id]);

  const preauthorizationIds = (await deps.run.preauthorizations.list(input.workspaceId, { parentOperationId: input.parentOperationId, activeOnly: true, now: nowOf(deps), limit: 100 })).map((grant) => grant.id);
  const consume = (review?: { approvalId: string }) => consumeOutputs(deps.run, {
    workspaceId: input.workspaceId, parentOperationId: input.parentOperationId, view, approvedInput, outputs: newOutputs, preauthorizationIds, ...(review ? { review } : {}),
  });
  let result = await consume();
  if (result.applied) return { state: "ready" };
  const decision = result.decision;
  const existing = await plans.findReviewOperation(deps.sql, input.workspaceId, input.parentOperationId, decision.requiredParentDigest);
  if (existing) {
    if (["rejected", "denied", "cancelled", "expired", "failed"].includes(existing.status)) return { state: "blocked", reason: "approval_changed" };
    const approvalId = await plans.findReviewApprovalId(deps.sql, input.workspaceId, existing.operationId);
    if (approvalId) {
      result = await consume({ approvalId });
      if (result.applied) return { state: "ready" };
    }
    return { state: "waiting", reviewOperationId: existing.operationId };
  }
  if (!deps.reviews) return { state: "blocked", reason: "review_pending" };
  const opened = await deps.reviews.open({ workspaceId: input.workspaceId, parentOperationId: input.parentOperationId, review: reviewInputOf(input.plan, input.parentOperationId, run.state.parentDigest, decision) });
  return { state: "waiting", reviewOperationId: opened.operationId };
}

/** The immutable input a person approves: exactly the new parent digest, the original child set and what moved. */
export function reviewInputOf(plan: MixedParentPlan, parentOperationId: string, previousParentDigest: string, decision: OutputConsumptionDecision): MixedParentReviewInput {
  return {
    mixedParentReviewOf: parentOperationId, parentPlanId: plan.parentPlanId, previousParentDigest, requiredParentDigest: decision.requiredParentDigest, childSetDigest: plan.childSetDigest,
    consumers: decision.consumers.map((consumer) => ({ childId: consumer.childId, previousEffectDigest: consumer.previousEffectDigest, newEffectDigest: consumer.newEffectDigest, referenceIds: [...consumer.referenceIds] })),
  };
}

/** True while a review operation of this run is open and nobody has approved it: the parent keeps waiting instead of re-advancing in a loop. */
export async function reviewStillPending(deps: JoinDeps, input: { workspaceId: string; parentOperationId: string; partitionId: string }): Promise<boolean> {
  const run = await readMixedRun(deps.run, input.workspaceId, input.parentOperationId);
  const child = run?.state.children[input.partitionId];
  if (!child || child.status !== "pending" || child.incoming.every((entry) => entry.materialized)) return false;
  const open = await plans.findOpenReviewOperation(deps.sql, input.workspaceId, input.parentOperationId);
  if (!open) return false;
  return (await plans.findReviewApprovalId(deps.sql, input.workspaceId, open.operationId)) === null;
}
