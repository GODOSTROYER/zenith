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
import { addSamples, pruneSamples, type SampleInput } from "./store";

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
