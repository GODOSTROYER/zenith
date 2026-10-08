/** Genuine default activities on natural Temporal timers. No schedule.trigger, backdated health or fake activities. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { Client, Connection, ScheduleNotFoundError } from "@temporalio/client";
import { openPlatformDb, repos } from "@/lib/controlplane/db";
import { withLease } from "@/lib/controlplane/leases";
import { assertCompatibleCriticalSchedule, CRITICAL_SCHEDULE_ID } from "@/lib/workflows/critical-schedule";
import { assertCompatibleReconcileSchedule, RECONCILE_SCHEDULE_ID } from "@/lib/workflows/reconcile-schedule";
import { TASK_QUEUE } from "@/lib/workflows/types";
import { assignPlan } from "@/lib/billing/store";
import { DEFAULT_PLAN_ID } from "@/lib/billing/plans";
import { localUrl, CORE_JOBS, assertMaintenancePreconditions, seededEpoch } from "./preconditions";

async function wait<T>(read: () => Promise<T | false>, budgetMs = 180_000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  do { const value = await read(); if (value !== false) return value; await new Promise(resolve => setTimeout(resolve, 1000)); } while (Date.now() < deadline);
  throw new Error("Default maintenance acceptance deadline exceeded.");
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill("SIGTERM");
  const kill = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try { await closed; } finally { clearTimeout(kill); }
}
export async function defaultMaintenanceAcceptance(): Promise<Record<string, unknown>> {
  assert(process.env.ZENITH_TEST_MAINTENANCE === "1", "Not run: needs the Mac default stack and ZENITH_TEST_MAINTENANCE=1.");
  localUrl(process.env.ZENITH_PLATFORM_DB_URL ?? "", ["postgres:", "postgresql:"]);
  localUrl(process.env.ZENITH_J4_API_ORIGIN ?? "", ["http:", "https:"]);
  const db = await openPlatformDb({ kind: "postgres", url: process.env.ZENITH_PLATFORM_DB_URL!, migrate: false, max: 2 });
  let connection: Connection | undefined, worker: ChildProcess | undefined;
  const ownedSchedules: string[] = [];
  const workspaceId = `j4-billing-${randomUUID()}`;
  try {
    const epoch = await assertMaintenancePreconditions(db, process.env);
    connection = await Connection.connect({ address: process.env.ZENITH_TEMPORAL_ADDRESS });
    const client = new Client({ connection, namespace: process.env.ZENITH_TEMPORAL_NAMESPACE });
    for (const id of [CRITICAL_SCHEDULE_ID, RECONCILE_SCHEDULE_ID]) await assert.rejects(client.schedule.getHandle(id).describe(), ScheduleNotFoundError);
    for (const taskQueueType of [1, 2]) {
      const queue = await client.workflowService.describeTaskQueue({ namespace: process.env.ZENITH_TEMPORAL_NAMESPACE, taskQueue: { name: TASK_QUEUE }, taskQueueType });
      assert((queue.pollers?.length ?? 0) === 0, "Isolated namespace already has a worker.");
    }
    // Record fixture timestamps only after the migration's immutable epoch. No singleton INSERT/UPDATE/DELETE.
    await assignPlan(db, { workspaceId, planId: DEFAULT_PLAN_ID, actor: "test:j4", reason: "owned local rehearsal" });
    const nonce = randomUUID();
    await db.query("insert into platform.agent_nonces(agent_id, nonce, seen_at) values ($1,$2,clock_timestamp() - interval '21 minutes')", [workspaceId, nonce]);
    const secret = (await readFile(process.env.ZENITH_J4_CRON_SECRET_FILE!, "utf8")).trim();
    assert(secret.length > 0, "Cron-secret file is empty.");
    const http = async (route: string) => {
      const response = await fetch(new URL(route, process.env.ZENITH_J4_API_ORIGIN), { method: "POST", headers: { authorization: `Bearer ${secret}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
      assert(response.ok, "Default tick/status HTTP request failed.");
      return await response.json() as Record<string, unknown>;
    };
    const start = () => {
      const child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "workers/execution/worker.ts"], { env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=1024", ZENITH_WORKER_IDENTITY: `j4-maintenance-${randomUUID()}`, ZENITH_WORKER_RECONCILE_SCHEDULE_MODE: "provision", ZENITH_WORKER_RECONCILE_MAX_ENVIRONMENTS: "1", ZENITH_WORKER_RECONCILE_CONCURRENCY: "1" }, stdio: "ignore", windowsHide: true });
      child.once("error", () => { /* wait() fails on absent health; no secret-bearing diagnostics */ });
      worker = child;
    };
    const healthy = async (minimum: number) => {
      assert(worker?.exitCode === null && worker?.signalCode === null, "Owned worker exited.");
      const rows = await repos.scheduledJobs.listScheduledJobs(db);
      return [...CORE_JOBS, "billing"].every(job => rows.some(row => row.job === job && row.runsTotal >= minimum && row.lastStatus === "ok" && row.lastSuccessSource === "temporal")) ? rows : false;
    };
    ownedSchedules.push(CRITICAL_SCHEDULE_ID, RECONCILE_SCHEDULE_ID);
    start();
    const first = await wait(() => healthy(1));

    const critical = await client.schedule.getHandle(CRITICAL_SCHEDULE_ID).describe();
    assertCompatibleCriticalSchedule(critical);
    assertCompatibleReconcileSchedule(await client.schedule.getHandle(RECONCILE_SCHEDULE_ID).describe(), { contract: "zenith.reconcile-sweep.v1", maxEnvironments: 1, environmentConcurrency: 1 });
    assert(!critical.state.paused && critical.info.numActionsTaken > 0, "Natural maintenance timer never fired.");
    const pruned = await db.query("select nonce from platform.agent_nonces where agent_id=$1 and nonce=$2", [workspaceId, nonce]);
    assert(pruned.length === 0, "Default housekeeping did not prune the seeded expired nonce.");
    assert(first.find(row => row.job === "billing")!.lastCounts.accounts >= 1, "Default billing did not examine durable accounts.");
    // Hold the real shared lease across a natural timer, then issue the actual fallback route.
    await withLease(db, { scope: "critical-job:runbooks", holder: `test:j4:${randomUUID()}`, ttlMs: 120_000 }, async (_lease, signal) => {
      const before = (await repos.scheduledJobs.getScheduledJob(db, "runbooks"))!.runsTotal;
      const actions = (await client.schedule.getHandle(CRITICAL_SCHEDULE_ID).describe()).info.numActionsTaken;
      await wait(async () => {
        signal.throwIfAborted();
        const current = await client.schedule.getHandle(CRITICAL_SCHEDULE_ID).describe();
        if (current.info.numActionsTaken <= actions || current.info.runningActions.length) return false;
        const recent = current.info.recentActions.at(-1);
        assert(recent?.action.type === "startWorkflow", "Natural action is absent.");
        const result = await client.workflow.getHandle(recent.action.workflow.workflowId, recent.action.workflow.firstExecutionRunId).result() as { runbooks: string };
        assert(result.runbooks === "busy", "Natural default runbooks pass overlapped the held lease.");
        return true;
      });
      const fallback = await http("/api/internal/tick/runbooks");
      assert(["busy", "durable_current"].includes(String(fallback.deferred)), "HTTP fallback did not defer.");
      assert((await repos.scheduledJobs.getScheduledJob(db, "runbooks"))!.runsTotal === before, "A second runbook pass overlapped.");
    });
    await stop(worker!); worker = undefined;
    // Real elapsed time, longer than both fallback deferral and two minute cadences.
    const until = Date.now() + 125_000;
    while (Date.now() < until) await new Promise(resolve => setTimeout(resolve, Math.min(1000, until - Date.now())));
    const fallback = await http("/api/internal/tick/runbooks");
    assert(fallback.ran === true, "Fallback did not resume during the worker outage.");
    assert((await repos.scheduledJobs.getScheduledJob(db, "runbooks"))!.lastSuccessSource === "fallback");
    const beforeRestart = await repos.scheduledJobs.listScheduledJobs(db);
    const previousActions = (await client.schedule.getHandle(CRITICAL_SCHEDULE_ID).describe()).info.numActionsTaken;
    start();
    const after = await wait(async () => {
      const rows = await healthy(2);
      return rows && [...CORE_JOBS, "billing"].every(job => rows.find(r => r.job === job)!.runsTotal > beforeRestart.find(r => r.job === job)!.runsTotal) ? rows : false;
    });
    const recovered = await client.schedule.getHandle(CRITICAL_SCHEDULE_ID).describe();
    assertCompatibleCriticalSchedule(recovered);
    assert(recovered.info.numActionsTaken >= previousActions, "Schedule history did not survive worker restart.");
    assert(after.find(r => r.job === "housekeeping")!.missedTicksTotal > 0, "Natural outage was not counted.");
    const status = await http("/api/internal/tick/status");
    assert(Array.isArray(status.jobs) && [...CORE_JOBS, "billing"].every(job => (status.jobs as { job: string; durable: boolean; state: string }[]).some(row => row.job === job && row.durable && row.state === "healthy")), "Default API health does not match durable readback.");
    assert(await seededEpoch(db) === epoch, "Published cleanup epoch changed.");
    return { schema: 1, level: "local_engine", naturalTimers: true, schedules: 2, criticalJobs: CORE_JOBS.length, billing: true, workerRestart: true, fallbackResumed: true, jobLeaseExclusion: true, housekeepingEffect: true, epochPreserved: true };
  } finally {
    const errors: unknown[] = [];
    // Drain while our worker is still alive. A cleanup failure never prevents stopping our child.
    if (connection && worker && worker.exitCode === null && worker.signalCode === null) {
      try {
        const client = new Client({ connection, namespace: process.env.ZENITH_TEMPORAL_NAMESPACE });
        for (const id of ownedSchedules) {
          try { await client.schedule.getHandle(id).pause("J4 owned cleanup drain."); }
          catch (error) { if (!(error instanceof ScheduleNotFoundError)) throw error; }
        }
        await wait(async () => {
          for (const id of ownedSchedules) {
            try { if ((await client.schedule.getHandle(id).describe()).info.runningActions.length) return false; }
            catch (error) { if (!(error instanceof ScheduleNotFoundError)) throw error; }
          }
          return true;
        }, 120_000);
      } catch (error) { errors.push(error); }
    }
    try { if (worker) await stop(worker); } catch (error) { errors.push(error); }
    if (connection) {
      try {
        if (!errors.length) {
          const client = new Client({ connection, namespace: process.env.ZENITH_TEMPORAL_NAMESPACE });
          for (const id of ownedSchedules) {
            const handle = client.schedule.getHandle(id);
            try { await handle.pause("J4 owned rehearsal cleanup."); }
            catch (error) { if (error instanceof ScheduleNotFoundError) continue; throw error; }
            const current = await handle.describe();
            assert(current.info.runningActions.length === 0, "Running workflow remains; retain namespace/database.");
            await handle.delete();
            await assert.rejects(handle.describe(), ScheduleNotFoundError);
          }
        }
      } catch (error) { errors.push(error); }
      finally { try { await connection.close(); } catch (error) { errors.push(error); } }
    }
    try { await db.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Owned maintenance cleanup is unconfirmed; retain namespace/database.");
  }
}
