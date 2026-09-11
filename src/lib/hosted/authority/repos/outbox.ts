/**
 * `hosted_outbox` — side effects committed with the state that justifies them.
 *
 * The rule the whole hosted subsystem follows: nothing that leaves this process
 * happens inside a transaction. An email, a provider call or a ledger append is
 * written here as a row in the same transaction as the grant or release it
 * belongs to, and performed afterwards. Once `tx()` returns, the *intent* is on
 * disk; a crash can delay the effect, never lose it.
 *
 * `idempotency_key` is UNIQUE and enqueue is `INSERT OR IGNORE`, so a caller
 * that retries — a replayed request, a resumed job phase — writes one row, not
 * two. The key is the receiver's dedupe handle as well, which is what makes
 * "at least once delivery" safe to build on.
 */
import type { DatabaseSync } from "node:sqlite";
import type { HostedOutboxEntry, OutboxState } from "@/lib/hosted/contracts";
import {
  changeCount,
  nowIso,
  readJson,
  readNumber,
  readOptionalText,
  readText,
  statements,
  writeJson,
  writeOptional,
  type Prepare,
  type SqlRow,
} from "../sql";

/** The effect kinds this outbox carries. Mirrors `HostedOutboxEntry["kind"]`. */
export type OutboxKind = HostedOutboxEntry["kind"];

/** What the caller supplies to record an intent. */
export interface NewOutboxEntry {
  id: string;
  /** Stable across every retry of one logical effect. UNIQUE. */
  idempotencyKey: string;
  kind: OutboxKind;
  payload: Record<string, unknown>;
  createdAt?: string;
}

/** The result of an enqueue: the row that now exists, and whether this call created it. */
export interface EnqueueResult {
  entry: HostedOutboxEntry;
  inserted: boolean;
}

/** What a settled entry records. */
export interface OutboxSettlement {
  error?: string;
  /**
   * Retries the drainer made *inside* this claim, beyond the one the claim
   * itself counted. Added to the stored total rather than replacing it: a row
   * reclaimed after a crash has already been attempted, and a settlement that
   * overwrote the count would erase the evidence of it.
   */
  extraAttempts?: number;
  now?: string;
}

/** Reads and writes of the `hosted_outbox` table. */
export interface OutboxRepo {
  /**
   * Record an intent. Call inside the transaction that writes the state this
   * effect belongs to. A second call with the same `idempotencyKey` returns
   * the existing row with `inserted: false` and writes nothing.
   */
  enqueue(input: NewOutboxEntry): EnqueueResult;
  get(id: string): HostedOutboxEntry | null;
  getByKey(idempotencyKey: string): HostedOutboxEntry | null;
  /**
   * Reclaim leases older than `leaseMs`, then durably mark pending rows
   * `sending` and hand them back — before any effect runs.
   */
  claimPending(
    leaseMs: number,
    opts?: { kinds?: readonly OutboxKind[]; now?: string; limit?: number }
  ): HostedOutboxEntry[];
  /** Record the terminal outcome of a claimed row. */
  settle(id: string, state: Extract<OutboxState, "done" | "failed">, fields?: OutboxSettlement): boolean;
  /**
   * Put one claimed row back on the queue without settling it — the drainer
   * uses this when it turns out it cannot perform the effect after all, so the
   * row is retried rather than recorded as a failure nobody attempted.
   */
  release(id: string): boolean;
  /** Hand back rows a dead process was holding. `leaseMs` of 0 reclaims every `sending` row. */
  reclaimStale(leaseMs: number, now?: string): number;
  listPending(opts?: { kinds?: readonly OutboxKind[] }): HostedOutboxEntry[];
}

const COLUMNS =
  "id, idempotency_key, kind, payload, state, attempts, created_at, claimed_at, settled_at, error";

