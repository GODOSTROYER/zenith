/**
 * From per-root facts to service candidates and build plans.
 *
 * The rules, in order of trust:
 *   1. an explicit process declaration (Procfile, compose, render, fly);
 *   2. the Dockerfile (what the image runs and EXPOSEs);
 *   3. a framework dependency or a server call in code;
 *   4. a conventional default for the framework, marked `low`.
 * Every choice keeps the evidence that led to it; ties resolve in that order
 * so the result is deterministic.
 */
import { slugify } from "@/lib/importers/types";
import { mergeEvidence, rootBase, rootLabel, rootWhere, type Ctx, type RootFacts } from "./model";
import { ev } from "./record";
import { confidenceRank, joinPath, sanitizeInline } from "./text";
import type { BuildPlan, Confidence, Evidence, Inference, Language, ServiceCandidate } from "./types";

const WORKER_CMD = /\b(?:celery\b.{0,80}\bworker|sidekiq|resque|rq worker|dramatiq|bullmq|delayed_job|horizon|asynq|queue:work|worker\.(?:js|py|rb))\b/i;
const CRON_CMD = /\bcelery\b.{0,80}\bbeat\b|\bclock(?:work)?\b|\bwhenever\b|\bscheduler\b|\bschedule:work\b/i;

const SAFE_TOKEN = /^[A-Za-z0-9._/-]{1,100}$/;

type ProcKind = "web" | "worker" | "cron" | "release";

function classifyProcess(type: string, command: string): ProcKind {
  if (type === "release") return "release";
  if (type === "web" || type.startsWith("web-") || type.startsWith("web_")) return "web";
  if (CRON_CMD.test(command) || /^(?:clock|scheduler|cron|beat)$/.test(type)) return "cron";
  return "worker";
}

interface Draft {
  name: string;
  root: string;
  kind: ServiceCandidate["kind"];
  confidence: Confidence;
  evidence: Evidence[];
  start?: Inference<string>;
  port?: Inference<number>;
  healthPath?: Inference<string>;
  schedule?: Inference<string>;
  image?: string;
  inProcess?: boolean;
  target?: string;
  note?: string;
}

const best = <T extends { conf: Confidence }>(list: T[]): T | undefined => [...list].sort((a, b) => confidenceRank(b.conf) - confidenceRank(a.conf))[0];

/* ---------------------------------- port ----------------------------------- */

function choosePort(ctx: Ctx, f: RootFacts, label: string): Inference<number> | undefined {
  const cands = [...f.ports];
  for (const fw of f.webFrameworks) if (fw.defaultPort !== undefined) cands.push({ port: fw.defaultPort, rank: 1, source: `${fw.name} default`, evidence: fw.evidence });
  if (cands.length === 0) return undefined;
  cands.sort((a, b) => b.rank - a.rank || a.port - b.port);
  const top = cands[0];
  const same = cands.filter((c) => c.port === top.port);
  const agreeing = new Set(same.filter((c) => c.rank >= 2).map((c) => c.source)).size;
  let confidence: Confidence = top.rank >= 5 ? "high" : top.rank >= 3 ? (agreeing >= 2 ? "high" : "medium") : top.rank === 2 ? "low" : "low";
  if (top.rank === 4 && agreeing >= 2) confidence = "high";
  if (top.rank === 4 && agreeing < 2) confidence = "medium";
  for (const other of cands) {
    if (other.port !== top.port && other.rank >= 3 && top.rank >= 3) ctx.risks.add(`Port mismatch in ${label}: ${top.source} says ${top.port} but ${other.source} says ${other.port}. ${top.port} was used; check which is right.`);
  }
  return { value: top.port, confidence, evidence: mergeEvidence(same.map((c) => c.evidence)) };
}

/* ---------------------------------- health --------------------------------- */

const HEALTH_ORDER = ["/health", "/healthz", "/api/health", "/up", "/_health", "/readyz", "/livez", "/api/healthz", "/actuator/health"];

