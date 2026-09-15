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
 *
 * A claim is *fenced*: `claimPending` hands back the row with the `attempts`
 * value its own statement wrote, and `settle`, `release` and `renew` are all
 * conditional on it. A worker that stalled past its lease and was reclaimed
 * gets `false` instead of overwriting the new owner's work — the same rule
 * `hosted_jobs` keeps with its `fence_token` column. See `outboxFence`.
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
  /**
   * The claim being settled: `attempts` as `claimPending` returned it.
   *
   * This is the fence token. `attempts` is incremented by the claim itself and
   * never decremented, so it names one claim of one row for as long as that row
   * exists, and a worker holding an older value is provably not the owner. See
   * `outboxFence` below for why an existing column is the token rather than a
   * new one.
   */
  fence: number;
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

/**
 * The fence token for a claimed row.
 *
 * `hosted_jobs` carries an explicit `fence_token` column and conditions every
 * `advance`/`finish`/`fail` on it (`repos/jobs.ts`). The outbox had nothing:
 * `settle` and `release` were guarded on `state = 'sending'` alone, so a worker
 * that stalled past its lease, was reclaimed, and then woke up would settle the
 * row *the new owner was actively sending* — losing the new owner's attempt
 * count and, if its send had failed, the failure itself.
 *
 * `attempts` supplies the same guarantee with no migration: `claimPending`
 * increments it in the same statement that takes the row, so every claim has a
 * strictly larger token than the claim before it, and no two live claims of one
 * row can share one. A column of its own would be more self-describing and is
 * the right shape for the schema owner to add later — see the handoff — but the
 * fence is real either way, because the *database* decides who matches.
 */
export const outboxFence = (entry: HostedOutboxEntry): number => entry.attempts;

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
  /**
   * Record the terminal outcome of a claimed row, if this claim still owns it.
   * `false` means the lease was lost and another worker holds the row — the
   * effect may have happened twice, but the record belongs to the new owner.
   */
  settle(id: string, state: Extract<OutboxState, "done" | "failed">, fields: OutboxSettlement): boolean;
  /**
   * Put one claimed row back on the queue without settling it — the drainer
   * uses this when it turns out it cannot perform the effect after all, so the
   * row is retried rather than recorded as a failure nobody attempted. Fenced:
   * a stale holder must not hand back a row somebody else is sending.
   */
  release(id: string, fence: number): boolean;
  /**
   * Extend this claim's lease. `false` means it is already gone — stop, and do
   * not settle: the row belongs to whoever reclaimed it.
   */
  renew(id: string, fence: number, now?: string): boolean;
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

    settle(id, state, fields) {
      const now = fields.now ?? nowIso();
      const result = sql(
        "UPDATE hosted_outbox SET state = ?, settled_at = ?, claimed_at = NULL, error = ?, " +
          "attempts = attempts + ? WHERE id = ? AND state = 'sending' AND attempts = ?"
      ).run(
        state,
        now,
        writeOptional(fields.error),
        Math.max(0, fields.extraAttempts ?? 0),
        id,
        fields.fence
      );
      return changeCount(result) === 1;
    },

    release(id, fence) {
      const result = sql(
        "UPDATE hosted_outbox SET state = 'pending', claimed_at = NULL " +
          "WHERE id = ? AND state = 'sending' AND attempts = ?"
      ).run(id, fence);
      return changeCount(result) === 1;
    },

    renew(id, fence, now = nowIso()) {
      const result = sql(
        "UPDATE hosted_outbox SET claimed_at = ? WHERE id = ? AND state = 'sending' AND attempts = ?"
      ).run(now, id, fence);
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
