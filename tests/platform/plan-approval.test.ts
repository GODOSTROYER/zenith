/** Real PGlite ledger/broker/signing; synthetic plans and scripted policy, no cloud calls. */
import { describe, expect, it } from "vitest";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-plan-approval-", { fast: true });
const { makeHarness, closeSharedPgliteAfterAll, scriptedEngine, requireApproval, user, sessionFor } = await import("../capabilities/support");
const { makePlan, change } = await import("../execution/fakes/fixtures");
const { repos } = await import("@/lib/controlplane/db");
const { approvalRoundOf, projectPlanReview } = await import("@/lib/controlplane/db/repos/operation-review");
const { buildPlanFacts } = await import("@/lib/capabilities/evaluate");
const { planEvidence } = await import("@/lib/execution/plan-evidence");
const { createOperationsPort } = await import("@/lib/execution/platform");
const { createExecutionBroker } = await import("@/lib/platform/broker");
closeSharedPgliteAfterAll();
const plan = makePlan({ changes: [change({ address: "aws_s3_bucket.assets", type: "aws_s3_bucket", action: "create", changes: [
  { path: "bucket", before: "raw-before-canary", after: "raw-after-canary", sensitive: false, forcesReplacement: false },
  { path: "password", before: "(sensitive)", after: "(sensitive)", sensitive: true, forcesReplacement: false },
] })] });
const facts = buildPlanFacts(plan)!;
const artifact = (cost = {}) => planEvidence({ plan, facts, cost, graphDigest: "a".repeat(64), stage: "plan" });

async function running(count = 1) {
  const h = await makeHarness({ kind: "pglite", engine: scriptedEngine("plan-policy", (input) => requireApproval(input.plan?.create ? count : 1, "admin", true)) });
  const proposal = await h.broker.propose({ capability: "deployment.deploy", scope: { workspaceId: h.ids.wsA, projectId: h.ids.projA, environmentId: h.ids.envAProd }, input: {} }, user("alice"));
  const op = proposal.operation;
  const decide = (who = "erin", planDigest?: string, decision: "approve" | "reject" = "approve") => h.broker[decision]({ workspaceId: h.ids.wsA, operationId: op.id, proposalDigest: op.proposalDigest, planDigest, approver: user(who), session: sessionFor(who) });
  await decide();
  await h.broker.beginExecution({ workspaceId: h.ids.wsA, operationId: op.id, holder: `workflow:${op.id}`, audience: "worker" });
  const ports = createOperationsPort(h.db!);
  const worker = createExecutionBroker(h.db!, async () => h.broker);
  const evidence = artifact({ deltaUsdMonthly: 12.5 });
  await repos.evidence.insert(h.db!, { workspaceId: h.ids.wsA, operationId: op.id, kind: "tofu_plan", digest: plan.planDigest, summary: evidence.summary, simulated: false });
  await ports.setPlanDigest({ workspaceId: h.ids.wsA, operationId: op.id, planDigest: plan.planDigest });
  const decision = await worker.reevaluate(op.id, facts);
  await ports.setPolicyDecision({ workspaceId: h.ids.wsA, operationId: op.id, decisionId: decision.decisionId });
  const suspend = () => ports.transition({ workspaceId: h.ids.wsA, operationId: op.id, to: "awaiting_approval" });
  return { h, op, decide, worker, ports, suspend, decision };
}