function chooseHealth(f: RootFacts): Inference<string> | undefined {
  if (f.healths.length === 0) return undefined;
  const declared = f.healths.filter((h) => h.declared);
  const pool = declared.length > 0 ? declared : f.healths;
  const rank = (p: string): number => {
    const i = HEALTH_ORDER.indexOf(p.replace(/\/$/, ""));
    return i === -1 ? HEALTH_ORDER.length : i;
  };
  const top = [...pool].sort((a, b) => rank(a.path) - rank(b.path) || (a.path < b.path ? -1 : 1))[0];
  const same = f.healths.filter((h) => h.path === top.path);
  return { value: top.path, confidence: declared.length > 0 ? "high" : "medium", evidence: mergeEvidence(same.map((h) => h.evidence)) };
}

/* ------------------------------- start commands ---------------------------- */

interface Cmd {
  command: string;
  conf: Confidence;
  evidence: Evidence;
}

const pyWsgi = (f: RootFacts): string | undefined => {
  const p = [...f.fileSet].sort().find((x) => /(?:^|\/)wsgi\.py$/.test(x));
  if (!p) return undefined;
  const rel = f.root.dir === "" ? p : p.slice(f.root.dir.length + 1);
  const mod = rel.replace(/\.py$/, "").split("/").join(".");
  return SAFE_TOKEN.test(mod) ? mod : undefined;
};

function webRecipes(f: RootFacts, port: number | undefined): Cmd[] {
  const out: Cmd[] = [];
  const p = port ?? 8000;
  const dep = (k: string) => f.deps.get(k);
  const next = dep("npm:next");
  if (next && !f.pkg?.scripts.has("start")) out.push({ command: "npx next start", conf: "medium", evidence: next.evidence });
  if (f.pkg?.main && SAFE_TOKEN.test(f.pkg.main) && !f.pkg.scripts.has("start")) out.push({ command: `node ${f.pkg.main}`, conf: "low", evidence: ev(f.pkg.path, "package.json:main") });
  const fastapi = f.pyApps.find((a) => a.kind === "fastapi");
  if (fastapi && SAFE_TOKEN.test(fastapi.module) && SAFE_TOKEN.test(fastapi.variable)) out.push({ command: `uvicorn ${fastapi.module}:${fastapi.variable} --host 0.0.0.0 --port ${p}`, conf: "medium", evidence: fastapi.evidence });
  const wsgi = dep("pip:django") ? pyWsgi(f) : undefined;
  if (wsgi) out.push({ command: `gunicorn ${wsgi}:application --bind 0.0.0.0:${p}`, conf: dep("pip:gunicorn") ? "medium" : "low", evidence: dep("pip:django")!.evidence });
  const flask = f.pyApps.find((a) => a.kind === "flask");
  if (flask && SAFE_TOKEN.test(flask.module) && SAFE_TOKEN.test(flask.variable)) out.push({ command: `gunicorn ${flask.module}:${flask.variable} --bind 0.0.0.0:${p}`, conf: dep("pip:gunicorn") ? "medium" : "low", evidence: flask.evidence });
  const rails = dep("gem:rails");
  if (rails) out.push({ command: f.fileSet.has(joinPath(f.root.dir, "config/puma.rb")) ? "bundle exec puma -C config/puma.rb" : `bundle exec rails server -b 0.0.0.0 -p ${p}`, conf: "medium", evidence: rails.evidence });
  const sinatra = dep("gem:sinatra");
  if (sinatra && f.fileSet.has(joinPath(f.root.dir, "config.ru"))) out.push({ command: `bundle exec rackup -o 0.0.0.0 -p ${p}`, conf: "medium", evidence: sinatra.evidence });
  const spring = f.webFrameworks.find((w) => w.name === "Spring Boot");
  if (spring) out.push({ command: f.root.markers.has("pom.xml") ? "java -jar target/*.jar" : "java -jar build/libs/*.jar", conf: "medium", evidence: spring.evidence });
  const gomod = joinPath(f.root.dir, "go.mod");
  if (f.hasMainGo && f.fileSet.has(gomod)) out.push({ command: "./app", conf: "medium", evidence: ev(gomod, "file:go.mod") });
  const laravel = dep("composer:laravel/framework");
  if (laravel) out.push({ command: `php artisan serve --host=0.0.0.0 --port=${p}`, conf: "low", evidence: laravel.evidence });
  return out;
}

