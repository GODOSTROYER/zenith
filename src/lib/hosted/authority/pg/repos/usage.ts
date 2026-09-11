/**
 * `hosted.usage_ledger` — the Postgres twin of `authority/repos/usage.ts`.
 *
 * Append-only, and nothing here updates or deletes a row. The spending envelope
 * and the 50/75/90 % alerts are only as trustworthy as the record they sum: a
 * ledger whose rows can be edited can be made to say anything, while one that
 * can only grow can be re-summed by anyone who doubts the total.
 *
 * `amount` is `double precision` rather than `bigint`, so it arrives as a real
 * number and `sum(amount)` does too; `coalesce(…, 0)` is still what makes an
 * empty slice a 0 instead of a NULL, exactly as in the SQLite repository.
 *
 * The shared `where` fragment is the load-bearing detail: a total and its list
 * must be able to disagree about *nothing*, so both are built from one
 * expression rather than two that happen to match today.
 */
import type { UsageEntry } from "@/lib/hosted/contracts";
import { nowIso } from "../../sql";
import type { UsageRepo } from "../../repos";
import type { UsageKind, UsageQuery } from "../../repos/usage";
import type { Sql, TransactionSql } from "../client";
import { readNumber, readOptionalText, readText, writeOptional, type PgRow } from "../rows";

/** The one place a row of `usage_ledger` becomes a `UsageEntry`. */
function map(row: PgRow): UsageEntry {
  return {
    id: readText(row, "id"),
    workspaceId: readText(row, "workspace_id"),
    appId: readOptionalText(row, "app_id"),
    kind: readText(row, "kind") as UsageKind,
    amount: readNumber(row, "amount"),
    at: readText(row, "at"),
    note: readOptionalText(row, "note"),
  };
}

/** Bind the `usage_ledger` repository to one connection or transaction. */
export function createPgUsageRepo(sql: Sql | TransactionSql): UsageRepo {
  /** The shared `where` of both reads, so a total can never cover a different slice from its list. */
  const where = (query: UsageQuery) => sql`
    where workspace_id = ${query.workspaceId} and usage_ledger.at >= ${query.since}
    ${query.appId === undefined ? sql`` : sql`and app_id = ${query.appId}`}
    ${query.kind === undefined ? sql`` : sql`and kind = ${query.kind}`}
  `;

  return {
    async append(input) {
      const entry: UsageEntry = {
        id: input.id,
        workspaceId: input.workspaceId,
        appId: input.appId,
        kind: input.kind,
        amount: input.amount,
        at: input.at ?? nowIso(),
        note: input.note,
      };
      await sql`
        insert into hosted.usage_ledger (id, workspace_id, app_id, kind, amount, at, note)
        values (${entry.id}, ${entry.workspaceId}, ${writeOptional(entry.appId)}, ${entry.kind},
                ${entry.amount}, ${entry.at}, ${writeOptional(entry.note)})
      `;
      return entry;
    },

    async sumSince(query) {
      const rows = (await sql`
        select coalesce(sum(amount), 0) as total from hosted.usage_ledger ${where(query)}
      `) as unknown as PgRow[];
      return rows.length === 1 ? readNumber(rows[0], "total") : 0;
    },

    async listSince(query, opts = {}) {
      const limit = Math.max(1, Math.trunc(opts.limit ?? 500));
      const rows = (await sql`
        select id, workspace_id, app_id, kind, amount, at, note from hosted.usage_ledger
        ${where(query)}
        order by usage_ledger.at, id
        limit ${limit}
      `) as unknown as PgRow[];
      return rows.map(map);
    },
  };
}
