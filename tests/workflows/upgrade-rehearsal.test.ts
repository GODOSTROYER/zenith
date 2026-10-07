/**
 * PROD-OPS-03 upgrade rehearsal: an OLD worker build starts workflows, goes away
 * while they are in flight, and a NEW worker build on the SAME task queue carries
 * them to completion. This is the rolling worker upgrade, run on a real local
 * Temporal server with scripted activities (so it proves workflow compatibility and
 * the patch contract, not any cloud effect).
 *
 * "Old" is a frozen earlier workflow source (tests/workflows/fixtures/legacy-*.ts,
 * recorded before the durable-build and ECS-repair patches); "new" is the current
 * definitions bundle. The reverse direction (new histories on old code) is NOT
 * asserted here: Temporal does not promise it, which is exactly why a rollback
 * across a patch needs worker deployment versioning (PINNED) or a drained window;
 * see docs/platform/operations/ROLLING-UPGRADES.md.
 *
 * Schema N-1/N is rehearsed in tests/controlplane/migration-compat.test.ts and
 * runner protocol N-1/N in tests/runners/protocol-window.test.ts.
 */
import path from "node:path";
import { describe, expect } from "vitest";
import type { WorkflowHandle } from "@temporalio/client";
import { WORKFLOW_ID, WORKFLOW_TYPES, type WorkflowResult } from "@/lib/workflows/types";
import { signalApproval } from "@/lib/workflows/client";
import { createFakeActivities, type FakeActivities } from "@/lib/workflows/activities/fake";
import { createExecutionWorker } from "../../workers/execution/run";
import { executionWorkerConfigFromEnv } from "../../workers/execution/config";
import { deployInput, serverSuite, waitForStatus, workflowBundlePath, type Harness } from "./support";

const { scenario } = serverSuite("local");

/** Poll `taskQueue` with the given build for the duration of `body`. */
async function withBuild<T>(h: Harness, bundle: string, fake: FakeActivities, taskQueue: string, body: () => Promise<T>): Promise<T> {
  const config = executionWorkerConfigFromEnv({
    ZENITH_TEMPORAL_ADDRESS: h.server.env.address,
    ZENITH_TEMPORAL_NAMESPACE: h.server.env.namespace ?? "default",
    ZENITH_WORKER_TASK_QUEUE: taskQueue,
    ZENITH_WORKER_SHUTDOWN_GRACE_MS: "2000",
    ZENITH_WORKER_HEARTBEAT_THROTTLE_MS: "300",
  });
  const worker = await createExecutionWorker({ config, connection: h.server.env.nativeConnection, activities: fake.activities, workflows: { workflowBundle: { codePath: bundle }, origin: "prebuilt-bundle" } });
  return worker.runUntil(body());
}

const markersOf = async (handle: WorkflowHandle): Promise<Set<string>> => {
  const history = await handle.fetchHistory();
  const markers = new Set<string>();
  // Read the pinned Core marker payload from the actual history, without whole-history protobuf conversion.
  for (const event of history.events ?? []) {
    const marker = event.markerRecordedEventAttributes;
    if (marker?.markerName !== "core_patch") continue;
    expect(Object.keys(marker.details ?? {})).toEqual(["patch-data"]);
    const payloads = marker.details?.["patch-data"]?.payloads;
    expect(payloads).toHaveLength(1);
    const payload = payloads?.[0];
    if (!payload?.data || !payload.metadata?.encoding) throw new Error("The actual patch marker payload is missing.");
    expect(payload.data).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(payload.metadata.encoding).toString("utf8")).toBe("json/plain");
    const patch = JSON.parse(Buffer.from(payload.data).toString("utf8")) as { id?: unknown; deprecated?: unknown };
    if (typeof patch?.id !== "string" || typeof patch.deprecated !== "boolean") throw new Error("The actual patch marker payload has an unexpected shape.");
    expect(patch).toEqual({ id: patch.id, deprecated: patch.deprecated });
    expect(patch.id.length).toBeGreaterThan(0);
    markers.add(patch.id);
  }
  return markers;
};

