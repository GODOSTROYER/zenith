/**
 * The control-plane client (src/lib/workflows/client.ts) against a real Temporal
 * dev server started by the suite: idempotent starts, signals, cancellation,
 * progress queries and the availability probe.
 *
 * Every connection here goes to a server the suite started, or to a local port
 * nothing listens on. Nothing connects to localhost:7233.
 */

import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WORKFLOW_ID, RECONCILE_WORKFLOW_ID, type WorkflowResult, type ReconcileWorkflowResult } from "@/lib/workflows/types";
import { temporalConfigFromEnv, type TemporalConnectionConfig } from "@/lib/workflows/config";
import {
  cancelOperation,
  closeWorkflowClients,
  getProgress,
  resetAvailabilityCache,
  signalApproval,
  startDayTwo,
  startDeploy,
  startReconcile,
  startRemediation,
  TemporalUnavailableError,
  temporalAvailable,
  workflowClient,
} from "@/lib/workflows/client";
import { deployInput, uniqueId, serverSuite, waitForStatus } from "./support";

const { scenario, server } = serverSuite("local", { concurrent: true });

const KEY = "tmprl-key-1a2b3c4d5e6f-do-not-print";

afterEach(() => {
  resetAvailabilityCache();
});

describe("startDeploy is idempotent on the operation id", () => {
  scenario("a duplicate start while running returns the same execution, and only one workflow runs", async (h) => {
    h.fake.setResult("evaluatePolicy", { outcome: "require_approval", decisionId: "d-1", reasons: [] });
    const input = deployInput();
    const opts = { client: h.client, taskQueue: h.taskQueue };
    await h.run(async () => {
      const first = await startDeploy(input, opts);
      await waitForStatus(first.handle, "awaiting_approval");
      const second = await startDeploy(input, opts);
      const third = await startDeploy({ ...input }, opts);

      expect(first.workflowId).toBe(WORKFLOW_ID(input.operationId));
      expect(second.workflowId).toBe(first.workflowId);
      expect(second.runId).toBe(first.runId);
      expect(third.runId).toBe(first.runId);

      // Exactly one execution exists for that id, and it is still the first run.
      const description = await h.client.workflow.getHandle(first.workflowId).describe();
      expect(description.runId).toBe(first.runId);
      expect(description.status.name).toBe("RUNNING");
      expect(h.fake.callsTo("validateDesiredState")).toHaveLength(1);
      expect(h.fake.callsTo("acquireLease")).toHaveLength(1);

      h.fake.approve();
      await signalApproval(input.operationId, opts);
      expect(((await first.handle.result()) as WorkflowResult).status).toBe("succeeded");
    });
  });

  scenario("a duplicate start after completion returns the finished execution and does not run it again", async (h) => {
    const input = deployInput();
    const opts = { client: h.client, taskQueue: h.taskQueue };
    await h.run(async () => {
      const first = await startDeploy(input, opts);
      const original = (await first.handle.result()) as WorkflowResult;
      expect(original.status).toBe("succeeded");
      const validated = h.fake.callsTo("validateDesiredState").length;

      const again = await startDeploy(input, opts);
      expect(again.runId).toBe(first.runId);
      expect(again.workflowId).toBe(first.workflowId);
      expect((await again.handle.result()) as WorkflowResult).toEqual(original);
      // Nothing re-ran.
      expect(h.fake.callsTo("validateDesiredState")).toHaveLength(validated);
    });
  });

  scenario("different operations get different workflow ids and runs", async (h) => {
    const opts = { client: h.client, taskQueue: h.taskQueue };
    await h.run(async () => {
      const a = await startDeploy(deployInput(), opts);
      const b = await startDeploy(deployInput(), opts);
      expect(a.workflowId).not.toBe(b.workflowId);
      expect(a.runId).not.toBe(b.runId);
      await Promise.all([a.handle.result(), b.handle.result()]);
    });
  });
});

