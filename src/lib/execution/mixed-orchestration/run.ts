/**
 * Durable parent-run state machine for a mixed graph of child workflows (PROD-MIX-04).
 *
 * This is NOT a transaction. Children are independent applies against independent
 * clouds; some will succeed while others fail, time out or are cancelled. The state
 * machine therefore records what actually happened per child and never reports
 * `atomic`, never rolls back, and never starts a destructive step by itself. What it
 * does decide, deterministically:
 *
 *  - a child starts only after every producer it depends on SUCCEEDED with a receipt,
 *    only while the run is neither cancelled nor expired, and only for the exact
 *    effect digest that was reviewed (DUR-B: a changed incoming materialization needs
 *    a `rebind`, which needs review or a precise preauthorization);
 *  - failure, timeout, outage, cancellation and expiry never mark a child "clean":
 *    a child that may have reached its provider is `effects: possible` and needs a
 *    recorded reconciliation before it can be retried;
 *  - dependents of anything that did not succeed are `blocked`, with the root causes;
 *  - cancel never claims a running child stopped (`cancel_requested` until the child
 *    reports), and expiry never withdraws in-flight work.
 *
 * Pure: `applyRunEvent(state, event, view?)` returns a new state and throws a
 * `MixedOrchestrationError` for an illegal move. Persistence is `run-store.ts`.
 */
import { z } from "zod";
import { digest } from "@/lib/controlplane/digest";
import { assertParentView, type ParentPlanView } from "./child-view";
import { cmp, ID, refuse, SHA, sortedUnique } from "./errors";
import { orderChildren } from "./order";
import { isIssuedDecision, type OutputConsumptionDecision } from "./decision";

export type ChildStatus = "pending" | "blocked" | "running" | "succeeded" | "failed" | "timed_out" | "outage" | "cancel_requested" | "cancelled" | "expired";
export type EffectKnowledge = "none" | "possible" | "present";

export const RUN_LIMITS = Object.freeze({ minChildTimeoutMs: 60_000, maxChildTimeoutMs: 24 * 60 * 60_000, maxRunMs: 30 * 24 * 60 * 60_000 });

export interface RebindRecord {
  effectDigest: string;
  authority: "unchanged" | "review" | "preauthorization";
  /** Approval id for a review; comma separated preauthorization ids for a preauthorization. */
  authorityRef: string;
  at: string;
}

export interface ChildRunState {
  id: string;
  /** Producers this child needs; copied from the validated plan so a sweeper needs no plan. */
  dependsOn: string[];
  /** Resource addresses and ownership of the child plan, so teardown needs no plan either. */
  nodes: { address: string; ownership: "managed" | "referenced" | "external" }[];
  /** Typed inputs this child consumes; it cannot start until every one is materialized and (re)bound. */
  incoming: { referenceId: string; materialized: boolean }[];
  subplanDigest: string;
  effectDigest: string;
  status: ChildStatus;
  attempts: number;
  attemptId?: string;
  startedAt?: string;
  finishedAt?: string;
  receiptDigest?: string;
  effects: EffectKnowledge;
  /** An indeterminate end (failure with possible effects, timeout, outage, unconfirmed cancel) needs reconciliation before retry or teardown. */
  reconciliationRequired: boolean;
  reason?: string;
  blockedBy?: string[];
  rebinds: RebindRecord[];
}

export type TeardownStepStatus = "planned" | "released" | "destroyed" | "failed" | "uncertain";
export interface TeardownStepState {
  childId: string;
  /** Managed resource addresses of this step, sorted. */
  addresses: string[];
  /** Children that must be destroyed first (their consumers that were applied). */
  after: string[];
  stepDigest: string;
  status: TeardownStepStatus;
  destroyOperationId?: string;
  approvalId?: string;
  releasedAt?: string;
  finishedAt?: string;
}
export interface TeardownState {
  planDigest: string;
  createdAt: string;
  /** Consumers first. */
  steps: TeardownStepState[];
}

export interface MixedRunState {
  version: 1;
  workspaceId: string;
  environmentId: string;
  parentOperationId: string;
  parentDigest: string;
  desiredDigest: string;
  /** Producers first. */
  order: string[];
  expiresAt: string;
  childTimeoutMs: number;
  cancelRequestedAt?: string;
  seq: number;
  children: Record<string, ChildRunState>;
  teardown?: TeardownState;
}

const At = z.string().refine((value) => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value, "iso");
const ChildId = z.string().min(1).max(200);
const Reason = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

