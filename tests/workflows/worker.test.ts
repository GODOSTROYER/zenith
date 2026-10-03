/**
 * Worker lifecycle: the shutdown handlers (unit, with a fake process), and a
 * rolling replacement against a real Temporal dev server: a worker drains on
 * shutdown, letting the running activity finish exactly once, and a second
 * worker carries the workflow to the end. That is what a redeploy of the
 * execution worker looks like.
 *
 * (A crashed worker, as opposed to a drained one, is covered by the heartbeat
 * timeout scenario in approval-time.test.ts.)
 */

import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createExecutionWorker } from "../../workers/execution/run";
import { executionWorkerConfigFromEnv } from "../../workers/execution/config";
import { installShutdownHandlers } from "../../workers/execution/lifecycle";
import { startExecutionWorker } from "../../workers/execution/entrypoint";
import { closeExecutionStore } from "../../workers/execution/startup";
import type { Sql } from "@/lib/controlplane/types";
import { WORKFLOW_ID, WORKFLOW_TYPES, type WorkflowResult } from "@/lib/workflows/types";
import { deployInput, serverSuite, waitFor } from "./support";

describe("installShutdownHandlers", () => {
  const make = () => {
    const signals = new EventEmitter();
    const worker = { shutdown: vi.fn() };
    const exit = vi.fn();
    const log = vi.fn();
    const stopping = installShutdownHandlers({ worker, graceMs: 5000, log, signals, exit });
    return { signals, worker, exit, log, stopping };
  };

  it("drains on the first SIGTERM, once, without exiting", () => {
    const { signals, worker, exit, log, stopping } = make();
    expect(stopping()).toBe(false);
    signals.emit("SIGTERM");
    expect(worker.shutdown).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    expect(stopping()).toBe(true);
    expect(log).toHaveBeenCalledWith("info", "shutdown requested: draining", { signal: "SIGTERM", graceMs: 5000 });
  });

  it("treats SIGINT the same way", () => {
    const { signals, worker } = make();
    signals.emit("SIGINT");
    expect(worker.shutdown).toHaveBeenCalledTimes(1);
  });

  it("a second signal exits immediately with code 1 and does not drain again", () => {
    const { signals, worker, exit, log } = make();
    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    expect(exit).toHaveBeenCalledWith(1);
    expect(worker.shutdown).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("error", "second signal: exiting immediately", { signal: "SIGINT" });
  });
});

describe("packaged execution worker bootstrap and store lifecycle", () => {
  it.each(["lowercase", "uppercase"])("permits loading with a valid %s fingerprint key without logging module values", async (letterCase) => {
    const key = randomBytes(32).toString("hex");
    const env = { ZENITH_SECRET_KEY: letterCase === "uppercase" ? key.toUpperCase() : key };
    const load = vi.fn(async () => {});
    const output = { write: vi.fn() };
    expect(await startExecutionWorker(load, output, env)).toBe(0);
    expect(load).toHaveBeenCalledOnce();
    expect(output.write).not.toHaveBeenCalled();
  });

  it.each([
    { label: "missing", key: undefined },
    { label: "empty", key: "" },
    { label: "malformed", key: "private-secret-input" },
    { label: "base64 vault", key: randomBytes(32).toString("base64") },
    { label: "short hex", key: randomBytes(32).toString("hex").slice(1) },
    { label: "long hex", key: `${randomBytes(32).toString("hex")}0` },
    { label: "padded hex", key: ` ${randomBytes(32).toString("hex")}` },
  ])("refuses a $label fingerprint key before loading without logging its value", async ({ key }) => {
    const load = vi.fn(async () => {});
    const output = { write: vi.fn() };
    expect(await startExecutionWorker(load, output, { ZENITH_SECRET_KEY: key })).toBe(1);
    expect(load).not.toHaveBeenCalled();
    expect(output.write).toHaveBeenCalledOnce();
    const logged = output.write.mock.calls[0][0];
    expect(JSON.parse(logged)).toEqual({
      level: "error", msg: "execution worker failed", component: "execution-worker",
      failureCategory: "configuration",
      error: "Execution requires ZENITH_SECRET_KEY (64 hex characters); plan fingerprints cannot use the public default.",
    });
    if (key) expect(logged).not.toContain(key);
  });

  it("refuses a module-load failure without printing URLs, keys or SQL", async () => {
    const env = { ZENITH_SECRET_KEY: randomBytes(32).toString("hex") };
    const privateMessage = "postgresql://user:private-password@private-host/db select 'private-value' signing-private-key";
    const load = vi.fn(async () => { throw new Error(privateMessage); });
    const output = { write: vi.fn() };
    expect(await startExecutionWorker(load, output, env)).toBe(1);
    expect(load).toHaveBeenCalledOnce();
    expect(output.write).toHaveBeenCalledOnce();
    const logged = output.write.mock.calls[0][0];
    expect(JSON.parse(logged)).toEqual({
      level: "error", msg: "execution worker failed", component: "execution-worker", failureCategory: "module-load",
      error: "Worker modules could not load; check packaged dependencies and configuration.",
    });
    expect(logged).not.toContain(privateMessage);
    expect(logged).not.toContain("private-password");
    expect(logged).not.toContain("private-value");
    expect(logged).not.toContain(env.ZENITH_SECRET_KEY);
  });

  it("closes the worker-owned store and tolerates no opened store", async () => {
    const close = vi.fn(async () => {});
    const store: Sql & { close(): Promise<void> } = { query: vi.fn(), tx: vi.fn(), close };
    await closeExecutionStore(store);
    expect(close).toHaveBeenCalledOnce();
    await expect(closeExecutionStore()).resolves.toBeUndefined();
  });

  it("preserves store-close failure so shutdown cannot claim clean completion", async () => {
    const failure = new Error("Close failed");
    const store: Sql & { close(): Promise<void> } = { query: vi.fn(), tx: vi.fn(), close: async () => { throw failure; } };
    await expect(closeExecutionStore(store)).rejects.toBe(failure);
  });
});

