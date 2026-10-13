/**
 * Durable SLI samples from this process's live metrics (PROD-OPS-01).
 *
 * `flushSloSamples` is called from `sampleControlPlane` (ops/sampler.ts), which already runs on every scrape of
 * `/api/internal/metrics` and on the execution worker's timer, so no new scheduler is invented. Each call adds the
 * DELTA of this process's cumulative API counters since its previous flush to `platform.slo_samples`; a restart
 * (counters going back to zero) is detected and the new reading is taken whole. Scheduler health is sampled from
 * the OBS-04 job records at most once per `SCHEDULER_SAMPLE_MS` per process. Failure never propagates: a sampling
 * problem must not make the sampler (and therefore the store-up signal) fail.
 */
import type { Sql } from "@/lib/controlplane/types";
import { metricsRegistry } from "@/lib/ops/telemetry/metrics";
import { sloDefinitions, type LatencyRatioObjective } from "./definitions";
import { apiAvailabilityFromSnapshot, apiLatencyFromSnapshot, counterDelta, type GoodTotal } from "./sli";
import { addSamples, pruneSamples, setBucketSample, type SampleInput } from "./store";

export const SLI_API_AVAILABILITY = "api_availability";
export const SLI_API_LATENCY = "api_latency";
export const SLI_SCHEDULER_HEALTH = "scheduler_health";

const SCHEDULER_SAMPLE_MS = 60_000;
const PRUNE_EVERY_MS = 6 * 3_600_000;

const last: { availability?: GoodTotal; latency?: GoodTotal; schedulerAt: number; pruneAt: number } = { schedulerAt: 0, pruneAt: 0 };

export function resetSloRecorderForTests(): void {
  last.availability = undefined;
  last.latency = undefined;
  last.schedulerAt = 0;
  last.pruneAt = 0;
}

/** Pure part: the sample entries for one flush, given the previous cumulative readings. Exposed for tests. */
export function apiSampleEntries(snapshot: ReturnType<ReturnType<typeof metricsRegistry>["snapshot"]>, latencyThresholdSeconds: number, previous: { availability?: GoodTotal; latency?: GoodTotal }): { entries: SampleInput[]; availability: GoodTotal; latency: GoodTotal } {
  const availability = apiAvailabilityFromSnapshot(snapshot);
  const lat = apiLatencyFromSnapshot(snapshot, latencyThresholdSeconds);
  const latency = { good: lat.good, total: lat.total };
  const a = counterDelta(previous.availability, availability);
  const l = counterDelta(previous.latency, latency);
  return {
    entries: [{ sli: SLI_API_AVAILABILITY, ...a }, { sli: SLI_API_LATENCY, ...l }],
    availability,
    latency,
  };
}

export async function flushSloSamples(sql: Sql, nowMs: number = Date.now()): Promise<void> {
  try {
    const defs = sloDefinitions();
    const latencyDef = defs.objectives.find((o): o is LatencyRatioObjective => o.id === "api_latency" && o.kind === "latency_ratio");
    const { entries, availability, latency } = apiSampleEntries(metricsRegistry().snapshot(), latencyDef?.thresholdSeconds ?? 0.5, last);
    const batch = [...entries];
    if (nowMs - last.schedulerAt >= SCHEDULER_SAMPLE_MS) {
      const { criticalJobHealth, CRITICAL_JOBS } = await import("@/lib/platform/critical-jobs");
      const health = await criticalJobHealth(sql);
      // never_run durable-only jobs mean "no durable scheduler installed", not an unhealthy scheduler
      const sampled = health.jobs.filter((j) => !(j.state === "never_run" && "durableOnly" in CRITICAL_JOBS[j.job]));
      if (sampled.length > 0) batch.push({ sli: SLI_SCHEDULER_HEALTH, good: sampled.filter((j) => j.state === "healthy").length, total: sampled.length });
      last.schedulerAt = nowMs;
    }
    await addSamples(sql, batch);
    last.availability = availability;
    last.latency = latency;
    if (nowMs - last.pruneAt >= PRUNE_EVERY_MS) {
      last.pruneAt = nowMs;
      await pruneSamples(sql);
    }
  } catch { /* best effort: SLO sampling never fails the sampler */ }
}

