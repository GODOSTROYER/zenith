/**
 * Orrery persistence: embedded JSON snapshot + JSONL append-only logs.
 *
 * Durability contract: every mutation is written atomically (tmp + rename);
 * deployment/audit events are append-only JSONL so a crash can never corrupt
 * history. A browser refresh or server restart resumes from disk.
 *
 * ponytail: single-process file store; swap for SQL behind this same module
 * if Orrery ever runs multi-process. The rest of the codebase only sees
 * `db()` and the append/read helpers.
 *
 * SPINE FILE — owned by the integrator.
 */
import fs from "node:fs";
import path from "node:path";
import type {
  AuditEvent,
  CloudConnection,
  Deployment,
  DeploymentEvent,
  Environment,
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
  /** per-workspace settings incl. autonomy level and user preferences */
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
  settings: {},
};

const DATA_DIR = process.env.ORRERY_DATA ?? path.join(process.cwd(), ".data");
const STATE = path.join(DATA_DIR, "state.json");
const EVENTS = path.join(DATA_DIR, "events.jsonl");
const AUDIT = path.join(DATA_DIR, "audit.jsonl");

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
      data = { ...EMPTY, ...(JSON.parse(fs.readFileSync(STATE, "utf8")) as Database) };
    } catch {
      // Corrupt snapshot: keep the file for forensics, start fresh.
      fs.copyFileSync(STATE, `${STATE}.corrupt-${Date.now()}`);
      data = structuredClone(EMPTY);
    }
  } else {
    data = structuredClone(EMPTY);
  }
  g.__orreryDb = data;
  return data;
}

/* --------------------------------- saving --------------------------------- */

type GS = typeof globalThis & {
  __orrerySaveTimer?: ReturnType<typeof setTimeout>;
  __orreryExitHooked?: boolean;
};

/** Coalescing window: a burst of step transitions costs one write, not twenty. */
const SAVE_DEBOUNCE_MS = 50;

function writeState(): void {
  ensureDir();
  const tmp = `${STATE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db()), "utf8");
  fs.renameSync(tmp, STATE);
}

/**
 * Persist. Writes are coalesced over a 50ms window and always atomic
 * (tmp + rename). `flush()` runs on process exit, so nothing is lost.
 */
export function save(): void {
  const g = globalThis as GS;
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
  /** max events to return (default 500) */
  limit?: number;
  /** "user" | "navigator" | "system" */
  actorType?: AuditEvent["actor"]["type"];
  /** exact action id, or a prefix ending in "." (e.g. "deploy.") */
  actionId?: string;
  result?: AuditEvent["result"];
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
  (!f.actorType || e.actor?.type === f.actorType) &&
  (!f.result || e.result === f.result) &&
  (!f.actionId ||
    (f.actionId.endsWith(".") ? e.actionId.startsWith(f.actionId) : e.actionId === f.actionId));

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
