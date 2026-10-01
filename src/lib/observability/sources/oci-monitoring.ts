/**
 * OCI summarizeMetricsData reads through a capability-scoped runner session.
 * Portable names map to fixed compute-agent metrics; MQL contains only verified
 * OCIDs and a supported interval. No caller query syntax or compartment-wide
 * streams. Missing mappings, malformed data and partial budgets stay explicit.
 * Synthetic contract evidence only; no live OCI tenancy was exercised.
 * API: https://docs.oracle.com/en-us/iaas/tools/go/latest/monitoring/
 */
import { randomUUID } from "node:crypto";
import { emptyResult, isRecord, unavailableResult } from "../normalize";
import { validateMetricQuery, MAX_POINTS_PER_SERIES, SERIES_PER_QUERY_MAX } from "../query";
import type { MetricSeries, ObservabilitySource, QueryResult } from "../types";
import { boundResources, OCI_READ_BUDGET, readSignal, signalRequest, validTimestamp, type OciSignalSession } from "./oci-common";

export const OCI_MONITORING_SOURCE_ID = "oci.monitoring";
const COMPUTE_METRICS: Readonly<Record<string, string>> = {
  "cpu.utilization": "CpuUtilization",
  "memory.utilization": "MemoryUtilization",
};

/** Native resolution lookback is measured from now: 1m=7d, 5m=30d, 1h=90d. */
function metricInterval(stepSec: number, ageSec: number): { interval: string; seconds: number } {
  if (stepSec <= 60 && ageSec <= 7 * 86400) return { interval: "1m", seconds: 60 };
  if (stepSec <= 300 && ageSec <= 30 * 86400) return { interval: "5m", seconds: 300 };
  if (stepSec <= 3600) return { interval: "1h", seconds: 3600 };
  return { interval: "1d", seconds: 86400 };
}

export function createOciMonitoringSource(session?: OciSignalSession): ObservabilitySource {
  return { id: OCI_MONITORING_SOURCE_ID, provider: "oci", supports: ["metric"],
    async queryMetrics(input, signal): Promise<QueryResult<MetricSeries>> {
      const q = validateMetricQuery(input, Date.now());
      signal.throwIfAborted();
      const unavailable = (reason: string) => unavailableResult<MetricSeries>(OCI_MONITORING_SOURCE_ID, reason);
      if (!session) return unavailable("no OCI runner session: metrics require a credential-broker observe session");
      const request = signalRequest(session, "monitoring", "/20180401/metrics/actions/summarizeMetricsData");
      if (!request) return unavailable("OCI Monitoring service or capability allowlist is unavailable.");
      const resources = boundResources(session, q.scope);
      if (!resources) return unavailable("OCI environment resource bindings are unavailable for this scope.");
      const instances = resources.filter((r) => r.nativeType === "oci:compute_instance");
      if (!instances.length) return unavailable("No supported OCI compute resources are bound to this metric scope.");
      const result = emptyResult<MetricSeries>();
      const ageSec = (Date.now() - Date.parse(q.range.from)) / 1000;
      if (ageSec > 90 * 86400) return unavailable("The selected time range is outside OCI Monitoring's ninety-day metric retention.");
      const interval = metricInterval(q.stepSec, ageSec);
      if (interval.seconds !== q.stepSec) result.notes = [`OCI metrics use the supported ${interval.interval} interval for this time range.`];
      let calls = 0;
      let omitted = false;
      for (const metric of q.metrics) {
        const nativeName = COMPUTE_METRICS[metric];
        if (!nativeName) { result.unavailable.push({ source: OCI_MONITORING_SOURCE_ID, reason: `No OCI Monitoring mapping for portable metric ${metric}.` }); continue; }
        for (const instance of instances) {
          if (calls >= OCI_READ_BUDGET || result.items.length >= SERIES_PER_QUERY_MAX) { result.truncated = true; break; }
          calls++;
          try {
            const response = await readSignal(session, { ...request, query: { compartmentId: session.compartmentOcid, compartmentIdInSubtree: false }, headers: { "opc-retry-token": randomUUID() },
              body: { namespace: "oci_computeagent", query: `${nativeName}[${interval.interval}]{resourceId = "${instance.externalId}"}.mean()`, startTime: q.range.from, endTime: q.range.to, resolution: interval.interval } }, signal);
            if (!Array.isArray(response.body) || response.body.length > SERIES_PER_QUERY_MAX) throw new Error("OCI Monitoring returned a malformed response.");
            if (!result.sources.length) result.sources.push(OCI_MONITORING_SOURCE_ID);
            for (const raw of response.body) {
              if (!isRecord(raw) || raw.namespace !== "oci_computeagent" || raw.name !== nativeName || !isRecord(raw.dimensions) || raw.dimensions.resourceId !== instance.externalId || (raw.compartmentId !== undefined && raw.compartmentId !== session.compartmentOcid) || !Array.isArray(raw.aggregatedDatapoints)) { omitted = true; continue; }
              if (result.items.length >= SERIES_PER_QUERY_MAX) { result.truncated = true; break; }
              const points: MetricSeries["points"] = [];
              const seen = new Map<string, number>();
              for (const point of raw.aggregatedDatapoints.slice(0, MAX_POINTS_PER_SERIES + 1)) {
                if (!isRecord(point)) { omitted = true; continue; }
                const timestamp = validTimestamp(point.timestamp);
                if (!timestamp || typeof point.value !== "number" || !Number.isFinite(point.value)) { omitted = true; continue; }
                if (timestamp < q.range.from || timestamp > q.range.to) continue;
                if (seen.has(timestamp)) {
                  if (seen.get(timestamp) !== point.value) { omitted = true; throw new Error("OCI Monitoring returned conflicting datapoints."); }
                  continue;
                }
                if (points.length >= MAX_POINTS_PER_SERIES) { result.truncated = true; break; }
                seen.set(timestamp, point.value);
                points.push({ timestamp, value: point.value });
              }
              if (raw.aggregatedDatapoints.length > MAX_POINTS_PER_SERIES) result.truncated = true;
              points.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
              // Metadata and dimensions are allowlisted rather than echoing arbitrary remote bags.
              result.items.push({ metric, unit: "Percent", address: instance.address, provider: "oci", native: { namespace: "oci_computeagent", name: nativeName, resourceId: instance.externalId, interval: interval.interval }, points });
            }
          } catch {
            signal.throwIfAborted();
            result.unavailable.push({ source: OCI_MONITORING_SOURCE_ID, reason: "OCI Monitoring runner read failed or returned unusable metric data." });
          }
        }
      }
      if (omitted) { result.truncated = true; (result.notes ??= []).push("OCI Monitoring returned unusable datapoints or mismatched series; omitted data has unknown coverage."); }
      if (result.truncated) (result.notes ??= []).push("OCI metric coverage is bounded by ten runner reads, fifty series and 1440 points per series.");
      return result;
    },
  };
}
