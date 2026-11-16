/**
 * Failure-injection scenarios for mixed runs (PROD-MIX-07), executed against the REAL orchestration reducer
 * (`applyRunEvent`, `summarizeRun`, `nextRunnable`) and, for the revoked-connection scenario, the real authority
 * re-verification. They simulate what a provider outage or a revoked partition connection does to a run and assert the
 * contract the platform promises:
 *
 *   - nothing is rolled back or destroyed automatically (`atomicity: none`, `automaticCompensation: never`);
 *   - children that finished stay applied and are reported as such;
 *   - dependents of the failed child are blocked with the root cause, never started;
 *   - an indeterminate child (timeout, outage) is reconciled before it can be retried;
 *   - after reconciliation a retry completes the run, and nothing was done twice.
 *
 * CONTRACT LEVEL: this is a simulation over the real state machine, not a provider outage. The live counterpart
 * (`live-recovery.ts`) injects a real fault through the control plane and the fault proxy and is gated and deferred.
 * Reports are plain data; a scenario "passes" only when every assertion it states was checked and true.
 */
import { digest } from "@/lib/controlplane/digest";
import type { ParentPlanView } from "@/lib/execution/mixed-orchestration/child-view";
import { MixedOrchestrationError } from "@/lib/execution/mixed-orchestration/errors";
import { applyRunEvent, createRunState, nextRunnable, summarizeRun, type AnyRunEvent, type MixedRunState } from "@/lib/execution/mixed-orchestration/run";

export interface SimulationWorld {
  view: ParentPlanView;
  /** a freshly created run state (nothing started) */
  state: MixedRunState;
  /** the clock the run state was created at */
  now: Date;
  /** optional: the real authority re-verification for a child, throwing when its connection is not usable */
  authority?: (childId: string, mode: "revoked" | "healthy") => void;
}

export interface Assertion { name: string; pass: boolean; detail?: string }
export interface ScenarioReport {
  id: ScenarioId;
  title: string;
  /** always "simulation": a pass here is never evidence of a live recovery */
  level: "simulation";
  assertions: Assertion[];
  ok: boolean;
  /** what a person does next in a real incident of this kind (the runbook step names) */
  runbook: string[];
}

export const SCENARIO_IDS = ["outage_mid_chain", "revoked_partition_connection", "blackhole_timeout", "expiry_with_partial_apply"] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

/**
 * A world over a plan view whose references are all treated as already materialized. These scenarios test failure
 * handling, not output consumption (MIX-03 owns that and has its own tests), so a consumer is startable once its
 * producers succeeded.
 */
export function simulationWorldOf(view: ParentPlanView, options: { parentOperationId: string; now: Date; expiresInMinutes?: number; childTimeoutMs?: number; authority?: SimulationWorld["authority"] }): SimulationWorld {
  const materialized: ParentPlanView = { ...view, references: view.references.map((reference) => ({ ...reference, materialized: true })) };
  const state = createRunState(materialized, { parentOperationId: options.parentOperationId, expiresAt: new Date(options.now.getTime() + (options.expiresInMinutes ?? 120) * 60_000).toISOString(), childTimeoutMs: options.childTimeoutMs ?? 10 * 60_000, now: options.now });
  return { view: materialized, state, now: options.now, ...(options.authority ? { authority: options.authority } : {}) };
}

const minute = (world: SimulationWorld, n: number): string => new Date(world.now.getTime() + n * 60_000).toISOString();
const receipt = (childId: string): string => digest(`receipt-${childId}`);

function startEvent(world: SimulationWorld, state: MixedRunState, childId: string, n: number): AnyRunEvent {
  return { kind: "start", childId, attemptId: `attempt-${digest(childId).slice(0, 8)}-${n}`, approvedEffectDigest: state.children[childId]!.effectDigest, at: minute(world, n) };
}
function run(world: SimulationWorld, state: MixedRunState, ...events: AnyRunEvent[]): MixedRunState {
  return events.reduce((current, event) => applyRunEvent(current, event, world.view), state);
}
function refusal(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { return e instanceof MixedOrchestrationError ? e.code : "other_error"; }
  return undefined;
}
const check = (assertions: Assertion[], name: string, pass: boolean, detail?: string): void => { assertions.push({ name, pass, ...(detail ? { detail } : {}) }); };

