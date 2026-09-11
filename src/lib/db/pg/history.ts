/**
 * Phase 3 package: history — revisions, revision manifests, deployments and
 * the deployment event log, on Postgres.
 *
 * Registers its collections with the store registry and replaces two delegate
 * groups; nothing here runs until the module is imported from
 * `src/lib/db/pg/all.ts`, which happens once at store selection.
 *
 * ## What moves
 *
 *   revisions           → `revisions`           (adapter, round 3 by project)
 *   revision manifests  → `revision_manifests`  (delegate + lazy accessor)
 *   deployments         → `deployments`         (adapter, round 3 by project)
 *   deployment events   → `deployment_events`   (delegate, per-deployment seq)
 *
 * Hydrated objects are the file store's objects. A `Revision` read back here
 * carries the same **non-enumerable** lazy `manifest` accessor that
 * `file-store.ts` attaches (`attachManifest`/`sealManifests`), so
 * `JSON.stringify(db())` still costs metadata only, every existing
 * `revision.manifest` reader still works, and assigning one writes it through.
 * The accessor reads an in-process LRU first and falls back to one blocking
 * `revision_manifests` read (`./sync-rest`) — the same shape as the file
 * store's synchronous `fs.readFileSync` of the side file, for the same reason:
 * the property is synchronous by contract and ~113 files depend on that.
 *
 * ## Ordering and durability
 *
 * Manifest and event writes are queued on the same `__zenithPgPending` chain
 * the store's own coalescer uses (`schedule()` in `../postgres-store.ts`), so
 * `flushPostgres()` — which `route()` awaits after every mutating handler —
 * waits for them too, and a write queued from inside a flush runs after that
 * flush rather than racing it. A revision's manifest row therefore lands in the
 * same flush as the revision, immediately after it:
 * `revision_manifests.revision_id` is a foreign key into `revisions`, so it
 * cannot land first, and `insertManifest` retries a foreign-key violation a
 * bounded number of times for a manifest assigned outside a flush.
 *
 * ## Sequence numbers
 *
 * `deployment_events` is keyed `(deployment_id, seq)` and `seq` is dense per
 * deployment, which is what makes the SSE tail a primary-key range scan. There
 * is no returning-subselect over PostgREST, so the assignment is:
 *
 *   1. take the next number from this process's counter, seeded from whatever
 *      it has already written or read for that deployment;
 *   2. insert;
 *   3. on `23505` — another instance took that number — read `max(seq)` for the
 *      deployment, continue from there and retry, bounded by
 *      `MAX_SEQ_ATTEMPTS`.
 *
 * The database is the authority; the counter is a hint. The number the insert
 * actually got is written back onto the event object, so the in-process tail
 * and the SSE cursor agree with the table. `engine.ts` asks for the number
 * through `nextEventSeq()` instead of minting its own when the store is
 * Postgres — its `__zenithSeq` fast path stays for the file store.
 *
 * ## Reading the log
 *
 *   `readEventsAsync(id, afterSeq)` — one keyed range read on the primary key,
 *   index-only whatever the log has grown to. The deployment SSE route calls
 *   **this** on every 300 ms tick, so a tailing client never blocks the event
 *   loop.
 *
 *   `readEvents(id, afterSeq)` — the synchronous `Store` method. Blocking read
 *   merged with this process's own queued appends, so an append that has not
 *   reached the table yet is still visible to the caller that wrote it.
 *
 * ## For package D (cron routes, the migration script)
 *
 *  - `engineTickAsync()` in `src/lib/engine/engine.ts` is the entry point for a
 *    tick that runs outside a request. Its contract — prime a snapshot first,
 *    one retry on a 409 — is documented there.
 *  - `sealRevisionManifests(db)` moves inline manifests out of the graph before
 *    a bulk write, so `toRow("revisions", …)` never puts one in `data`.
 *  - `flushHistory()` awaits every queued manifest/event write and rethrows the
 *    first failure. A script that exits on its own needs it; a request does
 *    not, because `flushPostgres()` already awaits the same chain.
 */
