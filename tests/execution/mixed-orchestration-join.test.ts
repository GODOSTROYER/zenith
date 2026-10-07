/**
 * The wave-4 join of the partition executor (PROD-MIX-01/02) and the mixed run service (PROD-MIX-03/04), at contract level.
 *
 * What runs here: the run view derived from a stored plan, the `start` run event recorded right before a child is
 * claimed (producers must have succeeded, a consumer with unmaterialized incoming references is refused), idempotent
 * outcome sync (a retried observation records nothing twice, a failure leaves effects "possible" and blocks dependents),
 * the review input and its approver-facing lines. The run store is the in-memory one, which enforces the same rules as
 * the SQL repository; the SQL-backed pieces of the join (review lookups, parent approval expiry) are exercised against
 * the platform store in tests/controlplane/mixed-parent-plans.test.ts. No cloud API is called.
 */
import { describe, expect, it } from "vitest";
import { digest } from "@/lib/controlplane/digest";
import { MIXED_PARENT_REVIEW_KEY, MixedPlanError, type ChildReceipt, type MixedParentPlan } from "@/lib/execution/mixed/types";
import { mixedProposalDetails } from "@/lib/execution/mixed/details";
import {
  parentViewOfPlan, recordChildStart, reviewInputOf, syncChildOutcome, type JoinDeps,
} from "@/lib/execution/mixed/orchestration-join";
import type { MixedWorld } from "@/lib/execution/mixed/world";
import { assertParentView, MixedOrchestrationError, openMixedRun, readMixedRun, refusingParentReviewPort, type MixedRunDeps } from "@/lib/execution/mixed-orchestration";
import { MemoryPreauthorizationStore } from "@/lib/execution/mixed-orchestration/preauthorization";
import { MemoryMixedRunStore } from "@/lib/execution/mixed-orchestration/run-store";
import { issueDecision } from "@/lib/execution/mixed-orchestration/decision";
import { DB, WEB, WS, plan } from "./mixed/_fixtures";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const PARENT = "op-parent-join";

const REFERENCE = { id: "db-host", producer: { address: DB, output: "endpoint", type: "endpoint" as const }, consumer: { address: WEB, input: "endpoint_db", type: "endpoint" as const } };

function runDeps(): MixedRunDeps {
  return {
    runs: new MemoryMixedRunStore(), preauthorizations: new MemoryPreauthorizationStore(), roles: {} as MixedRunDeps["roles"],
    teardownApprovals: { lookup: async () => null }, parentReview: refusingParentReviewPort, now: () => NOW,
  };
}

function joinDeps(run: MixedRunDeps): JoinDeps {
  return { sql: undefined as never, world: {} as MixedWorld, run, now: () => NOW };
}

async function opened(parent: MixedParentPlan = plan()) {
  const run = runDeps();
  const deps = joinDeps(run);
  await openMixedRun(run, { workspaceId: WS, parentOperationId: PARENT, view: parentViewOfPlan(parent), expiresAt: new Date(NOW.getTime() + 2 * 3_600_000).toISOString(), childTimeoutMs: 3_600_000 });
  return { run, deps, parent };
}

const scope = (parent: MixedParentPlan, partitionId: string) => ({ workspaceId: WS, parentOperationId: PARENT, plan: parent, partitionId });
const receipt = (label: string): ChildReceipt => ({ receiptDigest: digest(label) } as ChildReceipt);
const status = async (run: MixedRunDeps, id: string) => (await readMixedRun(run, WS, PARENT))!.state.children[id].status;

describe("the run view derived from a stored plan", () => {
  it("is a valid parent view with the plan's children, dependencies and declared references", () => {
    const parent = plan({ references: [REFERENCE] });
    const view = parentViewOfPlan(parent);
    expect(() => assertParentView(view)).not.toThrow();
    expect(view.children.map((child) => child.id).sort()).toEqual(parent.children.map((child) => child.partitionId).sort());
    expect(view.parentDigest).toBe(parent.parentDigest);
    expect(view.references).toHaveLength(1);
    expect(view.references[0]).toMatchObject({ id: "db-host", producerAddress: DB, consumerAddress: WEB, type: "endpoint", materialized: false });
  });

  it("refuses a stored reference that has no declared contract, so outputs are never guessed", () => {
    const parent = plan({ references: [REFERENCE] });
    const stripped: MixedParentPlan = { ...parent, references: parent.references.map(({ producerAddress: _a, producerOutput: _b, consumerAddress: _c, consumerInput: _d, valueType: _e, ...rest }) => rest) };
    expect(() => parentViewOfPlan(stripped)).toThrow(MixedPlanError);
  });
});