function chooseStart(f: RootFacts, procWeb: { command: string; line: number } | undefined, port: number | undefined): Inference<string> | undefined {
  const cands: Cmd[] = [];
  if (procWeb && f.procfile) cands.push({ command: procWeb.command, conf: "high", evidence: ev(f.procfile.path, "procfile:web", procWeb.line) });
  const d = f.dockerfile;
  if (d && (d.cmd || d.entrypoint)) {
    const text = sanitizeInline([d.entrypoint?.text, d.cmd?.text].filter(Boolean).join(" "), 300);
    cands.push({ command: text, conf: "high", evidence: ev(d.path, d.cmd ? "dockerfile:CMD" : "dockerfile:ENTRYPOINT", (d.cmd ?? d.entrypoint)!.line) });
  }
  const script = f.pkg?.scripts.get("start");
  if (script !== undefined && f.pkg) cands.push({ command: "npm start", conf: "high", evidence: ev(f.pkg.path, "script:start") });
  for (const s of f.starts) cands.push({ command: s.command, conf: s.confidence, evidence: s.evidence });
  cands.push(...webRecipes(f, port));
  const top = best(cands.map((c) => ({ ...c, conf: c.conf })));
  return top ? { value: top.command, confidence: top.conf, evidence: mergeEvidence([top.evidence]) } : undefined;
}

function workerRecipe(f: RootFacts, tech: string): Cmd | undefined {
  if (tech === "celery") {
    const app = f.pyApps.find((a) => a.kind === "celery");
    if (app && SAFE_TOKEN.test(app.module)) return { command: `celery -A ${app.module} worker --loglevel=info`, conf: "medium", evidence: app.evidence };
  }
  if (tech === "celery-beat") {
    const app = f.pyApps.find((a) => a.kind === "celery");
    if (app && SAFE_TOKEN.test(app.module)) return { command: `celery -A ${app.module} beat --loglevel=info`, conf: "medium", evidence: app.evidence };
  }
  return undefined;
}

/* ---------------------------------- drafts --------------------------------- */

const nameFor = (root: string, suffix: string): string => {
  const base = rootBase(root);
  const slug = slugify(suffix, "service");
  return base === "" ? slug : slugify(`${base}-${slug}`, "service");
};