export const RunEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start"), childId: ChildId, attemptId: z.string().regex(ID), approvedEffectDigest: z.string().regex(SHA), at: At }).strict(),
  z.object({ kind: z.literal("succeed"), childId: ChildId, receiptDigest: z.string().regex(SHA), at: At }).strict(),
  z.object({ kind: z.literal("fail"), childId: ChildId, reason: Reason, effects: z.enum(["none", "possible"]), at: At }).strict(),
  z.object({ kind: z.literal("outage"), childId: ChildId, at: At }).strict(),
  z.object({ kind: z.literal("tick"), at: At }).strict(),
  z.object({ kind: z.literal("cancel"), at: At }).strict(),
  z.object({ kind: z.literal("cancel_confirmed"), childId: ChildId, effects: z.enum(["none", "possible", "present"]), at: At }).strict(),
  z.object({ kind: z.literal("reconciled"), childId: ChildId, outcome: z.enum(["no_effects", "effects_present"]), evidenceDigest: z.string().regex(SHA), at: At }).strict(),
  z.object({ kind: z.literal("retry"), childId: ChildId, at: At }).strict(),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;

/** A `rebind` is not a plain event: it carries an issued consumption decision and the authority that covers it. */
export interface RebindEvent {
  kind: "rebind";
  decision: OutputConsumptionDecision;
  /** For `review_required`: the human approval id and the parent digest that approval is bound to. */
  review?: { approvalId: string; approvedParentDigest: string };
  at: string;
}
export type AnyRunEvent = RunEvent | RebindEvent;

const TERMINAL_BAD: ReadonlySet<ChildStatus> = new Set(["failed", "timed_out", "outage", "cancelled", "expired", "cancel_requested"]);
const INFLIGHT: ReadonlySet<ChildStatus> = new Set(["running", "cancel_requested"]);

export interface CreateRunInput {
  parentOperationId: string;
  expiresAt: string;
  childTimeoutMs: number;
  now: Date;
}

export function createRunState(view: ParentPlanView, input: CreateRunInput): MixedRunState {
  assertParentView(view);
  if (!ID.test(input.parentOperationId)) refuse("invalid_input");
  if (!Number.isInteger(input.childTimeoutMs) || input.childTimeoutMs < RUN_LIMITS.minChildTimeoutMs || input.childTimeoutMs > RUN_LIMITS.maxChildTimeoutMs) refuse("invalid_input");
  const expires = Date.parse(input.expiresAt);
  if (Number.isNaN(expires) || expires <= input.now.getTime() || expires - input.now.getTime() > RUN_LIMITS.maxRunMs) refuse("invalid_input");
  const ordering = orderChildren(view.children); // refuses a cycle before anything is recorded or started
  const children: Record<string, ChildRunState> = {};
  for (const child of view.children) {
    children[child.id] = { id: child.id, dependsOn: [...child.dependsOn].sort(), nodes: child.nodes.map((node) => ({ address: node.address, ownership: node.ownership })).sort((a, b) => cmp(a.address, b.address)), incoming: view.references.filter((reference) => reference.consumerChildId === child.id).map((reference) => ({ referenceId: reference.id, materialized: reference.materialized })).sort((a, b) => cmp(a.referenceId, b.referenceId)),
      subplanDigest: child.subplanDigest, effectDigest: child.effectDigest, status: "pending", attempts: 0,
      effects: "none", reconciliationRequired: false, rebinds: [] };
  }
  return {
    version: 1, workspaceId: view.workspaceId, environmentId: view.environmentId, parentOperationId: input.parentOperationId,
    parentDigest: view.parentDigest, desiredDigest: view.desiredDigest, order: [...ordering.execution],
    expiresAt: new Date(expires).toISOString(), childTimeoutMs: input.childTimeoutMs, seq: 0, children,
  };
}

function child(state: MixedRunState, id: string): ChildRunState {
  const found = state.children[id];
  if (!found) return refuse("unknown_child", id);
  return found;
}

function assertSameRun(state: MixedRunState, view?: ParentPlanView): void {
  if (!view) return;
  if (state.workspaceId !== view.workspaceId || state.environmentId !== view.environmentId || state.desiredDigest !== view.desiredDigest) refuse("stale_digest");
  const ids = new Set(view.children.map((c) => c.id));
  if (ids.size !== state.order.length || state.order.some((id) => !ids.has(id))) refuse("stale_digest");
  for (const c of view.children) if (state.children[c.id]?.subplanDigest !== c.subplanDigest) refuse("stale_digest", c.id);
}

