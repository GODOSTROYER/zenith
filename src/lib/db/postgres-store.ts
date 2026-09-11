/**
 * The Postgres-backed `Store`: Supabase (PostgREST) under the same synchronous
 * façade every caller already uses.
 *
 * ## Why it can be synchronous at all
 *
 * `Store` is a synchronous interface (see `./types.ts` — the "sync now, async
 * later" note) and ~113 files depend on that. A network round trip cannot be
 * made synchronous, so this implementation does not try: it reads a
 * **snapshot** that was loaded *before* the caller ran, hands the caller the
 * live mutable graph exactly as the file store does, and writes the diff back
 * on `flush`. The load happens in one of two places:
 *
 *  - **per request** — `route()` (src/lib/server/request.ts) prefetches the
 *    caller's workspace slice into `RequestState.snapshot` before the handler
 *    runs, so one request sees one consistent view and two concurrent requests
 *    never share a graph;
 *  - **per process** — a script, a seed, a test or a server component outside a
 *    request gets a process-global snapshot on `globalThis`, loaded lazily on
 *    the first `db()` that finds no request scope.
 *
 * ## Writes: row-level optimistic concurrency
 *
 * Every table carries `version bigint`. A flush compares the snapshot against
 * the baseline captured at load, writes only the rows that actually changed,
 * and guards each update with `.eq("version", loadedVersion)`. Zero rows
 * updated means somebody else moved that row first, and that is a **409**, not
 * a silent overwrite — the last-writer-wins alternative is how two admins
 * editing a member list quietly lose one of the edits.
 *
 * ## Change feed
 *
 * `onChange` cannot be an in-process EventEmitter once more than one instance
 * serves the app. Each flush bumps `workspace_versions` for the workspaces it
 * touched and records which projects moved; `onChange` polls that one narrow
 * table at the SSE tick (300 ms), at most once per window per workspace, and
 * only while a listener is attached.
 *
 * ## HYBRID BOUNDARY — Phase 3 debt
 *
 * Phase 2 moves the *organisational* slice only:
 *
 *     workspaces · members · invites · connections · projects · environments
 *     settings   · workspace_versions
 *
 * …and it holds none of that knowledge itself: each of those collections is an
 * adapter in `./pg/registry.ts` (registered by `./pg/core.ts`), and everything
 * here iterates the registry.
 *
 * Everything else — revisions and their manifests, deployments, deployment
 * events, the audit log, findings, navigator runs, alert rules/events/outbox,
 * secrets — still goes to `FileStore`, unchanged, through the delegate groups
 * in `./pg/delegates.ts` (`setDelegate("audit", …)` replaces one without
 * touching this file). The tables for them exist (supabase/migrations/0001_system_of_record.sql)
 * and are empty. That is deliberate: it makes `ZENITH_STORE=postgres` usable end
 * to end today instead of after the whole store lands, and it is real debt —
 * a serverless instance still keeps that half in its own `/tmp`. Phase 3 closes
 * it. Tracked in docs/MODULE-MAP.md and docs/ARCHITECTURE.md (ADR 1).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuditEvent, DeploymentEvent, Manifest } from "@/lib/domain/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { FileStore } from "./file-store";
import "./pg/core"; // registers the Phase-2 collections
import { delegates } from "./pg/delegates";
import {
  adapterFor,
  adapters,
  INSTALL_SETTINGS_ID,
  keyScope,
  type CollectionAdapter,
  type PgCollection,
  type PgRow as Row,
  type PrefetchContext,
  rowAdapters,
  runPrefetch,
  setTenant,
  storeError,
  tenantOf,
} from "./pg/registry";
import { requestSnapshot } from "./request-snapshot";
import type {
  AuditCountResult,
  AuditFilter,
  AuditPage,
  Database,
  Store,
  StoreChange,
} from "./types";

/* ------------------------------- the client ------------------------------- */

type GClient = typeof globalThis & { __zenithPgClient?: SupabaseClient };

/**
 * One service-role client per process. `createAdminClient()` already builds
 * exactly the right thing (service-role key, no session persistence, no token
 * refresh) and already owns the "you forgot the keys" error, so this reuses it
 * rather than restating either.
 */
export function pgClient(): SupabaseClient {
  const g = globalThis as GClient;
  if (g.__zenithPgClient) return g.__zenithPgClient;
  // Built on first use, never at import: the file store is the default and must
  // keep booting on an install with no Supabase configuration at all.
  return (g.__zenithPgClient = createAdminClient() as unknown as SupabaseClient);
}

