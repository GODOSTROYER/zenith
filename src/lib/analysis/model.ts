/**
 * Internal working state of one analysis run: the indexed repository, the
 * project roots found in it, per-root facts, and the collectors that turn
 * scattered observations into `Inference<T>` lists.
 *
 * Nothing here is exported from the package barrel.
 */
import { checkEntryPath, isIgnoredPath } from "./snapshot";
import { basename, compareStrings, dirname, maxConfidence } from "./text";
import type { Confidence, DatastoreKind, Evidence, Inference, RepoSnapshot } from "./types";

/* --------------------------------- index --------------------------------- */

const MAX_INDEXED_FILES = 20_000;
const MAX_INDEXED_BYTES = 1_048_576;

/** Sorted, de-duplicated, path-checked view of a snapshot's files. */
export class RepoIndex {
  readonly files = new Map<string, string>();
  readonly paths: string[];

  /** Files a hand-built snapshot offered beyond `MAX_INDEXED_FILES`; the builders never produce this. */
  readonly dropped: number;

  constructor(snapshot: RepoSnapshot) {
    // A snapshot from the builders is already bounded; one built by hand is re-bounded here.
    const offered = Array.isArray(snapshot.files) ? snapshot.files : [];
    const sorted = offered.filter((f) => typeof f?.path === "string").sort((a, b) => compareStrings(a.path, b.path));
    let dropped = 0;
    for (const f of sorted) {
      const check = checkEntryPath(f.path);
      if (!check.ok || isIgnoredPath(check.path) || this.files.has(check.path)) continue;
      if (this.files.size >= MAX_INDEXED_FILES) {
        dropped++;
        continue;
      }
      this.files.set(check.path, typeof f.content === "string" ? f.content.slice(0, MAX_INDEXED_BYTES) : "");
    }
    this.dropped = dropped;
    this.paths = [...this.files.keys()];
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  get(path: string): string | undefined {
    return this.files.get(path);
  }
}

/* --------------------------------- roots --------------------------------- */

export interface Root {
  /** "" is the repository root. */
  dir: string;
  /** Basenames of the marker files found directly in the directory. */
  markers: Set<string>;
}

/** Deepest root that contains `path`. `roots` must include the "" root. */
export function ownerOf(roots: Root[], path: string): Root {
  let best = roots[0];
  for (const r of roots) {
    if (r.dir === "" || path.startsWith(`${r.dir}/`)) if (r.dir.length >= best.dir.length) best = r;
  }
  return best;
}

export const rootLabel = (dir: string): string => (dir === "" ? "." : dir);
/** For sentences: "the repository root" instead of ".". */
export const rootWhere = (dir: string): string => (dir === "" ? "the repository root" : dir);
export const rootBase = (dir: string): string => (dir === "" ? "" : basename(dir));
export const isAncestorDir = (ancestor: string, dir: string): boolean => ancestor === "" ? dir !== "" : dir.startsWith(`${ancestor}/`);
export { dirname };

/* -------------------------------- collector ------------------------------ */

const MAX_EVIDENCE = 6;

const evKey = (e: Evidence): string => `${e.path}\u0000${e.line ?? 0}\u0000${e.rule}`;
const evCompare = (a: Evidence, b: Evidence): number =>
  compareStrings(a.path, b.path) || (a.line ?? 0) - (b.line ?? 0) || compareStrings(a.rule, b.rule);

/** De-duplicate, sort and cap a list of evidence. */
export function mergeEvidence(list: Evidence[], max = MAX_EVIDENCE): Evidence[] {
  return [...new Map(list.map((e) => [evKey(e), e] as const)).values()].sort(evCompare).slice(0, max);
}

/** Merge-by-key accumulator that yields sorted `Inference<T>` lists. */
export class Bucket<T> {
  private readonly m = new Map<string, { value: T; confidence: Confidence; evidence: Map<string, Evidence> }>();

  add(key: string, value: T, confidence: Confidence, evidence: Evidence | Evidence[], merge?: (old: T, next: T, oldConfidence: Confidence, nextConfidence: Confidence) => T): void {
    const list = Array.isArray(evidence) ? evidence : [evidence];
    const cur = this.m.get(key);
    if (!cur) {
      this.m.set(key, { value, confidence, evidence: new Map(list.map((e) => [evKey(e), e] as const)) });
      return;
    }
    if (merge) cur.value = merge(cur.value, value, cur.confidence, confidence);
    cur.confidence = maxConfidence(cur.confidence, confidence);
    for (const e of list) cur.evidence.set(evKey(e), e);
  }

  get(key: string): { value: T; confidence: Confidence } | undefined {
    return this.m.get(key);
  }

  has(key: string): boolean {
    return this.m.has(key);
  }

  entries(): { key: string; value: T; confidence: Confidence; evidence: Evidence[] }[] {
    return [...this.m.entries()]
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([key, v]) => ({ key, value: v.value, confidence: v.confidence, evidence: [...v.evidence.values()].sort(evCompare) }));
  }

  list(): Inference<T>[] {
    return this.entries().map(({ value, confidence, evidence }) => ({ value, confidence, evidence: evidence.slice(0, MAX_EVIDENCE) }));
  }
}

