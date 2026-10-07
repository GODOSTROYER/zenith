/**
 * Teardown of a partially or fully applied mixed run (PROD-MIX-04: "teardown order", "no
 * destructive automatic compensation").
 *
 * Nothing here destroys anything. `planTeardown` writes a PROPOSAL into the run: one step per
 * applied child, consumers first (reverse dependency order). Each step is released only by
 * `releaseTeardownStep`, which needs a verified HUMAN destructive approval of an
 * `infrastructure.destroy` operation (the existing destroy path: reviewed plan, admin role,
 * browser approval) whose reviewed destroy list matches this step, and which re-evaluates the
 * ordering rules at release time. Only one step is released at a time, and a step whose consumers
 * are not confirmed destroyed (failed or uncertain count as not destroyed) can never be released.
 *
 * Ownership: only addresses with `managed` ownership in the child plan are ever listed; referenced
 * and external nodes are retained and reported. Every managed address must be recorded as created
 * by THIS parent operation and child by the ownership lookup, and no resource outside the run may
 * depend on it; otherwise planning is refused.
 */
import { digest } from "@/lib/controlplane/digest";
import type { BrokerDeps } from "@/lib/capabilities/ports";
import { cmp, refuse, sortedUnique } from "./errors";
import { downstreamOf } from "./order";
import { evaluateOrdering, type OrderingSignals } from "./ordering-rules";
import type { MixedRunState, TeardownStepState } from "./run";

export interface ResourceOwner { parentOperationId: string; childId: string }

export interface TeardownPlanInput {
  /** Pre-resolved ownership of each managed address (the service reads the ownership registry/receipts). */
  owners: ReadonlyMap<string, ResourceOwner | null>;
  /** Resources outside this run that depend on an address (from live state). Any entry refuses planning. */
  externalDependents: (address: string) => readonly string[];
  now: Date;
}

export interface TeardownReport {
  readonly state: MixedRunState;
  /** Addresses never proposed for destruction because the plan does not manage them. */
  readonly retained: readonly { childId: string; address: string; ownership: string }[];
  /** Applied children with no managed address (nothing to destroy). */
  readonly nothingToDestroy: readonly string[];
}

const INFLIGHT = new Set(["running", "cancel_requested"]);

export function planTeardown(state: MixedRunState, input: TeardownPlanInput): TeardownReport {
  if (Object.values(state.children).some((child) => INFLIGHT.has(child.status))) refuse("ordering_blocked", "children_in_flight");
  const unreconciled = Object.values(state.children).filter((child) => child.reconciliationRequired).map((child) => child.id);
  if (unreconciled.length) refuse("ordering_blocked", ...unreconciled.sort(cmp));
  if (state.teardown && state.teardown.steps.some((step) => step.status !== "planned")) refuse("conflict", "teardown_in_progress");

  const applied = [...state.order].reverse().filter((id) => state.children[id].effects !== "none");
  const retained: { childId: string; address: string; ownership: string }[] = [];
  const nothing: string[] = [];
  const graph = Object.values(state.children).map((child) => ({ id: child.id, dependsOn: child.dependsOn }));
  const steps: TeardownStepState[] = [];
  for (const id of applied) {
    const addresses: string[] = [];
    for (const node of state.children[id].nodes) {
      if (node.ownership !== "managed") { retained.push({ childId: id, address: node.address, ownership: node.ownership }); continue; }
      const owner = input.owners.get(node.address);
      if (!owner || owner.parentOperationId !== state.parentOperationId || owner.childId !== id) refuse("ownership", node.address);
      const outside = input.externalDependents(node.address);
      if (outside.length) refuse("teardown_refused", node.address, ...[...outside].sort(cmp));
      addresses.push(node.address);
    }
    if (!addresses.length) { nothing.push(id); continue; }
    addresses.sort(cmp);
    const child = state.children[id];
    steps.push({
      childId: id, addresses, after: [], status: "planned",
      stepDigest: digest({ parentOperationId: state.parentOperationId, childId: id, addresses, subplanDigest: child.subplanDigest, receiptDigest: child.receiptDigest ?? null, attempts: child.attempts }),
    });
  }
  // A step waits for the steps of every applied consumer, directly or transitively.
  const stepIds = new Set(steps.map((step) => step.childId));
  for (const step of steps) step.after = sortedUnique([...downstreamOf(graph, step.childId)].filter((id) => stepIds.has(id)));
  const next = structuredClone(state);
  next.teardown = { planDigest: digest({ parentOperationId: state.parentOperationId, steps: steps.map((step) => step.stepDigest) }), createdAt: input.now.toISOString(), steps };
  next.seq += 1;
  return { state: next, retained, nothingToDestroy: nothing };
}

