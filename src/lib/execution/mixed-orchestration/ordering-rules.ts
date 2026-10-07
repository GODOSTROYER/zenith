/**
 * Ordering rules for drift repair, migrations, child starts and teardown across a mixed run
 * (PROD-MIX-04: "drift/migration/teardown order fail safely").
 *
 * Pure: given the run state (which records each child's dependencies, status, effects) and the
 * observed signals, `evaluateOrdering` answers whether an operation may proceed now, or lists the
 * rule and the child that blocks it. A block is a refusal, never a delay the caller may override.
 *
 *   start_child X     producers with unresolved drift (unauthorized change or native divergence)
 *                     block it: their outputs may no longer describe reality. A migration among X's
 *                     upstream must have succeeded. Only one migration child at a time.
 *   migration M       all producers succeeded; no other migration in flight; no dependent running.
 *   drift_repair X    nothing in X's neighbourhood (X, producers, dependents) may be in flight or
 *                     need reconciliation; producers with drift are repaired first; no migration
 *                     in that neighbourhood may be unsettled.
 *   teardown X        X and its dependents are settled and reconciled; dependents that were applied
 *                     are already destroyed (consumers first); no migration is in flight anywhere.
 */
import type { MixedRunState } from "./run";
import { downstreamOf, upstreamOf } from "./order";
import { cmp } from "./errors";

export type DriftClass = "unauthorized_change" | "native_divergence" | "expected_variance";

export interface OrderingSignals {
  /** Drift findings that are not yet repaired or accepted. */
  readonly drift: readonly { childId: string; klass: DriftClass }[];
  /** Children whose step is a schema/data migration (LIFE-10 classification supplied by the caller). */
  readonly migrationChildIds: readonly string[];
}

export type OrderingOperation = { kind: "start_child" | "drift_repair" | "migration" | "teardown"; childId: string };
export interface OrderingBlock { rule: string; childId: string; blockedBy: string }
export interface OrderingVerdict { allowed: boolean; blocks: readonly OrderingBlock[] }

const INFLIGHT = new Set(["running", "cancel_requested"]);

export function evaluateOrdering(state: MixedRunState, op: OrderingOperation, signals: OrderingSignals): OrderingVerdict {
  const graph = Object.values(state.children).map((child) => ({ id: child.id, dependsOn: child.dependsOn }));
  const self = state.children[op.childId];
  const blocks: OrderingBlock[] = [];
  const block = (rule: string, blockedBy: string): void => { blocks.push({ rule, childId: op.childId, blockedBy }); };
  if (!self) return { allowed: false, blocks: [{ rule: "unknown_child", childId: op.childId, blockedBy: op.childId }] };
  const up = upstreamOf(graph, op.childId);
  const down = downstreamOf(graph, op.childId);
  const neighbourhood = new Set([op.childId, ...up, ...down]);
  const migrations = new Set(signals.migrationChildIds);
  const unresolvedDrift = (id: string): boolean => signals.drift.some((finding) => finding.childId === id && finding.klass !== "expected_variance");
  const inflight = (id: string): boolean => INFLIGHT.has(state.children[id]?.status ?? "");
  const unsettled = (id: string): boolean => inflight(id) || state.children[id]?.reconciliationRequired === true;

  switch (op.kind) {
    case "start_child": {
      for (const id of [...up].sort(cmp)) {
        if (unresolvedDrift(id)) block("producer_drift_unresolved", id);
        if (migrations.has(id) && state.children[id]?.status !== "succeeded") block("migration_incomplete", id);
      }
      if (migrations.has(op.childId)) for (const id of [...migrations].sort(cmp)) if (id !== op.childId && inflight(id)) block("one_migration_at_a_time", id);
      break;
    }
    case "migration": {
      for (const id of [...up].sort(cmp)) if (state.children[id]?.status !== "succeeded") block("producers_incomplete", id);
      for (const id of [...migrations].sort(cmp)) if (id !== op.childId && inflight(id)) block("one_migration_at_a_time", id);
      for (const id of [...down].sort(cmp)) if (inflight(id)) block("dependents_in_flight", id);
      break;
    }
    case "drift_repair": {
      for (const id of [...neighbourhood].sort(cmp)) {
        if (inflight(id)) block("neighbour_in_flight", id);
        else if (unsettled(id)) block("neighbour_needs_reconciliation", id);
        if (id !== op.childId && migrations.has(id) && state.children[id]?.status !== "succeeded") block("migration_unsettled", id);
      }
      for (const id of [...up].sort(cmp)) if (unresolvedDrift(id)) block("repair_producers_first", id);
      break;
    }
    case "teardown": {
      for (const id of [...migrations].sort(cmp)) if (inflight(id)) block("migration_in_flight", id);
      for (const id of [op.childId, ...[...down].sort(cmp)]) {
        if (inflight(id)) block("neighbour_in_flight", id);
        else if (state.children[id]?.reconciliationRequired) block("neighbour_needs_reconciliation", id);
      }
      for (const id of [...down].sort(cmp)) {
        const applied = state.children[id]?.effects !== "none";
        const step = state.teardown?.steps.find((item) => item.childId === id);
        if (applied && step?.status !== "destroyed") block("teardown_consumers_first", id);
      }
      break;
    }
  }
  return { allowed: blocks.length === 0, blocks };
}
