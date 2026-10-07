/**
 * Drift and migration signals for the mixed run's ordering rules (PROD-MIX-04 follow-up).
 *
 * Two platform facts become `OrderingSignals`:
 *  - DRIFT (OBS-01 / reconcile): the newest drift report of a child's environment that was computed after the child operation
 *    was created. A finding is unresolved drift unless ownership already removed it (the stored report has expected variance
 *    dropped by `applyFieldOwnership`). A changed finding the report marks not repairable is a native divergence (a native
 *    operation owns the field); every other finding, and an address the pass could not read at all, is `unauthorized_change`
 *    or `unobserved`. A simulated report is not evidence of the real environment and contributes nothing.
 *  - MIGRATIONS (LIFE-10): release runs of the child operation whose migration class is `data`, `contract` or `unclassified`.
 *    `contract` and `unclassified` are also reported as contract migrations, which the ordering rules place after the
 *    children that depend on the migrating child.
 *
 * Reading never changes state and never reaches a cloud. A child without a bound operation or environment contributes nothing.
 */
import * as plans from "@/lib/controlplane/db/repos/mixed-parent-plans";
import * as signalStore from "@/lib/controlplane/db/repos/mixed-signals";
import type { ChildDriftReport } from "@/lib/controlplane/db/repos/mixed-signals";
import type { Sql } from "@/lib/controlplane/types";
import type { DriftClass, OrderingSignals } from "../mixed-orchestration/ordering-rules";

export interface SignalChild {
  partitionId: string;
  childEnvironmentId: string;
  /** The adopted child operation; bounds which drift report and which release runs belong to this child. */
  childOperationId?: string;
}

export interface ObservedSignals {
  drift: readonly { childId: string; klass: DriftClass }[];
  migrationChildIds: readonly string[];
  contractMigrationChildIds: readonly string[];
}

/** The unresolved drift classes one report contributes, deduplicated and sorted. */
export function driftClassesOf(report: ChildDriftReport | null): DriftClass[] {
  if (!report || report.simulated) return [];
  const classes = new Set<DriftClass>();
  for (const finding of report.findings) {
    if (finding.class === "changed" && finding.repairable === false) classes.add("native_divergence");
    else classes.add("unauthorized_change");
  }
  if (report.unobserved.length > 0) classes.add("unobserved");
  return [...classes].sort();
}

export async function readOrderingSignals(sql: Sql, workspaceId: string, children: readonly SignalChild[]): Promise<ObservedSignals> {
  const drift: { childId: string; klass: DriftClass }[] = [];
  const migrations = new Set<string>();
  const contract = new Set<string>();
  for (const child of children) {
    const scope = { workspaceId, environmentId: child.childEnvironmentId, ...(child.childOperationId ? { operationId: child.childOperationId } : {}) };
    for (const klass of driftClassesOf(await signalStore.latestChildDriftReport(sql, scope))) drift.push({ childId: child.partitionId, klass });
    for (const migration of await signalStore.childMigrationClasses(sql, scope)) {
      migrations.add(child.partitionId);
      if (migration.class !== "data") contract.add(child.partitionId);
    }
  }
  return { drift, migrationChildIds: [...migrations].sort(), contractMigrationChildIds: [...contract].sort() };
}

/** The same signals for a stored run's children, resolved from its mixed plan (used by the teardown route). */
export async function readRunSignals(sql: Sql, workspaceId: string, planId: string, plan: { children: readonly { partitionId: string; childEnvironmentId: string }[] }): Promise<ObservedSignals> {
  const rows = await plans.listChildren(sql, workspaceId, planId);
  const operationOf = new Map(rows.map((row) => [row.partitionId, row.childOperationId]));
  return readOrderingSignals(sql, workspaceId, plan.children.map((child) => ({ partitionId: child.partitionId, childEnvironmentId: child.childEnvironmentId, ...(operationOf.get(child.partitionId) ? { childOperationId: operationOf.get(child.partitionId)! } : {}) })));
}

export const asOrderingSignals = (observed: ObservedSignals): OrderingSignals => ({
  drift: [...observed.drift], migrationChildIds: [...observed.migrationChildIds], contractMigrationChildIds: [...observed.contractMigrationChildIds],
});

/** The production `MixedWorld.orderingSignals`. */
export function platformOrderingSignals(sql: Sql) {
  return async (workspaceId: string, children: readonly SignalChild[]): Promise<ObservedSignals> => readOrderingSignals(sql, workspaceId, children);
}
