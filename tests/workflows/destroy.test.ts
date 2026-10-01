/** Deterministic workflow contracts with a mocked Temporal runtime, not a live worker. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationFailure } from "@temporalio/common";

const state = vi.hoisted(() => ({ fns: {} as Record<string, ReturnType<typeof vi.fn>>, options: [] as unknown[] }));
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
  condition: async () => { state.fns.checkApproval.mockResolvedValue({ approved: true, rejected: false }); return true; },
}));

import { infrastructureDestroyWorkflow } from "@/lib/workflows/definitions/destroy";
import { startDestroy } from "@/lib/workflows/client";
import type { Client } from "@temporalio/client";

const input = { operationId: "destroy-test", workspaceId: "ws-1", environmentId: "env-1" };
const plan = { planDigest: "a".repeat(64), delete: 2, create: 0, update: 0, replace: 0, empty: false, destroysData: true };

beforeEach(() => {
  state.fns = {};
  for (const name of ["recordStep", "markOperation", "renewLease", "releaseLease"]) state.fns[name] = vi.fn(async () => undefined);
  state.fns.acquireLease = vi.fn(async () => ({ scope: "env:env-1", holder: "worker:test:destroy-test", fenceToken: 1 }));
  state.fns.planDestroyInfrastructure = vi.fn(async () => plan);
  state.fns.finalDestroyPlan = vi.fn(async () => plan);
  state.fns.evaluatePolicy = vi.fn(async () => ({ outcome: "require_approval", decisionId: "dec-1", reasons: [] }));
  state.fns.checkApproval = vi.fn(async () => ({ approved: true, rejected: false }));
  state.fns.applyDestroyInfrastructure = vi.fn(async () => ({ deleted: 2 }));
  state.fns.verifyDestroyedInfrastructure = vi.fn(async () => ({ status: "passed", checks: 2, failed: 0 }));
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
