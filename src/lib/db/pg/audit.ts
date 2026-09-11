/**
 * Phase 3 package: audit. Registers its collections with the store registry and
 * replaces its delegate group; nothing here runs until the module is imported
 * from src/lib/db/pg/all.ts, which happens once at store selection.
 *
 * ## What moved
 *
 * The audit log is `public.audit_events` — one row per event, `seq bigserial`
 * as the order and the cursor, a unique index on `id` so a retried append is a
 * no-op rather than a duplicate. Everything the file store answered by walking
 * `<ZENITH_DATA>/audit.jsonl` backwards is a query here:
 *
 *   | file store                        | this                                  |
 *   |-----------------------------------|---------------------------------------|
 *   | append a JSON line                | insert, ignoring a duplicate `id`     |
 *   | read the tail, filter in JS       | `where … order by seq desc limit $n`  |
 *   | byte offset of the next line      | the `seq` of the last row returned    |
 *   | count the newest 4 MB (`exact:false` past it) | `count=exact`, always `exact: true` |
 *
 * **The cursor stays opaque and stays a string.** The file store's was a byte
 * offset; this one is a `seq`. Nothing outside the store has ever been allowed
 * to interpret it — the route passes `?cursor=` straight back in — so the
 * encoding changes and no caller does. A cursor minted by one store and handed
 * to the other is nonsense, which is true of any opaque cursor and is why
 * switching `ZENITH_STORE` invalidates open pages, not rows.
 *
 * ## Scope
 *
 * Every read is fenced to `Snapshot.scope` — the workspaces the request's
 * prefetch actually loaded for this caller. A filter that names a workspace
 * outside that set returns nothing rather than that workspace's rows: the audit
 * log is the one table where a missing tenant clause leaks the whole install.
 *
 * ## Synchronicity
 *
 * `AuditDelegate` is synchronous because `Store` is, and every call here
 * depends on arguments no prefetch ever sees — a filter, a cursor, one event —
 * so there is nothing to load in advance. Both reads and the append therefore
 * block on `./sync-rest`, which explains that mechanism at length.
 *
 * This group is installed unconditionally, not behind a `ZENITH_STORE` check:
 * `delegates.audit` is reachable only through `PostgresStore`, and anything
 * holding `PostgresStore` — the store selector, the contract suite's factory —
 * has already said which store it means.
 */
import type { AuditEvent } from "@/lib/domain/types";
import { currentSnapshot } from "../postgres-store";
import type { AuditCountResult, AuditFilter, AuditPage } from "../types";
import { setDelegate, type AuditDelegate } from "./delegates";
import { eq, inList, restSync } from "./sync-rest";

const TABLE = "audit_events";

/* --------------------------------- mapping --------------------------------- */

/** Everything that is not a promoted column, exactly as the registry does it. */
interface AuditData {
  actor?: AuditEvent["actor"];
  input?: unknown;
  summary?: string;
  error?: string;
}

function toRow(e: AuditEvent): Record<string, unknown> {
  const data: AuditData = { actor: e.actor, input: e.input, summary: e.summary };
  if (e.error !== undefined) data.error = e.error;
  return {
    id: e.id,
    workspace_id: e.workspaceId,
    ts: e.ts,
    // null, never the empty string: the column is the filter, and `eq.''` is a
    // value a row could really hold.
    project_id: e.projectId ?? null,
    environment_id: e.environmentId ?? null,
    actor_type: e.actor?.type ?? null,
    action_id: e.actionId,
    result: e.result,
    data,
  };
}

/**
 * One row as the event the file store would have handed back — same fields,
 * same optionality. A null promoted column means "absent", never `field: null`,
 * because the domain type uses optional properties and a null would serialise
 * into a response body the file store never produces.
 */
function fromRow(row: Record<string, unknown>): AuditEvent {
  const data = (row.data ?? {}) as AuditData;
  const out: AuditEvent = {
    // `timestamptz` comes back in Postgres' own format; the log's contract is
    // an ISO string, and the activity screen sorts on it as text.
    ts: new Date(String(row.ts)).toISOString(),
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    actor: data.actor ?? {
      type: (row.actor_type as AuditEvent["actor"]["type"]) ?? "system",
      id: "",
      name: "",
    },
    actionId: String(row.action_id),
    input: data.input,
    result: row.result as AuditEvent["result"],
    summary: data.summary ?? "",
  };
  if (row.project_id != null) out.projectId = String(row.project_id);
  if (row.environment_id != null) out.environmentId = String(row.environment_id);
  if (data.error !== undefined) out.error = data.error;
  return out;
}

/** The page cursor: a row's `seq`, as a string, opaque to every caller. */
const cursorOf = (row: Record<string, unknown>): string => String(row.seq);

/* --------------------------------- filters --------------------------------- */

