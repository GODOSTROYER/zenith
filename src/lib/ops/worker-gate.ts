/**
 * Weighted-fair activity scheduling in the execution worker (PROD-OPS-02).
 *
 * Temporal hands one worker its tasks in server-queue order. When a tenant has
 * many heavy activities ready at once (plans, applies, builds, observation
 * passes), that order alone lets it occupy every execution slot. This gate sits
 * in the worker's activity-interceptor chain, so it needs no change to any
 * workflow or activity: before a HEAVY activity runs it takes a permit from a
 * `FairSemaphore`, and permits are granted in weighted-fair order across
 * tenants (stride scheduling, `fair-queue.ts`), with weights from
 * `platform.tenant_quotas`.
 *
 * Guarantees, and the limits of them:
 *   - Light activities (lease, approval check, policy evaluation, step
 *     bookkeeping) never wait, so a saturated heavy lane cannot starve the
 *     bookkeeping that keeps leases alive.
 *   - Capacity defaults to 3/4 of the activity slots, so heavy work can never
 *     take the slots the light lane needs.
 *   - Waiting is bounded in count (by the slots themselves) and in time
 *     (`ZENITH_WORKER_FAIR_MAX_WAIT_MS`, default 15 s, below the 60 s heartbeat
 *     timeout the workflows use). After that the activity RUNS: fairness may
 *     delay work but must never fail it, because an activity that fails before
 *     it starts would make the workflow classify a mutating step `uncertain`
 *     (definitions/policies.ts). Bypassed runs are counted
 *     (`zenith_worker_fair_bypassed_total`) so an operator can see saturation.
 *   - What this layer cannot do: reorder tasks still in the Temporal server's
 *     queue. Bounding what a tenant can put there is the job of the dispatch
 *     quota (`max active operations`), which is why both exist.
 */
import type { ActivityInterceptorsFactory } from "@temporalio/worker";
import { isBackpressureError } from "./errors";
import { FairSemaphore, type Permit } from "./fair-queue";
import { opsMetrics } from "./telemetry/catalog";
import { tenantLabeler } from "./telemetry/metrics";
import { tracer } from "./telemetry/tracing";

/** Activities that execute provider/runner work or long reads. Everything else is the light lane. */
export const HEAVY_ACTIVITIES: ReadonlySet<string> = new Set([
  "planInfrastructure", "applyInfrastructure", "buildArtifacts", "deployWorkloads", "runMigrations",
  "verifyInfrastructure", "verifyApplication", "observeEnvironment", "executeCapability", "reconcileObserve",
]);

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
export const SYSTEM_TENANT = "_system";

/** Tenant and operation of an activity from its first argument (every execution activity takes one object with ids). */
export function activityScope(args: readonly unknown[]): { tenant: string; operationId?: string } {
  const first = args[0];
  if (typeof first !== "object" || first === null) return { tenant: SYSTEM_TENANT };
  const o = first as Record<string, unknown>;
  const ws = typeof o.workspaceId === "string" && ID.test(o.workspaceId) ? o.workspaceId : SYSTEM_TENANT;
  const op = typeof o.operationId === "string" && ID.test(o.operationId) ? o.operationId : undefined;
  return { tenant: ws, ...(op ? { operationId: op } : {}) };
}

export interface WorkerFairGateOptions {
  /** the worker's total activity execution slots */
  activitySlots: number;
  /** heavy-lane permits; default 3/4 of the slots, at least 1 */
  capacity?: number;
  maxWaitMs: number;
}

export class WorkerFairGate {
  readonly semaphore: FairSemaphore;
  private weights = new Map<string, number>();
  constructor(private readonly opts: WorkerFairGateOptions) {
    const slots = Math.max(1, opts.activitySlots);
    const capacity = Math.min(slots, Math.max(1, opts.capacity ?? Math.floor((slots * 3) / 4)));
    this.semaphore = new FairSemaphore(capacity, { maxPerTenant: slots, maxTotal: slots });
  }

  /** Replace the tenant weight table (from `tenant_quotas`); tenants not listed weigh 1. */
  setWeights(weights: ReadonlyMap<string, number>): void { this.weights = new Map(weights); }
  weightOf(tenant: string): number { return this.weights.get(tenant) ?? 1; }

  async run<T>(activity: string, args: readonly unknown[], work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const m = opsMetrics();
    const { tenant, operationId } = activityScope(args);
    const label = tenantLabeler().label(tenant === SYSTEM_TENANT ? undefined : tenant);
    const heavy = HEAVY_ACTIVITIES.has(activity);
    const span = tracer().startSpan(`activity ${activity}`, {
      kind: "consumer",
      attributes: { "zenith.tenant.id": tenant, "zenith.operation.id": operationId, "zenith.operation.class": "activity", "zenith.activity.type": activity, "zenith.lane": heavy ? "heavy" : "light" },
    });
    const started = performance.now();
    let permit: Permit | undefined;
    let outcome = "ok";
    try {
      if (heavy) {
        try {
          permit = await this.semaphore.acquire(tenant, { weight: this.weightOf(tenant), maxWaitMs: this.opts.maxWaitMs, ...(signal ? { signal } : {}) });
        } catch (error) {
          // A full fair queue must not fail work that has not started; only a cancellation propagates.
          if (!isBackpressureError(error)) throw error;
        }
        m.workerWait.observe({ activity }, (permit?.waitedMs ?? 0) / 1000);
        span.setAttribute("zenith.fair.wait_ms", permit?.waitedMs ?? 0);
        if (!permit || permit.bypassed) {
          m.workerFairBypassed.inc({ tenant: label });
          span.setAttribute("zenith.fair.bypassed", true);
        }
        this.gauges();
      }
      return await tracer().withActive(span, work);
    } catch (error) {
      outcome = "error";
      span.setStatus("error", error instanceof Error ? error.name : "error");
      throw error;
    } finally {
      permit?.release();
      if (heavy) this.gauges();
      m.workerActivities.inc({ tenant: label, activity, outcome });
      m.workerDuration.observe({ activity }, (performance.now() - started) / 1000);
      if (outcome === "ok") span.setStatus("ok");
      span.end();
    }
  }

  private gauges(): void {
    const m = opsMetrics();
    m.workerFairInflight.set({}, this.semaphore.inFlight);
    m.workerFairWaiting.set({}, this.semaphore.waitingCount);
  }
}

const key = Symbol.for("zenith.ops.worker-gate.v1");
type G = typeof globalThis & { [key]?: WorkerFairGate };

/** The process's gate, if a worker installed one. */
export function workerFairGate(): WorkerFairGate | undefined {
  return (globalThis as G)[key];
}

/** Build and register the gate for this worker process (replaces any earlier one). */
export function installWorkerFairGate(options: WorkerFairGateOptions): WorkerFairGate {
  return ((globalThis as G)[key] = new WorkerFairGate(options));
}

export function resetWorkerFairGateForTests(): void { (globalThis as G)[key] = undefined; }

/** The interceptor factory the worker registers (`interceptors.activity`). */
export function fairActivityInterceptors(gate: WorkerFairGate): ActivityInterceptorsFactory {
  return (ctx) => ({
    inbound: {
      execute: (input, next) => gate.run(ctx.info.activityType, input.args, () => next(input), ctx.cancellationSignal),
    },
  });
}
