import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeRestoreHealth } from "@/lib/ops/recovery/health";
import { measureRecovery, registerRecoveryMeasurementSink } from "@/lib/ops/recovery/report";
let dir: string, reportFile: string, tokenFile: string;
const readinessUrl = "http://127.0.0.1:3400/api/internal/recovery/readiness";
const measurement = measureRecovery({ backupSnapshotAt: "2026-10-01T00:00:00Z", backupFinishedAt: "2026-10-01T00:00:10Z", incidentAt: "2026-10-01T00:01:00Z", restoreStartedAt: "2026-10-01T00:02:00Z", restoreFinishedAt: "2026-10-01T00:05:00Z" });
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "zenith-health-")); reportFile = path.join(dir, "report.json"); tokenFile = path.join(dir, "bearer"); await writeFile(tokenFile, randomBytes(24).toString("hex")); await writeFile(reportFile, JSON.stringify({ format: "zenith.recovery-report.v1", ok: true, runId: "restore_health_1", epoch: 1, measurement })); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
describe("restore first application readiness observer [contract]", () => {
  it("retains the first healthy timestamp after unhealthy and foreign-epoch responses, independently of DB completion", async () => {
    let time = Date.parse("2026-10-01T00:06:00Z");
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ ready: false }, { status: 503 })).mockResolvedValueOnce(Response.json({ ready: true, restoreRunId: "restore_health_1", recoveryEpoch: 2 })).mockResolvedValue(Response.json({ ready: true, restoreRunId: "restore_health_1", recoveryEpoch: 1 }));
    const report = await completeRestoreHealth({ reportFile, tokenFile, readinessUrl }, { fetch: fetcher, now: () => new Date(time), pause: async ms => { time += ms; } });
    expect(report.measurement).toMatchObject({ restoreDurationSeconds: 180, applicationHealthyAt: "2026-10-01T00:06:02.000Z", rtoSeconds: 302 });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "error", cache: "no-store" });
    const retained = await completeRestoreHealth({ reportFile, tokenFile, readinessUrl }, { fetch: fetcher });
    expect(retained.measurement?.applicationHealthyAt).toBe(report.measurement?.applicationHealthyAt); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("timeout produces no application sample or RTO and preserves the DB report", async () => {
    let time = Date.parse("2026-10-01T00:06:00Z");
    await expect(completeRestoreHealth({ reportFile, tokenFile, readinessUrl, timeoutSeconds: 2 }, { fetch: vi.fn().mockRejectedValue(new Error("down")), now: () => new Date(time), pause: async ms => { time += ms; } })).rejects.toThrow(/timeout/);
    expect(JSON.parse(await readFile(reportFile, "utf8")).measurement).toMatchObject({ applicationHealthyAt: null, rtoSeconds: null });
  });
  it("publication failure is explicit and retries the retained observation", async () => {
    const off = registerRecoveryMeasurementSink({ name: "failure", record: async () => { throw new Error("down"); } });
    try {
      await expect(completeRestoreHealth({ reportFile, tokenFile, readinessUrl }, { fetch: vi.fn().mockResolvedValue(Response.json({ ready: true, restoreRunId: "restore_health_1", recoveryEpoch: 1 })), now: () => new Date("2026-10-01T00:06:00Z") })).rejects.toThrow(/delivery failed/);
      await expect(completeRestoreHealth({ reportFile, tokenFile, readinessUrl })).rejects.toThrow(/delivery failed/);
      expect(JSON.parse(await readFile(reportFile, "utf8")).measurement.applicationHealthyAt).toBe("2026-10-01T00:06:00.000Z");
    } finally { off(); }
  });
  it("refuses credentials embedded in URLs and public plaintext HTTP", async () => {
    for (const url of ["http://example.test/api/internal/recovery/readiness", "https://u:p@example.test/api/internal/recovery/readiness"]) await expect(completeRestoreHealth({ reportFile, tokenFile, readinessUrl: url })).rejects.toThrow(/HTTPS/);
  });
});