/** Test seam: drop the cached client so a mock can take its place. */
export function resetPgClient(client?: SupabaseClient): void {
  (globalThis as GClient).__zenithPgClient = client;
}

/* ------------------------------ the row shape ------------------------------ */

/**
 * Every per-collection fact — table, promoted columns, key, tenant, hydration
 * and prefetch round — now lives in `./pg/registry.ts`, registered by
 * `./pg/core.ts`. This file iterates that registry and knows nothing about any
 * particular table. Re-exported here because the migration script and the
 * contract tests import them from the store.
 */
export { INSTALL_SETTINGS_ID, tenantOf };
export type { PgCollection };

/* -------------------------------- snapshots -------------------------------- */

interface Baseline {
  version: number;
  /** canonical JSON at load, so the flush writes only what actually moved */
  json: string;
}

export interface Snapshot {
  data: Database;
  /** `collection:id` → what the database held when this snapshot loaded */
  baseline: Map<string, Baseline>;
  /** collections a `save()` has touched since the last flush */
  dirty: Set<PgCollection | "settings">;
  /** the workspaces this snapshot is authoritative for (deletes are scoped here) */
  scope: Set<string>;
  /** `workspace_versions.version` at load, so a bump does not need a re-read */
  feed: Map<string, number>;
  /** version of the install-global settings row at load */
  settingsVersion: number;
  /** projects named by `save(projectId)` since the last flush */
  touched: { ids: Set<string>; all: boolean };
  /** true once `save()` has scheduled a write nobody has flushed yet */
  scheduled: boolean;
}

const canonical = (row: unknown): string => JSON.stringify(row);

const bkey = (collection: string, id: string, workspaceId = ""): string =>
  `${collection}:${workspaceId}:${id}`;

const emptySnapshot = (data: Database): Snapshot => ({
  data,
  baseline: new Map(),
  dirty: new Set(),
  scope: new Set(),
  feed: new Map(),
  settingsVersion: 0,
  touched: { ids: new Set(), all: false },
  scheduled: false,
});

/* --------------------------------- loading -------------------------------- */

async function selectRows(
  client: SupabaseClient,
  table: string,
  filter?: { column: string; values: string[] }
): Promise<Row[]> {
  let query = client.from(table).select("*");
  if (filter) {
    if (filter.values.length === 0) return [];
    query = query.in(filter.column, filter.values);
  }
  const { data, error } = await query;
  if (error) throw storeError(table, "read", error.message);
  return (data ?? []) as Row[];
}

/**
 * Load one workspace slice.
 *
 * Order is the point, and the registry declares it: round 1 answers "which
 * workspaces is this caller in" (by id **or** by the email an invite named
 * before they first signed in — the same rule `workspacesFor` applies), round 2
 * fetches everything keyed by those ids, round 3 everything keyed by what round
 * 2 loaded. `null` for `user` loads everything, which is what a script, a
 * migration or a test wants.
 */
export async function loadSnapshot(
  client: SupabaseClient,
  user: { id: string; email: string } | null
): Promise<Snapshot> {
  const base = FileStore.db();
  const snap = emptySnapshot(base);

  const ctx: PrefetchContext = { client, user, workspaceIds: [], projectIds: [] };
  const rows = new Map<PgCollection, Row[]>();
  for (const round of [1, 2, 3] as const) {
    const group = adapters().filter((a) => a.prefetch.round === round);
    const results = await Promise.all(group.map((a) => runPrefetch(a, ctx)));
    group.forEach((a, i) => {
      rows.set(a.collection, results[i]);
      // Rounds feed each other: members hand on the workspace ids, projects the
      // project ids. Nothing else in this loop knows a collection by name.
      a.prefetch.provides?.(results[i], ctx);
    });
  }

  const feedRows = await selectRows(
    client,
    "workspace_versions",
    user ? { column: "workspace_id", values: ctx.workspaceIds } : undefined
  );

  // Settings first: `invites` live inside the bag (see the invites adapter), so
  // the array they are adopted into has to exist before the adopt loop runs.
  const settingsRow = (rows.get("settings") ?? [])[0];
  snap.settingsVersion = Number(settingsRow?.version ?? 0);
  const settings = { ...((settingsRow?.data ?? {}) as Record<string, unknown>) };
  settings.invites = [];
  base.settings = settings;
  snap.baseline.set(
    bkey("settings", INSTALL_SETTINGS_ID),
    { version: snap.settingsVersion, json: canonical(withoutInvites(settings)) }
  );

  for (const adapter of rowAdapters())
    adopt(snap, adapter, rows.get(adapter.collection) ?? [], adapter.rows!(base));

  for (const id of ctx.workspaceIds) snap.scope.add(id);
  for (const r of rows.get("workspaces") ?? []) snap.scope.add(String(r.id));
  for (const r of feedRows) snap.feed.set(String(r.workspace_id), Number(r.version ?? 0));

  return snap;
}

