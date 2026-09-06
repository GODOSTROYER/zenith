/**
 * Orrery persistence: embedded JSON snapshot + JSONL append-only logs.
 *
 * Durability contract: every mutation is written atomically (tmp + rename);
 * deployment/audit events are append-only JSONL so a crash can never corrupt
 * history. A browser refresh or server restart resumes from disk.
 *
 * Hot vs cold. `state.json` is rewritten in full on every save, so only what
 * changes belongs in it: workspaces, projects, environments, deployments and
 * revision *metadata*. Revision manifests — immutable, and the largest thing
 * the store holds — live one file each under `revisions/` and load on demand
 * (see "revision manifests" below). Events and audit rows are append-only.
 *
 * Every successful write emits a change event (`onChange`), which is how the
 * project stream pushes instead of every open tab polling.
 *
 * ponytail: single-process file store; swap for SQL behind this same module
 * if Orrery ever runs multi-process. The rest of the codebase only sees
 * `db()` and the append/read helpers.
 *
 * SPINE FILE — owned by the integrator.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { env } from "@/lib/env";
import type {
  AlertEvent,
  AlertOutboxEntry,
  AlertRule,
  AuditEvent,
  CloudConnection,
  Deployment,
  DeploymentEvent,
  Environment,
  Manifest,
  Member,
  NavigatorRun,
  Project,
  Revision,
  SecurityFinding,
  Workspace,
} from "@/lib/domain/types";

export interface Database {
  workspaces: Workspace[];
  members: Member[];
  connections: CloudConnection[];
  projects: Project[];
  environments: Environment[];
  revisions: Revision[];
  deployments: Deployment[];
  findings: SecurityFinding[];
  navigatorRuns: NavigatorRun[];
  /** standing alert conditions, one per (environment, kind) */
  alertRules: AlertRule[];
  /** the durable record of every time a rule fired; outlives its rule */
  alertEvents: AlertEvent[];
  /** delivery intent, written with the event it belongs to; drained by the sender */
  alertOutbox: AlertOutboxEntry[];
  /**
   * Install-wide settings bag. NOT per-workspace despite the name: `autonomy`
   * is a single install-global level (the dial says so on screen), and
   * `alertChannels`/`invites` are flat lists that carry their own
   * `workspaceId` and must be filtered by the reader. Nothing here is safe
   * to serialize wholesale — channels hold HMAC secrets and webhook URLs,
   * invites hold email addresses — so responses build an allowlisted DTO
   * (see /api/bootstrap) rather than spreading this object.
   */
  settings: Record<string, unknown>;
}

const EMPTY: Database = {
  workspaces: [],
  members: [],
  connections: [],
  projects: [],
  environments: [],
  revisions: [],
  deployments: [],
  findings: [],
  navigatorRuns: [],
  alertRules: [],
  alertEvents: [],
  alertOutbox: [],
  settings: {},
};

const DATA_DIR = env().ORRERY_DATA;
const STATE = path.join(DATA_DIR, "state.json");
const EVENTS = path.join(DATA_DIR, "events.jsonl");
const AUDIT = path.join(DATA_DIR, "audit.jsonl");
/** Cold storage: one immutable manifest per revision, written once. */
const MANIFESTS = path.join(DATA_DIR, "revisions");

