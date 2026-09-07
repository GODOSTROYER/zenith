/**
 * `quota_counters` — requests per app per UTC day, and how many of them were
 * denied.
 *
 * `increment` is one upsert with `RETURNING`, so the count a caller acts on is
 * the count that committed. That matters more than it looks: the gateway
 * decides admission from this number, and a read-modify-write would let two
 * concurrent requests both see 9 999 and both be admitted.
 *
 * PLAN-R3 R3-12: every request that resolves to a known app host counts,
 * whatever its outcome, and the day rolls at 00:00 UTC. Callers pass the day
 * so the boundary is theirs to state and to test.
 *
 * Workstream W1 (hosted R3).
 */
import type { DatabaseSync } from "node:sqlite";
import type { QuotaCounter } from "@/lib/hosted/contracts";
import { nowIso, readNumber, readText, statements, type Prepare, type SqlRow } from "../sql";

/** Reads and writes of the `quota_counters` table. */
export interface QuotasRepo {
  /**
   * Count one request against an app-day and answer with the totals that
   * committed. `denied` also increments the denial counter.
   */
  increment(appId: string, day: string, denied: boolean): QuotaCounter;
  /** The counter as it stands, or a zeroed one when the day has no requests yet. */
  get(appId: string, day: string): QuotaCounter;
  /** Counters for an app, newest day first. */
  listByApp(appId: string, opts?: { sinceDay?: string; limit?: number }): QuotaCounter[];
}

/** The UTC day a timestamp falls in, as `YYYY-MM-DD`. The quota day boundary. */
export const utcDay = (at: string | number | Date = Date.now()): string =>
  (typeof at === "string" ? at : nowIso(at)).slice(0, 10);

/** The one place a row of `quota_counters` becomes a `QuotaCounter`. */
function map(row: SqlRow): QuotaCounter {
  return {
    appId: readText(row, "app_id"),
    day: readText(row, "day"),
    requests: readNumber(row, "requests"),
    denied: readNumber(row, "denied"),
  };
}

/** Bind the `quota_counters` repository to one connection. */
export function createQuotasRepo(db: DatabaseSync): QuotasRepo {
  const sql: Prepare = statements(db);

  return {
    increment(appId, day, denied) {
      const rows = sql(
        "INSERT INTO quota_counters (app_id, day, requests, denied) VALUES (?, ?, 1, ?) " +
          "ON CONFLICT (app_id, day) DO UPDATE SET requests = requests + 1, denied = denied + excluded.denied " +
          "RETURNING app_id, day, requests, denied"
      ).all(appId, day, denied ? 1 : 0);
      return map(rows[0]);
    },

    get(appId, day) {
      const row = sql(
        "SELECT app_id, day, requests, denied FROM quota_counters WHERE app_id = ? AND day = ?"
      ).get(appId, day);
      return row ? map(row) : { appId, day, requests: 0, denied: 0 };
    },

    listByApp(appId, opts = {}) {
      const limit = Math.max(1, Math.trunc(opts.limit ?? 90));
      if (opts.sinceDay)
        return sql(
          "SELECT app_id, day, requests, denied FROM quota_counters WHERE app_id = ? AND day >= ? " +
            "ORDER BY day DESC LIMIT ?"
        )
          .all(appId, opts.sinceDay, limit)
          .map(map);
      return sql(
        "SELECT app_id, day, requests, denied FROM quota_counters WHERE app_id = ? ORDER BY day DESC LIMIT ?"
      )
        .all(appId, limit)
        .map(map);
    },
  };
}
