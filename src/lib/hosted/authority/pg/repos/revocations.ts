/**
 * `hosted.revocation_ledger` — the Postgres twin of
 * `authority/repos/revocations.ts`.
 *
 * This is the one table designed to be read *outside* the database it lives in:
 * its rows are copied off-host so that a clean-host restore from an older
 * snapshot can ask "what was revoked after the snapshot I just restored?" and
 * re-apply it. Without that, restoring last night's backup would quietly
 * re-admit everyone removed today (G23).
 *
 * The three properties survive the translation as database facts:
 *
 *  - **The sequence is never reused.** SQLite's `INTEGER PRIMARY KEY
 *    AUTOINCREMENT` becomes `bigint generated always as identity`, which draws
 *    from a sequence rather than from `max(seq) + 1`. That is what makes `append`
 *    race-safe here without a lock: two concurrent appends take two different
 *    numbers because the sequence hands out two different numbers, where SQLite
 *    got the same answer from serialising its writers. `seq` is therefore never
 *    named in the insert — `generated always` refuses a supplied value, which is
 *    the point.
 *  - **No foreign key on `app_id`**, because the ledger has to be readable
 *    against a snapshot in which the app row does not exist yet.
 *  - **No update and no delete**, here or in the interface.
 *
 * `seq` is `bigint`, so the driver hands it back as a decimal string and
 * `readNumber` is what turns it into the `number` `RevocationLedgerEntry` types
 * it as. `by` is quoted in the insert: it is an unreserved keyword, and quoting
 * it costs nothing and removes the question.
 */
import type { RevocationLedgerEntry } from "@/lib/hosted/contracts";
import { nowIso } from "../../sql";
import type { RevocationsRepo } from "../../repos";
import type { Sql, TransactionSql } from "../client";
import { readNumber, readText, type PgRow } from "../rows";

/** The one place a row of `revocation_ledger` becomes a `RevocationLedgerEntry`. */
function map(row: PgRow): RevocationLedgerEntry {
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

/** Bind the `revocation_ledger` repository to one connection or transaction. */
export function createPgRevocationsRepo(sql: Sql | TransactionSql): RevocationsRepo {
  return {
    async append(input) {
      const rows = (await sql`
        insert into hosted.revocation_ledger (at, app_id, grant_id, subject, "by", reason)
        values (${input.at ?? nowIso()}, ${input.appId}, ${input.grantId}, ${input.subject},
                ${input.by}, ${input.reason})
        returning seq, at, app_id, grant_id, subject, "by", reason
      `) as unknown as PgRow[];
      return map(rows[0]);
    },

    async listAfter(seq, opts = {}) {
      const limit = Math.max(1, Math.trunc(opts.limit ?? 1000));
      const rows = (await sql`
        select seq, at, app_id, grant_id, subject, "by", reason from hosted.revocation_ledger
        where seq > ${seq}
        order by seq
        limit ${limit}
      `) as unknown as PgRow[];
      return rows.map(map);
    },

    async maxSeq() {
      const rows = (await sql`
        select coalesce(max(seq), 0) as top from hosted.revocation_ledger
      `) as unknown as PgRow[];
      return rows.length === 1 ? readNumber(rows[0], "top") : 0;
    },
  };
}