import type {
  Deployment,
  DeploymentEvent,
  Manifest,
  Revision,
} from "@/lib/domain/types";
import { log } from "@/lib/log";
import { currentSnapshot, pgClient } from "../postgres-store";
import type { Database } from "../types";
import { setDelegate, type EventsDelegate, type ManifestDelegate } from "./delegates";
import {
  hydrateWith,
  iso,
  registerCollection,
  storeError,
  tenantOf,
  type PgRow,
  type PrefetchContext,
  type PrefetchQuery,
  type TenantContext,
} from "./registry";
import { eq, restSync } from "./sync-rest";

/* ------------------------------- the graph -------------------------------- */

/** The live graph this call reads: the request's snapshot, or the process one. */
const graph = (): Database => currentSnapshot().data;

type GGraph = typeof globalThis & { __zenithPgHistoryGraph?: object };

/**
 * The caches below belong to one graph. `reset()` replaces the whole `Database`
 * object — the file store's `resetDb` builds a new one and the Postgres store
 * adopts it — so identity is the cheap, synchronous signal that everything this
 * process remembered about revisions and events is gone. That is what
 * "reset clears state, logs and manifests" in the store contract asserts, and
 * it has to be true before the reset's own flush has run.
 */
function syncGraph(data: Database = graph()): Database {
  const g = globalThis as GGraph;
  if (g.__zenithPgHistoryGraph !== data) {
    g.__zenithPgHistoryGraph = data;
    manifestCache().clear();
    eventTails().clear();
    seqCounters().clear();
  }
  return data;
}

/** The workspace a row hanging off a project is filed under. */
function workspaceOfProject(projectId: string, row: object): string {
  const data = graph();
  return tenantOf(row) || data.projects.find((p) => p.id === projectId)?.workspaceId || "";
}

const workspaceOfRevision = (revisionId: string): string => {
  const revision = graph().revisions.find((r) => r.id === revisionId);
  return revision ? workspaceOfProject(revision.projectId, revision) : "";
};

const workspaceOfDeployment = (deploymentId: string): string => {
  const deployment = graph().deployments.find((d) => d.id === deploymentId);
  return deployment ? workspaceOfProject(deployment.projectId, deployment) : "";
};

/* ------------------------------- write queue ------------------------------- */

type GPending = typeof globalThis & { __zenithPgPending?: Promise<void> };

/**
 * Queue one write on the store's own pending chain.
 *
 * The same `globalThis` key `schedule()` in `../postgres-store.ts` uses, on
 * purpose rather than by accident: `flushPostgres()` awaits that chain, so a
 * caller that waits for the store's writes waits for these too, and a manifest
 * write queued from inside a flush runs after that flush instead of racing the
 * revision row it references.
 */
function enqueue(task: () => Promise<void>): Promise<void> {
  const g = globalThis as GPending;
  const run = (g.__zenithPgPending ?? Promise.resolve()).catch(() => undefined).then(task);
  g.__zenithPgPending = run.catch(() => undefined);
  return run;
}

/** Queued writes nobody has awaited yet, for `flushHistory()`. */
type GTasks = typeof globalThis & { __zenithPgHistoryTasks?: Promise<void>[] };
const tasks = (): Promise<void>[] => ((globalThis as GTasks).__zenithPgHistoryTasks ??= []);

/**
 * Queue a write, log a failure, and remember it so `flushHistory()` can report
 * it. An append is fire-and-forget by contract — the file store's
 * `appendFileSync` is too — so a failure here is logged rather than thrown at a
 * caller that has already moved on.
 */
function queue(what: string, task: () => Promise<void>): void {
  const run = enqueue(task);
  const pending = tasks();
  pending.push(run);
  if (pending.length > 512) pending.splice(0, pending.length - 512);
  run.catch((err) =>
    log.error(`postgres history write failed: ${what}`, { scope: "db", error: err })
  );
}

