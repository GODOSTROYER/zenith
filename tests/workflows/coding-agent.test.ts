/**
 * The durable coding-agent workflow (PROD-MACH-06) on a real Temporal server
 * (the suite starts its own; it skips with the reason when none can start, and
 * `ZENITH_TEST_TEMPORAL=1` makes that a failure). Activities are scripted: the
 * agent loop itself is covered in tests/coding-agent; this proves the durable
 * shell: step loop, no state in history, cancellation propagation into the
 * running step, and finalization on cancel and on failure.
 */
import { describe, expect } from "vitest";
import { ApplicationFailure, Context, CancelledFailure } from "@temporalio/activity";
import { WorkflowFailedError } from "@temporalio/client";
import type { CodingAgentActivities, CodingAgentRunInput, CodingAgentStepResult } from "@/lib/workflows/definitions/codingAgent";
import { WORKFLOW_TYPES } from "@/lib/workflows/types";
import { serverSuite, uniqueId, waitFor } from "./support";

const { scenario } = serverSuite("local");
const input = (runId: string): CodingAgentRunInput => ({ contract: "zenith.coding-agent-run.v1", runId, workspaceId: "ws_test" });

function install(h: { fake: { activities: object } }, impl: CodingAgentActivities): void {
  Object.assign(h.fake.activities as Record<string, unknown>, impl);
}

describe("codingAgentRunWorkflow on real Temporal", () => {
  scenario("loops one durable step at a time until the run settles, holding no run state in history", async (h) => {
    const seen: string[] = [];
    let n = 0;
    install(h, {
      async agentStep(i) {
        seen.push(i.runId);
        Context.current().heartbeat({ n });
        n += 1;
        return { status: n < 4 ? "running" : "completed" } as CodingAgentStepResult;
      },
      async agentFinalize() {
        throw new Error("finalize must not run on a normal finish");
      },
    });
    const runId = uniqueId("car");
    const result = await h.run(async () => {
      const handle = await h.client.workflow.start(WORKFLOW_TYPES.codingAgentRun, { workflowId: `car-${runId}`, taskQueue: h.taskQueue, args: [input(runId)] });
      return handle.result();
    });
    expect(result).toEqual({ status: "completed" });
    expect(seen).toEqual([runId, runId, runId, runId]);
  });

  scenario("a budget stop ends the workflow cleanly with the stopped status (resume starts a new workflow)", async (h) => {
    install(h, { agentStep: async () => ({ status: "budget_exhausted" }), agentFinalize: async () => ({ status: "failed" }) });
    const runId = uniqueId("car");
    const result = await h.run(async () => (await h.client.workflow.start(WORKFLOW_TYPES.codingAgentRun, { workflowId: `car-${runId}`, taskQueue: h.taskQueue, args: [input(runId)] })).result());
    expect(result).toEqual({ status: "budget_exhausted" });
  });

  scenario("cancel reaches the running step through its abort signal, then the run is finalized as cancelled", async (h) => {
    const finalized: { outcome: string }[] = [];
    let stepStarted = false;
    let sawAbort = false;
    install(h, {
      async agentStep() {
        const context = Context.current();
        stepStarted = true;
        await new Promise<void>((resolve) => {
          const beat = setInterval(() => context.heartbeat({ waiting: true }), 200);
          context.cancellationSignal.addEventListener("abort", () => { sawAbort = true; clearInterval(beat); resolve(); }, { once: true });
        });
        throw new CancelledFailure(undefined);
      },
      async agentFinalize(i) {
        finalized.push({ outcome: i.outcome });
        return { status: "cancelled" };
      },
    });
    const runId = uniqueId("car");
    await h.run(async () => {
      const handle = await h.client.workflow.start(WORKFLOW_TYPES.codingAgentRun, { workflowId: `car-${runId}`, taskQueue: h.taskQueue, args: [input(runId)] });
      await waitFor("the step to start", () => stepStarted);
      await handle.cancel();
      await expect(handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);
      expect(sawAbort).toBe(true);
      expect(finalized).toEqual([{ outcome: "cancelled" }]);
    });
  });

  scenario("a step that fails for good finalizes the run as failed (resumable) and fails the workflow", async (h) => {
    const finalized: { outcome: string; detail: string }[] = [];
    install(h, {
      async agentStep() {
        throw ApplicationFailure.nonRetryable("model unavailable", "CodingAgentModelUnavailable");
      },
      async agentFinalize(i) {
        finalized.push({ outcome: i.outcome, detail: i.detail });
        return { status: "failed" };
      },
    });
    const runId = uniqueId("car");
    await h.run(async () => {
      const handle = await h.client.workflow.start(WORKFLOW_TYPES.codingAgentRun, { workflowId: `car-${runId}`, taskQueue: h.taskQueue, args: [input(runId)] });
      await expect(handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);
    });
    expect(finalized).toEqual([{ outcome: "failed", detail: "step_failed" }]);
  });

  scenario("refuses malformed input without running any step", async (h) => {
    let steps = 0;
    install(h, { agentStep: async () => { steps += 1; return { status: "completed" }; }, agentFinalize: async () => ({ status: "failed" }) });
    await h.run(async () => {
      const handle = await h.client.workflow.start(WORKFLOW_TYPES.codingAgentRun, { workflowId: `car-${uniqueId("bad")}`, taskQueue: h.taskQueue, args: [{ contract: "other", runId: "x", workspaceId: "w", extra: true }] });
      await expect(handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);
    });
    expect(steps).toBe(0);
  });
});
