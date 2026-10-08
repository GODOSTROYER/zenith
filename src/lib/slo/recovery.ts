/**
 * RPO / RTO and capacity measurement hooks (PROD-OPS-01).
 *
 * `reportRecoveryRehearsal` is what a restore rehearsal (PROD-OPS-04) calls when it finishes: it gives the three
 * instants the rehearsal observed and this module derives the two numbers, so the arithmetic lives in one tested
 * place and a rehearsal cannot report a flattering figure it did not measure:
 *
 *   RPO = failureAt - dataRecoveredThrough   (how much recent data the restore did NOT bring back)
 *   RTO = serviceRestoredAt - failureAt      (how long the service was unavailable)
 *
 * Reachable from outside the process through `POST /api/internal/slo/measurements` (bearer-gated, like every
 * tick route) and `scripts/slo/capacity-test.mjs --report`. Results are append-only; the comparison to the
 * provisional target is recorded WITH the target definition version it was made against.
 */
import type { Sql } from "@/lib/controlplane/types";
import { ControlStoreError } from "@/lib/controlplane/db/errors";
import { sloDefinitions, type CapacityObjective, type RecoveryObjective } from "./definitions";
import { recordMeasurement, type Measurement } from "./store";

export interface RecoveryRehearsalReport {
  source: "restore-rehearsal" | "recovery-drill";
  /** when the simulated failure happened (the instant service stopped and writes stopped being durable) */
  failureAt: Date;
  /** the newest committed write the restored data contains */
  dataRecoveredThrough: Date;
  /** when the restored service first answered a successful health check */
  serviceRestoredAt: Date;
  recordedBy: string;
  /** short token that points at the rehearsal's own evidence (run id, report path); never a secret */
  reference?: string;
}