/** Producers each child needs, as recorded in the run. */
function depsOf(state: MixedRunState, id: string): readonly string[] {
  return state.children[id]?.dependsOn ?? [];
}

/** Pending/blocked children become blocked (with root causes) or pending again. Topological order. */
function recomputeBlocked(state: MixedRunState): void {
  for (const id of state.order) {
    const c = state.children[id];
    if (c.status !== "pending" && c.status !== "blocked") continue;
    const causes: string[] = [];
    for (const dependency of depsOf(state, id)) {
      const upstream = state.children[dependency];
      if (TERMINAL_BAD.has(upstream.status)) causes.push(dependency);
      else if (upstream.status === "blocked") causes.push(...(upstream.blockedBy ?? [dependency]));
    }
    if (causes.length) { c.status = "blocked"; c.blockedBy = sortedUnique(causes); } else { c.status = "pending"; delete c.blockedBy; }
  }
}

function endIndeterminate(c: ChildRunState, status: "timed_out" | "outage" | "failed", reason: string, at: string, effects: EffectKnowledge): void {
  c.status = status; c.reason = reason; c.finishedAt = at;
  // A call may have reached the provider before the end: never record "no effects" without evidence.
  c.effects = effects === "none" ? "none" : c.effects === "present" ? "present" : "possible";
  c.reconciliationRequired = c.effects !== "none";
}

/** `view`, when given, must be the plan the run was created from (digest-checked); the sweeper omits it. */
export function applyRunEvent(state: MixedRunState, raw: AnyRunEvent, view?: ParentPlanView): MixedRunState {
  assertSameRun(state, view);
  const next = structuredClone(state);
  const at = raw.at;
  if (Number.isNaN(Date.parse(at))) refuse("invalid_input");
  const atMs = Date.parse(at);

  if (raw.kind === "rebind") {
    rebind(next, raw);
  } else {
    const parsed = RunEventSchema.safeParse(raw);
    if (!parsed.success) return refuse("invalid_input");
    const event = parsed.data;
    switch (event.kind) {
      case "start": {
        const c = child(next, event.childId);
        if (next.cancelRequestedAt) refuse("run_terminal", event.childId);
        if (atMs >= Date.parse(next.expiresAt)) refuse("run_terminal", event.childId);
        if (c.status !== "pending") refuse("illegal_transition", event.childId);
        const missing = depsOf(state, c.id).filter((d) => next.children[d].status !== "succeeded" || !next.children[d].receiptDigest);
        if (missing.length) refuse("ordering_blocked", ...missing);
        const unmaterialized = c.incoming.filter((input) => !input.materialized).map((input) => `input:${input.referenceId}`);
        if (unmaterialized.length) refuse("ordering_blocked", ...unmaterialized);
        if (event.approvedEffectDigest !== c.effectDigest) refuse("stale_digest", c.id);
        c.status = "running"; c.attempts += 1; c.attemptId = event.attemptId; c.startedAt = event.at;
        delete c.finishedAt; delete c.reason; delete c.receiptDigest;
        // Provider calls may begin at any point after this: the effect is "possible" until a receipt says otherwise.
        c.effects = c.effects === "present" ? "present" : "possible"; c.reconciliationRequired = false;
        break;
      }
      case "succeed": {
        const c = child(next, event.childId);
        // A late receipt after timeout/outage is real evidence the child finished; the receipt is supplied by the verified child history.
        if (!INFLIGHT.has(c.status) && c.status !== "timed_out" && c.status !== "outage") refuse("illegal_transition", c.id);
        c.status = "succeeded"; c.receiptDigest = event.receiptDigest; c.finishedAt = event.at; c.effects = "present"; c.reconciliationRequired = false; delete c.reason;
        break;
      }
      case "fail": {
        const c = child(next, event.childId);
        if (!INFLIGHT.has(c.status)) refuse("illegal_transition", c.id);
        endIndeterminate(c, "failed", event.reason, event.at, event.effects);
        break;
      }
      case "outage": {
        const c = child(next, event.childId);
        if (!INFLIGHT.has(c.status)) refuse("illegal_transition", c.id);
        endIndeterminate(c, "outage", "provider_or_control_plane_outage", event.at, "possible");
        break;
      }
      case "tick": {
        for (const id of next.order) {
          const c = next.children[id];
          if (INFLIGHT.has(c.status) && c.startedAt && atMs >= Date.parse(c.startedAt) + next.childTimeoutMs) endIndeterminate(c, "timed_out", "child_timeout", event.at, "possible");
        }
        if (atMs >= Date.parse(next.expiresAt)) {
          // Expiry stops NEW starts. In-flight children are not withdrawn and are never reported stopped.
          for (const id of next.order) {
            const c = next.children[id];
            if (c.status === "pending" || c.status === "blocked") { c.status = "expired"; c.reason = "approval_expired"; c.finishedAt = event.at; delete c.blockedBy; }
          }
        }
        break;
      }
      case "cancel": {
        if (!next.cancelRequestedAt) next.cancelRequestedAt = event.at;
        for (const id of next.order) {
          const c = next.children[id];
          if (c.status === "pending" || c.status === "blocked") { c.status = "cancelled"; c.reason = "cancelled_before_start"; c.finishedAt = event.at; delete c.blockedBy; }
          else if (c.status === "running") c.status = "cancel_requested";
        }
        break;
      }
      case "cancel_confirmed": {
        const c = child(next, event.childId);
        if (c.status !== "cancel_requested") refuse("illegal_transition", c.id);
        c.status = "cancelled"; c.reason = "cancelled_while_running"; c.finishedAt = event.at;
        c.effects = event.effects === "none" ? "none" : event.effects; c.reconciliationRequired = event.effects === "possible";
        break;
      }
      case "reconciled": {
        const c = child(next, event.childId);
        if (!c.reconciliationRequired) refuse("illegal_transition", c.id);
        c.effects = event.outcome === "no_effects" ? "none" : "present"; c.reconciliationRequired = false;
        break;
      }
      case "retry": {
        const c = child(next, event.childId);
        if (next.cancelRequestedAt) refuse("run_terminal", c.id);
        if (atMs >= Date.parse(next.expiresAt)) refuse("run_terminal", c.id);
        if ((c.status !== "failed" && c.status !== "timed_out" && c.status !== "outage") || c.reconciliationRequired) refuse("illegal_transition", c.id);
        c.status = "pending"; delete c.reason; delete c.finishedAt;
        break;
      }
    }
  }
  recomputeBlocked(next);
  next.seq += 1;
  return next;
}

