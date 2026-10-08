/**
 * RPO / RTO measurement for a restore (PROD-OPS-04).
 *
 * Measured, not asserted: every number comes from a timestamp the backup or the restore recorded.
 *
 *  - RPO (data-loss window) = loss time minus the backup's snapshot instant. The loss time is something only the
 *    operator knows (`--incident-at`); without it the report gives the honest UPPER BOUND, the age of the backup
 *    when the restore began, and says so.
 *  - RTO (time to recover) = the moment the restored application first answered healthy readiness
 *    (`applicationHealthyAt`) minus the loss time. Until application readiness is observed RTO stays unmeasured.
 *    `restoreFinishedAt` and restore duration record database completion separately.
 *  - Continuation = how long after the restore the operator took to decide every in-flight item. A restore is
 *    "operationally recovered" only when nothing is pending, and the report shows the pending count rather than
 *    hiding it inside a single RTO number.
 *
 * Targets are PROVISIONAL: PROD-OPS-01 owns approved objectives and is not part of this base. A target given
 * through the environment is compared and labelled provisional; with none, the verdict is `no_targets`. The report
 * is plain JSON. A sink registered through `registerRecoveryMeasurementSink` (the extension point PROD-OPS-01
 * hooks use) receives every report in addition to the file.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { requireText } from "@/lib/controlplane/db/errors";
import type { Sql } from "@/lib/controlplane/types";

export const RECOVERY_REPORT_FORMAT = "zenith.recovery-report.v1";

export interface RecoveryTargets {
  readonly rpoSeconds: number | null;
  readonly rtoSeconds: number | null;
  /** always provisional until OPS-01 records an accountable approval */
  readonly status: "provisional" | "unset";
}

export interface RecoveryMeasurement {
  readonly backupSnapshotAt: string;
  readonly backupFinishedAt: string;
  readonly restoreStartedAt: string;
  readonly restoreFinishedAt: string;
  readonly incidentAt: string | null;
  readonly applicationHealthyAt: string | null;
  /** exact data-loss window; null unless the loss time was supplied */
  readonly rpoSeconds: number | null;
  /** age of the backup when the restore began: an upper bound on the loss window when the loss time is unknown */
  readonly backupAgeAtRestoreStartSeconds: number;
  readonly restoreDurationSeconds: number;
  /** loss to observed application readiness; null unless both instants are known */
  readonly rtoSeconds: number | null;
  readonly targets: RecoveryTargets;
  readonly verdict: "within_targets" | "exceeds_targets" | "no_targets" | "awaiting_application_health" | "incomplete_measurement";
  readonly caveats: readonly string[];
}

const secondsBetween = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / 100) / 10;

