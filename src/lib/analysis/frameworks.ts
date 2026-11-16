/**
 * Framework-specific config readers and migration detection: Prisma schemas,
 * Rails `config/*.yml`, Spring `application.*`, Next.js file routes, and the
 * "how would this app migrate its database" table.
 *
 * Migration commands are CANDIDATES for a human or a release step to run. The
 * analysis never runs them.
 */
import { addDatastore, addEnv, ev } from "./record";
import type { Ctx, RootFacts } from "./model";
import { scanRubyEnvInConfig } from "./sources";
import { basename, joinPath, lines, sanitizeInline } from "./text";
import type { Confidence, DatastoreKind } from "./types";

const inRoot = (f: RootFacts, rel: string): string => joinPath(f.root.dir, rel);

/* ---------------------------------- prisma ---------------------------------- */

const PRISMA_KIND: Record<string, DatastoreKind | undefined> = {
  postgresql: "postgres",
  postgres: "postgres",
  mysql: "mysql",
  mongodb: "mongodb",
  sqlite: "sqlite",
};

function readPrisma(ctx: Ctx, f: RootFacts, path: string): void {
  let inDatasource = false;
  for (const { n, text } of lines(ctx.idx.get(path) ?? "")) {
    const t = text.trim();
    if (/^datasource\s{1,4}[A-Za-z_][A-Za-z0-9_]{0,40}\s{0,4}\{/.test(t)) inDatasource = true;
    else if (inDatasource && t.startsWith("}")) inDatasource = false;
    if (!inDatasource) continue;
    const p = /^provider\s{0,4}=\s{0,4}"([A-Za-z]{2,20})"/.exec(t);
    if (p) {
      const kind = PRISMA_KIND[p[1].toLowerCase()];
      if (kind) addDatastore(ctx, f.root.dir, kind, "high", ev(path, "prisma-provider", n));
      else ctx.unknowns.add(`${path}: Prisma provider "${sanitizeInline(p[1], 20)}" is not one Zenith V1 can provision (postgresql is).`);
    }
    for (const m of t.matchAll(/env\(\s{0,2}"([A-Za-z_][A-Za-z0-9_]{0,99})"\s{0,2}\)/g)) addEnv(ctx, m[1], f.root.dir, "high", ev(path, "prisma-env", n));
  }
}

/* ------------------------------------ rails --------------------------------- */

function readRails(ctx: Ctx, f: RootFacts): void {
  for (const name of ["config/database.yml", "config/storage.yml", "config/cable.yml"]) {
    const text = ctx.idx.get(inRoot(f, name));
    if (text !== undefined) scanRubyEnvInConfig(ctx, f, inRoot(f, name), text);
  }
  const db = inRoot(f, "config/database.yml");
  const dbText = ctx.idx.get(db);
  if (dbText !== undefined) {
    let env = "";
    for (const { n, text } of lines(dbText)) {
      const top = /^([A-Za-z_][A-Za-z0-9_]{0,40}):\s{0,3}(?:&[A-Za-z_]\w{0,30})?\s{0,3}$/.exec(text);
      if (top) env = top[1];
      const a = /^\s{2,8}adapter:\s{1,4}["']?([A-Za-z0-9_]{2,30})["']?\s{0,3}$/.exec(text);
      if (!a) continue;
      const adapter = a[1].toLowerCase();
      const kind: DatastoreKind | undefined = adapter === "postgresql" || adapter === "postgis" ? "postgres" : adapter === "mysql2" || adapter === "trilogy" || adapter === "mysql" ? "mysql" : adapter === "sqlite3" ? "sqlite" : undefined;
      if (!kind) continue;
      // sqlite in development/test is the Rails default and says nothing about production
      if (kind === "sqlite" && (env === "development" || env === "test")) continue;
      addDatastore(ctx, f.root.dir, kind, kind === "sqlite" ? "medium" : "high", ev(db, "rails-database-yml", n));
    }
  }
  const storage = inRoot(f, "config/storage.yml");
  const st = ctx.idx.get(storage);
  if (st !== undefined) {
    for (const { n, text } of lines(st)) if (/^\s{2,8}service:\s{1,4}S3\b/.test(text)) addDatastore(ctx, f.root.dir, "object_store", "high", ev(storage, "rails-storage-s3", n), { engine: "s3" });
  }
  const cable = inRoot(f, "config/cable.yml");
  const cb = ctx.idx.get(cable);
  if (cb !== undefined) {
    for (const { n, text } of lines(cb)) if (/^\s{2,8}adapter:\s{1,4}redis\b/.test(text)) addDatastore(ctx, f.root.dir, "redis", "medium", ev(cable, "rails-cable-redis", n));
  }
  const sk = inRoot(f, "config/sidekiq.yml");
  if (ctx.idx.has(sk)) f.workers.push({ tech: "sidekiq", confidence: "high", evidence: ev(sk, "file:sidekiq.yml", 1), command: "bundle exec sidekiq" });
}

/* ------------------------------------ spring -------------------------------- */

function readSpring(ctx: Ctx, f: RootFacts, path: string): void {
  const isYaml = /\.ya?ml$/.test(path);
  let inServer = false;
  for (const { n, text } of lines(ctx.idx.get(path) ?? "")) {
    if (/^\s{0,80}#/.test(text)) continue;
    for (const m of text.matchAll(/\$\{([A-Z][A-Z0-9_]{1,99})(?::([^}\n]{0,100}))?\}/g)) addEnv(ctx, m[1], f.root.dir, "high", ev(path, "spring-placeholder", n), m[2]);
    const jdbc = /\bjdbc:(postgresql|mysql|mariadb|sqlite)\b/.exec(text);
    if (jdbc) addDatastore(ctx, f.root.dir, jdbc[1] === "postgresql" ? "postgres" : jdbc[1] === "sqlite" ? "sqlite" : "mysql", "high", ev(path, "spring-datasource-url", n));
    if (/^\s{0,80}spring\.(?:data\.)?redis\./.test(text)) addDatastore(ctx, f.root.dir, "redis", "high", ev(path, "spring-redis", n));
    if (/^\s{0,80}spring\.data\.mongodb\./.test(text)) addDatastore(ctx, f.root.dir, "mongodb", "high", ev(path, "spring-mongodb", n));
    if (/^\s{0,80}spring\.rabbitmq\./.test(text)) addDatastore(ctx, f.root.dir, "rabbitmq", "high", ev(path, "spring-rabbitmq", n), { engine: "amqp" });
    if (/^\s{0,80}spring\.mail\.host\b/.test(text)) addDatastore(ctx, f.root.dir, "email", "high", ev(path, "spring-mail", n), { engine: "smtp" });
    if (/^\s{0,80}spring\.kafka\./.test(text)) addDatastore(ctx, f.root.dir, "kafka", "high", ev(path, "spring-kafka", n));
    let portText: string | undefined;
    if (!isYaml) portText = /^\s{0,80}server\.port\s{0,4}[=:]\s{0,4}(\S{1,40})/.exec(text)?.[1];
    else {
      if (/^server:\s{0,3}$/.test(text)) inServer = true;
      else if (/^\S/.test(text)) inServer = false;
      if (inServer) portText = /^\s{2,8}port:\s{1,4}["']?([^"'\s#]{1,40})/.exec(text)?.[1];
    }
    if (portText) {
      const literal = /^(\d{2,5})$/.exec(portText) ?? /^\$\{[A-Z_]{1,40}:(\d{2,5})\}$/.exec(portText);
      if (literal && Number(literal[1]) <= 65535) f.ports.push({ port: Number(literal[1]), rank: 4, source: "server.port", evidence: ev(path, "spring-server-port", n) });
    }
  }
}

/* ---------------------------------- next.js --------------------------------- */

const NEXT_HEALTH = /^(?:src\/)?(?:app|pages)\/(.{0,80})\.(?:js|jsx|ts|tsx|mjs)$/;

/** `app/api/health/route.ts` → `/api/health`. */
function nextHealthRoute(rel: string): string | undefined {
  const m = NEXT_HEALTH.exec(rel);
  if (!m) return undefined;
  const route = m[1].replace(/\/(?:route|page|index)$/, "");
  return /^(?:api\/)?(?:health|healthz|_health|up)$/.test(route) ? `/${route}` : undefined;
}

/* ---------------------------------- driver ---------------------------------- */

export function readFrameworkConfigs(ctx: Ctx, f: RootFacts): void {
  const dir = f.root.dir;
  for (const p of [...f.fileSet].sort()) {
    const rel = dir === "" ? p : p.slice(dir.length + 1);
    const base = basename(p);
    if (base === "schema.prisma") readPrisma(ctx, f, p);
    else if (/^application(?:-[a-z0-9_]{1,30})?\.(?:properties|ya?ml)$/.test(base)) readSpring(ctx, f, p);
    const health = nextHealthRoute(rel);
    if (health && f.deps.has("npm:next")) f.healths.push({ path: health, declared: false, evidence: ev(p, "next-file-route") });
  }
  if (f.deps.has("gem:rails") || ctx.idx.has(inRoot(f, "config/database.yml"))) readRails(ctx, f);
}

/* -------------------------------- migrations -------------------------------- */

interface Mig {
  tool: string;
  command: string;
  conf: Confidence;
  note?: string;
  evidence: ReturnType<typeof ev>;
}

const SCRIPT_MIGRATIONS: { re: RegExp; tool: string }[] = [
  { re: /\bprisma migrate deploy\b/, tool: "prisma" },
  { re: /\bknex migrate:latest\b/, tool: "knex" },
  { re: /\btypeorm(?:-ts-node-\w+)? migration:run\b/, tool: "typeorm" },
  { re: /\bsequelize(?:-cli)? db:migrate\b/, tool: "sequelize" },
  { re: /\bdrizzle-kit migrate\b/, tool: "drizzle" },
  { re: /\bnode-pg-migrate up\b/, tool: "node-pg-migrate" },
  { re: /\bdb-migrate up\b/, tool: "db-migrate" },
];

/** Every plausible migration command for the root. Deterministic, never executed. */
export function detectMigrations(ctx: Ctx, f: RootFacts): Mig[] {
  const out: Mig[] = [];
  const has = (k: string) => f.deps.get(k);
  const files = [...f.fileSet];
  const anyUnder = (prefix: string) => files.some((p) => p.startsWith(joinPath(f.root.dir, prefix)));
  const first = (pred: (p: string) => boolean) => files.filter(pred).sort()[0];

  // scripts that already spell the command out
  for (const [name, body] of [...(f.pkg?.scripts ?? new Map<string, string>()).entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const hit = SCRIPT_MIGRATIONS.find((s) => s.re.test(body));
    // the script NAME becomes part of a command line, so it must be a plain identifier
    if (hit && f.pkg && /^[A-Za-z0-9:_.-]{1,60}$/.test(name)) out.push({ tool: hit.tool, command: `npm run ${name}`, conf: "high", note: `package.json script "${name}" runs ${hit.tool} migrations`, evidence: ev(f.pkg.path, `script:${name}`) });
  }

  const prismaSchema = first((p) => basename(p) === "schema.prisma");
  if (prismaSchema && (has("npm:prisma") || has("npm:@prisma/client"))) {
    const schemaDir = prismaSchema.slice(0, prismaSchema.lastIndexOf("/") + 1);
    const migrations = files.some((p) => p.startsWith(`${schemaDir}migrations/`));
    out.push({
      tool: "prisma",
      command: "npx prisma migrate deploy",
      conf: migrations ? "high" : "medium",
      ...(migrations ? {} : { note: "no prisma/migrations directory found; the schema may be applied with `prisma db push`, which is not a release-safe migration" }),
      evidence: ev(prismaSchema, migrations ? "prisma-migrations-dir" : "prisma-schema"),
    });
  }
  const knexfile = first((p) => /(?:^|\/)knexfile\.[a-z]{2,3}$/.test(p));
  if (has("npm:knex") && (knexfile || anyUnder("migrations/") || anyUnder("db/migrations/"))) out.push({ tool: "knex", command: "npx knex migrate:latest", conf: knexfile ? "high" : "medium", evidence: has("npm:knex")!.evidence });
  if (has("npm:typeorm") && (anyUnder("src/migrations/") || anyUnder("migrations/"))) {
    out.push({ tool: "typeorm", command: "npx typeorm migration:run", conf: "medium", note: "TypeORM 0.3+ needs `-d <data-source file>`; add it once known", evidence: has("npm:typeorm")!.evidence });
  }
  if (has("npm:sequelize-cli") || ctx.idx.has(inRoot(f, ".sequelizerc"))) out.push({ tool: "sequelize", command: "npx sequelize-cli db:migrate", conf: has("npm:sequelize-cli") ? "high" : "medium", evidence: (has("npm:sequelize-cli") ?? { evidence: ev(inRoot(f, ".sequelizerc"), "file:.sequelizerc") }).evidence });
  if (has("npm:drizzle-kit")) out.push({ tool: "drizzle", command: "npx drizzle-kit migrate", conf: "medium", evidence: has("npm:drizzle-kit")!.evidence });
  if (has("npm:node-pg-migrate")) out.push({ tool: "node-pg-migrate", command: "npx node-pg-migrate up", conf: "medium", evidence: has("npm:node-pg-migrate")!.evidence });

  const alembicIni = inRoot(f, "alembic.ini");
  if (ctx.idx.has(alembicIni) || has("pip:alembic")) out.push({ tool: "alembic", command: "alembic upgrade head", conf: ctx.idx.has(alembicIni) ? "high" : "medium", evidence: ctx.idx.has(alembicIni) ? ev(alembicIni, "file:alembic.ini") : has("pip:alembic")!.evidence });
  if (has("pip:django") && ctx.idx.has(inRoot(f, "manage.py"))) out.push({ tool: "django", command: "python manage.py migrate --noinput", conf: "high", evidence: ev(inRoot(f, "manage.py"), "file:manage.py") });
  if (has("pip:flask-migrate")) out.push({ tool: "flask-migrate", command: "flask db upgrade", conf: "medium", evidence: has("pip:flask-migrate")!.evidence });

  if (has("gem:rails") && (anyUnder("db/migrate/") || ctx.idx.has(inRoot(f, "db/schema.rb")))) out.push({ tool: "rails", command: "bundle exec rails db:migrate", conf: "high", evidence: has("gem:rails")!.evidence });

  const laravel = has("composer:laravel/framework");
  if (laravel) out.push({ tool: "laravel", command: "php artisan migrate --force", conf: anyUnder("database/migrations/") ? "high" : "medium", evidence: laravel.evidence });

  const flyway = has("mvn:flyway-core");
  if (flyway) out.push({ tool: "flyway", command: "flyway migrate", conf: "medium", note: "Spring Boot runs Flyway automatically at startup when flyway-core is on the classpath", evidence: flyway.evidence });
  const liquibase = has("mvn:liquibase-core");
  if (liquibase) out.push({ tool: "liquibase", command: "liquibase update", conf: "medium", note: "Spring Boot runs Liquibase automatically at startup when liquibase-core is on the classpath", evidence: liquibase.evidence });

  const goose = [...f.deps.values()].find((d) => d.eco === "go" && (d.name === "github.com/pressly/goose" || d.name.startsWith("github.com/pressly/goose/")));
  if (goose) out.push({ tool: "goose", command: "goose up", conf: "medium", note: "goose needs the migrations directory and a database DSN (`-dir`, driver, DSN)", evidence: goose.evidence });
  const migrate = [...f.deps.values()].find((d) => d.eco === "go" && d.name.startsWith("github.com/golang-migrate/migrate"));
  if (migrate) out.push({ tool: "golang-migrate", command: 'migrate -path migrations -database "$DATABASE_URL" up', conf: "medium", note: "assumes migrations live in ./migrations and DATABASE_URL names the database", evidence: migrate.evidence });

  for (const e of f.procfile?.entries ?? []) if (e.type === "release") out.push({ tool: "procfile-release", command: e.command, conf: "high", note: "Procfile release phase", evidence: ev(f.procfile!.path, "procfile:release", e.line) });
  return out;
}