/**
 * The workspaces this call may read, or `[]` for "none, so do not query".
 *
 * Two fences, and a row has to clear both. `Snapshot.scope` is the tenant one —
 * the workspaces this caller's prefetch was authoritative for. The graph is the
 * liveness one: a workspace the snapshot no longer holds has been deleted (or
 * `reset()` away) by this caller, and its log goes with it. Intersecting them
 * is strictly narrower than either, which is the right direction for the one
 * table where a missing clause leaks the whole install.
 *
 * `undefined` is impossible on purpose: an unfiltered read of the whole table
 * is never the right answer, so an empty scope returns an empty page rather
 * than falling back to everything.
 *
 * TODO(ceiling): the rows themselves outlive the workspace — nothing deletes
 * from `audit_events`, because an append-only log with no retention policy is
 * what the file store is too (`audit.jsonl` is only truncated by `reset()`).
 * They are unreadable through the store from the moment their workspace goes;
 * a retention job is the real answer and belongs with the migration, not here.
 */
function scopeIds(filter: AuditFilter): string[] {
  const snap = currentSnapshot();
  const live = snap.data.workspaces.filter((w) => snap.scope.has(w.id)).map((w) => w.id);
  if (!filter.workspaceId) return live;
  return live.includes(filter.workspaceId) ? [filter.workspaceId] : [];
}

/** `AuditFilter` as PostgREST query parts, tenant clause included. */
function where(filter: AuditFilter, workspaceIds: string[]): string[] {
  const parts = [inList("workspace_id", workspaceIds)];
  if (filter.projectId) parts.push(eq("project_id", filter.projectId));
  if (filter.environmentId) parts.push(eq("environment_id", filter.environmentId));
  if (filter.actorType) parts.push(eq("actor_type", filter.actorType));
  if (filter.result) parts.push(eq("result", filter.result));
  if (filter.from) parts.push(`ts=gte.${encodeURIComponent(filter.from)}`);
  if (filter.to) parts.push(`ts=lte.${encodeURIComponent(filter.to)}`);
  if (filter.actionId)
    parts.push(
      // A trailing dot is a prefix, exactly as `matches()` reads it in the file
      // store. `*` is PostgREST's wildcard for `like`.
      filter.actionId.endsWith(".")
        ? `action_id=like.${encodeURIComponent(`${filter.actionId}*`)}`
        : eq("action_id", filter.actionId)
    );
  return parts;
}

/* -------------------------------- the group -------------------------------- */

/**
 * Append one row.
 *
 * Written before the call returns, not deferred: `appendAudit` is followed by a
 * read often enough — an action appends and the screen that triggered it asks
 * for the page — that a deferred write would show the caller a log missing the
 * thing it just did. It costs one blocking round trip, the same as a read.
 *
 * A failure is reported on the console and never thrown: an audit write that
 * took the caller's action down with it would trade a missing log line for a
 * failed deployment. The file store's append cannot fail this way, so nothing
 * upstream is written to handle it.
 *
 * Idempotent on `id`: the unique index plus `resolution=ignore-duplicates`
 * means a retry (a queue redelivery, a re-run script) writes nothing twice.
 */
function appendAudit(e: AuditEvent): void {
  try {
    restSync({
      method: "POST",
      table: TABLE,
      op: "insert into",
      path: `${TABLE}?on_conflict=id`,
      body: [toRow(e)],
      prefer: "resolution=ignore-duplicates,return=minimal",
    });
  } catch (err) {
    console.error(`Zenith could not write an audit row (${e.actionId}): ${(err as Error).message}`);
  }
}

/** One page, newest first. `nextCursor` is the last row's `seq`. */
function readAuditPage(filter: AuditFilter = {}): AuditPage {
  const workspaceIds = scopeIds(filter);
  if (workspaceIds.length === 0) return { events: [] };

  const want = Math.max(1, filter.limit ?? 500);
  const parts = where(filter, workspaceIds);
  const cursor = filter.cursor === undefined ? undefined : Number(filter.cursor);
  if (cursor !== undefined && Number.isFinite(cursor)) parts.push(`seq=lt.${cursor}`);

  const { rows } = restSync({
    method: "GET",
    table: TABLE,
    op: "read",
    path: `${TABLE}?select=*&${parts.join("&")}&order=seq.desc&limit=${want}`,
  });

  const events = rows.map(fromRow);
  // A short page is the end of the log; a full one may not be, so it carries a
  // cursor. Same rule the file store applies when it fills `want`.
  return rows.length < want
    ? { events }
    : { events, nextCursor: cursorOf(rows[rows.length - 1]) };
}

/** Back-compatible reader: newest first, no cursor. */
const readAudit = (filter: AuditFilter = {}): AuditEvent[] => readAuditPage(filter).events;

/**
 * How many rows match.
 *
 * `exact` is always true here, and that is the one place this store is *better*
 * than the file one: the file store counts the newest 4 MB and reports a floor
 * past that, because counting means reading. Postgres counts, so the screen can
 * say "50 of 214" without the "+" the budget forced.
 */
function countAudit(filter: AuditFilter = {}): AuditCountResult {
  const workspaceIds = scopeIds(filter);
  if (workspaceIds.length === 0) return { total: 0, exact: true };

  const { total } = restSync({
    method: "GET",
    table: TABLE,
    op: "count",
    // `limit=1` because the rows are thrown away — only `Content-Range` matters.
    path: `${TABLE}?select=seq&${where(filter, workspaceIds).join("&")}&limit=1`,
    prefer: "count=exact",
  });
  return { total: total ?? 0, exact: true };
}

export const PostgresAudit: AuditDelegate = {
  appendAudit,
  readAuditPage,
  readAudit,
  countAudit,
};

setDelegate("audit", PostgresAudit);
