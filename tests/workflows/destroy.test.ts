/** Deterministic workflow contracts with a mocked Temporal runtime, not a live worker. */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ApplicationFailure } from "@temporalio/common";

const state = vi.hoisted(() => ({ fns: {} as Record<string, Mock<(...args: unknown[]) => Promise<unknown>>>, options: [] as unknown[], patched: true, onWait: async () => {} }));
vi.mock("@temporalio/workflow", async () => ({
  ...await import("@temporalio/common"),
  proxyActivities: (options: unknown) => { state.options.push(options); return new Proxy({}, { get: (_obj, name: string) => (...args: unknown[]) => state.fns[name](...args) }); },
  ActivityCancellationType: { WAIT_CANCELLATION_COMPLETED: 2 },
  CancellationScope: class {
    static nonCancellable<T>(fn: () => Promise<T>): Promise<T> { return fn(); }
    async run<T>(fn: () => Promise<T>): Promise<T> { return fn(); }
    cancel() {}
  },
  defineSignal: (name: string) => name, defineQuery: (name: string) => name,
  setHandler: vi.fn(), workflowInfo: () => ({ workflowId: "op-destroy-test" }),
  isCancellation: () => false, log: { warn: vi.fn() },
  condition: async () => { await state.onWait(); return true; },
  patched: () => state.patched,
}));

import { infrastructureDestroyWorkflow } from "@/lib/workflows/definitions/destroy";
import { startDestroy } from "@/lib/workflows/client";
import type { Client } from "@temporalio/client";

const input = { operationId: "destroy-test", workspaceId: "ws-1", environmentId: "env-1" };
const plan = { planDigest: "a".repeat(64), delete: 2, create: 0, update: 0, replace: 0, empty: false, destroysData: true };

beforeEach(() => {
  vi.useRealTimers();
  state.patched = true;
  state.onWait = async () => { state.fns.checkApproval.mockResolvedValue({ approved: true, rejected: false }); };
  state.fns = {};
  for (const name of ["recordStep", "markOperation", "renewLease", "releaseLease"]) state.fns[name] = vi.fn(async () => undefined);
  state.fns.acquireLease = vi.fn(async () => ({ scope: "env:env-1", holder: "worker:test:destroy-test", fenceToken: 1 }));
  state.fns.planDestroyInfrastructure = vi.fn(async () => plan);
  state.fns.finalDestroyPlan = vi.fn(async () => plan);
  state.fns.evaluatePolicy = vi.fn(async () => ({ outcome: "require_approval", decisionId: "dec-1", reasons: [] }));
  state.fns.checkApproval = vi.fn(async () => ({ approved: true, rejected: false }));
  state.fns.applyDestroyInfrastructure = vi.fn(async () => ({ deleted: 2 }));
  state.fns.verifyDestroyedInfrastructure = vi.fn(async () => ({ status: "passed", checks: 2, failed: 0 }));
  state.fns.checkTeardownRelease = vi.fn(async () => ({ gated: false }));
});