describe("the other start functions", () => {
  scenario("startDayTwo and startRemediation start `op-<operationId>` workflows and are idempotent", async (h) => {
    const opts = { client: h.client, taskQueue: h.taskQueue };
    await h.run(async () => {
      const dayTwo = { operationId: uniqueId("d2"), workspaceId: "ws-1", environmentId: "env-1", capability: "workload.restart" };
      const first = await startDayTwo(dayTwo, opts);
      expect(first.workflowId).toBe(`op-${dayTwo.operationId}`);
      expect(((await first.handle.result()) as WorkflowResult).status).toBe("succeeded");
      expect((await startDayTwo(dayTwo, opts)).runId).toBe(first.runId);

      const fix = { operationId: uniqueId("rm"), workspaceId: "ws-1", environmentId: "env-1", incidentId: "inc-1" };
      const remediation = await startRemediation(fix, opts);
      expect(remediation.workflowId).toBe(`op-${fix.operationId}`);
      expect(((await remediation.handle.result()) as WorkflowResult).status).toBe("succeeded");
    });
  });

  scenario("startReconcile runs one pass per environment at a time, and a finished pass does not block the next", async (h) => {
    const opts = { client: h.client, taskQueue: h.taskQueue };
    const input = { workspaceId: "ws-1", environmentId: uniqueId("env"), allowAutoRepair: false };
    const held = h.fake.hold("reconcileObserve");
    await h.run(async () => {
      const first = await startReconcile(input, opts);
      expect(first.workflowId).toBe(RECONCILE_WORKFLOW_ID(input.environmentId));
      await held.started;
      const duplicate = await startReconcile(input, opts);
      expect(duplicate.runId).toBe(first.runId); // still running: same pass
      held.release();
      expect(((await first.handle.result()) as ReconcileWorkflowResult).status).toBe("observed");

      const next = await startReconcile(input, opts);
      expect(next.runId).not.toBe(first.runId); // finished: a new pass is allowed
      expect(((await next.handle.result()) as ReconcileWorkflowResult).status).toBe("observed");
    });
  });
});

describe("signals and queries", () => {
  scenario("signalApproval and cancelOperation report `not_found` for an unknown operation instead of throwing", async (h) => {
    const opts = { client: h.client };
    expect(await signalApproval("no-such-operation", opts)).toEqual({ delivered: false, reason: "not_found" });
    expect(await cancelOperation("no-such-operation", opts)).toEqual({ delivered: false, reason: "not_found" });
  });

  scenario("getProgress returns live progress, then the final progress, and null for an unknown operation", async (h) => {
    h.fake.setResult("evaluatePolicy", { outcome: "require_approval", decisionId: "d-1", reasons: [] });
    const input = deployInput();
    const opts = { client: h.client, taskQueue: h.taskQueue };
    await h.run(async () => {
      const started = await startDeploy(input, opts);
      await waitForStatus(started.handle, "awaiting_approval");
      const live = await getProgress(input.operationId, opts);
      expect(live).toMatchObject({ operationId: input.operationId, status: "awaiting_approval" });
      expect(live?.steps.find((s) => s.step === "plan")?.status).toBe("done");
      expect(live?.steps.find((s) => s.step === "apply_infrastructure")?.status).toBe("pending");

      h.fake.approve();
      await signalApproval(input.operationId, opts);
      await started.handle.result();
      const final = await getProgress(input.operationId, opts);
      expect(final?.status).toBe("succeeded");
      expect(final?.steps.every((s) => s.status === "done" || s.status === "skipped")).toBe(true);

      expect(await getProgress("no-such-operation", opts)).toBeNull();
    });
  });

  scenario("getProgress does not hang when the worker has gone away: it fails fast with a typed error", async (h) => {
    h.fake.setResult("evaluatePolicy", { outcome: "require_approval", decisionId: "d-1", reasons: [] });
    const input = deployInput();
    const opts = { client: h.client, taskQueue: h.taskQueue };
    // Get the workflow into its approval wait, then let the worker leave.
    await h.run(async () => {
      const started = await startDeploy(input, opts);
      await waitForStatus(started.handle, "awaiting_approval");
    });
    const began = Date.now();
    await expect(getProgress(input.operationId, { client: h.client, timeoutMs: 1500 })).rejects.toBeInstanceOf(TemporalUnavailableError);
    expect(Date.now() - began).toBeLessThan(6000);
    await h.client.workflow.getHandle(WORKFLOW_ID(input.operationId)).terminate("test cleanup");
  });

  scenario("cancelOperation asks a running operation to stop", async (h) => {
    const held = h.fake.hold("deployWorkloads");
    const input = deployInput();
    const opts = { client: h.client, taskQueue: h.taskQueue };
    await h.run(async () => {
      const started = await startDeploy(input, opts);
      await held.started;
      expect(await cancelOperation(input.operationId, opts)).toEqual({ delivered: true });
      expect(((await started.handle.result()) as WorkflowResult).status).toBe("cancelled");
    });
  });
});

