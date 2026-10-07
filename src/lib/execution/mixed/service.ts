/**
 * Orchestration of mixed parent and child plans over the platform store
 * (PROD-MIX-01 / PROD-MIX-02). Pure of transport: connections, the product
 * store and the child launcher arrive as ports, so the same code is driven by the
 * REST routes, the Temporal activities and the contract tests.
 *
 * Guard order for anything that makes a child act (the wave-4b order):
 *   authority/intent (parent operation running, human approval of exactly this
 *   plan, durable start intent)  ->  semantics (child graph is an exact subset of
 *   the approved subplan, connection identity and backend unchanged, DUR-B digest
 *   write-once)  ->  custody and effect ledger (inside the child's own workflow)
 *   ->  provider call (only ever made by a child workflow).
 * Nothing in this module compensates, rolls back or destroys.
 */
import type { Sql } from "@/lib/controlplane/types";
import * as plans from "@/lib/controlplane/db/repos/mixed-parent-plans";
import type { SemanticsStore } from "@/lib/execution/semantics/store";
import type { DeployWorkflowInput } from "@/lib/workflows/types";
import { planMixedPartitions, type MixedPartitionInput, type PartitionReference } from "@/lib/execution/mixed-partitions";
import { assertAddressesStable, deriveAddresses } from "./addresses";
import { admitMixedGraph, type MixedAdmission } from "./admission";
import { buildParentPlan, assertParentPlanIntegrity, parentProposalInput, proposalMatchesPlan, type BuildParentPlanInput } from "./parent-plan";
import { assignPartitions, type PartitionPin } from "./partitioner";
import { outcomeOfOperationStatus } from "./receipt";
import {
  CHILD_TERMINAL, MIXED_PARENT_CAPABILITY, MixedPlanError, type ChildReceipt, type ChildState, type ChildSubplan, type MixedBlockReason, type MixedParentPlan, type MixedParentProposalInput,
} from "./types";
import { reverifyAuthority, verifyChildGraph } from "./verify";
import type { MixedWorld } from "./world";

/** Per-child event budget in the parent workflow makes more than this unsafe; see workflows/definitions/mixedParent.ts. */
export const MAX_MIXED_CHILDREN = 8;

/** Claim and start a child exactly like a person pressing Start would: broker claim, then a durable start intent. */
export interface ChildLauncher {
  /** `already_claimed` is success: a prior attempt (or the owner) claimed it. Any other failure throws. */
  claim(workspaceId: string, operationId: string): Promise<"claimed" | "already_claimed">;
  /** Durable, idempotent start of the child's deploy workflow. Throws when the start cannot be confirmed. */
  start(input: DeployWorkflowInput): Promise<void>;
}

export interface MixedDeps {
  sql: Sql;
  world: MixedWorld;
  /** Reviewed-semantics store, for each child's DUR-B digest. */
  semantics?: SemanticsStore;
  /**
   * Typed outputs (MIX-03) plug in here: true when every incoming reference of the child is materialized under its
   * approved contract. Absent means no materializer is wired, so a child with incoming references cannot start.
   */
  referencesReady?: (plan: MixedParentPlan, child: ChildSubplan) => Promise<boolean>;
}

export interface PlanMixedInput {
  workspaceId: string;
  parentEnvironmentId: string;
  childEnvironmentIds: readonly string[];
  pins?: readonly PartitionPin[];
  references?: BuildParentPlanInput["references"];
  createdBy: string;
}

/** Partition the parent's graph over the named child environments and store the immutable parent plan. */
export async function planMixed(deps: MixedDeps, input: PlanMixedInput): Promise<{ stored: plans.StoredMixedPlan; created: boolean; proposalInput: MixedParentProposalInput }> {
  if (!input.childEnvironmentIds.length || input.childEnvironmentIds.length > MAX_MIXED_CHILDREN) {
    throw new MixedPlanError("invalid_input", `A mixed plan needs between 1 and ${MAX_MIXED_CHILDREN} child environments.`);
  }
  if (input.childEnvironmentIds.includes(input.parentEnvironmentId)) throw new MixedPlanError("invalid_input", "The parent environment cannot also be a child.");
  const parent = await deps.world.parentGraph(input.workspaceId, input.parentEnvironmentId);
  const candidates = [];
  for (const childEnvironmentId of input.childEnvironmentIds) {
    const child = await deps.world.childEnvironment(input.workspaceId, childEnvironmentId);
    if (child.projectId !== parent.projectId) throw new MixedPlanError("child_mismatch", "A child environment belongs to a different project than the parent.");
    candidates.push({ childEnvironmentId, connection: child.connection });
  }
  const plan = buildParentPlan({
    workspaceId: input.workspaceId, projectId: parent.projectId, parentEnvironmentId: input.parentEnvironmentId, graph: parent.graph, candidates,
    ...(input.pins ? { pins: input.pins } : {}), ...(input.references ? { references: input.references } : {}),
  });
  const result = await plans.createPlan(deps.sql, { plan, createdBy: input.createdBy });
  return { ...result, proposalInput: parentProposalInput(result.stored.plan) };
}

