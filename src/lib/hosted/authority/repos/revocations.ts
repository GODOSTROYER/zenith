/**
 * `revocation_ledger` — a monotonically numbered, append-only record of every
 * grant that was taken away.
 *
 * This is the one table designed to be read *outside* the database it lives
 * in. Its rows are copied to the off-host backup target, so a clean-host
 * restore from an older snapshot can ask "what was revoked after the snapshot
 * I just restored?" and re-apply it. Without that, restoring last night's
 * backup would quietly re-admit everyone removed today (G23).
 *
 * Hence three properties: the sequence is `INTEGER PRIMARY KEY AUTOINCREMENT`
 * so numbers are never reused after a delete; there is no foreign key to
 * `apps`, because the ledger has to be readable against a snapshot in which
 * the app row does not exist yet; and there is no update or delete here at
 * all.
 */
import type { DatabaseSync } from "node:sqlite";
import type { RevocationLedgerEntry, Subject } from "@/lib/hosted/contracts";
import { nowIso, readNumber, readText, statements, type Prepare, type SqlRow } from "../sql";

/** What the caller supplies to record a revocation. The sequence number is assigned here. */
export interface NewRevocation {
  appId: string;
  grantId: string;
  subject: Subject;
  by: Subject;
  reason: string;
  at?: string;
}

/** Reads and writes of the `revocation_ledger` table. */
export interface RevocationsRepo {
  /** Append one revocation and answer with the row, including its assigned `seq`. */
  append(input: NewRevocation): RevocationLedgerEntry;
  /** Everything numbered above `seq`, oldest first — the reconciliation read. */
  listAfter(seq: number, opts?: { limit?: number }): RevocationLedgerEntry[];
  /** The highest sequence number issued, or 0 when the ledger is empty. */
  maxSeq(): number;
}

const COLUMNS = "seq, at, app_id, grant_id, subject, by, reason";

/** The one place a row of `revocation_ledger` becomes a `RevocationLedgerEntry`. */
function map(row: SqlRow): RevocationLedgerEntry {
  return {
    seq: readNumber(row, "seq"),
    at: readText(row, "at"),
    appId: readText(row, "app_id"),
    grantId: readText(row, "grant_id"),
    subject: readText(row, "subject"),
    by: readText(row, "by"),
    reason: readText(row, "reason"),
  };
}

/** Bind the `revocation_ledger` repository to one connection. */
export function createRevocationsRepo(db: DatabaseSync): RevocationsRepo {
  const sql: Prepare = statements(db);

  return {
    append(input) {
      const rows = sql(
        "INSERT INTO revocation_ledger (at, app_id, grant_id, subject, by, reason) " +
          `VALUES (?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`
      ).all(input.at ?? nowIso(), input.appId, input.grantId, input.subject, input.by, input.reason);
      return map(rows[0]);
    },

    listAfter(seq, opts = {}) {
      const limit = Math.max(1, Math.trunc(opts.limit ?? 1000));
      return sql(`SELECT ${COLUMNS} FROM revocation_ledger WHERE seq > ? ORDER BY seq LIMIT ?`)
        .all(seq, limit)
        .map(map);
    },

    maxSeq() {
      const row = sql("SELECT COALESCE(MAX(seq), 0) AS top FROM revocation_ledger").get();
      return row ? readNumber(row, "top") : 0;
    },
  };
}
