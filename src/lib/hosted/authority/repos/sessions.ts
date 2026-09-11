/**
 * `app_sessions` — the opaque per-app browser session, keyed by the hash of
 * the cookie value.
 *
 * The cookie value itself is never stored, so a leaked database cannot be
 * replayed as a session. Termination is a state change, never a delete: the
 * gateway has to be able to tell "this session was ended" from "this session
 * never existed", and a purge that removed rows would turn the first into the
 * second.
 *
 * The bulk terminators are what make R3-10 and G13 true. Signing out of the
 * platform terminates by subject, revoking a grant terminates by grant, and
 * suspending an app terminates by app — each one statement, so the count they
 * return is the count that actually committed.
 */
import type { DatabaseSync } from "node:sqlite";
import type { AppSession, Subject } from "@/lib/hosted/contracts";
import {
  changeCount,
  nowIso,
  readOptionalText,
  readText,
  statements,
  type Prepare,
  type SqlRow,
} from "../sql";

/** Why a session ended. Mirrors `AppSession["terminatedReason"]`. */
export type TerminationReason = NonNullable<AppSession["terminatedReason"]>;

/** What the caller supplies to open a session. */
export interface NewSession {
  /** SHA-256 hex of the opaque cookie value. 64 characters, enforced by the schema. */
  id: string;
  appId: string;
  subject: Subject;
  grantId: string;
  expiresAt: string;
  createdAt?: string;
}

/** Reads and writes of the `app_sessions` table. */
export interface SessionsRepo {
  insert(input: NewSession): AppSession;
  /** Look a session up by the hash of the presented cookie. */
  get(idHash: string): AppSession | null;
  listByApp(appId: string, opts?: { liveOnly?: boolean; now?: string }): AppSession[];
  terminate(id: string, reason: TerminationReason, now?: string): boolean;
  /** Every live session this person holds, on every app. Returns how many ended. */
  terminateBySubject(subject: Subject, reason: TerminationReason, now?: string): number;
  /** Every live session that hangs off one grant. Call in the revoke transaction. */
  terminateByGrant(grantId: string, reason: TerminationReason, now?: string): number;
  terminateByApp(appId: string, reason: TerminationReason, now?: string): number;
  /**
   * Delete sessions whose `expires_at` has passed. Housekeeping, not
   * admission — an expired session is already refused, whether or not the row
   * is still there.
   *
   * This is the one deletion in this repository, and it is not an exception to
   * "termination is a state change": a session that ran out of time carries no
   * finding worth keeping, because `expires_at` in the past already said what
   * happened to it. A session that was *terminated* — signed out, revoked,
   * ended by an operator — keeps its row and its reason until its own expiry
   * passes. Returns how many rows were removed.
   */
  purgeExpired(now?: string): number;
}

const COLUMNS =
  "id, app_id, subject, grant_id, created_at, expires_at, terminated_at, terminated_reason";

/** The one place a row of `app_sessions` becomes an `AppSession`. */
function map(row: SqlRow): AppSession {
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

/** Bind the `app_sessions` repository to one connection. */
export function createSessionsRepo(db: DatabaseSync): SessionsRepo {
  const sql: Prepare = statements(db);

  const terminateWhere = (
    column: "subject" | "grant_id" | "app_id",
    value: string,
    reason: TerminationReason,
    now: string
  ): number => {
    const result = sql(
      "UPDATE app_sessions SET terminated_at = ?, terminated_reason = ? " +
        `WHERE ${column} = ? AND terminated_at IS NULL`
    ).run(now, reason, value);
    return changeCount(result);
  };

  return {
    insert(input) {
      const session: AppSession = {
        id: input.id,
        appId: input.appId,
        subject: input.subject,
        grantId: input.grantId,
        createdAt: input.createdAt ?? nowIso(),
        expiresAt: input.expiresAt,
      };
      sql(`INSERT INTO app_sessions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`).run(
        session.id,
        session.appId,
        session.subject,
        session.grantId,
        session.createdAt,
        session.expiresAt
      );
      return session;
    },

    get(idHash) {
      const row = sql(`SELECT ${COLUMNS} FROM app_sessions WHERE id = ?`).get(idHash);
      return row ? map(row) : null;
    },

    listByApp(appId, opts = {}) {
      if (!opts.liveOnly)
        return sql(`SELECT ${COLUMNS} FROM app_sessions WHERE app_id = ? ORDER BY created_at DESC, id`)
          .all(appId)
          .map(map);
      return sql(
        `SELECT ${COLUMNS} FROM app_sessions WHERE app_id = ? AND terminated_at IS NULL AND expires_at > ? ` +
          "ORDER BY created_at DESC, id"
      )
        .all(appId, opts.now ?? nowIso())
        .map(map);
    },

    terminate(id, reason, now = nowIso()) {
      const result = sql(
        "UPDATE app_sessions SET terminated_at = ?, terminated_reason = ? " +
          "WHERE id = ? AND terminated_at IS NULL"
      ).run(now, reason, id);
      return changeCount(result) === 1;
    },

    terminateBySubject(subject, reason, now = nowIso()) {
      return terminateWhere("subject", subject, reason, now);
    },

    terminateByGrant(grantId, reason, now = nowIso()) {
      return terminateWhere("grant_id", grantId, reason, now);
    },

    terminateByApp(appId, reason, now = nowIso()) {
      return terminateWhere("app_id", appId, reason, now);
    },

    purgeExpired(now = nowIso()) {
      const result = sql("DELETE FROM app_sessions WHERE expires_at <= ?").run(now);
      return changeCount(result);
    },
  };
}