/**
 * Rebuild, from the stored plan alone, the exact planner input the parent plan was derived from (graph, bindings,
 * assignments and the declared reference inventory with every value still unavailable), and prove it re-derives the
 * stored parent digest. This is what MIX-03 judges new materializations against; a graph, connection or backend that
 * changed since the plan refuses with `plan_refused` instead of being judged against something nobody approved.
 */
export async function plannerInputOf(deps: Pick<MixedDeps, "world">, plan: MixedParentPlan): Promise<MixedPartitionInput> {
  const parent = await deps.world.parentGraph(plan.workspaceId, plan.parentEnvironmentId);
  const candidates = [];
  for (const child of plan.children) candidates.push({ childEnvironmentId: child.childEnvironmentId, connection: (await deps.world.childEnvironment(plan.workspaceId, child.childEnvironmentId)).connection });
  const pins = plan.children.flatMap((child) => child.nodes.map((node) => ({ address: node.address, childEnvironmentId: child.childEnvironmentId })));
  const assigned = assignPartitions({ workspaceId: plan.workspaceId, graph: parent.graph, candidates, pins });
  const references: PartitionReference[] = plan.references.map((ref) => {
    if (!ref.producerAddress || !ref.producerOutput || !ref.consumerAddress || !ref.consumerInput || !ref.valueType) {
      throw new MixedPlanError("plan_refused", "This plan stored a reference without its declared contract, so its outputs cannot be materialized; plan again.", { referenceId: ref.referenceId });
    }
    return {
      id: ref.referenceId, scope: { workspaceId: plan.workspaceId, environmentId: parent.graph.environmentId },
      producer: { address: ref.producerAddress, output: ref.producerOutput, type: ref.valueType }, consumer: { address: ref.consumerAddress, input: ref.consumerInput, type: ref.valueType },
      materialization: { state: "unavailable", reason: "not_produced" },
    };
  });
  const input: MixedPartitionInput = { workspaceId: plan.workspaceId, graph: parent.graph, bindings: assigned.bindings, assignments: assigned.assignments, references };
  let derived;
  try { derived = planMixedPartitions(input); } catch { throw new MixedPlanError("plan_refused", "The parent graph can no longer be partitioned the way the approved plan was."); }
  if (derived.parentDigest !== plan.parentDigest) throw new MixedPlanError("plan_refused", "The parent graph, a connection or a backend changed since the plan was approved; plan again.");
  return input;
}

async function loadPlan(sql: Sql, workspaceId: string, planId: string): Promise<plans.StoredMixedPlan> {
  const stored = await plans.getPlan(sql, workspaceId, planId);
  if (!stored) throw new MixedPlanError("not_found", "The mixed plan was not found.");
  assertParentPlanIntegrity(stored.plan);
  return stored;
}

const childOf = (plan: MixedParentPlan, partitionId: string): ChildSubplan => {
  const child = plan.children.find((candidate) => candidate.partitionId === partitionId);
  if (!child) throw new MixedPlanError("not_found", "The partition is not part of this plan.");
  return child;
};