/* ------------------------------ human approval ----------------------------- */

/** What the existing destroy operation says about its reviewed list and approvals. Read from the broker store, never from a caller. */
export interface DestroyApprovalFact {
  operationId: string;
  workspaceId: string;
  environmentId: string;
  capability: string;
  status: string;
  /** Destroy addresses of the reviewed, non-simulated plan evidence. */
  destroyAddresses: readonly string[];
  proposalDigest: string;
  approvals: readonly { id: string; decision: "approve" | "reject"; proposalDigest: string; approverKind: string; humanOnly: boolean; approverRole: string; expiresAt: string; consumed: boolean }[];
}

export interface TeardownApprovalPort {
  lookup(workspaceId: string, destroyOperationId: string): Promise<DestroyApprovalFact | null>;
}

export interface VerifiedTeardownApproval {
  readonly workspaceId: string;
  readonly environmentId: string;
  readonly destroyOperationId: string;
  readonly approvalId: string;
  readonly destroyAddresses: readonly string[];
}
const verified = new WeakSet<object>();

/** Adapter over the capability broker's store: the destroy operation, its recorded evidence and approvals. */
export function brokerTeardownApprovalPort(deps: Pick<BrokerDeps, "store">): TeardownApprovalPort {
  return {
    async lookup(workspaceId, destroyOperationId) {
      const op = await deps.store.getOperation(workspaceId, destroyOperationId);
      if (!op || !op.environmentId || !op.planDigest) return null;
      const evidence = await deps.store.getPlanEvidence(workspaceId, op.id, op.planDigest);
      const addresses = evidence && !evidence.simulated && evidence.summary.destroy === true ? evidence.summary.destroyAddresses : undefined;
      if (!Array.isArray(addresses) || addresses.some((item) => typeof item !== "string")) return null;
      const approvals = await deps.store.listApprovals(workspaceId, op.id);
      return {
        operationId: op.id, workspaceId, environmentId: op.environmentId, capability: op.capability, status: op.status,
        destroyAddresses: addresses as string[], proposalDigest: op.proposalDigest,
        approvals: approvals.map((approval) => ({
          id: approval.id, decision: approval.decision, proposalDigest: approval.proposalDigest, approverKind: approval.approver.kind,
          humanOnly: approval.approver.onBehalfOf === undefined && approval.approver.integrationId === undefined,
          approverRole: approval.approverRole, expiresAt: approval.expiresAt, consumed: approval.consumedAt !== undefined,
        })),
      };
    },
  };
}

/**
 * The destroy operation must be a live `infrastructure.destroy` in this workspace and environment with a
 * non-simulated reviewed list, approved by a human admin for exactly the proposal digest (not rejected, not
 * expired, not already consumed), and its list must match the step: equal for a succeeded child, a non-empty
 * subset of the step for a child that did not finish (it may have created only some resources).
 */
