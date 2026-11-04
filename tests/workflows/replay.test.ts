/**
 * Determinism: histories recorded by the real workflows, captured from a real
 * Temporal server, must replay cleanly against the current workflow code.
 *
 * This is the guard against an unpatched change to a workflow that may still be
 * running somewhere: reorder an activity, add a step, change a timer, and the
 * replay of a history recorded before the change fails with a determinism
 * violation. Changes must go behind `patched("<id>")` (see
 * docs/platform/EXECUTION-WORKER.md).
 *
 * A negative control proves the check has teeth: the same history replayed
 * against a deliberately reordered workflow is rejected.
 *
 * (Histories are captured here, per run, from the current code, so they show
 * the code is replay-deterministic against itself. Freezing histories recorded
 * by a released version as golden files is the next step once a version ships.)
 */

import path from "node:path";
import { describe, expect } from "vitest";
import { Worker } from "@temporalio/worker";
import { DeterminismViolationError } from "@temporalio/workflow";
import type { History } from "@temporalio/common/lib/proto-utils";
import { FAILURE_TYPES, RECONCILE_WORKFLOW_ID, WORKFLOW_ID, WORKFLOW_TYPES } from "@/lib/workflows/types";
import { cancelOperation, signalApproval } from "@/lib/workflows/client";
import { deployInput, uniqueId, serverSuite, waitForStatus, workflowBundlePath, type Harness } from "./support";

const { scenario } = serverSuite("local", { concurrent: true });

const ROOT = path.resolve(__dirname, "../..");

async function bundleFor(entry?: string): Promise<string> {
  return workflowBundlePath(entry);
}

/** Replay `history` against the current definitions; resolves if deterministic. */
async function replay(history: History, workflowId: string, entry?: string): Promise<void> {
  await Worker.runReplayHistory({ workflowBundle: { codePath: await bundleFor(entry) } }, history, workflowId);
}

const needsApproval = (h: Harness): void => h.fake.setResult("evaluatePolicy", { outcome: "require_approval", decisionId: "d-1", reasons: ["prod"] });

describe("replaying histories recorded by the current workflows", () => {
  scenario("deploy: happy path", async (h) => {
    const input = deployInput();
    const handle = await h.run(async () => {
      const started = await h.client.workflow.start(WORKFLOW_TYPES.deploy, { workflowId: WORKFLOW_ID(input.operationId), taskQueue: h.taskQueue, args: [input] });
      await started.result();
      return started;
    });
    const history = await handle.fetchHistory();
    expect(history.events!.length).toBeGreaterThan(100);
    await replay(history, handle.workflowId);
  });

  scenario("deploy: approval wait, signal, and a second lease", async (h) => {
    needsApproval(h);
    const input = deployInput();
    const handle = await h.run(async () => {
      const started = await h.client.workflow.start(WORKFLOW_TYPES.deploy, { workflowId: WORKFLOW_ID(input.operationId), taskQueue: h.taskQueue, args: [input] });
      await waitForStatus(started, "awaiting_approval");
      h.fake.approve();
      await signalApproval(input.operationId, { client: h.client });
      await started.result();
      return started;
    });
    const history = await handle.fetchHistory();
    expect(JSON.stringify(history)).toContain("approvalRecorded");
    await replay(history, handle.workflowId);
  });

  scenario("deploy: a failure path (lease lost during apply)", async (h) => {
    h.fake.failOn("applyInfrastructure", { type: FAILURE_TYPES.leaseLost, message: "fence moved" });
    const input = deployInput();
    const handle = await h.run(async () => {
      const started = await h.client.workflow.start(WORKFLOW_TYPES.deploy, { workflowId: WORKFLOW_ID(input.operationId), taskQueue: h.taskQueue, args: [input] });
      await started.result();
      return started;
    });
    await replay(await handle.fetchHistory(), handle.workflowId);
  });

  scenario("deploy: cancellation mid-flight", async (h) => {
    const held = h.fake.hold("deployWorkloads");
    const input = deployInput();
    const handle = await h.run(async () => {
      const started = await h.client.workflow.start(WORKFLOW_TYPES.deploy, { workflowId: WORKFLOW_ID(input.operationId), taskQueue: h.taskQueue, args: [input] });
      await held.started;
      await cancelOperation(input.operationId, { client: h.client });
      await started.result();
      return started;
    });
    await replay(await handle.fetchHistory(), handle.workflowId);
  });

  scenario("deploy: retried reads (activity attempts do not disturb replay)", async (h) => {
    h.fake.failOn("evaluatePolicy", { message: "temporarily unavailable", times: 2 });
    const input = deployInput();
    const handle = await h.run(async () => {
      const started = await h.client.workflow.start(WORKFLOW_TYPES.deploy, { workflowId: WORKFLOW_ID(input.operationId), taskQueue: h.taskQueue, args: [input] });
      await started.result();
      return started;
    });
    await replay(await handle.fetchHistory(), handle.workflowId);
  }, 90_000);

  scenario("day-two, remediation and reconcile", async (h) => {
    const dayTwo = { operationId: uniqueId("d2"), workspaceId: "ws-1", environmentId: "env-1", capability: "workload.restart" };
    const fix = { operationId: uniqueId("rm"), workspaceId: "ws-1", environmentId: "env-1", incidentId: "inc-1" };
    const pass = { workspaceId: "ws-1", environmentId: uniqueId("env"), allowAutoRepair: true };
    const handles = await h.run(async () => {
      const a = await h.client.workflow.start(WORKFLOW_TYPES.dayTwo, { workflowId: WORKFLOW_ID(dayTwo.operationId), taskQueue: h.taskQueue, args: [dayTwo] });
      await a.result();
      const b = await h.client.workflow.start(WORKFLOW_TYPES.remediation, { workflowId: WORKFLOW_ID(fix.operationId), taskQueue: h.taskQueue, args: [fix] });
      await b.result();
      const c = await h.client.workflow.start(WORKFLOW_TYPES.reconcile, { workflowId: RECONCILE_WORKFLOW_ID(pass.environmentId), taskQueue: h.taskQueue, args: [pass] });
      await c.result();
      return [a, b, c];
    });
    for (const handle of handles) await replay(await handle.fetchHistory(), handle.workflowId);
  });
});

describe("the replay check has teeth", () => {
  scenario("the same history is rejected by a workflow that schedules its activities in a different order", async (h) => {
    const input = deployInput();
    const handle = await h.run(async () => {
      const started = await h.client.workflow.start(WORKFLOW_TYPES.deploy, { workflowId: WORKFLOW_ID(input.operationId), taskQueue: h.taskQueue, args: [input] });
      await started.result();
      return started;
    });
    const history = await handle.fetchHistory();
    await replay(history, handle.workflowId); // fine against the real code
    const reordered = path.join(ROOT, "tests/workflows/fixtures/reordered-deploy.ts");
    await expect(replay(history, handle.workflowId, reordered)).rejects.toBeInstanceOf(DeterminismViolationError);
  });
});
