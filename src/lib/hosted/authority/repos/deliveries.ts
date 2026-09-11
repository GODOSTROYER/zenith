/**
 * `invite_deliveries` — one row per attempt to put an invitation in front of a
 * person, and the sealed payload that makes a retry possible.
 *
 * Claim before the effect, settle after: a row is durably `sending` before the
 * first byte leaves, so a crash mid-send leaves evidence to reclaim rather
 * than an invitation nobody knows was half sent. `sent` means the transport
 * accepted the message; nothing here ever claims a mailbox received it.
 *
 * `sealed_payload` holds the AES-GCM sealed token W5 needs to rebuild the
 * email — this module stores bytes and nothing else. It is erased with
 * `clearSealedPayload` once the row settles, which is what bounds how long a
 * working invitation link exists inside the database.
 */
import type { DatabaseSync } from "node:sqlite";
import type { DeliveryState, InviteDelivery } from "@/lib/hosted/contracts";
import {
  changeCount,
  nowIso,
  readBytes,
  readNumber,
  readOptionalText,
  readText,
  statements,
  writeOptional,
  type Prepare,
  type SqlRow,
} from "../sql";

/** What the caller supplies to queue a delivery. */
export interface NewDelivery {
  id: string;
  inviteId: string;
  /** The sealed token bytes; omit when there is nothing to rebuild. */
  sealedPayload?: Uint8Array | null;
  createdAt?: string;
}

/** A claimed row and the bytes the sender needs, handed over together. */
export interface ClaimedDelivery {
  delivery: InviteDelivery;
  sealedPayload: Uint8Array | null;
}

/**
 * Every value the `transport` CHECK accepts, as a constant rather than
 * something read back out of the schema.
 *
 * The outbox handler has to know whether this database will accept
 * `'none'` — "no transport is configured, the owner shares the link by hand" —
 * before it writes it. It used to learn that by parsing the table's DDL out of
 * `sqlite_master`, which is both a SQLite-only trick and a lie waiting to
 * happen. Migration v2 widened the CHECK on every install this build can open,
 * and `0002_hosted_authority.sql` starts Postgres at the widened one, so the
 * answer is a fact of the build. Adding a value here means adding a migration
 * on both stores.
 */
export const DELIVERY_TRANSPORTS = ["smtp", "log", "none"] as const;

/** One of the transports `invite_deliveries.transport` accepts. */
export type DeliveryTransport = (typeof DELIVERY_TRANSPORTS)[number];

/** What a targeted `claim` found. */
export type TargetedClaim =
  /** This call owns the row; it is durably `sending` and `attempts` has moved. */
  | { kind: "claimed"; delivery: InviteDelivery; sealedPayload: Uint8Array | null }
  /** Terminal success: the transport already accepted this one. Never re-claimed. */
  | { kind: "sent" }
  /** Somebody else's live claim. Leave it alone; their lease has not expired. */
  | { kind: "busy" }
  /** No such row. */
  | { kind: "missing" };

/** What settling a never-attempted delivery records. */
export interface PendingSettlement {
  /** The transport that would have been used, or `null` when there was none at all. */
  transport?: DeliveryTransport | null;
  /** Why it was never attempted. Always present: a failure with no reason cannot be acted on. */
  error: string;
  now?: string;
}

/** What a settled delivery records. */
export interface DeliverySettlement {
  transport?: DeliveryTransport;
  providerMessageId?: string;
  /** Required in spirit for `failed`: a failure with no reason cannot be acted on. */
  error?: string;
  now?: string;
}

/** Reads and writes of the `invite_deliveries` table. */
export interface DeliveriesRepo {
  insert(input: NewDelivery): InviteDelivery;
  get(id: string): InviteDelivery | null;
  listByInvite(inviteId: string): InviteDelivery[];
  /**
   * Reclaim leases older than `leaseMs`, then take every `pending` row,
   * durably mark it `sending` and hand it back with its sealed payload. The
   * `attempts` counter moves here, before the effect, so a crash still counts.
   */
  claimPending(leaseMs: number, opts?: { now?: string; limit?: number }): ClaimedDelivery[];
  /**
   * Claim exactly one row, by id, and say what was found.
   *
   * What the invitation outbox handler uses: it is invoked once per outbox row
   * and must own exactly the row that row names, where `claimPending` takes the
   * whole queue. A `failed` row is claimable again — that is what makes the
   * outbox's retries reach the transport — and so is a `sending` row whose
   * claim is older than `leaseMs`. A `sent` row never is.
   */
  claim(id: string, leaseMs: number, now?: string): TargetedClaim;
  /** Record the terminal outcome of a claimed row. */
  settle(id: string, state: Extract<DeliveryState, "sent" | "failed">, fields?: DeliverySettlement): boolean;
  /**
   * Settle a row that was never claimed, because it was never going to be
   * attempted — this install has no transport, so the owner must share the link
   * by hand.
   *
   * `settle` deliberately will not do this: it moves a `sending` row, and
   * moving a `pending` one would let a settlement overtake a send that is in
   * flight. This moves a `pending` row and only a `pending` row. False when
   * there was no pending row to settle.
   */
  settlePending(id: string, outcome: PendingSettlement): boolean;
  /** Hand back rows a dead process was holding. Returns how many moved to `pending`. */
  reclaimStale(leaseMs: number, now?: string): number;
  /** Erase the sealed token. Call once the invitation can no longer be resent from this row. */
  clearSealedPayload(id: string): boolean;
}

const COLUMNS =
  "id, invite_id, state, attempts, created_at, claimed_at, settled_at, transport, " +
  "provider_message_id, error";

