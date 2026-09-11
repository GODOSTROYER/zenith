/**
 * `hosted.invite_deliveries` — the Postgres twin of `authority/repos/deliveries.ts`.
 *
 * Claim before the effect, settle after, on both stores: a row is durably
 * `sending` before the first byte leaves, and `attempts` moves in the claim so
 * a crash mid-send still counts. `sent` means the transport accepted the
 * message; nothing here ever claims a mailbox received it.
 *
 * Two things are Postgres-specific and neither changes an answer:
 *
 *  - `claimPending` takes its batch with `for update skip locked`. SQLite
 *    serialises writers, so "the oldest hundred pending rows" could never
 *    overlap between two drainers; Postgres does not, and without the lock hint
 *    two drainers would block on each other and then both claim rows the other
 *    already holds.
 *  - `claim`'s fallback read runs after an UPDATE that changed nothing, not
 *    after one that failed — a no-op UPDATE does not abort a transaction, so
 *    the read that classifies `sent` / `busy` / `missing` is safe.
 *
 * `sealed_payload` is `bytea`, which the driver hands back as a `Buffer` — a
 * `Uint8Array`, so `readBytes` needs no conversion and the caller sees the
 * same type it saw on SQLite.
 */
import type { DeliveryState, InviteDelivery } from "@/lib/hosted/contracts";
import { nowIso } from "../../sql";
import type { DeliveriesRepo } from "../../repos";
import type { Sql, TransactionSql } from "../client";
import {
  changeCount,
  readBytes,
  readNumber,
  readOptionalText,
  readText,
  writeOptional,
  type PgRow,
} from "../rows";

/** The one place a row of `invite_deliveries` becomes an `InviteDelivery`. */
function map(row: PgRow): InviteDelivery {
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

/** Bind the `invite_deliveries` repository to one connection or transaction. */
export function createPgDeliveriesRepo(sql: Sql | TransactionSql): DeliveriesRepo {
  const reclaim = async (leaseMs: number, now: string): Promise<number> => {
    const cutoff = nowIso(Date.parse(now) - leaseMs);
    const result = await sql`
      update hosted.invite_deliveries set state = 'pending', claimed_at = null
      where state = 'sending' and (claimed_at is null or claimed_at <= ${cutoff})
    `;
    return changeCount(result);
  };

  return {
    async insert(input) {
      const delivery: InviteDelivery = {
        id: input.id,
        inviteId: input.inviteId,
        state: "pending",
        attempts: 0,
        createdAt: input.createdAt ?? nowIso(),
      };
      await sql`
        insert into hosted.invite_deliveries
          (id, invite_id, state, attempts, created_at, claimed_at, settled_at, transport,
           provider_message_id, error, sealed_payload)
        values
          (${delivery.id}, ${delivery.inviteId}, 'pending', 0, ${delivery.createdAt},
           null, null, null, null, null, ${input.sealedPayload ?? null})
      `;
      return delivery;
    },

    async get(id) {
      const rows = (await sql`
        select * from hosted.invite_deliveries where id = ${id}
      `) as unknown as PgRow[];
      return rows.length === 1 ? map(rows[0]) : null;
    },

    async listByInvite(inviteId) {
      const rows = (await sql`
        select * from hosted.invite_deliveries
        where invite_id = ${inviteId}
        order by created_at, id
      `) as unknown as PgRow[];
      return rows.map(map);
    },

    async claimPending(leaseMs, opts = {}) {
      const now = opts.now ?? nowIso();
      await reclaim(leaseMs, now);
      const limit = Math.max(1, Math.trunc(opts.limit ?? 100));
      // RETURNING makes the claim and the read one statement, so no other
      // writer can slip between marking a row `sending` and learning which
      // rows this call owns.
      const rows = (await sql`
        update hosted.invite_deliveries set
          state = 'sending',
          claimed_at = ${now},
          attempts = attempts + 1
        where id in (
          select id from hosted.invite_deliveries
          where state = 'pending'
          order by created_at, id
          limit ${limit}
          for update skip locked
        )
        returning *
      `) as unknown as PgRow[];
      return rows.map((row) => ({ delivery: map(row), sealedPayload: readBytes(row, "sealed_payload") }));
    },

    async claim(id, leaseMs, now = nowIso()) {
      const staleBefore = nowIso(Date.parse(now) - leaseMs);
      // One statement with RETURNING, so no other worker can slip between
      // marking the row `sending` and learning that this call owns it.
      const rows = (await sql`
        update hosted.invite_deliveries set
          state = 'sending',
          claimed_at = ${now},
          attempts = attempts + 1
        where id = ${id}
          and (state in ('pending', 'failed')
               or (state = 'sending' and (claimed_at is null or claimed_at <= ${staleBefore})))
        returning *
      `) as unknown as PgRow[];
      if (rows.length === 1)
        return {
          kind: "claimed",
          delivery: map(rows[0]),
          sealedPayload: readBytes(rows[0], "sealed_payload"),
        };
      const existing = (await sql`
        select state from hosted.invite_deliveries where id = ${id}
      `) as unknown as PgRow[];
      if (existing.length !== 1) return { kind: "missing" };
      return readText(existing[0], "state") === "sent" ? { kind: "sent" } : { kind: "busy" };
    },

    async settle(id, state, fields = {}) {
      const now = fields.now ?? nowIso();
      const result = await sql`
        update hosted.invite_deliveries set
          state = ${state},
          settled_at = ${now},
          claimed_at = null,
          transport = coalesce(${writeOptional(fields.transport)}, transport),
          provider_message_id = coalesce(${writeOptional(fields.providerMessageId)}, provider_message_id),
          error = ${writeOptional(fields.error)}
        where id = ${id} and state = 'sending'
      `;
      return changeCount(result) === 1;
    },

    async settlePending(id, outcome) {
      const result = await sql`
        update hosted.invite_deliveries set
          state = 'failed',
          settled_at = ${outcome.now ?? nowIso()},
          claimed_at = null,
          transport = ${outcome.transport ?? null},
          error = ${outcome.error.slice(0, 2000)}
        where id = ${id} and state = 'pending'
      `;
      return changeCount(result) === 1;
    },

    async reclaimStale(leaseMs, now = nowIso()) {
      return reclaim(leaseMs, now);
    },

    async clearSealedPayload(id) {
      const result = await sql`
        update hosted.invite_deliveries set sealed_payload = null where id = ${id}
      `;
      return changeCount(result) === 1;
    },
  };
}
