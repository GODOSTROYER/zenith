/**
 * Time-dependent behaviour: the 24 hour approval window, the periodic approval
 * re-check, and a mutating activity whose worker goes silent. These need the
 * time-skipping test server (`TestWorkflowEnvironment.createTimeSkipping`, the
 * SDK's cached or downloaded test server), because the real waits are hours.
 *
 * The suite skips itself, with the reason, when that server cannot be started.
 * It never uses localhost:7233.
 */

import { describe, expect } from "vitest";
import { APPROVAL_POLL_INTERVAL_MS, APPROVAL_TIMEOUT_MS } from "@/lib/workflows/definitions/policies";
import { WORKFLOW_ID, WORKFLOW_TYPES, type DeployWorkflowInput, type WorkflowResult } from "@/lib/workflows/types";
import { deployInput, serverSuite, waitForStatus, type Harness } from "./support";

// Time skipping is global to the environment: these scenarios run one at a time.
const { scenario, server } = serverSuite("time-skipping");

const start = (h: Harness, input: DeployWorkflowInput) =>
  h.client.workflow.start(WORKFLOW_TYPES.deploy, { workflowId: WORKFLOW_ID(input.operationId), taskQueue: h.taskQueue, args: [input] });

describe("approval window (time-skipping server)", () => {
  scenario("an approval that never arrives expires the operation after 24 hours and applies nothing", async (h) => {
    h.fake.setResult("evaluatePolicy", { outcome: "require_approval", decisionId: "d-1", reasons: ["production"] });
    const result = await h.run(async () => {
      const handle = await start(h, deployInput());
      await waitForStatus(handle, "awaiting_approval");
      return (await handle.result()) as WorkflowResult; // awaiting the result skips the waiting time
    });

    expect(result.status).toBe("expired");
    expect(result.error).toMatch(/No approval was recorded within 24 hours/);
    expect(h.fake.statuses.map((s) => s.status)).toEqual(["running", "awaiting_approval", "expired"]);
    expect(h.fake.callsTo("finalPlan")).toHaveLength(0);
    expect(h.fake.callsTo("applyInfrastructure")).toHaveLength(0);
    // The wait released the lease, and expiry did not take another.
    expect(h.fake.lease.acquired).toHaveLength(1);
    expect(h.fake.lease.released).toHaveLength(1);
    expect(h.fake.lease.held).toBeUndefined();
    // No signal ever came, so every wake-up was the periodic re-check.
    const checks = h.fake.callsTo("checkApproval").length;
    expect(checks).toBeGreaterThanOrEqual(Math.floor(APPROVAL_TIMEOUT_MS / APPROVAL_POLL_INTERVAL_MS));
    expect(checks).toBeLessThanOrEqual(Math.ceil(APPROVAL_TIMEOUT_MS / APPROVAL_POLL_INTERVAL_MS) + 2);
  });

  scenario("an approval recorded without a signal is still noticed by the periodic re-check", async (h) => {
    h.fake.setResult("evaluatePolicy", { outcome: "require_approval", decisionId: "d-1", reasons: [] });
    const result = await h.run(async () => {
      const handle = await start(h, deployInput());
      await waitForStatus(handle, "awaiting_approval");
      h.fake.approve(); // the row is written; the signal is "lost"
      await server().env.sleep(APPROVAL_POLL_INTERVAL_MS + 60_000);
      return (await handle.result()) as WorkflowResult;
    });
    expect(result.status).toBe("succeeded");
    expect(h.fake.callsTo("applyInfrastructure")).toHaveLength(1);
  });
});

// Takes about a minute of REAL time: the test server skips timers, but the 60 s
// heartbeat timeout of a silent activity is waited out. Slow, and worth it: it is
// the evidence for "a crashed worker ends uncertain and the apply is not replayed".
describe("a worker that goes silent mid-apply (time-skipping server)", () => {
  scenario("the heartbeat timeout ends the operation `uncertain`; the apply is not replayed", async (h) => {
    const stalled = h.fake.hold("applyInfrastructure", { heartbeat: false });
    const input = deployInput();
    const result = await h.run(async () => {
      const handle = await start(h, input);
      await stalled.started;
      await server().env.sleep("3 minutes"); // past the 60 s heartbeat timeout
      const r = (await handle.result()) as WorkflowResult;
      stalled.release();
      return r;
    });

    expect(result.status).toBe("uncertain");
    expect(result.error).toMatch(/apply_infrastructure did not complete cleanly and may have acted/);
    expect(result.error).toMatch(/timed out \(HEARTBEAT\)/);
    // One attempt at the Temporal layer: a crash must not silently re-run an apply.
    expect(h.fake.callsTo("applyInfrastructure")).toHaveLength(1);
    expect(h.fake.callsTo("buildArtifacts")).toHaveLength(0);
    expect(h.fake.callsTo("releaseLease")).toHaveLength(1);
    expect(h.fake.statuses.at(-1)).toMatchObject({ status: "uncertain" });
  }, 150_000);
});
