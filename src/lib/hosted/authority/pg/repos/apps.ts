/**
 * `hosted.apps` — the Postgres twin of `authority/repos/apps.ts`.
 *
 * Two things about this table are database facts rather than code paths, and
 * both survive the translation unchanged:
 *
 *  - **The active-release pointer is fenced.** `setActiveRelease` is one
 *    conditional UPDATE on `active_fence`, so a worker that has been asleep for
 *    ten minutes and still holds the old token gets `false` rather than
 *    repointing a live hostname at a release that was superseded while it was
 *    gone. Never a read-then-write: the compare and the swap are the same
 *    statement, which is the only version of this that is safe under two
 *    workers.
 *  - **`active_release_id` references `hosted.releases(id)`, which references
 *    `hosted.apps(id)` back.** Postgres resolves a REFERENCES clause at create
 *    time, so the migration adds that constraint after both tables exist —
 *    nothing here has to know, because an app is always inserted with a null
 *    pointer and only ever points at a release that already committed.
 *
 * `active_fence` is `bigint` and arrives as a decimal string; `readNumber` in
 * `../rows.ts` is what turns it back into the `number` `HostedApp` types it as.
 */
import type { AppState, HostedApp, RuntimeId } from "@/lib/hosted/contracts";
import { nowIso } from "../../sql";
import type { AppsRepo } from "../../repos";
import type { Sql, TransactionSql } from "../client";
import {
  changeCount,
  readNullableText,
  readNumber,
  readOptionalText,
  readText,
  writeOptional,
  type PgRow,
} from "../rows";

/** The one place a row of `apps` becomes a `HostedApp`. */
function map(row: PgRow): HostedApp {
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

/** Bind the `apps` repository to one connection or transaction. */
export function createPgAppsRepo(sql: Sql | TransactionSql): AppsRepo {
  const byId = async (id: string): Promise<HostedApp | null> => {
    const rows = (await sql`
      select * from hosted.apps where id = ${id}
    `) as unknown as PgRow[];
    return rows.length === 1 ? map(rows[0]) : null;
  };

  return {
    async insert(input) {
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
      await sql`
        insert into hosted.apps
          (id, workspace_id, slug, name, contract_version, schema_version, state, state_reason,
           created_by, created_at, updated_at, active_release_id, active_fence, runtime)
        values
          (${app.id}, ${app.workspaceId}, ${app.slug}, ${app.name}, 1, 1, ${app.state},
           ${writeOptional(app.stateReason)}, ${app.createdBy}, ${app.createdAt}, ${app.updatedAt},
           null, 0, ${app.runtime})
      `;
      return app;
    },

    get: byId,

    async getBySlug(slug) {
      const rows = (await sql`
        select * from hosted.apps where slug = ${slug}
      `) as unknown as PgRow[];
      return rows.length === 1 ? map(rows[0]) : null;
    },

    // Ordered by slug within a timestamp, not by id: two apps created in the
    // same millisecond would otherwise come back in the order of their random
    // UUIDs, which is a list that reshuffles itself for no reason a reader can
    // see. The slug is unique, so this is a total order.
    async listByWorkspace(workspaceId) {
      const rows = (await sql`
        select * from hosted.apps where workspace_id = ${workspaceId} order by created_at, slug
      `) as unknown as PgRow[];
      return rows.map(map);
    },

    async listAll() {
      const rows = (await sql`
        select * from hosted.apps order by created_at, slug
      `) as unknown as PgRow[];
      return rows.map(map);
    },

    async update(id, patch, now = nowIso()) {
      // A patch with nothing in it is a read, not a write — the SQLite
      // repository returns the row without touching `updated_at`, and a caller
      // that cannot tell the two apart must not see a stamp move here either.
      if (
        patch.name === undefined &&
        patch.state === undefined &&
        patch.stateReason === undefined &&
        patch.runtime === undefined
      )
        return byId(id);
      // One statement, and the column list is this file's rather than the
      // caller's: an absent field coalesces to what is already stored, and
      // `stateReason` is the one field whose explicit `null` means "clear it",
      // which is why it is a CASE on presence rather than a COALESCE.
      const rows = (await sql`
        update hosted.apps set
          name = coalesce(${writeOptional(patch.name)}::text, name),
          state = coalesce(${writeOptional(patch.state)}::text, state),
          state_reason = case
            when ${patch.stateReason !== undefined}::boolean then ${writeOptional(patch.stateReason)}::text
            else state_reason
          end,
          runtime = coalesce(${writeOptional(patch.runtime)}::text, runtime),
          updated_at = ${now}
        where id = ${id}
        returning *
      `) as unknown as PgRow[];
      return rows.length === 1 ? map(rows[0]) : null;
    },

    async setActiveRelease(appId, releaseId, expectedFence, now = nowIso()) {
      const result = await sql`
        update hosted.apps set
          active_release_id = ${releaseId},
          active_fence = active_fence + 1,
          updated_at = ${now}
        where id = ${appId} and active_fence = ${expectedFence}
      `;
      return changeCount(result) === 1;
    },
  };
}
