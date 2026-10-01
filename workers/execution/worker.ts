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
 */

import { DefaultLogger, NativeConnection, Runtime } from "@temporalio/worker";
import { Context } from "@temporalio/activity";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ensurePlatformApp } from "@/lib/platform/app";
import { createActivities } from "@/lib/workflows/activities";
import { connectionOptionsFor, describeTemporalConfig } from "@/lib/workflows/config";
import { executionWorkerConfigFromEnv } from "./config";
import { installShutdownHandlers } from "./lifecycle";
import { createExecutionWorker, workflowSource } from "./run";
import { ExecutionStartupError, validateExecutionConfiguration, openExecutionStore } from "./startup";

function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, msg, component: "execution-worker", ...fields })}\n`);
}

async function main(): Promise<void> {
  const config = executionWorkerConfigFromEnv();
  await validateExecutionConfiguration();
  const db = await openExecutionStore();
  if (!(await ensurePlatformApp(db))) throw new ExecutionStartupError("Platform runtime composition failed; check platform schema and configuration.");
  const planDir = path.resolve(process.env.ZENITH_WORKER_PLAN_DIR ?? path.join(process.env.ZENITH_DATA ?? ".data", "platform-plans"));
  await mkdir(planDir, { recursive: true, mode: 0o700 });
  const activities = createActivities({ db, workerIdentity: config.identity, planDir, ports: { heartbeat: (detail) => Context.current().heartbeat(detail), activitySignal: () => Context.current().cancellationSignal } });
  Runtime.install({ logger: new DefaultLogger(config.logLevel) });

  const workflows = await workflowSource(config);
  if (workflows.fallbackReason) log("warn", "swc could not compile the workflows; used the esbuild fallback", { reason: workflows.fallbackReason });
  const connection = await NativeConnection.connect(connectionOptionsFor(config.temporal));
  const worker = await createExecutionWorker({
    config,
    connection,
    activities,
    workflows,
  });

  installShutdownHandlers({ worker, graceMs: config.shutdownGraceMs, log, signals: process, exit: (code) => process.exit(code) });

  const startedAt = Date.now();
  log("info", "execution worker ready", {
    ...describeTemporalConfig(config.temporal),
    taskQueue: config.taskQueue,
    identity: config.identity,
    maxConcurrentActivities: config.maxConcurrentActivities,
    maxConcurrentWorkflowTasks: config.maxConcurrentWorkflowTasks,
    workflowSource: workflows.origin,
  });
  const health =
    config.healthLogIntervalMs > 0
      ? setInterval(
          () => log("info", "execution worker health", { state: worker.getState(), uptimeSec: Math.round((Date.now() - startedAt) / 1000) }),
          config.healthLogIntervalMs
        )
      : undefined;
  health?.unref();

  try {
    await worker.run();
    log("info", "execution worker stopped");
  } finally {
    if (health) clearInterval(health);
    await connection.close();
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    log("error", "execution worker failed", { error: err instanceof ExecutionStartupError ? err.message : "Execution stopped unexpectedly; check platform store, Temporal and worker configuration." });
    process.exit(1);
  }
);