function rebind(next: MixedRunState, event: RebindEvent): void {
  if (!isIssuedDecision(event.decision)) refuse("preauthorization");
  const decision = event.decision;
  if (next.cancelRequestedAt) refuse("run_terminal");
  if (decision.workspaceId !== next.workspaceId || decision.environmentId !== next.environmentId || decision.desiredDigest !== next.desiredDigest) refuse("stale_digest");
  let authority: RebindRecord["authority"];
  let authorityRef: string;
  if (decision.classification === "unchanged") { authority = "unchanged"; authorityRef = decision.requiredParentDigest; }
  else if (decision.classification === "preauthorized") { authority = "preauthorization"; authorityRef = decision.preauthorizationIds.join(","); }
  else {
    const review = event.review;
    // A person's approval of the EXACT new parent digest (DUR-B): any other digest is a different effect.
    if (!review || !ID.test(review.approvalId) || review.approvedParentDigest !== decision.requiredParentDigest) return refuse("stale_digest");
    authority = "review"; authorityRef = review.approvalId;
  }
  for (const consumer of decision.consumers) {
    const c = child(next, consumer.childId);
    if (c.status !== "pending" && c.status !== "blocked") refuse("illegal_transition", c.id);
    if (c.effectDigest !== consumer.previousEffectDigest) refuse("stale_digest", c.id);
    c.effectDigest = consumer.newEffectDigest;
    for (const input of c.incoming) if (consumer.referenceIds.includes(input.referenceId)) input.materialized = true;
    c.rebinds.push({ effectDigest: consumer.newEffectDigest, authority, authorityRef, at: event.at });
  }
  next.parentDigest = decision.requiredParentDigest;
}

/** Children that may start now: all producers succeeded, run live. Never includes blocked children. */
export function nextRunnable(state: MixedRunState, now: Date, view?: ParentPlanView): string[] {
  assertSameRun(state, view);
  if (state.cancelRequestedAt || now.getTime() >= Date.parse(state.expiresAt)) return [];
  return state.order.filter((id) => {
    const c = state.children[id];
    return c.status === "pending" && depsOf(state, id).every((d) => state.children[d].status === "succeeded" && !!state.children[d].receiptDigest);
  });
}

export type RunOutcome = "complete" | "in_progress" | "partial" | "indeterminate" | "nothing_applied";
export type NextStep = "review_replan" | "reconcile_before_retry" | "retry_after_reconcile" | "propose_teardown_for_human_approval" | "wait_for_in_flight_children" | "none";

