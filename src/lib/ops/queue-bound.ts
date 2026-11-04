/**
 * The runner job queue bound (PROD-OPS-02).
 *
 * `platform.runner_jobs` is the durable queue between the control plane and
 * customer-network runners. It is bounded here, in the store layer every
 * enqueue goes through (`repos/jobs.ts enqueue`), so no caller can bypass it:
 *
 *   operation-less reads (API-originated)   refused at the tenant's queued-job
 *                                           cap with 429 and Retry-After; the
 *                                           global cap refuses with 503.
 *   operation-bound jobs (from workflows)   NOT refused at the tenant cap. They
 *                                           belong to an operation that was
 *                                           already admitted by the dispatch
 *                                           quota (max active operations), so
 *                                           their count is bounded by that
 *                                           quota. Refusing one mid-operation
 *                                           would fail a step that already
 *                                           holds a lease, which the workflow
 *                                           can only report as `uncertain`.
 *                                           A hard ceiling at four times the
 *                                           global cap remains as a last
 *                                           defence (503) against a runaway.
 *
 * Maintenance never blocks an enqueue: in-flight operations must be able to
 * finish for a drain to be safe. New work is stopped earlier, at dispatch.
 *
 * The count-then-insert is not serialized: two concurrent enqueues can exceed
 * a cap by at most the number of concurrent writers. The bound is therefore
 * "cap plus concurrency", which is still a bound.
 */
import type { Sql } from "@/lib/controlplane/types";
import { BackpressureError } from "./errors";
import { opsLimitsFromEnv } from "./config";
import { getTenantQuota, queuedJobCount } from "./store";

/** How many times the global cap an operation-bound job may reach before it is refused. */
export const OPERATION_BOUND_CEILING_FACTOR = 4;

export interface RoomInput {
  workspaceId: string;
  /** true when the job belongs to an admitted operation */
  operationBound: boolean;
}

export async function assertRunnerQueueRoom(sql: Sql, input: RoomInput, env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  const limits = opsLimitsFromEnv(env).runnerQueue;
  const retry = opsLimitsFromEnv(env).retryAfterSec;
  const counts = await queuedJobCount(sql, input.workspaceId);
  if (input.operationBound) {
    if (counts.global >= limits.maxGlobal * OPERATION_BOUND_CEILING_FACTOR)
      throw new BackpressureError("overloaded", "runner_queue", "The runner job queue is at its hard ceiling; the control plane is shedding load.", retry * 6, input.workspaceId);
    return;
  }
  const quota = await getTenantQuota(sql, input.workspaceId);
  const tenantCap = quota?.maxQueuedJobs ?? Math.min(1_000_000, limits.maxPerTenant * (quota?.weight ?? 1));
  if (counts.workspace >= tenantCap)
    throw new BackpressureError("queue_full", "runner_queue", `This workspace already has ${counts.workspace} runner jobs waiting (limit ${tenantCap}). Wait for them to finish.`, retry * 2, input.workspaceId);
  if (counts.global >= limits.maxGlobal)
    throw new BackpressureError("overloaded", "runner_queue", "The runner job queue is full across all workspaces.", retry * 2, input.workspaceId);
}
