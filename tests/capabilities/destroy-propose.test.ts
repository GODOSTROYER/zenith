/** Real ledger/broker checks; evidence is a recorded fixture, no cloud execution. */
import { describe, expect, it } from "vitest";
import { repos } from "@/lib/controlplane/db";
import { planEvidence } from "@/lib/execution/plan-evidence";
import { createOperationsPort } from "@/lib/execution/platform";
import { createExecutionBroker } from "@/lib/platform/broker";
import { buildPlanFacts } from "@/lib/capabilities/evaluate";
import { makePlan, change } from "../execution/fakes/fixtures";
import { allowDecision, closeSharedPgliteAfterAll, integrationOf, makeHarness, navigator, scriptedEngine, sessionFor, user } from "./support";

closeSharedPgliteAfterAll();
export const destroyFixture = () => makePlan({ changes: [change({ address: "aws_s3_bucket.assets", nodeAddress: "object_store/assets", type: "aws_s3_bucket", action: "delete", destroysData: true })] });

async function reviewed() {
  const h = await makeHarness({ kind: "pglite", engine: scriptedEngine("allow-fixture", () => allowDecision()) });
  const plan = destroyFixture(), facts = buildPlanFacts(plan)!;
  const scope = { workspaceId: h.ids.wsA, projectId: h.ids.projA, environmentId: h.ids.envASbx };
  const source = await h.broker.propose({ capability: "infrastructure.plan", scope }, user("alice"), { plan });
  const summary = { ...planEvidence({ plan, facts, cost: {}, graphDigest: "a".repeat(64), stage: "plan" }).summary,
    destroy: true, destroyAddresses: ["object_store/assets"], statefulDeletes: facts.destroyedStatefulAddresses, retained: ["Secret/ns/keep"] };
  const evidence = await repos.evidence.insert(h.db!, { workspaceId: h.ids.wsA, operationId: source.operation.id, kind: "tofu_plan", digest: plan.planDigest, summary, simulated: false });
  const ctx = { session: sessionFor("alice"), destroyPlan: { operationId: source.operation.id, planDigest: plan.planDigest } };
  const request = { capability: "infrastructure.destroy", scope, input: { environmentId: scope.environmentId } };
  return { h, plan, facts, scope, source, evidence, ctx, request };
}