/** The one place a row of `invite_deliveries` becomes an `InviteDelivery`. */
function map(row: SqlRow): InviteDelivery {
  return {
    id: readText(row, "id"),
    inviteId: readText(row, "invite_id"),
    state: readText(row, "state") as DeliveryState,
    attempts: readNumber(row, "attempts"),
    createdAt: readText(row, "created_at"),
    claimedAt: readOptionalText(row, "claimed_at"),
    settledAt: readOptionalText(row, "settled_at"),
    transport: readOptionalText(row, "transport") as InviteDelivery["transport"],
    providerMessageId: readOptionalText(row, "provider_message_id"),
    error: readOptionalText(row, "error"),
  };
}

/** Bind the `invite_deliveries` repository to one connection. */
export function createDeliveriesRepo(db: DatabaseSync): DeliveriesRepo {
  const sql: Prepare = statements(db);

  const reclaim = (leaseMs: number, now: string): number => {
    const cutoff = nowIso(Date.parse(now) - leaseMs);
    const result = sql(
      "UPDATE invite_deliveries SET state = 'pending', claimed_at = NULL " +
        "WHERE state = 'sending' AND (claimed_at IS NULL OR claimed_at <= ?)"
    ).run(cutoff);
    return changeCount(result);
  };

  return {
    insert(input) {
      const delivery: InviteDelivery = {
        id: input.id,
        inviteId: input.inviteId,
        state: "pending",
        attempts: 0,
        createdAt: input.createdAt ?? nowIso(),
      };
      sql(
        `INSERT INTO invite_deliveries (${COLUMNS}, sealed_payload) ` +
          "VALUES (?, ?, 'pending', 0, ?, NULL, NULL, NULL, NULL, NULL, ?)"
      ).run(delivery.id, delivery.inviteId, delivery.createdAt, input.sealedPayload ?? null);
      return delivery;
    },

    get(id) {
      const row = sql(`SELECT ${COLUMNS} FROM invite_deliveries WHERE id = ?`).get(id);
      return row ? map(row) : null;
    },

    listByInvite(inviteId) {
      return sql(
        `SELECT ${COLUMNS} FROM invite_deliveries WHERE invite_id = ? ORDER BY created_at, id`
      )
        .all(inviteId)
        .map(map);
    },

    claimPending(leaseMs, opts = {}) {
      const now = opts.now ?? nowIso();
      reclaim(leaseMs, now);
      // RETURNING makes the claim and the read one statement, so no other
      // writer can slip between marking a row `sending` and learning which
      // rows this call owns.
      const limit = Math.max(1, Math.trunc(opts.limit ?? 100));
      const rows = sql(
        "UPDATE invite_deliveries SET state = 'sending', claimed_at = ?, attempts = attempts + 1 " +
          "WHERE id IN (SELECT id FROM invite_deliveries WHERE state = 'pending' ORDER BY created_at, id LIMIT ?) " +
          `RETURNING ${COLUMNS}, sealed_payload`
      ).all(now, limit);
      return rows.map((row) => ({ delivery: map(row), sealedPayload: readBytes(row, "sealed_payload") }));
    },

    claim(id, leaseMs, now = nowIso()) {
      const staleBefore = nowIso(Date.parse(now) - leaseMs);
      // One statement with RETURNING, so no other worker can slip between
      // marking the row `sending` and learning that this call owns it.
      const rows = sql(
        "UPDATE invite_deliveries SET state = 'sending', claimed_at = ?, attempts = attempts + 1 " +
          "WHERE id = ? AND (state IN ('pending','failed') " +
          "OR (state = 'sending' AND (claimed_at IS NULL OR claimed_at <= ?))) " +
          `RETURNING ${COLUMNS}, sealed_payload`
      ).all(now, id, staleBefore);
      if (rows.length === 1)
        return {
          kind: "claimed",
          delivery: map(rows[0]),
          sealedPayload: readBytes(rows[0], "sealed_payload"),
        };
      const existing = sql("SELECT state FROM invite_deliveries WHERE id = ?").get(id);
      if (!existing) return { kind: "missing" };
      return readText(existing, "state") === "sent" ? { kind: "sent" } : { kind: "busy" };
    },

    settle(id, state, fields = {}) {
      const now = fields.now ?? nowIso();
      const result = sql(
        "UPDATE invite_deliveries SET state = ?, settled_at = ?, claimed_at = NULL, " +
          "transport = COALESCE(?, transport), provider_message_id = COALESCE(?, provider_message_id), error = ? " +
          "WHERE id = ? AND state = 'sending'"
      ).run(
        state,
        now,
        writeOptional(fields.transport),
        writeOptional(fields.providerMessageId),
        writeOptional(fields.error),
        id
      );
      return changeCount(result) === 1;
    },

    settlePending(id, outcome) {
      const result = sql(
        "UPDATE invite_deliveries SET state = 'failed', settled_at = ?, claimed_at = NULL, " +
          "transport = ?, error = ? WHERE id = ? AND state = 'pending'"
      ).run(
        outcome.now ?? nowIso(),
        outcome.transport ?? null,
        outcome.error.slice(0, 2000),
        id
      );
      return changeCount(result) === 1;
    },

    reclaimStale(leaseMs, now = nowIso()) {
      return reclaim(leaseMs, now);
    },

    clearSealedPayload(id) {
      const result = sql("UPDATE invite_deliveries SET sealed_payload = NULL WHERE id = ?").run(id);
      return changeCount(result) === 1;
    },
  };
}
