import { describe, expect, it, vi } from "vitest";
import { restoreSloSink } from "@/lib/slo/restore-sink";

describe("restore drill SLO join", () => {
  const measurement = { incidentAt: "2026-10-08T01:00:00Z", backupSnapshotAt: "2026-10-08T00:55:00Z", restoreStartedAt: "2026-10-08T01:05:00Z", restoreFinishedAt: "2026-10-08T01:20:00Z", applicationHealthyAt: "2026-10-08T01:25:00Z" };
  it("reports observed instants through the shared recovery recorder", async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    await restoreSloSink(record, "operator").record({ ok: true, runId: "restore_123", measurement });
    expect(record).toHaveBeenCalledExactlyOnceWith({ failureAt: new Date(measurement.incidentAt), dataRecoveredThrough: new Date(measurement.backupSnapshotAt), restoreStartedAt: new Date(measurement.restoreStartedAt), databaseRestoreFinishedAt: new Date(measurement.restoreFinishedAt), applicationHealthyAt: new Date(measurement.applicationHealthyAt), recordedBy: "operator", reference: "restore_123" });
  });
  it.each([{ ok: false, measurement }, { ok: true, measurement: null }, { ok: true, measurement: { ...measurement, restoreStartedAt: undefined } }])("does not publish a failed or unmeasured restore %#", async report => {
    const record = vi.fn();
    await restoreSloSink(record, "operator").record(report);
    expect(record).not.toHaveBeenCalled();
  });
  it("propagates publication failure to the report delivery machinery", async () => {
    await expect(restoreSloSink(async () => { throw new Error("store unavailable"); }, "operator").record({ ok: true, measurement })).rejects.toThrow("store unavailable");
  });
});
