/**
 * The housekeeping hook (PROD-MIX-04: timeout and expiry propagation without a running executor).
 * Ticks every mixed run whose child timeout or approval expiry has passed, on the platform store.
 * It starts nothing and destroys nothing: a tick only moves overdue children to `timed_out` /
 * `expired` and blocks their dependents. Counts only leave this module.
 */
import type { Sql } from "@/lib/controlplane/types";
import { platformMixedRunStore } from "./run-store";
import { sweepDueMixedRuns } from "./service";

export async function sweepMixedRunDeadlines(sql: Sql, options: { limit?: number; now?: Date } = {}): Promise<{ swept: number; failed: number }> {
  const now = options.now ?? new Date();
  return sweepDueMixedRuns({ runs: platformMixedRunStore(sql), now: () => now }, options.limit ?? 50);
}