/** Apply every child in order up to (not including) `index`, one minute apart; returns the new state and the next minute. */
function applyBefore(world: SimulationWorld, index: number): { state: MixedRunState; n: number } {
  let state = world.state;
  let n = 1;
  for (const id of world.state.order.slice(0, index)) {
    state = run(world, state, startEvent(world, state, id, n), { kind: "succeed", childId: id, receiptDigest: receipt(id), at: minute(world, n + 1) });
    n += 2;
  }
  return { state, n };
}

export function outageMidChain(world: SimulationWorld): ScenarioReport {
  const a: Assertion[] = [];
  const [producer, middle, consumer] = [world.state.order[0]!, world.state.order[1]!, world.state.order[2]!];
  const before = applyBefore(world, 1);
  let state = run(world, before.state, startEvent(world, before.state, middle, before.n));
  state = run(world, state, { kind: "outage", childId: middle, at: minute(world, before.n + 1) });
  let summary = summarizeRun(state);
  check(a, "the run says it is not atomic and never compensates", summary.atomicity === "none" && summary.automaticCompensation === "never");
  check(a, "the finished producer stays applied and is reported", summary.appliedWithoutRunCompletion.includes(producer));
  check(a, "the child hit by the outage needs reconciliation", state.children[middle]!.reconciliationRequired && state.children[middle]!.effects === "possible");
  check(a, "the dependent is blocked by the root cause, not started", state.children[consumer]!.status === "blocked" && (state.children[consumer]!.blockedBy ?? []).includes(middle));
  check(a, "nothing is runnable while the outage is unresolved", nextRunnable(state, new Date(minute(world, before.n + 2)), world.view).length === 0);
  check(a, "the summary asks for reconciliation before retry", summary.nextSteps.includes("reconcile_before_retry"));
  check(a, "a retry before reconciliation is refused", refusal(() => run(world, state, { kind: "retry", childId: middle, at: minute(world, before.n + 2) })) === "illegal_transition");
  state = run(world, state,
    { kind: "reconciled", childId: middle, outcome: "no_effects", evidenceDigest: digest("provider-readback-no-effects"), at: minute(world, before.n + 3) },
    { kind: "retry", childId: middle, at: minute(world, before.n + 4) });
  check(a, "after reconciliation the retry makes the child runnable again", state.children[middle]!.status === "pending" && nextRunnable(state, new Date(minute(world, before.n + 5)), world.view).includes(middle));
  state = run(world, state, startEvent(world, state, middle, before.n + 5), { kind: "succeed", childId: middle, receiptDigest: receipt(middle), at: minute(world, before.n + 6) });
  state = run(world, state, startEvent(world, state, consumer, before.n + 7), { kind: "succeed", childId: consumer, receiptDigest: receipt(consumer), at: minute(world, before.n + 8) });
  summary = summarizeRun(state);
  check(a, "the run completes with every child applied once", summary.outcome === "complete" && Object.values(state.children).every((c) => c.attempts >= 1) && state.children[producer]!.attempts === 1 && state.children[consumer]!.attempts === 1);
  return { id: "outage_mid_chain", title: "A provider outage hits the middle child of the chain", level: "simulation", assertions: a, ok: a.every((x) => x.pass), runbook: ["confirm-blast-radius", "reconcile-indeterminate-child", "retry-after-reconcile"] };
}