const REFERENCE = /^[A-Za-z0-9._:/#-]{1,120}$/;
const bad = (message: string, field: string): never => { throw new ControlStoreError("invalid_input", message, { field }); };

export function computeRecovery(input: Pick<RecoveryRehearsalReport, "failureAt" | "dataRecoveredThrough" | "serviceRestoredAt">): { rpoSeconds: number; rtoSeconds: number } {
  const f = input.failureAt.getTime();
  const d = input.dataRecoveredThrough.getTime();
  const r = input.serviceRestoredAt.getTime();
  if ([f, d, r].some(Number.isNaN)) return bad("failureAt, dataRecoveredThrough and serviceRestoredAt must be valid times.", "failureAt");
  if (d > f) return bad("dataRecoveredThrough cannot be after failureAt: a restore cannot recover data that did not exist yet.", "dataRecoveredThrough");
  if (r < f) return bad("serviceRestoredAt cannot be before failureAt.", "serviceRestoredAt");
  return { rpoSeconds: (f - d) / 1000, rtoSeconds: (r - f) / 1000 };
}

const objective = <T extends RecoveryObjective | CapacityObjective>(id: string): T => {
  const found = sloDefinitions().objectives.find((o) => o.id === id);
  if (!found) throw new Error(`SLO definition ${id} is missing.`);
  return found as T;
};

export async function reportRecoveryRehearsal(sql: Sql, input: RecoveryRehearsalReport): Promise<{ rpo: Measurement; rto: Measurement }> {
  const { rpoSeconds, rtoSeconds } = computeRecovery(input);
  if (input.reference !== undefined && !REFERENCE.test(input.reference)) bad("reference must be a short token (letters, digits and . _ : / # -).", "reference");
  const defs = sloDefinitions();
  const details = {
    failureAt: input.failureAt.toISOString(),
    dataRecoveredThrough: input.dataRecoveredThrough.toISOString(),
    serviceRestoredAt: input.serviceRestoredAt.toISOString(),
    ...(input.reference ? { reference: input.reference } : {}),
  };
  const common = { source: input.source, recordedBy: input.recordedBy, targetVersion: defs.definitionVersion, details, measuredAt: input.serviceRestoredAt };
  return sql.tx(async (tx) => ({
    rpo: await recordMeasurement(tx, { ...common, kind: "rpo", value: rpoSeconds, withinTarget: rpoSeconds <= objective<RecoveryObjective>("rpo").maxSeconds }),
    rto: await recordMeasurement(tx, { ...common, kind: "rto", value: rtoSeconds, withinTarget: rtoSeconds <= objective<RecoveryObjective>("rto").maxSeconds }),
  }));
}

export interface CapacityTestReport {
  /** requests per second actually sustained over the steady phase */
  sustainedRps: number;
  p95Ms: number;
  errorRate: number;
  durationSeconds: number;
  concurrency: number;
  /** short label for the machine and target, e.g. "local-dev next start"; not a hostname with credentials */
  environment: string;
  measuredAt: Date;
  recordedBy: string;
}

export const capacityMeetsTarget = (t: Pick<CapacityTestReport, "sustainedRps" | "p95Ms" | "errorRate">, o: CapacityObjective): boolean =>
  t.sustainedRps >= o.minRequestsPerSecond && t.p95Ms <= o.maxP95Ms && t.errorRate <= o.maxErrorRate;

export async function reportCapacityTest(sql: Sql, input: CapacityTestReport): Promise<Measurement> {
  if (!(input.sustainedRps >= 0) || !(input.p95Ms >= 0) || !(input.errorRate >= 0 && input.errorRate <= 1) || !(input.durationSeconds > 0) || !(input.concurrency >= 1)) bad("Capacity figures are out of range.", "sustainedRps");
  if (!/^[A-Za-z0-9 ._:/#()-]{1,80}$/.test(input.environment)) bad("environment must be a short plain label.", "environment");
  const defs = sloDefinitions();
  return recordMeasurement(sql, {
    kind: "capacity",
    source: "capacity-test",
    value: input.sustainedRps,
    withinTarget: capacityMeetsTarget(input, objective<CapacityObjective>("capacity")),
    targetVersion: defs.definitionVersion,
    recordedBy: input.recordedBy,
    details: { p95Ms: input.p95Ms, errorRate: input.errorRate, durationSeconds: input.durationSeconds, concurrency: input.concurrency, environment: input.environment },
    measuredAt: input.measuredAt,
  });
}

/** Actual restore milestones. RTO is only emitted after application readiness, never at database completion. */
export interface RestoreCompletionReport {
  failureAt?: Date;
  dataRecoveredThrough: Date;
  restoreStartedAt: Date;
  databaseRestoreFinishedAt: Date;
  applicationHealthyAt?: Date;
  recordedBy: string;
  reference: string;
}

export async function reportRestoreCompletion(sql: Sql, input: RestoreCompletionReport): Promise<Measurement[]> {
  if (!REFERENCE.test(input.reference)) bad("reference must identify the restore run.", "reference");
  const start = input.restoreStartedAt.getTime(), db = input.databaseRestoreFinishedAt.getTime(), health = input.applicationHealthyAt?.getTime();
  if (![start, db, ...(health === undefined ? [] : [health])].every(Number.isFinite) || db < start || (health !== undefined && health < db))
    bad("Restore milestones must be valid times in restore/database/health order.", "databaseRestoreFinishedAt");
  const defs = sloDefinitions();
  const details = { reference: input.reference, restoreStartedAt: input.restoreStartedAt.toISOString(), databaseRestoreFinishedAt: input.databaseRestoreFinishedAt.toISOString(),
    dataRecoveredThrough: input.dataRecoveredThrough.toISOString(), ...(input.failureAt ? { failureAt: input.failureAt.toISOString() } : {}),
    ...(input.applicationHealthyAt ? { applicationHealthyAt: input.applicationHealthyAt.toISOString() } : {}) };
  return sql.tx(async tx => {
    // Serializes duplicate CLI observers for one run; evidence remains append-only.
    await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`restore-slo:${input.reference}`]);
    const recorded: Measurement[] = [];
    const once = async (kind: import("./store").MeasurementKind, value: number, measuredAt: Date, withinTarget?: boolean) => {
      const existing = await tx.query("select id from platform.slo_measurements where kind = $1 and source = 'recovery-drill' and details->>'reference' = $2 limit 1", [kind, input.reference]);
      if (!existing.length) recorded.push(await recordMeasurement(tx, { kind, value, measuredAt, withinTarget, source: "recovery-drill", recordedBy: input.recordedBy, targetVersion: defs.definitionVersion, details }));
    };
    await once("database_restore", (db - start) / 1000, input.databaseRestoreFinishedAt);
    if (input.applicationHealthyAt) {
      await once("application_health", (health! - start) / 1000, input.applicationHealthyAt);
      if (input.failureAt) {
        const values = computeRecovery({ failureAt: input.failureAt, dataRecoveredThrough: input.dataRecoveredThrough, serviceRestoredAt: input.applicationHealthyAt });
        await once("rpo", values.rpoSeconds, input.applicationHealthyAt, values.rpoSeconds <= objective<RecoveryObjective>("rpo").maxSeconds);
        await once("rto", values.rtoSeconds, input.applicationHealthyAt, values.rtoSeconds <= objective<RecoveryObjective>("rto").maxSeconds);
      }
    }
    return recorded;
  });
}