export async function verifyTeardownApproval(port: TeardownApprovalPort, state: MixedRunState, childId: string, destroyOperationId: string, now: Date): Promise<VerifiedTeardownApproval> {
  const step = state.teardown?.steps.find((item) => item.childId === childId);
  if (!step) return refuse("teardown_refused", childId);
  const fact = await port.lookup(state.workspaceId, destroyOperationId);
  if (!fact || fact.workspaceId !== state.workspaceId || fact.environmentId !== state.environmentId || fact.capability !== "infrastructure.destroy"
    || ["denied", "rejected", "cancelled", "expired", "failed", "uncertain", "succeeded", "completed"].includes(fact.status)) return refuse("approval_invalid");
  const listed = sortedUnique(fact.destroyAddresses);
  const inStep = new Set(step.addresses);
  const exact = state.children[childId].status === "succeeded";
  const matches = exact ? listed.length === step.addresses.length && listed.every((address) => inStep.has(address)) : listed.length > 0 && listed.every((address) => inStep.has(address));
  if (!matches) return refuse("approval_invalid", childId);
  if (fact.approvals.some((approval) => approval.decision === "reject")) return refuse("approval_invalid", childId);
  const good = fact.approvals.find((approval) => approval.decision === "approve" && approval.approverKind === "user" && approval.humanOnly && approval.approverRole === "admin"
    && approval.proposalDigest === fact.proposalDigest && !approval.consumed && Date.parse(approval.expiresAt) > now.getTime());
  if (!good) return refuse("approval_invalid", childId);
  const proof: VerifiedTeardownApproval = Object.freeze({ workspaceId: fact.workspaceId, environmentId: fact.environmentId, destroyOperationId: fact.operationId, approvalId: good.id, destroyAddresses: Object.freeze(listed) });
  verified.add(proof);
  return proof;
}

/** Release one step to the existing destroy path. Pure state change: it destroys nothing. */
export function releaseTeardownStep(state: MixedRunState, childId: string, approval: VerifiedTeardownApproval, signals: OrderingSignals, now: Date): MixedRunState {
  if (!verified.has(approval) || approval.workspaceId !== state.workspaceId || approval.environmentId !== state.environmentId) return refuse("approval_invalid");
  const teardown = state.teardown;
  const step = teardown?.steps.find((item) => item.childId === childId);
  if (!teardown || !step) return refuse("teardown_refused", childId);
  if (step.status !== "planned") return refuse("illegal_transition", childId);
  if (teardown.steps.some((item) => item.status === "released")) return refuse("ordering_blocked", "one_teardown_step_at_a_time");
  const earlier = teardown.steps.filter((item) => step.after.includes(item.childId) && item.status !== "destroyed");
  if (earlier.length) return refuse("ordering_blocked", ...earlier.map((item) => item.childId).sort(cmp));
  const verdict = evaluateOrdering(state, { kind: "teardown", childId }, signals);
  if (!verdict.allowed) return refuse("ordering_blocked", ...verdict.blocks.map((block) => `${block.rule}:${block.blockedBy}`));
  const next = structuredClone(state);
  const target = next.teardown!.steps.find((item) => item.childId === childId)!;
  target.status = "released"; target.approvalId = approval.approvalId; target.destroyOperationId = approval.destroyOperationId; target.releasedAt = now.toISOString();
  next.seq += 1;
  return next;
}

/** Record what the destroy operation reported. An uncertain or failed step blocks every producer step behind it. */
export function recordTeardownResult(state: MixedRunState, childId: string, outcome: "destroyed" | "failed" | "uncertain", now: Date): MixedRunState {
  const step = state.teardown?.steps.find((item) => item.childId === childId);
  if (!step) return refuse("teardown_refused", childId);
  if (step.status !== "released") return refuse("illegal_transition", childId);
  const next = structuredClone(state);
  const target = next.teardown!.steps.find((item) => item.childId === childId)!;
  target.status = outcome; target.finishedAt = now.toISOString();
  if (outcome === "destroyed") next.children[childId].effects = "none";
  else next.children[childId].reconciliationRequired = true;
  next.seq += 1;
  return next;
}