function approvalsFor(fake: FakeActivities): Set<string> {
  const approved = new Set<string>();
  fake.setResult("checkApproval", ({ operationId }) => ({
    approved: approved.has(operationId), rejected: false,
    ...(approved.has(operationId) ? { approvalId: `approval-${operationId}` } : {}),
  }));
  return approved;
}

describe("rolling worker upgrade with in-flight workflows", () => {
  scenario("a deploy waiting for approval on the OLD build is finished by the NEW build, which takes the patched branch only after replay", async (h) => {
    const fake = createFakeActivities();
    const approved = approvalsFor(fake);
    fake.setResult("evaluatePolicy", { outcome: "require_approval", decisionId: "d-rehearsal", reasons: ["prod"] });
    const oldBundle = await workflowBundlePath(path.resolve(__dirname, "fixtures/legacy-build-deploy.ts"));
    const newBundle = await workflowBundlePath();
    const taskQueue = h.taskQueue;
    const input = deployInput();

    // OLD build starts the workflow and leaves it waiting for a human.
    const handle = await withBuild(h, oldBundle, fake, taskQueue, async () => {
      const started = await h.client.workflow.start(WORKFLOW_TYPES.deploy, { workflowId: WORKFLOW_ID(input.operationId), taskQueue, args: [input] });
      await waitForStatus(started, "awaiting_approval");
      return started;
    });
    expect([...await markersOf(handle)], "the old build recorded no durable-build patch marker").not.toContain("durable-build-launch-v1");
    expect(fake.callsTo("applyInfrastructure"), "nothing past approval ran on the old build").toHaveLength(0);

    // The old worker is gone. A human approves while NO worker is polling; the signal waits in history.
    approved.add(input.operationId);
    await signalApproval(input.operationId, { client: h.client });

    // The NEW build picks the same queue up, replays the old history deterministically and finishes it.
    const result = await withBuild(h, newBundle, fake, taskQueue, () => handle.result()) as WorkflowResult;
    expect(result.status).toBe("succeeded");
    expect(fake.callsTo("applyInfrastructure")).toHaveLength(1);
    expect(fake.callsTo("buildArtifacts")).toHaveLength(1);
    expect([...await markersOf(handle)], "post-replay the new build records its patch marker").toContain("durable-build-launch-v1");
  }, 120_000);

  scenario("a workflow started by the old build and a workflow started by the new build both complete on the new build", async (h) => {
    const fake = createFakeActivities();
    const approved = approvalsFor(fake);
    fake.setResult("evaluatePolicy", { outcome: "require_approval", decisionId: "d-mixed", reasons: [] });
    const oldBundle = await workflowBundlePath(path.resolve(__dirname, "fixtures/legacy-build-deploy.ts"));
    const newBundle = await workflowBundlePath();
    const taskQueue = h.taskQueue;
    const oldInput = deployInput();
    const newInput = deployInput();
    const oldHandle = await withBuild(h, oldBundle, fake, taskQueue, async () => {
      const started = await h.client.workflow.start(WORKFLOW_TYPES.deploy, { workflowId: WORKFLOW_ID(oldInput.operationId), taskQueue, args: [oldInput] });
      await waitForStatus(started, "awaiting_approval");
      return started;
    });
    approved.add(oldInput.operationId);
    const results = await withBuild(h, newBundle, fake, taskQueue, async () => {
      await signalApproval(oldInput.operationId, { client: h.client });
      const resumed = await oldHandle.result() as WorkflowResult;
      expect(resumed.status).toBe("succeeded");
      expect(fake.lease.held, "the old run releases its environment before the fresh run starts").toBeUndefined();
      const fresh = await h.client.workflow.start(WORKFLOW_TYPES.deploy, { workflowId: WORKFLOW_ID(newInput.operationId), taskQueue, args: [newInput] });
      await waitForStatus(fresh, "awaiting_approval");
      expect(fake.callsTo("applyInfrastructure").filter(c => (c.input as { operationId: string }).operationId === newInput.operationId)).toHaveLength(0);
      approved.add(newInput.operationId);
      await signalApproval(newInput.operationId, { client: h.client });
      return [resumed, await fresh.result()] as WorkflowResult[];
    });
    expect(results.map((r) => r.status)).toEqual(["succeeded", "succeeded"]);
  }, 120_000);
});
