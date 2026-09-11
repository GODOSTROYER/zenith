/**
 * `hosted.hosted_outbox` — the Postgres twin of `authority/repos/outbox.ts`.
 *
 * Same table, same statements, same guarantees. Two translations are worth
 * naming because every repository package will meet them:
 *
 *  - **`INSERT OR IGNORE` is `on conflict do nothing`.** Same effect, same
 *    reliance on `idempotency_key` being UNIQUE: a caller that retries writes
 *    one row, and learns from `count` whether this call was the one that
 *    created it.
 *  - **`LIMIT` inside a subquery needs `for update skip locked`.** SQLite
 *    serialises writers, so "take the oldest hundred pending rows" cannot
 *    overlap with another claim. Postgres does not, and two drainers running
 *    the same subquery would block on each other and then claim rows the other
 *    already had. `skip locked` makes each drainer take rows nobody else holds,
 *    which is what the single-connection SQLite version got for free.
 */
import type { HostedOutboxEntry, OutboxState } from "@/lib/hosted/contracts";
import { nowIso } from "../../sql";
import type { OutboxRepo } from "../../repos";
import type { OutboxKind } from "../../repos/outbox";
import type { Sql, TransactionSql } from "../client";
import {
  changeCount,
  readJson,
  readNumber,
  readOptionalText,
  readText,
  writeJson,
  writeOptional,
  type PgRow,
} from "../rows";

/** The one place a row of `hosted_outbox` becomes a `HostedOutboxEntry`. */
function map(row: PgRow): HostedOutboxEntry {
  return {
    id: readText(row, "id"),
    idempotencyKey: readText(row, "idempotency_key"),
    kind: readText(row, "kind") as OutboxKind,
    payload: readJson<Record<string, unknown>>(row, "payload"),
    state: readText(row, "state") as OutboxState,
    attempts: readNumber(row, "attempts"),
    createdAt: readText(row, "created_at"),
    claimedAt: readOptionalText(row, "claimed_at"),
    settledAt: readOptionalText(row, "settled_at"),
    error: readOptionalText(row, "error"),
  };
}

/** Bind the `hosted_outbox` repository to one connection or transaction. */
export function createPgOutboxRepo(sql: Sql | TransactionSql): OutboxRepo {
  const byKey = async (key: string): Promise<HostedOutboxEntry | null> => {
    const rows = (await sql`
      select * from hosted.hosted_outbox where idempotency_key = ${key}
    `) as unknown as PgRow[];
    return rows.length === 1 ? map(rows[0]) : null;
  };

  const reclaim = async (leaseMs: number, now: string): Promise<number> => {
    const cutoff = nowIso(Date.parse(now) - leaseMs);
    const result = await sql`
      update hosted.hosted_outbox set state = 'pending', claimed_at = null
      where state = 'sending' and (claimed_at is null or claimed_at <= ${cutoff})
    `;
    return changeCount(result);
  };

  return {
    async enqueue(input) {
      const entry: HostedOutboxEntry = {
        id: input.id,
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
        payload: input.payload,
        state: "pending",
        attempts: 0,
        createdAt: input.createdAt ?? nowIso(),
      };
      const result = await sql`
        insert into hosted.hosted_outbox
          (id, idempotency_key, kind, payload, state, attempts, created_at, claimed_at, settled_at, error)
        values
          (${entry.id}, ${entry.idempotencyKey}, ${entry.kind}, ${writeJson(entry.payload)},
           'pending', 0, ${entry.createdAt}, null, null, null)
        on conflict (idempotency_key) do nothing
      `;
      if (changeCount(result) === 1) return { entry, inserted: true };
      const existing = await byKey(entry.idempotencyKey);
      return { entry: existing ?? entry, inserted: false };
    },

    async get(id) {
      const rows = (await sql`
        select * from hosted.hosted_outbox where id = ${id}
      `) as unknown as PgRow[];
      return rows.length === 1 ? map(rows[0]) : null;
    },

    getByKey: byKey,

    async claimPending(leaseMs, opts = {}) {
      const now = opts.now ?? nowIso();
      await reclaim(leaseMs, now);
      const limit = Math.max(1, Math.trunc(opts.limit ?? 100));
      const kinds = opts.kinds;
      // A caller that computed "the kinds I can handle" and got none must be
      // handed nothing, not everything. See `kindFilter` in the SQLite repo.
      if (kinds !== undefined && kinds.length === 0) return [];
      const rows = (await sql`
        update hosted.hosted_outbox set
          state = 'sending',
          claimed_at = ${now},
          attempts = attempts + 1
        where id in (
          select id from hosted.hosted_outbox
          where state = 'pending'
          ${kinds === undefined ? sql`` : sql`and kind in ${sql(kinds as readonly string[])}`}
          order by created_at, id
          limit ${limit}
          for update skip locked
        )
        returning *
      `) as unknown as PgRow[];
      return rows.map(map);
    },

    async settle(id, state, fields = {}) {
      const result = await sql`
        update hosted.hosted_outbox set
          state = ${state},
          settled_at = ${fields.now ?? nowIso()},
          claimed_at = null,
          error = ${writeOptional(fields.error)},
          attempts = attempts + ${Math.max(0, fields.extraAttempts ?? 0)}
        where id = ${id} and state = 'sending'
      `;
      return changeCount(result) === 1;
    },

    async release(id) {
      const result = await sql`
        update hosted.hosted_outbox set state = 'pending', claimed_at = null
        where id = ${id} and state = 'sending'
      `;
      return changeCount(result) === 1;
    },

    async reclaimStale(leaseMs, now = nowIso()) {
      return reclaim(leaseMs, now);
    },

    async listPending(opts = {}) {
      const kinds = opts.kinds;
      if (kinds !== undefined && kinds.length === 0) return [];
      const rows = (await sql`
        select * from hosted.hosted_outbox
        where state = 'pending'
        ${kinds === undefined ? sql`` : sql`and kind in ${sql(kinds as readonly string[])}`}
        order by created_at, id
      `) as unknown as PgRow[];
      return rows.map(map);
    },
  };
}