/* --------------------------------- facts --------------------------------- */

export type Eco = "npm" | "pip" | "gem" | "go" | "mvn" | "composer" | "cargo";

export interface Dep {
  eco: Eco;
  name: string;
  dev: boolean;
  evidence: Evidence;
}

export interface PortCandidate {
  port: number;
  /** 1 framework default … 6 explicit flag */
  rank: number;
  source: string;
  evidence: Evidence;
}

export interface HealthCandidate {
  path: string;
  /** true when a deployment file declares it, false when only a code route does */
  declared: boolean;
  evidence: Evidence;
}

export interface WorkerSignal {
  tech: string;
  confidence: Confidence;
  evidence: Evidence;
  command?: string;
  /** file that starts the worker, when it is one */
  file?: string;
}

export interface CronSignal {
  mechanism: string;
  confidence: Confidence;
  evidence: Evidence;
  schedule?: string;
  inProcess: boolean;
  command?: string;
  target?: string;
  /** Some signals (a Procfile `clock:` line) are already a whole process. */
  file?: string;
}

export interface ProcfileEntry {
  type: string;
  command: string;
  line: number;
}

export interface DockerfileFacts {
  path: string;
  /** Base images in stage order. */
  from: { image: string; tag?: string; line: number }[];
  expose: { port: number; line: number }[];
  cmd?: { text: string; line: number };
  entrypoint?: { text: string; line: number };
  healthPath?: { path: string; line: number };
  hasHealthcheck: boolean;
  /** Names set with ENV (values stay in the importer result). */
  envDefaults: Map<string, string>;
  envSecretNames: Set<string>;
  unpinnedBase: boolean;
}

export interface CommandCandidate {
  command: string;
  confidence: Confidence;
  evidence: Evidence;
}

export interface RootFacts {
  root: Root;
  deps: Map<string, Dep>;
  pkg?: {
    path: string;
    name?: string;
    scripts: Map<string, string>;
    main?: string;
    workspaces?: string[];
    packageManager?: string;
    localDeps: string[];
  };
  procfile?: { path: string; entries: ProcfileEntry[] };
  dockerfile?: DockerfileFacts;
  otherDockerfiles: string[];
  ports: PortCandidate[];
  healths: HealthCandidate[];
  workers: WorkerSignal[];
  crons: CronSignal[];
  listenFiles: Set<string>;
  starts: CommandCandidate[];
  /** Web framework detected (role web) and its evidence. */
  webFrameworks: { name: string; defaultPort?: number; confidence: Confidence; evidence: Evidence }[];
  staticFrameworks: { name: string; confidence: Confidence; evidence: Evidence }[];
  /** Python entry points found in source, for start-command recipes. */
  pyApps: { kind: "fastapi" | "flask" | "celery"; module: string; variable: string; evidence: Evidence }[];
  hasMainGo: boolean;
  goMainDirs: string[];
  /** Files under this root, for cheap existence checks. */
  fileSet: Set<string>;
  /** Build hints from a hosting config (vercel.json, netlify.toml). */
  hosting?: { buildCommand?: string; outputDir?: string; installCommand?: string; evidence: Evidence };
}

export const newFacts = (root: Root): RootFacts => ({
  root,
  deps: new Map(),
  otherDockerfiles: [],
  ports: [],
  healths: [],
  workers: [],
  crons: [],
  listenFiles: new Set(),
  starts: [],
  webFrameworks: [],
  staticFrameworks: [],
  pyApps: [],
  hasMainGo: false,
  goMainDirs: [],
  fileSet: new Set(),
});

/* --------------------------------- context ------------------------------- */

export interface DatastoreExtra {
  kind: DatastoreKind;
}

export interface EnvAcc {
  name: string;
  secret: boolean;
  roots: Set<string>;
  defaults: Set<string>;
  conflicted: boolean;
}

export interface Ctx {
  idx: RepoIndex;
  roots: Root[];
  facts: Map<string, RootFacts>;
  runtimes: Bucket<import("./types").RuntimeRequirement>;
  frameworks: Bucket<import("./types").FrameworkRequirement>;
  datastores: Bucket<import("./types").DatastoreRequirement>;
  migrations: Bucket<import("./types").MigrationRequirement>;
  healthEndpoints: Bucket<import("./types").HealthEndpoint>;
  infrastructure: Bucket<import("./types").InfrastructureFinding>;
  findings: Bucket<import("./types").RepoFinding>;
  envs: Map<string, { acc: EnvAcc; evidence: Map<string, Evidence>; confidence: Confidence }>;
  /** Services the repository itself names by image (compose `image:`), with no root to analyse. */
  extraServices: ExtraService[];
  unknowns: Set<string>;
  risks: Set<string>;
}

export interface ExtraService {
  name: string;
  root: string;
  kind: "web" | "worker";
  image: string;
  port?: number;
  healthPath?: string;
  command?: string;
  evidence: Evidence;
}

export const factsFor = (ctx: Ctx, dir: string): RootFacts => {
  const f = ctx.facts.get(dir);
  if (!f) throw new Error(`analysis invariant: no facts for root ${dir}`);
  return f;
};
