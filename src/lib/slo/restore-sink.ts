import type { MeasurementSink } from "@/lib/ops/recovery/report";
import type { RecoveryRehearsalReport } from "./recovery";

/** Only a completed, fenced drill with a supplied incident time is a measurement. */
export function restoreSloSink(record: (input: RecoveryRehearsalReport) => Promise<unknown>, recordedBy: string): MeasurementSink {
  return {
    name: "slo:recovery",
    async record(report) {
      if (report.ok !== true) return;
      const m = report.measurement as { incidentAt?: string | null; backupSnapshotAt?: string; restoreFinishedAt?: string } | null;
      if (!m?.incidentAt || !m.backupSnapshotAt || !m.restoreFinishedAt) return;
      await record({ source: "recovery-drill", failureAt: new Date(m.incidentAt), dataRecoveredThrough: new Date(m.backupSnapshotAt), serviceRestoredAt: new Date(m.restoreFinishedAt), recordedBy, reference: String(report.runId) });
    },
  };
}
