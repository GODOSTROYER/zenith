/**
 * `analyzeRepository`: RepoSnapshot -> AppRequirements.
 *
 * Deterministic and side-effect free. The snapshot is hostile data: nothing in
 * it is executed, installed, imported or evaluated; every pattern is linear;
 * every file was already size-capped by the snapshot builder, and this pass
 * adds its own budgets (project roots, bytes scanned, environment names).
 * Output ordering never depends on input order or hash iteration, so the same
 * snapshot yields byte-identical JSON.
 *
 * Passes: index -> roots -> manifests and dependency rules -> Dockerfile and
 * Procfile -> framework configs -> source scan -> deployment configs ->
 * workspace inheritance -> assemble services, builds, migrations, env,
 * unknowns and risks.
 */
import { detectMigrations, readFrameworkConfigs } from "./frameworks";
import { readRepoConfigs } from "./configs";
import { readDependencies } from "./deps";
import { isDockerfileName, readDockerfile, readProcfile } from "./dockerfile";
import { Bucket, RepoIndex, mergeEvidence, newFacts, ownerOf, rootBase, rootLabel, rootWhere, type Ctx, type Root, type RootFacts } from "./model";
import { addDatastore, ev } from "./record";
import { discoverRoots } from "./roots";
import { classifyPath } from "./snapshot";
import { applyDependencyRules } from "./rules";
import { buildPlanFor, draftsForRoot, type Draft } from "./services";
import { langOf, scanConfigSecrets, scanSourceFile } from "./sources";
import { basename, compareStrings, joinPath, lowerConfidence } from "./text";
import { slugify, uniqueName } from "@/lib/importers/types";
import type { AppRequirements, Confidence, Evidence, Inference, MonorepoInfo, RepoSnapshot, ServiceCandidate } from "./types";

const MAX_ROOTS = 100;
const MAX_SOURCE_BYTES = 24 * 1024 * 1024;

const KIND_ORDER: Record<string, number> = { web: 0, static: 1, worker: 2, cron: 3 };

function newCtx(idx: RepoIndex, roots: Root[]): Ctx {
  return {
    idx,
    roots,
    facts: new Map(),
    runtimes: new Bucket(),
    frameworks: new Bucket(),
    datastores: new Bucket(),
    migrations: new Bucket(),
    healthEndpoints: new Bucket(),
    infrastructure: new Bucket(),
    findings: new Bucket(),
    envs: new Map(),
    extraServices: [],
    unknowns: new Set(),
    risks: new Set(),
  };
}

function pickDockerfiles(f: RootFacts): string[] {
  const depth = (p: string): number => p.slice(f.root.dir === "" ? 0 : f.root.dir.length + 1).split("/").length;
  return [...f.fileSet]
    .filter((p) => isDockerfileName(basename(p)))
    .sort((a, b) => depth(a) - depth(b) || (basename(a).toLowerCase() === "dockerfile" ? 0 : 1) - (basename(b).toLowerCase() === "dockerfile" ? 0 : 1) || compareStrings(a, b));
}

/** Datastores, migrations and env names of a workspace library flow to the services that depend on it. */
function inheritFromWorkspaceLibraries(ctx: Ctx, serviceRoots: Set<string>): void {
  const byName = new Map<string, string>();
  for (const [dir, f] of ctx.facts) if (f.pkg?.name) byName.set(f.pkg.name, dir);
  if (byName.size < 2) return;
  const localDeps = (dir: string): string[] => {
    const f = ctx.facts.get(dir);
    if (!f) return [];
    return [...f.deps.values()]
      .filter((d) => d.eco === "npm" && byName.has(d.name) && byName.get(d.name) !== dir)
      .map((d) => byName.get(d.name)!)
      .sort();
  };
  for (const service of [...serviceRoots].sort()) {
    const seen = new Set<string>([service]);
    let frontier = [service];
    for (let depth = 0; depth < 4 && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const dir of frontier) {
        for (const lib of localDeps(dir)) {
          if (seen.has(lib)) continue;
          seen.add(lib);
          next.push(lib);
        }
      }
      frontier = next;
    }
    seen.delete(service);
    for (const lib of [...seen].sort()) {
      const pkgPath = ctx.facts.get(service)?.pkg?.path ?? joinPath(service, "package.json");
      const via = ev(pkgPath, `workspace-dep:${ctx.facts.get(lib)?.pkg?.name ?? lib}`);
      for (const d of ctx.datastores.entries().filter((e) => e.value.root === lib)) {
        addDatastore(ctx, service, d.value.kind, lowerConfidence(d.confidence), via, { engine: d.value.engine, role: d.value.role });
      }
      for (const m of ctx.migrations.entries().filter((e) => e.value.root === lib)) {
        ctx.migrations.add(`${m.value.tool}\u0000${service}`, { ...m.value, root: service }, lowerConfidence(m.confidence), [...m.evidence, via]);
      }
      for (const e of ctx.envs.values()) if (e.acc.roots.has(lib)) e.acc.roots.add(service);
    }
  }
}

