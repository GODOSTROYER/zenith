/** PROD-OBS-04: schedule models plus explicit owned-Temporal scheduling acceptance; maintenance activities remain controlled. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ScheduleAlreadyRunning, ScheduleNotFoundError, ScheduleOverlapPolicy, Connection, WorkflowFailedError, type Client, type ScheduleDescription, type WorkflowHandle } from "@temporalio/client";
import {
  CRITICAL_CADENCE_MS, CRITICAL_CATCHUP_MS, CRITICAL_MAINTENANCE_CONTRACT, CRITICAL_SCHEDULE_ID, CriticalScheduleError,
  assertCompatibleCriticalSchedule, criticalScheduleOptions, ensureCriticalMaintenanceSchedule, inspectCriticalMaintenanceSchedule,
} from "@/lib/workflows/critical-schedule";
import { TASK_QUEUE } from "@/lib/workflows/types";

const described = (over: Record<string, unknown> = {}, paused = false): ScheduleDescription => {
  const o = criticalScheduleOptions();
  return { scheduleId: o.scheduleId, spec: o.spec, action: o.action, policies: o.policies, memo: o.memo, state: { paused, note: "x" }, info: { runningActions: [], numActionsTaken: 3, numActionsSkippedOverlap: 1, numActionsMissedCatchupWindow: 0, recentActions: [], nextActionTimes: [], createdAt: new Date() }, ...over } as unknown as ScheduleDescription;
};
const fake = (describe: () => Promise<ScheduleDescription>, create: (...args: unknown[]) => Promise<unknown> = vi.fn(async () => undefined)) =>
  ({ schedule: { getHandle: () => ({ describe }), create, withDeadline: (_d: number, fn: () => Promise<unknown>) => fn() } }) as unknown as Client;
const notFound = () => new ScheduleNotFoundError("none", CRITICAL_SCHEDULE_ID);

describe("critical maintenance schedule definition", () => {
  it("is a one-attempt, SKIP-overlap, bounded catch-up schedule on the execution queue", () => {
    const o = criticalScheduleOptions();
    expect(o.scheduleId).toBe(CRITICAL_SCHEDULE_ID);
    expect(o.policies).toMatchObject({ overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: CRITICAL_CATCHUP_MS, pauseOnFailure: false });
    expect(o.spec.intervals).toEqual([{ every: CRITICAL_CADENCE_MS, offset: 0 }]);
    expect(o.action).toMatchObject({ type: "startWorkflow", workflowType: "criticalMaintenanceWorkflow", taskQueue: TASK_QUEUE, args: [{ contract: CRITICAL_MAINTENANCE_CONTRACT }], retry: { maximumAttempts: 1 } });
    expect(o.state?.paused).toBe(false);
  });

  it("accepts its own description and refuses any drift in an authority-bearing field", () => {
    expect(() => assertCompatibleCriticalSchedule(described())).not.toThrow();
    const o = criticalScheduleOptions();
    const cases: Record<string, unknown>[] = [
      { policies: { ...o.policies, overlap: ScheduleOverlapPolicy.ALLOW_ALL } },
      { policies: { ...o.policies, pauseOnFailure: true } },
      { policies: { ...o.policies, catchupWindow: 1 } },
      { action: { ...o.action, taskQueue: "other" } },
      { action: { ...o.action, workflowType: "other" } },
      { action: { ...o.action, args: [{ contract: "other" }] } },
      { action: { ...o.action, retry: { maximumAttempts: 5 } } },
      { spec: { ...o.spec, intervals: [{ every: 1000 }] } },
      { memo: { zenithOwner: "someone-else" } },
    ];
    for (const over of cases) expect(() => assertCompatibleCriticalSchedule(described(over))).toThrow(CriticalScheduleError);
  });
});

describe("ensureCriticalMaintenanceSchedule", () => {
  it("creates the schedule when absent", async () => {
    let created = false;
    const create = vi.fn(async () => { created = true; });
    const describe = vi.fn(async () => { if (!created) throw notFound(); return described(); });
    const result = await ensureCriticalMaintenanceSchedule(fake(describe, create));
    expect(result).toMatchObject({ created: true, paused: false });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("adopts a compatible existing schedule and keeps an operator pause", async () => {
    const create = vi.fn();
    const result = await ensureCriticalMaintenanceSchedule(fake(async () => described({}, true), create));
    expect(result).toMatchObject({ created: false, paused: true });
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses an incompatible existing schedule and never overwrites it", async () => {
    const create = vi.fn();
    await expect(ensureCriticalMaintenanceSchedule(fake(async () => described({ policies: { overlap: ScheduleOverlapPolicy.ALLOW_ALL } }), create))).rejects.toMatchObject({ code: "incompatible_schedule" });
    expect(create).not.toHaveBeenCalled();
  });

  it("tolerates a concurrent creator and verifies what is there", async () => {
    let calls = 0;
    const describe = vi.fn(async () => { if (calls++ === 0) throw notFound(); return described(); });
    const create = vi.fn(async () => { throw new ScheduleAlreadyRunning("exists", CRITICAL_SCHEDULE_ID); });
    expect(await ensureCriticalMaintenanceSchedule(fake(describe, create))).toMatchObject({ created: false });
  });

  it("reports an unconfirmed transport rather than guessing", async () => {
    await expect(ensureCriticalMaintenanceSchedule(fake(async () => { throw new Error("socket closed"); }))).rejects.toMatchObject({ code: "transport_unconfirmed" });
  });
});

describe("inspectCriticalMaintenanceSchedule", () => {
  it("projects counts only and flags absence, drift and pause", async () => {
    expect(await inspectCriticalMaintenanceSchedule(fake(async () => { throw notFound(); }))).toMatchObject({ present: false });
    expect(await inspectCriticalMaintenanceSchedule(fake(async () => described({}, true)))).toEqual({ present: true, compatible: true, paused: true, running: 0, actions: 3, skippedOverlap: 1, missedCatchup: 0 });
    expect(await inspectCriticalMaintenanceSchedule(fake(async () => described({ memo: {} })))).toMatchObject({ present: true, compatible: false });
  });
});


import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Context } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { CriticalMaintenanceActivities, CriticalMaintenanceActivityInput, CriticalMaintenanceResult, criticalMaintenanceWorkflow } from "@/lib/workflows/definitions/criticalMaintenance";
import { waitFor, workflowBundlePath } from "./support";

async function criticalFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createServer(); socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const port = (socket.address() as { port: number }).port;
      socket.close(error => error ? reject(error) : resolve(port));
    });
  });
}
async function criticalDeadline<T>(value: Promise<T>, label: string, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([value, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
const criticalGroupAbsent = (pid: number): boolean => {
  try { process.kill(-pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw new Error("Owned Temporal process-group observation is unavailable."); }
};
type CriticalFileIdentity = { device: number; inode: number; uid: number };

/** Fixed loopback CLI process and persistent SQLite only; no default server or download. */
class CriticalDurableServer {
  private child?: ChildProcess;
  private closed?: Promise<void>;
  private childClosed = false;
  private launchFailed = false;
  private startupStderr = Buffer.alloc(0);
  private startupStderrTruncated = false;
  private connectionUnconfirmed = false;
  private sqlite?: CriticalFileIdentity;
  env?: TestWorkflowEnvironment;
  readonly ownershipAttribute = `ZenithCriticalFixture${randomUUID().replace(/-/g, "")}`;
  constructor(readonly cli: string, readonly directory: string, readonly port: number, readonly rootIdentity: CriticalFileIdentity) {}
  private startupFailure(message: string): Error {
    // Drain stderr without publishing provider text, paths or arbitrary messages.
    const text = this.startupStderr.toString("utf8");
    const classifier = this.launchFailed ? "spawn_failed"
      : text.includes("bind: address already in use") ? "address_in_use"
      : text.includes("database is locked") ? "database_locked"
      : text.includes("unable to open database file") ? "database_open_failed"
      : text.includes("permission denied") ? "permission_denied" : "unknown";
    return new Error(`${message} ${JSON.stringify({ classifier, exitCode: this.child?.exitCode ?? null,
      signalCode: this.child?.signalCode ?? null, stderrTruncated: this.startupStderrTruncated })}`);
  }
  async assertDirectory(): Promise<void> {
    const actual = await lstat(this.directory);
    if (!actual.isDirectory() || actual.isSymbolicLink() || (actual.mode & 0o777) !== 0o700 || actual.dev !== this.rootIdentity.device || actual.ino !== this.rootIdentity.inode || actual.uid !== this.rootIdentity.uid) throw new Error("Owned Temporal directory custody changed; retain it.");
  }
  async assertSqlite(): Promise<void> {
    await this.assertDirectory();
    const filename = path.join(this.directory, "owned-temporal.sqlite");
    const actual = await lstat(filename);
    if (!actual.isFile() || actual.isSymbolicLink() || actual.nlink !== 1 || actual.uid !== this.rootIdentity.uid) throw new Error("Owned Temporal SQLite custody is unavailable.");
    if (!this.sqlite) {
      await chmod(filename, 0o600);
      const captured = await lstat(filename);
      if (captured.dev !== actual.dev || captured.ino !== actual.ino || captured.uid !== actual.uid || !captured.isFile() || captured.nlink !== 1 || (captured.mode & 0o777) !== 0o600) throw new Error("Owned Temporal SQLite capture changed.");
      this.sqlite = { device: captured.dev, inode: captured.ino, uid: captured.uid };
    } else if (actual.dev !== this.sqlite.device || actual.ino !== this.sqlite.inode || actual.uid !== this.sqlite.uid || (actual.mode & 0o777) !== 0o600) throw new Error("Owned Temporal SQLite identity changed; retain it.");
  }
  async assertRemovalCustody(): Promise<void> {
    await this.assertDirectory();
    if (this.sqlite) await this.assertSqlite();
    else await expect(lstat(path.join(this.directory, "owned-temporal.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
  }
  async start(): Promise<void> {
    if (this.child || this.env || this.port === 7233) throw new Error("Refusing unowned or default Temporal process attachment.");
    await this.assertDirectory();
    if (this.sqlite) await this.assertSqlite();
    else await expect(lstat(path.join(this.directory, "owned-temporal.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
    const http = await criticalFreePort(), metrics = await criticalFreePort();
    if (new Set([this.port, http, metrics]).size !== 3 || [this.port, http, metrics].some(port => [7233, 8233, 8000, 9000, 9090].includes(port))) throw new Error("Owned Temporal ports must be exclusive and nondefault.");
    this.childClosed = false; this.launchFailed = false;
    this.startupStderr = Buffer.alloc(0); this.startupStderrTruncated = false;
    const child = spawn(this.cli, ["--disable-config-env", "--disable-config-file", "server", "start-dev", "--headless", "--ip", "127.0.0.1", "--port", String(this.port), "--http-port", String(http), "--metrics-port", String(metrics), "--db-filename", path.join(this.directory, "owned-temporal.sqlite"), "--search-attribute", `${this.ownershipAttribute}=Keyword`], {
      detached: true, stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
      env: { PATH: process.env.PATH, NODE_ENV: "test", HOME: this.directory, XDG_CONFIG_HOME: this.directory },
    });
    this.child = child;
    child.stderr?.on("data", (chunk: Buffer) => {
      const remaining = 8192 - this.startupStderr.length;
      if (chunk.length > remaining) this.startupStderrTruncated = true;
      if (remaining > 0) this.startupStderr = Buffer.concat([this.startupStderr, chunk.subarray(0, remaining)]);
    });
    this.closed = new Promise(resolve => { child.once("error", () => { this.launchFailed = true; }); child.once("close", () => { this.childClosed = true; resolve(); }); });
    await waitFor("owned durable critical Temporal frontend", async () => {
      if (this.launchFailed || this.childClosed) throw this.startupFailure("Owned Temporal process failed before readiness.");
      let connection: Connection | undefined;
      try {
        connection = await Connection.connect({ address: `127.0.0.1:${this.port}`, connectTimeout: 500 });
        const attributes = await connection.operatorService.listSearchAttributes({ namespace: "default" });
        if (!Object.hasOwn(attributes.customAttributes, this.ownershipAttribute) || attributes.customAttributes[this.ownershipAttribute] !== 2) return false;
        await this.assertSqlite();
        return true;
      } catch { return false; }
      finally { try { await connection?.close(); } catch { this.connectionUnconfirmed = true; throw new Error("Owned Temporal readiness connection did not settle."); } }
    }, 45_000);
    if (this.launchFailed || this.childClosed) throw this.startupFailure("Owned Temporal readiness lost its process.");
    this.env = await TestWorkflowEnvironment.createFromExistingServer({ address: `127.0.0.1:${this.port}`, namespace: "default" });
  }
  async stop(): Promise<void> {
    const errors: unknown[] = [];
    if (this.connectionUnconfirmed) errors.push(new Error("Owned Temporal readiness connection settlement is unconfirmed."));
    const environment = this.env; this.env = undefined;
    try { if (environment) await criticalDeadline(environment.teardown(), "Owned Temporal connections did not settle.", 5_000); } catch (error) { errors.push(error); }
    const child = this.child;
    if (child) {
      try {
        if (!this.childClosed && child.pid) process.kill(-child.pid, "SIGTERM");
        try { await criticalDeadline(this.closed!, "Owned Temporal TERM did not settle.", 10_000); }
        catch {
          // Never signal a reused group after its original leader has closed.
          if (!this.childClosed && child.pid) process.kill(-child.pid, "SIGKILL");
          await criticalDeadline(this.closed!, "Owned Temporal KILL did not settle; retain directory.", 5_000);
        }
        if (child.pid) await waitFor("owned Temporal process-group absence", () => criticalGroupAbsent(child.pid!), 2_000);
        this.child = undefined; this.closed = undefined;
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Owned Temporal shutdown is unconfirmed; retain directory.");
  }
}

const assertActualCriticalDescription = (value: ScheduleDescription): void => {
  assertCompatibleCriticalSchedule(value);
  expect(value.memo).toEqual(criticalScheduleOptions().memo);
  expect(value.action).toMatchObject({ type: "startWorkflow", workflowType: "criticalMaintenanceWorkflow", workflowId: CRITICAL_SCHEDULE_ID, taskQueue: TASK_QUEUE, args: [{ contract: CRITICAL_MAINTENANCE_CONTRACT }], workflowExecutionTimeout: 180_000, workflowRunTimeout: 180_000, workflowTaskTimeout: 10_000, retry: { maximumAttempts: 1 } });
  expect(value.policies).toMatchObject({ overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: CRITICAL_CATCHUP_MS, pauseOnFailure: false });
  expect(value.spec.intervals).toEqual([{ every: CRITICAL_CADENCE_MS, offset: 0 }]);
  expect(value.spec.timezone).toBe("UTC");
};

// Controlled activity results prove scheduling/workflow execution, never default job effects or health.
const criticalControlledResult: CriticalMaintenanceResult = Object.freeze({ engine: "skipped", alerts: "skipped", outbox: "skipped", housekeeping: "skipped", "runner-reaper": "skipped", runbooks: "skipped" });
const validateCriticalActivity = (input: CriticalMaintenanceActivityInput): void => {
  expect(Object.keys(input).sort()).toEqual(["contract", "passId"]);
  expect(input.contract).toBe(CRITICAL_MAINTENANCE_CONTRACT);
  const execution = Context.current().info.workflowExecution;
  if (!execution) throw new Error("Controlled maintenance must be invoked by the actual workflow.");
  expect(input.passId).toBe(execution.runId);
};

describe("critical maintenance schedule on an actual owned durable Temporal service", () => {
  const required = process.env.ZENITH_TEST_TEMPORAL === "1";
  const enabled = required;
  let skipReason: string | undefined, root = "", bundle = "";
  let server: CriticalDurableServer | undefined;
  let scheduleOwned = false, cleanupUnconfirmed = false;
  let pendingMutation: string | null = null;
  const started: WorkflowHandle<typeof criticalMaintenanceWorkflow>[] = [];
  const barriers = new Set<() => void>();
  const workers = new Map<Worker, Promise<unknown>>();
  const client = (): Client => { if (!server?.env) throw new Error("Owned critical Temporal is unavailable."); return server.env.client; };
  async function runWorker<T>(activities: CriticalMaintenanceActivities, body: () => Promise<T>): Promise<T> {
    if (!server?.env) throw new Error("Owned critical Temporal is unavailable.");
    const worker = await Worker.create({ connection: server.env.nativeConnection, namespace: "default", taskQueue: TASK_QUEUE, workflowBundle: { codePath: bundle }, activities: { ...activities }, shutdownGraceTime: "2s", maxHeartbeatThrottleInterval: "300ms", defaultHeartbeatThrottleInterval: "100ms" });
    const running = worker.runUntil(body);
    workers.set(worker, running);
    try { return await running; }
    finally { if (worker.getState() === "STOPPED") workers.delete(worker); }
  }
  async function mutation<T>(phase: string, call: () => Promise<T>, milliseconds = 10_000): Promise<T> {
    if (pendingMutation !== null) throw new Error("Prior owned Temporal mutation is unconfirmed; retain directory.");
    pendingMutation = phase;
    const begun = Date.now();
    const value = await criticalDeadline(call(), "Owned Temporal mutation response is unconfirmed; retain directory.", milliseconds);
    if (Date.now() - begun > milliseconds) throw new Error("Owned Temporal mutation response missed its deadline; retain directory.");
    pendingMutation = null;
    return value;
  }
  async function createPausedSchedule() {
    if (cleanupUnconfirmed) throw new Error("Earlier fixture cleanup was unconfirmed.");
    await expect(client().schedule.getHandle(CRITICAL_SCHEDULE_ID).describe()).rejects.toBeInstanceOf(ScheduleNotFoundError);
    // Keep the real fixed unpaused creation away from its next minute tick.
    // Bounded calls below must finish in this same minute; no real action row is ignored.
    await waitFor("safe fixed-cadence creation phase", () => Date.now() % CRITICAL_CADENCE_MS < 10_000, 65_000);
    const minute = Math.floor(Date.now() / CRITICAL_CADENCE_MS);
    const value = await mutation("ensure-critical-schedule", () => ensureCriticalMaintenanceSchedule(client()), 30_000);
    scheduleOwned = true;
    expect(value).toMatchObject({ created: true, paused: false });
    await mutation("pause-critical-schedule", () => value.handle.pause("Owned fixture operator pause."), 5_000);
    const actual = await client().schedule.withDeadline(Date.now() + 5_000, () => value.handle.describe());
    expect(Math.floor(Date.now() / CRITICAL_CADENCE_MS)).toBe(minute);
    assertActualCriticalDescription(actual);
    expect(actual.state).toMatchObject({ paused: true, note: "Owned fixture operator pause." });
    expect(actual.info.numActionsTaken).toBe(0);
    expect(actual.info.recentActions).toEqual([]);
    expect(actual.info.runningActions).toEqual([]);
    return value.handle;
  }
  async function scheduled() {
    const description = await waitFor("actual critical scheduled execution recorded", async () => {
      const value = await client().schedule.getHandle(CRITICAL_SCHEDULE_ID).describe();
      return value.info.recentActions.length === 1 ? value : false;
    });
    const action = description.info.recentActions[0].action;
    if (action.type !== "startWorkflow") throw new Error("Unexpected owned critical schedule action.");
    const value = client().workflow.getHandle<typeof criticalMaintenanceWorkflow>(action.workflow.workflowId, action.workflow.firstExecutionRunId);
    started.push(value);
    return value;
  }
  beforeAll(async () => {
    if (!enabled) { skipReason = "Actual critical scheduling requires ZENITH_TEST_TEMPORAL=1."; return; }
    const cli = process.env.ZENITH_TEST_TEMPORAL_CLI;
    if (!cli) throw new Error("Required pinned offline Temporal CLI is unavailable.");
    if (!path.isAbsolute(cli) || typeof process.getuid !== "function" || process.platform === "win32") throw new Error("Owned durable CLI requires an explicit native POSIX path.");
    const executable = await lstat(cli);
    if (!executable.isFile() || executable.isSymbolicLink() || (executable.mode & 0o022) !== 0) throw new Error("Pinned Temporal CLI custody is unavailable.");
    const version = await promisify(execFile)(cli, ["--disable-config-env", "--disable-config-file", "--version"], { timeout: 5_000, maxBuffer: 8192, env: { PATH: process.env.PATH, NODE_ENV: "test" } });
    if (!/^temporal version 1\.9\.1(?:\s|$)/.test(version.stdout.trim()) || version.stderr !== "") throw new Error("Required Temporal CLI version1.9.1 is unavailable.");
    root = await mkdtemp(path.join(os.tmpdir(), "zenith-owned-critical-temporal-"));
    await chmod(root, 0o700);
    const identity = await lstat(root);
    if (!identity.isDirectory() || identity.uid !== process.getuid() || (identity.mode & 0o777) !== 0o700) throw new Error("Owned critical directory capture failed.");
    server = new CriticalDurableServer(cli, root, await criticalFreePort(), { device: identity.dev, inode: identity.ino, uid: identity.uid });
    await server.start();
    bundle = await workflowBundlePath(path.resolve(__dirname, "../../src/lib/workflows/definitions/criticalMaintenance.ts"), "actual-owned-critical-schedule-v1");
  }, 180_000);
  afterEach(async () => {
    if (!enabled || skipReason) return;
    const errors: unknown[] = [];
    for (const release of barriers) release(); barriers.clear();
    for (const [worker, running] of workers) {
      try { if (worker.getState() === "RUNNING") worker.shutdown(); await criticalDeadline(running, "Owned critical worker did not settle.", 15_000); }
      catch (error) { errors.push(error); }
      if (worker.getState() !== "STOPPED") errors.push(new Error("Owned critical worker remains active."));
    }
    workers.clear();
    if (server?.env) {
      for (const handle of started.splice(0)) {
        try {
          if ((await handle.describe()).status.name === "RUNNING") await handle.cancel().catch(async () => { if ((await handle.describe()).status.name === "RUNNING") throw new Error("Owned workflow cancellation is unconfirmed."); });
          try { await criticalDeadline(handle.result(), "Owned critical workflow terminal result is unconfirmed.", 15_000); }
          catch (error) { if (!(error instanceof WorkflowFailedError)) throw error; }
          if ((await handle.describe()).status.name === "RUNNING") throw new Error("Owned critical workflow remains active.");
        } catch (error) { errors.push(error); }
      }
      if (pendingMutation !== null) errors.push(new Error("Owned Temporal mutation remains unconfirmed; retain directory."));
      if (scheduleOwned && errors.length === 0) {
        try {
          const handle = client().schedule.getHandle(CRITICAL_SCHEDULE_ID);
          assertActualCriticalDescription(await handle.describe());
          await mutation("delete-critical-schedule", () => handle.delete());
          await expect(handle.describe()).rejects.toBeInstanceOf(ScheduleNotFoundError);
          scheduleOwned = false;
        } catch (error) { errors.push(error); }
      }
    } else if (scheduleOwned || started.length) errors.push(new Error("Owned workflow or schedule cleanup lost its connection."));
    if (errors.length) { cleanupUnconfirmed = true; throw new AggregateError(errors, "Critical scheduling teardown is unconfirmed; retain directory."); }
  }, 60_000);
  afterAll(async () => {
    for (const release of barriers) release(); barriers.clear();
    try { await server?.stop(); }
    catch (error) { cleanupUnconfirmed = true; throw error; }
    if (root) {
      if (cleanupUnconfirmed || pendingMutation !== null || scheduleOwned || workers.size || started.length || !server) throw new Error("Unconfirmed critical fixture work; retain owned directory.");
      await server.assertRemovalCustody();
      await rm(root, { recursive: true, force: false });
      await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    }
  }, 30_000);
  function actual(name: string, body: () => Promise<void>, timeout: number): void {
    it(name, async context => { if (skipReason) return context.skip(skipReason); await body(); }, timeout);
  }
  actual("preserves compatible schedule and queued actual workflow across server restart", async () => {
    const schedule = await createPausedSchedule();
    await mutation("trigger-critical-schedule", () => schedule.trigger(ScheduleOverlapPolicy.SKIP));
    const original = await scheduled();
    const workflowId = original.workflowId, runId = (await original.describe()).runId;
    await server!.assertSqlite();
    await server!.stop();
    await server!.start();
    const adopted = await mutation("adopt-critical-schedule", () => ensureCriticalMaintenanceSchedule(client()), 30_000);
    expect(adopted).toMatchObject({ created: false, paused: true });
    const description = await adopted.handle.describe();
    assertActualCriticalDescription(description);
    expect(description.state).toMatchObject({ paused: true, note: "Owned fixture operator pause." });
    const recovered = client().workflow.getHandle<typeof criticalMaintenanceWorkflow>(workflowId, runId);
    started.splice(0, started.length, recovered);
    let calls = 0;
    await runWorker({ runCriticalMaintenance: async input => { validateCriticalActivity(input); expect(input.passId).toBe(runId); calls++; return { ...criticalControlledResult }; } }, async () => {
      expect((await recovered.describe()).runId).toBe(runId);
      expect(await recovered.result()).toEqual(criticalControlledResult);
    });
    expect(calls).toBe(1);
    expect((await recovered.describe()).status.name).toBe("COMPLETED");
    expect((await adopted.handle.describe()).info.numActionsTaken).toBe(1);
  }, 150_000);
  actual("skips overlap while the first genuine activity is held", async () => {
    const schedule = await createPausedSchedule();
    let calls = 0, entered = false, release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; }); barriers.add(release);
    await runWorker({ runCriticalMaintenance: async input => {
      validateCriticalActivity(input); calls++; entered = true;
      const heartbeat = setInterval(() => Context.current().heartbeat("owned-controlled-maintenance"), 250);
      try { await barrier; return { ...criticalControlledResult }; }
      finally { clearInterval(heartbeat); }
    } }, async () => {
      try {
        await mutation("trigger-critical-schedule", () => schedule.trigger(ScheduleOverlapPolicy.SKIP));
        const first = await scheduled();
        await waitFor("first genuine critical activity entered", () => entered);
        const before = await schedule.describe();
        expect(before.info.runningActions).toHaveLength(1); expect(before.info.numActionsTaken).toBe(1);
        await mutation("trigger-critical-schedule", () => schedule.trigger(ScheduleOverlapPolicy.SKIP));
        const skipped = await waitFor("actual critical SKIP overlap observation", async () => { const value = await schedule.describe(); return value.info.numActionsSkippedOverlap > before.info.numActionsSkippedOverlap ? value : false; });
        assertActualCriticalDescription(skipped);
        expect(skipped.info.runningActions).toHaveLength(1); expect(skipped.info.numActionsTaken).toBe(1);
        expect(skipped.info.numActionsSkippedOverlap).toBe(before.info.numActionsSkippedOverlap + 1); expect(calls).toBe(1);
        release(); barriers.delete(release);
        expect(await first.result()).toEqual(criticalControlledResult);
        expect((await first.describe()).status.name).toBe("COMPLETED");
      } finally { release(); barriers.delete(release); }
    });
    expect(calls).toBe(1);
  }, 180_000);
});
