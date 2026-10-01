/**
 * Zenith execution worker: the long-running process that runs Temporal
 * workflow tasks and activities for real-infrastructure operations
 * (ADR-0009, docs/platform/EXECUTION-WORKER.md).
 *
 *   npx tsx workers/execution/worker.ts          (development, from the repo root)
 *   node dist/execution/worker.cjs               (container image; see docker/worker.Dockerfile)
 *
 * Activities compose the platform stores, capability/credential brokers and
 * native drivers. Required secrets and schema are checked before polling.
 *
 * Shutdown: SIGTERM / SIGINT stop polling, let running activities finish for
 * ZENITH_WORKER_SHUTDOWN_GRACE_MS, then cancel them. A second signal exits
 * immediately.
 *
 * Logs are JSON lines on stdout. Secrets (the Temporal API key, cloud
 * credentials) are never logged.
 * Loopback probes listen on ZENITH_WORKER_HEALTH_PORT (default 9464).
 * Local terminal-operation plans age out after ZENITH_WORKER_PLAN_MAX_AGE_HOURS
 * (default 24); unowned/active plans are retained conservatively.
 */

import { DefaultLogger, NativeConnection, Runtime } from "@temporalio/worker";
import { Context } from "@temporalio/activity";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ensurePlatformApp } from "@/lib/platform/app";
import type { Sql } from "@/lib/controlplane/types";
import { listDrivers } from "@/lib/drivers/types";
import { loadPolicyEngine } from "@/lib/policy";
import { planMaxAgeFromEnv, startPlanJanitor } from "@/lib/execution/plan-janitor";
import { createActivities } from "@/lib/workflows/activities";
import { connectionOptionsFor, describeTemporalConfig } from "@/lib/workflows/config";
import { executionWorkerConfigFromEnv } from "./config";
import { installShutdownHandlers } from "./lifecycle";
import { createExecutionWorker, workflowSource } from "./run";
import { ExecutionStartupError, validateExecutionConfiguration, openExecutionStore } from "./startup";
import { HEALTH_CHECK_TIMEOUT_MS, healthPortFromEnv, startHealthServer } from "./health";

function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, msg, component: "execution-worker", ...fields })}\n`);
}

async function main(): Promise<void> {
  const config = executionWorkerConfigFromEnv();
  let db: Sql | undefined;
  let connection: NativeConnection | undefined;
  let worker: Awaited<ReturnType<typeof createExecutionWorker>> | undefined;
  let policyLoaded = false;
  let stopping = () => false;
  let janitor: ReturnType<typeof startPlanJanitor> | undefined;
  let healthLog: ReturnType<typeof setInterval> | undefined;
  const endpoint = await startHealthServer({ port: healthPortFromEnv(), checks: {
    async temporal() {
      if (!connection || !worker) return undefined;
      if (stopping() || worker.getState() !== "RUNNING") return false;
      await connection.withDeadline(Date.now() + HEALTH_CHECK_TIMEOUT_MS, () => connection!.workflowService.getSystemInfo({}));
      return !stopping() && worker.getState() === "RUNNING";
    },
    async store() { if (!db) return undefined; await db.query("select 1"); return true; },
    policy: () => policyLoaded,
    drivers: () => ["aws", "kubernetes", "zenith", "gcp", "azure", "oci"].every((provider) => listDrivers().some((driver) => driver.provider === provider)),
  } });
  try {
    await validateExecutionConfiguration();
    db = await openExecutionStore();
    if (!(await ensurePlatformApp(db))) throw new ExecutionStartupError("Platform runtime composition failed; check platform schema and configuration.");
    // Load the actual verified bundle before advertising readiness, not a flag
    // inferred from platform composition (which intentionally needs no policy).
    await loadPolicyEngine();
    policyLoaded = true;
    const planDir = path.resolve(process.env.ZENITH_WORKER_PLAN_DIR ?? path.join(process.env.ZENITH_DATA ?? ".data", "platform-plans"));
    await mkdir(planDir, { recursive: true, mode: 0o700 });
    const activities = createActivities({ db, workerIdentity: config.identity, planDir, ports: { heartbeat: (detail) => Context.current().heartbeat(detail), activitySignal: () => Context.current().cancellationSignal } });
    Runtime.install({ logger: new DefaultLogger(config.logLevel) });

    const workflows = await workflowSource(config);
    if (workflows.fallbackReason) log("warn", "swc could not compile the workflows; used the esbuild fallback", { reason: workflows.fallbackReason });
    connection = await NativeConnection.connect(connectionOptionsFor(config.temporal));
    worker = await createExecutionWorker({
      config,
      connection,
      activities,
      workflows,
    });

    stopping = installShutdownHandlers({ worker, graceMs: config.shutdownGraceMs, log, signals: process, exit: (code) => process.exit(code) });
    janitor = startPlanJanitor(db, { planDir, maxAgeMs: planMaxAgeFromEnv() }, (result) => {
      if (result) log("info", "plan maintenance", { ...result });
      else log("warn", "plan maintenance unavailable; check plan directory and control store");
    });

    const startedAt = Date.now();
    log("info", "execution worker ready", {
      ...describeTemporalConfig(config.temporal),
      taskQueue: config.taskQueue,
      identity: config.identity,
      maxConcurrentActivities: config.maxConcurrentActivities,
      maxConcurrentWorkflowTasks: config.maxConcurrentWorkflowTasks,
      workflowSource: workflows.origin,
      healthPort: endpoint.port,
    });
    healthLog =
      config.healthLogIntervalMs > 0
        ? setInterval(
            () => log("info", "execution worker health", { state: worker!.getState(), uptimeSec: Math.round((Date.now() - startedAt) / 1000) }),
            config.healthLogIntervalMs
          )
        : undefined;
    healthLog?.unref();

    await worker.run();
    log("info", "execution worker stopped");
  } finally {
    stopping = () => true;
    if (healthLog) clearInterval(healthLog);
    await endpoint.close();
    await janitor?.stop();
    await connection?.close();
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    log("error", "execution worker failed", { error: err instanceof ExecutionStartupError ? err.message : "Execution stopped unexpectedly; check platform store, Temporal and worker configuration." });
    process.exit(1);
  }
);