export function revokedPartitionConnection(world: SimulationWorld): ScenarioReport {
  const a: Assertion[] = [];
  const [producer, middle, consumer] = [world.state.order[0]!, world.state.order[1]!, world.state.order[2]!];
  const before = applyBefore(world, 1);
  const state = before.state;
  const refused = world.authority ? refusal(() => world.authority!(middle, "revoked")) : undefined;
  if (!world.authority) check(a, "the real authority re-verification was supplied", false, "no authority check was wired into this simulation");
  else check(a, "a revoked connection makes authority re-verification refuse before the child starts", refused === undefined ? false : true, refused);
  check(a, "the refusal changes nothing: no child was started or recorded", state.children[middle]!.status === "pending" && state.children[middle]!.attempts === 0 && state.children[middle]!.effects === "none");
  const summary = summarizeRun(state);
  check(a, "the finished producer stays applied", summary.completed.some((c) => c.childId === producer));
  check(a, "the untouched dependents are still pending, not failed", state.children[consumer]!.status === "pending" || state.children[consumer]!.status === "blocked");
  const healed = world.authority ? refusal(() => world.authority!(middle, "healthy")) : "no_authority";
  check(a, "with a verified connection (a new plan after re-binding) re-verification passes", healed === undefined);
  check(a, "nothing is rolled back or destroyed because a connection was revoked", summary.automaticCompensation === "never" && summary.atomicity === "none");
  return { id: "revoked_partition_connection", title: "A partition's connection is revoked mid-run", level: "simulation", assertions: a, ok: a.every((x) => x.pass), runbook: ["confirm-blast-radius", "rebind-connection-and-replan", "resume-after-new-approval"] };
}

export function blackholeTimeout(world: SimulationWorld): ScenarioReport {
  const a: Assertion[] = [];
  const middle = world.state.order[1]!;
  const consumer = world.state.order[2]!;
  const before = applyBefore(world, 1);
  let state = run(world, before.state, startEvent(world, before.state, middle, before.n));
  const timeoutAt = before.n + Math.ceil(state.childTimeoutMs / 60_000) + 1;
  state = run(world, state, { kind: "tick", at: minute(world, timeoutAt) });
  check(a, "an unanswered child times out instead of hanging forever", state.children[middle]!.status === "timed_out");
  check(a, "a timeout is indeterminate: effects possible and reconciliation required", state.children[middle]!.effects === "possible" && state.children[middle]!.reconciliationRequired);
  check(a, "its dependents are blocked", state.children[consumer]!.status === "blocked");
  // A late receipt is evidence the child did finish after all; the run accepts it as such.
  state = run(world, state, { kind: "succeed", childId: middle, receiptDigest: receipt(middle), at: minute(world, timeoutAt + 1) });
  check(a, "a late receipt is accepted as evidence and unblocks the run", state.children[middle]!.status === "succeeded" && !state.children[middle]!.reconciliationRequired && state.children[consumer]!.status === "pending");
  check(a, "the timeout was never turned into a rollback", summarizeRun(state).automaticCompensation === "never");
  return { id: "blackhole_timeout", title: "A provider endpoint is blackholed: the child never answers", level: "simulation", assertions: a, ok: a.every((x) => x.pass), runbook: ["confirm-blast-radius", "reconcile-indeterminate-child", "retry-after-reconcile"] };
}

export function expiryWithPartialApply(world: SimulationWorld): ScenarioReport {
  const a: Assertion[] = [];
  const producer = world.state.order[0]!;
  const middle = world.state.order[1]!;
  const before = applyBefore(world, 1);
  const expiry = Date.parse(before.state.expiresAt);
  const late = new Date(expiry + 60_000).toISOString();
  const state = run(world, before.state, { kind: "tick", at: late });
  const summary = summarizeRun(state);
  check(a, "approval expiry stops new starts", state.children[middle]!.status === "expired");
  check(a, "the applied producer is not withdrawn", state.children[producer]!.status === "succeeded" && summary.appliedWithoutRunCompletion.includes(producer));
  check(a, "nothing is runnable after expiry", nextRunnable(state, new Date(late), world.view).length === 0);
  check(a, "the next step is a human-approved teardown proposal or a fresh plan, never an automatic one", summary.nextSteps.includes("propose_teardown_for_human_approval") && summary.automaticCompensation === "never");
  return { id: "expiry_with_partial_apply", title: "The approval expires after one child applied", level: "simulation", assertions: a, ok: a.every((x) => x.pass), runbook: ["confirm-blast-radius", "propose-teardown-for-approval", "replan-and-reapprove"] };
}

export function runAllScenarios(world: SimulationWorld): ScenarioReport[] {
  return [outageMidChain(world), revokedPartitionConnection(world), blackholeTimeout(world), expiryWithPartialApply(world)];
}