/** Prove a candidate child operation deploys exactly this partition, then bind it (write-once). */
export async function adoptChildOperation(deps: MixedDeps, input: { workspaceId: string; planId: string; partitionId: string; operationId: string }) {
  const stored = await loadPlan(deps.sql, input.workspaceId, input.planId);
  if (stored.status !== "planned") throw new MixedPlanError("invalid_state", "Children can only be adopted before the plan runs.");
  const child = childOf(stored.plan, input.partitionId);
  const facts = await plans.readOperationFacts(deps.sql, input.workspaceId, input.operationId);
  if (!facts?.environmentId) throw new MixedPlanError("not_found", "The operation was not found.");
  if (facts.environmentId !== child.childEnvironmentId) throw new MixedPlanError("child_mismatch", "The operation targets a different environment than this child.");
  const proposalInput = facts.input && typeof facts.input === "object" && !Array.isArray(facts.input) ? (facts.input as Record<string, unknown>) : {};
  if (typeof proposalInput.revisionId !== "string") throw new MixedPlanError("child_mismatch", "The operation does not name the revision it deploys.");
  const graph = await deps.world.childGraph(input.workspaceId, child.childEnvironmentId, proposalInput.revisionId);
  verifyChildGraph(child, graph);
  const connections = await deps.world.connections(input.workspaceId, [child.authority.connectionId]);
  reverifyAuthority({ workspaceId: input.workspaceId, parentEnvironmentId: stored.plan.parentEnvironmentId, child, connection: connections.get(child.authority.connectionId) ?? null });
  return plans.adoptChild(deps.sql, input);
}

export interface ParentReadiness {
  stored: plans.StoredMixedPlan;
  admission: MixedAdmission;
}

/**
 * Everything that must hold before the parent claims anything: the operation is this plan's own, carries exactly its
 * proposal input, was approved by a person (a policy allow without a human is refused), the address registry matches a
 * fresh derivation, every child is adopted, no child still needs unmaterialized references, and the cross-provider
 * refusal is lifted only through a fresh `MixedAdmission` (every partition bound and verified right now).
 */
export async function verifyParent(deps: MixedDeps, input: { workspaceId: string; operationId: string; planId: string; requireRunning: boolean }): Promise<ParentReadiness> {
  const stored = await loadPlan(deps.sql, input.workspaceId, input.planId);
  if (stored.parentOperationId !== input.operationId) throw new MixedPlanError("approval_mismatch", "This operation is not the parent of the plan.");
  const facts = await plans.readOperationFacts(deps.sql, input.workspaceId, input.operationId);
  if (!facts || facts.capability !== MIXED_PARENT_CAPABILITY || facts.environmentId !== stored.plan.parentEnvironmentId) throw new MixedPlanError("approval_mismatch", "The parent operation does not match the plan.");
  if (!proposalMatchesPlan(facts.input, stored.plan)) throw new MixedPlanError("approval_mismatch", "The parent operation's proposal is not exactly this plan.");
  if (!facts.approvalRequired || facts.humanApprovals < 1 || facts.rejections > 0) {
    throw new MixedPlanError("approval_mismatch", "A mixed plan runs only on a person's approval of exactly its child set; none is recorded.");
  }
  if (input.requireRunning ? facts.status !== "running" : !["approved", "queued", "running"].includes(facts.status)) {
    throw new MixedPlanError("invalid_state", "The parent operation is not in a startable state.", { status: facts.status });
  }
  assertAddressesStable(await plans.getAddresses(deps.sql, input.workspaceId, input.planId), deriveAddresses(stored.plan.children));
  const children = await plans.listChildren(deps.sql, input.workspaceId, input.planId);
  if (children.length !== stored.plan.children.length || children.some((child) => child.state === "pending")) {
    throw new MixedPlanError("child_mismatch", "Every child needs an adopted operation before the parent can start.");
  }
  for (const child of stored.plan.children) {
    if (child.blockedByReferences.length > 0 && !(deps.referencesReady && (await deps.referencesReady(stored.plan, child)))) {
      throw new MixedPlanError("plan_refused", "A child consumes dependency outputs that are not materialized under their approved contract.", { partitionId: child.partitionId });
    }
  }
  const parent = await deps.world.parentGraph(input.workspaceId, stored.plan.parentEnvironmentId);
  const connections = await deps.world.connections(input.workspaceId, stored.plan.children.map((child) => child.authority.connectionId));
  const admission = admitMixedGraph({ plan: stored.plan, graph: parent.graph, connections });
  return { stored, admission };
}

/** planned -> running; idempotent for a resumed run. */
export async function beginParent(deps: MixedDeps, input: { workspaceId: string; planId: string }): Promise<void> {
  const stored = await plans.getPlan(deps.sql, input.workspaceId, input.planId);
  if (!stored) throw new MixedPlanError("not_found", "The mixed plan was not found.");
  if (stored.status === "running") return;
  await plans.setParentStatus(deps.sql, { workspaceId: input.workspaceId, planId: input.planId, from: "planned", to: "running" });
}