/** In-process workers share the web server's file; there is nothing separate to deploy. */
function draftsForRoot(ctx: Ctx, f: RootFacts): Draft[] {
  const drafts: Draft[] = [];
  const dir = f.root.dir;
  const proc = f.procfile?.entries ?? [];
  const procWeb = proc.find((e) => classifyProcess(e.type, e.command) === "web");
  const procOthers = proc.filter((e) => {
    const k = classifyProcess(e.type, e.command);
    return k === "worker" || k === "cron";
  });

  /* web / static */
  const webSigs: { conf: Confidence; evidence: Evidence }[] = [];
  const staticSigs: { conf: Confidence; evidence: Evidence }[] = [];
  if (procWeb && f.procfile) webSigs.push({ conf: "high", evidence: ev(f.procfile.path, "procfile:web", procWeb.line) });
  const d = f.dockerfile;
  const dockerCmd = d ? `${d.entrypoint?.text ?? ""} ${d.cmd?.text ?? ""}` : "";
  if (d && !WORKER_CMD.test(dockerCmd) && !CRON_CMD.test(dockerCmd)) webSigs.push({ conf: d.expose.length > 0 ? "high" : "medium", evidence: d.expose.length > 0 ? ev(d.path, "dockerfile:EXPOSE", d.expose[0].line) : ev(d.path, "file:Dockerfile") });
  for (const fw of f.webFrameworks) webSigs.push({ conf: fw.confidence, evidence: fw.evidence });
  if (f.listenFiles.size > 0) webSigs.push({ conf: "medium", evidence: ev([...f.listenFiles].sort()[0], "listen-call") });
  if (f.ports.some((p) => p.source === "compose ports")) webSigs.push({ conf: "medium", evidence: f.ports.find((p) => p.source === "compose ports")!.evidence });
  for (const s of f.staticFrameworks) staticSigs.push({ conf: s.confidence, evidence: s.evidence });
  if (webSigs.length === 0 && staticSigs.length === 0 && f.pkg?.scripts.has("start")) webSigs.push({ conf: "low", evidence: ev(f.pkg.path, "script:start") });
  if (webSigs.length === 0 && staticSigs.length === 0 && f.root.markers.has("index.html") && dir === "" && proc.length === 0) staticSigs.push({ conf: "low", evidence: ev("index.html", "file:index.html") });

  const webBest = best(webSigs);
  const staticBest = best(staticSigs);
  const isStatic = staticBest !== undefined && (webBest === undefined || confidenceRank(staticBest.conf) > confidenceRank(webBest.conf));
  const primary = isStatic ? staticBest : webBest;
  let webName: string | undefined;
  if (primary) {
    const kind = isStatic ? "static" : "web";
    const sigs = isStatic ? staticSigs : webSigs;
    const label = `${rootLabel(dir)} (${kind})`;
    const port = kind === "web" ? choosePort(ctx, f, label) : undefined;
    const draft: Draft = {
      name: dir === "" ? "web" : slugify(rootBase(dir), "web"),
      root: dir,
      kind,
      confidence: primary.conf,
      evidence: mergeEvidence(sigs.map((s) => s.evidence)),
      ...(kind === "web" ? { start: chooseStart(f, procWeb, port?.value), port, healthPath: chooseHealth(f) } : {}),
    };
    drafts.push(draft);
    webName = draft.name;
  }

  /* workers */
  if (procOthers.length > 0 && f.procfile) {
    for (const e of procOthers) {
      const kind = classifyProcess(e.type, e.command) as "worker" | "cron";
      drafts.push({
        name: nameFor(dir, e.type),
        root: dir,
        kind,
        confidence: "high",
        evidence: [ev(f.procfile.path, `procfile:${e.type}`, e.line)],
        start: { value: e.command, confidence: "high", evidence: [ev(f.procfile.path, `procfile:${e.type}`, e.line)] },
      });
    }
  } else {
    const seen = new Set<string>();
    const signals = [...f.workers].sort((a, b) => confidenceRank(b.confidence) - confidenceRank(a.confidence) || (a.tech < b.tech ? -1 : a.tech > b.tech ? 1 : 0) || (a.command ?? "").localeCompare(b.command ?? ""));
    for (const w of signals) {
      const key = `${w.tech}\u0000${w.command ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (w.file && f.listenFiles.has(w.file) && webName) {
        ctx.unknowns.add(`The ${w.tech} worker in ${w.file} runs in the same file as the web server, so it is treated as part of ${webName}, not a separate worker service.`);
        continue;
      }
      const script = f.pkg?.scripts.has("worker") && f.pkg ? { command: "npm run worker", conf: "high" as Confidence, evidence: ev(f.pkg.path, "script:worker") } : undefined;
      const recipe = w.command ? { command: w.command, conf: w.confidence, evidence: w.evidence } : (script ?? workerRecipe(f, w.tech));
      let start: Inference<string> | undefined = recipe ? { value: recipe.command, confidence: recipe.conf, evidence: [recipe.evidence] } : undefined;
      if (!start && w.file && /\.(?:js|mjs|cjs)$/.test(w.file) && SAFE_TOKEN.test(w.file)) start = { value: `node ${w.file}`, confidence: "low", evidence: [ev(w.file, `${w.tech}-entrypoint`)] };
      const dockerWorkerOnly = !primary && d && WORKER_CMD.test(dockerCmd);
      drafts.push({
        name: nameFor(dir, drafts.some((x) => x.kind === "worker") ? `worker-${w.tech}` : "worker"),
        root: dir,
        kind: "worker",
        confidence: dockerWorkerOnly ? "high" : w.confidence,
        evidence: [w.evidence],
        ...(start ? { start } : {}),
      });
    }
    if (!primary && d && WORKER_CMD.test(dockerCmd) && !drafts.some((x) => x.kind === "worker")) {
      drafts.push({ name: nameFor(dir, "worker"), root: dir, kind: "worker", confidence: "high", evidence: [ev(d.path, "dockerfile:CMD", (d.cmd ?? d.entrypoint)?.line)], start: { value: sanitizeInline(dockerCmd, 300), confidence: "high", evidence: [ev(d.path, "dockerfile:CMD", (d.cmd ?? d.entrypoint)?.line)] } });
    }
  }

  /* cron */
  if (procOthers.length === 0 || !f.procfile) {
    const seen = new Set<string>();
    const sorted = [...f.crons].sort((a, b) => (a.mechanism < b.mechanism ? -1 : a.mechanism > b.mechanism ? 1 : 0) || (a.schedule ?? "").localeCompare(b.schedule ?? "") || (a.target ?? "").localeCompare(b.target ?? ""));
    let inProcessDone = false;
    for (const c of sorted) {
      if (c.inProcess) {
        if (inProcessDone) continue;
        inProcessDone = true;
        drafts.push({
          name: nameFor(dir, "scheduler"),
          root: dir,
          kind: "cron",
          confidence: c.confidence,
          evidence: [c.evidence],
          inProcess: true,
          ...(c.schedule ? { schedule: { value: c.schedule, confidence: "medium" as Confidence, evidence: [c.evidence] } } : {}),
          note: `${c.mechanism} runs inside another service's process; every replica of that service will fire it.`,
        });
        ctx.risks.add(`In-process scheduler (${c.mechanism}) at ${c.evidence.path}: it runs inside the web process, so with more than one replica each job fires once per replica.`);
        continue;
      }
      const key = c.target ? `${c.mechanism}\u0000${c.target}\u0000${c.schedule ?? ""}` : `${c.mechanism}\u0000${c.schedule ?? ""}`;
      if (seen.has(key) && !c.target) continue;
      seen.add(key);
      const command = c.command ?? workerRecipe(f, c.mechanism)?.command;
      drafts.push({
        name: nameFor(dir, c.target ? `cron-${c.target.replace(/[?].*$/, "")}` : c.mechanism),
        root: dir,
        kind: "cron",
        confidence: c.confidence,
        evidence: [c.evidence],
        ...(c.schedule ? { schedule: { value: c.schedule, confidence: c.confidence, evidence: [c.evidence] } } : {}),
        ...(command ? { start: { value: command, confidence: "medium" as Confidence, evidence: [c.evidence] } } : {}),
        ...(c.target ? { target: c.target, note: `Calls ${c.target} on the web service on this schedule.` } : {}),
      });
    }
  }
  return drafts;
}

