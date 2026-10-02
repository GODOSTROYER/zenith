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

import { DefaultLogger, NativeConnection, Runtime, Worker } from "@temporalio/worker";
import { Context } from "@temporalio/activity";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ensurePlatformApp } from "@/lib/platform/app";
import type { Sql } from "@/lib/controlplane/types";
import { listDrivers } from "@/lib/drivers/types";
import { loadPolicyEngine } from "@/lib/policy";
import { planMaxAgeFromEnv, startPlanJanitor } from "@/lib/execution/plan-janitor";
import { createAzureSourceStorageResolver } from "@/lib/providers/azure/release/source-binding";
import { createActivities } from "@/lib/workflows/activities";
import { connectionOptionsFor, describeTemporalConfig } from "@/lib/workflows/config";
import { temporalDataConverterFromEnv } from "@/lib/workflows/codec";
import { executionWorkerConfigFromEnv } from "./config";
import { installShutdownHandlers } from "./lifecycle";
import { workerOptions, workflowSource } from "./run";
import { ExecutionStartupError, validateExecutionConfiguration, openExecutionStore, closeExecutionStore, type ExecutionFailureCategory } from "./startup";
import { HEALTH_CHECK_TIMEOUT_MS, healthPortFromEnv, startHealthServer } from "./health";

function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, msg, component: "execution-worker", ...fields })}\n`);
}

let failureCategory: ExecutionFailureCategory = "configuration";
async function main(): Promise<void> {
  const config = executionWorkerConfigFromEnv();
  const dataConverter = temporalDataConverterFromEnv();
  let db: Sql | undefined;
  let connection: NativeConnection | undefined;
  let worker: Worker | undefined;
  let policyLoaded = false;
  let stopping = () => false;
  let janitor: ReturnType<typeof startPlanJanitor> | undefined;
  let healthLog: ReturnType<typeof setInterval> | undefined;
  failureCategory = "health-listener";
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
    failureCategory = "configuration";
    await validateExecutionConfiguration();
    failureCategory = "platform-store";
    db = await openExecutionStore();
    failureCategory = "platform-composition";
    if (!(await ensurePlatformApp(db))) throw new ExecutionStartupError("Platform runtime composition failed; check platform schema and configuration.");
    // Load the actual verified bundle before advertising readiness, not a flag
    // inferred from platform composition (which intentionally needs no policy).
    failureCategory = "policy-assets";
    await loadPolicyEngine();
    policyLoaded = true;
    const planDir = path.resolve(process.env.ZENITH_WORKER_PLAN_DIR ?? path.join(process.env.ZENITH_DATA ?? ".data", "platform-plans"));
    failureCategory = "plan-directory";
    await mkdir(planDir, { recursive: true, mode: 0o700 });
    failureCategory = "activity-composition";
    const activities = createActivities({ db, workerIdentity: config.identity, planDir, sourceBundles: { azureStorage: createAzureSourceStorageResolver(db) }, ports: { heartbeat: (detail) => Context.current().heartbeat(detail), activitySignal: () => Context.current().cancellationSignal } });
    failureCategory = "temporal-runtime";
    Runtime.install({ logger: new DefaultLogger(config.logLevel) });

    failureCategory = "workflow-bundle";
    const workflows = await workflowSource(config);
    if (workflows.fallbackReason) log("warn", "swc could not compile the workflows; used the esbuild fallback", { reason: workflows.fallbackReason });
    failureCategory = "temporal-connect";
    connection = await NativeConnection.connect(connectionOptionsFor(config.temporal));
    failureCategory = "temporal-worker";
    worker = await Worker.create({
      ...workerOptions({
        config,
        connection,
        activities,
        workflows,
      }),
      dataConverter,
    });

    failureCategory = "worker-lifecycle";
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

    failureCategory = "worker-run";
    await worker.run();
    log("info", "execution worker stopped");
    failureCategory = "resource-close";
  } finally {
    stopping = () => true;
    if (healthLog) clearInterval(healthLog);
    // A failed close must not strand another owned resource during shutdown.
    try { await endpoint.close(); }
    finally {
      try { await janitor?.stop(); }
      finally {
        try { await connection?.close(); }
        finally { await closeExecutionStore(db); }
      }
    }
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    log("error", "execution worker failed", { failureCategory, error: err instanceof ExecutionStartupError ? err.message : "Execution stopped unexpectedly; check platform store, Temporal and worker configuration." });
    process.exit(1);
  }
);