describe("explicit destroy workflow", () => {
  it("reviews, approves, re-plans, applies and verifies absence", async () => {
    const result = await infrastructureDestroyWorkflow(input);
    expect(result.status).toBe("succeeded");
    expect(state.fns.evaluatePolicy).toHaveBeenCalledWith({ operationId: input.operationId, planDigest: plan.planDigest });
    expect(state.fns.applyDestroyInfrastructure).toHaveBeenCalledWith(expect.objectContaining({ planDigest: plan.planDigest }));
    expect(state.fns.verifyDestroyedInfrastructure).toHaveBeenCalledOnce();
    expect(state.fns.releaseLease).toHaveBeenCalledOnce();
  });
  it("always requires a person even when policy allows unattended work", async () => {
    state.fns.evaluatePolicy.mockResolvedValue({ outcome: "allow", decisionId: "dec-1", reasons: [] });
    state.fns.checkApproval.mockResolvedValueOnce({ approved: false, rejected: false });
    expect((await infrastructureDestroyWorkflow(input)).status).toBe("succeeded");
    expect(state.fns.checkApproval).toHaveBeenCalledTimes(2);
    expect(state.fns.acquireLease).toHaveBeenCalledTimes(2);
    expect(state.fns.releaseLease).toHaveBeenCalledTimes(2);
  });
  it("refuses a changed final plan", async () => {
    state.fns.finalDestroyPlan.mockResolvedValue({ ...plan, planDigest: "b".repeat(64) });
    expect((await infrastructureDestroyWorkflow(input)).status).toBe("failed");
    expect(state.fns.applyDestroyInfrastructure).not.toHaveBeenCalled();
  });
  it("refuses engine plan_changed without retrying the apply", async () => {
    state.fns.applyDestroyInfrastructure.mockRejectedValue(ApplicationFailure.nonRetryable("plan moved", "plan_changed"));
    expect((await infrastructureDestroyWorkflow(input)).status).toBe("failed");
    expect(state.fns.applyDestroyInfrastructure).toHaveBeenCalledOnce();
  });
  it("reports lease loss during teardown as uncertain", async () => {
    state.fns.applyDestroyInfrastructure.mockRejectedValue(ApplicationFailure.nonRetryable("fence moved", "LeaseLost"));
    expect((await infrastructureDestroyWorkflow(input)).status).toBe("uncertain");
    expect(state.fns.verifyDestroyedInfrastructure).not.toHaveBeenCalled();
    expect(state.fns.releaseLease).toHaveBeenCalledOnce();
  });
  it("stops on rejected approval", async () => {
    state.fns.checkApproval.mockResolvedValue({ approved: false, rejected: true });
    expect((await infrastructureDestroyWorkflow(input)).status).toBe("failed");
    expect(state.fns.finalDestroyPlan).not.toHaveBeenCalled();
    expect(state.fns.applyDestroyInfrastructure).not.toHaveBeenCalled();
  });
  it("stops on policy deny", async () => {
    state.fns.evaluatePolicy.mockResolvedValue({ outcome: "deny", decisionId: "dec-1", reasons: ["stateful protected"] });
    expect((await infrastructureDestroyWorkflow(input)).status).toBe("failed");
    expect(state.fns.checkApproval).not.toHaveBeenCalled();
  });
  it("never calls unreadable absence done", async () => {
    state.fns.verifyDestroyedInfrastructure.mockResolvedValue({ status: "unknown", checks: 2, failed: 0 });
    expect((await infrastructureDestroyWorkflow(input)).status).toBe("uncertain");
  });
  it("reports still-present resources as failure", async () => {
    state.fns.verifyDestroyedInfrastructure.mockResolvedValue({ status: "failed", checks: 2, failed: 1 });
    expect((await infrastructureDestroyWorkflow(input)).status).toBe("failed");
  });
  it("gives destroy apply one attempt and waits for completed cancellation", () => {
    expect(state.options).toContainEqual(expect.objectContaining({ retry: expect.objectContaining({ maximumAttempts: 1 }), cancellationType: 2 }));
  });
});

const gate = (state_: "released" | "waiting" | "blocked") => ({ gated: true, state: state_, childIds: ["producer"], parentOperationIds: ["op-parent"] });
const statuses = () => state.fns.markOperation.mock.calls.map(([call]) => (call as { status: string }).status);

