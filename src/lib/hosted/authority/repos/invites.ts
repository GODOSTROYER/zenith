/**
 * `app_invites` — the single-use, hashed, expiring invitation to an app.
 *
 * The token itself is never stored: only its SHA-256, so a stolen database
 * cannot be turned back into a working invitation link. `accept` is one
 * conditional UPDATE — `state = 'pending' AND expires_at > ?` — because an
 * invitation that two tabs redeem at the same instant must produce one grant,
 * and a read-then-write would produce two.
 *
 * The expiry boundary is strict: an invitation whose `expires_at` equals the
 * instant of acceptance is *not* accepted. A boundary that admits its own
 * deadline is a boundary that has to be re-argued every time someone reads it.
 */
import type { DatabaseSync } from "node:sqlite";
import type { AppInvite, AppRole, InviteState, Subject } from "@/lib/hosted/contracts";
import {
  changeCount,
  nowIso,
  readOptionalText,
  readText,
  statements,
  writeOptional,
  type Prepare,
  type SqlRow,
} from "../sql";

/** What the caller supplies to create an invitation. */
export interface NewInvite {
  id: string;
  appId: string;
  /** Lowercase; acceptance requires the caller's verified email to equal it. */
  email: string;
  role: AppRole;
  /** SHA-256 hex of the single-use token. 64 characters, enforced by the schema. */
  tokenHash: string;
  createdBy: Subject;
  expiresAt: string;
  /** The invitation this one replaces, when this is a resend. */
  supersedes?: string;
  createdAt?: string;
}

/** Reads and writes of the `app_invites` table. */
export interface InvitesRepo {
  insert(input: NewInvite): AppInvite;
  get(id: string): AppInvite | null;
  /** The redemption lookup. Hash the presented token; never search by email. */
  getByTokenHash(tokenHash: string): AppInvite | null;
  listByApp(appId: string, opts?: { state?: InviteState }): AppInvite[];
  /**
   * Moves an outstanding invitation to a terminal state (`expired`, `revoked`).
   * Not for acceptance — that has its own conditional update.
   */
  setState(id: string, state: Exclude<InviteState, "accepted">): boolean;
  /**
   * Atomic single-use acceptance: true only if this call is the one that moved
   * a `pending`, unexpired invitation to `accepted`. Call inside the same
   * transaction that creates the grant.
   */
  accept(id: string, subject: Subject, now: string): boolean;
  /** Marks an outstanding invitation superseded by a resend. */
  supersede(id: string): boolean;
}

const COLUMNS =
  "id, app_id, email, role, token_hash, state, created_by, created_at, expires_at, " +
  "accepted_at, accepted_by, supersedes";

/** The one place a row of `app_invites` becomes an `AppInvite`. */
function map(row: SqlRow): AppInvite {
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

/** Bind the `app_invites` repository to one connection. */
export function createInvitesRepo(db: DatabaseSync): InvitesRepo {
  const sql: Prepare = statements(db);

  return {
    insert(input) {
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
      sql(
        `INSERT INTO app_invites (${COLUMNS}) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL, NULL, ?)`
      ).run(
        invite.id,
        invite.appId,
        invite.email,
        invite.role,
        invite.tokenHash,
        invite.createdBy,
        invite.createdAt,
        invite.expiresAt,
        writeOptional(invite.supersedes)
      );
      return invite;
    },

    get(id) {
      const row = sql(`SELECT ${COLUMNS} FROM app_invites WHERE id = ?`).get(id);
      return row ? map(row) : null;
    },

    getByTokenHash(tokenHash) {
      const row = sql(`SELECT ${COLUMNS} FROM app_invites WHERE token_hash = ?`).get(tokenHash);
      return row ? map(row) : null;
    },

    listByApp(appId, opts = {}) {
      if (opts.state)
        return sql(
          `SELECT ${COLUMNS} FROM app_invites WHERE app_id = ? AND state = ? ORDER BY created_at DESC, id`
        )
          .all(appId, opts.state)
          .map(map);
      return sql(`SELECT ${COLUMNS} FROM app_invites WHERE app_id = ? ORDER BY created_at DESC, id`)
        .all(appId)
        .map(map);
    },

    setState(id, state) {
      const result = sql(
        "UPDATE app_invites SET state = ? WHERE id = ? AND state = 'pending'"
      ).run(state, id);
      return changeCount(result) === 1;
    },

    accept(id, subject, now) {
      const result = sql(
        "UPDATE app_invites SET state = 'accepted', accepted_at = ?, accepted_by = ? " +
          "WHERE id = ? AND state = 'pending' AND expires_at > ?"
      ).run(now, subject, id, now);
      return changeCount(result) === 1;
    },

    supersede(id) {
      const result = sql(
        "UPDATE app_invites SET state = 'superseded' WHERE id = ? AND state = 'pending'"
      ).run(id);
      return changeCount(result) === 1;
    },
  };
}
