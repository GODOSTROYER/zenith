/**
 * `hosted_events` — the durable analytics envelope, deduped by logical
 * operation.
 *
 * Every retry in this system is designed to be safe, which means the same
 * logical operation can be attempted more than once. A metric that counted
 * attempts instead of operations would report growth that never happened, so
 * `(event, logical_id)` is unique and `append` answers whether this call was
 * the one that recorded it. Rows with no logical id are never deduped — SQL
 * NULL is not equal to itself, so they simply do not enter the index.
 *
 * The subject is stored only as `subject_hash` (W8 computes the HMAC under
 * `ZENITH_EVENTS_SALT`); nothing here holds an id or an email, and `props` is
 * for counts, codes and durations rather than content.
 *
 * PLAN-R3 R3-13: the event vocabulary is provisional — `HOSTED_EVENTS` in the
 * contracts is marked as such pending the page-36 list — so the column carries
 * no CHECK constraint. `HostedEventName` still narrows it in TypeScript.
 */
import type { DatabaseSync } from "node:sqlite";
import type { ActorClass, HostedEvent, HostedEventName } from "@/lib/hosted/contracts";
import {
  changeCount,
  nowIso,
  readBoolean,
  readNumber,
  readOptionalJson,
  readOptionalText,
  readText,
  statements,
  writeBoolean,
  writeOptional,
  writeOptionalJson,
  type Prepare,
  type SqlRow,
} from "../sql";

/** What the caller supplies to record an event. */
export interface NewHostedEvent {
  id: string;
  event: HostedEventName;
  workspaceId: string;
  appId?: string;
  /** HMAC of the subject. Never an id, never an email. */
  subjectHash?: string;
  releaseId?: string;
  outcome: HostedEvent["outcome"];
  /** Dedupe handle for one logical operation (a write id, a job id). */
  logicalId?: string;
  assisted: boolean;
  actorClass: ActorClass;
  props?: Record<string, string | number | boolean>;
  ts?: string;
}

/** Which slice of the event log to read or count. */
export interface EventQuery {
  /** Inclusive ISO lower bound. */
  since?: string;
  workspaceId?: string;
  appId?: string;
  event?: HostedEventName;
}

/** Reads and writes of the `hosted_events` table. */
export interface EventsRepo {
  /**
   * Record an event. `inserted` is false when an event with the same
   * `(event, logicalId)` was already recorded — the retry case — and `event`
   * is then the row that already existed.
   */
  append(input: NewHostedEvent): { event: HostedEvent; inserted: boolean };
  /** Events in the slice, oldest first. */
  listSince(query?: EventQuery, opts?: { limit?: number }): HostedEvent[];
  /** How many events the slice holds. */
  count(query?: EventQuery): number;
}

const COLUMNS =
  "id, event, ts, workspace_id, app_id, subject_hash, release_id, outcome, logical_id, " +
  "assisted, actor_class, props";

/** The one place a row of `hosted_events` becomes a `HostedEvent`. */
function map(row: SqlRow): HostedEvent {
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

/** The shared `WHERE` of the list and the count, so they can never disagree. */
function where(query: EventQuery = {}): { clause: string; values: string[] } {
  const values: string[] = [];
  const parts: string[] = [];
  if (query.since !== undefined) {
    parts.push("ts >= ?");
    values.push(query.since);
  }
  if (query.workspaceId !== undefined) {
    parts.push("workspace_id = ?");
    values.push(query.workspaceId);
  }
  if (query.appId !== undefined) {
    parts.push("app_id = ?");
    values.push(query.appId);
  }
  if (query.event !== undefined) {
    parts.push("event = ?");
    values.push(query.event);
  }
  return { clause: parts.length ? ` WHERE ${parts.join(" AND ")}` : "", values };
}

/** Bind the `hosted_events` repository to one connection. */
export function createEventsRepo(db: DatabaseSync): EventsRepo {
  const sql: Prepare = statements(db);

  return {
    append(input) {
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
      const result = sql(
        `INSERT OR IGNORE INTO hosted_events (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        event.id,
        event.event,
        event.ts,
        event.workspaceId,
        writeOptional(event.appId),
        writeOptional(event.subjectHash),
        writeOptional(event.releaseId),
        event.outcome,
        writeOptional(event.logicalId),
        writeBoolean(event.assisted),
        event.actorClass,
        writeOptionalJson(event.props)
      );
      if (changeCount(result) === 1) return { event, inserted: true };
      const existing = sql(
        `SELECT ${COLUMNS} FROM hosted_events WHERE event = ? AND logical_id = ?`
      ).get(event.event, writeOptional(event.logicalId));
      return { event: existing ? map(existing) : event, inserted: false };
    },

    listSince(query, opts = {}) {
      const { clause, values } = where(query);
      const limit = Math.max(1, Math.trunc(opts.limit ?? 500));
      return sql(`SELECT ${COLUMNS} FROM hosted_events${clause} ORDER BY ts, id LIMIT ?`)
        .all(...values, limit)
        .map(map);
    },

    count(query) {
      const { clause, values } = where(query);
      const row = sql(`SELECT COUNT(*) AS total FROM hosted_events${clause}`).get(...values);
      return row ? readNumber(row, "total") : 0;
    },
  };
}