type G = typeof globalThis & { __orreryDb?: Database };

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** Load (once per process; survives Next.js HMR via globalThis). */
export function db(): Database {
  const g = globalThis as G;
  if (g.__orreryDb) return g.__orreryDb;
  ensureDir();
  let data: Database = EMPTY;
  if (fs.existsSync(STATE)) {
    try {
      // structuredClone, not a bare spread: a key missing from disk — every new
      // collection, on the first load after it is added — would otherwise alias
      // EMPTY's own array, and the first push would corrupt the empty template.
      data = {
        ...structuredClone(EMPTY),
        ...(JSON.parse(fs.readFileSync(STATE, "utf8")) as Database),
      };
    } catch (err) {
      // A corrupt snapshot must never become an empty *writable* install: the
      // next save would overwrite the only copy of the real data, turning a
      // recoverable parse error into total loss. Keep the file, refuse to
      // boot, and name the way back.
      const kept = `${STATE}.corrupt-${Date.now()}`;
      fs.copyFileSync(STATE, kept);
      throw new Error(
        `The Orrery state file at ${STATE} could not be parsed, so the server will not start: ` +
          `continuing would serve an empty workspace and the next write would overwrite your data. ` +
          `A copy is preserved at ${kept}. ` +
          `Fix: restore a good copy over ${STATE} (a .corrupt-* file or your own backup), ` +
          `or delete ${STATE} to start over deliberately with an empty install. ` +
          `Parse error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    data = structuredClone(EMPTY);
  }
  g.__orreryDb = data;
  // Baseline for the orphan sweep, set before the first write can happen: a
  // project deleted by this process's very first save must still take its
  // manifests with it.
  revisionCount = data.revisions.length;
  // Migrate a pre-split snapshot: manifests found inline move to the side
  // store, then state.json is rewritten without them. Side files are written
  // first, so an interrupted migration simply re-runs on the next boot.
  if (sealManifests()) writeState();
  return data;
}

/* --------------------------- revision manifests ---------------------------- */

/**
 * Revision manifests are the cold half of the store: written once at deploy,
 * read by one screen at a time, and — before this split — re-serialised in
 * full on every save, forever. They now live in `<ORRERY_DATA>/revisions/`,
 * one atomic file each, and `Revision.manifest` is a lazy accessor:
 *
 *  - `enumerable: false`, so `JSON.stringify(db())` never sees a manifest and
 *    a save costs metadata only, whatever the deploy history looks like;
 *  - a getter, so every existing reader (`revision.manifest`, in the engine,
 *    the providers, the alert and log simulators, the security rules, the
 *    server-rendered screens) keeps working untouched;
 *  - a setter, so assigning a manifest writes it through.
 *
 * The one thing that changed for callers: a `Revision` no longer carries its
 * manifest through `JSON.stringify`. A route that puts one in a response body
 * must attach it explicitly — `q.revisionManifest(id)`.
 */

/** ponytail: LRU by insertion order; a Map is the stdlib's LRU. */
const MANIFEST_CACHE_MAX = 32;

type GM = typeof globalThis & { __orreryManifests?: Map<string, Manifest> };
const manifestCache = (): Map<string, Manifest> =>
  ((globalThis as GM).__orreryManifests ??= new Map());

/** Ids come from `id()`, but an importer's id is untrusted: never a path. */
const manifestFile = (id: string): string =>
  path.join(MANIFESTS, `${encodeURIComponent(id)}.json`);

function readManifest(id: string): Manifest {
  const cache = manifestCache();
  const hit = cache.get(id);
  if (hit) {
    cache.delete(id); // re-insert = most recently used
    cache.set(id, hit);
    return hit;
  }
  const file = manifestFile(id);
  if (!fs.existsSync(file))
    // Never substitute an empty manifest: a diff against one reads as "delete
    // every service", which is exactly the plan a rollback would then apply.
    throw new Error(
      `Revision "${id}" has no stored manifest (${file}). The revision metadata is in state.json but its manifest file is missing — restore it from a backup, or delete the revision.`
    );
  return cachePut(id, JSON.parse(fs.readFileSync(file, "utf8")) as Manifest);
}

function cachePut(id: string, m: Manifest): Manifest {
  const cache = manifestCache();
  cache.delete(id);
  cache.set(id, m);
  if (cache.size > MANIFEST_CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return m;
}

function writeManifest(id: string, m: Manifest): void {
  fs.mkdirSync(MANIFESTS, { recursive: true });
  const file = manifestFile(id);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m), "utf8");
  fs.renameSync(tmp, file);
  cachePut(id, m);
}

function attachManifest(r: Revision): void {
  Object.defineProperty(r, "manifest", {
    configurable: true,
    enumerable: false, // ← what keeps manifests out of every save
    get: () => readManifest(r.id),
    set: (m: Manifest) => writeManifest(r.id, m),
  });
}

/**
 * Give every revision its lazy accessor, moving an inline manifest out to the
 * side store first if it still has one. Runs on load — where a revision read
 * back from `state.json` has no manifest property at all, and a pre-split one
 * has it inline — and again before every write, for the revision the deploy
 * action just pushed. Returns true when something moved and `state.json` is
 * therefore stale.
 */
function sealManifests(): boolean {
  let moved = false;
  for (const r of db().revisions) {
    const own = Object.getOwnPropertyDescriptor(r, "manifest");
    if (own && !own.enumerable) continue; // already an accessor
    if (own) {
      writeManifest(r.id, r.manifest);
      moved = true;
    }
    attachManifest(r);
  }
  return moved;
}

/**
 * Drop side files with no revision left in state.json — a deleted project, a
 * pruned history. Only worth a readdir when the revision count actually fell,
 * so the normal save path never touches the directory.
 */
function dropOrphanManifests(): void {
  if (!fs.existsSync(MANIFESTS)) return;
  const live = new Set(db().revisions.map((r) => `${encodeURIComponent(r.id)}.json`));
  for (const name of fs.readdirSync(MANIFESTS))
    if (!live.has(name)) fs.rmSync(path.join(MANIFESTS, name), { force: true });
}

/* ------------------------------ change events ------------------------------ */

export interface StoreChange {
  /**
   * Projects the coalesced saves in this window are known to have touched.
   * **Empty means "unknown, assume any"** — not "nothing changed", since the
   * event only fires after a write actually happened. Callers that know their
   * project pass it to `save(projectId)`; the rest broadcast.
   */
  projectIds: string[];
}

type GC = typeof globalThis & {
  __orreryChanges?: EventEmitter;
  __orreryTouched?: { ids: Set<string>; all: boolean };
};

const changes = (): EventEmitter =>
  ((globalThis as GC).__orreryChanges ??= new EventEmitter().setMaxListeners(0));

const touched = () =>
  ((globalThis as GC).__orreryTouched ??= { ids: new Set<string>(), all: false });

/**
 * Called after every successful write. Returns an unsubscribe function.
 *
 * In-process only — the same single-process ceiling as the store itself. It is
 * what lets `/api/projects/:id/stream` push instead of every open tab polling.
 */
export function onChange(fn: (c: StoreChange) => void): () => void {
  changes().on("change", fn);
  return () => {
    changes().off("change", fn);
  };
}

/** True when a change event concerns this project (or names no project). */
export const changed = (c: StoreChange, projectId: string): boolean =>
  c.projectIds.length === 0 || c.projectIds.includes(projectId);

/* --------------------------------- saving --------------------------------- */

type GS = typeof globalThis & {
  __orrerySaveTimer?: ReturnType<typeof setTimeout>;
  __orreryExitHooked?: boolean;
};

/** Coalescing window: a burst of step transitions costs one write, not twenty. */
const SAVE_DEBOUNCE_MS = 50;

/** Revisions at the last write, so an orphan sweep costs a readdir only when
 *  history actually shrank. */
let revisionCount = -1;

function writeState(): void {
  ensureDir();
  // Manifests go to their own files first: state.json must never be the only
  // copy of one, and after this it serialises metadata alone.
  sealManifests();
  const tmp = `${STATE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db()), "utf8");
  fs.renameSync(tmp, STATE);
  const count = db().revisions.length;
  if (count < revisionCount) dropOrphanManifests();
  revisionCount = count;

  const t = touched();
  const change: StoreChange = { projectIds: t.all ? [] : [...t.ids] };
  t.ids.clear();
  t.all = false;
  // Listener failures are the listener's problem; a save is already durable.
  changes().emit("change", change);
}

/**
 * Persist. Writes are coalesced over a 50ms window and always atomic
 * (tmp + rename). `flush()` runs on process exit, so nothing is lost.
 *
 * `projectId` is a hint for the change event, not a filter on what is written
 * — the whole database is saved either way. Omit it and the event says
 * "something changed", which every subscriber has to handle regardless,
 * because one coalesced write can carry several callers' mutations.
 */
export function save(projectId?: string): void {
  const g = globalThis as GS;
  const t = touched();
  if (projectId) t.ids.add(projectId);
  else t.all = true;
  hookExit();
  if (g.__orrerySaveTimer) return; // a flush is already scheduled
  g.__orrerySaveTimer = setTimeout(() => {
    g.__orrerySaveTimer = undefined;
    writeState();
  }, SAVE_DEBOUNCE_MS);
  // Never hold the process open for a pending save; the exit hook flushes it.
  (g.__orrerySaveTimer as { unref?: () => void }).unref?.();
}

/** Write any pending save immediately. Idempotent. */
export function flush(): void {
  const g = globalThis as GS;
  if (g.__orrerySaveTimer) {
    clearTimeout(g.__orrerySaveTimer);
    g.__orrerySaveTimer = undefined;
  }
  writeState();
}

const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

function onSignal(sig: NodeJS.Signals): void {
  flush();
  // Re-raise only when nothing else handles this signal — otherwise the host
  // (next dev, a test runner) owns shutdown and we must not cut it short.
  if (process.listenerCount(sig) <= 1) {
    process.removeListener(sig, onSignal);
    process.kill(process.pid, sig);
  }
}

function hookExit(): void {
  const g = globalThis as GS;
  if (g.__orreryExitHooked) return;
  g.__orreryExitHooked = true;
  process.on("exit", () => {
    if ((globalThis as GS).__orrerySaveTimer) flush();
  });
  for (const sig of SIGNALS) process.on(sig, onSignal);
}

/** Reset everything (used by seed script). */
export function resetDb(data?: Partial<Database>): Database {
  const g = globalThis as G;
  g.__orreryDb = { ...structuredClone(EMPTY), ...data };
  ensureDir();
  for (const f of [EVENTS, AUDIT]) if (fs.existsSync(f)) fs.unlinkSync(f);
  // Cold storage too, and before the flush: `data` may carry inline manifests
  // (the seed script does), and those are what the flush writes back out.
  fs.rmSync(MANIFESTS, { recursive: true, force: true });
  manifestCache().clear();
  flush();
  return g.__orreryDb;
}

/* ------------------------------ event streams ------------------------------ */

export function appendEvent(e: DeploymentEvent): void {
  ensureDir();
  fs.appendFileSync(EVENTS, JSON.stringify(e) + "\n", "utf8");
}

/**
 * Incremental view of events.jsonl: each read consumes only the bytes appended
 * since the last one. The SSE route polls this per client every 300ms, so a
 * full rescan per poll was the whole cost of watching a deployment.
 */
interface EventTail {
  /** bytes of EVENTS already parsed into `events` */
  pos: number;
  events: DeploymentEvent[];
  /** trailing bytes that are not yet a complete line */
  carry: Buffer;
  /** true once old events have been evicted from `events` */
  evicted: boolean;
}

/** ponytail: cap the in-memory tail; older reads fall back to a file scan. */
const TAIL_MAX = 5_000;

type GE = typeof globalThis & { __orreryEventTail?: EventTail };

function eventTail(): EventTail {
  const g = globalThis as GE;
  const t = (g.__orreryEventTail ??= { pos: 0, events: [], carry: Buffer.alloc(0), evicted: false });
  if (!fs.existsSync(EVENTS)) {
    if (t.pos) Object.assign(t, { pos: 0, events: [], carry: Buffer.alloc(0), evicted: false });
    return t;
  }
  const size = fs.statSync(EVENTS).size;
  if (size < t.pos) Object.assign(t, { pos: 0, events: [], carry: Buffer.alloc(0), evicted: false });
  if (size === t.pos) return t;

  const fd = fs.openSync(EVENTS, "r");
  try {
    const buf = Buffer.allocUnsafe(size - t.pos);
    fs.readSync(fd, buf, 0, buf.length, t.pos);
    t.pos = size;
    const chunk = Buffer.concat([t.carry, buf]);
    const lastNl = chunk.lastIndexOf(10);
    if (lastNl < 0) {
      t.carry = chunk;
      return t;
    }
    t.carry = chunk.subarray(lastNl + 1);
    for (const line of chunk.subarray(0, lastNl).toString("utf8").split("\n")) {
      if (!line) continue;
      try {
        t.events.push(JSON.parse(line) as DeploymentEvent);
      } catch {
        /* skip torn line */
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  if (t.events.length > TAIL_MAX) {
    t.events = t.events.slice(-TAIL_MAX);
    t.evicted = true;
  }
  return t;
}

function scanEvents(deploymentId: string, afterSeq: number): DeploymentEvent[] {
  if (!fs.existsSync(EVENTS)) return [];
  const out: DeploymentEvent[] = [];
  for (const line of fs.readFileSync(EVENTS, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as DeploymentEvent;
      if (e.deploymentId === deploymentId && e.seq > afterSeq) out.push(e);
    } catch {
      /* skip torn line */
    }
  }
  return out;
}

export function readEvents(deploymentId: string, afterSeq = -1): DeploymentEvent[] {
  const t = eventTail();
  const hit = t.events.filter((e) => e.deploymentId === deploymentId && e.seq > afterSeq);
  // The tail answers everything unless events older than the cursor were evicted.
  if (!t.evicted || (hit.length > 0 && hit[0].seq === afterSeq + 1)) return hit;
  return scanEvents(deploymentId, afterSeq);
}

export function appendAudit(e: AuditEvent): void {
  ensureDir();
  fs.appendFileSync(AUDIT, JSON.stringify(e) + "\n", "utf8");
}

export interface AuditFilter {
  workspaceId?: string;
  projectId?: string;
  /** only rows recorded against this environment */
  environmentId?: string;
  /** max events to return (default 500) */
  limit?: number;
  /** "user" | "navigator" | "system" */
  actorType?: AuditEvent["actor"]["type"];
  /** exact action id, or a prefix ending in "." (e.g. "deploy.") */
  actionId?: string;
  result?: AuditEvent["result"];
  /** ISO timestamp, inclusive lower bound on `ts` */
  from?: string;
  /** ISO timestamp, inclusive upper bound on `ts` */
  to?: string;
  /** opaque page cursor from a previous `readAuditPage` */
  cursor?: string;
}

export interface AuditPage {
  events: AuditEvent[];
  /** pass back as `cursor` for the next (older) page; absent = end of log */
  nextCursor?: string;
}

/** Bytes scanned per call before we stop and hand back a cursor. */
const AUDIT_SCAN_BUDGET = 1 << 20;
const AUDIT_CHUNK = 64 * 1024;

const matches = (e: AuditEvent, f: AuditFilter): boolean =>
  (!f.workspaceId || e.workspaceId === f.workspaceId) &&
  (!f.projectId || e.projectId === f.projectId) &&
  (!f.environmentId || e.environmentId === f.environmentId) &&
  (!f.actorType || e.actor?.type === f.actorType) &&
  (!f.result || e.result === f.result) &&
  (!f.from || e.ts >= f.from) &&
  (!f.to || e.ts <= f.to) &&
  (!f.actionId ||
    (f.actionId.endsWith(".") ? e.actionId.startsWith(f.actionId) : e.actionId === f.actionId));

/**
 * How many rows match, so the UI can say "50 of 214" instead of "50".
 *
 * Counting means reading, so it is bounded: the newest 4 MB of the log. Past
 * that the count is a floor, and `exact: false` says so rather than letting a
 * screen present a truncated number as the truth.
 */
const AUDIT_COUNT_BUDGET = 4 << 20;

export function countAudit(filter: AuditFilter = {}): { total: number; exact: boolean } {
  if (!fs.existsSync(AUDIT)) return { total: 0, exact: true };
  const size = fs.statSync(AUDIT).size;
  const start = Math.max(0, size - AUDIT_COUNT_BUDGET);
  const fd = fs.openSync(AUDIT, "r");
  let total = 0;
  try {
    const buf = Buffer.allocUnsafe(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    // A partial first line (we may have cut mid-record) is dropped, not guessed.
    const lines = text.split("\n");
    if (start > 0) lines.shift();
    for (const line of lines) {
      if (!line) continue;
      try {
        if (matches(JSON.parse(line) as AuditEvent, filter)) total++;
      } catch {
        /* skip torn line */
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return { total, exact: start === 0 };
}

/**
 * Read the audit log backwards from the end (or from `cursor`), newest first.
 * Filtering happens here so callers never pull a window they then throw away.
 */
export function readAuditPage(filter: AuditFilter = {}): AuditPage {
  if (!fs.existsSync(AUDIT)) return { events: [] };
  const size = fs.statSync(AUDIT).size;
  const want = Math.max(1, filter.limit ?? 500);
  const start = Number(filter.cursor);
  let pos = Number.isFinite(start) ? Math.min(Math.max(start, 0), size) : size;
  if (pos === 0) return { events: [] };

  const events: AuditEvent[] = [];
  let carry = Buffer.alloc(0);
  let scanned = 0;
  const fd = fs.openSync(AUDIT, "r");
  try {
    while (pos > 0) {
      const len = Math.min(AUDIT_CHUNK, pos);
      pos -= len;
      scanned += len;
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, pos);
      // Concatenate as bytes, not strings: a chunk boundary can split a UTF-8 char.
      const chunk = Buffer.concat([buf, carry]);
      const nl = pos === 0 ? -1 : chunk.indexOf(10);
      if (nl < 0 && pos > 0) {
        carry = chunk;
        continue;
      }
      carry = nl < 0 ? Buffer.alloc(0) : chunk.subarray(0, nl);
      const body = nl < 0 ? chunk : chunk.subarray(nl + 1);
      const lines = body.toString("utf8").split("\n");
      // absolute byte offset of each line's first character
      let off = pos + carry.length + (nl < 0 ? 0 : 1);
      const starts = lines.map((l) => {
        const s = off;
        off += Buffer.byteLength(l) + 1;
        return s;
      });
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i]) {
          try {
            const e = JSON.parse(lines[i]) as AuditEvent;
            if (matches(e, filter)) events.push(e);
          } catch {
            /* skip torn line */
          }
        }
        if (events.length >= want) return { events, nextCursor: String(starts[i]) };
      }
      // starts[0] is a real line start (anything before it lives in `carry`).
      if (scanned >= AUDIT_SCAN_BUDGET && pos > 0)
        return { events, nextCursor: String(starts[0]) };
    }
  } finally {
    fs.closeSync(fd);
  }
  return { events };
}

/** Back-compatible reader: newest first, no cursor. */
export const readAudit = (filter: AuditFilter = {}): AuditEvent[] =>
  readAuditPage(filter).events;

/* ------------------------------ tiny queries ------------------------------- */

export const q = {
  workspace: (id: string) => db().workspaces.find((w) => w.id === id || w.slug === id),
  project: (id: string) => db().projects.find((p) => p.id === id || p.slug === id),
  environment: (id: string) => db().environments.find((e) => e.id === id),
  environmentsOf: (projectId: string) =>
    db().environments.filter((e) => e.projectId === projectId),
  revision: (id: string) => db().revisions.find((r) => r.id === id),
  /**
   * A revision's manifest, loaded from cold storage on demand.
   *
   * `revision.manifest` returns the same object — the property is a lazy
   * accessor. Use this accessor wherever the manifest has to survive
   * serialisation (an API response body, a structuredClone), because the
   * property is non-enumerable and `JSON.stringify` drops it.
   */
  revisionManifest: (id: string): Manifest | undefined => q.revision(id)?.manifest,
  revisionsOf: (projectId: string) =>
    db()
      .revisions.filter((r) => r.projectId === projectId)
      .sort((a, b) => b.number - a.number),
  deployment: (id: string) => db().deployments.find((d) => d.id === id),
  deploymentsOf: (environmentId: string) =>
    db()
      .deployments.filter((d) => d.environmentId === environmentId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
  connection: (id: string) => db().connections.find((c) => c.id === id),
};

/**
 * Tenancy guard for id-lookup routes. An object id is a bearer token: knowing
 * one must not be enough to read it from another workspace. Every /api route
 * that resolves an object by id checks this and 404s when it fails — 404, not
 * 403, so the id space is not enumerable either.
 */
export const inWorkspace = (workspaceId: string, projectId: string): boolean =>
  q.project(projectId)?.workspaceId === workspaceId;
