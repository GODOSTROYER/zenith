/** Real isolated Temporal; scripted activities prove orchestration, not AWS writes. */
import path from "node:path";
import { expect } from "vitest";
import { Worker } from "@temporalio/worker";
import { FAILURE_TYPES, WORKFLOW_ID, WORKFLOW_TYPES, type PlanSummary, type WorkflowResult } from "@/lib/workflows/types";
import { cancelOperation, signalApproval } from "@/lib/workflows/client";
import { makeHarness, serverSuite, uniqueId, waitForStatus, workflowBundlePath, type Harness } from "./support";

const { scenario } = serverSuite("local");
const input = () => ({ operationId: uniqueId("ecs-repair"), workspaceId: "ws-1", environmentId: "env-1", capability: "drift.repair" });
const plan: PlanSummary = { planDigest: "a".repeat(64), create: 0, update: 1, delete: 0, replace: 0, destroysData: false, empty: false };
function configure(h: Harness) {
  h.fake.setResult("planInfrastructure", plan); h.fake.setResult("finalPlan", plan);
  h.fake.setResult("evaluatePolicy", { outcome: "require_approval", decisionId: "repair-human-review", reasons: [] });
}
const start = (h: Harness, request = input()) => h.client.workflow.start(WORKFLOW_TYPES.dayTwo,
  { workflowId: WORKFLOW_ID(request.operationId), taskQueue: h.taskQueue, args: [request] });

