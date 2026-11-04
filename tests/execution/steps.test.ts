/**
 * recordStep, markOperation and the lease activities.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationFailure } from "@temporalio/activity";
import { LeaseBusyError, LeaseLostError, StepFailedError } from "@/lib/execution/errors";
import { deploymentStatusForStep } from "@/lib/execution/steps";
import type { StepName } from "@/lib/workflows/types";
import { CANARY_SECRET, DEPLOYMENT, ENV, OP, WS } from "./fakes/fixtures";
import { createWorld, type World } from "./fakes/world";

const worlds: World[] = [];
const world = (...args: Parameters<typeof createWorld>): World => {
  const w = createWorld(...args);
  worlds.push(w);
  return w;
};
afterEach(() => {
  while (worlds.length) worlds.pop()!.dispose();
});

describe("recordStep", () => {
  it("projects the step onto the deployment the operation names, with the detail scrubbed", async () => {
    const w = world();
    await w.activities.recordStep({ operationId: OP, step: "plan", status: "running" });
    await w.activities.recordStep({ operationId: OP, deploymentId: DEPLOYMENT, step: "plan", status: "done", detail: `2 create · token=${CANARY_SECRET}\nline two` });
    expect(w.product.steps).toEqual([
      { deploymentId: DEPLOYMENT, step: "plan", status: "running", deploymentStatus: "planning" },
      { deploymentId: DEPLOYMENT, step: "plan", status: "done", detail: expect.stringContaining("2 create") },
    ]);
    expect(JSON.stringify(w.product.steps)).not.toContain(CANARY_SECRET);
    expect(w.product.steps[1].detail).not.toMatch(/\n/);
    expect(w.ops.heartbeats).toBe(2); // the operation is alive as long as its worker talks about it
  });

  it("sets the deployment status only when a step starts running", async () => {
    const w = world();
    await w.activities.recordStep({ operationId: OP, step: "apply_infrastructure", status: "running" });
    await w.activities.recordStep({ operationId: OP, step: "apply_infrastructure", status: "done" });
    expect(w.product.steps.map((s) => s.deploymentStatus)).toEqual(["applying", undefined]);
  });

  it("maps every step to the status the UI should show", () => {
    const expected: Record<StepName, string | undefined> = {
      validate: "planning",
      lease: "planning",
      credentials: "planning",
      plan: "planning",
      policy: "planning",
      final_plan: "planning",
      approval: "awaiting_approval",
      apply_network: "applying",
      apply_data: "applying",
      apply_infrastructure: "applying",
      build: "applying",
      publish: "applying",
      deploy: "applying",
      secrets: "applying",
      ingress: "applying",
      dns_tls: "applying",
      migrate: "applying",
      execute_capability: "applying",
      verify_infrastructure: "verifying",
      verify_application: "verifying",
      observe: "verifying",
      finalize: undefined,
      release: undefined,
    };
    for (const [step, status] of Object.entries(expected)) expect(deploymentStatusForStep(step as StepName), step).toBe(status);
  });

  it("does nothing for an operation with no deployment (day two), an unknown operation, or a deployment id that is not the operation's", async () => {
    const w = world({ op: { proposal: { capability: "service.restart", scope: { workspaceId: WS }, input: { replicas: 2 }, summary: "s", details: [], risk: "low" } } });
    await w.activities.recordStep({ operationId: OP, step: "lease", status: "running" });
    await w.activities.recordStep({ operationId: "op-missing", step: "lease", status: "running" });
    expect(w.product.steps).toEqual([]);

    const bound = world();
    await bound.activities.recordStep({ operationId: OP, deploymentId: "dep-someone-elses", step: "lease", status: "running" });
    expect(bound.product.steps).toEqual([]);
    expect(bound.logs.some((l) => l.message.includes("does not match the operation's"))).toBe(true);
  });
});

describe("markOperation", () => {
  it("claims an approved operation when the workflow marks it running, and projects 'planning'", async () => {
    const w = world();
    await w.activities.markOperation({ operationId: OP, status: "running" });
    expect(w.ops.ops.get(OP)!.status).toBe("running");
    expect(w.product.statuses).toEqual(["planning"]);
    expect(w.events.ofType("operation.started")).toHaveLength(1);
    await w.activities.markOperation({ operationId: OP, status: "running" }); // idempotent
    expect(w.events.ofType("operation.started")).toHaveLength(1);
  });

  it("moves a running operation to awaiting_approval and back", async () => {
    const w = world();
    await w.activities.markOperation({ operationId: OP, status: "running" });
    await w.activities.markOperation({ operationId: OP, status: "awaiting_approval" });
    expect(w.ops.ops.get(OP)!.status).toBe("awaiting_approval");
    expect(w.product.statuses.at(-1)).toBe("awaiting_approval");
  });

  it("commits a success to the ledger and the deployment and announces it once", async () => {
    const w = world();
    await w.activities.markOperation({ operationId: OP, status: "running" });
    await w.activities.markOperation({ operationId: OP, status: "succeeded" });
    await w.activities.markOperation({ operationId: OP, status: "succeeded" });
    expect(w.ops.ops.get(OP)!.status).toBe("succeeded");
    expect(w.product.outcomes[0]).toEqual({ deploymentId: DEPLOYMENT, outcome: "succeeded" });
    expect(w.events.ofType("deployment.healthy")).toHaveLength(1);
    expect(w.events.ofType("operation.succeeded")).toHaveLength(1);
  });

  it.each([
    ["failed", "failed", "deployment.unhealthy"],
    ["uncertain", "uncertain", "deployment.unhealthy"],
  ] as const)("ends %s with a scrubbed error and a deployment.unhealthy event", async (status, outcome, event) => {
    const w = world();
    await w.activities.markOperation({ operationId: OP, status: "running" });
    await w.activities.markOperation({ operationId: OP, status, error: `apply failed token=${CANARY_SECRET}` });
    expect(w.ops.ops.get(OP)!.status).toBe(status);
    expect(w.product.outcomes.at(-1)).toMatchObject({ deploymentId: DEPLOYMENT, outcome });
    expect(w.product.outcomes.at(-1)!.error).not.toContain(CANARY_SECRET);
    expect(w.events.ofType(event)).toHaveLength(1);
    expect(JSON.stringify(w.ops.ops.get(OP))).not.toContain(CANARY_SECRET);
  });

  it("never reports success for an operation the ledger already ended differently (the reconciler marked it uncertain)", async () => {
    const w = world();
    await w.activities.markOperation({ operationId: OP, status: "running" });
    await w.ops.markUncertain({ workspaceId: WS, operationId: OP, reason: "the executor stopped reporting" });
    await w.activities.markOperation({ operationId: OP, status: "succeeded" });
    expect(w.ops.ops.get(OP)!.status).toBe("uncertain");
    expect(w.product.outcomes.at(-1)!.outcome).toBe("uncertain"); // the deployment shows what the ledger holds
    expect(w.events.ofType("deployment.healthy")).toHaveLength(0);
    expect(w.logs.some((l) => l.message.includes("the ledger kept a different status"))).toBe(true);
  });

  it("records cancelled and expired as their own outcomes", async () => {
    const a = world();
    await a.activities.markOperation({ operationId: OP, status: "running" });
    await a.activities.markOperation({ operationId: OP, status: "cancelled", error: "Cancelled by request." });
    expect(a.product.outcomes.at(-1)).toMatchObject({ outcome: "cancelled" });

    const b = world();
    await b.activities.markOperation({ operationId: OP, status: "running" });
    await b.activities.markOperation({ operationId: OP, status: "awaiting_approval" });
    await b.activities.markOperation({ operationId: OP, status: "expired", error: "No approval in 24 h." });
    expect(b.product.outcomes.at(-1)).toMatchObject({ outcome: "expired" });
  });

  it("fails permanently for an unknown operation and transiently while the ledger is down (the workflow retries the terminal write)", async () => {
    const w = world();
    await expect(w.activities.markOperation({ operationId: "op-missing", status: "running" })).rejects.toBeInstanceOf(StepFailedError);
    w.ops.failTransitions = 1;
    const err = await w.activities.markOperation({ operationId: OP, status: "running" }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ApplicationFailure); // plain → retried
    await w.activities.markOperation({ operationId: OP, status: "running" }); // the retry lands
    expect(w.ops.ops.get(OP)!.status).toBe("running");
  });

  it("projects nothing for an operation that names no deployment, but still moves the ledger", async () => {
    const w = world({ op: { proposal: { capability: "service.restart", scope: { workspaceId: WS }, input: {}, summary: "s", details: [], risk: "low" } } });
    await w.activities.markOperation({ operationId: OP, status: "running" });
    await w.activities.markOperation({ operationId: OP, status: "succeeded" });
    expect(w.ops.ops.get(OP)!.status).toBe("succeeded");
    expect(w.product.outcomes).toEqual([]);
  });
});

describe("lease activities", () => {
  it("acquires env:<environment> for the operation, holder worker:<id>:<op>, and emits lease.acquired", async () => {
    const w = world();
    const lease = await w.lease();
    expect(lease).toEqual({ scope: `env:${ENV}`, holder: `worker:test-worker:${OP}`, fenceToken: 1 });
    expect(w.leases.acquireCalls[0]).toMatchObject({ scope: `env:${ENV}`, ttlMs: 300_000, workspaceId: WS });
    expect(w.events.ofType("lease.acquired")).toHaveLength(1);
  });

  it("raises a non-retryable LeaseBusy when another operation holds the environment, and leaves that lease alone", async () => {
    const w = world();
    w.leases.steal(`env:${ENV}`, "worker:other:op-other");
    const err = await w.lease().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeaseBusyError);
    expect((err as ApplicationFailure).type).toBe("LeaseBusy");
    expect((err as ApplicationFailure).nonRetryable).toBe(true);
    expect(w.leases.state.get(`env:${ENV}`)!.holder).toBe("worker:other:op-other");
  });

  it("re-acquiring after a retry gives the same holder a NEW fence, making the old value stale", async () => {
    const w = world();
    const first = await w.lease();
    const second = await w.lease();
    expect(second.fenceToken).toBe(first.fenceToken + 1);
    await expect(w.leases.assertFence(first.scope, first.fenceToken)).rejects.toBeInstanceOf(LeaseLostError);
  });

  it("refuses a scope that is not this operation's environment, and an unusable ttl", async () => {
    const w = world();
    await expect(w.activities.acquireLease({ operationId: OP, scope: "env:some-other-env", ttlMs: 60_000 })).rejects.toBeInstanceOf(StepFailedError);
    await expect(w.activities.acquireLease({ operationId: OP, scope: "connection:c1", ttlMs: 60_000 })).rejects.toBeInstanceOf(StepFailedError);
    await expect(w.activities.acquireLease({ operationId: OP, scope: `env:${ENV}`, ttlMs: 0 })).rejects.toBeInstanceOf(StepFailedError);
    await expect(w.activities.acquireLease({ operationId: OP, scope: `env:${ENV}`, ttlMs: 10 * 3_600_000 })).rejects.toBeInstanceOf(StepFailedError);
    await expect(w.activities.acquireLease({ operationId: "op-missing", scope: `env:${ENV}`, ttlMs: 60_000 })).rejects.toBeInstanceOf(StepFailedError);
    expect(w.leases.acquireCalls).toHaveLength(0);
  });

  it("takes a reconcile lease only for the matching pass id and a known environment", async () => {
    const w = world();
    const lease = await w.activities.acquireLease({ operationId: `reconcile-${ENV}`, scope: `reconcile:${ENV}`, ttlMs: 60_000 });
    expect(lease.holder).toBe(`worker:test-worker:reconcile-${ENV}`);
    await expect(w.activities.acquireLease({ operationId: `reconcile-${ENV}`, scope: "reconcile:another", ttlMs: 60_000 })).rejects.toBeInstanceOf(StepFailedError);
    await expect(w.activities.acquireLease({ operationId: "reconcile-unknown-env", scope: "reconcile:unknown-env", ttlMs: 60_000 })).rejects.toBeInstanceOf(StepFailedError);
  });

  it("renews a held lease, extends the operation's execution lease, and raises LeaseLost for a lost one", async () => {
    const w = world();
    const lease = await w.lease();
    await w.activities.renewLease({ lease, ttlMs: 60_000 });
    expect(w.leases.renewCalls).toBe(1);
    expect(w.ops.heartbeats).toBe(1);
    w.leases.steal(lease.scope);
    const err = await w.activities.renewLease({ lease, ttlMs: 60_000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeaseLostError);
    expect((err as LeaseLostError).code).toBe("lease_lost");
  });

  it("releases idempotently: a second or stale release is harmless, and only a real release is announced", async () => {
    const w = world();
    const lease = await w.lease();
    await w.activities.releaseLease({ lease });
    await w.activities.releaseLease({ lease });
    expect(w.events.ofType("lease.released")).toHaveLength(1);
    const stale = await w.lease();
    w.leases.steal(stale.scope);
    await expect(w.activities.releaseLease({ lease: stale })).resolves.toBeUndefined();
    expect(w.events.ofType("lease.released")).toHaveLength(1);
  });
});
