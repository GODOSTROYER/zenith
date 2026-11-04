/** Gated real local Temporal execution/replay; activities are scripted fakes. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@temporalio/client";
import { Worker } from "@temporalio/worker";
import { temporal } from "@temporalio/proto";
import { temporalDataConverterFromEnv } from "@/lib/workflows/codec";
import { createFakeActivities } from "@/lib/workflows/activities/fake";
import { WORKFLOW_ID, WORKFLOW_TYPES } from "@/lib/workflows/types";
import { executionWorkerConfigFromEnv } from "../../workers/execution/config";
import { workerOptions } from "../../workers/execution/run";
import { deployInput, startTestServer, uniqueId, waitForStatus, workflowBundlePath, type TestServer } from "./support";

const CURRENT = "11".repeat(32);
const NEXT = "22".repeat(32);
const enabled = process.env.ZENITH_TEST_TEMPORAL === "1";
let server: TestServer | undefined;
let bundle: string;
beforeAll(async () => {
  if (!enabled) return;
  const started = await startTestServer("local");
  server = started.server;
  if (!server) throw new Error(started.skipReason ?? "Required local Temporal test server unavailable");
  bundle = await workflowBundlePath();
}, 240_000);
afterAll(async () => { await server?.teardown(); });

describe.skipIf(!enabled)("codec histories on local Temporal (ZENITH_TEST_TEMPORAL=1)", () => {
  it("encrypts workflow/activity payloads, supports queries/signals and replays with retained keys", async () => {
    if (!server) throw new Error("Required local Temporal test server unavailable");
    const dataConverter = temporalDataConverterFromEnv({ NODE_ENV: "production", ZENITH_SECRET_KEY: CURRENT });
    const client = new Client({ connection: server.env.connection, namespace: server.env.namespace, dataConverter });
    const fake = createFakeActivities();
    fake.setResult("evaluatePolicy", { outcome: "require_approval", decisionId: "d-1", reasons: ["test"] });
    const input = deployInput({ revisionId: "codec-revision-canary" });
    const config = executionWorkerConfigFromEnv({ ZENITH_TEMPORAL_ADDRESS: server.env.address, ZENITH_WORKER_TASK_QUEUE: uniqueId("codec"), ZENITH_WORKER_SHUTDOWN_GRACE_MS: "2000" });
    const worker = await Worker.create({ ...workerOptions({ config, connection: server.env.nativeConnection, activities: fake.activities, workflows: { workflowBundle: { codePath: bundle }, origin: "prebuilt-bundle" } }), dataConverter });
    const handle = await worker.runUntil(async () => {
      const started = await client.workflow.start(WORKFLOW_TYPES.deploy, { workflowId: WORKFLOW_ID(input.operationId), taskQueue: config.taskQueue, args: [input] });
      await waitForStatus(started, "awaiting_approval");
      fake.approve();
      await started.signal("approvalRecorded");
      expect((await started.result()).status).toBe("succeeded");
      return started;
    });
    const history = await handle.fetchHistory();
    expect(history.events!.length).toBeGreaterThan(100);
    expect(Buffer.from(temporal.api.history.v1.History.encode(history).finish()).includes(Buffer.from(input.revisionId))).toBe(false);
    await Worker.runReplayHistory({ workflowBundle: { codePath: bundle }, dataConverter }, history, handle.workflowId);
    const rotated = temporalDataConverterFromEnv({ NODE_ENV: "production", ZENITH_SECRET_KEY: NEXT, ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS: JSON.stringify([CURRENT]) });
    await Worker.runReplayHistory({ workflowBundle: { codePath: bundle }, dataConverter: rotated }, history, handle.workflowId);
    expect(fake.callsTo("applyInfrastructure")).toHaveLength(1);
  }, 90_000);

  it("replays a legacy plaintext history with an encrypted converter", async () => {
    if (!server) throw new Error("Required local Temporal test server unavailable");
    const fake = createFakeActivities();
    const input = deployInput();
    const config = executionWorkerConfigFromEnv({ ZENITH_TEMPORAL_ADDRESS: server.env.address, ZENITH_WORKER_TASK_QUEUE: uniqueId("legacy"), ZENITH_WORKER_SHUTDOWN_GRACE_MS: "2000" });
    const worker = await Worker.create(workerOptions({ config, connection: server.env.nativeConnection, activities: fake.activities, workflows: { workflowBundle: { codePath: bundle }, origin: "prebuilt-bundle" } }));
    const handle = await worker.runUntil(async () => {
      const started = await server!.env.client.workflow.start(WORKFLOW_TYPES.deploy, { workflowId: WORKFLOW_ID(input.operationId), taskQueue: config.taskQueue, args: [input] });
      expect((await started.result()).status).toBe("succeeded");
      return started;
    });
    await Worker.runReplayHistory({ workflowBundle: { codePath: bundle }, dataConverter: temporalDataConverterFromEnv({ ZENITH_SECRET_KEY: CURRENT }) }, await handle.fetchHistory(), handle.workflowId);
  }, 90_000);
});
