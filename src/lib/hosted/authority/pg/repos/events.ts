/**
 * `hosted.hosted_events` — the Postgres twin of `authority/repos/events.ts`.
 *
 * Every retry in this system is designed to be safe, which means the same
 * logical operation can be attempted more than once. A metric that counted
 * attempts instead of operations would report growth that never happened, so
 * the partial unique index `hosted_events_logical on (event, logical_id) where
 * logical_id is not null` is what makes the count truthful, and `append`
 * answers whether *this* call was the one that recorded the event.
 *
 * Two translations carry the behaviour across:
 *
 *  - **`INSERT OR IGNORE` is `on conflict do nothing`, with no conflict
 *    target.** SQLite's form absorbs *any* uniqueness violation — the primary
 *    key on `id` as well as the logical index — and a targeted
 *    `on conflict (event, logical_id)` would not. The untargeted form absorbs
 *    both, which is what keeps a duplicate id answering `inserted: false`
 *    instead of throwing on one store and not the other.
 *  - **Rows with no logical id are never deduped**, on either store, because
 *    SQL NULL is not equal to itself: they do not enter the index, and the
 *    lookup `logical_id = null` that follows a non-insert finds nothing — so a
 *    caller that re-used an id with no logical id gets its own event back with
 *    `inserted: false`, word for word what SQLite answers.
 *
 * The subject is stored only as `subject_hash`; nothing here holds an id or an
 * email. `assisted` is a real `boolean` in Postgres where SQLite stored 0/1
 * under a CHECK, and `props` is a `text` column holding JSON on both.
 */
import type { ActorClass, HostedEvent, HostedEventName } from "@/lib/hosted/contracts";
import { nowIso } from "../../sql";
import type { EventsRepo } from "../../repos";
import type { EventQuery } from "../../repos/events";
import type { Sql, TransactionSql } from "../client";
import {
  changeCount,
  readBoolean,
  readNumber,
  readOptionalJson,
  readOptionalText,
  readText,
  writeBoolean,
  writeOptional,
  writeOptionalJson,
  type PgRow,
} from "../rows";

/** The one place a row of `hosted_events` becomes a `HostedEvent`. */
function map(row: PgRow): HostedEvent {
  return {
    id: readText(row, "id"),
    event: readText(row, "event") as HostedEventName,
    ts: readText(row, "ts"),
    workspaceId: readText(row, "workspace_id"),
    appId: readOptionalText(row, "app_id"),
    subjectHash: readOptionalText(row, "subject_hash"),
    releaseId: readOptionalText(row, "release_id"),
    outcome: readText(row, "outcome") as HostedEvent["outcome"],
    logicalId: readOptionalText(row, "logical_id"),
    assisted: readBoolean(row, "assisted"),
    actorClass: readText(row, "actor_class") as ActorClass,
    props: readOptionalJson<Record<string, string | number | boolean>>(row, "props"),
  };
}

/** Bind the `hosted_events` repository to one connection or transaction. */
export function createPgEventsRepo(sql: Sql | TransactionSql): EventsRepo {
  /** The shared `where` of the list and the count, so they can never disagree. */
  const where = (query: EventQuery = {}) => sql`
    where true
    ${query.since === undefined ? sql`` : sql`and ts >= ${query.since}`}
    ${query.workspaceId === undefined ? sql`` : sql`and workspace_id = ${query.workspaceId}`}
    ${query.appId === undefined ? sql`` : sql`and app_id = ${query.appId}`}
    ${query.event === undefined ? sql`` : sql`and event = ${query.event}`}
  `;

  return {
    async append(input) {
      const event: HostedEvent = {
        id: input.id,
        event: input.event,
        ts: input.ts ?? nowIso(),
        workspaceId: input.workspaceId,
        appId: input.appId,
        subjectHash: input.subjectHash,
        releaseId: input.releaseId,
        outcome: input.outcome,
        logicalId: input.logicalId,
        assisted: input.assisted,
        actorClass: input.actorClass,
        props: input.props,
      };
      const result = await sql`
        insert into hosted.hosted_events
          (id, event, ts, workspace_id, app_id, subject_hash, release_id, outcome, logical_id,
           assisted, actor_class, props)
        values
          (${event.id}, ${event.event}, ${event.ts}, ${event.workspaceId}, ${writeOptional(event.appId)},
           ${writeOptional(event.subjectHash)}, ${writeOptional(event.releaseId)}, ${event.outcome},
           ${writeOptional(event.logicalId)}, ${writeBoolean(event.assisted)}, ${event.actorClass},
           ${writeOptionalJson(event.props)})
        on conflict do nothing
      `;
      if (changeCount(result) === 1) return { event, inserted: true };
      // The row that already holds this logical operation. With no logical id
      // there is nothing to match — NULL is not equal to itself — so the caller
      // gets its own event back, which is exactly what SQLite answers.
      const rows = (await sql`
        select id, event, ts, workspace_id, app_id, subject_hash, release_id, outcome, logical_id,
               assisted, actor_class, props
        from hosted.hosted_events
        where event = ${event.event} and logical_id = ${writeOptional(event.logicalId)}
      `) as unknown as PgRow[];
      return { event: rows.length === 1 ? map(rows[0]) : event, inserted: false };
    },

    async listSince(query, opts = {}) {
      const limit = Math.max(1, Math.trunc(opts.limit ?? 500));
      const rows = (await sql`
        select id, event, ts, workspace_id, app_id, subject_hash, release_id, outcome, logical_id,
               assisted, actor_class, props
        from hosted.hosted_events
        ${where(query)}
        order by ts, id
        limit ${limit}
      `) as unknown as PgRow[];
      return rows.map(map);
    },

    async count(query) {
      const rows = (await sql`
        select count(*) as total from hosted.hosted_events ${where(query)}
      `) as unknown as PgRow[];
      return rows.length === 1 ? readNumber(rows[0], "total") : 0;
    },
  };
}
