/**
 * Deployment-shaped config files as EVIDENCE: docker-compose, Terraform,
 * Kubernetes manifests, vercel.json, fly.toml, render.yaml, serverless.yml,
 * netlify.toml, and `.env` files.
 *
 * docker-compose and Terraform go through the existing importers
 * (`importCompose`, `importTerraform`), which already translate them with an
 * honest report; this module reads their manifests for facts and adds the few
 * things they drop (compose `command`, images that are databases the importer
 * would mistype). No file here is evaluated: YAML/JSON/TOML are parsed as data
 * with size caps, everything else is line-scanned.
 */
import { load } from "js-yaml";
import { importCompose, importTerraform } from "@/lib/importers";
import { slugify } from "@/lib/importers/types";
import { isEnvExampleName, parseEnvFile } from "./envfile";
import { ownerOf, type Ctx } from "./model";
import { addDatastore, addEnv, addFinding, ev } from "./record";
import { basename, dirname, displayPath, isRecord, lines, parseJson, sanitizeInline, tomlSections } from "./text";
import type { DatastoreKind } from "./types";

const YAML_CAP = 256 * 1024;
const MAX_COMPOSE_SERVICES = 60;
const MAX_COMPOSE_ENV_ENTRIES = 1500;

const looksLikeCron = (s: string): boolean => /^[0-9*/,?LW#A-Za-z@-]{1,20}(?: [0-9*/,?LW#A-Za-z-]{1,20}){4,6}$/.test(s.trim());

/* --------------------------------- compose --------------------------------- */

const IMAGE_KINDS: { re: RegExp; kind: DatastoreKind; engine?: string; conf: "high" | "medium" | "low" }[] = [
  { re: /(?:^|\/)(?:postgres|postgis|timescale|pgvector|supabase\/postgres)/, kind: "postgres", conf: "high" },
  { re: /(?:^|\/)(?:mysql|mariadb|percona)/, kind: "mysql", conf: "high" },
  { re: /(?:^|\/)mongo(?:db)?(?:[:@]|$)/, kind: "mongodb", conf: "high" },
  { re: /(?:^|\/)(?:redis|valkey|dragonfly|keydb)/, kind: "redis", conf: "high" },
  { re: /(?:^|\/)(?:minio|seaweedfs)/, kind: "object_store", engine: "s3", conf: "medium" },
  { re: /(?:^|\/)localstack/, kind: "object_store", engine: "s3", conf: "low" },
  { re: /(?:^|\/)rabbitmq/, kind: "rabbitmq", engine: "amqp", conf: "high" },
  { re: /(?:^|\/)(?:kafka|redpanda|bitnami\/kafka)/, kind: "kafka", conf: "high" },
  { re: /(?:^|\/)(?:mailhog|mailpit|maildev|inbucket|mailcatcher)/, kind: "email", engine: "smtp", conf: "medium" },
];
const UNMODELED_IMAGE = /(?:^|\/)(?:elasticsearch|opensearch|memcached|nats|clickhouse|cassandra|influxdb|neo4j|cockroach)/;

function normalizeDir(base: string, rel: string): string | undefined {
  const parts = (rel.startsWith("/") ? [] : base === "" ? [] : base.split("/")).slice();
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

function readCompose(ctx: Ctx, path: string): void {
  const content = ctx.idx.get(path) ?? "";
  if (content.length > YAML_CAP) {
    ctx.unknowns.add(`${path} is larger than ${YAML_CAP} bytes and was not parsed.`);
    return;
  }
  let doc: unknown;
  try {
    doc = load(content);
  } catch {
    ctx.unknowns.add(`${path} could not be parsed as a docker-compose file.`);
    return;
  }
  const rawServices = isRecord(doc) && isRecord(doc.services) ? doc.services : {};
  const keys = Object.keys(rawServices);
  // The importer's second pass is quadratic in services x environment entries; bound the input before calling it.
  let envEntries = 0;
  for (const key of keys) {
    const env = isRecord(rawServices[key]) ? (rawServices[key] as Record<string, unknown>).environment : undefined;
    envEntries += Array.isArray(env) ? env.length : isRecord(env) ? Object.keys(env).length : 0;
  }
  if (keys.length > MAX_COMPOSE_SERVICES || envEntries > MAX_COMPOSE_ENV_ENTRIES) {
    ctx.unknowns.add(`${path} is too large to analyse (more than ${MAX_COMPOSE_SERVICES} services or ${MAX_COMPOSE_ENV_ENTRIES} environment entries).`);
    return;
  }
  let imported: ReturnType<typeof importCompose>;
  try {
    imported = importCompose(content);
  } catch {
    ctx.unknowns.add(`${path} could not be parsed as a docker-compose file.`);
    return;
  }
  const images = new Map<string, string>();
  const commands = new Map<string, string>();
  for (const key of keys) {
    const svc = rawServices[key];
    if (!isRecord(svc)) continue;
    const name = slugify(key, "service");
    if (typeof svc.image === "string") images.set(name, svc.image.toLowerCase());
    const cmd = svc.command ?? svc.entrypoint;
    if (typeof cmd === "string") commands.set(name, sanitizeInline(cmd, 300));
    else if (Array.isArray(cmd) && cmd.every((c) => typeof c === "string")) commands.set(name, sanitizeInline(cmd.join(" "), 300));
  }
  // one pass for evidence line numbers: the first line that is just `<name>:`
  const serviceLines = new Map<string, number>();
  for (const { n, text } of lines(content)) {
    const m = /^\s{0,10}["']?([A-Za-z0-9._-]{1,60})["']?\s{0,3}:\s{0,3}$/.exec(text);
    if (m) {
      const key = slugify(m[1], "service");
      if (!serviceLines.has(key)) serviceLines.set(key, n);
    }
  }
  const lineOfService = (name: string): number | undefined => serviceLines.get(name);

  const composeDir = dirname(path);
  const composeRoot = ownerOf(ctx.roots, path).dir;
  ctx.infrastructure.add(`compose\u0000${path}`, { kind: "docker-compose", path, detail: `${imported.manifest.services.length + imported.manifest.resources.length} compose service(s)` }, "high", ev(path, "file:docker-compose"));

  const idToName = new Map<string, string>();
  for (const s of imported.manifest.services) idToName.set(s.id, s.name);
  for (const r of imported.manifest.resources) idToName.set(r.id, r.name);

  // classify every compose entry by its image: datastore, unmodeled, or a real service
  const dataStoreNames = new Map<string, (typeof IMAGE_KINDS)[number]>();
  const unmodeled = new Set<string>();
  for (const [name, image] of images) {
    const hit = IMAGE_KINDS.find((k) => k.re.test(image));
    if (hit) dataStoreNames.set(name, hit);
    else if (UNMODELED_IMAGE.test(image)) unmodeled.add(name);
  }
  for (const r of imported.manifest.resources) if (!dataStoreNames.has(r.name) && !unmodeled.has(r.name)) unmodeled.add(r.name);
  for (const name of [...unmodeled].sort()) ctx.unknowns.add(`${path}: compose service "${displayPath(name, 40)}" runs an image that Zenith V1 does not model (${sanitizeInline(images.get(name) ?? "unknown image", 60)}); it is not part of the proposal.`);

  const rootFor = (context: string): string => {
    const dir = normalizeDir(composeDir, context);
    if (dir === undefined) return composeRoot;
    return ctx.roots.find((r) => r.dir === dir)?.dir ?? ownerOf(ctx.roots, dir === "" ? "x" : `${dir}/x`).dir;
  };

  const serviceRoot = new Map<string, string>(); // importer service name → root dir
  for (const s of imported.manifest.services) {
    if (dataStoreNames.has(s.name) || unmodeled.has(s.name)) continue;
    const line = lineOfService(s.name);
    if (s.source.type === "git") {
      const root = rootFor(s.source.repo);
      serviceRoot.set(s.name, root);
      const f = ctx.facts.get(root);
      if (f) {
        if (s.port !== undefined) f.ports.push({ port: s.port, rank: 4, source: "compose ports", evidence: ev(path, "compose:ports", line) });
        if (s.healthPath) f.healths.push({ path: s.healthPath, declared: true, evidence: ev(path, "compose:healthcheck", line) });
        const cmd = commands.get(s.name);
        if (s.kind === "worker") f.workers.push({ tech: "compose-service", confidence: "high", evidence: ev(path, "compose:service", line), ...(cmd ? { command: cmd } : {}) });
        else if (cmd) f.starts.push({ command: cmd, confidence: "medium", evidence: ev(path, "compose:command", line) });
      }
      for (const e of s.env) addEnv(ctx, e.key, root, "medium", ev(path, "compose:environment", line));
    } else if (s.source.type === "image") {
      serviceRoot.set(s.name, composeRoot);
      ctx.extraServices.push({
        name: s.name,
        root: composeRoot,
        kind: s.kind === "worker" ? "worker" : "web",
        image: sanitizeInline(s.source.image, 120),
        ...(s.port !== undefined ? { port: s.port } : {}),
        ...(s.healthPath ? { healthPath: s.healthPath } : {}),
        ...(commands.get(s.name) ? { command: commands.get(s.name) } : {}),
        evidence: ev(path, "compose:service", line),
      });
      for (const e of s.env) addEnv(ctx, e.key, composeRoot, "medium", ev(path, "compose:environment", line));
    }
  }

  // datastores: attribute each to the roots of the services that use it
  for (const [name, hit] of [...dataStoreNames.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const resource = imported.manifest.resources.find((r) => r.name === name) ?? imported.manifest.services.find((s) => s.name === name);
    const users = new Set<string>();
    if (resource) {
      for (const b of imported.manifest.bindings) {
        if (b.to !== resource.id) continue;
        const from = idToName.get(b.from);
        const root = from ? serviceRoot.get(from) : undefined;
        if (root !== undefined) users.add(root);
      }
    }
    if (users.size === 0) users.add(composeRoot);
    for (const root of [...users].sort()) addDatastore(ctx, root, hit.kind, hit.conf, ev(path, `compose:image:${hit.kind}`, lineOfService(name)), { engine: hit.engine });
  }
}

/* ---------------------------------- terraform ------------------------------- */

const TF_CAP = 128 * 1024;
const TF_FILE_LIMIT = 30;

function readTerraform(ctx: Ctx, paths: string[]): void {
  let seen = 0;
  for (const path of paths) {
    if (++seen > TF_FILE_LIMIT) {
      ctx.unknowns.add(`More than ${TF_FILE_LIMIT} Terraform files were found; only the first ${TF_FILE_LIMIT} were read.`);
      return;
    }
    const raw = ctx.idx.get(path) ?? "";
    if (raw.length > TF_CAP) {
      ctx.unknowns.add(`${path} is larger than ${TF_CAP} bytes and was not read.`);
      continue;
    }
    // The importer's block scan is quadratic over runs of blank lines; blank lines carry nothing here.
    const text = raw
      .split("\n")
      .filter((l) => l.trim() !== "")
      .join("\n");
    const result = importTerraform(text);
    const root = ownerOf(ctx.roots, path).dir;
    ctx.infrastructure.add(`terraform\u0000${path}`, { kind: "terraform", path, detail: `${result.manifest.resources.length} recognised resource(s)` }, "high", ev(path, "file:terraform"));
    const resourceLines = new Map<string, number>();
    for (const { n, text: t } of lines(raw)) {
      const m = /^\s{0,10}resource\s{1,5}"([A-Za-z0-9_]{1,80})"\s{1,5}"([A-Za-z0-9_-]{1,80})"/.exec(t);
      if (m && !resourceLines.has(`${m[1]}.${m[2]}`)) resourceLines.set(`${m[1]}.${m[2]}`, n);
    }
    for (const r of result.manifest.resources) {
      const type = (r.externalRef ?? "").split(".")[0];
      const line = resourceLines.get(r.externalRef ?? "");
      const kind: DatastoreKind = r.kind === "postgres" || r.kind === "redis" || r.kind === "object_store" || r.kind === "queue" || r.kind === "email" ? r.kind : "postgres";
      addDatastore(ctx, root, kind, "medium", ev(path, `terraform:${type || "resource"}`, line), { engine: kind === "queue" ? "sqs" : kind === "object_store" ? "s3" : undefined });
    }
  }
}

/* -------------------------------- kubernetes -------------------------------- */

function readKubernetes(ctx: Ctx, path: string): void {
  const content = ctx.idx.get(path) ?? "";
  const ls = lines(content);
  if (!ls.some((l) => /^apiVersion:\s/.test(l.text))) return;
  const kinds = new Set<string>();
  const root = ownerOf(ctx.roots, path).dir;
  const f = ctx.facts.get(root);
  let inCron = false;
  for (const { n, text } of ls) {
    if (/^---/.test(text)) inCron = false;
    const k = /^kind:\s{1,4}([A-Za-z]{2,40})\s{0,4}$/.exec(text);
    if (k) {
      kinds.add(k[1]);
      inCron = k[1] === "CronJob";
    }
    if (inCron) {
      const sc = /^\s{2,8}schedule:\s{1,4}["']?([^"'\n#]{1,40}?)["']?\s{0,4}(?:#.*)?$/.exec(text);
      if (sc && looksLikeCron(sc[1])) f?.crons.push({ mechanism: "kubernetes-cronjob", confidence: "medium", evidence: ev(path, "k8s:CronJob", n), inProcess: false, schedule: sc[1].trim() });
    }
    const cp = /^\s{2,40}-?\s{0,3}containerPort:\s{1,4}(\d{2,5})\b/.exec(text);
    if (cp && f) f.ports.push({ port: Number(cp[1]), rank: 2, source: "k8s containerPort", evidence: ev(path, "k8s:containerPort", n) });
  }
  if (kinds.size > 0) ctx.infrastructure.add(`kubernetes\u0000${path}`, { kind: "kubernetes", path, detail: [...kinds].sort().slice(0, 12).join(", ") }, "high", ev(path, "file:kubernetes"));
}

/* ----------------------------- hosting config files -------------------------- */

function readVercel(ctx: Ctx, path: string): void {
  const json = parseJson(ctx.idx.get(path) ?? "");
  if (!isRecord(json)) return;
  const root = ownerOf(ctx.roots, path).dir;
  const f = ctx.facts.get(root);
  ctx.infrastructure.add(`vercel\u0000${path}`, { kind: "vercel", path }, "high", ev(path, "file:vercel.json"));
  if (!f) return;
  const clean = (v: unknown): string | undefined => (typeof v === "string" && v.length <= 300 ? sanitizeInline(v, 300) : undefined);
  const buildCommand = clean(json.buildCommand);
  const outputDir = clean(json.outputDirectory);
  const installCommand = clean(json.installCommand);
  if (buildCommand || outputDir || installCommand) f.hosting = { buildCommand, outputDir, installCommand, evidence: ev(path, "vercel:build") };
  if (Array.isArray(json.crons)) {
    for (const c of json.crons.slice(0, 50)) {
      if (!isRecord(c) || typeof c.path !== "string" || typeof c.schedule !== "string") continue;
      if (!/^\/[A-Za-z0-9\-._~/]{0,198}(?:\?[A-Za-z0-9=&\-._~%]{0,100})?$/.test(c.path) || !looksLikeCron(c.schedule)) continue;
      const line = lines(ctx.idx.get(path) ?? "").find((l) => l.text.includes(c.path as string))?.n;
      f.crons.push({ mechanism: "vercel-cron", confidence: "high", evidence: ev(path, "vercel:crons", line), inProcess: false, schedule: c.schedule.trim(), target: c.path });
    }
  }
}

function readFly(ctx: Ctx, path: string): void {
  const content = ctx.idx.get(path) ?? "";
  const root = ownerOf(ctx.roots, path).dir;
  const f = ctx.facts.get(root);
  ctx.infrastructure.add(`fly\u0000${path}`, { kind: "fly", path }, "high", ev(path, "file:fly.toml"));
  if (!f) return;
  for (const section of tomlSections(content)) {
    for (const { n, text } of section.lines) {
      const ip = /^internal_port\s{0,4}=\s{0,4}(\d{2,5})\b/.exec(text);
      if (ip) f.ports.push({ port: Number(ip[1]), rank: 4, source: "fly.toml internal_port", evidence: ev(path, "fly:internal_port", n) });
      const hp = /^path\s{0,4}=\s{0,4}["'](\/[^"'\s]{0,100})["']/.exec(text);
      if (hp && /check/i.test(section.name)) f.healths.push({ path: hp[1], declared: true, evidence: ev(path, "fly:http_check", n) });
      if (section.name === "processes") {
        const p = /^([A-Za-z0-9_-]{1,40})\s{0,4}=\s{0,4}["']([^"']{1,300})["']/.exec(text);
        if (p) {
          const entries = f.procfile?.entries ?? [];
          if (!f.procfile) f.procfile = { path, entries };
          if (f.procfile.path === path) entries.push({ type: p[1].toLowerCase(), command: sanitizeInline(p[2], 300), line: n });
        }
      }
    }
  }
}

function readRender(ctx: Ctx, path: string): void {
  const content = ctx.idx.get(path) ?? "";
  if (content.length > YAML_CAP) return;
  let doc: unknown;
  try {
    doc = load(content);
  } catch {
    ctx.unknowns.add(`${path} could not be parsed as YAML.`);
    return;
  }
  ctx.infrastructure.add(`render\u0000${path}`, { kind: "render", path }, "high", ev(path, "file:render.yaml"));
  if (!isRecord(doc)) return;
  const baseDir = dirname(path);
  if (Array.isArray(doc.databases) && doc.databases.length > 0) addDatastore(ctx, ownerOf(ctx.roots, path).dir, "postgres", "medium", ev(path, "render:databases"));
  const services = Array.isArray(doc.services) ? doc.services.slice(0, 50) : [];
  for (const svc of services) {
    if (!isRecord(svc)) continue;
    const dir = typeof svc.rootDir === "string" ? normalizeDir(baseDir, svc.rootDir) : baseDir;
    const root = dir === undefined ? undefined : (ctx.roots.find((r) => r.dir === dir)?.dir ?? ownerOf(ctx.roots, dir === "" ? "x" : `${dir}/x`).dir);
    const f = root === undefined ? undefined : ctx.facts.get(root);
    const type = typeof svc.type === "string" ? svc.type : "";
    if ((type === "redis" || type === "keyvalue") && root !== undefined) {
      addDatastore(ctx, root, "redis", "medium", ev(path, "render:redis"));
      continue;
    }
    if (!f) continue;
    const start = typeof svc.startCommand === "string" ? sanitizeInline(svc.startCommand, 300) : undefined;
    if (type === "web" && start) f.starts.push({ command: start, confidence: "medium", evidence: ev(path, "render:startCommand") });
    if (type === "worker") f.workers.push({ tech: "render-worker", confidence: "high", evidence: ev(path, "render:worker"), ...(start ? { command: start } : {}) });
    if (type === "cron" && typeof svc.schedule === "string" && looksLikeCron(svc.schedule)) f.crons.push({ mechanism: "render-cron", confidence: "high", evidence: ev(path, "render:cron"), inProcess: false, schedule: svc.schedule.trim(), ...(start ? { command: start } : {}) });
    if (typeof svc.healthCheckPath === "string" && /^\/[A-Za-z0-9\-._~/]{0,100}$/.test(svc.healthCheckPath)) f.healths.push({ path: svc.healthCheckPath, declared: true, evidence: ev(path, "render:healthCheckPath") });
    if (Array.isArray(svc.envVars)) {
      for (const e of svc.envVars.slice(0, 100)) if (isRecord(e) && typeof e.key === "string") addEnv(ctx, e.key, f.root.dir, "medium", ev(path, "render:envVars"));
    }
  }
}

function readServerless(ctx: Ctx, path: string): void {
  const content = ctx.idx.get(path) ?? "";
  const hasFunctions = /^functions:\s{0,3}$/m.test(content);
  ctx.infrastructure.add(`serverless\u0000${path}`, { kind: "serverless", path, detail: hasFunctions ? "defines functions" : undefined }, "high", ev(path, "file:serverless.yml"));
  if (hasFunctions) ctx.unknowns.add(`${path} defines Serverless Framework functions; the V1 manifest has no function service kind, so they are evidence only and not part of the proposal.`);
}

function readNetlify(ctx: Ctx, path: string): void {
  const root = ownerOf(ctx.roots, path).dir;
  const f = ctx.facts.get(root);
  if (!f) return;
  let buildCommand: string | undefined;
  let outputDir: string | undefined;
  for (const section of tomlSections(ctx.idx.get(path) ?? "")) {
    if (section.name !== "build") continue;
    for (const { text } of section.lines) {
      const c = /^command\s{0,4}=\s{0,4}["']([^"']{1,300})["']/.exec(text);
      if (c) buildCommand = sanitizeInline(c[1], 300);
      const p = /^publish\s{0,4}=\s{0,4}["']([^"']{1,200})["']/.exec(text);
      if (p) outputDir = sanitizeInline(p[1], 200);
    }
  }
  if (buildCommand || outputDir) f.hosting = { ...(f.hosting ?? { evidence: ev(path, "netlify:build") }), buildCommand, outputDir };
}

/* ------------------------------------ env files ----------------------------- */

function readEnvFile(ctx: Ctx, path: string): void {
  const base = basename(path).toLowerCase();
  const root = ownerOf(ctx.roots, path).dir;
  const assignments = parseEnvFile(ctx.idx.get(path) ?? "");
  const example = isEnvExampleName(base);
  for (const a of assignments) addEnv(ctx, a.name, root, "medium", ev(path, example ? "env-example" : "committed-env", a.line));
  if (example) {
    for (const a of assignments.filter((x) => x.hasValue && x.secretLike)) {
      addFinding(ctx, { code: "secret_in_example_env", path, detail: `${displayPath(path)} line ${a.line}: ${a.name} has a value that looks like a real credential in an example file. The value was not recorded. Replace it with a placeholder and rotate it.` }, ev(path, "env-example-secret", a.line));
      ctx.risks.add(`${displayPath(path)} is an example env file but ${a.name} looks like a real credential (value not recorded).`);
    }
    return;
  }
  const withValues = assignments.filter((a) => a.hasValue);
  if (withValues.length === 0) return;
  addFinding(
    ctx,
    { code: "committed_env", path, detail: `${displayPath(path)} is a committed environment file with ${withValues.length} variable value(s) set (${assignments.length} names). Values were not read into the analysis. Rotate anything real in it and remove it from the repository.` },
    ev(path, "committed-env", withValues[0].line)
  );
  ctx.risks.add(`Committed environment file ${displayPath(path)} has values set (${withValues.length} of ${assignments.length} variables); values were not recorded. Rotate any real secrets in it.`);
}

/* ------------------------------------ driver -------------------------------- */

const COMPOSE_FILE = /^(?:docker-)?compose(?:\.[a-z0-9_-]{1,30})?\.ya?ml$/;

/** Read every repo-level deployment/config file. `paths` is the sorted list of all indexed paths. */
export function readRepoConfigs(ctx: Ctx, paths: string[]): void {
  const tf: string[] = [];
  for (const path of paths) {
    const base = basename(path).toLowerCase();
    const inK8s = /(?:^|\/)(?:k8s|kubernetes|deploy|deployment|deployments|manifests|kustomize|overlays|base)\//.test(path) && /\.ya?ml$/.test(base);
    if (COMPOSE_FILE.test(base)) readCompose(ctx, path);
    else if (base.endsWith(".tf")) tf.push(path);
    else if (base === "vercel.json") readVercel(ctx, path);
    else if (base === "fly.toml") readFly(ctx, path);
    else if (base === "render.yaml" || base === "render.yml") readRender(ctx, path);
    else if (base === "serverless.yml" || base === "serverless.yaml") readServerless(ctx, path);
    else if (base === "netlify.toml") readNetlify(ctx, path);
    else if (base === ".env" || base.startsWith(".env.")) readEnvFile(ctx, path);
    else if (inK8s) readKubernetes(ctx, path);
  }
  if (tf.length > 0) readTerraform(ctx, tf);
}
