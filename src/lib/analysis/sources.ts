/**
 * Source-code scanner: a single linear pass per file, line by line, with
 * bounded patterns. Nothing is parsed as code and nothing is evaluated — this
 * finds the literals a human would grep for: environment variable reads,
 * listen calls, health routes, connection-URL schemes, scheduler and worker
 * entry points.
 *
 * Only NAMES and non-secret literal defaults are recorded for environment
 * variables. Credentials found in source (connection strings with a password,
 * provider key formats) become findings that say where and what kind, never
 * the value.
 */
import { addDatastore, addEnv, addFinding, ev } from "./record";
import type { Ctx, RootFacts } from "./model";
import { basename, displayPath, lines, type Line } from "./text";
import type { DatastoreKind } from "./types";

type Lang = "js" | "py" | "rb" | "go" | "java" | "php" | "rs";

const EXT_LANG: Record<string, Lang> = {
  ".js": "js",
  ".jsx": "js",
  ".ts": "js",
  ".tsx": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".mts": "js",
  ".cts": "js",
  ".py": "py",
  ".rb": "rb",
  ".go": "go",
  ".java": "java",
  ".kt": "java",
  ".kts": "java",
  ".php": "php",
  ".rs": "rs",
};

export const langOf = (path: string): Lang | undefined => {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? undefined : EXT_LANG[path.slice(dot).toLowerCase()];
};

/* ------------------------------- shared regexes --------------------------- */

const SCHEME =
  /\b(postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|sqs|sqlite|s3)(?:\+[a-z0-9_]{1,20})?:\/\//gi;
const SCHEME_KIND: Record<string, { kind: DatastoreKind; engine?: string }> = {
  postgres: { kind: "postgres" },
  postgresql: { kind: "postgres" },
  mysql: { kind: "mysql" },
  mariadb: { kind: "mysql" },
  mongodb: { kind: "mongodb" },
  "mongodb+srv": { kind: "mongodb" },
  redis: { kind: "redis" },
  rediss: { kind: "redis" },
  amqp: { kind: "rabbitmq", engine: "amqp" },
  amqps: { kind: "rabbitmq", engine: "amqp" },
  sqs: { kind: "queue", engine: "sqs" },
  sqlite: { kind: "sqlite" },
  s3: { kind: "object_store", engine: "s3" },
};

const USERINFO = /\b([a-z][a-z0-9+.-]{1,20}):\/\/([^\s/:@'"`]{1,64}):([^\s/@'"`]{1,128})@([^\s/:'"`?#]{1,253})/gi;
const PLACEHOLDER_PASSWORD = /^(?:\$|\{|<|%|\*+$|x+$|password$|pass$|passwd$|secret$|changeme|example|your[-_]|user$|test$|dummy|placeholder)/i;
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?|host\.docker\.internal)$|(?:\.local|\.internal|\.test|\.example|\.invalid|\.localhost|\.svc)$|^[^.]+$/i;

const SECRET_FORMATS: { re: RegExp; label: string }[] = [
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, label: "an AWS access key id" },
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, label: "a private key" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/, label: "a GitHub token" },
  { re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,255}\b/, label: "a Stripe live key" },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,255}\b/, label: "a Slack token" },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, label: "a Google API key" },
];

const HEALTH_LITERAL = /["'`](\/(?:health|healthz|api\/health|api\/healthz|up|_health|readyz|livez))\/?["'`]/;

/** Returns the first defined capture group of a sticky default matcher at `at`, or undefined. */
function defaultAt(re: RegExp, text: string, at: number): string | undefined {
  re.lastIndex = at;
  const m = re.exec(text);
  if (!m) return undefined;
  for (let i = 1; i < m.length; i++) if (m[i] !== undefined) return /^(?:True|False)$/.test(m[i]) ? m[i].toLowerCase() : m[i];
  return undefined;
}

const JS_DEFAULT = /\s{0,4}(?:,\s{0,4}\d{1,3}\s{0,4})?\)?\s{0,4}(?:\|\||\?\?)\s{0,4}(?:'([^'\n]{0,100})'|"([^"\n]{0,100})"|`([^`$\n]{0,100})`|(\d{1,10})\b|(true|false)\b)/y;
const PY_DEFAULT = /\s{0,4},\s{0,4}(?:default\s{0,4}=\s{0,4})?(?:"([^"\n]{0,100})"|'([^'\n]{0,100})'|(\d{1,10})\b|(True|False)\b)/y;
const RB_DEFAULT = /\)?\s{0,4}(?:,\s{0,4}|\|\|\s{0,4}|\{\s{0,4})(?:"([^"\n]{0,100})"|'([^'\n]{0,100})'|(\d{1,10})\b)/y;
const PHP_DEFAULT = /\s{0,4},\s{0,4}(?:'([^'\n]{0,100})'|"([^"\n]{0,100})"|(\d{1,10})\b|(true|false)\b)/y;