/**
 * Await every queued manifest/event write; rethrow the first failure. A request
 * does not need this (`flushPostgres()` awaits the same chain); a script about
 * to exit, and the contract tests, do.
 */
export async function flushHistory(): Promise<void> {
  // Two chains, and each one can feed the other: a flush queued by the store
  // seals a revision and queues a manifest write, and a manifest write queued
  // here lands behind whatever the store has already scheduled. So: drain the
  // store's chain, drain ours, and repeat until a pass adds nothing.
  for (let round = 0; round < 8; round++) {
    await (globalThis as GPending).__zenithPgPending;
    if (tasks().length === 0) return;
    const settled = await Promise.allSettled(tasks().splice(0));
    const failed = settled.find((r) => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}

/**
 * Test seam: forget everything this process has cached about revisions and
 * deployment events — which is exactly what a freshly started instance knows.
 * The contract suite uses it to play two instances against one table.
 */
export function resetHistoryCaches(): void {
  manifestCache().clear();
  eventTails().clear();
  seqCounters().clear();
}

/* ---------------------------- revision manifests --------------------------- */

/** TODO(ceiling): LRU by insertion order; a Map is the stdlib's LRU. */
const MANIFEST_CACHE_MAX = 32;

type GM = typeof globalThis & { __zenithPgManifests?: Map<string, Manifest> };
const manifestCache = (): Map<string, Manifest> =>
  ((globalThis as GM).__zenithPgManifests ??= new Map());

function cacheGet(id: string): Manifest | undefined {
  const cache = manifestCache();
  const hit = cache.get(id);
  if (!hit) return undefined;
  cache.delete(id); // re-insert = most recently used
  cache.set(id, hit);
  return hit;
}

function cachePut(id: string, m: Manifest): Manifest {
  const cache = manifestCache();
  cache.delete(id);
  cache.set(id, m);
  if (cache.size > MANIFEST_CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return m;
}

/**
 * One manifest, from the LRU or from cold storage.
 *
 * The blocking read is what makes `revision.manifest` keep working on Postgres:
 * a getter cannot await, and the file store answers the same property with a
 * synchronous file read. It is bounded and rare — a manifest this process wrote
 * is already cached, and `warmRevisionManifests()` fills the cache in one query
 * for a screen that is about to read several.
 */
function readManifest(id: string): Manifest {
  const hit = cacheGet(id);
  if (hit) return hit;
  const { rows } = restSync({
    method: "GET",
    table: "revision_manifests",
    op: "read",
    path: `revision_manifests?select=manifest&${eq("revision_id", id)}&limit=1`,
  });
  const row = rows[0];
  if (!row)
    // Never substitute an empty manifest: a diff against one reads as "delete
    // every service", which is exactly the plan a rollback would then apply.
    throw new Error(
      `Revision "${id}" has no stored manifest (revision_manifests). The revision row is in Postgres but its manifest row is missing — restore it from a backup, or delete the revision.`
    );
  return cachePut(id, row.manifest as Manifest);
}

/** How many times a manifest insert waits for its revision row to appear. */
const MAX_FK_ATTEMPTS = 3;
const FK_RETRY_MS = 50;

async function insertManifest(revisionId: string, manifest: Manifest): Promise<void> {
  const client = pgClient();
  const workspaceId = workspaceOfRevision(revisionId);
  for (let attempt = 1; ; attempt++) {
    const { error } = await client.from("revision_manifests").upsert(
      {
        revision_id: revisionId,
        workspace_id: workspaceId,
        manifest,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "revision_id" }
    );
    if (!error) return;
    // 23503: the revision row is not there yet. It is queued ahead of this
    // write on the normal path (see the header), so this only happens when a
    // manifest was assigned outside a flush — wait a beat and try again.
    if (error.code !== "23503" || attempt >= MAX_FK_ATTEMPTS)
      throw storeError("revision_manifests", "write", error.message);
    await new Promise((resolve) => setTimeout(resolve, FK_RETRY_MS));
  }
}

function writeManifest(revisionId: string, manifest: Manifest): void {
  cachePut(revisionId, manifest);
  queue(`manifest for revision "${revisionId}"`, () => insertManifest(revisionId, manifest));
}

/**
 * Load several manifests into the LRU in one query.
 *
 * Optional — every read falls back to a blocking single-row fetch — but one
 * round trip for a page that is about to read ten manifests beats ten.
 */
export async function warmRevisionManifests(revisionIds: string[]): Promise<void> {
  const wanted = [...new Set(revisionIds.filter(Boolean))].filter(
    (id) => !manifestCache().has(id)
  );
  if (wanted.length === 0) return;
  const { data, error } = await pgClient()
    .from("revision_manifests")
    .select("revision_id,manifest")
    .in("revision_id", wanted);
  if (error) throw storeError("revision_manifests", "read", error.message);
  for (const row of (data ?? []) as PgRow[])
    cachePut(String(row.revision_id), row.manifest as Manifest);
}

/** One manifest without blocking, for a caller that can await. */
export async function revisionManifestAsync(id: string): Promise<Manifest | undefined> {
  const hit = cacheGet(id);
  if (hit) return hit;
  await warmRevisionManifests([id]);
  return cacheGet(id);
}

/**
 * Whose accessor is on this revision.
 *
 * Both stores run in a Postgres install: `PostgresStore.save()` also calls
 * `FileStore.save()`, whose debounced `writeState()` calls `sealManifests()` —
 * so the file store can reach a freshly pushed revision first, move the
 * manifest into `<ZENITH_DATA>/revisions/` and attach *its* accessor. Without
 * this mark the seal below would see a non-enumerable `manifest`, conclude the
 * work was done and never write the `revision_manifests` row: the manifest
 * would exist only in one instance's `/tmp`, which is the exact debt Phase 3
 * closes. Marked, the seal takes the property over — reading the value through
 * whatever accessor is there, which is what makes the hand-over lossless.
 */
const PG_MANIFEST = Symbol.for("zenith.pgManifest");

/**
 * The lazy accessor, identical in shape to the file store's: non-enumerable, a
 * getter that reads cold storage and a setter that writes through.
 */
function attachManifest(r: Revision): void {
  Object.defineProperty(r, "manifest", {
    configurable: true,
    enumerable: false, // ← what keeps manifests out of every write
    get: () => readManifest(r.id),
    set: (m: Manifest) => writeManifest(r.id, m),
  });
  Object.defineProperty(r, PG_MANIFEST, {
    value: true,
    enumerable: false,
    configurable: true,
  });
}

/**
 * Give one revision its accessor, moving an inline manifest to cold storage
 * first. The Postgres counterpart of `sealManifests()` in the file store, and
 * for the same reason: a revision is pushed onto the graph with its manifest
 * inline (see `actions/defs/deploy.ts`), and the write must not carry it into
 * the `data` column.
 */
function seal(r: Revision): void {
  const own = Object.getOwnPropertyDescriptor(r, "manifest");
  if (own && !own.enumerable && (r as unknown as Record<symbol, unknown>)[PG_MANIFEST]) return;
  if (!own) {
    attachManifest(r);
    return;
  }
  // Either the inline manifest the caller pushed, or — when the file store won
  // the race described above — the one it just moved to its side file. Both
  // read the same way, which is the point of the accessor.
  const manifest = r.manifest;
  attachManifest(r);
  writeManifest(r.id, manifest);
}

/**
 * Seal every revision in a graph. Called on the write path through the
 * `revisions` adapter's `rows` accessor — so the diff never sees an inline
 * manifest — and exported for the bulk importer, which builds rows with
 * `toRow()` rather than through a flush.
 */
export function sealRevisionManifests(data: Database = graph()): Revision[] {
  for (const r of data.revisions) seal(r);
  return data.revisions;
}

/* -------------------------------- collections ------------------------------ */

/** Round 3: both tables hang off projects, exactly as environments do. */
const byProject = (ctx: PrefetchContext): PrefetchQuery =>
  ctx.user ? { kind: "in", column: "project_id", values: ctx.projectIds } : { kind: "all" };

/**
 * The tenant for a row that names a project and nothing else: the column during
 * a load, the project's workspace during a diff, and the non-enumerable
 * fallback `adopt()` stamped on for objects that carry no field of their own.
 * The same rule `environments` follows in `./core.ts`.
 */
const projectTenant = (row: { projectId: string }, ctx: TenantContext): string => {
  const own = ctx.row?.workspace_id;
  if (own) return String(own);
  const project = ctx.db?.projects.find((p) => p.id === row.projectId);
  return project ? project.workspaceId : tenantOf(row);
};

/** `timestamptz` comes back in Postgres' format; the graph holds ISO strings. */
function normaliseIso<T>(row: T, ...fields: (keyof T)[]): T {
  for (const field of fields) {
    const v = row[field];
    if (typeof v === "string" && v) row[field] = new Date(v).toISOString() as T[keyof T];
  }
  return row;
}

const revisionRename = {
  project_id: "projectId",
  number: "number",
  created_at: "createdAt",
};

registerCollection<Revision>({
  collection: "revisions",
  table: "revisions",
  key: (r) => ({ id: r.id }),
  tenant: projectTenant,
  // `manifest` is deliberately not a promoted column and not in `rename`: it is
  // non-enumerable by the time a write reads the row (see `rows` below), so
  // `stripPromoted`'s spread never sees it.
  promote: (r) => {
    seal(r);
    return { project_id: r.projectId, number: r.number, created_at: iso(r.createdAt) };
  },
  rename: revisionRename,
  hydrate: (row) => {
    const r = hydrateWith<Revision>(revisionRename)(row);
    attachManifest(r);
    return r;
  },
  prefetch: { round: 3, filter: byProject },
  // The seal hook: `diff()` and `rebaseline()` both reach the graph through
  // here, so an inline manifest is in cold storage before anything serialises
  // the revision it was pushed onto.
  // `syncGraph` first: it is what notices a `reset()` handed the store a new
  // graph, and the caches have to be dropped *before* this seal repopulates
  // them — otherwise the manifest cached here is thrown away by the next
  // reader's check and the row it was queued to write has not landed yet.
  rows: (db: Database) =>
    sealRevisionManifests(syncGraph(db)) as unknown as { id: string }[],
});

const deploymentRename = {
  project_id: "projectId",
  environment_id: "environmentId",
  revision_id: "revisionId",
  status: "status",
  created_at: "createdAt",
  ended_at: "endedAt",
};

registerCollection<Deployment>({
  collection: "deployments",
  table: "deployments",
  key: (d) => ({ id: d.id }),
  tenant: projectTenant,
  promote: (d) => ({
    project_id: d.projectId,
    environment_id: d.environmentId,
    revision_id: d.revisionId,
    status: d.status,
    created_at: iso(d.createdAt),
    ended_at: iso(d.endedAt),
  }),
  rename: deploymentRename,
  // `endedAt` is not one of the registry's normalised timestamp fields, and a
  // round-tripped `+00:00` that does not match what was written would make
  // every flush rewrite every finished deployment for ever.
  hydrate: (row) => normaliseIso(hydrateWith<Deployment>(deploymentRename)(row), "endedAt"),
  prefetch: { round: 3, filter: byProject },
  rows: (db: Database) => db.deployments as unknown as { id: string }[],
});

/* ----------------------------- deployment events ---------------------------- */

/** Events this process has written or read, per deployment. */
type GT = typeof globalThis & { __zenithPgEventTails?: Map<string, DeploymentEvent[]> };
const eventTails = (): Map<string, DeploymentEvent[]> =>
  ((globalThis as GT).__zenithPgEventTails ??= new Map());

type GC = typeof globalThis & { __zenithPgEventSeq?: Map<string, number> };
const seqCounters = (): Map<string, number> =>
  ((globalThis as GC).__zenithPgEventSeq ??= new Map());

/** Events kept in memory per deployment, and deployments kept at all. */
const TAIL_MAX = 5_000;
const TAILS_MAX = 64;

function tailFor(deploymentId: string): DeploymentEvent[] {
  const tails = eventTails();
  const hit = tails.get(deploymentId);
  if (hit) {
    tails.delete(deploymentId); // re-insert = most recently used
    tails.set(deploymentId, hit);
    return hit;
  }
  const fresh: DeploymentEvent[] = [];
  tails.set(deploymentId, fresh);
  if (tails.size > TAILS_MAX) tails.delete(tails.keys().next().value as string);
  return fresh;
}

const bumpCounter = (deploymentId: string, next: number): void => {
  const counters = seqCounters();
  if ((counters.get(deploymentId) ?? -1) < next) counters.set(deploymentId, next);
};

/** Merge into the tail, keeping it ordered by seq and free of duplicates. */
function remember(deploymentId: string, events: DeploymentEvent[]): void {
  if (events.length === 0) return;
  const tail = tailFor(deploymentId);
  const seen = new Set(tail.map((e) => e.seq));
  for (const e of events) {
    if (seen.has(e.seq)) continue;
    seen.add(e.seq);
    tail.push(e);
  }
  tail.sort((a, b) => a.seq - b.seq);
  if (tail.length > TAIL_MAX) tail.splice(0, tail.length - TAIL_MAX);
  const highest = tail[tail.length - 1]?.seq;
  if (highest !== undefined) bumpCounter(deploymentId, highest + 1);
}

/**
 * The next sequence number for this deployment, as a hint.
 *
 * `engine.ts` calls this instead of minting its own number when the store is
 * Postgres. The database still decides: `insertEvent` retries from `max(seq)`
 * when another instance already took this number, and writes back the number it
 * actually got.
 */
export function nextEventSeq(deploymentId: string): number {
  syncGraph();
  const counters = seqCounters();
  let next = counters.get(deploymentId);
  if (next === undefined) {
    // Nothing known in this process yet. Resume after whatever the table holds,
    // so an instance that picks up somebody else's deployment does not start a
    // retry storm at zero.
    next = maxSeqSync(deploymentId) + 1;
  }
  counters.set(deploymentId, next + 1);
  return next;
}

/** How many numbers one insert may try before it gives up. */
const MAX_SEQ_ATTEMPTS = 8;

const SEQ_SELECT = "deployment_events?select=deployment_id,seq,ts,body";

function maxSeqSync(deploymentId: string): number {
  const { rows } = restSync({
    method: "GET",
    table: "deployment_events",
    op: "read",
    path: `deployment_events?select=seq&${eq("deployment_id", deploymentId)}&order=seq.desc&limit=1`,
  });
  return rows[0] ? Number(rows[0].seq) : -1;
}

async function maxSeq(deploymentId: string): Promise<number> {
  const { data, error } = await pgClient()
    .from("deployment_events")
    .select("seq")
    .eq("deployment_id", deploymentId)
    .order("seq", { ascending: false })
    .limit(1);
  if (error) throw storeError("deployment_events", "read", error.message);
  const row = (data ?? [])[0] as PgRow | undefined;
  return row ? Number(row.seq) : -1;
}

/** `ts`, `deploymentId` and `seq` are columns; everything else is the body. */
const bodyOf = (e: DeploymentEvent): Record<string, unknown> => {
  const { ts: _ts, deploymentId: _deploymentId, seq: _seq, ...body } = e;
  return body;
};

const rowToEvent = (row: Record<string, unknown>): DeploymentEvent =>
  ({
    ...(row.body as Record<string, unknown>),
    ts: row.ts ? new Date(String(row.ts)).toISOString() : "",
    deploymentId: String(row.deployment_id),
    seq: Number(row.seq),
  }) as DeploymentEvent;

async function insertEvent(e: DeploymentEvent): Promise<void> {
  const client = pgClient();
  const workspaceId = workspaceOfDeployment(e.deploymentId);
  const body = bodyOf(e);
  let seq = Math.max(0, e.seq);
  for (let attempt = 1; attempt <= MAX_SEQ_ATTEMPTS; attempt++) {
    const { error } = await client.from("deployment_events").insert({
      deployment_id: e.deploymentId,
      seq,
      workspace_id: workspaceId,
      ts: e.ts,
      body,
    });
    if (!error) {
      // The number the database accepted is the one the SSE cursor must use, so
      // it goes back onto the object this process's tail is holding.
      e.seq = seq;
      bumpCounter(e.deploymentId, seq + 1);
      return;
    }
    // 23505: (deployment_id, seq) is taken — another instance is writing this
    // deployment's log too. Continue from what the table actually holds.
    if (error.code !== "23505") throw storeError("deployment_events", "insert into", error.message);
    seq = (await maxSeq(e.deploymentId)) + 1;
  }
  throw storeError(
    "deployment_events",
    "insert into",
    `no free sequence number for deployment "${e.deploymentId}" after ${MAX_SEQ_ATTEMPTS} attempts`
  );
}

/**
 * Events for one deployment with `seq > afterSeq`, oldest first.
 *
 * One keyed range read on the primary key `(deployment_id, seq)` — index-only,
 * never a scan, whatever the log has grown to. The deployment SSE route calls
 * this on every 300 ms tick, which is why it is the async one: a tailing client
 * must not block the event loop.
 */
export async function readEventsAsync(
  deploymentId: string,
  afterSeq = -1
): Promise<DeploymentEvent[]> {
  syncGraph();
  const { data, error } = await pgClient()
    .from("deployment_events")
    .select("deployment_id,seq,ts,body")
    .eq("deployment_id", deploymentId)
    .gt("seq", afterSeq)
    .order("seq", { ascending: true });
  if (error) throw storeError("deployment_events", "read", error.message);
  const events = ((data ?? []) as PgRow[]).map((row) => rowToEvent(row));
  remember(deploymentId, events);
  return events.filter((e) => e.seq > afterSeq);
}

/* -------------------------------- delegates -------------------------------- */

const manifests: ManifestDelegate = {
  revisionManifest: (id) => {
    const data = syncGraph();
    const revision = data.revisions.find((r) => r.id === id);
    // Same answer as the file store's: a revision the graph does not hold has
    // no manifest to give, whatever the table still contains.
    if (!revision) return undefined;
    seal(revision); // a just-pushed revision still carries its manifest inline
    return revision.manifest;
  },
};

const events: EventsDelegate = {
  appendEvent: (e) => {
    syncGraph();
    remember(e.deploymentId, [e]);
    queue(`event ${e.seq} of deployment "${e.deploymentId}"`, () => insertEvent(e));
  },
  /**
   * The synchronous reader. Blocking range read merged with this process's own
   * queued appends — an event written a microsecond ago has not reached the
   * table yet, and the caller that wrote it must still see it. Everything that
   * can await (the SSE route) uses `readEventsAsync` instead.
   *
   * Scoped to the deployments the graph holds, which is the same rule
   * `revisionManifest` follows: a deployment `reset()` dropped or retention
   * pruned has no log to hand out *here*, and nothing can ask for one anyway —
   * the SSE route resolves the deployment before it reads its events. The rows
   * stay in the table, append-only, exactly as the file store leaves its JSONL.
   */
  readEvents: (deploymentId, afterSeq = -1) => {
    const data = syncGraph();
    if (!data.deployments.some((d) => d.id === deploymentId)) return [];
    const { rows } = restSync({
      method: "GET",
      table: "deployment_events",
      op: "read",
      path: `${SEQ_SELECT}&${eq("deployment_id", deploymentId)}&seq=gt.${Math.trunc(afterSeq)}&order=seq.asc`,
    });
    remember(deploymentId, rows.map(rowToEvent));
    return (eventTails().get(deploymentId) ?? []).filter((e) => e.seq > afterSeq);
  },
};

setDelegate("manifests", manifests);
setDelegate("events", events);
