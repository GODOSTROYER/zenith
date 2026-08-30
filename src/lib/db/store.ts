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

/** Atomic persist. Call after any mutation to db(). */
export function save(): void {
  ensureDir();
  const tmp = `${STATE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db(), null, 1), "utf8");
  fs.renameSync(tmp, STATE);
}

/** Reset everything (used by seed script). */
export function resetDb(data?: Partial<Database>): Database {
  const g = globalThis as G;
  g.__orreryDb = { ...structuredClone(EMPTY), ...data };
  ensureDir();
  for (const f of [EVENTS, AUDIT]) if (fs.existsSync(f)) fs.unlinkSync(f);
  save();
  return g.__orreryDb;
}

/* ------------------------------ event streams ------------------------------ */

export function appendEvent(e: DeploymentEvent): void {
  ensureDir();
  fs.appendFileSync(EVENTS, JSON.stringify(e) + "\n", "utf8");
}

export function readEvents(deploymentId: string, afterSeq = -1): DeploymentEvent[] {
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

export function appendAudit(e: AuditEvent): void {
  ensureDir();
  fs.appendFileSync(AUDIT, JSON.stringify(e) + "\n", "utf8");
}

export function readAudit(filter: {
  workspaceId?: string;
  projectId?: string;
  limit?: number;
}): AuditEvent[] {
  if (!fs.existsSync(AUDIT)) return [];
  const out: AuditEvent[] = [];
  for (const line of fs.readFileSync(AUDIT, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as AuditEvent;
      if (filter.workspaceId && e.workspaceId !== filter.workspaceId) continue;
      if (filter.projectId && e.projectId !== filter.projectId) continue;
      out.push(e);
    } catch {
      /* skip torn line */
    }
  }
  out.reverse(); // newest first
  return filter.limit ? out.slice(0, filter.limit) : out;
}

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