/* ---------------------------------- builds --------------------------------- */

const inDir = (dir: string, name: string): string => joinPath(dir, name);

function viteOutDir(ctx: Ctx, f: RootFacts): string | undefined {
  const cfg = [...f.fileSet].sort().find((p) => /(?:^|\/)vite\.config\.[cm]?[jt]s$/.test(p) && p.split("/").length === (f.root.dir === "" ? 1 : f.root.dir.split("/").length + 1));
  const m = cfg ? /\boutDir\s{0,4}:\s{0,4}["']([A-Za-z0-9._/-]{1,60})["']/.exec(ctx.idx.get(cfg) ?? "") : null;
  return m?.[1];
}

function nodeInstall(f: RootFacts): { install: string; runner: string } {
  const has = (n: string) => f.fileSet.has(inDir(f.root.dir, n));
  if (has("pnpm-lock.yaml") || f.pkg?.packageManager?.startsWith("pnpm")) return { install: "pnpm install --frozen-lockfile", runner: "pnpm run" };
  if (has("yarn.lock") || f.pkg?.packageManager?.startsWith("yarn")) return { install: "yarn install --frozen-lockfile", runner: "yarn" };
  if (has("package-lock.json")) return { install: "npm ci", runner: "npm run" };
  return { install: "npm install", runner: "npm run" };
}

function pythonInstall(ctx: Ctx, f: RootFacts): string | undefined {
  const has = (n: string) => f.fileSet.has(inDir(f.root.dir, n));
  const pyproject = ctx.idx.get(inDir(f.root.dir, "pyproject.toml")) ?? "";
  if (has("uv.lock")) return "uv sync --frozen";
  if (has("poetry.lock") || /^\[tool\.poetry\]/m.test(pyproject)) return "poetry install --no-root --only main";
  if (has("Pipfile.lock") || has("Pipfile")) return "pipenv install --deploy";
  if ([...f.fileSet].some((p) => /(?:^|\/)requirements\.txt$/.test(p) && p === inDir(f.root.dir, "requirements.txt"))) return "pip install -r requirements.txt";
  if (/^\[project\]/m.test(pyproject)) return "pip install .";
  return undefined;
}

export function buildPlanFor(ctx: Ctx, f: RootFacts, hasStatic: boolean): Inference<BuildPlan> {
  const dir = f.root.dir;
  const d = f.dockerfile;
  if (d) {
    const others = f.otherDockerfiles.length > 0 ? ` ${f.otherDockerfiles.length} other Dockerfile(s) exist in this directory tree and were not chosen.` : "";
    return {
      value: { root: dir, strategy: "dockerfile", dockerfile: d.path, needsDockerfile: false, note: `${d.path} builds the image; Zenith builds it in the customer's own account, not in the control plane.${others}` },
      confidence: f.otherDockerfiles.length > 0 ? "medium" : "high",
      evidence: [ev(d.path, "file:Dockerfile")],
    };
  }
  const evidenceFor = (path: string, rule: string): Evidence[] => [ev(path, rule)];
  const scripts = f.pkg?.scripts;

  if (f.pkg && hasStatic) {
    const { install, runner } = nodeInstall(f);
    const hosted = f.hosting?.outputDir;
    const outputDir = hosted ?? viteOutDir(ctx, f) ?? (f.staticFrameworks.some((s) => s.name === "Create React App") ? "build" : "dist");
    const build = f.hosting?.buildCommand ?? (scripts?.has("build") ? `${runner} build` : undefined);
    return {
      value: { root: dir, strategy: "static", language: "node", installCommand: f.hosting?.installCommand ?? install, ...(build ? { buildCommand: build } : {}), outputDir, needsDockerfile: false, note: `Static single-page app: build with the package's build script and publish ${outputDir}/.` },
      confidence: build ? "medium" : "low",
      evidence: evidenceFor(f.pkg.path, "buildpack:node-static"),
    };
  }
  if (!d && dir === "" && f.root.markers.has("index.html") && !f.pkg) {
    return { value: { root: dir, strategy: "static", outputDir: ".", needsDockerfile: false, note: "A plain index.html at the repository root: serve the directory as-is." }, confidence: "low", evidence: [ev("index.html", "file:index.html")] };
  }
  if (f.pkg) {
    const { install, runner } = nodeInstall(f);
    const build = scripts?.has("build") ? `${runner} build` : undefined;
    const known = build !== undefined || scripts?.has("start") === true;
    return {
      value: { root: dir, strategy: "buildpack", language: "node", installCommand: install, ...(build ? { buildCommand: build } : {}), needsDockerfile: false, note: "Inferred Node.js recipe (package.json scripts); not verified by a build." },
      confidence: known ? "medium" : "low",
      evidence: evidenceFor(f.pkg.path, "buildpack:node"),
    };
  }
  const has = (k: string) => [...f.deps.keys()].some((x) => x.startsWith(k));
  const py = [...f.fileSet].some((p) => /(?:^|\/)(?:requirements[^/]{0,60}\.txt|pyproject\.toml|Pipfile|setup\.py)$/.test(p) && p.startsWith(dir === "" ? "" : `${dir}/`)) || has("pip:");
  if (py) {
    const install = pythonInstall(ctx, f);
    if (install) {
      const ref = [...f.deps.values()].find((x) => x.eco === "pip")?.evidence ?? ev(inDir(dir, "requirements.txt"), "file:requirements.txt");
      return { value: { root: dir, strategy: "buildpack", language: "python", installCommand: install, needsDockerfile: false, note: "Inferred Python recipe (dependency manifest); not verified by a build." }, confidence: "medium", evidence: [ref] };
    }
  }
  const gomod = inDir(dir, "go.mod");
  if (ctx.idx.has(gomod)) {
    const mainDir = f.goMainDirs.includes(dir) ? "." : f.goMainDirs.length > 0 ? `./${(f.goMainDirs.sort()[0] ?? "").slice(dir === "" ? 0 : dir.length + 1)}` : "./...";
    return { value: { root: dir, strategy: "buildpack", language: "go", installCommand: "go mod download", buildCommand: `go build -o app ${SAFE_TOKEN.test(mainDir) ? mainDir : "./..."}`, needsDockerfile: false, note: "Inferred Go recipe (go.mod); the binary is built as ./app." }, confidence: f.hasMainGo ? "medium" : "low", evidence: evidenceFor(gomod, "buildpack:go") };
  }
  const gemfile = inDir(dir, "Gemfile");
  if (ctx.idx.has(gemfile)) {
    return { value: { root: dir, strategy: "buildpack", language: "ruby", installCommand: "bundle install", needsDockerfile: false, note: "Inferred Ruby recipe (Gemfile). Rails asset compilation, if used, is not inferred." }, confidence: f.deps.has("gem:rails") ? "medium" : "low", evidence: evidenceFor(gemfile, "buildpack:ruby") };
  }
  for (const [file, cmd, rule] of [[inDir(dir, "pom.xml"), "mvn -B package -DskipTests", "buildpack:maven"], [inDir(dir, "build.gradle"), "gradle build -x test", "buildpack:gradle"], [inDir(dir, "build.gradle.kts"), "gradle build -x test", "buildpack:gradle"]] as const) {
    if (ctx.idx.has(file)) {
      const spring = f.webFrameworks.some((w) => w.name === "Spring Boot");
      return { value: { root: dir, strategy: "buildpack", language: "java", buildCommand: cmd, needsDockerfile: false, note: "Inferred JVM recipe; produces a runnable jar only when the Spring Boot plugin is applied." }, confidence: spring ? "medium" : "low", evidence: evidenceFor(file, rule) };
    }
  }
  const language = (["rust", "php"] as Language[]).find((l) => ctx.runtimes.has(`${l}\u0000${dir}`));
  ctx.unknowns.add(`Needs Dockerfile: no Dockerfile at ${rootWhere(dir)} and no build recipe could be inferred${language ? ` for ${language}` : ""}.`);
  return {
    value: { root: dir, strategy: "unknown", ...(language ? { language } : {}), needsDockerfile: true, note: "No Dockerfile and no recognised build recipe; a Dockerfile is required." },
    confidence: "low",
    evidence: [],
  };
}

export { draftsForRoot };
export type { Draft };