scenario("requires concrete plan approval, then exact final plan and one saved-plan apply", async (h) => {
  configure(h); const request = input();
  const handle = await h.run(async () => {
    const handle = await start(h, request); await waitForStatus(handle, "awaiting_approval");
    expect(h.fake.callsTo("applyInfrastructure")).toHaveLength(0);
    expect(h.fake.callsTo("evaluatePolicy")[0].input).toEqual({ operationId: request.operationId, planDigest: plan.planDigest });
    await expect(start(h, request)).rejects.toThrow();
    h.fake.approve(); await signalApproval(request.operationId, { client: h.client }); await handle.result(); return handle;
  });
  const result = await handle.result() as WorkflowResult; expect(result.status).toBe("succeeded");
  expect(h.fake.callsTo("applyInfrastructure")).toHaveLength(1); expect(h.fake.callsTo("executeCapability")).toHaveLength(0);
  expect(h.fake.callsTo("verifyApplication")).toHaveLength(0); expect(h.fake.callsTo("buildArtifacts")).toHaveLength(0);
  expect(h.fake.callsTo("validateDesiredState")).toHaveLength(0);
  expect(h.fake.lease.acquired).toHaveLength(2);
  await Worker.runReplayHistory({ workflowBundle: { codePath: await workflowBundlePath() } }, await handle.fetchHistory(), handle.workflowId);
});
scenario("policy allow alone cannot authorize the concrete repair", async (h) => {
  configure(h); h.fake.setResult("evaluatePolicy", { outcome: "allow", decisionId: "unexpected-allow", reasons: [] });
  const result = await h.run(async () => await (await start(h)).result()) as WorkflowResult;
  expect(result.status).toBe("failed"); expect(h.fake.callsTo("applyInfrastructure")).toHaveLength(0);
});
scenario("moved final plan refuses apply and requires a new review", async (h) => {
  configure(h); h.fake.approve(); h.fake.setResult("finalPlan", { ...plan, planDigest: "b".repeat(64) });
  const result = await h.run(async () => await (await start(h)).result()) as WorkflowResult;
  expect(result.status).toBe("failed"); expect(h.fake.callsTo("applyInfrastructure")).toHaveLength(0);
});
scenario("an unclassified apply response is uncertain and is never retried", async (h) => {
  configure(h); h.fake.approve(); h.fake.failOn("applyInfrastructure", { message: "accepted then response lost" });
  const result = await h.run(async () => await (await start(h)).result()) as WorkflowResult;
  expect(result.status).toBe("uncertain"); expect(h.fake.callsTo("applyInfrastructure")).toHaveLength(1);
  expect(h.fake.callsTo("executeCapability")).toHaveLength(0); expect(h.fake.lease.released).toHaveLength(1);
});
scenario("lost fence after entering apply preserves uncertainty without compensation", async (h) => {
  configure(h); h.fake.approve(); h.fake.failOn("applyInfrastructure", { type: FAILURE_TYPES.leaseLost, message: "fence moved" });
  const result = await h.run(async () => await (await start(h)).result()) as WorkflowResult;
  expect(result.status).toBe("uncertain"); expect(h.fake.callsTo("applyInfrastructure")).toHaveLength(1);
});
for (const cancellation of ["browser-signal", "temporal-cancel"] as const) {
  scenario(`cancellation after entering apply remains blocking uncertainty (${cancellation})`, async (h) => {
    configure(h); h.fake.approve(); const held = h.fake.hold("applyInfrastructure"); const request = input();
    const result = await h.run(async () => {
      const handle = await start(h, request); await held.started;
      if (cancellation === "browser-signal") await cancelOperation(request.operationId, { client: h.client });
      else await handle.cancel();
      return await handle.result() as WorkflowResult;
    });
    expect(result.status).toBe("uncertain"); expect(result.error).toContain("Inspect this operation");
    expect(h.fake.statuses.at(-1)).toMatchObject({ status: "uncertain" });
    expect(h.fake.callsTo("applyInfrastructure")).toHaveLength(1); expect(h.fake.callsTo("executeCapability")).toHaveLength(0);
    expect(result.steps.find((step) => step.step === "finalize")?.status).toBe("pending");
    expect(h.fake.callsTo("releaseLease")).toHaveLength(1);
  });
}
scenario("pre-write cancellation stays cancelled without an apply attempt", async (h) => {
  configure(h); const held = h.fake.hold("planInfrastructure"); const request = input();
  const result = await h.run(async () => {
    const handle = await start(h, request); await held.started; await cancelOperation(request.operationId, { client: h.client });
    return await handle.result() as WorkflowResult;
  });
  expect(result.status).toBe("cancelled"); expect(h.fake.callsTo("applyInfrastructure")).toHaveLength(0);
  expect(h.fake.callsTo("releaseLease")).toHaveLength(1);
});
scenario("a classified cancelled halt after an apply attempt remains uncertain", async (h) => {
  const fixture = path.resolve(__dirname, "fixtures/ecs-replica-cancellation.ts");
  const cancellationHarness = makeHarness(h.server, await workflowBundlePath(fixture), h.fake);
  const request = input();
  const result = await cancellationHarness.run(async () => await (await cancellationHarness.client.workflow.start("classifiedRepairCancellationWorkflow", {
    workflowId: WORKFLOW_ID(request.operationId), taskQueue: cancellationHarness.taskQueue, args: [request],
  })).result()) as WorkflowResult;
  expect(result.status).toBe("uncertain"); expect(h.fake.callsTo("applyInfrastructure")).toHaveLength(1);
  expect(h.fake.statuses.at(-1)).toMatchObject({ status: "uncertain" });
});
scenario("pre-repair cancellation history keeps its legacy terminal classification on replay", async (h) => {
  const fixture = path.resolve(__dirname, "fixtures/legacy-day-two.ts");
  const legacy = makeHarness(h.server, await workflowBundlePath(fixture), h.fake); const held = h.fake.hold("executeCapability"); const request = input();
  const handle = await legacy.run(async () => {
    const handle = await start(legacy, request); await held.started; await cancelOperation(request.operationId, { client: legacy.client });
    expect((await handle.result() as WorkflowResult).status).toBe("cancelled"); return handle;
  });
  await Worker.runReplayHistory({ workflowBundle: { codePath: await workflowBundlePath() } }, await handle.fetchHistory(), handle.workflowId);
});
scenario("histories recorded by the pre-repair day-two workflow replay through the legacy branch", async (h) => {
  const fixture = path.resolve(__dirname, "fixtures/legacy-day-two.ts");
  const legacy = makeHarness(h.server, await workflowBundlePath(fixture), h.fake);
  const handle = await legacy.run(async () => { const handle = await start(legacy); await handle.result(); return handle; });
  expect(h.fake.callsTo("executeCapability")).toHaveLength(1);
  expect(h.fake.callsTo("planInfrastructure")).toHaveLength(0);
  await Worker.runReplayHistory({ workflowBundle: { codePath: await workflowBundlePath() } }, await handle.fetchHistory(), handle.workflowId);
});