describe("workflowClient and temporalAvailable", () => {
  /** A port nothing is listening on. */
  async function closedPort(): Promise<number> {
    const srv = createServer();
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const { port } = srv.address() as { port: number };
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    return port;
  }

  const configFor = async (overrides: Partial<TemporalConnectionConfig> = {}): Promise<TemporalConnectionConfig> => ({
    ...temporalConfigFromEnv({ ZENITH_TEMPORAL_ADDRESS: `127.0.0.1:${await closedPort()}` }),
    ...overrides,
  });

  it("reports an unreachable server as a typed answer, quickly, without throwing or leaking the API key", async () => {
    const config = await configFor({ apiKey: KEY, tls: true });
    const began = Date.now();
    const answer = await temporalAvailable({ config, timeoutMs: 1500, ttlMs: 0 });
    expect(answer.available).toBe(false);
    if (answer.available) return;
    expect(["unreachable", "timeout", "error"]).toContain(answer.reason);
    expect(answer.address).toBe(config.address);
    expect(JSON.stringify(answer)).not.toContain(KEY);
    expect(Date.now() - began).toBeLessThan(8000);
  }, 20_000);

  it("reports a server that accepts connections but never answers as unavailable within the timeout", async () => {
    const sockets = new Set<import("node:net").Socket>();
    const silent: Server = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const { port } = silent.address() as { port: number };
    try {
      const began = Date.now();
      const answer = await temporalAvailable({ config: temporalConfigFromEnv({ ZENITH_TEMPORAL_ADDRESS: `127.0.0.1:${port}` }), timeoutMs: 1000, ttlMs: 0 });
      expect(answer.available).toBe(false);
      expect(Date.now() - began).toBeLessThan(8000);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  }, 20_000);

  it("reports available for the suite's own server, and a missing namespace as namespace_not_found", async (ctx) => {
    let address: string;
    try {
      address = server().env.address;
    } catch (err) {
      return ctx.skip((err as Error).message);
    }
    const good = await temporalAvailable({ config: temporalConfigFromEnv({ ZENITH_TEMPORAL_ADDRESS: address }), ttlMs: 0 });
    expect(good).toMatchObject({ available: true, address, namespace: "default" });
    if (good.available) expect(good.latencyMs).toBeLessThan(5000);

    const missing = await temporalAvailable({ config: temporalConfigFromEnv({ ZENITH_TEMPORAL_ADDRESS: address, ZENITH_TEMPORAL_NAMESPACE: "no-such-namespace" }), ttlMs: 0 });
    expect(missing).toMatchObject({ available: false, reason: "namespace_not_found" });
  }, 30_000);

  it("caches an answer for the ttl and not beyond it", async () => {
    const config = await configFor();
    const first = await temporalAvailable({ config, timeoutMs: 800, ttlMs: 60_000 });
    const second = await temporalAvailable({ config, timeoutMs: 800, ttlMs: 60_000 });
    expect(second).toBe(first); // same object: served from the cache
    const fresh = await temporalAvailable({ config, timeoutMs: 800, ttlMs: 0 });
    expect(fresh).not.toBe(first);
    expect(fresh.available).toBe(first.available);
  }, 30_000);

  it("workflowClient shares one connection per config, does not cache a failed connect, and never echoes the API key", async (ctx) => {
    let address: string;
    try {
      address = server().env.address;
    } catch (err) {
      return ctx.skip((err as Error).message);
    }
    const good = temporalConfigFromEnv({ ZENITH_TEMPORAL_ADDRESS: address });
    const a = await workflowClient(good);
    const b = await workflowClient({ ...good });
    expect(b).toBe(a);

    const bad = await configFor({ apiKey: KEY, tls: true });
    const err = (await workflowClient(bad).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(TemporalUnavailableError);
    expect(err.message).toContain(bad.address);
    expect(err.message).not.toContain(KEY);
    // The failed connect was not cached: a second attempt fails afresh rather than returning a stale rejection object.
    const err2 = (await workflowClient(bad).catch((e: unknown) => e)) as Error;
    expect(err2).toBeInstanceOf(TemporalUnavailableError);
    expect(err2).not.toBe(err);
    await closeWorkflowClients();
  }, 60_000);
});
