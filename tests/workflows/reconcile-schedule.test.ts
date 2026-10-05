/** Real owned local Temporal/persistent SQLite; actual SQL controller. Provider authority is a fixture. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Context } from "@temporalio/activity";
import { Connection, ScheduleNotFoundError, ScheduleOverlapPolicy, type Client, type ScheduleDescription, type WorkflowHandle } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { tempDataDir } from "../_support/data-dir";
tempDataDir("zenith-reconcile-schedule-");
const { openPlatformDb, repos } = await import("@/lib/controlplane/db");
const { createPlatformReconcilePorts, registerEnvironment } = await import("@/lib/reconcile/platform");
const { reconcileSweepInput, reconcileScheduleOptions, assertCompatibleReconcileSchedule, createReconcileSweepRuntime, createIsolatedReconcileSweepRuntime, ensureReconcileSchedule, inspectReconcileSchedule, RECONCILE_SCHEDULE_ID, RECONCILE_SWEEP_TYPE, RECONCILE_SWEEP_LEASE } = await import("@/lib/workflows/reconcile-schedule");
const { TASK_QUEUE } = await import("@/lib/workflows/types");
const { findTemporalCli, waitFor, workflowBundlePath } = await import("./support");
import type { PlatformDbHandle } from "@/lib/controlplane/db";
import { textArray } from "@/lib/controlplane/db/sql";
import type { ReconcilePassPorts } from "@/lib/reconcile/pass-types";
import type { ReconcileSweepActivities, ReconcileSweepResult } from "@/lib/workflows/definitions/reconcileSweep";

describe("durable reconciliation scalar boundary", () => {
  it("narrows resource pressure with explicit bounded integers", () => {
    expect(reconcileSweepInput()).toEqual({ contract: "zenith.reconcile-sweep.v1", maxEnvironments: 25, environmentConcurrency: 3 });
    expect(Object.isFrozen(reconcileSweepInput())).toBe(true);
    expect(reconcileSweepInput({ contract: "zenith.reconcile-sweep.v1", maxEnvironments: 1, environmentConcurrency: 1 }).maxEnvironments).toBe(1);
    for (const bad of [null, [], {}, { contract: "other", maxEnvironments: 1, environmentConcurrency: 1 }, { contract: "zenith.reconcile-sweep.v1", maxEnvironments: 26, environmentConcurrency: 1 }, { contract: "zenith.reconcile-sweep.v1", maxEnvironments: 1, environmentConcurrency: 4 }, { contract: "zenith.reconcile-sweep.v1", maxEnvironments: "1", environmentConcurrency: 1 }, { ...reconcileSweepInput(), allowAutoRepair: true }]) expect(() => reconcileSweepInput(bad)).toThrow("configuration is invalid");
  });
  it("refuses accessors and serialization hooks without evaluating them", () => {
    const getter = vi.fn(() => 1);
    expect(() => reconcileSweepInput({ contract: "zenith.reconcile-sweep.v1", get maxEnvironments() { return getter(); }, environmentConcurrency: 1 })).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(() => reconcileSweepInput({ ...reconcileSweepInput(), toJSON: vi.fn() })).toThrow();
    expect(() => reconcileSweepInput({ ...reconcileSweepInput(), [Symbol("extra")]: true })).toThrow();
  });
  it("refuses a cross-realm plain record at the strict caller boundary", () => {
    // Deliberately modeled foreign-realm input; the actual describe below remains unmodified.
    const foreign = runInNewContext('({ contract: "zenith.reconcile-sweep.v1", maxEnvironments: 25, environmentConcurrency: 3 })');
    expect(Object.getPrototypeOf(foreign)).not.toBe(Object.prototype);
    expect(() => reconcileSweepInput(foreign)).toThrow("configuration is invalid");
  });
  it("defines finite no-retry passes, SKIP overlap and bounded catchup", () => {
    const options = reconcileScheduleOptions();
    expect(options).toMatchObject({ scheduleId: RECONCILE_SCHEDULE_ID, policies: { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: 60_000, pauseOnFailure: false }, state: { paused: true }, action: { type: "startWorkflow", workflowType: RECONCILE_SWEEP_TYPE, taskQueue: TASK_QUEUE, workflowExecutionTimeout: 180_000, retry: { maximumAttempts: 1 } } });
    expect(options.state).not.toHaveProperty("triggerImmediately");
    expect(options.state).not.toHaveProperty("backfill");
  });
  it("rejects a forged ready capability before talking to Temporal", async () => {
    const describe = vi.fn();
    const create = vi.fn();
    await expect(ensureReconcileSchedule({ schedule: { getHandle: () => ({ describe }), create } } as unknown as Client, { assertReady: async () => undefined })).rejects.toMatchObject({ code: "prerequisites_unavailable" });
    expect(describe).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

/** No default port, download or external service attachment. CLI config/env loading is disabled. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const port = (server.address() as { port: number }).port; server.close((error) => error ? reject(error) : resolve(port)); }); });
}
class DurableServer {
  private child?: ChildProcess;
  env?: TestWorkflowEnvironment;
  constructor(readonly cli: string, readonly directory: string, readonly port: number) {}
  async start(): Promise<void> {
    if (this.port === 7233) throw new Error("Refusing default Temporal port.");
    this.child = spawn(this.cli, ["--disable-config-env", "--disable-config-file", "server", "start-dev", "--headless", "--ip", "127.0.0.1", "--port", String(this.port), "--http-port", String(await freePort()), "--metrics-port", String(await freePort()), "--db-filename", path.join(this.directory, "owned-temporal.sqlite"), "--search-attribute", "ZenithScheduleOwner=Keyword"], { stdio: "ignore", windowsHide: true });
    const child = this.child;
    let failed = false;
    child.once("error", () => { failed = true; });
    await waitFor("owned durable Temporal frontend", async () => {
      if (failed || child.exitCode !== null) throw new Error("Owned durable Temporal process exited before readiness.");
      let connection: Connection | undefined;
      try { connection = await Connection.connect({ address: `127.0.0.1:${this.port}`, connectTimeout: 500 }); await connection.workflowService.describeNamespace({ namespace: "default" }); return true; }
      catch { return false; }
      finally { await connection?.close(); }
    }, 45_000);
    this.env = await TestWorkflowEnvironment.createFromExistingServer({ address: `127.0.0.1:${this.port}`, namespace: "default" });
  }
  async stop(): Promise<void> {
    await this.env?.teardown();
    this.env = undefined;
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) return;
    const closed = once(child, "close");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try { await closed; } finally { clearTimeout(timer); }
  }
}

/** The real controller claims globally, so an empty-graph suite needs its own database. */
async function openScheduleDatabase(url: string): Promise<{ db: PlatformDbHandle; close(): Promise<void> }> {
  const postgres = (await import("postgres")).default;
  const name = `zenith_reconcile_${randomUUID().replace(/-/g, "")}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  type Identity = { oid: string; owner_oid: string };
  const readIdentity = () => admin.unsafe<Identity[]>("select oid::text,datdba::text as owner_oid from pg_database where datname=$1", [name]);
  let identity: Readonly<Identity> | undefined;
  let created = false;
  let closed = false;
  let handle: PlatformDbHandle | undefined;
  const close = async (): Promise<void> => {
    if (closed) return;
    try {
      await handle?.close();
      handle = undefined;
      if (created) {
        const current = await readIdentity();
        if (!identity || current.length !== 1 || current[0].oid !== identity.oid || current[0].owner_oid !== identity.owner_oid) throw new Error("Owned reconciliation database custody changed; refusing cleanup.");
        await admin.unsafe(`drop database "${name}" with (force)`);
        if ((await readIdentity()).length !== 0) throw new Error("Owned reconciliation database cleanup is unconfirmed.");
        created = false;
      }
    } finally { await admin.end({ timeout: 5 }); }
    closed = true;
  };
  try {
    if ((await readIdentity()).length !== 0) throw new Error("Owned reconciliation database name is already present.");
    const owner = await admin.unsafe<{ owner_oid: string }[]>("select oid::text as owner_oid from pg_roles where rolname=current_user");
    if (owner.length !== 1) throw new Error("Owned reconciliation database role is unavailable.");
    await admin.unsafe(`create database "${name}"`);
    created = true;
    const current = await readIdentity();
    if (current.length !== 1 || current[0].owner_oid !== owner[0].owner_oid) throw new Error("Owned reconciliation database custody was not captured.");
    identity = Object.freeze({ ...current[0] });
    const target = new URL(url);
    target.pathname = `/${name}`;
    handle = await openPlatformDb({ kind: "postgres", url: target.toString(), migrate: true, max: 5 });
    const actual = await handle.query<{ database: string }>("select current_database() as database");
    if (actual.length !== 1 || actual[0].database !== name) throw new Error("Owned reconciliation database opener target changed.");
    return { db: handle, close };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Owned reconciliation database setup or cleanup failed."); }
    throw error;
  }
}

describe("durable schedule on an actual isolated Temporal service", () => {
  let owned: DurableServer | undefined;
  let root = "";
  let bundle = "";
  let db: PlatformDbHandle;
  let closeDatabase: (() => Promise<void>) | undefined;
  let skipReason: string | undefined;
  const started: WorkflowHandle[] = [];
  const enabled = process.env.ZENITH_TEST_RECONCILE_SCHEDULE === "1" || process.env.ZENITH_TEST_TEMPORAL === "1";
  const required = process.env.ZENITH_TEST_TEMPORAL === "1";
  const client = (): Client => { if (!owned?.env) throw new Error("Owned Temporal is unavailable."); return owned.env.client; };
  const ports = (): ReconcilePassPorts => createPlatformReconcilePorts({ db,
    broker: { propose: async () => { throw new Error("Empty graph fixture has no repair authority."); } },
    withObserveSession: async () => { throw new Error("Empty graph fixture opens no provider sessions."); },
    startRepair: async () => { throw new Error("Empty graph fixture starts no repairs."); },
  });
  const runtime = (getPorts: () => Promise<ReconcilePassPorts> = async () => ports()) => createIsolatedReconcileSweepRuntime(db, getPorts);
  async function worker(activities: ReconcileSweepActivities): Promise<Worker> {
    if (!owned?.env) throw new Error("Missing owned Temporal.");
    return Worker.create({ connection: owned.env.nativeConnection, namespace: "default", taskQueue: TASK_QUEUE, workflowBundle: { codePath: bundle }, activities: { ...activities }, shutdownGraceTime: "2s", maxHeartbeatThrottleInterval: "300ms", defaultHeartbeatThrottleInterval: "100ms" });
  }
  async function start(): Promise<WorkflowHandle> {
    const handle = await client().workflow.start(RECONCILE_SWEEP_TYPE, { workflowId: `owned-sweep-${randomUUID()}`, taskQueue: TASK_QUEUE, args: [reconcileSweepInput()], workflowExecutionTimeout: 180_000, retry: { maximumAttempts: 1 } });
    started.push(handle);
    return handle;
  }
  async function scheduled(): Promise<WorkflowHandle> {
    const description = await waitFor("scheduled execution recorded", async () => { const value = await client().schedule.getHandle(RECONCILE_SCHEDULE_ID).describe(); return value.info.recentActions.length > 0 ? value : false; });
    const action = description.info.recentActions.at(-1)?.action;
    if (!action || action.type !== "startWorkflow") throw new Error("Unexpected schedule action.");
    const handle = client().workflow.getHandle(action.workflow.workflowId, action.workflow.firstExecutionRunId);
    started.push(handle);
    return handle;
  }
  beforeAll(async () => {
    if (!enabled) { skipReason = "Real schedule lane requires ZENITH_TEST_RECONCILE_SCHEDULE=1 (or required ZENITH_TEST_TEMPORAL=1)."; return; }
    const cli = findTemporalCli();
    if (!cli) { if (required) throw new Error("Required durable Temporal CLI is unavailable; no runtime proof can be substituted."); skipReason = "Durable Temporal CLI is unavailable; no server was started."; return; }
    root = await mkdtemp(path.join(os.tmpdir(), "zenith-owned-reconcile-temporal-"));
    owned = new DurableServer(cli, root, await freePort());
    try {
      await owned.start();
      // Platform fixtures are real SQL. PGlite is an explicit test adapter, never production acceptance.
      const url = process.env.ZENITH_TEST_PLATFORM_PG_URL;
      if (url) {
        const scratch = await openScheduleDatabase(url);
        db = scratch.db;
        closeDatabase = scratch.close;
      } else {
        db = await openPlatformDb({ kind: "pglite" });
        const local = db;
        closeDatabase = () => local.close();
      }
      expect(await db.query("select environment_id from platform.reconcile_state")).toEqual([]);
      bundle = await workflowBundlePath(path.resolve(__dirname, "../../src/lib/workflows/definitions/reconcileSweep.ts"), "durable-reconcile-sweep-v1");
    } catch (error) { try { await owned.stop(); } finally { await closeDatabase?.(); } await rm(root, { recursive: true, force: true }); throw error; }
  }, 180_000);
  afterEach(async () => {
    vi.restoreAllMocks();
    if (!owned?.env) return;
    try { await client().schedule.getHandle(RECONCILE_SCHEDULE_ID).delete(); } catch (error) { if (!(error instanceof ScheduleNotFoundError)) throw error; }
    for (const handle of started.splice(0)) await handle.cancel().catch(() => undefined);
  }, 30_000);
  afterAll(async () => { try { await owned?.stop(); } finally { await closeDatabase?.(); } if (root) await rm(root, { recursive: true, force: true }); }, 30_000);
  function actual(name: string, body: () => Promise<void>, timeout = 90_000): void {
    it(name, async (context) => { if (skipReason) return context.skip(skipReason); await body(); }, timeout);
  }

  actual("creates one compatible schedule, provisions concurrently and preserves an operator pause", async () => {
    const cap = runtime();
    const attempts = await Promise.all(Array.from({ length: 4 }, () => ensureReconcileSchedule(client(), cap)));
    expect(attempts.filter((value) => value.created)).toHaveLength(1);
    expect(attempts.find((value) => value.created)).toMatchObject({ created: true, paused: false });
    const handle = attempts[0].handle;
    const active = await handle.describe();
    assertCompatibleReconcileSchedule(active);
    expect(active.state).toMatchObject({ paused: false, note: "Zenith durable reconciliation active." });
    await handle.pause("Operator investigation.");
    expect(await ensureReconcileSchedule(client(), cap)).toMatchObject({ created: false, paused: true });
    expect((await handle.describe()).state.note).toBe("Operator investigation.");
  });
  actual("refuses changed configuration and foreign ownership without updating the existing action", async () => {
    const cap = runtime();
    const { handle } = await ensureReconcileSchedule(client(), cap);
    await handle.pause("Fixture pause.");
    await expect(ensureReconcileSchedule(client(), cap, { ...reconcileSweepInput(), environmentConcurrency: 1 })).rejects.toMatchObject({ code: "incompatible_schedule" });
    const before = await handle.describe();
    // SDK 1.24 cannot re-encode its decoded zero backoff; this intentional routing
    // mutation keeps the same one-attempt policy with canonical encodeable defaults.
    await handle.update((current) => ({ spec: current.spec, action: { ...current.action, retry: { ...current.action.retry, maximumAttempts: 1, backoffCoefficient: 2 }, taskQueue: "foreign-fixture-queue" }, policies: current.policies, state: current.state, typedSearchAttributes: current.typedSearchAttributes }));
    await expect(ensureReconcileSchedule(client(), cap)).rejects.toMatchObject({ code: "incompatible_schedule" });
    const after = await handle.describe();
    expect(after.action).toMatchObject({ taskQueue: "foreign-fixture-queue", args: before.action.args });
    expect(after.state).toMatchObject({ paused: true, note: "Fixture pause." });
  });
  actual("a real concurrent operator pause invalidates activation CAS and is preserved", async () => {
    const service = client().schedule.workflowService;
    const original = service.updateSchedule.bind(service);
    let injected = false;
    vi.spyOn(service, "updateSchedule").mockImplementation(async (request) => {
      if (!injected) { injected = true; await client().schedule.getHandle(RECONCILE_SCHEDULE_ID).pause("Operator paused during activation."); }
      return original(request);
    });
    await expect(ensureReconcileSchedule(client(), runtime())).rejects.toMatchObject({ code: "incompatible_schedule" });
    const current = await client().schedule.getHandle(RECONCILE_SCHEDULE_ID).describe();
    expect(injected).toBe(true);
    expect(service.updateSchedule).toHaveBeenCalledTimes(1);
    expect(current.state).toMatchObject({ paused: true, note: "Operator paused during activation." });
    assertCompatibleReconcileSchedule(current);
  });
  actual("refuses absent prerequisites and a production PGlite store before schedule creation", async () => {
    const unavailable = runtime(async () => { throw new Error("Private diagnostic must not escape."); });
    await expect(ensureReconcileSchedule(client(), unavailable)).rejects.toMatchObject({ code: "prerequisites_unavailable", message: "Durable reconciliation prerequisites are unavailable." });
    if (db.kind === "pglite") await expect(ensureReconcileSchedule(client(), createReconcileSweepRuntime(db))).rejects.toMatchObject({ code: "prerequisites_unavailable" });
    await expect(client().schedule.getHandle(RECONCILE_SCHEDULE_ID).describe()).rejects.toBeInstanceOf(ScheduleNotFoundError);
  });
  actual("proves SKIP overlap while the first scheduled activity is actually held", async () => {
    const cap = runtime();
    let entered = false;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const activities: ReconcileSweepActivities = { sweepReconcilePass: async (input) => { entered = true; await barrier; return cap.activities.sweepReconcilePass(input); } };
    const runningWorker = await worker(activities);
    await runningWorker.runUntil(async () => {
      const { handle } = await ensureReconcileSchedule(client(), cap);
      await handle.trigger(ScheduleOverlapPolicy.SKIP);
      const first = await scheduled();
      await waitFor("first activity held at barrier", () => entered);
      try {
        await handle.trigger(ScheduleOverlapPolicy.SKIP);
        await waitFor("actual Temporal overlap skip count", async () => (await handle.describe()).info.numActionsSkippedOverlap >= 1);
        expect((await handle.describe()).info.runningActions).toHaveLength(1);
      } finally { release(); }
      expect(await first.result()).toMatchObject({ status: "completed", counts: { claimed: 0 } });
    });
  });
  actual("the global database lease refuses a direct concurrent sweep despite distinct workflow IDs", async () => {
    let entered = false;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const slowPorts = (): ReconcilePassPorts => {
      const original = ports();
      return { ...original, state: { ...original.state, claimDue: async (input) => { entered = true; await barrier; return original.state.claimDue(input); } } };
    };
    const cap = runtime(async () => slowPorts());
    const runningWorker = await worker(cap.activities);
    await runningWorker.runUntil(async () => {
      const first = await start();
      await waitFor("global lease owner within claimDue", () => entered);
      expect(await repos.leases.current(db, RECONCILE_SWEEP_LEASE)).not.toBeNull();
      try { expect(await (await start()).result()).toEqual({ status: "busy" }); }
      finally { release(); }
      expect(await first.result()).toMatchObject({ status: "completed" });
      expect(await repos.leases.current(db, RECONCILE_SWEEP_LEASE)).toBeNull();
    });
  });
  actual("the valid sweep-v1 environment retains its distinct lease while the global sweep runs", async () => {
    const workspaceId = `owned-sweep-lease-${randomUUID()}`;
    const environmentId = "sweep-v1";
    expect(RECONCILE_SWEEP_LEASE).toBe("reconcile-sweep:v1");
    expect(RECONCILE_SWEEP_LEASE).not.toBe(`reconcile:${environmentId}`);
    try {
      const connection = await repos.connections.create(db, { workspaceId, createdBy: "schedule-fixture", config: { provider: "aws", mode: "aws_assume_role", accountId: "123456789012", region: "us-east-1", observeRoleArn: "arn:aws:iam::123456789012:role/owned-schedule-observe", deployRoleArn: "arn:aws:iam::123456789012:role/owned-schedule-deploy", externalId: "owned-schedule-fixture" } });
      await repos.connections.recordVerification(db, { workspaceId, id: connection.id, ok: true, detail: "SQL scheduling fixture only; no provider call." });
      await registerEnvironment(db, { environment: { workspaceId, environmentId, class: "production", provider: "aws", region: "us-east-1", connection: { id: connection.id, status: "verified" } } });
      const cap = runtime();
      const runningWorker = await worker(cap.activities);
      await runningWorker.runUntil(async () => {
        expect(await (await start()).result()).toMatchObject({ status: "completed", counts: { claimed: 1, nothingToReconcile: 1, busy: 0 } });
      });
      expect(await db.query("select last_outcome,claimed_by from platform.reconcile_state where workspace_id=$1 and environment_id=$2", [workspaceId, environmentId])).toEqual([{ last_outcome: "nothing_to_reconcile", claimed_by: null }]);
      expect(await repos.leases.current(db, RECONCILE_SWEEP_LEASE)).toBeNull();
      expect(await repos.leases.current(db, `reconcile:${environmentId}`)).toBeNull();
    } finally {
      await db.query("delete from platform.reconcile_state where workspace_id=$1", [workspaceId]);
      await db.query("delete from platform.provider_connections where workspace_id=$1", [workspaceId]);
    }
  });
  actual("keeps durable minute scheduling active after an actual database statement failure and recovers", async () => {
    let fail = true;
    const cap = runtime(async () => {
      const original = ports();
      return { ...original, state: { ...original.state, claimDue: async (input) => { if (fail) await db.query("select 1/0"); return original.state.claimDue(input); } } };
    });
    const runningWorker = await worker(cap.activities);
    await runningWorker.runUntil(async () => {
      const { handle } = await ensureReconcileSchedule(client(), cap);
      await handle.trigger(ScheduleOverlapPolicy.SKIP);
      const failed = await scheduled();
      const failedRunId = (await failed.describe()).runId;
      expect(await failed.result()).toEqual({ status: "deferred", reason: "pass_unconfirmed" });
      expect(await inspectReconcileSchedule(client())).toMatchObject({ paused: false });
      expect(await repos.leases.current(db, RECONCILE_SWEEP_LEASE)).toBeNull();
      fail = false;
      // Do not manually trigger recovery: wait for the real fixed minute cadence.
      const next = await waitFor("scheduled minute after database recovery", async () => {
        const values = (await handle.describe()).info.recentActions;
        const value = values.find((action) => action.action.type === "startWorkflow" && action.action.workflow.firstExecutionRunId !== failedRunId);
        return value?.action.type === "startWorkflow" ? value.action : false;
      }, 80_000);
      const recovered = client().workflow.getHandle(next.workflow.workflowId, next.workflow.firstExecutionRunId);
      started.push(recovered);
      expect(await recovered.result()).toMatchObject({ status: "completed", counts: { claimed: 0, failed: 0 } });
    });
  }, 120_000);
  actual("preserves the schedule and queued execution through an actual server process restart", async () => {
    const cap = runtime();
    const { handle } = await ensureReconcileSchedule(client(), cap);
    await handle.trigger(ScheduleOverlapPolicy.SKIP);
    const before = await scheduled();
    const executionId = before.workflowId;
    const runId = (await before.describe()).runId;
    await owned!.stop();
    await owned!.start();
    expect(await ensureReconcileSchedule(client(), cap)).toMatchObject({ created: false });
    const recovered = client().workflow.getHandle(executionId, runId);
    started.push(recovered);
    const restartedWorker = await worker(cap.activities);
    await restartedWorker.runUntil(async () => { expect(await recovered.result()).toMatchObject({ status: "completed", counts: { claimed: 0 } }); });
    expect((await client().schedule.getHandle(RECONCILE_SCHEDULE_ID).describe()).info.numActionsTaken).toBeGreaterThanOrEqual(1);
  }, 150_000);
  actual("a completed pass replays after a worker restart without rerunning its SQL activity", async () => {
    const cap = runtime();
    let calls = 0;
    const firstWorker = await worker({ sweepReconcilePass: async (input) => { calls++; return cap.activities.sweepReconcilePass(input); } });
    let handle: WorkflowHandle;
    await firstWorker.runUntil(async () => { handle = await start(); expect(await handle.result()).toMatchObject({ status: "completed" }); });
    await Worker.runReplayHistory({ workflowBundle: { codePath: bundle } }, await handle!.fetchHistory(), handle!.workflowId);
    const secondWorker = await worker(cap.activities);
    await secondWorker.runUntil(async () => { expect(await handle!.result()).toMatchObject({ status: "completed" }); });
    expect(calls).toBe(1);
  });
  actual("cancellation reaches a held controller read, releases the global lease and runs no compensation", async () => {
    let entered = false;
    let aborted = false;
    const operationsBefore = (await db.query<{ count: number }>("select count(*)::int as count from platform.operations"))[0].count;
    const cap = runtime(async () => {
      const original = ports();
      return { ...original, state: { ...original.state, claimDue: async () => {
        entered = true;
        const signal = Context.current().cancellationSignal;
        await new Promise<void>((_resolve, reject) => { if (signal.aborted) { aborted = true; reject(signal.reason); } else signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true }); });
        return [];
      } } };
    });
    const runningWorker = await worker(cap.activities);
    await runningWorker.runUntil(async () => {
      const handle = await start();
      await waitFor("controller activity awaiting cancellation", () => entered);
      await handle.cancel();
      await expect(handle.result()).rejects.toThrow();
      expect(aborted).toBe(true);
      expect(await repos.leases.current(db, RECONCILE_SWEEP_LEASE)).toBeNull();
      expect((await db.query<{ count: number }>("select count(*)::int as count from platform.operations"))[0].count).toBe(operationsBefore);
    });
  });
  actual("claims a bounded fair SQL batch and leaves unvisited environments due for the next pass", async () => {
    const prefix = `owned-sweep-${randomUUID()}`;
    const workspaces = [`${prefix}-a`, `${prefix}-b`];
    try {
      for (let tenant = 0; tenant < workspaces.length; tenant++) {
        const connection = await repos.connections.create(db, { workspaceId: workspaces[tenant], createdBy: "schedule-fixture", config: { provider: "aws", mode: "aws_assume_role", accountId: "123456789012", region: "us-east-1", observeRoleArn: "arn:aws:iam::123456789012:role/owned-schedule-observe", deployRoleArn: "arn:aws:iam::123456789012:role/owned-schedule-deploy", externalId: "owned-schedule-fixture" } });
        await repos.connections.recordVerification(db, { workspaceId: workspaces[tenant], id: connection.id, ok: true, detail: "SQL scheduling fixture only; no provider call." });
        for (let index = 0; index < (tenant === 0 ? 14 : 13); index++) await registerEnvironment(db, { environment: { workspaceId: workspaces[tenant], environmentId: `${prefix}-${tenant}-${index}`, class: "production", provider: "aws", region: "us-east-1", connection: { id: connection.id, status: "verified" } } });
      }
      const cap = runtime();
      const runningWorker = await worker(cap.activities);
      await runningWorker.runUntil(async () => {
        const first = await (await start()).result() as ReconcileSweepResult;
        expect(first).toMatchObject({ status: "completed", counts: { claimed: 25, nothingToReconcile: 25, saturated: true } });
        const second = await (await start()).result() as ReconcileSweepResult;
        expect(second).toMatchObject({ status: "completed", counts: { claimed: 2, nothingToReconcile: 2 } });
      });
      const rows = await db.query<{ workspace_id: string; last_outcome: string; claimed_by: string | null }>("select workspace_id,last_outcome,claimed_by from platform.reconcile_state where workspace_id=any($1::text[])", [textArray(workspaces)]);
      expect(rows).toHaveLength(27);
      expect(rows.every((row) => row.last_outcome === "nothing_to_reconcile" && row.claimed_by === null)).toBe(true);
      expect(new Set(rows.map((row) => row.workspace_id))).toEqual(new Set(workspaces));
    } finally {
      await db.query("delete from platform.reconcile_state where workspace_id=any($1::text[])", [textArray(workspaces)]);
      await db.query("delete from platform.provider_connections where workspace_id=any($1::text[])", [textArray(workspaces)]);
    }
  }, 120_000);
  actual("checks every authority-bearing schedule field on a genuine describe result", async () => {
    const { handle } = await ensureReconcileSchedule(client(), runtime());
    const current = await handle.describe();
    assertCompatibleReconcileSchedule(current);
    const copies: ScheduleDescription[] = [
      { ...current, memo: { ...current.memo, zenithOwner: "foreign" } },
      { ...current, memo: { ...current.memo, extra: "foreign" } },
      { ...current, action: { ...current.action, workflowId: "foreign" } },
      { ...current, action: { ...current.action, workflowType: "foreign" } },
      { ...current, action: { ...current.action, taskQueue: "foreign" } },
      { ...current, action: { ...current.action, retry: { maximumAttempts: 2 } } },
      { ...current, action: { ...current.action, workflowExecutionTimeout: 600_000 } },
      { ...current, action: { ...current.action, args: [{ ...reconcileSweepInput(), environmentConcurrency: 1 }] } },
      { ...current, policies: { ...current.policies, overlap: ScheduleOverlapPolicy.ALLOW_ALL } },
      { ...current, policies: { ...current.policies, catchupWindow: 86_400_000 } },
      { ...current, policies: { ...current.policies, pauseOnFailure: true } },
      { ...current, state: { ...current.state, remainingActions: 1 } },
      { ...current, spec: { ...current.spec, intervals: [{ every: 1_000, offset: 0 }] } },
      { ...current, spec: { ...current.spec, endAt: new Date() } },
      { ...current, spec: { ...current.spec, jitter: 1_000 } },
    ];
    for (const changed of copies) expect(() => assertCompatibleReconcileSchedule(changed)).toThrow("existing reconciliation schedule is incompatible");
    const raw = current.raw.schedule!;
    const rawAction = raw.action!.startWorkflow!;
    // Supplemental mutations of an actual describe, not evidence that the server persisted
    // these modeled variants. Check both the SDK result and fields it may discard.
    const priorityCopy = (priority: unknown, rawPriority: unknown): ScheduleDescription => ({
      ...current,
      action: { ...current.action, priority },
      raw: { ...current.raw, schedule: { ...raw, action: { startWorkflow: { ...rawAction, priority: rawPriority } } } },
    } as unknown as ScheduleDescription);
    for (const priority of [undefined, null, {}, { priorityKey: undefined, fairnessKey: undefined, fairnessWeight: undefined }, { priorityKey: 0, fairnessKey: "", fairnessWeight: 0 }, { priorityKey: 0, fairnessKey: "", fairnessWeight: 1 }]) {
      expect(() => assertCompatibleReconcileSchedule(priorityCopy(priority, priority))).not.toThrow();
    }
    const priorityGetter = vi.fn(() => 0);
    const refusedPriorities = [
      { priorityKey: 1 }, { fairnessKey: "foreign" }, { fairnessWeight: 2 },
      { priorityKey: "0" }, { fairnessKey: 0 }, { fairnessWeight: "1" },
      { priorityKey: Number.NaN }, { fairnessWeight: Number.POSITIVE_INFINITY },
      { priorityKey: 0, unknown: undefined }, { [Symbol("unknown")]: 0 },
      Object.defineProperty({}, "unknown", { value: undefined }),
      { get priorityKey() { return priorityGetter(); } }, [], false,
    ];
    for (const priority of refusedPriorities) {
      expect(() => assertCompatibleReconcileSchedule(priorityCopy(priority, null))).toThrow("existing reconciliation schedule is incompatible");
      expect(() => assertCompatibleReconcileSchedule(priorityCopy({}, priority))).toThrow("existing reconciliation schedule is incompatible");
    }
    expect(priorityGetter).not.toHaveBeenCalled();
    for (const backoffCoefficient of [undefined, 0, 2]) {
      expect(() => assertCompatibleReconcileSchedule({ ...current, action: { ...current.action, retry: { ...current.action.retry, maximumAttempts: 1, backoffCoefficient } } })).not.toThrow();
    }
    for (const retry of [
      { maximumAttempts: 0 }, { maximumAttempts: 2 },
      { maximumAttempts: 1, backoffCoefficient: 1 }, { maximumAttempts: 1, backoffCoefficient: 3 },
      { maximumAttempts: 1, initialInterval: 2_000 }, { maximumAttempts: 1, maximumInterval: 200_000 },
      { maximumAttempts: 1, nonRetryableErrorTypes: ["foreign"] },
    ]) expect(() => assertCompatibleReconcileSchedule({ ...current, action: { ...current.action, retry } })).toThrow("existing reconciliation schedule is incompatible");
    const rawCopies: ScheduleDescription[] = [
      { ...current, raw: { ...current.raw, schedule: { ...raw, policies: { ...raw.policies, keepOriginalWorkflowId: true } } } },
      ...([{ behavior: 1, pinnedVersion: "owned-foreign-deployment.build" }, { autoUpgrade: true }, { autoUpgrade: false }] as const).map((versioningOverride) => ({ ...current, raw: { ...current.raw, schedule: { ...raw, action: { startWorkflow: { ...rawAction, versioningOverride } } } } })),
      { ...current, raw: { ...current.raw, schedule: { ...raw, action: { startWorkflow: { ...rawAction, taskQueue: { ...rawAction.taskQueue, kind: 2 } } } } } },
      { ...current, raw: { ...current.raw, schedule: { ...raw, action: { startWorkflow: { ...rawAction, taskQueue: { ...rawAction.taskQueue, normalName: "foreign-sticky-queue" } } } } } },
    ];
    for (const changed of rawCopies) expect(() => assertCompatibleReconcileSchedule(changed)).toThrow("existing reconciliation schedule is incompatible");
    for (const kind of [undefined, null, 0, 1] as const) {
      for (const versioningOverride of [undefined, null, {}, { behavior: 0, pinnedVersion: "", deployment: null, pinned: null, autoUpgrade: null, oneTime: null }] as const) {
        expect(() => assertCompatibleReconcileSchedule({ ...current, raw: { ...current.raw, schedule: { ...raw,
          policies: { ...raw.policies, keepOriginalWorkflowId: false },
          action: { startWorkflow: { ...rawAction, versioningOverride, taskQueue: { ...rawAction.taskQueue, kind, normalName: "" } } },
        } } })).not.toThrow();
      }
    }
  });
  actual("refuses persisted raw versioning and workflow-ID policies that SDK decoding omits", async () => {
    for (const field of ["versioning", "workflow-id"] as const) {
      const handle = await client().schedule.create(reconcileScheduleOptions());
      const before = await handle.describe();
      const raw = before.raw.schedule!;
      const schedule = field === "versioning"
        ? { ...raw, action: { startWorkflow: { ...raw.action!.startWorkflow!, versioningOverride: { behavior: 2 as const } } } }
        : { ...raw, policies: { ...raw.policies, keepOriginalWorkflowId: true } };
      await client().schedule.workflowService.updateSchedule({ namespace: client().schedule.options.namespace,
        scheduleId: RECONCILE_SCHEDULE_ID, schedule, conflictToken: before.raw.conflictToken,
        requestId: randomUUID(), identity: client().schedule.options.identity });
      const observed = await handle.describe();
      if (field === "versioning") {
        const override = observed.raw.schedule?.action?.startWorkflow?.versioningOverride;
        expect(override?.behavior === 2 || override?.autoUpgrade === true).toBe(true);
        expect(observed.action).not.toHaveProperty("versioningOverride");
      } else {
        expect(observed.raw.schedule?.policies?.keepOriginalWorkflowId).toBe(true);
        expect(observed.policies).not.toHaveProperty("keepOriginalWorkflowId");
      }
      expect(() => assertCompatibleReconcileSchedule(observed)).toThrow("existing reconciliation schedule is incompatible");
      await expect(ensureReconcileSchedule(client(), runtime())).rejects.toMatchObject({ code: "incompatible_schedule" });
      const after = await handle.describe();
      expect(after.raw.schedule).toEqual(observed.raw.schedule);
      expect(after.state).toMatchObject({ paused: true, note: before.state.note });
      await handle.delete();
    }
  });
});