describe("recording the start before the claim", () => {
  it("lets the first child start, records it once, and refuses a consumer before its producer succeeded", async () => {
    const { run, deps, parent } = await opened();
    const [first, second] = parent.children;
    await recordChildStart(deps, scope(parent, first.partitionId));
    expect(await status(run, first.partitionId)).toBe("running");
    // A retried claim or start records nothing twice.
    await recordChildStart(deps, scope(parent, first.partitionId));
    expect((await readMixedRun(run, WS, PARENT))!.state.children[first.partitionId].attempts).toBe(1);
    await expect(recordChildStart(deps, scope(parent, second.partitionId))).rejects.toBeInstanceOf(MixedOrchestrationError);
    expect(await status(run, second.partitionId)).toBe("pending");
  });

  it("starts the next child only after the producer's success is recorded with its receipt", async () => {
    const { run, deps, parent } = await opened();
    const [first, second] = parent.children;
    await recordChildStart(deps, scope(parent, first.partitionId));
    await syncChildOutcome(deps, { ...scope(parent, first.partitionId), state: "succeeded", receipt: receipt("first") });
    expect(await status(run, first.partitionId)).toBe("succeeded");
    // Observing the same outcome again is a no-op.
    await syncChildOutcome(deps, { ...scope(parent, first.partitionId), state: "succeeded", receipt: receipt("first") });
    await recordChildStart(deps, scope(parent, second.partitionId));
    expect(await status(run, second.partitionId)).toBe("running");
  });

  it("refuses to start a consumer whose incoming reference was never materialized", async () => {
    const parent = plan({ references: [REFERENCE] });
    const { run, deps } = await opened(parent);
    const producer = parent.children.find((child) => child.nodes.some((node) => node.address === DB))!;
    const consumer = parent.children.find((child) => child.nodes.some((node) => node.address === WEB))!;
    await recordChildStart(deps, scope(parent, producer.partitionId));
    await syncChildOutcome(deps, { ...scope(parent, producer.partitionId), state: "succeeded", receipt: receipt("producer") });
    let failure: unknown;
    try { await recordChildStart(deps, scope(parent, consumer.partitionId)); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(MixedOrchestrationError);
    expect((failure as MixedOrchestrationError).code).toBe("ordering_blocked");
    expect(await status(run, consumer.partitionId)).toBe("pending");
  });
});

describe("syncing outcomes", () => {
  it("records a failed child as possibly applied and blocks everything behind it, without compensating", async () => {
    const { run, deps, parent } = await opened();
    const [first, second] = parent.children;
    await recordChildStart(deps, scope(parent, first.partitionId));
    await syncChildOutcome(deps, { ...scope(parent, first.partitionId), state: "failed" });
    const state = (await readMixedRun(run, WS, PARENT))!.state;
    expect(state.children[first.partitionId]).toMatchObject({ status: "failed", effects: "possible", reconciliationRequired: true });
    expect(state.children[second.partitionId].status).toBe("blocked");
    expect(state.children[second.partitionId].blockedBy).toContain(first.partitionId);
  });

  it("heals a run opened after the child already ran: the start is recorded first, then the end", async () => {
    const { run, deps, parent } = await opened();
    const first = parent.children[0];
    await syncChildOutcome(deps, { ...scope(parent, first.partitionId), state: "succeeded", receipt: receipt("late") });
    expect(await status(run, first.partitionId)).toBe("succeeded");
  });

  it("ignores states that are not an end (started, adopted, blocked)", async () => {
    const { run, deps, parent } = await opened();
    const first = parent.children[0];
    await syncChildOutcome(deps, { ...scope(parent, first.partitionId), state: "started" });
    expect(await status(run, first.partitionId)).toBe("pending");
  });
});

describe("the review of a changed parent digest", () => {
  const decision = (parent: MixedParentPlan) => issueDecision({
    classification: "review_required", workspaceId: WS, environmentId: parent.parentEnvironmentId, desiredDigest: parent.desiredDigest, requiredParentDigest: digest("new-parent"),
    reasons: ["effect_changed"], consumers: [{ childId: parent.children[1].partitionId, previousEffectDigest: parent.children[1].effectDigest, newEffectDigest: digest("new-effect"), referenceIds: ["db-host"] }],
    preauthorizationIds: [], uncovered: ["db-host"],
  });

  it("binds exactly the new parent digest and the original child set, and shows an approver what moved", () => {
    const parent = plan();
    const input = reviewInputOf(parent, PARENT, parent.parentDigest, decision(parent));
    expect(input).toMatchObject({ [MIXED_PARENT_REVIEW_KEY]: PARENT, parentPlanId: parent.parentPlanId, previousParentDigest: parent.parentDigest, requiredParentDigest: digest("new-parent"), childSetDigest: parent.childSetDigest });
    expect(input.consumers).toHaveLength(1);
    const lines = mixedProposalDetails(input);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.join("\n")).toContain(digest("new-parent").slice(0, 16));
    expect(lines.join("\n")).toContain("starts nothing by itself");
  });

  it("never reads as an executable parent proposal: its key differs from the parent plan key", () => {
    const parent = plan();
    const input = reviewInputOf(parent, PARENT, parent.parentDigest, decision(parent)) as unknown as Record<string, unknown>;
    expect(input.mixedParentPlanId).toBeUndefined();
  });
});
