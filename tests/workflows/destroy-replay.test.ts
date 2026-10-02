/** Real cached Temporal time-skipping server; activities remain scripted contracts. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Worker } from "@temporalio/worker";
import { ApplicationFailure } from "@temporalio/common";
import { createFakeActivities } from "@/lib/workflows/activities/fake";
import type { DestroyActivities } from "@/lib/workflows/definitions/destroy";
import { startDestroy, startDeploy } from "@/lib/workflows/client";
import { deployInput, makeHarness, startTestServer, workflowBundlePath, uniqueId, type TestServer } from "./support";

let server: TestServer | undefined;
let bundle: string;
const enabled = process.env.ZENITH_TEST_TEMPORAL === "1";
beforeAll(async () => {
  if (!enabled) return;
  const result = await startTestServer("time-skipping");
  server = result.server;
  if (!server) throw new Error(result.skipReason ?? "Required time-skipping Temporal test server unavailable");
  bundle = await workflowBundlePath();
}, 90_000);
afterAll(async () => { await server?.teardown(); });

describe.skipIf(!enabled)("real destroy workflow histories (ZENITH_TEST_TEMPORAL=1)", () => {
  for (const kind of ["happy", "plan_changed", "lease_lost", "approval_reject", "unknown_absence"] as const) {
  it(`${kind} runs and replays against the current definitions`, async () => {
    if (!server) throw new Error("Required time-skipping Temporal test server unavailable");
    const fake = createFakeActivities();
    fake.approve();
    if (kind === "approval_reject") fake.activities.checkApproval = async () => ({ approved: false, rejected: true });
    const plan = { planDigest: "a".repeat(64), create: 0, update: 0, delete: 1, replace: 0, empty: false, destroysData: true };
    const calls: string[] = [];
    const extra: DestroyActivities = {
      planDestroyInfrastructure: async () => { calls.push("plan"); return plan; },
      finalDestroyPlan: async () => { calls.push("final"); if (kind === "plan_changed") throw ApplicationFailure.nonRetryable("plan moved", "plan_changed"); return plan; },
      applyDestroyInfrastructure: async () => { calls.push("apply"); if (kind === "lease_lost") throw ApplicationFailure.nonRetryable("fence lost", "LeaseLost"); return { deleted: 1 }; },
      verifyDestroyedInfrastructure: async () => { calls.push("verify"); return { status: kind === "unknown_absence" ? "unknown" : "passed", checks: 1, failed: 0 }; },
    };
    Object.assign(fake.activities, extra);
    const h = makeHarness(server, bundle, fake);
    const input = { operationId: uniqueId("destroy"), workspaceId: "ws-1", environmentId: "env-1" };
    const handle = await h.run(async () => {
      await startDestroy(input, { client: h.client, taskQueue: h.taskQueue });
      const started = h.client.workflow.getHandle(`op-${input.operationId}`);
      const result = await started.result();
      expect(result.status).toBe(kind === "happy" ? "succeeded" : ["lease_lost", "unknown_absence"].includes(kind) ? "uncertain" : "failed");
      return started;
    });
    const history = await handle.fetchHistory();
    await Worker.runReplayHistory({ workflowBundle: { codePath: bundle } }, history, handle.workflowId);
    expect(calls.filter((c) => c === "apply")).toHaveLength(["plan_changed", "approval_reject"].includes(kind) ? 0 : 1);
  }, 90_000);
  }
  it("preserves and replays the deploy command sequence", async () => {
    if (!server) throw new Error("Required time-skipping Temporal test server unavailable");
    const fake = createFakeActivities();
    const h = makeHarness(server, bundle, fake);
    const input = deployInput();
    const handle = await h.run(async () => {
      const started = await startDeploy(input, { client: h.client, taskQueue: h.taskQueue });
      expect((await started.handle.result()).status).toBe("succeeded");
      return started.handle;
    });
    await Worker.runReplayHistory({ workflowBundle: { codePath: bundle } }, await handle.fetchHistory(), handle.workflowId);
    expect(fake.callsTo("applyInfrastructure")).toHaveLength(1);
  }, 90_000);
});