const looksLikeCron = (s: string): boolean => /^[0-9*/,?LW#A-Za-z@-]{1,20}(?: [0-9*/,?LW#A-Za-z-]{1,20}){4,6}$/.test(s.trim()) || /^@(?:hourly|daily|weekly|monthly|yearly|annually|midnight)$/.test(s.trim());

/* ------------------------------ the file scanner -------------------------- */

interface FileScan {
  ctx: Ctx;
  f: RootFacts;
  path: string;
  root: string;
}

function envRead(s: FileScan, name: string, n: number, rule: string, def: string | undefined): void {
  addEnv(s.ctx, name, s.root, "high", ev(s.path, rule, n), def);
  if (name === "PORT" && def !== undefined && /^\d{2,5}$/.test(def)) {
    const port = Number(def);
    if (port >= 1 && port <= 65535) s.f.ports.push({ port, rank: 3, source: "PORT default in code", evidence: ev(s.path, "env-default:PORT", n) });
  }
}

function port(s: FileScan, value: string, n: number, rule: string, rank = 3): void {
  const p = Number(value);
  if (Number.isInteger(p) && p >= 1 && p <= 65535) s.f.ports.push({ port: p, rank, source: rule, evidence: ev(s.path, rule, n) });
}

/** Credentials written into a file: reported by kind and location, never by value. */
function secretChecks(ctx: Ctx, path: string, text: string, n: number): void {
  for (const m of text.matchAll(USERINFO)) {
    const pass = m[3];
    const host = m[4];
    if (PLACEHOLDER_PASSWORD.test(pass) || LOCAL_HOST.test(host)) continue;
    addFinding(
      ctx,
      {
        code: "hardcoded_credentials",
        path: path,
        detail: `A ${m[1].toLowerCase()} connection string with an embedded password is written in ${displayPath(path)} at line ${n}. The value was not recorded. Move it to a secret and rotate it.`,
      },
      ev(path, "url-credentials", n)
    );
    ctx.risks.add(`Hard-coded credentials in a connection string at ${displayPath(path)}:${n} (value not recorded).`);
  }
  for (const { re, label } of SECRET_FORMATS) {
    if (re.test(text)) {
      addFinding(ctx, { code: "secret_in_source", path: path, detail: `${displayPath(path)} line ${n} contains what looks like ${label}. The value was not recorded. Revoke it and move it to a secret.` }, ev(path, "secret-format", n));
      ctx.risks.add(`Possible secret (${label}) committed at ${displayPath(path)}:${n} (value not recorded).`);
    }
  }
}

/** Run the credential checks over a config-class file (Dockerfile, compose, package.json, properties ...). */
export function scanConfigSecrets(ctx: Ctx, path: string, content: string): void {
  for (const { n, text } of lines(content)) secretChecks(ctx, path, text, n);
}

function scanCommon(s: FileScan, text: string, n: number): void {
  for (const m of text.matchAll(SCHEME)) {
    const hit = SCHEME_KIND[m[1].toLowerCase()];
    if (hit) addDatastore(s.ctx, s.root, hit.kind, "medium", ev(s.path, `url-scheme:${m[1].toLowerCase()}`, n), { engine: hit.engine });
  }
  secretChecks(s.ctx, s.path, text, n);
  const h = HEALTH_LITERAL.exec(text);
  if (h) s.f.healths.push({ path: h[1], declared: false, evidence: ev(s.path, "route-literal", n) });
}

/* ---------------------------------- js ----------------------------------- */

const JS_ENV = [
  /process\.env\.([A-Za-z_][A-Za-z0-9_]{0,99})/g,
  /process\.env\[\s{0,2}["']([A-Za-z_][A-Za-z0-9_]{0,99})["']\s{0,2}\]/g,
  /import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]{0,99})/g,
];
const JS_DESTRUCTURE = /(?:const|let|var)\s{0,4}\{([^}\n]{1,300})\}\s{0,4}=\s{0,4}process\.env\b/;
const JS_CRON = /(?:cron\.schedule|schedule\.scheduleJob|new CronJob|@Cron|agenda\.every)\(\s{0,4}["']([^"'\n]{1,60})["']/;
const JS_TYPEORM = /\btype\s{0,4}:\s{0,4}["'](postgres|postgresql|mysql|mariadb|mongodb|sqlite|better-sqlite3)["']/;
const JS_SEQUELIZE = /\bdialect\s{0,4}:\s{0,4}["'](postgres|postgresql|mysql|mariadb|sqlite)["']/;
const JS_KNEX = /\bclient\s{0,4}:\s{0,4}["'](pg|postgres|postgresql|mysql|mysql2|sqlite3|better-sqlite3)["']/;

const PG_LIKE = new Set(["postgres", "postgresql", "pg"]);
const MYSQL_LIKE = new Set(["mysql", "mysql2", "mariadb"]);

function dialectKind(d: string): DatastoreKind | undefined {
  if (PG_LIKE.has(d)) return "postgres";
  if (MYSQL_LIKE.has(d)) return "mysql";
  if (d === "sqlite" || d === "sqlite3" || d === "better-sqlite3") return "sqlite";
  if (d === "mongodb") return "mongodb";
  return undefined;
}

function scanJs(s: FileScan, ls: Line[], content: string): void {
  const hasBullmq = content.includes("bullmq");
  const hasBull = !hasBullmq && /['"]bull['"]/.test(content);
  const hasTypeorm = s.f.deps.has("npm:typeorm");
  const hasSequelize = s.f.deps.has("npm:sequelize");
  const hasKnex = s.f.deps.has("npm:knex");
  const hasDrizzle = s.f.deps.has("npm:drizzle-orm");
  for (const { n, text } of ls) {
    for (const re of JS_ENV) for (const m of text.matchAll(re)) envRead(s, m[1], n, "env-read", defaultAt(JS_DEFAULT, text, m.index + m[0].length));
    const d = JS_DESTRUCTURE.exec(text);
    if (d) {
      for (const part of d[1].split(",")) {
        const name = /^\s{0,4}([A-Za-z_][A-Za-z0-9_]{0,99})/.exec(part)?.[1];
        const eq = part.indexOf("=");
        const lit = eq === -1 ? undefined : /^\s{0,4}(?:'([^'\n]{0,100})'|"([^"\n]{0,100})"|(\d{1,10}))\s{0,4}$/.exec(part.slice(eq + 1));
        if (name) envRead(s, name, n, "env-destructure", lit ? (lit[1] ?? lit[2] ?? lit[3]) : undefined);
      }
    }
    const lit = /\.listen\(\s{0,4}(\d{2,5})\b/.exec(text) ?? /\.listen\(\s{0,4}\{[^}\n]{0,120}\bport\s{0,4}:\s{0,4}(\d{2,5})\b/.exec(text);
    if (lit) {
      port(s, lit[1], n, "listen-literal");
      s.f.listenFiles.add(s.path);
    } else if (/\.listen\(\s{0,4}[A-Za-z_({]/.test(text) || /\bserve\(\s{0,4}\{/.test(text) || /\bapp\.start\(/.test(text)) {
      s.f.listenFiles.add(s.path);
    }
    const bound = /(?<![.\w])(?:PORT|port)\s{0,4}=\s{0,4}["']?(\d{2,5})["']?\s{0,4}[;,]?\s{0,4}$/.exec(text);
    if (bound) port(s, bound[1], n, "port-constant");
    const honoPort = /\bserve\(\s{0,4}\{[^}\n]{0,120}\bport\s{0,4}:\s{0,4}(\d{2,5})\b/.exec(text);
    if (honoPort) port(s, honoPort[1], n, "serve-port");
    if (hasBullmq && /\bnew Worker\(/.test(text)) s.f.workers.push({ tech: "bullmq", confidence: "high", evidence: ev(s.path, "bullmq-worker", n), file: s.path });
    else if (hasBull && /\.process\(/.test(text)) s.f.workers.push({ tech: "bull", confidence: "medium", evidence: ev(s.path, "bull-process", n), file: s.path });
    const c = JS_CRON.exec(text);
    if (c && /(?:node-cron|node-schedule|cron|agenda|@nestjs\/schedule)/.test(content)) {
      const valid = looksLikeCron(c[1]);
      s.f.crons.push({ mechanism: "in-process scheduler", confidence: "medium", evidence: ev(s.path, "cron-literal", n), inProcess: true, ...(valid ? { schedule: c[1].trim() } : {}) });
    }
    if (hasTypeorm) {
      const t = JS_TYPEORM.exec(text);
      const kind = t ? dialectKind(t[1]) : undefined;
      if (t && kind) addDatastore(s.ctx, s.root, kind, "high", ev(s.path, "typeorm-type", n));
    }
    if (hasSequelize) {
      const t = JS_SEQUELIZE.exec(text);
      const kind = t ? dialectKind(t[1]) : undefined;
      if (t && kind) addDatastore(s.ctx, s.root, kind, "high", ev(s.path, "sequelize-dialect", n));
    }
    if (hasKnex) {
      const t = JS_KNEX.exec(text);
      const kind = t ? dialectKind(t[1]) : undefined;
      if (t && kind) addDatastore(s.ctx, s.root, kind, "high", ev(s.path, "knex-client", n));
    }
    if (hasDrizzle) {
      if (/drizzle-orm\/(?:node-postgres|postgres-js|neon|vercel-postgres|pg-core)/.test(text) || /\bpgTable\(/.test(text)) addDatastore(s.ctx, s.root, "postgres", "high", ev(s.path, "drizzle-postgres", n));
      else if (/drizzle-orm\/(?:mysql2|mysql-core|planetscale)/.test(text) || /\bmysqlTable\(/.test(text)) addDatastore(s.ctx, s.root, "mysql", "high", ev(s.path, "drizzle-mysql", n));
      else if (/drizzle-orm\/(?:better-sqlite3|sqlite-core|libsql)/.test(text) || /\bsqliteTable\(/.test(text)) addDatastore(s.ctx, s.root, "sqlite", "medium", ev(s.path, "drizzle-sqlite", n));
    }
  }
}

/* ------------------------------------ py --------------------------------- */

const PY_ENV = /\b(?:os\.environ(?:\.get)?|os\.getenv|environ\.get|getenv)\s{0,2}[[(]\s{0,4}["']([A-Za-z_][A-Za-z0-9_]{0,99})["']/g;
const PY_ENV_LIB = /\b(?:env|config)(?:\.[a-z_]{2,12})?\(\s{0,4}["']([A-Z][A-Z0-9_]{1,99})["']/g;
const PY_DJANGO_ENGINE = /["']ENGINE["']\s{0,4}:\s{0,4}["']django\.(?:contrib\.gis\.)?db\.backends\.([a-z0-9_.]{1,40})["']/;
const PY_BOTO = /\b(?:client|resource)\(\s{0,4}["'](s3|sqs|ses|sesv2)["']/;
const PY_APP = /^([A-Za-z_][A-Za-z0-9_]{0,59})\s{0,4}(?::\s{0,4}[A-Za-z_.[\]]{1,60}\s{0,4})?=\s{0,4}(FastAPI|Flask|Celery)\(/;

/** `app/main.py` under root `x` → `app.main`; `pkg/celery.py` → `pkg`. */
function pyModule(path: string, root: string): string {
  const rel = root === "" ? path : path.slice(root.length + 1);
  const parts = rel.replace(/\.py$/, "").split("/");
  if (parts[parts.length - 1] === "__init__") parts.pop();
  return parts.join(".");
}

function scanPy(s: FileScan, ls: Line[], content: string): void {
  const isSettings = /(?:^|\/)settings(?:\/[a-z_]{1,30})?\.py$/.test(s.path) || content.includes("DATABASES");
  for (const { n, text } of ls) {
    for (const m of text.matchAll(PY_ENV)) envRead(s, m[1], n, "env-read", defaultAt(PY_DEFAULT, text, m.index + m[0].length));
    for (const m of text.matchAll(PY_ENV_LIB)) envRead(s, m[1], n, "env-read", defaultAt(PY_DEFAULT, text, m.index + m[0].length));
    if (isSettings) {
      const e = PY_DJANGO_ENGINE.exec(text);
      if (e) {
        const kind: DatastoreKind | undefined = /^(?:postgresql|postgresql_psycopg2|postgis)$/.test(e[1]) ? "postgres" : e[1] === "mysql" ? "mysql" : e[1] === "sqlite3" ? "sqlite" : undefined;
        if (kind) addDatastore(s.ctx, s.root, kind, kind === "sqlite" ? "medium" : "high", ev(s.path, "django-engine", n));
      }
      if (/^\s{0,8}EMAIL_HOST\s{0,4}=/.test(text)) addDatastore(s.ctx, s.root, "email", "medium", ev(s.path, "django-email-host", n), { engine: "smtp" });
    }
    const b = PY_BOTO.exec(text);
    if (b) {
      const kind: DatastoreKind = b[1] === "s3" ? "object_store" : b[1] === "sqs" ? "queue" : "email";
      addDatastore(s.ctx, s.root, kind, "high", ev(s.path, `boto3:${b[1]}`, n), { engine: b[1] === "sqs" ? "sqs" : b[1] === "s3" ? "s3" : "ses", ...(kind === "queue" ? { role: "both" as const } : {}) });
    }
    const dj = /\b(?:path|re_path|url)\(\s{0,4}r?["']\^?(health|healthz)(\/?)\$?["']/.exec(text);
    if (dj) s.f.healths.push({ path: `/${dj[1]}${dj[2]}`, declared: false, evidence: ev(s.path, "django-route", n) });
    const app = PY_APP.exec(text);
    if (app) {
      const kind = app[2] === "FastAPI" ? "fastapi" : app[2] === "Flask" ? "flask" : "celery";
      s.f.pyApps.push({ kind, module: pyModule(s.path, s.root), variable: app[1], evidence: ev(s.path, `py-app:${kind}`, n) });
    }
    const run = /\.run\([^)\n]{0,100}\bport\s{0,4}=\s{0,4}(\d{2,5})/.exec(text);
    if (run) {
      port(s, run[1], n, "run-port");
      s.f.listenFiles.add(s.path);
    }
    const flag = /(?:--port[ =]|--bind[ =]\S{0,40}:|-p )(\d{2,5})\b/.exec(text);
    if (flag && /["']/.test(text)) port(s, flag[1], n, "port-flag", 5);
    if (/\b(?:beat_schedule|CELERYBEAT_SCHEDULE)\b/.test(text)) s.f.crons.push({ mechanism: "celery-beat", confidence: "medium", evidence: ev(s.path, "celery-beat-schedule", n), inProcess: false });
  }
}

/* ------------------------------------ rb --------------------------------- */

const RB_ENV = /\bENV(?:\.fetch\(\s{0,2}|\[\s{0,2})["']([A-Za-z_][A-Za-z0-9_]{0,99})["']/g;

function rubyEnvReads(s: FileScan, text: string, n: number): void {
  for (const m of text.matchAll(RB_ENV)) {
    const at = m.index + m[0].length;
    const tail = text.slice(at, at + 5);
    // `ENV["X"] || "d"` and `ENV.fetch("X") { "d" }` / `ENV.fetch("X", "d")` all read as "default follows"
    envRead(s, m[1], n, "env-read", defaultAt(RB_DEFAULT, text, at) ?? (tail.startsWith("]") ? defaultAt(RB_DEFAULT, text, at + 1) : undefined));
  }
}

/** ERB in Rails YAML (`<%= ENV["X"] %>`): environment names only, same rules as Ruby source. */
export function scanRubyEnvInConfig(ctx: Ctx, f: RootFacts, path: string, content: string): void {
  const s: FileScan = { ctx, f, path, root: f.root.dir };
  for (const { n, text } of lines(content)) rubyEnvReads(s, text, n);
}

function scanRb(s: FileScan, ls: Line[]): void {
  const isSchedule = basename(s.path) === "schedule.rb";
  for (const { n, text } of ls) {
    rubyEnvReads(s, text, n);
    const sinatra = /\bset\s{1,3}:port\s{0,3},\s{0,3}(\d{2,5})\b/.exec(text);
    if (sinatra) port(s, sinatra[1], n, "sinatra-port");
    const r = /\bget\s{1,3}["'](health|healthz|up|_health)["']/.exec(text);
    if (r) s.f.healths.push({ path: `/${r[1]}`, declared: false, evidence: ev(s.path, "rails-route", n) });
    if (/:redis_cache_store\b/.test(text)) addDatastore(s.ctx, s.root, "redis", "high", ev(s.path, "rails-redis-cache", n));
    if (/queue_adapter\s{0,4}=\s{0,4}:sidekiq\b/.test(text)) s.f.workers.push({ tech: "sidekiq", confidence: "high", evidence: ev(s.path, "active-job-sidekiq", n), command: "bundle exec sidekiq" });
    const mail = /action_mailer\.delivery_method\s{0,4}=\s{0,4}:(smtp|ses|sendgrid_actionmailer|postmark|mailgun)\b/.exec(text);
    if (mail) addDatastore(s.ctx, s.root, "email", "medium", ev(s.path, "action-mailer", n), { engine: mail[1] === "ses" ? "ses" : "smtp" });
    if (/active_storage\.service\s{0,4}=\s{0,4}:amazon\b/.test(text)) addDatastore(s.ctx, s.root, "object_store", "high", ev(s.path, "active-storage-amazon", n), { engine: "s3" });
    if (isSchedule && /^\s{0,8}every\s/.test(text)) s.f.crons.push({ mechanism: "whenever", confidence: "high", evidence: ev(s.path, "whenever-schedule", n), inProcess: false });
  }
}

/* ------------------------------------ go --------------------------------- */

const GO_ENV = /\bos\.(?:Getenv|LookupEnv)\(\s{0,2}"([A-Za-z_][A-Za-z0-9_]{0,99})"/g;
const GO_ENV_HELPER = /\b[gG]et[eE]nv\w{0,20}\(\s{0,2}"([A-Z][A-Z0-9_]{1,99})"\s{0,2},\s{0,2}"([^"\n]{0,100})"/g;

function scanGo(s: FileScan, ls: Line[], content: string): void {
  const isMain = /^package main\b/m.test(content) && /^func main\(\)/m.test(content);
  if (isMain) {
    s.f.hasMainGo = true;
    const dir = s.path.includes("/") ? s.path.slice(0, s.path.lastIndexOf("/")) : "";
    if (!s.f.goMainDirs.includes(dir)) s.f.goMainDirs.push(dir);
  }
  for (const { n, text } of ls) {
    for (const m of text.matchAll(GO_ENV)) envRead(s, m[1], n, "env-read", undefined);
    for (const m of text.matchAll(GO_ENV_HELPER)) envRead(s, m[1], n, "env-helper", m[2]);
    const listen = /\b(?:ListenAndServe(?:TLS)?|\.Run|\.Listen|\.Start)\(\s{0,2}"[^":\n]{0,60}:(\d{2,5})"/.exec(text);
    if (listen) {
      port(s, listen[1], n, "listen-literal");
      s.f.listenFiles.add(s.path);
    } else if (/\bhttp\.ListenAndServe(?:TLS)?\(/.test(text) || /\.(?:Run|Listen)\(\s{0,2}[A-Za-z":]/.test(text)) {
      s.f.listenFiles.add(s.path);
    }
    if (/\bhttp\.ListenAndServe(?:TLS)?\(/.test(text)) s.ctx.frameworks.add(`net/http\u0000${s.root}`, { name: "Go net/http", root: s.root, role: "web" }, "medium", ev(s.path, "go-listen", n));
    const open = /\bsql\.Open\(\s{0,2}"(postgres|pgx|mysql|sqlite3)"/.exec(text);
    if (open) addDatastore(s.ctx, s.root, open[1] === "mysql" ? "mysql" : open[1] === "sqlite3" ? "sqlite" : "postgres", "high", ev(s.path, "sql-open", n));
    const cron = /\.AddFunc\(\s{0,2}"([^"\n]{1,60})"/.exec(text);
    if (cron) s.f.crons.push({ mechanism: "robfig/cron", confidence: "medium", evidence: ev(s.path, "cron-literal", n), inProcess: true, ...(looksLikeCron(cron[1]) ? { schedule: cron[1].trim() } : {}) });
  }
}

/* ----------------------------------- java -------------------------------- */

const JAVA_ENV = /System\.getenv\(\s{0,2}"([A-Za-z_][A-Za-z0-9_]{0,99})"/g;
const SPRING_PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]{1,99})(?::([^}\n]{0,100}))?\}/g;

export function scanSpringPlaceholders(s: FileScan, text: string, n: number): void {
  for (const m of text.matchAll(SPRING_PLACEHOLDER)) envRead(s, m[1], n, "spring-placeholder", m[2]);
}

function scanJava(s: FileScan, ls: Line[]): void {
  for (const { n, text } of ls) {
    for (const m of text.matchAll(JAVA_ENV)) envRead(s, m[1], n, "env-read", undefined);
    scanSpringPlaceholders(s, text, n);
    const cron = /@Scheduled\(\s{0,4}cron\s{0,4}=\s{0,4}"([^"\n]{1,60})"/.exec(text);
    if (cron) s.f.crons.push({ mechanism: "spring-scheduled", confidence: "medium", evidence: ev(s.path, "cron-literal", n), inProcess: true, ...(looksLikeCron(cron[1]) ? { schedule: cron[1].trim() } : {}) });
  }
}

/* ------------------------------------ php -------------------------------- */

const PHP_ENV = /\b(?:env|getenv)\(\s{0,2}['"]([A-Za-z_][A-Za-z0-9_]{0,99})['"]|\$_ENV\[\s{0,2}['"]([A-Za-z_][A-Za-z0-9_]{0,99})['"]\s{0,2}\]/g;

function scanPhp(s: FileScan, ls: Line[]): void {
  for (const { n, text } of ls) {
    for (const m of text.matchAll(PHP_ENV)) envRead(s, m[1] ?? m[2], n, "env-read", defaultAt(PHP_DEFAULT, text, m.index + m[0].length));
    const db = /env\(\s{0,2}'DB_CONNECTION'\s{0,2},\s{0,2}'(\w{1,20})'/.exec(text);
    if (db) {
      const kind: DatastoreKind | undefined = db[1] === "pgsql" ? "postgres" : db[1] === "mysql" || db[1] === "mariadb" ? "mysql" : db[1] === "sqlite" ? "sqlite" : undefined;
      if (kind) addDatastore(s.ctx, s.root, kind, "medium", ev(s.path, "laravel-db-default", n));
    }
    if (/->(?:everyMinute|everyFiveMinutes|hourly|daily|weekly|monthly|cron)\(/.test(text)) s.f.crons.push({ mechanism: "laravel-scheduler", confidence: "medium", evidence: ev(s.path, "laravel-schedule", n), inProcess: false, command: "php artisan schedule:work" });
  }
}

/* ------------------------------------ rs --------------------------------- */

function scanRs(s: FileScan, ls: Line[]): void {
  for (const { n, text } of ls) {
    for (const m of text.matchAll(/\b(?:std::)?env::var\(\s{0,2}"([A-Za-z_][A-Za-z0-9_]{0,99})"/g)) envRead(s, m[1], n, "env-read", undefined);
    const bind = /TcpListener::bind\(\s{0,2}"[^":\n]{0,40}:(\d{2,5})"/.exec(text) ?? /\.bind\(\s{0,2}\(\s{0,2}"[^"\n]{0,40}"\s{0,2},\s{0,2}(\d{2,5})/.exec(text);
    if (bind) {
      port(s, bind[1], n, "bind-literal");
      s.f.listenFiles.add(s.path);
    }
  }
}

/* -------------------------------- entry point ----------------------------- */

/** Scan one source file. `content` is already size-capped by the snapshot. */
export function scanSourceFile(ctx: Ctx, f: RootFacts, path: string, content: string): void {
  const lang = langOf(path);
  if (!lang) return;
  const s: FileScan = { ctx, f, path, root: f.root.dir };
  const ls = lines(content);
  for (const { n, text } of ls) scanCommon(s, text, n);
  switch (lang) {
    case "js":
      return scanJs(s, ls, content);
    case "py":
      return scanPy(s, ls, content);
    case "rb":
      return scanRb(s, ls);
    case "go":
      return scanGo(s, ls, content);
    case "java":
      return scanJava(s, ls);
    case "php":
      return scanPhp(s, ls);
    case "rs":
      return scanRs(s, ls);
  }
}

