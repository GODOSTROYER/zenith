/**
 * mixedParentWorkflow (PROD-MIX-02) on a real Temporal server (the suite starts its
 * own; it skips with the reason when none can start, and ZENITH_TEST_TEMPORAL=1 makes
 * that a failure). The mixed activities are SCRIPTED here: what the real ones decide
 * is covered against the platform database in tests/controlplane/mixed-parent-plans.test.ts.
 * This file proves the durable shell: children run one at a time in dependency order,
 * a refusal or a failed child stops everything after it, nothing is compensated, the
 * waiting path loops without advancing early, cancellation settles the plan, and no
 * credential-like key ever enters workflow history.
 */
import { describe, expect } from "vitest";
import { ApplicationFailure, CancelledFailure, Context } from "@temporalio/activity";
import { WORKFLOW_ID, WORKFLOW_TYPES, type WorkflowResult } from "@/lib/workflows/types";
import type { MixedActivities, MixedAdvance, MixedChildOutcome, MixedObservation, MixedParentWorkflowInput } from "@/lib/workflows/definitions/mixedParent";
import { findCredentialKeys, serverSuite, uniqueId, waitFor, type Harness } from "./support";

const { scenario } = serverSuite("local", { concurrent: true });

const ORDER = [{ partitionId: "partition/a", ordinal: 0 }, { partitionId: "partition/b", ordinal: 1 }, { partitionId: "partition/c", ordinal: 2 }];
const input = (operationId = uniqueId("opm")): MixedParentWorkflowInput => ({ workspaceId: "ws-1", operationId, environmentId: "env-parent", parentPlanId: "mpp_test" });

interface Script {
  advance?: (partitionId: string, call: number) => MixedAdvance;
  observe?: (partitionId: string, call: number) => MixedObservation | Promise<MixedObservation>;
  verify?: () => Awaited<ReturnType<MixedActivities["verifyMixedParent"]>>;
}

function install(h: Harness, script: Script) {
  const log = { advance: [] as string[], observe: [] as string[], settle: [] as { outcome: string; reason: string }[], verify: 0 };
  const count: Record<string, number> = {};
  const impl: MixedActivities = {
    async verifyMixedParent() {
      log.verify += 1;
      return script.verify ? script.verify() : { order: ORDER, childSetDigest: "d".repeat(64) };
    },
    async advanceMixedChild(i) {
      log.advance.push(i.partitionId);
      count[`a:${i.partitionId}`] = (count[`a:${i.partitionId}`] ?? 0) + 1;
      return script.advance ? script.advance(i.partitionId, count[`a:${i.partitionId}`]) : { state: "started" };
    },
    async awaitMixedChild(i) {
      Context.current().heartbeat({ phase: "observing" });
      log.observe.push(i.partitionId);
      count[`o:${i.partitionId}`] = (count[`o:${i.partitionId}`] ?? 0) + 1;
      return script.observe ? script.observe(i.partitionId, count[`o:${i.partitionId}`]) : { state: "succeeded" };
    },
    async settleMixedParent(i) {
      log.settle.push({ outcome: i.outcome, reason: i.reason });
      return { status: i.outcome };
    },
  };
  Object.assign(h.fake.activities as unknown as Record<string, unknown>, impl);
  return log;
}

const start = (h: Harness, value: MixedParentWorkflowInput) => h.client.workflow.start(WORKFLOW_TYPES.mixedParent, { workflowId: WORKFLOW_ID(value.operationId), taskQueue: h.taskQueue, args: [value] });
const run = async (h: Harness, value: MixedParentWorkflowInput): Promise<WorkflowResult> => (await (await start(h, value)).result()) as WorkflowResult;