const withoutInvites = (settings: Record<string, unknown>): Record<string, unknown> => {
  const { invites: _invites, ...rest } = settings;
  return rest;
};

/** Hydrate rows into the live array the callers mutate, and record the baseline. */
function adopt(
  snap: Snapshot,
  adapter: CollectionAdapter<never>,
  rows: Row[],
  target: { id: string }[]
): void {
  target.length = 0;
  for (const row of rows) {
    const obj = adapter.hydrate(row) as { id: string };
    const workspaceId = adapter.tenant(obj as never, { row });
    setTenant(obj, workspaceId);
    target.push(obj);
    snap.baseline.set(bkey(adapter.collection, obj.id, keyScope(adapter.collection, workspaceId)), {
      version: Number(row.version ?? 1),
      json: canonical(obj),
    });
  }
}

/* ------------------------------- the snapshot ------------------------------ */

type GSnap = typeof globalThis & { __zenithPgSnapshot?: Snapshot };

/**
 * The snapshot a caller with no request scope gets: one per process, loaded on
 * first use. Scripts, the seed, tests and server components outside `route()`
 * land here; a request never does, because `route()` put one in `RequestState`.
 */
function processSnapshot(): Snapshot {
  const g = globalThis as GSnap;
  if (g.__zenithPgSnapshot) return g.__zenithPgSnapshot;
  // Nothing has loaded yet and `db()` cannot await. Hand back an empty snapshot
  // over the file store's graph rather than lying about what is in Postgres —
  // `primeProcessSnapshot()` is the supported way in, and both the scripts and
  // the contract tests call it.
  return (g.__zenithPgSnapshot = emptySnapshot(FileStore.db()));
}

/** Load the process-global snapshot from Postgres. Awaited by scripts and tests. */
export async function primeProcessSnapshot(
  user: { id: string; email: string } | null = null
): Promise<Snapshot> {
  const snap = await loadSnapshot(pgClient(), user);
  (globalThis as GSnap).__zenithPgSnapshot = snap;
  return snap;
}

/** Drop the process-global snapshot (tests, and `reset()`). */
export const clearProcessSnapshot = (): void => {
  delete (globalThis as GSnap).__zenithPgSnapshot;
};

/**
 * The snapshot this call should read: the request's, when there is one.
 *
 * `route()` put it on `./request-snapshot`'s AsyncLocalStorage (and on
 * `RequestState.snapshot`, which is the same object) before the handler ran.
 * Outside a request — a script, the seed, a test — the process-global one is
 * the right and only answer.
 */
export function currentSnapshot(): Snapshot {
  return (requestSnapshot() as Snapshot | undefined) ?? processSnapshot();
}

/* --------------------------------- writing -------------------------------- */

/** Rows of one collection that moved since the snapshot loaded. */
interface Change {
  collection: PgCollection;
  row: { id: string };
  workspaceId: string;
  baseline?: Baseline;
}

function diff(snap: Snapshot): { writes: Change[]; deletes: Change[] } {
  const writes: Change[] = [];
  const seen = new Set<string>();

  for (const adapter of rowAdapters()) {
    const collection = adapter.collection;
    for (const row of adapter.rows!(snap.data)) {
      const workspaceId = adapter.tenant(row as never, { db: snap.data });
      const key = bkey(collection, row.id, keyScope(collection, workspaceId));
      seen.add(key);
      const baseline = snap.baseline.get(key);
      if (baseline && baseline.json === canonical(row)) continue;
      writes.push({ collection, row, workspaceId, baseline });
    }
  }

  // Anything the snapshot loaded and no longer holds was deleted by this
  // caller. Scoped to what this snapshot actually loaded, so a request that
  // only ever saw one workspace can never delete another one's rows.
  const deletes: Change[] = [];
  for (const [key, baseline] of snap.baseline) {
    if (seen.has(key) || key.startsWith("settings:")) continue;
    const [collection, workspaceId, ...rest] = key.split(":");
    deletes.push({
      collection: collection as PgCollection,
      row: { id: rest.join(":") },
      workspaceId,
      baseline,
    });
  }
  return { writes, deletes };
}

