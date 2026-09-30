/**
 * Environment for the execution worker process. Connection settings
 * (ZENITH_TEMPORAL_*) are parsed by `src/lib/workflows/config.ts`; this file
 * owns the worker-specific knobs.
 *
 *   ZENITH_WORKER_TASK_QUEUE                     task queue to poll            (default zenith-execution)
 *   ZENITH_WORKER_MAX_CONCURRENT_ACTIVITIES      parallel activity executions  (default 8, 1..1000)
 *   ZENITH_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS  parallel workflow tasks       (default 40, 1..1000)
 *   ZENITH_WORKER_SHUTDOWN_GRACE_MS              how long running activities may finish after
 *                                                SIGTERM before they are cancelled (default 600000)
 *   ZENITH_WORKER_HEARTBEAT_THROTTLE_MS          longest gap between an activity's heartbeats reaching the
 *                                                server, which is also how long a cancel request can take
 *                                                to reach a running activity   (default 10000, 100..60000)
 *   ZENITH_WORKER_WORKFLOW_BUNDLE                path to a prebuilt workflow bundle (production);
 *                                                unset -> bundle the TypeScript definitions at start-up
 *   ZENITH_WORKER_LOG_LEVEL                      TRACE|DEBUG|INFO|WARN|ERROR   (default INFO)
 *   ZENITH_WORKER_HEALTH_LOG_INTERVAL_MS         periodic health line; 0 disables (default 60000)
 *   ZENITH_WORKER_IDENTITY                       worker identity in Temporal   (default zenith-exec:<host>:<pid>)
 */

import { hostname } from "node:os";
import { TASK_QUEUE } from "@/lib/workflows/types";
import { temporalConfigFromEnv, type TemporalConnectionConfig } from "@/lib/workflows/config";

export interface ExecutionWorkerConfig {
  temporal: TemporalConnectionConfig;
  taskQueue: string;
  maxConcurrentActivities: number;
  maxConcurrentWorkflowTasks: number;
  shutdownGraceMs: number;
  heartbeatThrottleMs: number;
  workflowBundlePath?: string;
  logLevel: "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR";
  healthLogIntervalMs: number;
  identity: string;
}

export class WorkerConfigError extends Error {
  readonly code = "worker_config_invalid";
}

type Env = Readonly<Record<string, string | undefined>>;

function intFrom(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new WorkerConfigError(`${name} must be a whole number`);
  const value = Number(raw);
  if (value < min || value > max) throw new WorkerConfigError(`${name} must be between ${min} and ${max}`);
  return value;
}

const LEVELS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"] as const;

export function executionWorkerConfigFromEnv(env: Env = process.env): ExecutionWorkerConfig {
  const level = (env.ZENITH_WORKER_LOG_LEVEL?.trim().toUpperCase() || "INFO") as (typeof LEVELS)[number];
  if (!LEVELS.includes(level)) throw new WorkerConfigError(`ZENITH_WORKER_LOG_LEVEL must be one of ${LEVELS.join(", ")}`);
  const taskQueue = env.ZENITH_WORKER_TASK_QUEUE?.trim() || TASK_QUEUE;
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(taskQueue)) throw new WorkerConfigError("ZENITH_WORKER_TASK_QUEUE contains characters Temporal does not allow");
  return {
    temporal: temporalConfigFromEnv(env),
    taskQueue,
    maxConcurrentActivities: intFrom(env, "ZENITH_WORKER_MAX_CONCURRENT_ACTIVITIES", 8, 1, 1000),
    maxConcurrentWorkflowTasks: intFrom(env, "ZENITH_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS", 40, 1, 1000),
    shutdownGraceMs: intFrom(env, "ZENITH_WORKER_SHUTDOWN_GRACE_MS", 600_000, 0, 24 * 3600_000),
    heartbeatThrottleMs: intFrom(env, "ZENITH_WORKER_HEARTBEAT_THROTTLE_MS", 10_000, 100, 60_000),
    workflowBundlePath: env.ZENITH_WORKER_WORKFLOW_BUNDLE?.trim() || undefined,
    logLevel: level,
    healthLogIntervalMs: intFrom(env, "ZENITH_WORKER_HEALTH_LOG_INTERVAL_MS", 60_000, 0, 24 * 3600_000),
    identity: env.ZENITH_WORKER_IDENTITY?.trim() || `zenith-exec:${hostname()}:${process.pid}`,
  };
}