describe("trusted destroy proposals", () => {
  it("binds server evidence and forces approval even when policy allows", async () => {
    const { h, request, ctx, evidence, plan, facts } = await reviewed();
    const first = await h.broker.propose({ ...request, idempotencyKey: "destroy-review" }, user("alice"), ctx);
    const replay = await h.broker.propose({ ...request, idempotencyKey: "destroy-review" }, user("alice"), ctx);
    expect(first.operation.status).toBe("awaiting_approval");
    expect(first.decision.approval).toEqual({ count: 1, minRole: "admin", separationOfDuties: false });
    const row = await h.store.getOperation(h.ids.wsA, first.operation.id);
    expect(row?.proposal).toMatchObject({ planDigest: plan.planDigest, broker: { plan: facts, destroyPlan: { evidenceId: evidence.id, retained: ["Secret/ns/keep"] } } });
    expect(replay.replayed).toBe(true);
    expect(replay.operation.id).toBe(first.operation.id);
    expect((await h.store.listApprovals(h.ids.wsA, first.operation.id))).toHaveLength(0);
  });
  it("does not accept raw normalized context or body facts as destroy evidence", async () => {
    const { h, request, plan } = await reviewed();
    const checked = await h.broker.check({ ...request, input: { facts: { delete: 0 }, planDigest: plan.planDigest } }, user("alice"), { plan });
    expect(checked.decision.outcome).toBe("deny");
    expect(checked.decision.reasons.map((r) => r.code)).toContain("plan_required");
  });
  it.each(["integration", "navigator"])("never permits %s proposals or approvals", async (kind) => {
    const { h, request, ctx } = await reviewed();
    const actor = kind === "integration" ? integrationOf(h, "intRW") : navigator("alice");
    await h.store.putEnvironmentAutonomy({ workspaceId: h.ids.wsA, environmentId: h.ids.envASbx, autonomyLevel: 5, updatedBy: "alice" });
    const denied = await h.broker.propose(request, actor, ctx);
    expect(denied.operation.status).toBe("denied");
    expect(denied.decision.reasons.map((r) => r.code)).toContain("teardown_human_only");
    const proposed = await h.broker.propose(request, user("alice"), ctx);
    await expect(h.broker.approve({ workspaceId: h.ids.wsA, operationId: proposed.operation.id, proposalDigest: proposed.operation.proposalDigest, approver: actor, session: sessionFor(actor.id) })).rejects.toMatchObject({ code: "approver_not_human" });
  });
  it("requires a matching human browser proof", async () => {
    const { h, request, ctx } = await reviewed();
    await expect(h.broker.propose(request, user("alice"), { ...ctx, session: undefined })).rejects.toMatchObject({ code: "browser_session_required" });
    await expect(h.broker.propose(request, user("alice"), { ...ctx, session: sessionFor("erin") })).rejects.toMatchObject({ code: "browser_session_required" });
  });
  it("refuses another workspace/environment and stale digests", async () => {
    const { h, request, ctx } = await reviewed();
    await expect(h.broker.propose({ ...request, scope: { workspaceId: h.ids.wsB, environmentId: h.ids.envBProd } }, user("alice"), ctx)).rejects.toMatchObject({ code: "not_found" });
    await expect(h.broker.propose({ ...request, scope: { ...request.scope, environmentId: h.ids.envAProd } }, user("alice"), ctx)).rejects.toMatchObject({ code: "not_found" });
    await expect(h.broker.propose(request, user("alice"), { ...ctx, destroyPlan: { ...ctx.destroyPlan, planDigest: "b".repeat(64) } })).rejects.toMatchObject({ code: "invalid_state" });
  });
  it.each(["simulated", "ordinary", "malformed", "final"])("refuses %s planning evidence", async (mode) => {
    const { h, request, ctx, evidence } = await reviewed();
    const summary = { ...evidence.summary, ...(mode === "ordinary" ? { destroy: false } : {}), ...(mode === "malformed" ? { facts: { delete: 0 } } : {}), ...(mode === "final" ? { stage: "final_plan" } : {}) };
    await h.db!.query("update platform.evidence set simulated = $3, summary = $4::jsonb where workspace_id = $1 and id = $2", [h.ids.wsA, evidence.id, mode === "simulated", JSON.stringify(summary)]);
    await expect(h.broker.propose(request, user("alice"), ctx)).rejects.toMatchObject({ code: "invalid_state" });
  });
  it("reports a real current-round human approval id after the workflow plan gate", async () => {
    const { h, request, ctx, evidence, plan } = await reviewed();
    const { operation: op } = await h.broker.propose(request, user("alice"), ctx);
    const decide = (planDigest?: string) => h.broker.approve({ workspaceId: h.ids.wsA, operationId: op.id, proposalDigest: op.proposalDigest, planDigest, approver: user("erin"), session: sessionFor("erin") });
    await decide();
    await h.broker.beginExecution({ workspaceId: h.ids.wsA, operationId: op.id, holder: `workflow:${op.id}`, audience: "worker" });
    await repos.evidence.insert(h.db!, { workspaceId: h.ids.wsA, operationId: op.id, kind: "tofu_plan", digest: plan.planDigest, summary: evidence.summary, simulated: false });
    const worker = createExecutionBroker(h.db!, async () => h.broker), ops = createOperationsPort(h.db!);
    expect((await worker.approvalStatus(op.id)).approved).toBe(false);
    await ops.transition({ workspaceId: h.ids.wsA, operationId: op.id, to: "awaiting_approval" });
    const approved = await decide(plan.planDigest);
    expect(await worker.approvalStatus(op.id)).toMatchObject({ approved: true, rejected: false, approvalId: approved.approval.id });
  });
});
