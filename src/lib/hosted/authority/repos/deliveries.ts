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

/** What a settled delivery records. */
export interface DeliverySettlement {
  transport?: "smtp" | "log" | "none";
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
  /** Record the terminal outcome of a claimed row. */
  settle(id: string, state: Extract<DeliveryState, "sent" | "failed">, fields?: DeliverySettlement): boolean;
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

    reclaimStale(leaseMs, now = nowIso()) {
      return reclaim(leaseMs, now);
    },

    clearSealedPayload(id) {
      const result = sql("UPDATE invite_deliveries SET sealed_payload = NULL WHERE id = ?").run(id);
      return changeCount(result) === 1;
    },
  };
}