const SECURITY_SKIPS: Record<string, string> = {
  traversal: "path traversal",
  absolute_path: "absolute path",
  bad_path: "unsafe path",
  symlink: "symbolic link",
  hardlink: "hard link",
  special_entry: "device or special entry",
};

export function analyzeRepository(snapshot: RepoSnapshot): AppRequirements {
  const idx = new RepoIndex(snapshot);
  let roots = discoverRoots(idx.paths);
  const ctx = newCtx(idx, roots);
  if (roots.length > MAX_ROOTS) {
    roots = roots.slice(0, MAX_ROOTS);
    ctx.roots = roots;
    ctx.unknowns.add(`The repository has more than ${MAX_ROOTS} project directories; only the first ${MAX_ROOTS} were analysed.`);
  }
  for (const r of roots) ctx.facts.set(r.dir, newFacts(r));
  for (const path of idx.paths) ctx.facts.get(ownerOf(roots, path).dir)!.fileSet.add(path);
  const ordered = roots.map((r) => ctx.facts.get(r.dir)!);

  /* manifests, then rules over the dependencies they declared */
  for (const f of ordered) {
    readDependencies(ctx, f);
    applyDependencyRules(ctx, f);
  }
  /* Dockerfile, Procfile, framework configs */
  for (const f of ordered) {
    const dockerfiles = pickDockerfiles(f);
    if (dockerfiles.length > 0) {
      readDockerfile(ctx, f, dockerfiles[0]);
      f.otherDockerfiles = dockerfiles.slice(1);
      for (const other of f.otherDockerfiles) ctx.infrastructure.add(`dockerfile\u0000${other}`, { kind: "dockerfile", path: other }, "high", ev(other, "file:Dockerfile"));
    }
    const procfile = joinPath(f.root.dir, "Procfile");
    if (idx.has(procfile)) readProcfile(ctx, f, procfile);
    readFrameworkConfigs(ctx, f);
  }
  /* source scan under a byte budget */
  let scanned = 0;
  for (const f of ordered) {
    for (const path of [...f.fileSet].sort()) {
      if (!langOf(path)) continue;
      const content = idx.get(path) ?? "";
      if (scanned + content.length > MAX_SOURCE_BYTES) {
        ctx.unknowns.add(`Source scanning stopped after ${MAX_SOURCE_BYTES} bytes; later files were not scanned.`);
        break;
      }
      scanned += content.length;
      scanSourceFile(ctx, f, path, content);
    }
  }
  /* deployment configs (compose, terraform, env files, vercel, fly, render, k8s ...) */
  readRepoConfigs(ctx, idx.paths);
  for (const path of idx.paths) if (classifyPath(path) === "config") scanConfigSecrets(ctx, path, idx.get(path) ?? "");
  for (const f of ordered) for (const m of detectMigrations(ctx, f)) ctx.migrations.add(`${m.tool}\u0000${f.root.dir}`, { root: f.root.dir, tool: m.tool, command: m.command, ...(m.note ? { note: m.note } : {}) }, m.conf, m.evidence);

  /* services */
  const drafts: Draft[] = [];
  for (const f of ordered) drafts.push(...draftsForRoot(ctx, f));
  for (const x of ctx.extraServices) {
    drafts.push({
      name: x.name,
      root: x.root,
      kind: x.kind,
      confidence: "medium",
      evidence: [x.evidence],
      image: x.image,
      ...(x.command ? { start: { value: x.command, confidence: "medium", evidence: [x.evidence] } } : {}),
      ...(x.port !== undefined ? { port: { value: x.port, confidence: "medium", evidence: [x.evidence] } } : {}),
      ...(x.healthPath ? { healthPath: { value: x.healthPath, confidence: "high", evidence: [x.evidence] } } : {}),
    });
  }
  drafts.sort((a, b) => compareStrings(a.root, b.root) || (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || compareStrings(a.name, b.name));
  const taken: string[] = [];
  for (const d of drafts) {
    d.name = uniqueName(slugify(d.name, "service"), taken);
    taken.push(d.name);
  }
  const serviceRoots = new Set(drafts.filter((d) => !d.image).map((d) => d.root));
  inheritFromWorkspaceLibraries(ctx, serviceRoots);

  const services: Inference<ServiceCandidate>[] = drafts.map((d) => ({
    value: {
      name: d.name,
      root: d.root,
      kind: d.kind,
      ...(d.start ? { startCommand: { ...d.start, evidence: mergeEvidence(d.start.evidence) } } : {}),
      ...(d.port ? { port: { ...d.port, evidence: mergeEvidence(d.port.evidence) } } : {}),
      ...(d.healthPath ? { healthPath: { ...d.healthPath, evidence: mergeEvidence(d.healthPath.evidence) } } : {}),
      ...(d.schedule ? { schedule: { ...d.schedule, evidence: mergeEvidence(d.schedule.evidence) } } : {}),
      ...(d.image ? { image: d.image } : {}),
      ...(d.inProcess ? { inProcess: true } : {}),
      ...(d.target ? { target: d.target } : {}),
      ...(d.note ? { note: d.note } : {}),
    },
    confidence: d.confidence,
    evidence: mergeEvidence(d.evidence),
  }));

  /* build plans, health endpoints, per-service gaps */
  const builds: AppRequirements["builds"] = [];
  for (const dir of [...serviceRoots].sort()) {
    const f = ctx.facts.get(dir)!;
    const hasStatic = drafts.some((d) => d.root === dir && d.kind === "static");
    const plan = buildPlanFor(ctx, f, hasStatic);
    builds.push(plan);
    if (plan.value.strategy === "buildpack" || plan.value.strategy === "unknown") ctx.risks.add(`No Dockerfile at ${rootWhere(dir)}: the build recipe is inferred, not verified by a build.`);
    for (const r of ctx.runtimes.entries().filter((e) => e.value.root === dir && e.value.version === undefined)) {
      if (!ctx.runtimes.entries().some((o) => o.value.root === dir && o.value.language === r.value.language && o.value.version !== undefined)) ctx.unknowns.add(`The ${r.value.language} version is not pinned at ${rootWhere(dir)}.`);
    }
  }
  for (const d of drafts) {
    const label = `${d.name} (${rootLabel(d.root)})`;
    if (d.kind === "web") {
      if (!d.port) ctx.unknowns.add(`The listening port of ${label} could not be determined.`);
      if (!d.healthPath) ctx.risks.add(`No health endpoint found for ${label}: add /healthz or configure one so deployments can be verified.`);
      if (!d.start && !d.image) ctx.unknowns.add(`The start command of ${label} could not be determined.`);
    } else if ((d.kind === "worker" || d.kind === "cron") && !d.start && !d.inProcess && !d.target && !d.image) {
      ctx.unknowns.add(`The start command of ${label} could not be determined.`);
    }
    if (d.kind === "cron" && !d.schedule && !d.inProcess) ctx.unknowns.add(`The schedule of ${label} could not be determined as a cron expression.`);
    if (d.kind === "web" && d.healthPath) ctx.healthEndpoints.add(`${d.root}\u0000${d.healthPath.value}`, { root: d.root, path: d.healthPath.value }, d.healthPath.confidence, d.healthPath.evidence);
  }
  for (const f of ordered) for (const h of f.healths) ctx.healthEndpoints.add(`${f.root.dir}\u0000${h.path}`, { root: f.root.dir, path: h.path }, h.declared ? "high" : "medium", h.evidence);
  if (drafts.length === 0) ctx.unknowns.add("No deployable service was detected (no web server, worker, scheduler, static site or Dockerfile).");

  /* environment variables */
  const envVars: AppRequirements["envVars"] = [...ctx.envs.values()]
    .sort((a, b) => compareStrings(a.acc.name, b.acc.name))
    .map((e) => ({
      value: {
        name: e.acc.name,
        classification: e.acc.secret ? ("secret" as const) : ("config" as const),
        roots: [...e.acc.roots].sort(),
        ...(!e.acc.secret && e.acc.defaults.size === 1 && !e.acc.conflicted ? { defaultValue: [...e.acc.defaults][0] } : {}),
      },
      confidence: e.confidence,
      evidence: mergeEvidence([...e.evidence.values()], 3),
    }));

  /* monorepo */
  const monorepo = monorepoOf(ctx, ordered, serviceRoots);

  /* snapshot-level risks */
  if (snapshot.truncated || idx.dropped > 0) ctx.risks.add("The repository exceeded an intake limit, so this analysis is partial.");
  const refused = (snapshot.skipped ?? []).filter((s) => SECURITY_SKIPS[s.reason] !== undefined);
  if (refused.length > 0) {
    const parts = refused.map((s) => `${s.count} ${SECURITY_SKIPS[s.reason]}${s.count === 1 ? "" : "s"}`);
    ctx.risks.add(`The archive contained entries that were refused and never read: ${parts.join(", ")}.`);
  }
  const oversize = (snapshot.skipped ?? []).find((s) => s.reason === "oversize");
  if (oversize) ctx.unknowns.add(`${oversize.count} file(s) larger than the per-file limit were skipped and not analysed.`);

  const out: AppRequirements = {
    schemaVersion: 1,
    source: snapshot.source,
    truncated: snapshot.truncated === true || idx.dropped > 0,
    fileCount: idx.paths.length,
    runtimes: ctx.runtimes.list(),
    frameworks: ctx.frameworks.list(),
    services,
    builds,
    datastores: ctx.datastores.list(),
    migrations: ctx.migrations.list(),
    healthEndpoints: ctx.healthEndpoints.list(),
    envVars,
    infrastructure: ctx.infrastructure.list(),
    ...(monorepo ? { monorepo } : {}),
    findings: ctx.findings.list(),
    unknowns: [...ctx.unknowns].sort(compareStrings),
    risks: [...ctx.risks].sort(compareStrings),
  };
  return out;
}

/* -------------------------------- monorepo --------------------------------- */

function monorepoOf(ctx: Ctx, ordered: RootFacts[], serviceRoots: Set<string>): Inference<MonorepoInfo> | undefined {
  const evidence: Evidence[] = [];
  let tool: string | undefined;
  let confidence: Confidence = "medium";
  const rootFacts = ctx.facts.get("");
  const at = (name: string): boolean => ctx.idx.has(name);
  const signals: [string, string, string][] = [
    ["turbo.json", "turborepo", "file:turbo.json"],
    ["nx.json", "nx", "file:nx.json"],
    ["lerna.json", "lerna", "file:lerna.json"],
    ["rush.json", "rush", "file:rush.json"],
    ["pnpm-workspace.yaml", "pnpm workspaces", "file:pnpm-workspace.yaml"],
  ];
  for (const [file, name, rule] of signals) {
    if (at(file)) {
      tool ??= name;
      evidence.push(ev(file, rule));
    }
  }
  if (rootFacts?.pkg?.workspaces && rootFacts.pkg.workspaces.length > 0) {
    tool ??= rootFacts.pkg.packageManager?.startsWith("yarn") ? "yarn workspaces" : "npm workspaces";
    evidence.push(ev(rootFacts.pkg.path, "package.json:workspaces"));
  }
  const packageRoots = ordered.filter((f) => f.root.dir !== "" && (f.pkg !== undefined || serviceRoots.has(f.root.dir)));
  if (tool) confidence = "high";
  else if (serviceRoots.size >= 2 || packageRoots.length >= 2) {
    tool = "multiple-manifests";
    for (const f of packageRoots.slice(0, 4)) evidence.push(ev(f.pkg?.path ?? joinPath(f.root.dir, "package.json"), "multiple-project-roots"));
  } else return undefined;
  if (packageRoots.length === 0 && confidence !== "high") return undefined;
  const packages = packageRoots.map((f) => ({ name: f.pkg?.name ?? (rootBase(f.root.dir) || "root"), root: f.root.dir }));
  for (const f of packageRoots.slice(0, 4)) if (f.pkg && evidence.length < 6) evidence.push(ev(f.pkg.path, "workspace-package"));
  return { value: { tool, packages }, confidence, evidence: mergeEvidence(evidence) };
}

