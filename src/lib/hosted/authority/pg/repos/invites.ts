/**
 * `hosted.app_invites` — the Postgres twin of `authority/repos/invites.ts`.
 *
 * Single use is the conditional UPDATE in `accept` — `state = 'pending' and
 * expires_at > now` — on both stores. Two tabs redeeming the same invitation at
 * the same instant produce one changed row and one `false`, and the row count
 * is the answer, so nothing here reads before it writes.
 *
 * The expiry boundary is strict on both stores: an invitation whose
 * `expires_at` equals the instant of acceptance is not accepted.
 *
 * `token_hash` is UNIQUE in the schema; a second insert with the same hash is
 * refused by the database and the driver error propagates, exactly as the
 * SQLite repository lets its own propagate. Neither store translates it: the
 * token is minted by the caller from 32 random bytes and a collision is a bug
 * upstream, not a state a route answers for.
 */
import type { AppInvite, AppRole, InviteState } from "@/lib/hosted/contracts";
import { nowIso } from "../../sql";
import type { InvitesRepo } from "../../repos";
import type { Sql, TransactionSql } from "../client";
import { changeCount, readOptionalText, readText, writeOptional, type PgRow } from "../rows";

/** The one place a row of `app_invites` becomes an `AppInvite`. */
function map(row: PgRow): AppInvite {
  return {
    id: readText(row, "id"),
    appId: readText(row, "app_id"),
    email: readText(row, "email"),
    role: readText(row, "role") as AppRole,
    tokenHash: readText(row, "token_hash"),
    state: readText(row, "state") as InviteState,
    createdBy: readText(row, "created_by"),
    createdAt: readText(row, "created_at"),
    expiresAt: readText(row, "expires_at"),
    acceptedAt: readOptionalText(row, "accepted_at"),
    acceptedBy: readOptionalText(row, "accepted_by"),
    supersedes: readOptionalText(row, "supersedes"),
  };
}

/** Bind the `app_invites` repository to one connection or transaction. */
export function createPgInvitesRepo(sql: Sql | TransactionSql): InvitesRepo {
  return {
    async insert(input) {
      const invite: AppInvite = {
        id: input.id,
        appId: input.appId,
        email: input.email,
        role: input.role,
        tokenHash: input.tokenHash,
        state: "pending",
        createdBy: input.createdBy,
        createdAt: input.createdAt ?? nowIso(),
        expiresAt: input.expiresAt,
        supersedes: input.supersedes,
      };
      await sql`
        insert into hosted.app_invites
          (id, app_id, email, role, token_hash, state, created_by, created_at, expires_at,
           accepted_at, accepted_by, supersedes)
        values
          (${invite.id}, ${invite.appId}, ${invite.email}, ${invite.role}, ${invite.tokenHash},
           'pending', ${invite.createdBy}, ${invite.createdAt}, ${invite.expiresAt},
           null, null, ${writeOptional(invite.supersedes)})
      `;
      return invite;
    },

    async get(id) {
      const rows = (await sql`
        select * from hosted.app_invites where id = ${id}
      `) as unknown as PgRow[];
      return rows.length === 1 ? map(rows[0]) : null;
    },

    async getByTokenHash(tokenHash) {
      const rows = (await sql`
        select * from hosted.app_invites where token_hash = ${tokenHash}
      `) as unknown as PgRow[];
      return rows.length === 1 ? map(rows[0]) : null;
    },

    async listByApp(appId, opts = {}) {
      const rows = (await sql`
        select * from hosted.app_invites
        where app_id = ${appId}
        ${opts.state ? sql`and state = ${opts.state}` : sql``}
        order by created_at desc, id
      `) as unknown as PgRow[];
      return rows.map(map);
    },

    async setState(id, state) {
      const result = await sql`
        update hosted.app_invites set state = ${state}
        where id = ${id} and state = 'pending'
      `;
      return changeCount(result) === 1;
    },

    async accept(id, subject, now) {
      const result = await sql`
        update hosted.app_invites set
          state = 'accepted',
          accepted_at = ${now},
          accepted_by = ${subject}
        where id = ${id} and state = 'pending' and expires_at > ${now}
      `;
      return changeCount(result) === 1;
    },

    async supersede(id) {
      const result = await sql`
        update hosted.app_invites set state = 'superseded'
        where id = ${id} and state = 'pending'
      `;
      return changeCount(result) === 1;
    },
  };
}
