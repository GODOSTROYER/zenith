/**
 * `hosted.quota_counters` — the Postgres twin of `authority/repos/quotas.ts`.
 *
 * The one property this table exists to keep is that **the number a caller acts
 * on is the number that committed**. The gateway admits or denies a request from
 * this counter, so a read-modify-write would let two concurrent requests both
 * see 9 999 and both be admitted. `increment` is therefore a single upsert with
 * `RETURNING` — `insert … on conflict (app_id, day) do update set requests =
 * quota_counters.requests + 1` — exactly as the SQLite repository is, and for
 * exactly the same reason.
 *
 * `requests` and `denied` are `bigint` here, so the driver hands them back as
 * decimal strings; `readNumber` turns them into the `number` `QuotaCounter`
 * types them as, refusing rather than rounding anything past 2^53.
 */
import type { QuotaCounter } from "@/lib/hosted/contracts";
import type { QuotasRepo } from "../../repos";
import type { Sql, TransactionSql } from "../client";
import { changeCount, readNumber, readText, type PgRow } from "../rows";

/** The one place a row of `quota_counters` becomes a `QuotaCounter`. */
function map(row: PgRow): QuotaCounter {
  return {
    appId: readText(row, "app_id"),
    day: readText(row, "day"),
    requests: readNumber(row, "requests"),
    denied: readNumber(row, "denied"),
  };
}

/** Bind the `quota_counters` repository to one connection or transaction. */
export function createPgQuotasRepo(sql: Sql | TransactionSql): QuotasRepo {
  return {
    async increment(appId, day, denied) {
      // One statement, never a read then a write: two concurrent requests must
      // see two different totals, and the total each acts on has to be its own.
      const rows = (await sql`
        insert into hosted.quota_counters (app_id, day, requests, denied)
        values (${appId}, ${day}, 1, ${denied ? 1 : 0})
        on conflict (app_id, day) do update set
          requests = quota_counters.requests + 1,
          denied = quota_counters.denied + excluded.denied
        returning app_id, day, requests, denied
      `) as unknown as PgRow[];
      return map(rows[0]);
    },

    async get(appId, day) {
      const rows = (await sql`
        select app_id, day, requests, denied from hosted.quota_counters
        where app_id = ${appId} and day = ${day}
      `) as unknown as PgRow[];
      // A day with no requests is a zeroed counter, not a null: a caller
      // comparing against a limit must never have to check for absence first.
      return rows.length === 1 ? map(rows[0]) : { appId, day, requests: 0, denied: 0 };
    },

    async listByApp(appId, opts = {}) {
      const limit = Math.max(1, Math.trunc(opts.limit ?? 90));
      const rows = (await sql`
        select app_id, day, requests, denied from hosted.quota_counters
        where app_id = ${appId}
        ${opts.sinceDay ? sql`and day >= ${opts.sinceDay}` : sql``}
        order by day desc
        limit ${limit}
      `) as unknown as PgRow[];
      return rows.map(map);
    },

    async resetDay(appId, day) {
      const result =
        day === undefined
          ? await sql`delete from hosted.quota_counters where app_id = ${appId}`
          : await sql`delete from hosted.quota_counters where app_id = ${appId} and day = ${day}`;
      return changeCount(result);
    },
  };
}
