/**
 * `apps` — the hosted application record and its durable active-release
 * pointer.
 *
 * The pointer is the reason this table needs a fence: activation is the one
 * moment a worker that has been asleep for ten minutes can still do damage, by
 * pointing a live hostname at a release that was superseded while it was gone.
 * `setActiveRelease` is therefore a compare-and-swap on `active_fence`, and a
 * worker holding a stale token gets `false` rather than a silent overwrite.
 *
 * Workstream W1 (hosted R3).
 */
import type { DatabaseSync } from "node:sqlite";
import type { AppState, HostedApp, RuntimeId, Subject } from "@/lib/hosted/contracts";
import {
  changeCount,
  nowIso,
  readNullableText,
  readNumber,
  readOptionalText,
  readText,
  statements,
  writeOptional,
  type Prepare,
  type SqlRow,
} from "../sql";

/** What the caller supplies to create an app; the rest is fixed by the contract. */
export interface NewApp {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  createdBy: Subject;
  runtime: RuntimeId;
  /** Defaults to `active`. */
  state?: AppState;
  stateReason?: string;
  /** Defaults to now. Supplied by tests and by an import that preserves history. */
  createdAt?: string;
}

/** The fields `update` may change. Anything absent is left alone. */
export interface AppPatch {
  name?: string;
  state?: AppState;
  /** `null` clears the reason; `undefined` leaves it as it is. */
  stateReason?: string | null;
  runtime?: RuntimeId;
}

/** Reads and writes of the `apps` table. Every method is synchronous and transaction-safe. */
export interface AppsRepo {
  insert(input: NewApp): HostedApp;
  get(id: string): HostedApp | null;
  getBySlug(slug: string): HostedApp | null;
  listByWorkspace(workspaceId: string): HostedApp[];
  /** Every app in the install, oldest first — the pilot-wide views need it. */
  listAll(): HostedApp[];
  /** Returns the updated record, or null when no app has that id. */
  update(id: string, patch: AppPatch, now?: string): HostedApp | null;
  /**
   * Compare-and-swap the active release pointer. True when `expectedFence`
   * still matched and the pointer moved (the fence is now `expectedFence + 1`);
   * false when another activation got there first, and nothing was written.
   */
  setActiveRelease(appId: string, releaseId: string, expectedFence: number, now?: string): boolean;
}

const COLUMNS =
  "id, workspace_id, slug, name, contract_version, schema_version, state, state_reason, " +
  "created_by, created_at, updated_at, active_release_id, active_fence, runtime";

/** The one place a row of `apps` becomes a `HostedApp`. */
function map(row: SqlRow): HostedApp {
  return {
    id: readText(row, "id"),
    workspaceId: readText(row, "workspace_id"),
    slug: readText(row, "slug"),
    name: readText(row, "name"),
    contractVersion: 1,
    schemaVersion: 1,
    state: readText(row, "state") as AppState,
    stateReason: readOptionalText(row, "state_reason"),
    createdBy: readText(row, "created_by"),
    createdAt: readText(row, "created_at"),
    updatedAt: readText(row, "updated_at"),
    activeReleaseId: readNullableText(row, "active_release_id"),
    activeFence: readNumber(row, "active_fence"),
    runtime: readText(row, "runtime") as RuntimeId,
  };
}

/** Bind the `apps` repository to one connection. */
export function createAppsRepo(db: DatabaseSync): AppsRepo {
  const sql: Prepare = statements(db);

  const byId = (id: string): HostedApp | null => {
    const row = sql(`SELECT ${COLUMNS} FROM apps WHERE id = ?`).get(id);
    return row ? map(row) : null;
  };

  return {
    insert(input) {
      const at = input.createdAt ?? nowIso();
      const app: HostedApp = {
        id: input.id,
        workspaceId: input.workspaceId,
        slug: input.slug,
        name: input.name,
        contractVersion: 1,
        schemaVersion: 1,
        state: input.state ?? "active",
        stateReason: input.stateReason,
        createdBy: input.createdBy,
        createdAt: at,
        updatedAt: at,
        activeReleaseId: null,
        activeFence: 0,
        runtime: input.runtime,
      };
      sql(
        `INSERT INTO apps (${COLUMNS}) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, NULL, 0, ?)`
      ).run(
        app.id,
        app.workspaceId,
        app.slug,
        app.name,
        app.state,
        writeOptional(app.stateReason),
        app.createdBy,
        app.createdAt,
        app.updatedAt,
        app.runtime
      );
      return app;
    },

    get: byId,

    getBySlug(slug) {
      const row = sql(`SELECT ${COLUMNS} FROM apps WHERE slug = ?`).get(slug);
      return row ? map(row) : null;
    },

    // Ordered by slug within a timestamp, not by id: two apps created in the
    // same millisecond would otherwise come back in the order of their random
    // UUIDs, which is a list that reshuffles itself for no reason a reader can
    // see. The slug is unique, so this is a total order.
    listByWorkspace(workspaceId) {
      return sql(`SELECT ${COLUMNS} FROM apps WHERE workspace_id = ? ORDER BY created_at, slug`)
        .all(workspaceId)
        .map(map);
    },

    listAll() {
      return sql(`SELECT ${COLUMNS} FROM apps ORDER BY created_at, slug`).all().map(map);
    },

    update(id, patch, now = nowIso()) {
      // Column names come from this fixed map, never from the caller; only
      // values are ever bound.
      const sets: string[] = [];
      const values: (string | null)[] = [];
      if (patch.name !== undefined) {
        sets.push("name = ?");
        values.push(patch.name);
      }
      if (patch.state !== undefined) {
        sets.push("state = ?");
        values.push(patch.state);
      }
      if (patch.stateReason !== undefined) {
        sets.push("state_reason = ?");
        values.push(patch.stateReason);
      }
      if (patch.runtime !== undefined) {
        sets.push("runtime = ?");
        values.push(patch.runtime);
      }
      if (sets.length === 0) return byId(id);
      sets.push("updated_at = ?");
      values.push(now, id);
      sql(`UPDATE apps SET ${sets.join(", ")} WHERE id = ?`).run(...values);
      return byId(id);
    },

    setActiveRelease(appId, releaseId, expectedFence, now = nowIso()) {
      const result = sql(
        "UPDATE apps SET active_release_id = ?, active_fence = active_fence + 1, updated_at = ? " +
          "WHERE id = ? AND active_fence = ?"
      ).run(releaseId, now, appId, expectedFence);
      return changeCount(result) === 1;
    },
  };
}