export function targetsFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): RecoveryTargets {
  const read = (name: string): number | null => {
    const raw = env[name]?.trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const rpoSeconds = read("ZENITH_RPO_TARGET_SECONDS");
  const rtoSeconds = read("ZENITH_RTO_TARGET_SECONDS");
  return { rpoSeconds, rtoSeconds, status: rpoSeconds === null && rtoSeconds === null ? "unset" : "provisional" };
}

export function measureRecovery(input: {
  backupSnapshotAt: string;
  backupFinishedAt: string;
  restoreStartedAt: string;
  restoreFinishedAt: string;
  applicationHealthyAt?: string;
  incidentAt?: string;
  targets?: RecoveryTargets;
}): RecoveryMeasurement {
  const targets = input.targets ?? { rpoSeconds: null, rtoSeconds: null, status: "unset" };
  const caveats: string[] = [];
  const incidentAt = input.incidentAt ? new Date(input.incidentAt).toISOString() : null;
  const rpo = incidentAt ? secondsBetween(input.backupSnapshotAt, incidentAt) : null;
  const applicationHealthyAt = input.applicationHealthyAt ? new Date(input.applicationHealthyAt).toISOString() : null;
  if (applicationHealthyAt && Date.parse(applicationHealthyAt) < Date.parse(input.restoreFinishedAt)) throw new Error("Application health cannot precede database restore completion.");
  const rto = incidentAt && applicationHealthyAt ? secondsBetween(incidentAt, applicationHealthyAt) : null;
  if (!applicationHealthyAt) caveats.push("Application readiness has not been observed. Database restore duration is recorded separately; RTO is not measured.");
  if (rpo !== null && rpo < 0) caveats.push("The loss time is before the backup snapshot; the RPO is reported as 0.");
  if (!incidentAt) caveats.push("No loss time was supplied: the RPO shown is the backup age at restore start, an upper bound; RTO needs both the loss time and observed application health.");
  caveats.push("Work performed after the snapshot left no record in the restored database; reconcile providers for that window (see RECOVERY.md).");
  const breaches: boolean[] = [];
  const rpoValue = rpo !== null ? Math.max(0, rpo) : secondsBetween(input.backupSnapshotAt, input.restoreStartedAt);
  if (targets.rpoSeconds !== null) breaches.push(rpoValue > targets.rpoSeconds);
  if (targets.rtoSeconds !== null && rto !== null) breaches.push(rto > targets.rtoSeconds);
  return {
    backupSnapshotAt: input.backupSnapshotAt,
    backupFinishedAt: input.backupFinishedAt,
    restoreStartedAt: input.restoreStartedAt,
    restoreFinishedAt: input.restoreFinishedAt,
    incidentAt,
    applicationHealthyAt,
    rpoSeconds: rpo === null ? null : Math.max(0, rpo),
    backupAgeAtRestoreStartSeconds: secondsBetween(input.backupSnapshotAt, input.restoreStartedAt),
    restoreDurationSeconds: secondsBetween(input.restoreStartedAt, input.restoreFinishedAt),
    rtoSeconds: rto,
    targets,
    verdict: breaches.some(Boolean) ? "exceeds_targets" : targets.rtoSeconds !== null && !applicationHealthyAt ? "awaiting_application_health" : targets.rtoSeconds !== null && rto === null ? "incomplete_measurement" : breaches.length === 0 ? "no_targets" : "within_targets",
    caveats,
  };
}

export interface ContinuationMeasurement {
  readonly epoch: number;
  readonly opened: number;
  readonly decided: number;
  readonly pending: number;
  readonly lastDecidedAt: string | null;
  /** epoch creation to the last decision; null while anything is pending */
  readonly durationSeconds: number | null;
}

/** How far the operator has got through the work a restore opened. Reads only; workspace-agnostic by design (an operator view). */
export async function measureContinuation(sql: Sql, epoch: number): Promise<ContinuationMeasurement> {
  const row = (await sql.query<{ opened: number | string; decided: number | string; last: unknown; created: unknown }>(
    `select (select count(*)::int from platform.recovery_items where epoch = $1::bigint) as opened,
            (select count(*)::int from platform.recovery_items where epoch = $1::bigint and state <> 'pending') as decided,
            (select max(decided_at) from platform.recovery_items where epoch = $1::bigint) as last,
            (select created_at from platform.recovery_epochs where epoch = $1::bigint) as created`, [epoch]))[0];
  const opened = Number(row?.opened ?? 0), decided = Number(row?.decided ?? 0);
  const last = row?.last ? new Date(row.last as string).toISOString() : null;
  const created = row?.created ? new Date(row.created as string).toISOString() : null;
  return { epoch, opened, decided, pending: opened - decided, lastDecidedAt: last, durationSeconds: opened > 0 && opened === decided && last && created ? secondsBetween(created, last) : opened === 0 ? 0 : null };
}

/* ---------------------------------- sinks ---------------------------------- */

export interface MeasurementSink {
  readonly name: string;
  record(report: Readonly<Record<string, unknown>>): Promise<void>;
}

const sinks = new Map<string, MeasurementSink>();
/** The extension point for PROD-OPS-01: a registered sink receives every restore report. */
export function registerRecoveryMeasurementSink(sink: MeasurementSink): () => void {
  sinks.set(requireText("sink name", sink.name, 80), sink);
  return () => { sinks.delete(sink.name); };
}

export function fileSink(file: string): MeasurementSink {
  return {
    name: `file:${path.basename(file)}`,
    async record(report) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    },
  };
}

/** Deliver a report to the file sink and every registered sink. A failing sink never hides the report: failures are returned. */
export async function deliverReport(report: Readonly<Record<string, unknown>>, file: string): Promise<{ delivered: string[]; failed: string[] }> {
  const delivered: string[] = [];
  const failed: string[] = [];
  for (const sink of [fileSink(file), ...sinks.values()]) {
    try { await sink.record(report); delivered.push(sink.name); } catch { failed.push(sink.name); }
  }
  return { delivered, failed };
}