/** The one place a row of `hosted_outbox` becomes a `HostedOutboxEntry`. */
function map(row: SqlRow): HostedOutboxEntry {
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

/**
 * `AND kind IN (?, ?)` plus its values.
 *
 * Three cases, and the third is the one worth being explicit about: no filter
 * matches every kind, a non-empty filter matches those kinds, and an *empty*
 * filter matches nothing. A caller that computed "the kinds I can handle" and
 * got none must not be handed every row instead.
 */
function kindFilter(kinds?: readonly OutboxKind[]): { clause: string; values: string[] } {
  if (kinds === undefined) return { clause: "", values: [] };
  if (kinds.length === 0) return { clause: " AND 0", values: [] };
  return { clause: ` AND kind IN (${kinds.map(() => "?").join(", ")})`, values: [...kinds] };
}

/** Bind the `hosted_outbox` repository to one connection. */
export function createOutboxRepo(db: DatabaseSync): OutboxRepo {
  const sql: Prepare = statements(db);

  const byKey = (key: string): HostedOutboxEntry | null => {
    const row = sql(`SELECT ${COLUMNS} FROM hosted_outbox WHERE idempotency_key = ?`).get(key);
    return row ? map(row) : null;
  };

  const reclaim = (leaseMs: number, now: string): number => {
    const cutoff = nowIso(Date.parse(now) - leaseMs);
    const result = sql(
      "UPDATE hosted_outbox SET state = 'pending', claimed_at = NULL " +
        "WHERE state = 'sending' AND (claimed_at IS NULL OR claimed_at <= ?)"
    ).run(cutoff);
    return changeCount(result);
  };

  return {
    enqueue(input) {
      const entry: HostedOutboxEntry = {
        id: input.id,
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
        payload: input.payload,
        state: "pending",
        attempts: 0,
        createdAt: input.createdAt ?? nowIso(),
      };
      const result = sql(
        `INSERT OR IGNORE INTO hosted_outbox (${COLUMNS}) ` +
          "VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL)"
      ).run(entry.id, entry.idempotencyKey, entry.kind, writeJson(entry.payload), entry.createdAt);
      if (changeCount(result) === 1) return { entry, inserted: true };
      const existing = byKey(entry.idempotencyKey);
      return { entry: existing ?? entry, inserted: false };
    },

    get(id) {
      const row = sql(`SELECT ${COLUMNS} FROM hosted_outbox WHERE id = ?`).get(id);
      return row ? map(row) : null;
    },

    getByKey: byKey,

    claimPending(leaseMs, opts = {}) {
      const now = opts.now ?? nowIso();
      reclaim(leaseMs, now);
      const limit = Math.max(1, Math.trunc(opts.limit ?? 100));
      const { clause, values } = kindFilter(opts.kinds);
      return sql(
        "UPDATE hosted_outbox SET state = 'sending', claimed_at = ?, attempts = attempts + 1 " +
          "WHERE id IN (SELECT id FROM hosted_outbox WHERE state = 'pending'" +
          clause +
          " ORDER BY created_at, id LIMIT ?) " +
          `RETURNING ${COLUMNS}`
      )
        .all(now, ...values, limit)
        .map(map);
    },

    settle(id, state, fields = {}) {
      const now = fields.now ?? nowIso();
      const result = sql(
        "UPDATE hosted_outbox SET state = ?, settled_at = ?, claimed_at = NULL, error = ?, " +
          "attempts = attempts + ? WHERE id = ? AND state = 'sending'"
      ).run(state, now, writeOptional(fields.error), Math.max(0, fields.extraAttempts ?? 0), id);
      return changeCount(result) === 1;
    },

    release(id) {
      const result = sql(
        "UPDATE hosted_outbox SET state = 'pending', claimed_at = NULL WHERE id = ? AND state = 'sending'"
      ).run(id);
      return changeCount(result) === 1;
    },

    reclaimStale(leaseMs, now = nowIso()) {
      return reclaim(leaseMs, now);
    },

    listPending(opts = {}) {
      const { clause, values } = kindFilter(opts.kinds);
      return sql(
        `SELECT ${COLUMNS} FROM hosted_outbox WHERE state = 'pending'${clause} ORDER BY created_at, id`
      )
        .all(...values)
        .map(map);
    },
  };
}
