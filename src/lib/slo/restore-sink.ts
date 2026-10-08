import type { MeasurementSink } from "@/lib/ops/recovery/report";
import type { RestoreCompletionReport } from "./recovery";

/** A database milestone is distinct from healthy application completion. */
export function restoreSloSink(record: (input: RestoreCompletionReport) => Promise<unknown>, recordedBy: string): MeasurementSink {
  return {
    name: "slo:recovery",
    async record(report) {
      if (report.ok !== true) return;
      const m = report.measurement as { incidentAt?: string | null; backupSnapshotAt?: string; restoreStartedAt?: string; restoreFinishedAt?: string; applicationHealthyAt?: string | null } | null;
      if (!m?.backupSnapshotAt || !m.restoreStartedAt || !m.restoreFinishedAt) return;
      await record({ ...(m.incidentAt ? { failureAt: new Date(m.incidentAt) } : {}), dataRecoveredThrough: new Date(m.backupSnapshotAt), restoreStartedAt: new Date(m.restoreStartedAt),
        databaseRestoreFinishedAt: new Date(m.restoreFinishedAt), ...(m.applicationHealthyAt ? { applicationHealthyAt: new Date(m.applicationHealthyAt) } : {}), recordedBy, reference: String(report.runId) });
    },
  };
}
