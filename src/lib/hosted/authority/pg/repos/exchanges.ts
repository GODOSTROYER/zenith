/**
 * `hosted.app_exchanges` — the Postgres twin of `authority/repos/exchanges.ts`.
 *
 * `consume` is one conditional UPDATE guarded on `consumed_at is null`, with
 * RETURNING, on both stores. Two redemptions of the same code race, one changes
 * a row and gets the exchange back, the other gets `null`. Nothing reads before
 * it writes.
 *
 * `state` is the browser's opaque value and is never overwritten; the lifecycle
 * lives in `status`. See the SQLite repository's header for why that split is
 * load-bearing.
 */
import type { AppExchange } from "@/lib/hosted/contracts";
import { nowIso } from "../../sql";
import type { ExchangesRepo } from "../../repos";
import type { Sql, TransactionSql } from "../client";
import { changeCount, readOptionalText, readText, writeOptional, type PgRow } from "../rows";

/** The one place a row of `app_exchanges` becomes an `AppExchange`. */
function map(row: PgRow): AppExchange {
  return {
    codeHash: readText(row, "code_hash"),
    appId: readText(row, "app_id"),
    subject: readText(row, "subject"),
    grantId: readText(row, "grant_id"),
    state: readText(row, "state"),
    createdAt: readText(row, "created_at"),
    expiresAt: readText(row, "expires_at"),
    consumedAt: readOptionalText(row, "consumed_at"),
    sessionId: readOptionalText(row, "session_id"),
  };
}

/** Bind the `app_exchanges` repository to one connection or transaction. */
export function createPgExchangesRepo(sql: Sql | TransactionSql): ExchangesRepo {
  return {
    async insert(input) {
      const exchange: AppExchange = {
        codeHash: input.codeHash,
        appId: input.appId,
        subject: input.subject,
        grantId: input.grantId,
        state: input.state,
        createdAt: input.createdAt ?? nowIso(),
        expiresAt: input.expiresAt,
      };
      await sql`
        insert into hosted.app_exchanges
          (code_hash, app_id, subject, grant_id, state, status, created_at, expires_at,
           consumed_at, session_id)
        values
          (${exchange.codeHash}, ${exchange.appId}, ${exchange.subject}, ${exchange.grantId},
           ${exchange.state}, 'pending', ${exchange.createdAt}, ${exchange.expiresAt}, null, null)
      `;
      return exchange;
    },

    async get(codeHash) {
      const rows = (await sql`
        select * from hosted.app_exchanges where code_hash = ${codeHash}
      `) as unknown as PgRow[];
      return rows.length === 1 ? map(rows[0]) : null;
    },

    async consume(codeHash, now, sessionId) {
      const rows = (await sql`
        update hosted.app_exchanges set
          status = 'consumed',
          consumed_at = ${now},
          session_id = coalesce(${writeOptional(sessionId)}, session_id)
        where code_hash = ${codeHash} and consumed_at is null and expires_at > ${now}
        returning *
      `) as unknown as PgRow[];
      return rows.length === 1 ? map(rows[0]) : null;
    },

    async linkSession(codeHash, sessionId) {
      const result = await sql`
        update hosted.app_exchanges set session_id = ${sessionId} where code_hash = ${codeHash}
      `;
      return changeCount(result) === 1;
    },

    async purgeExpired(now = nowIso()) {
      await sql`
        update hosted.app_exchanges set status = 'expired'
        where status = 'pending' and consumed_at is null and expires_at <= ${now}
      `;
      const result = await sql`
        delete from hosted.app_exchanges where expires_at <= ${now}
      `;
      return changeCount(result);
    },
  };
}
