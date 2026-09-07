/**
 * `usage_ledger` — append-only measurements: build milliseconds, requests,
 * stored bytes, emails and provider dollars.
 *
 * Append-only because the spending envelope and the 50/75/90 % alerts are only
 * as trustworthy as the record they sum. A ledger whose rows can be edited can
 * be made to say anything; one that can only grow can be re-summed by anyone
 * who doubts the total.
 *
 * Workstream W1 (hosted R3).
 */
import type { DatabaseSync } from "node:sqlite";
import type { UsageEntry } from "@/lib/hosted/contracts";
import {
  nowIso,
  readNumber,
  readOptionalText,
  readText,
  statements,
  writeOptional,
  type Prepare,
  type SqlRow,
} from "../sql";

/** The measurement kinds the ledger carries. Mirrors `UsageEntry["kind"]`. */
export type UsageKind = UsageEntry["kind"];

/** What the caller supplies to append a measurement. */
export interface NewUsageEntry {
  id: string;
  workspaceId: string;
  appId?: string;
  kind: UsageKind;
  amount: number;
  at?: string;
  note?: string;
}

/** Which slice of the ledger to read or total. */
export interface UsageQuery {
  workspaceId: string;
  appId?: string;
  kind?: UsageKind;
  /** Inclusive ISO lower bound. */
  since: string;
}

/** Reads and writes of the `usage_ledger` table. */
export interface UsageRepo {
  append(input: NewUsageEntry): UsageEntry;
  /** Total `amount` over the slice. 0 when nothing matches — never null. */
  sumSince(query: UsageQuery): number;
  /** The slice itself, oldest first. */
  listSince(query: UsageQuery, opts?: { limit?: number }): UsageEntry[];
}

const COLUMNS = "id, workspace_id, app_id, kind, amount, at, note";

/** The one place a row of `usage_ledger` becomes a `UsageEntry`. */
function map(row: SqlRow): UsageEntry {
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

/** The shared `WHERE` of both reads, so a total can never cover a different slice from its list. */
function where(query: UsageQuery): { clause: string; values: (string | null)[] } {
  const values: (string | null)[] = [query.workspaceId, query.since];
  let clause = "workspace_id = ? AND at >= ?";
  if (query.appId !== undefined) {
    clause += " AND app_id = ?";
    values.push(query.appId);
  }
  if (query.kind !== undefined) {
    clause += " AND kind = ?";
    values.push(query.kind);
  }
  return { clause, values };
}

/** Bind the `usage_ledger` repository to one connection. */
export function createUsageRepo(db: DatabaseSync): UsageRepo {
  const sql: Prepare = statements(db);

  return {
    append(input) {
      const entry: UsageEntry = {
        id: input.id,
        workspaceId: input.workspaceId,
        appId: input.appId,
        kind: input.kind,
        amount: input.amount,
        at: input.at ?? nowIso(),
        note: input.note,
      };
      sql(`INSERT INTO usage_ledger (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        entry.id,
        entry.workspaceId,
        writeOptional(entry.appId),
        entry.kind,
        entry.amount,
        entry.at,
        writeOptional(entry.note)
      );
      return entry;
    },

    sumSince(query) {
      const { clause, values } = where(query);
      const row = sql(`SELECT COALESCE(SUM(amount), 0) AS total FROM usage_ledger WHERE ${clause}`).get(
        ...values
      );
      return row ? readNumber(row, "total") : 0;
    },

    listSince(query, opts = {}) {
      const { clause, values } = where(query);
      const limit = Math.max(1, Math.trunc(opts.limit ?? 500));
      return sql(`SELECT ${COLUMNS} FROM usage_ledger WHERE ${clause} ORDER BY at, id LIMIT ?`)
        .all(...values, limit)
        .map(map);
    },
  };
}