export interface RunSummary {
  /** Constant. A mixed apply is never one transaction. */
  readonly atomicity: "none";
  /** Constant. No child is ever rolled back or destroyed automatically. */
  readonly automaticCompensation: "never";
  readonly outcome: RunOutcome;
  readonly cancelled: boolean;
  readonly expired: boolean;
  readonly completed: readonly { childId: string; receiptDigest: string }[];
  readonly failed: readonly { childId: string; status: ChildStatus; reason?: string }[];
  readonly indeterminate: readonly string[];
  readonly inFlight: readonly string[];
  readonly blocked: readonly { childId: string; blockedBy: readonly string[] }[];
  readonly notStarted: readonly string[];
  /** Succeeded children that remain applied although the run did not complete. Only a person-approved teardown can change this. */
  readonly appliedWithoutRunCompletion: readonly string[];
  readonly nextSteps: readonly NextStep[];
  readonly stateDigest: string;
}

export function summarizeRun(state: MixedRunState): RunSummary {
  const all = state.order.map((id) => state.children[id]);
  const succeeded = all.filter((c) => c.status === "succeeded");
  const inFlight = all.filter((c) => INFLIGHT.has(c.status));
  const open = all.filter((c) => c.status === "pending");
  const indeterminate = all.filter((c) => c.reconciliationRequired);
  const failed = all.filter((c) => c.status === "failed" || c.status === "timed_out" || c.status === "outage" || c.status === "cancelled" || c.status === "expired");
  const anyEffects = all.some((c) => c.effects !== "none");
  const complete = succeeded.length === all.length;
  const hasBadEnd = failed.length > 0;
  let outcome: RunOutcome;
  if (complete) outcome = "complete";
  else if (inFlight.length || (open.length && !hasBadEnd && !state.cancelRequestedAt)) outcome = "in_progress";
  else if (succeeded.length) outcome = "partial";
  else if (anyEffects || indeterminate.length) outcome = "indeterminate";
  else outcome = "nothing_applied";
  const steps: NextStep[] = [];
  if (inFlight.length) steps.push("wait_for_in_flight_children");
  if (indeterminate.length) steps.push("reconcile_before_retry");
  if (failed.some((c) => !c.reconciliationRequired && (c.status === "failed" || c.status === "timed_out" || c.status === "outage")) && !state.cancelRequestedAt) steps.push("retry_after_reconcile");
  if (hasBadEnd || all.some((c) => c.status === "blocked")) steps.push("review_replan");
  if (!complete && succeeded.some((c) => c.effects !== "none")) steps.push("propose_teardown_for_human_approval");
  if (!steps.length) steps.push("none");
  const stable = { ...state, seq: undefined };
  return Object.freeze({
    atomicity: "none" as const, automaticCompensation: "never" as const, outcome,
    cancelled: !!state.cancelRequestedAt, expired: all.some((c) => c.status === "expired"),
    completed: succeeded.map((c) => ({ childId: c.id, receiptDigest: c.receiptDigest! })),
    failed: failed.map((c) => ({ childId: c.id, status: c.status, ...(c.reason ? { reason: c.reason } : {}) })),
    indeterminate: indeterminate.map((c) => c.id), inFlight: inFlight.map((c) => c.id),
    blocked: all.filter((c) => c.status === "blocked").map((c) => ({ childId: c.id, blockedBy: c.blockedBy ?? [] })),
    notStarted: open.map((c) => c.id),
    appliedWithoutRunCompletion: complete ? [] : succeeded.filter((c) => c.effects !== "none").map((c) => c.id),
    nextSteps: sortedUnique(steps) as NextStep[], stateDigest: digest(stable),
  });
}

/** Earliest instant at which `tick` would change this run (child timeout or approval expiry), or null. */
export function nextDeadline(state: MixedRunState): string | null {
  const times: number[] = [];
  const all = Object.values(state.children);
  for (const c of all) if (INFLIGHT.has(c.status) && c.startedAt) times.push(Date.parse(c.startedAt) + state.childTimeoutMs);
  if (all.some((c) => c.status === "pending" || c.status === "blocked")) times.push(Date.parse(state.expiresAt));
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

/** True while some child can still change state (started, waiting or blocked); false once every child is terminal. */
export function isRunOpen(state: MixedRunState): boolean {
  return Object.values(state.children).some((c) => c.status === "pending" || c.status === "blocked" || INFLIGHT.has(c.status));
}

export function isRunSettled(state: MixedRunState): boolean {
  return !Object.values(state.children).some((c) => INFLIGHT.has(c.status));
}

