/**
 * `app_exchanges` — the 60-second, single-use code that carries an identity
 * from the control origin to an app host.
 *
 * `consume` is one conditional UPDATE guarded on `consumed_at IS NULL`. That
 * guard, not a read followed by a write, is what makes a code single-use: two
 * redemptions of the same code race inside SQLite, one of them changes a row,
 * and the other gets `null`.
 *
 * **`state` is the browser's state, not a lifecycle.** `AppExchange.state` in
 * the contract is the opaque value the browser sent and must get back on
 * redemption, so it is stored untouched and the lifecycle lives in a separate
 * `status` column. Overwriting `state` with `'consumed'` — the obvious shape,
 * copied from every other table here — would destroy the one value redemption
 * exists to return.
 */
import type { DatabaseSync } from "node:sqlite";
import type { AppExchange, Subject } from "@/lib/hosted/contracts";
import {
  changeCount,
  nowIso,
  readOptionalText,
  readText,
  statements,
  writeOptional,
  type Prepare,
  type SqlRow,
} from "../sql";

/** What the caller supplies to mint an exchange code. */
export interface NewExchange {
  /** SHA-256 hex of the single-use code. 64 characters, enforced by the schema. */
  codeHash: string;
  appId: string;
  subject: Subject;
  grantId: string;
  /** The opaque browser state, echoed back on redemption. */
  state: string;
  expiresAt: string;
  createdAt?: string;
}

/** Reads and writes of the `app_exchanges` table. */
export interface ExchangesRepo {
  insert(input: NewExchange): AppExchange;
  get(codeHash: string): AppExchange | null;
  /**
   * Redeem a code exactly once. Answers with the exchange — including the
   * browser `state` to echo — when this call is the one that consumed it, and
   * `null` when the code is unknown, already consumed or expired (`expires_at`
   * equal to `now` counts as expired).
   */
  consume(codeHash: string, now: string, sessionId?: string): AppExchange | null;
  /**
   * Record which session a redeemed code produced.
   *
   * Separate from `consume` because `session_id` references `app_sessions(id)`
   * and foreign keys are immediate: the session has to exist before the
   * exchange can point at it, so redemption consumes the code, inserts the
   * session and then links the two — all inside one transaction. False when
   * the code is unknown.
   */
  linkSession(codeHash: string, sessionId: string): boolean;
  /** Mark unconsumed codes past their expiry, and delete what is settled. Returns rows removed. */
  purgeExpired(now?: string): number;
}

const COLUMNS =
  "code_hash, app_id, subject, grant_id, state, created_at, expires_at, consumed_at, session_id";

/** The one place a row of `app_exchanges` becomes an `AppExchange`. */
function map(row: SqlRow): AppExchange {
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

/** Bind the `app_exchanges` repository to one connection. */
export function createExchangesRepo(db: DatabaseSync): ExchangesRepo {
  const sql: Prepare = statements(db);

  return {
    insert(input) {
      const exchange: AppExchange = {
        codeHash: input.codeHash,
        appId: input.appId,
        subject: input.subject,
        grantId: input.grantId,
        state: input.state,
        createdAt: input.createdAt ?? nowIso(),
        expiresAt: input.expiresAt,
      };
      sql(
        "INSERT INTO app_exchanges (code_hash, app_id, subject, grant_id, state, status, " +
          "created_at, expires_at, consumed_at, session_id) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL)"
      ).run(
        exchange.codeHash,
        exchange.appId,
        exchange.subject,
        exchange.grantId,
        exchange.state,
        exchange.createdAt,
        exchange.expiresAt
      );
      return exchange;
    },

    get(codeHash) {
      const row = sql(`SELECT ${COLUMNS} FROM app_exchanges WHERE code_hash = ?`).get(codeHash);
      return row ? map(row) : null;
    },

    consume(codeHash, now, sessionId) {
      const rows = sql(
        "UPDATE app_exchanges SET status = 'consumed', consumed_at = ?, " +
          "session_id = COALESCE(?, session_id) " +
          "WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ? " +
          `RETURNING ${COLUMNS}`
      ).all(now, writeOptional(sessionId), codeHash, now);
      return rows.length === 1 ? map(rows[0]) : null;
    },

    linkSession(codeHash, sessionId) {
      const result = sql("UPDATE app_exchanges SET session_id = ? WHERE code_hash = ?").run(
        sessionId,
        codeHash
      );
      return changeCount(result) === 1;
    },

    purgeExpired(now = nowIso()) {
      sql(
        "UPDATE app_exchanges SET status = 'expired' " +
          "WHERE status = 'pending' AND consumed_at IS NULL AND expires_at <= ?"
      ).run(now);
      const result = sql("DELETE FROM app_exchanges WHERE expires_at <= ?").run(now);
      return changeCount(result);
    },
  };
}