describe("mixedParentWorkflow", () => {
  scenario("runs every child in dependency order, one at a time, and settles succeeded", async (h) => {
    const log = install(h, {});
    const result = await h.run(() => run(h, input()));
    expect(result.status).toBe("succeeded");
    expect(log.advance).toEqual(["partition/a", "partition/b", "partition/c"]);
    expect(log.observe).toEqual(["partition/a", "partition/b", "partition/c"]);
    expect(log.settle).toEqual([{ outcome: "succeeded", reason: "all children succeeded" }]);
    expect(log.verify).toBe(1);
    expect(h.fake.statuses.at(-1)).toMatchObject({ status: "succeeded" });
    expect(result.steps.map((s) => s.step)).toEqual(expect.arrayContaining(["validate", "lease", "execute_capability", "finalize", "release"]));
    expect(h.fake.callsTo("releaseLease")).toHaveLength(1);
    expect(findCredentialKeys(h.fake.calls.map((call) => call.input))).toEqual([]);
  });

  scenario("a child that already succeeded at advance time is not observed again", async (h) => {
    const log = install(h, { advance: (partitionId) => (partitionId === "partition/a" ? { state: "succeeded" } : { state: "started" }) });
    const result = await h.run(() => run(h, input()));
    expect(result.status).toBe("succeeded");
    expect(log.observe).toEqual(["partition/b", "partition/c"]);
  });

  for (const outcome of ["failed", "cancelled", "uncertain"] as const) {
    scenario(`a ${outcome} child stops the parent; later children are never advanced and nothing is rolled back`, async (h) => {
      const log = install(h, { observe: (partitionId) => ({ state: (partitionId === "partition/b" ? outcome : "succeeded") as MixedChildOutcome }) });
      const result = await h.run(() => run(h, input()));
      expect(result.status).toBe(outcome === "failed" ? "failed" : outcome);
      expect(log.advance).toEqual(["partition/a", "partition/b"]);
      expect(log.settle).toHaveLength(1);
      expect(log.settle[0].outcome).toBe(outcome);
      expect(result.error).toMatch(/remaining children were not started/);
      expect(result.error).toMatch(/nothing was rolled back/i);
      // no destructive or compensating activity exists in this workflow's vocabulary
      expect(h.fake.names().filter((name) => /destroy|rollback|compensate/i.test(name))).toEqual([]);
    });
  }

  scenario("a refused plan fails cleanly before any child is advanced", async (h) => {
    const log = install(h, { verify: () => { throw ApplicationFailure.nonRetryable("A mixed plan runs only on a person's approval of exactly its child set; none is recorded.", "StepFailed"); } });
    const result = await h.run(() => run(h, input()));
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/approval/);
    expect(log.advance).toEqual([]);
    expect(log.settle).toEqual([{ outcome: "failed", reason: "the parent stopped before every child ran" }]);
    expect(h.fake.callsTo("acquireLease")).toHaveLength(0);
  });

  scenario("a blocked child fails the parent with the reason and starts nothing after it", async (h) => {
    const log = install(h, { advance: (partitionId) => (partitionId === "partition/b" ? { state: "blocked", reason: "dependency_not_succeeded" } : { state: "started" }) });
    const result = await h.run(() => run(h, input()));
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/dependency_not_succeeded/);
    expect(log.advance).toEqual(["partition/a", "partition/b"]);
  });

  scenario("waits for a child's own approval: advance only again once the observation says it may proceed", async (h) => {
    const log = install(h, {
      advance: (partitionId, call) => (partitionId === "partition/a" && call === 1 ? { state: "waiting" } : { state: "started" }),
      observe: (partitionId, call) => (partitionId === "partition/a" && call === 1 ? { state: "adopted" } : { state: "succeeded" }),
    });
    const result = await h.run(() => run(h, input()));
    expect(result.status).toBe("succeeded");
    expect(log.advance.filter((id) => id === "partition/a")).toHaveLength(2);
    expect(log.advance).toEqual(["partition/a", "partition/a", "partition/b", "partition/c"]);
  });

  scenario("a started child that keeps running is observed again without a second advance", async (h) => {
    const log = install(h, { observe: (partitionId, call) => (partitionId === "partition/a" && call < 3 ? { state: "started" } : { state: "succeeded" }) });
    const result = await h.run(() => run(h, input()));
    expect(result.status).toBe("succeeded");
    expect(log.observe.filter((id) => id === "partition/a")).toHaveLength(3);
    expect(log.advance.filter((id) => id === "partition/a")).toHaveLength(1);
  });

  scenario("an unclassified activity error after a child started is uncertain, not failed", async (h) => {
    install(h, { observe: async (partitionId) => { if (partitionId === "partition/a") throw ApplicationFailure.nonRetryable("store unavailable", "SomethingElse"); return { state: "succeeded" }; } });
    const result = await h.run(() => run(h, input()));
    expect(result.status).toBe("uncertain");
  });

  scenario("cancel while a child runs: the parent ends cancelled, settles, and cancels nothing in any cloud", async (h) => {
    const log = install(h, {});
    let observing = false;
    (h.fake.activities as unknown as Record<string, unknown>).awaitMixedChild = async () => {
      const context = Context.current();
      observing = true;
      await new Promise<void>((resolve) => {
        const beat = setInterval(() => context.heartbeat({ waiting: true }), 200);
        context.cancellationSignal.addEventListener("abort", () => { clearInterval(beat); resolve(); }, { once: true });
      });
      throw new CancelledFailure(undefined);
    };
    await h.run(async () => {
      const handle = await start(h, input());
      await waitFor("the child observation to start", () => observing);
      await handle.cancel();
      expect(await handle.result()).toMatchObject({ status: "cancelled" });
      expect(log.settle).toEqual([{ outcome: "cancelled", reason: "the parent stopped before every child ran" }]);
      expect(h.fake.names().filter((name) => /destroy|rollback|compensate/i.test(name))).toEqual([]);
    });
  });
});
