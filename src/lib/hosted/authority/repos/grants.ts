/**
 * `app_grants` — who may open a hosted app, and in what role.
 *
 * This table is the single authority PLAN-R3 R3-02 asks for: no claim, no
 * workspace membership and no cached copy may add or restore a grant. A
 * revoke is therefore a state change here and nowhere else, and the partial
 * unique index on `(app_id, subject) WHERE state = 'active'` is what makes
 * "one live grant per person per app" a property of the database rather than a
 * property of whichever code path happened to run.
 *
 * Revoked rows are kept, not deleted: the history is what a restore reconciles
 * against (`revocations.ts`), and a deleted row cannot prove a person was ever
 * removed.
 *
 * Workstream W1 (hosted R3).
 */
import type { DatabaseSync } from "node:sqlite";
import type { AppGrant, AppRole, GrantState, Subject } from "@/lib/hosted/contracts";
import {
  changeCount,
  nowIso,
  readNumber,
  readOptionalText,
  readText,
  statements,
  type Prepare,
  type SqlRow,
} from "../sql";

/** What the caller supplies to create a grant. */
export interface NewGrant {
  id: string;
  appId: string;
  subject: Subject;
  /** The verified email at grant time, lowercase. Display only, never a key. */
  email: string;
  role: AppRole;
  grantedBy: Subject;
  /** Defaults to `active`. */
  state?: GrantState;
  createdAt?: string;
}

/** Reads and writes of the `app_grants` table. */
export interface GrantsRepo {
  insert(input: NewGrant): AppGrant;
  get(id: string): AppGrant | null;
  /** The one live grant for this person on this app, or null. The admission read. */
  activeFor(appId: string, subject: Subject): AppGrant | null;
  /** Every grant on an app, newest first. Pass `activeOnly` for the live ones. */
  listByApp(appId: string, opts?: { activeOnly?: boolean }): AppGrant[];
  listBySubject(subject: Subject, opts?: { activeOnly?: boolean }): AppGrant[];
  /** Revokes a grant that is not already revoked; returns the row as it now stands. */
  revoke(id: string, by: Subject, reason: string, now?: string): AppGrant | null;
  /** Changes the role of an active grant. False when the grant is missing or not active. */
  setRole(id: string, role: AppRole, now?: string): boolean;
  /**
   * Moves every active grant on these apps to `needs_reapproval` — the state a
   * clean-host restore leaves a grant in when it cannot be confirmed against
   * the off-host revocation ledger. Returns how many rows moved.
   */
  markNeedsReapproval(appIds: readonly string[], now?: string): number;
  /** How many live owners an app has. The last-owner guard reads this. */
  countActiveOwners(appId: string): number;
}

const COLUMNS =
  "id, app_id, subject, email, role, state, granted_by, created_at, updated_at, " +
  "revoked_at, revoked_by, revoked_reason";

/** The one place a row of `app_grants` becomes an `AppGrant`. */
function map(row: SqlRow): AppGrant {
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

/** Bind the `app_grants` repository to one connection. */
export function createGrantsRepo(db: DatabaseSync): GrantsRepo {
  const sql: Prepare = statements(db);

  const byId = (id: string): AppGrant | null => {
    const row = sql(`SELECT ${COLUMNS} FROM app_grants WHERE id = ?`).get(id);
    return row ? map(row) : null;
  };

  return {
    insert(input) {
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
      sql(
        `INSERT INTO app_grants (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`
      ).run(
        grant.id,
        grant.appId,
        grant.subject,
        grant.email,
        grant.role,
        grant.state,
        grant.grantedBy,
        grant.createdAt,
        grant.updatedAt
      );
      return grant;
    },

    get: byId,

    activeFor(appId, subject) {
      const row = sql(
        `SELECT ${COLUMNS} FROM app_grants WHERE app_id = ? AND subject = ? AND state = 'active'`
      ).get(appId, subject);
      return row ? map(row) : null;
    },

    listByApp(appId, opts = {}) {
      const sqlText = opts.activeOnly
        ? `SELECT ${COLUMNS} FROM app_grants WHERE app_id = ? AND state = 'active' ORDER BY created_at DESC, id`
        : `SELECT ${COLUMNS} FROM app_grants WHERE app_id = ? ORDER BY created_at DESC, id`;
      return sql(sqlText).all(appId).map(map);
    },

    listBySubject(subject, opts = {}) {
      const sqlText = opts.activeOnly
        ? `SELECT ${COLUMNS} FROM app_grants WHERE subject = ? AND state = 'active' ORDER BY created_at DESC, id`
        : `SELECT ${COLUMNS} FROM app_grants WHERE subject = ? ORDER BY created_at DESC, id`;
      return sql(sqlText).all(subject).map(map);
    },

    revoke(id, by, reason, now = nowIso()) {
      sql(
        "UPDATE app_grants SET state = 'revoked', revoked_at = ?, revoked_by = ?, revoked_reason = ?, updated_at = ? " +
          "WHERE id = ? AND state <> 'revoked'"
      ).run(now, by, reason, now, id);
      return byId(id);
    },

    setRole(id, role, now = nowIso()) {
      const result = sql(
        "UPDATE app_grants SET role = ?, updated_at = ? WHERE id = ? AND state = 'active'"
      ).run(role, now, id);
      return changeCount(result) === 1;
    },

    markNeedsReapproval(appIds, now = nowIso()) {
      if (appIds.length === 0) return 0;
      const holes = appIds.map(() => "?").join(", ");
      const result = sql(
        `UPDATE app_grants SET state = 'needs_reapproval', updated_at = ? ` +
          `WHERE state = 'active' AND app_id IN (${holes})`
      ).run(now, ...appIds);
      return changeCount(result);
    },

    countActiveOwners(appId) {
      const row = sql(
        "SELECT COUNT(*) AS owners FROM app_grants WHERE app_id = ? AND state = 'active' AND role = 'owner'"
      ).get(appId);
      return row ? readNumber(row, "owners") : 0;
    },
  };
}