/** A 409 the caller can act on, rather than a silently lost edit. */
async function conflict(): Promise<never> {
  const { ApiError } = await import("@/lib/server/errors");
  throw new ApiError("Someone else changed this workspace; reload and retry", 409, {
    fix: "Reload the page so you are editing the current version, then make the change again.",
  });
}

async function writeRow(client: SupabaseClient, change: Change): Promise<void> {
  const spec = adapterFor(change.collection);
  const row = change.row as never;
  const promoted = spec.promote(row);
  const data = stripPromoted(change.row, change.collection);
  const now = new Date().toISOString();

  if (!change.baseline) {
    const { error } = await client.from(spec.table).insert({
      id: change.row.id,
      workspace_id: change.workspaceId,
      ...promoted,
      data,
      version: 1,
      updated_at: now,
    });
    if (error) throw storeError(spec.table, "insert into", error.message);
    return;
  }

  let query = client
    .from(spec.table)
    .update({ ...promoted, data, version: change.baseline.version + 1, updated_at: now })
    .eq("version", change.baseline.version);
  for (const [column, value] of Object.entries(
    spec.key({ id: change.row.id, workspaceId: change.workspaceId })
  ))
    query = query.eq(column, value);
  const { data: updated, error } = await query.select("id");
  if (error) throw storeError(spec.table, "update", error.message);
  if (!updated || updated.length === 0) await conflict();
}

async function deleteRow(client: SupabaseClient, change: Change): Promise<void> {
  const spec = adapterFor(change.collection);
  let query = client.from(spec.table).delete();
  for (const [column, value] of Object.entries(
    spec.key({ id: change.row.id, workspaceId: change.workspaceId })
  ))
    query = query.eq(column, value);
  const { error } = await query;
  if (error) throw storeError(spec.table, "delete from", error.message);
}

/**
 * One domain object as the row that stores it. Exported for the migration
 * script, so the bulk import and the request path cannot encode a row two
 * different ways.
 */
export function toRow(
  collection: PgCollection,
  row: { id: string },
  workspaceId: string
): Record<string, unknown> {
  const spec = adapterFor(collection);
  return {
    id: row.id,
    workspace_id: workspaceId,
    ...spec.promote(row as never),
    data: stripPromoted(row, collection),
    version: 1,
    updated_at: new Date().toISOString(),
  };
}

/** The table one collection writes to. */
export const tableOf = (collection: PgCollection): string => adapterFor(collection).table;

/** Everything that is not a promoted column, so `data` never duplicates one. */
function stripPromoted(row: { id: string }, collection: PgCollection): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  delete out.id;
  for (const field of Object.values(adapterFor(collection).rename)) delete out[field];
  return out;
}