export type ChildAdvance =
  | { state: "started"; childOperationId: string }
  | { state: "waiting"; reason: "approval" }
  | { state: "blocked"; reason: MixedBlockReason }
  | { state: "succeeded" | "failed" | "uncertain" | "cancelled"; childOperationId: string };

const beforeStart = ["proposed", "awaiting_approval"];
const endedWithoutUs = ["succeeded", "failed", "uncertain", "cancelled", "rejected", "denied", "expired"];

/**
 * Bring ONE child toward started, from durable state only, so a crashed or retried activity repeats it safely. It
 * never starts a child whose dependencies did not succeed, whose connection or graph changed, or whose own approval is
 * missing, and it never re-claims: an already claimed operation is only (re)started through the same durable intent.
 */
export async function advanceChild(deps: MixedDeps, launcher: ChildLauncher, input: { workspaceId: string; operationId: string; planId: string; partitionId: string }): Promise<ChildAdvance> {
  const { stored } = await verifyParent(deps, { workspaceId: input.workspaceId, operationId: input.operationId, planId: input.planId, requireRunning: true });
  if (stored.status !== "running") throw new MixedPlanError("invalid_state", "The mixed plan is not running.", { status: stored.status });
  const child = childOf(stored.plan, input.partitionId);
  const rows = await plans.listChildren(deps.sql, input.workspaceId, input.planId);
  const row = rows.find((candidate) => candidate.partitionId === input.partitionId);
  if (!row) throw new MixedPlanError("not_found", "The partition is not part of this plan.");
  if (CHILD_TERMINAL.includes(row.state)) {
    if (row.state === "blocked") return { state: "blocked", reason: "dependency_not_succeeded" };
    return { state: row.state as "succeeded" | "failed" | "uncertain" | "cancelled", childOperationId: row.childOperationId! };
  }
  for (const dependency of child.dependsOn) {
    const dep = rows.find((candidate) => candidate.partitionId === dependency);
    if (dep?.state !== "succeeded") {
      const reason: MixedBlockReason = dep?.state === "uncertain" ? "dependency_uncertain" : "dependency_not_succeeded";
      await plans.blockChild(deps.sql, { workspaceId: input.workspaceId, planId: input.planId, partitionId: input.partitionId, reason });
      return { state: "blocked", reason };
    }
  }
  if (!row.childOperationId) throw new MixedPlanError("child_mismatch", "The child has no adopted operation.");
  const childOperationId = row.childOperationId;
  if (row.state === "started") return { state: "started", childOperationId };
  const facts = await plans.readOperationFacts(deps.sql, input.workspaceId, childOperationId);
  if (!facts || facts.environmentId !== child.childEnvironmentId) throw new MixedPlanError("child_mismatch", "The child operation no longer matches its environment.");
  if (endedWithoutUs.includes(facts.status)) {
    await plans.blockChild(deps.sql, { workspaceId: input.workspaceId, planId: input.planId, partitionId: input.partitionId, reason: "The child operation ended before the parent started it." });
    return { state: "blocked", reason: "dependency_not_succeeded" };
  }
  if (beforeStart.includes(facts.status)) return { state: "waiting", reason: "approval" };
  // Semantics and authority again, right before the claim: the graph the child would apply, and the connection it would use.
  const inputRecord = facts.input && typeof facts.input === "object" && !Array.isArray(facts.input) ? (facts.input as Record<string, unknown>) : {};
  if (typeof inputRecord.revisionId !== "string") throw new MixedPlanError("child_mismatch", "The child operation does not name its revision.");
  verifyChildGraph(child, await deps.world.childGraph(input.workspaceId, child.childEnvironmentId, inputRecord.revisionId));
  const connections = await deps.world.connections(input.workspaceId, [child.authority.connectionId]);
  reverifyAuthority({ workspaceId: input.workspaceId, parentEnvironmentId: stored.plan.parentEnvironmentId, child, connection: connections.get(child.authority.connectionId) ?? null });
  if (!facts.projectId) throw new MixedPlanError("child_mismatch", "The child operation has no project.");
  if (facts.status !== "running") await launcher.claim(input.workspaceId, childOperationId);
  const startInput = await deps.world.childStartInput(input.workspaceId, { id: childOperationId, environmentId: child.childEnvironmentId, projectId: facts.projectId, input: facts.input });
  await launcher.start(startInput);
  if (row.state === "adopted") await plans.markChildStarted(deps.sql, { workspaceId: input.workspaceId, planId: input.planId, partitionId: input.partitionId, operationId: childOperationId });
  return { state: "started", childOperationId };
}