describe("concrete plan approval rounds", () => {
  it("preserves require_approval, ignores consumed round zero, and grants only after this plan round is approved", async () => {
    const { h, op, worker, suspend, ports, decide, decision } = await running();
    expect(decision.outcome).toBe("require_approval");
    expect(await worker.approvalStatus(op.id)).toMatchObject({ approved: false, rejected: false });
    const fence = await h.acquireLease(h.ids.envAProd);
    await expect(worker.issueGrant(op.id, "worker", fence)).rejects.toThrow("current round");
    await h.loseLease(fence.scope);
    const waiting = await suspend();
    expect(waiting?.status).toBe("awaiting_approval"); expect(approvalRoundOf(waiting!)).toBe(1);
    expect(await worker.approvalStatus(op.id)).toMatchObject({ approved: false, rejected: false });
    await decide("erin", plan.planDigest);
    expect(await worker.approvalStatus(op.id)).toMatchObject({ approved: true, rejected: false });
    await ports.transition({ workspaceId: h.ids.wsA, operationId: op.id, to: "running" });
    const newFence = await h.acquireLease(h.ids.envAProd);
    expect(newFence.fenceToken).toBeGreaterThan(fence.fenceToken);
    const grant = await worker.issueGrant(op.id, "worker", newFence);
    expect(grant.claims).toMatchObject({ op: op.id, fence: newFence.fenceToken });
    const approvals = await h.store.listApprovals(h.ids.wsA, op.id);
    expect(approvals.map(approvalRoundOf)).toEqual([0, 1]);
    expect(approvals.every((a) => Boolean(a.consumedAt))).toBe(true);
    const events = await repos.events.list(h.db!, h.ids.wsA, { operationId: op.id });
    expect(events.filter((e) => e.type === "operation.started")).toHaveLength(2);
    expect(events.some((e) => e.type === "operation.prepared" && e.data.kind === "approval_gate")).toBe(true);
  });
  it("refuses missing/stale reviewed plan digests, including the SQL path", async () => {
    const { h, op, suspend, decide } = await running(); await suspend();
    await expect(decide()).rejects.toMatchObject({ code: "digest_mismatch" });
    await expect(decide("erin", "f".repeat(64))).rejects.toMatchObject({ code: "digest_mismatch" });
    await expect(h.store.recordApproval({ workspaceId: h.ids.wsA, operationId: op.id, proposalDigest: op.proposalDigest, approver: user("erin"), approverRole: "admin", policyVersion: "plan-policy", decision: "approve" })).rejects.toMatchObject({ code: "digest_mismatch" });
    expect(await h.store.listApprovals(h.ids.wsA, op.id)).toHaveLength(1);
  });
  it("checks round preconditions under the SQL lock and prevents an old request deciding a later round", async () => {
    const { h, op, suspend } = await running(); await suspend();
    const input = { workspaceId: h.ids.wsA, operationId: op.id, proposalDigest: op.proposalDigest, approver: user("erin"), approverRole: "admin" as const, policyVersion: "plan-policy", decision: "approve" as const, planDigest: plan.planDigest, expectedApprovalRound: 0 };
    await expect(h.store.recordApproval(input)).rejects.toMatchObject({ code: "digest_mismatch" });
  });
  it("enforces separation, minimum role and distinct count in the plan round", async () => {
    const { h, op, suspend, decide, worker } = await running(2); await suspend();
    await expect(decide("alice", plan.planDigest)).rejects.toMatchObject({ code: "separation_of_duties" });
    await expect(decide("bob", plan.planDigest)).rejects.toMatchObject({ code: "approver_role_insufficient" });
    const first = await decide("erin", plan.planDigest); expect(first.finalized).toBe(false); expect(first.approvals).toEqual({ have: 1, need: 2 });
    await expect(decide("erin", plan.planDigest)).rejects.toMatchObject({ code: "duplicate_decision" });
    expect((await worker.approvalStatus(op.id)).approved).toBe(false);
    h.world.members.set(`${h.ids.wsA}|dave`, "admin"); await decide("dave", plan.planDigest);
    expect((await worker.approvalStatus(op.id)).approved).toBe(true);
    h.world.members.set(`${h.ids.wsA}|erin`, "viewer");
    expect((await worker.approvalStatus(op.id)).approved).toBe(false);
    await h.expireApprovals(op.id); expect((await worker.approvalStatus(op.id)).approved).toBe(false);
  });
  it("rejects the plan round even without a reviewed artifact and issues no apply grant", async () => {
    const { h, op, worker, suspend, decide } = await running(); await suspend();
    await decide("erin", undefined, "reject");
    expect(await worker.approvalStatus(op.id)).toMatchObject({ approved: false, rejected: true });
    await expect(worker.issueGrant(op.id, "worker")).rejects.toThrow("running");
    expect((await h.store.getOperation(h.ids.wsA, op.id))?.status).toBe("rejected");
  });
  it("keeps deny as deny instead of opening an approval gate", async () => {
    const { h, op, worker } = await running();
    h.setEngine(scriptedEngine("denied-now", () => ({ outcome: "deny", reasons: [{ code: "public_database", message: "Public DB denied." }] })));
    expect(await worker.reevaluate(op.id, facts)).toMatchObject({ outcome: "deny", reasons: ["public_database"] });
    expect(await worker.approvalStatus(op.id)).toEqual({ approved: false, rejected: true });
  });
  it("refuses approval if current concrete-plan policy denies, even if proposal policy allows", async () => {
    const { h, suspend, decide } = await running(); await suspend();
    h.setEngine(scriptedEngine("changed", (input) => input.plan?.create ? { outcome: "deny", reasons: [{ code: "plan_denied", message: "The plan is denied." }] } : requireApproval(1, "admin", true)));
    await expect(decide("erin", plan.planDigest)).rejects.toMatchObject({ code: "policy_denied" });
  });
  it("cannot replace the approved plan digest with a re-plan", async () => {
    const { h, op, ports, suspend, decide } = await running(); await suspend(); await decide("erin", plan.planDigest);
    await expect(ports.setPlanDigest({ workspaceId: h.ids.wsA, operationId: op.id, planDigest: makePlan({ seed: "changed" }).planDigest })).rejects.toThrow("plan_changed");
    expect((await h.store.getOperation(h.ids.wsA, op.id))?.planDigest).toBe(plan.planDigest);
  });
  it("an approval recorded before a plan is stamped cannot authorize that later plan", async () => {
    const { h, ports } = await running();
    const op = (await h.broker.propose({ capability: "deployment.deploy", scope: { workspaceId: h.ids.wsA, projectId: h.ids.projA, environmentId: h.ids.envAProd }, input: {} }, user("alice"))).operation;
    const approve = () => h.broker.approve({ workspaceId: h.ids.wsA, operationId: op.id, proposalDigest: op.proposalDigest, approver: user("erin"), session: sessionFor("erin") });
    await approve(); await h.broker.beginExecution({ workspaceId: h.ids.wsA, operationId: op.id, holder: `workflow:${op.id}`, audience: "worker" });
    await ports.transition({ workspaceId: h.ids.wsA, operationId: op.id, to: "awaiting_approval" });
    await approve();
    await expect(ports.setPlanDigest({ workspaceId: h.ids.wsA, operationId: op.id, planDigest: plan.planDigest })).rejects.toThrow("plan_changed");
    expect((await h.store.getOperation(h.ids.wsA, op.id))?.planDigest).toBeUndefined();
  });
  it("exposes tenant-scoped, bounded review evidence with no attribute values and unknown costs", async () => {
    const { h, op, suspend } = await running(); await suspend();
    const detail = await h.broker.getOperationDetail({ workspaceId: h.ids.wsA, operationId: op.id, principal: user("erin") });
    expect(detail.planReview).toMatchObject({ planDigest: plan.planDigest, cost: { deltaUsdMonthly: 12.5 }, decision: { outcome: "require_approval" } });
    expect(JSON.stringify(detail)).not.toMatch(/raw-before-canary|raw-after-canary|fingerprint/);
    expect(detail.planReview?.view.resources[0].changes).toEqual([{ path: "bucket", forcesReplacement: false }, { path: "password", sensitive: true, forcesReplacement: false }]);
    expect(detail.operation.approvalRound).toBe(1);
    await expect(h.broker.getOperationDetail({ workspaceId: h.ids.wsB, operationId: op.id, principal: user("mallory") })).rejects.toMatchObject({ code: "not_found" });
    const summary = artifact().summary; expect(projectPlanReview(summary, plan.planDigest)?.cost).toEqual({});
    expect(projectPlanReview({ ...summary, view: {} }, plan.planDigest)).toBeUndefined();
    expect(projectPlanReview({ ...summary, stage: "final_plan" }, plan.planDigest)).toBeUndefined();
    expect(projectPlanReview(summary, "b".repeat(64))).toBeUndefined();
  });
  it("refuses missing/simulated evidence and expires an unanswered plan round", async () => {
    const { h, op, suspend, decide, ports } = await running(); await suspend();
    await h.db!.query("update platform.evidence set simulated = true where workspace_id = $1 and operation_id = $2", [h.ids.wsA, op.id]);
    await expect(decide("erin", plan.planDigest)).rejects.toMatchObject({ code: "invalid_state" });
    await h.expireOperation(op.id); await ports.transition({ workspaceId: h.ids.wsA, operationId: op.id, to: "expired" });
    expect((await h.store.getOperation(h.ids.wsA, op.id))?.status).toBe("expired");
  });
});
