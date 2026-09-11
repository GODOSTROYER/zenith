/**
 * `hosted.app_sessions` — the Postgres twin of `authority/repos/sessions.ts`.
 *
 * Termination is a state change, never a delete, on both stores: the gateway
 * has to tell "this session was ended" from "this session never existed". The
 * bulk terminators are each one UPDATE guarded on `terminated_at is null`, so
 * the count they return is the count that committed — the property R3-10 and
 * G13 rest on.
 *
 * `purgeExpired` is the one deletion, and it is housekeeping: a session whose
 * `expires_at` has passed is already refused whether or not its row is there.
 */
import type { AppSession } from "@/lib/hosted/contracts";
import { nowIso } from "../../sql";
import type { SessionsRepo } from "../../repos";
import type { TerminationReason } from "../../repos/sessions";
import type { Sql, TransactionSql } from "../client";
import { changeCount, readOptionalText, readText, type PgRow } from "../rows";

/** The one place a row of `app_sessions` becomes an `AppSession`. */
function map(row: PgRow): AppSession {
  return {
    id: readText(row, "id"),
    appId: readText(row, "app_id"),
    subject: readText(row, "subject"),
    grantId: readText(row, "grant_id"),
    createdAt: readText(row, "created_at"),
    expiresAt: readText(row, "expires_at"),
    terminatedAt: readOptionalText(row, "terminated_at"),
    terminatedReason: readOptionalText(row, "terminated_reason") as AppSession["terminatedReason"],
  };
}

/** Bind the `app_sessions` repository to one connection or transaction. */
export function createPgSessionsRepo(sql: Sql | TransactionSql): SessionsRepo {
  const terminateWhere = async (
    column: "subject" | "grant_id" | "app_id",
    value: string,
    reason: TerminationReason,
    now: string
  ): Promise<number> => {
    const result = await sql`
      update hosted.app_sessions set terminated_at = ${now}, terminated_reason = ${reason}
      where ${sql(column)} = ${value} and terminated_at is null
    `;
    return changeCount(result);
  };

  return {
    async insert(input) {
      const session: AppSession = {
        id: input.id,
        appId: input.appId,
        subject: input.subject,
        grantId: input.grantId,
        createdAt: input.createdAt ?? nowIso(),
        expiresAt: input.expiresAt,
      };
      await sql`
        insert into hosted.app_sessions
          (id, app_id, subject, grant_id, created_at, expires_at, terminated_at, terminated_reason)
        values
          (${session.id}, ${session.appId}, ${session.subject}, ${session.grantId},
           ${session.createdAt}, ${session.expiresAt}, null, null)
      `;
      return session;
    },

    async get(idHash) {
      const rows = (await sql`
        select * from hosted.app_sessions where id = ${idHash}
      `) as unknown as PgRow[];
      return rows.length === 1 ? map(rows[0]) : null;
    },

    async listByApp(appId, opts = {}) {
      const rows = (await sql`
        select * from hosted.app_sessions
        where app_id = ${appId}
        ${opts.liveOnly ? sql`and terminated_at is null and expires_at > ${opts.now ?? nowIso()}` : sql``}
        order by created_at desc, id
      `) as unknown as PgRow[];
      return rows.map(map);
    },

    async appIdsForSubject(subject) {
      const rows = (await sql`
        select distinct app_id from hosted.app_sessions
        where subject = ${subject} and terminated_at is null
        order by app_id
      `) as unknown as PgRow[];
      return rows.map((row) => readText(row, "app_id"));
    },

    async terminate(id, reason, now = nowIso()) {
      const result = await sql`
        update hosted.app_sessions set terminated_at = ${now}, terminated_reason = ${reason}
        where id = ${id} and terminated_at is null
      `;
      return changeCount(result) === 1;
    },

    async terminateBySubject(subject, reason, now = nowIso()) {
      return terminateWhere("subject", subject, reason, now);
    },

    async terminateByGrant(grantId, reason, now = nowIso()) {
      return terminateWhere("grant_id", grantId, reason, now);
    },

    async terminateByApp(appId, reason, now = nowIso()) {
      return terminateWhere("app_id", appId, reason, now);
    },

    async purgeExpired(now = nowIso()) {
      const result = await sql`
        delete from hosted.app_sessions where expires_at <= ${now}
      `;
      return changeCount(result);
    },
  };
}