/**
 * Observe one started child. If its operation reached a terminal status, record the durable receipt (and the child's
 * DUR-B reviewed semantics digest, write-once) and move the child to its terminal state. A `succeeded` operation with no
 * recorded reviewed semantics is NOT reported as success: the receipt says `uncertain`, because the evidence the parent
 * approval relies on is missing.
 */
export async function observeChild(deps: MixedDeps, input: { workspaceId: string; planId: string; partitionId: string }): Promise<{ state: ChildState; receipt?: ChildReceipt }> {
  const stored = await loadPlan(deps.sql, input.workspaceId, input.planId);
  const child = childOf(stored.plan, input.partitionId);
  const rows = await plans.listChildren(deps.sql, input.workspaceId, input.planId);
  const row = rows.find((candidate) => candidate.partitionId === input.partitionId);
  if (!row?.childOperationId) throw new MixedPlanError("not_found", "The child has no operation.");
  const existing = await plans.getReceipt(deps.sql, input.workspaceId, input.planId, input.partitionId);
  if (existing) return { state: existing.outcome, receipt: existing };
  if (row.state !== "started") return { state: row.state };
  const facts = await plans.readOperationFacts(deps.sql, input.workspaceId, row.childOperationId);
  if (!facts) throw new MixedPlanError("not_found", "The child operation was not found.");
  let semanticsDigest = row.executableSemanticsDigest;
  if (!semanticsDigest && facts.planDigest && deps.semantics) {
    const recorded = await deps.semantics.get(input.workspaceId, facts.id, facts.planDigest);
    if (recorded) {
      semanticsDigest = recorded.semantics.digest;
      await plans.recordExecutableSemantics(deps.sql, { workspaceId: input.workspaceId, planId: input.planId, partitionId: input.partitionId, executableSemanticsDigest: semanticsDigest });
    }
  }
  const mapped = outcomeOfOperationStatus(facts.status);
  if (!mapped) return { state: "started" };
  const downgraded = mapped === "succeeded" && !semanticsDigest;
  const outputsDigest = mapped === "succeeded" && deps.world.childOutputsDigest
    ? await deps.world.childOutputsDigest(input.workspaceId, { id: facts.id, environmentId: child.childEnvironmentId, input: facts.input })
    : undefined;
  const receipt = await plans.recordReceipt(deps.sql, {
    workspaceId: input.workspaceId, parentPlanId: input.planId, partitionId: input.partitionId, ordinal: child.ordinal, childOperationId: facts.id,
    outcome: downgraded ? "uncertain" : mapped, childStatus: downgraded ? "succeeded_without_reviewed_semantics" : facts.status,
    ...(semanticsDigest ? { executableSemanticsDigest: semanticsDigest } : {}), ...(facts.planDigest ? { planDigest: facts.planDigest } : {}), ...(outputsDigest ? { outputsDigest } : {}),
  });
  return { state: receipt.outcome, receipt };
}

/**
 * End the parent: every child that never started becomes `blocked` (terminal, nothing is undone) and the parent status
 * moves forward once. A child that is still `started` is left as it is: its own workflow owns what happens next, and its
 * receipt is recorded when it is observed, never invented here.
 */
export async function settleParent(deps: MixedDeps, input: { workspaceId: string; planId: string; outcome: "succeeded" | "failed" | "uncertain" | "cancelled"; reason: string }): Promise<void> {
  const rows = await plans.listChildren(deps.sql, input.workspaceId, input.planId);
  for (const row of rows) {
    if (row.state === "pending" || row.state === "adopted") {
      await plans.blockChild(deps.sql, { workspaceId: input.workspaceId, planId: input.planId, partitionId: row.partitionId, reason: input.reason });
    }
  }
  const stored = await plans.getPlan(deps.sql, input.workspaceId, input.planId);
  if (!stored) return;
  if (stored.status === "planned") {
    if (input.outcome === "cancelled") await plans.setParentStatus(deps.sql, { workspaceId: input.workspaceId, planId: input.planId, from: "planned", to: "cancelled" });
    return;
  }
  if (stored.status === "running") await plans.setParentStatus(deps.sql, { workspaceId: input.workspaceId, planId: input.planId, from: "running", to: input.outcome });
}