async function writeSettings(client: SupabaseClient, snap: Snapshot): Promise<void> {
  const data = withoutInvites(snap.data.settings);
  const baseline = snap.baseline.get(bkey("settings", INSTALL_SETTINGS_ID));
  if (baseline && baseline.json === canonical(data)) return;
  const next = (baseline?.version ?? 0) + 1;
  const { error } = await client.from("settings").upsert(
    {
      workspace_id: INSTALL_SETTINGS_ID,
      data,
      version: next,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id" }
  );
  if (error) throw storeError("settings", "write", error.message);
  snap.settingsVersion = next;
  snap.baseline.set(bkey("settings", INSTALL_SETTINGS_ID), { version: next, json: canonical(data) });
}

/**
 * Bump the change feed for every workspace this flush touched.
 *
 * Deliberately *not* guarded on `version`: this table is a notification, not a
 * record. A lost bump would only mean one listener polls a beat later; a 409
 * here would mean a successful write reported failure.
 */
async function bumpFeed(client: SupabaseClient, snap: Snapshot, ids: Set<string>): Promise<void> {
  if (ids.size === 0) return;
  const projects = snap.touched.all ? [] : [...snap.touched.ids];
  const now = new Date().toISOString();
  const rows = [...ids].map((workspace_id) => {
    const next = (snap.feed.get(workspace_id) ?? 0) + 1;
    snap.feed.set(workspace_id, next);
    return { workspace_id, version: next, touched_projects: projects, updated_at: now };
  });
  const { error } = await client
    .from("workspace_versions")
    .upsert(rows, { onConflict: "workspace_id" });
  if (error) throw storeError("workspace_versions", "write", error.message);
}

/** Write every pending change in one pass, then re-baseline the snapshot. */
async function flushSnapshot(snap: Snapshot): Promise<void> {
  const client = pgClient();
  const { writes, deletes } = diff(snap);
  const touchedWorkspaces = new Set<string>();

  // FK order: a workspace before its members, a project before its
  // environments — which is registration order, by the registry's contract.
  const ORDER = rowAdapters().map((a) => a.collection);
  for (const collection of ORDER)
    for (const change of writes.filter((c) => c.collection === collection)) {
      await writeRow(client, change);
      touchedWorkspaces.add(change.workspaceId);
    }
  // Deletes run in reverse, for the same reason.
  for (const collection of [...ORDER].reverse())
    for (const change of deletes.filter((c) => c.collection === collection)) {
      await deleteRow(client, change);
      touchedWorkspaces.add(change.workspaceId);
    }

  await writeSettings(client, snap);
  await bumpFeed(client, snap, touchedWorkspaces);

  rebaseline(snap);
  snap.dirty.clear();
  snap.touched.ids.clear();
  snap.touched.all = false;
  snap.scheduled = false;
}

/** After a successful flush the snapshot *is* the database. Say so. */
function rebaseline(snap: Snapshot): void {
  const next = new Map<string, Baseline>();
  for (const adapter of rowAdapters())
    for (const row of adapter.rows!(snap.data)) {
      const workspaceId = adapter.tenant(row as never, { db: snap.data });
      const key = bkey(adapter.collection, row.id, keyScope(adapter.collection, workspaceId));
      const previous = snap.baseline.get(key);
      next.set(key, {
        version: previous ? previous.version + (previous.json === canonical(row) ? 0 : 1) : 1,
        json: canonical(row),
      });
      snap.scope.add(workspaceId);
    }
  const settings = snap.baseline.get(bkey("settings", INSTALL_SETTINGS_ID));
  if (settings) next.set(bkey("settings", INSTALL_SETTINGS_ID), settings);
  snap.baseline = next;
}

/* ------------------------------ change events ------------------------------ */

/** The SSE tick. Polling faster than the consumer reads buys nothing. */
const POLL_MS = 300;

type GFeed = typeof globalThis & {
  __zenithPgListeners?: Set<(c: StoreChange) => void>;
  __zenithPgPoll?: ReturnType<typeof setInterval>;
  __zenithPgSeen?: Map<string, number>;
};

const listeners = (): Set<(c: StoreChange) => void> =>
  ((globalThis as GFeed).__zenithPgListeners ??= new Set());

const seenVersions = (): Map<string, number> =>
  ((globalThis as GFeed).__zenithPgSeen ??= new Map());

async function pollFeed(): Promise<void> {
  const ids = [...currentSnapshot().scope];
  if (ids.length === 0 || listeners().size === 0) return;
  const { data, error } = await pgClient()
    .from("workspace_versions")
    .select("workspace_id,version,touched_projects")
    .in("workspace_id", ids);
  if (error) return; // a transient feed failure must not take the stream down
  const seen = seenVersions();
  const projectIds = new Set<string>();
  let moved = false;
  for (const row of (data ?? []) as Row[]) {
    const id = String(row.workspace_id);
    const version = Number(row.version ?? 0);
    const before = seen.get(id);
    seen.set(id, version);
    if (before === undefined || version <= before) continue;
    moved = true;
    for (const p of (row.touched_projects as string[] | null) ?? []) projectIds.add(p);
  }
  if (!moved) return;
  const change: StoreChange = { projectIds: [...projectIds] };
  for (const fn of listeners()) fn(change);
}

/**
 * Subscribe to write notifications. Returns an unsubscribe function.
 *
 * One poller per process, not per listener: a hundred open streams must cost
 * one query per tick, not a hundred. It starts with the first listener and is
 * cleared with the last, so an idle process makes no queries at all.
 */
function onChange(fn: (c: StoreChange) => void): () => void {
  const g = globalThis as GFeed;
  // Local writes still announce themselves synchronously through the file
  // store's emitter, so an in-process save reaches its own SSE stream without
  // waiting a poll for the round trip to come back.
  const offLocal = FileStore.onChange(fn);
  listeners().add(fn);
  if (!g.__zenithPgPoll) {
    g.__zenithPgPoll = setInterval(() => void pollFeed(), POLL_MS);
    (g.__zenithPgPoll as { unref?: () => void }).unref?.();
  }
  return () => {
    offLocal();
    listeners().delete(fn);
    if (listeners().size === 0 && g.__zenithPgPoll) {
      clearInterval(g.__zenithPgPoll);
      g.__zenithPgPoll = undefined;
    }
  };
}

/* ------------------------------ the interface ------------------------------ */

/** Every registered collection, settings included; the rest is `FileStore`. */
const ALL = (): PgCollection[] => adapters().map((a) => a.collection);

type GPending = typeof globalThis & { __zenithPgPending?: Promise<void> };

function schedule(snap: Snapshot): Promise<void> {
  const g = globalThis as GPending;
  const run = (g.__zenithPgPending ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => flushSnapshot(snap));
  g.__zenithPgPending = run.catch(() => undefined);
  return run;
}

/**
 * Wait for every write this process has started. `route()` awaits this before
 * answering a mutating request — on every host, not only serverless: a write
 * that has not reached Postgres when the response leaves is a write the very
 * next request can fail to read, and that has nothing to do with freezing.
 */
export async function flushPostgres(): Promise<boolean> {
  const snap = currentSnapshot();
  const had = snap.scheduled || snap.dirty.size > 0;
  const pending = (globalThis as GPending).__zenithPgPending;
  if (had) await schedule(snap);
  else if (pending) await pending;
  return had;
}

export const PostgresStore: Store & {
  flushAsync: () => Promise<boolean>;
} = {
  db(): Database {
    return currentSnapshot().data;
  },

  save(projectId?: string): void {
    const snap = currentSnapshot();
    if (projectId) snap.touched.ids.add(projectId);
    else snap.touched.all = true;
    for (const c of ALL()) snap.dirty.add(c);
    snap.scheduled = true;
    // The Phase-3 half of the graph lives in the file store, and its own
    // coalescer is what persists it. Dropping this would lose every deployment.
    FileStore.save(projectId);
    void schedule(snap).catch(() => undefined);
  },

  flush(): void {
    FileStore.flush();
    void flushPostgres().catch(() => undefined);
  },

  /**
   * Synchronous by contract, so it can only report and start the write.
   * `flushAsync()` is the one that waits, and `route()` calls that.
   */
  flushPending(): boolean {
    const snap = currentSnapshot();
    const had = snap.scheduled || snap.dirty.size > 0;
    FileStore.flushPending();
    if (had) {
      // Claim the work now: the write is in flight from this moment, so a
      // second call before it lands has nothing new to report. `diff()` reads
      // the snapshot against its baseline, not this set, so nothing is lost.
      snap.scheduled = false;
      snap.dirty.clear();
      void schedule(snap).catch(() => undefined);
    }
    return had;
  },

  flushAsync(): Promise<boolean> {
    FileStore.flushPending();
    return flushPostgres();
  },

  /**
   * Reset is scoped to what this snapshot loaded, never a global truncate:
   * `reset()` is a test and seed affordance, and a store pointed at a real
   * project must not be one call away from emptying it.
   */
  reset(data?: Partial<Database>): Database {
    const snap = currentSnapshot();
    const base = FileStore.reset(data);
    snap.data = base;
    snap.data.settings.invites ??= [];
    snap.dirty = new Set(ALL());
    snap.touched = { ids: new Set(), all: true };
    snap.scheduled = true;
    void schedule(snap).catch(() => undefined);
    return snap.data;
  },

  /* ---- Phase 3 debt: delegated, file store by default (./pg/delegates) ---- */
  appendEvent: (e: DeploymentEvent) => delegates.events.appendEvent(e),
  readEvents: (deploymentId: string, afterSeq?: number) =>
    delegates.events.readEvents(deploymentId, afterSeq),
  appendAudit: (e: AuditEvent) => delegates.audit.appendAudit(e),
  readAuditPage: (filter?: AuditFilter): AuditPage => delegates.audit.readAuditPage(filter),
  readAudit: (filter?: AuditFilter): AuditEvent[] => delegates.audit.readAudit(filter),
  countAudit: (filter?: AuditFilter): AuditCountResult => delegates.audit.countAudit(filter),
  revisionManifest: (id: string): Manifest | undefined => delegates.manifests.revisionManifest(id),

  onChange,
  changed: (c: StoreChange, projectId: string): boolean =>
    c.projectIds.length === 0 || c.projectIds.includes(projectId),
};