/* ----------------------- managed runtime availability ----------------------- */

/** Observations of managed (provider zenith) production workloads: good = all desired replicas ready. */
export const SLI_MANAGED_RUNTIME = "managed_runtime_availability";
/** Observations whose health was `unknown`: kept out of the ratio and counted here (good is always 0). */
export const SLI_MANAGED_RUNTIME_UNKNOWN = "managed_runtime_unknown";
/** Where managed workload health is observed (src/lib/reconcile/core.ts, after the pass commits). */
export const MANAGED_PROVIDER = "zenith";
export const MANAGED_WORKLOAD_NATIVE_TYPE = "k8s:Deployment";

export interface RuntimeObservationInput {
  provider: string;
  nativeType: string;
  health: "healthy" | "degraded" | "unhealthy" | "unknown";
  counts: Readonly<Record<string, number>>;
}

export interface ManagedRuntimeTally { good: number; bad: number; unknown: number; scaledToZero: number }

/**
 * Pure part. Only managed (zenith) Deployments in a production-class environment count. An `unknown` health is
 * never a pass or a failure: it is tallied separately. A workload deliberately scaled to zero (desired 0) is not
 * serving by design and is not sampled either. Good means the platform observed every desired replica ready
 * (health `healthy`, or ready >= desired).
 */
export function managedRuntimeTally(environmentClass: string, observed: readonly RuntimeObservationInput[]): ManagedRuntimeTally {
  const tally: ManagedRuntimeTally = { good: 0, bad: 0, unknown: 0, scaledToZero: 0 };
  if (environmentClass !== "production") return tally;
  for (const o of observed) {
    if (o.provider !== MANAGED_PROVIDER || o.nativeType !== MANAGED_WORKLOAD_NATIVE_TYPE) continue;
    if (o.health === "unknown") { tally.unknown++; continue; }
    const desired = o.counts.desired ?? 0;
    if (!(desired > 0)) { tally.scaledToZero++; continue; }
    if (o.health === "healthy" || (o.counts.ready ?? 0) >= desired) tally.good++;
    else tally.bad++;
  }
  return tally;
}

/**
 * Record one pass of managed runtime observations as SLO samples. Failure never propagates: a metrics write must
 * never fail the observation that produced it. Returns the tally (or null when nothing was recorded).
 */
export async function recordManagedRuntimeHealth(sql: Sql, environmentClass: string, observed: readonly RuntimeObservationInput[]): Promise<ManagedRuntimeTally | null> {
  try {
    const tally = managedRuntimeTally(environmentClass, observed);
    await addSamples(sql, [
      { sli: SLI_MANAGED_RUNTIME, good: tally.good, total: tally.good + tally.bad },
      { sli: SLI_MANAGED_RUNTIME_UNKNOWN, good: 0, total: tally.unknown },
    ]);
    return tally;
  } catch { return null; /* best effort: see above */ }
}

/* ------------------------------- external probe ------------------------------ */

/** Results reported by an external probe calling the control plane from outside. */
export const SLI_EXTERNAL_PROBE = "external_probe_availability";

export interface ExternalProbeReport {
  /** start of the five-minute window, aligned to a five-minute boundary */
  windowStart: Date;
  /** probes that got a healthy answer in the window */
  good: number;
  /** probes sent in the window (at least 1) */
  total: number;
}

/**
 * Record one external probe window. Idempotent: the bucket is REPLACED, so a retried upload leaves the same row.
 * One reporter per deployment: two probers writing the same window overwrite each other, so a second probe location
 * must report summed counts (see docs/platform/operations/SLO.md). Unlike the flush above this throws on invalid
 * input, because the caller (an authenticated hook) needs the refusal.
 */
export async function reportExternalProbe(sql: Sql, input: ExternalProbeReport): Promise<{ sli: string; windowStart: string; good: number; total: number }> {
  await setBucketSample(sql, SLI_EXTERNAL_PROBE, input.windowStart, input.good, input.total);
  return { sli: SLI_EXTERNAL_PROBE, windowStart: input.windowStart.toISOString(), good: input.good, total: input.total };
}
