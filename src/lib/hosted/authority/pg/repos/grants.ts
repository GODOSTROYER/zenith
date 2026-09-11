/**
 * `hosted.app_grants` — the Postgres twin of `authority/repos/grants.ts`.
 *
 * The property this table exists to hold is a database fact on both stores: the
 * partial unique index `app_grants_active on (app_id, subject) where state =
 * 'active'` is what makes "one live grant per person per app" true regardless of
 * which code path ran. A second live grant is refused by the index here exactly
 * as it is there, and the raw driver error is allowed to propagate on both
 * sides — the SQLite repository does not translate it either, so translating it
 * here would make the two stores distinguishable.
 *
 * `revoke` is deliberately an UPDATE followed by a read rather than an
 * `update … returning`: the SQLite repository answers with the row *as it now
 * stands*, which for an already-revoked grant is the existing revoked row and
 * not `null`. `returning` would answer `null` there. The UPDATE cannot violate
 * anything — it moves a row *off* `active`, so the partial index is never in
 * play — so the read that follows it is never a read on an aborted transaction.
 */
import type { AppGrant, AppRole, GrantState } from "@/lib/hosted/contracts";
import { nowIso } from "../../sql";
import type { GrantsRepo } from "../../repos";
import type { Sql, TransactionSql } from "../client";
import { changeCount, readNumber, readOptionalText, readText, type PgRow } from "../rows";

/** The one place a row of `app_grants` becomes an `AppGrant`. */
function map(row: PgRow): AppGrant {
  return {
    id: readText(row, "id"),
    appId: readText(row, "app_id"),
    subject: readText(row, "subject"),
    email: readText(row, "email"),
    role: readText(row, "role") as AppRole,
    state: readText(row, "state") as GrantState,
    grantedBy: readText(row, "granted_by"),
    createdAt: readText(row, "created_at"),
    updatedAt: readText(row, "updated_at"),
    revokedAt: readOptionalText(row, "revoked_at"),
    revokedBy: readOptionalText(row, "revoked_by"),
    revokedReason: readOptionalText(row, "revoked_reason"),
  };
}

/** Bind the `app_grants` repository to one connection or transaction. */
export function createPgGrantsRepo(sql: Sql | TransactionSql): GrantsRepo {
  const byId = async (id: string): Promise<AppGrant | null> => {
    const rows = (await sql`
      select * from hosted.app_grants where id = ${id}
    `) as unknown as PgRow[];
    return rows.length === 1 ? map(rows[0]) : null;
  };

  return {
    async insert(input) {
      const at = input.createdAt ?? nowIso();
      const grant: AppGrant = {
        id: input.id,
        appId: input.appId,
        subject: input.subject,
        email: input.email,
        role: input.role,
        state: input.state ?? "active",
        grantedBy: input.grantedBy,
        createdAt: at,
        updatedAt: at,
      };
      await sql`
        insert into hosted.app_grants
          (id, app_id, subject, email, role, state, granted_by, created_at, updated_at,
           revoked_at, revoked_by, revoked_reason)
        values
          (${grant.id}, ${grant.appId}, ${grant.subject}, ${grant.email}, ${grant.role},
           ${grant.state}, ${grant.grantedBy}, ${grant.createdAt}, ${grant.updatedAt},
           null, null, null)
      `;
      return grant;
    },

    get: byId,

    async activeFor(appId, subject) {
      const rows = (await sql`
        select * from hosted.app_grants
        where app_id = ${appId} and subject = ${subject} and state = 'active'
      `) as unknown as PgRow[];
      return rows.length === 1 ? map(rows[0]) : null;
    },

    async listByApp(appId, opts = {}) {
      const rows = (await sql`
        select * from hosted.app_grants
        where app_id = ${appId}
        ${opts.activeOnly ? sql`and state = 'active'` : sql``}
        order by created_at desc, id
      `) as unknown as PgRow[];
      return rows.map(map);
    },

    async listBySubject(subject, opts = {}) {
      const rows = (await sql`
        select * from hosted.app_grants
        where subject = ${subject}
        ${opts.activeOnly ? sql`and state = 'active'` : sql``}
        order by created_at desc, id
      `) as unknown as PgRow[];
      return rows.map(map);
    },

    async revoke(id, by, reason, now = nowIso()) {
      await sql`
        update hosted.app_grants set
          state = 'revoked',
          revoked_at = ${now},
          revoked_by = ${by},
          revoked_reason = ${reason},
          updated_at = ${now}
        where id = ${id} and state <> 'revoked'
      `;
      // The row as it now stands, which for an already-revoked grant is the row
      // that was already there. See the header.
      return byId(id);
    },

    async setRole(id, role, now = nowIso()) {
      const result = await sql`
        update hosted.app_grants set role = ${role}, updated_at = ${now}
        where id = ${id} and state = 'active'
      `;
      return changeCount(result) === 1;
    },

    async markNeedsReapproval(appIds, now = nowIso()) {
      if (appIds.length === 0) return 0;
      const result = await sql`
        update hosted.app_grants set state = 'needs_reapproval', updated_at = ${now}
        where state = 'active' and app_id in ${sql(appIds as readonly string[])}
      `;
      return changeCount(result);
    },

    async countActiveOwners(appId) {
      const rows = (await sql`
        select count(*) as owners from hosted.app_grants
        where app_id = ${appId} and state = 'active' and role = 'owner'
      `) as unknown as PgRow[];
      return rows.length === 1 ? readNumber(rows[0], "owners") : 0;
    },
  };
}