const { scenario, server } = serverSuite("local");

describe("rolling replacement of the execution worker", () => {
  scenario(
    "a draining worker lets the running activity finish once; the next worker completes the workflow",
    async (h) => {
      const env = server().env;
      const configFor = (identity: string) =>
        executionWorkerConfigFromEnv({
          ZENITH_TEMPORAL_ADDRESS: env.address,
          ZENITH_TEMPORAL_NAMESPACE: env.namespace ?? "default",
          ZENITH_WORKER_TASK_QUEUE: h.taskQueue,
          ZENITH_WORKER_SHUTDOWN_GRACE_MS: "15000",
          ZENITH_WORKER_HEARTBEAT_THROTTLE_MS: "300",
          ZENITH_WORKER_IDENTITY: identity,
        });
      const workflows = { workflowBundle: { codePath: h.bundle }, origin: "prebuilt-bundle" as const };
      const start = (identity: string) => createExecutionWorker({ config: configFor(identity), connection: env.nativeConnection, activities: h.fake.activities, workflows });

      // The deploy activity takes 2.5 s: long enough to be mid-flight when worker A is told to stop.
      h.fake.delay("deployWorkloads", 2500);
      const input = deployInput();

      const workerA = await start("worker-a");
      const runA = workerA.run();
      const handle = await h.client.workflow.start(WORKFLOW_TYPES.deploy, { workflowId: WORKFLOW_ID(input.operationId), taskQueue: h.taskQueue, args: [input] });
      await waitFor("deployWorkloads to start on worker A", () => h.fake.callsTo("deployWorkloads").length === 1);

      workerA.shutdown(); // as SIGTERM would
      await runA; // resolves only after the running activity finished (grace is 15 s)
      expect(h.fake.callsTo("deployWorkloads")[0]!.result).toEqual({ services: 1 });
      // Worker A no longer polls, so the workflow has not moved past the deploy.
      expect(h.fake.callsTo("runMigrations")).toHaveLength(0);
      expect((await handle.describe()).status.name).toBe("RUNNING");

      const workerB = await start("worker-b");
      const result = await workerB.runUntil(handle.result()) as WorkflowResult;

      expect(result.status).toBe("succeeded");
      // The activity ran exactly once across the two workers: a redeploy did not replay the deploy.
      expect(h.fake.callsTo("deployWorkloads")).toHaveLength(1);
      expect(h.fake.callsTo("applyInfrastructure")).toHaveLength(1);
      expect(h.fake.callsTo("runMigrations")).toHaveLength(1);
      expect(h.fake.statuses.map((s) => s.status)).toEqual(["running", "succeeded"]);
      expect(h.fake.lease.released).toHaveLength(1);
    },
    90_000
  );
});
