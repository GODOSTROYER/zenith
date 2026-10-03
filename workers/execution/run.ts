/**
 * Worker construction, separate from the process entry point so tests can build
 * a worker against a test server without reading the environment or installing
 * signal handlers.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { Worker, type NativeConnection, type WorkerOptions } from "@temporalio/worker";
import type { WorkerActivities } from "@/lib/workflows/types";
import { bundleDefinitions, type BundlerKind } from "./bundle";
import type { ExecutionWorkerConfig } from "./config";
import type { Client } from "@temporalio/client";
import { TASK_QUEUE } from "@/lib/workflows/types";

/** Where the TypeScript workflow definitions live, relative to this file. */
export function defaultWorkflowsPath(): string {
  const here = typeof __dirname === "string" ? __dirname : process.cwd();
  return path.resolve(here, "../../src/lib/workflows/definitions/index.ts");
}

export type WorkflowSource = Required<Pick<WorkerOptions, "workflowBundle">> & {
  /** how the workflow code was obtained, for the start-up log line */
  origin: "prebuilt-bundle" | `typescript-source (${BundlerKind})`;
  /** set when the esbuild fallback was used; log it */
  fallbackReason?: string;
};

/**
 * A prebuilt bundle when configured (production: no bundler at start-up),
 * otherwise the definitions are bundled from source. The definitions use
 * relative imports only, so the bundler needs no `@/` alias.
 */
export async function workflowSource(
  config: Pick<ExecutionWorkerConfig, "workflowBundlePath">,
  workflowsPath: string = defaultWorkflowsPath()
): Promise<WorkflowSource> {
  if (config.workflowBundlePath) {
    if (!existsSync(config.workflowBundlePath)) throw new Error(`ZENITH_WORKER_WORKFLOW_BUNDLE points at ${config.workflowBundlePath}, which does not exist`);
    return { workflowBundle: { codePath: config.workflowBundlePath }, origin: "prebuilt-bundle" };
  }
  if (!existsSync(workflowsPath)) {
    throw new Error(`workflow definitions not found at ${workflowsPath}; build a bundle (workers/execution/build-bundle.ts) and set ZENITH_WORKER_WORKFLOW_BUNDLE`);
  }
  const { code, sourceMap, bundler, fallbackReason } = await bundleDefinitions(workflowsPath);
  return { workflowBundle: { code, sourceMap }, origin: `typescript-source (${bundler})`, ...(fallbackReason ? { fallbackReason } : {}) };
}

export interface CreateWorkerInput {
  config: ExecutionWorkerConfig;
  connection: NativeConnection;
  activities: WorkerActivities;
  workflows: WorkflowSource;
}

/** Pure mapping from config to Temporal worker options (unit-tested). */
export function workerOptions({ config, connection, activities, workflows }: CreateWorkerInput): WorkerOptions {
  return {
    connection,
    namespace: config.temporal.namespace,
    taskQueue: config.taskQueue,
    identity: config.identity,
    activities: { ...activities },
    maxConcurrentActivityTaskExecutions: config.maxConcurrentActivities,
    maxConcurrentWorkflowTaskExecutions: config.maxConcurrentWorkflowTasks,
    // After a shutdown request the worker stops polling and lets running
    // activities finish for this long; then it cancels them (delivered through
    // heartbeats) and finally abandons them.
    shutdownGraceTime: config.shutdownGraceMs,
    // Heartbeats are throttled to 80% of the activity's heartbeatTimeout (48 s
    // for the 60 s the workflows use), and a cancel request reaches a running
    // activity only in a heartbeat response. Capping the throttle bounds how
    // long a cancelled apply keeps running before it notices.
    maxHeartbeatThrottleInterval: config.heartbeatThrottleMs,
    defaultHeartbeatThrottleInterval: config.heartbeatThrottleMs,
    workflowBundle: workflows.workflowBundle,
  };
}

export function createExecutionWorker(input: CreateWorkerInput): Promise<Worker> {
  return Worker.create(workerOptions(input));
}

/** Worker.run must already be active. Observe our fresh normal workflow AND activity pollers. */
export async function awaitReconcilePollers(worker: Pick<Worker, "getState">, client: Client, config: Pick<ExecutionWorkerConfig, "identity" | "taskQueue" | "temporal">, startedAt: number): Promise<void> {
  if (config.taskQueue !== TASK_QUEUE) throw new Error("This worker cannot service the fixed reconciliation task queue.");
  if (!Number.isSafeInteger(startedAt) || startedAt < 0 || startedAt > Date.now()) throw new Error("The reconciliation polling start is invalid.");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (worker.getState() !== "RUNNING") throw new Error("The execution worker is not polling.");
    let observed = true;
    for (const taskQueueType of [1, 2]) {
      const response = await client.connection.withDeadline(deadline, () => client.workflowService.describeTaskQueue({
        namespace: config.temporal.namespace, taskQueue: { name: TASK_QUEUE, kind: 1 }, taskQueueType,
      }));
      if (!response.pollers?.some(poller => {
        const stamp = poller.lastAccessTime;
        const seconds = Number(stamp?.seconds?.toString());
        const nanos = stamp?.nanos ?? 0;
        const accessedAt = seconds * 1000 + nanos / 1_000_000;
        return poller.identity === config.identity && Number.isSafeInteger(seconds)
          && Number.isInteger(nanos) && nanos >= 0 && nanos < 1_000_000_000
          && accessedAt >= startedAt && accessedAt <= Date.now() + 5_000;
      })) observed = false;
    }
    if (observed && worker.getState() === "RUNNING") return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Fresh reconciliation workflow/activity pollers were not observed.");
}