describe("mixed teardown release gate (PROD-MIX-04 teardown order)", () => {
  it("runs a destroy outside any mixed teardown as before: no wait, no extra approval round", async () => {
    expect((await infrastructureDestroyWorkflow(input)).status).toBe("succeeded");
    expect(state.fns.checkTeardownRelease).toHaveBeenCalledExactlyOnceWith({ operationId: input.operationId, announce: true });
    expect(statuses()).toEqual(["running", "succeeded"]);
    expect(state.fns.acquireLease).toHaveBeenCalledOnce();
    expect(state.fns.applyDestroyInfrastructure).toHaveBeenCalledOnce();
  });
  it("leaves a history recorded before the gate unchanged", async () => {
    state.patched = false;
    expect((await infrastructureDestroyWorkflow(input)).status).toBe("succeeded");
    expect(state.fns.checkTeardownRelease).not.toHaveBeenCalled();
  });
  it("takes a release that is already in without a wait", async () => {
    state.fns.checkTeardownRelease.mockResolvedValue(gate("released"));
    expect((await infrastructureDestroyWorkflow(input)).status).toBe("succeeded");
    expect(statuses()).toEqual(["running", "succeeded"]);
    expect(state.fns.acquireLease).toHaveBeenCalledOnce();
  });
  it("waits lease-free for the release and the fresh round's approval, then applies", async () => {
    const order: string[] = [];
    state.fns.checkTeardownRelease.mockImplementation(async () => { order.push("check"); return gate(order.filter((c) => c === "check").length < 3 ? "waiting" : "released"); });
    state.fns.applyDestroyInfrastructure.mockImplementation(async () => { order.push("apply"); return { deleted: 2 }; });
    // The approval of the proposal round exists; the fresh round opened by the wait is approved before the release lands.
    state.onWait = async () => {};
    expect((await infrastructureDestroyWorkflow(input)).status).toBe("succeeded");
    expect(order).toEqual(["check", "check", "check", "apply"]);
    expect(state.fns.checkTeardownRelease.mock.calls.map(([call]) => (call as { announce: boolean }).announce)).toEqual([true, false, false]);
    expect(statuses()).toEqual(["running", "awaiting_approval", "running", "succeeded"]);
    // Dropped for the wait, re-taken after it, released at the end.
    expect(state.fns.acquireLease).toHaveBeenCalledTimes(2);
    expect(state.fns.releaseLease).toHaveBeenCalledTimes(2);
    expect(state.fns.recordStep).toHaveBeenCalledWith(expect.objectContaining({ step: "teardown_release", status: "running", detail: expect.stringContaining("producer") }));
  });
  it("does not apply on a release alone: the fresh approval round must be approved too", async () => {
    state.fns.checkTeardownRelease.mockResolvedValueOnce(gate("waiting")).mockResolvedValue(gate("released"));
    let waits = 0;
    state.onWait = async () => { if (++waits === 3) state.fns.checkApproval.mockResolvedValue({ approved: true, rejected: false }); };
    state.fns.checkApproval.mockResolvedValueOnce({ approved: true, rejected: false }).mockResolvedValue({ approved: false, rejected: false });
    expect((await infrastructureDestroyWorkflow(input)).status).toBe("succeeded");
    expect(waits).toBe(3);
    expect(state.fns.applyDestroyInfrastructure).toHaveBeenCalledOnce();
  });
  it("expires without applying when the release never comes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    state.fns.checkTeardownRelease.mockResolvedValue(gate("waiting"));
    state.onWait = async () => { vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000); };
    const result = await infrastructureDestroyWorkflow(input);
    expect(result.status).toBe("expired");
    expect(state.fns.finalDestroyPlan).not.toHaveBeenCalled();
    expect(state.fns.applyDestroyInfrastructure).not.toHaveBeenCalled();
  });
  it("never applies a producer whose release was refused (its consumer stands): the step stays unreleased", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // The release route refused (ordering_blocked); the run still shows the step planned, so every check says waiting.
    state.fns.checkTeardownRelease.mockResolvedValue(gate("waiting"));
    let waits = 0;
    state.onWait = async () => { waits++; state.fns.checkApproval.mockResolvedValue({ approved: true, rejected: false }); if (waits > 3) vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000); };
    expect((await infrastructureDestroyWorkflow(input)).status).toBe("expired");
    expect(state.fns.applyDestroyInfrastructure).not.toHaveBeenCalled();
  });
  it("stops a destroy whose step can never be released (failed or uncertain)", async () => {
    state.fns.checkTeardownRelease.mockResolvedValue(gate("blocked"));
    const result = await infrastructureDestroyWorkflow(input);
    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("cannot be released") });
    expect(state.fns.applyDestroyInfrastructure).not.toHaveBeenCalled();
  });
  it("stops on a rejected fresh round", async () => {
    state.fns.checkTeardownRelease.mockResolvedValue(gate("waiting"));
    state.onWait = async () => { state.fns.checkApproval.mockResolvedValue({ approved: false, rejected: true }); };
    expect((await infrastructureDestroyWorkflow(input)).status).toBe("failed");
    expect(state.fns.applyDestroyInfrastructure).not.toHaveBeenCalled();
  });
  it("fails closed when the mixed lookup is unavailable", async () => {
    state.fns.checkTeardownRelease.mockRejectedValue(ApplicationFailure.nonRetryable("store down", "unavailable"));
    expect((await infrastructureDestroyWorkflow(input)).status).toBe("failed");
    expect(state.fns.finalDestroyPlan).not.toHaveBeenCalled();
    expect(state.fns.applyDestroyInfrastructure).not.toHaveBeenCalled();
  });
});

describe("startDestroy payload boundary", () => {
  it("snapshots only ids and shares operation deduplication", async () => {
    const start = vi.fn(async () => ({ workflowId: "op-destroy-test", firstExecutionRunId: "run-1" }));
    const client = { workflow: { start } } as unknown as Client;
    const payload = { ...input, password: "must-not-enter-history", toJSON: () => ({ password: "leak" }) };
    await startDestroy(payload, { client });
    expect(start).toHaveBeenCalledWith("infrastructureDestroyWorkflow", expect.objectContaining({ workflowId: "op-destroy-test", args: [input] }));
    expect(JSON.stringify(start.mock.calls)).not.toContain("must-not-enter-history");
  });
});
