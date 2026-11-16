import { readFile } from "node:fs/promises";
import { measureRecovery, deliverReport, type RecoveryMeasurement } from "./report";
import type { RestoreReport } from "./restore";

/** Observe the first successful authenticated readiness response; redirects and foreign restore epochs refuse. */
export async function completeRestoreHealth(input: { reportFile: string; readinessUrl: string; tokenFile: string; timeoutSeconds?: number }, deps: { fetch?: typeof fetch; now?: () => Date; pause?: (ms: number) => Promise<void> } = {}): Promise<RestoreReport> {
  const report = JSON.parse(await readFile(input.reportFile, "utf8")) as RestoreReport;
  if (report.ok !== true || !report.measurement || !report.epoch || report.format !== "zenith.recovery-report.v1") throw new Error("A completed, fenced restore report is required.");
  if (report.measurement.applicationHealthyAt) { const delivery = await deliverReport(report as unknown as Record<string, unknown>, input.reportFile); if (delivery.failed.length) throw new Error("Retained health measurement delivery failed."); return report; }
  const target = new URL(input.readinessUrl);
  if (target.username || target.password || target.pathname !== "/api/internal/recovery/readiness" || (target.protocol !== "https:" && !(target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)))) throw new Error("Use HTTPS readiness, or HTTP on loopback, without URL credentials.");
  target.searchParams.set("restoreRunId", report.runId);
  const token = (await readFile(input.tokenFile, "utf8")).trim();
  if (!token || /[\r\n]/.test(token)) throw new Error("A readiness bearer token file is required.");
  const limit = input.timeoutSeconds ?? 900;
  if (!Number.isFinite(limit) || limit <= 0 || limit > 3600) throw new Error("Readiness timeout must be 1 to 3600 seconds.");
  const now = deps.now ?? (() => new Date());
  const end = now().getTime() + limit * 1000;
  const pause = deps.pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  while (now().getTime() < end) {
    let healthy = false;
    try {
      const res = await (deps.fetch ?? fetch)(target, { headers: { authorization: `Bearer ${token}` }, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000) });
      const body = await res.json() as { ready?: boolean; restoreRunId?: string; recoveryEpoch?: number };
      healthy = res.status === 200 && body.ready === true && body.restoreRunId === report.runId && body.recoveryEpoch === report.epoch;
    } catch { /* Network failure is an unhealthy observation, never evidence of recovery. */ }
    if (healthy) {
      const m = report.measurement;
      const measurement: RecoveryMeasurement = measureRecovery({ ...m, incidentAt: m.incidentAt ?? undefined, applicationHealthyAt: now().toISOString() });
      const complete = { ...report, measurement };
      const result = await deliverReport(complete as unknown as Record<string, unknown>, input.reportFile);
      if (result.failed.length) throw new Error("Application health observed but SLO delivery failed; retry the same report to publish its retained timestamp.");
      return complete;
    }
    await pause(1000);
  }
  throw new Error("Application readiness was not healthy before the timeout; no application completion or RTO recorded.");
}
