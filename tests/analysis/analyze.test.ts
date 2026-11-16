import { describe, expect, it } from "vitest";
import { analyzeRepository } from "@/lib/analysis";
import { analyzeFiles, datastoreKinds, env, inferences, service } from "./helpers";
import { nextjsPrismaRedis } from "./fixtures/nextjs-prisma-redis";
import { expressBullmqProcfile } from "./fixtures/express-bullmq-procfile";
import { djangoCeleryPostgres } from "./fixtures/django-celery-postgres";
import { fastapiSqlalchemyAlembic } from "./fixtures/fastapi-sqlalchemy-alembic";
import { railsSidekiqPostgres } from "./fixtures/rails-sidekiq-postgres";
import { goGinDockerfile } from "./fixtures/go-gin-dockerfile";
import { viteSpa } from "./fixtures/vite-spa";
import { monorepoTwoServices } from "./fixtures/monorepo-two-services";
import { flaskUnsupportedStores } from "./fixtures/flask-unsupported-stores";
import { springBootMaven } from "./fixtures/spring-boot-maven";
import { composeStack } from "./fixtures/compose-stack";

const FIXTURES: Record<string, Record<string, string>> = {
  nextjsPrismaRedis,
  expressBullmqProcfile,
  djangoCeleryPostgres,
  fastapiSqlalchemyAlembic,
  railsSidekiqPostgres,
  goGinDockerfile,
  viteSpa,
  monorepoTwoServices,
  flaskUnsupportedStores,
  springBootMaven,
  composeStack,
};

const evidencePaths = (i: { evidence: { path: string }[] }): string[] => i.evidence.map((e) => e.path);

describe("every inference carries evidence", () => {
  for (const [name, files] of Object.entries(FIXTURES)) {
    it(`${name}: non-empty evidence that points at real files`, () => {
      const { snapshot, req } = analyzeFiles(files);
      const paths = new Set(snapshot.files.map((f) => f.path));
      const found = inferences(req);
      expect(found.length).toBeGreaterThan(3);
      for (const { path, inference } of found) {
        // an unknown build plan ("needs Dockerfile") is the one inference that has nothing to point at
        const unknownBuild = path.startsWith("$.builds") && (inference.value as { strategy?: string }).strategy === "unknown";
        if (!unknownBuild) expect(inference.evidence.length, path).toBeGreaterThan(0);
        expect(["high", "medium", "low"]).toContain(inference.confidence);
        for (const e of inference.evidence) {
          expect(e.rule.length, path).toBeGreaterThan(0);
          expect(paths.has(e.path), `${path}: ${e.path} is not a file in the snapshot`).toBe(true);
          if (e.line !== undefined) expect(Number.isInteger(e.line) && e.line >= 1).toBe(true);
        }
      }
    });
  }
});

describe("Next.js + Prisma + Redis + Dockerfile", () => {
  const { req } = analyzeFiles(nextjsPrismaRedis);

  it("finds one web service on 3000 with a Dockerfile build and its health check", () => {
    expect(req.services.map((s) => s.value.name)).toEqual(["web"]);
    const web = service(req, "web");
    expect(web.kind).toBe("web");
    expect(web.root).toBe("");
    expect(web.port?.value).toBe(3000);
    expect(web.port?.confidence).toBe("high");
    expect(evidencePaths(web.port!)).toContain("Dockerfile");
    expect(web.startCommand?.value).toBe("node server.js");
    expect(web.healthPath?.value).toBe("/api/health");
    expect(web.healthPath?.confidence).toBe("high");
    const build = req.builds[0];
    expect(build.value.strategy).toBe("dockerfile");
    expect(build.value.dockerfile).toBe("Dockerfile");
    expect(build.value.needsDockerfile).toBe(false);
    expect(build.confidence).toBe("high");
  });

  it("reads runtime and framework", () => {
    expect(req.runtimes.find((r) => r.value.language === "node")?.value.version).toBe(">=20");
    const next = req.frameworks.find((f) => f.value.name === "Next.js");
    expect(next?.confidence).toBe("high");
    expect(evidencePaths(next!)).toContain("package.json");
  });

  it("finds postgres via the Prisma provider and redis via ioredis, with evidence", () => {
    expect(datastoreKinds(req)).toEqual(["postgres", "redis"]);
    const pg = req.datastores.find((d) => d.value.kind === "postgres")!;
    expect(evidencePaths(pg)).toContain("prisma/schema.prisma");
    expect(pg.evidence.find((e) => e.rule === "prisma-provider")?.line).toBe(6);
    const redis = req.datastores.find((d) => d.value.kind === "redis")!;
    expect(evidencePaths(redis)).toEqual(expect.arrayContaining(["package.json", "src/lib/redis.ts"]));
    expect(req.datastores.every((d) => d.value.supportedInV1)).toBe(true);
  });

  it("proposes prisma migrate deploy as a candidate and never as an action", () => {
    expect(req.migrations).toHaveLength(1);
    expect(req.migrations[0].value).toMatchObject({ tool: "prisma", command: "npx prisma migrate deploy" });
    expect(req.migrations[0].confidence).toBe("high");
  });

  it("classifies env names and keeps only plain code defaults", () => {
    expect(env(req, "DATABASE_URL")?.classification).toBe("secret");
    expect(env(req, "REDIS_URL")?.classification).toBe("secret");
    expect(env(req, "NEXTAUTH_SECRET")?.classification).toBe("secret");
    expect(env(req, "REDIS_URL")?.defaultValue).toBeUndefined(); // secret names never carry a default, even when code has one
    expect(env(req, "APP_NAME")).toMatchObject({ classification: "config", defaultValue: "Shop" });
    expect(env(req, "NEXT_PUBLIC_SITE_URL")).toMatchObject({ classification: "config" });
    expect(env(req, "NEXT_PUBLIC_SITE_URL")?.defaultValue).toBeUndefined();
    expect(env(req, "NODE_ENV")?.defaultValue).toBe("production"); // from the Dockerfile ENV
  });

  it("has no unknowns or risks worth reporting for a complete repository", () => {
    expect(req.risks).toEqual([]);
    expect(req.unknowns).toEqual([]);
  });
});

describe("Express + pg + bullmq worker + Procfile", () => {
  const { req } = analyzeFiles(expressBullmqProcfile);

  it("splits web and worker from the Procfile with their commands", () => {
    expect(req.services.map((s) => `${s.value.name}:${s.value.kind}`)).toEqual(["web:web", "worker:worker"]);
    expect(service(req, "web").startCommand?.value).toBe("node server.js");
    expect(evidencePaths(service(req, "web").startCommand!)).toEqual(["Procfile"]);
    expect(service(req, "worker").startCommand).toMatchObject({ value: "node worker.js", confidence: "high" });
  });

  it("takes the port from the PORT default and the health route from code", () => {
    const web = service(req, "web");
    expect(web.port?.value).toBe(8080);
    expect(web.port?.confidence).toBe("medium");
    expect(web.port?.evidence[0]).toMatchObject({ path: "server.js", line: 7 });
    expect(web.healthPath?.value).toBe("/healthz");
    expect(web.healthPath?.confidence).toBe("medium");
  });

  it("finds postgres, redis (bullmq) and email (nodemailer)", () => {
    expect(datastoreKinds(req)).toEqual(["email", "postgres", "redis"]);
  });

  it("offers knex migrations from both the dependency and the release phase", () => {
    expect(req.migrations.map((m) => m.value.tool).sort()).toEqual(["knex", "procfile-release"]);
    for (const m of req.migrations) expect(m.value.command).toBe("npx knex migrate:latest");
  });

  it("reports the missing Dockerfile as a risk and infers a node recipe", () => {
    expect(req.risks.some((r) => r.startsWith("No Dockerfile at the repository root"))).toBe(true);
    expect(req.builds[0].value).toMatchObject({ strategy: "buildpack", language: "node", installCommand: "npm install" });
    expect(req.builds[0].confidence).toBe("medium");
  });

  it("records smtp host default as config", () => {
    expect(env(req, "SMTP_HOST")).toMatchObject({ classification: "config", defaultValue: "smtp.internal" });
  });
});

describe("Django + celery + postgres + requirements.txt", () => {
  const { req } = analyzeFiles(djangoCeleryPostgres);

  it("finds web, worker and celery beat (cron)", () => {
    expect(req.services.map((s) => `${s.value.name}:${s.value.kind}`)).toEqual(["web:web", "worker:worker", "beat:cron"]);
    expect(service(req, "web").port).toMatchObject({ value: 8000, confidence: "high" }); // --bind in the Procfile
    expect(service(req, "worker").startCommand?.value).toBe("celery -A myproj worker -l info");
    expect(service(req, "beat").startCommand?.value).toBe("celery -A myproj beat -l info");
  });

  it("finds postgres from the Django ENGINE, redis from the broker, and email", () => {
    expect(datastoreKinds(req)).toEqual(["email", "postgres", "redis"]);
    const pg = req.datastores.find((d) => d.value.kind === "postgres")!;
    expect(pg.evidence.map((e) => e.rule)).toEqual(expect.arrayContaining(["django-engine", "dep:pip:psycopg2-binary"]));
    const redis = req.datastores.find((d) => d.value.kind === "redis")!;
    expect(redis.evidence.map((e) => e.rule)).toContain("dep:pip:celery[redis]");
  });

  it("offers manage.py migrate and reads the python version and health route", () => {
    expect(req.migrations.some((m) => m.value.tool === "django" && m.value.command === "python manage.py migrate --noinput")).toBe(true);
    expect(req.runtimes.find((r) => r.value.language === "python")?.value.version).toBe("3.12");
    expect(service(req, "web").healthPath?.value).toBe("/health/");
  });

  it("marks broker URL and credentials as secrets", () => {
    for (const name of ["CELERY_BROKER_URL", "DB_PASSWORD", "DJANGO_SECRET_KEY"]) expect(env(req, name)?.classification, name).toBe("secret");
    expect(env(req, "DEBUG")).toMatchObject({ classification: "config", defaultValue: "false" });
    expect(env(req, "DB_NAME")).toMatchObject({ classification: "config", defaultValue: "app" });
  });

  it("says the beat schedule cannot be turned into a cron expression", () => {
    expect(req.unknowns.some((u) => u.includes("schedule of beat"))).toBe(true);
  });
});

describe("FastAPI + SQLAlchemy + alembic, no Dockerfile", () => {
  const { req } = analyzeFiles(fastapiSqlalchemyAlembic);

  it("infers a python recipe with medium confidence and says there is no Dockerfile", () => {
    expect(req.builds[0].value).toMatchObject({ strategy: "buildpack", language: "python", installCommand: "pip install -r requirements.txt", needsDockerfile: false });
    expect(req.builds[0].confidence).toBe("medium");
    expect(req.risks.some((r) => r.includes("No Dockerfile"))).toBe(true);
  });

  it("finds fastapi on the framework-default port (low) with a uvicorn start recipe and /health", () => {
    const web = service(req, "web");
    expect(web.port).toMatchObject({ value: 8000, confidence: "low" });
    expect(web.startCommand?.value).toBe("uvicorn app.main:app --host 0.0.0.0 --port 8000");
    expect(evidencePaths(web.startCommand!)).toEqual(["app/main.py"]);
    expect(web.healthPath).toMatchObject({ value: "/health", confidence: "medium" });
  });

  it("finds postgres and alembic", () => {
    expect(datastoreKinds(req)).toEqual(["postgres"]);
    expect(req.migrations).toHaveLength(1);
    expect(req.migrations[0].value).toMatchObject({ tool: "alembic", command: "alembic upgrade head" });
    expect(env(req, "DATABASE_URL")?.classification).toBe("secret");
  });
});

describe("Rails + sidekiq + whenever", () => {
  const { req } = analyzeFiles(railsSidekiqPostgres);

  it("finds web on 3000, a sidekiq worker and a whenever cron", () => {
    expect(req.services.map((s) => `${s.value.name}:${s.value.kind}`)).toEqual(["web:web", "worker:worker", "whenever:cron"]);
    expect(service(req, "web").port).toMatchObject({ value: 3000, confidence: "medium" });
    expect(service(req, "web").healthPath?.value).toBe("/up");
    expect(service(req, "worker").startCommand?.value).toBe("bundle exec sidekiq");
  });

  it("reads postgres from database.yml, redis from sidekiq, S3 from Active Storage; ignores dev-only sqlite", () => {
    expect(datastoreKinds(req)).toEqual(["object_store", "postgres", "redis"]);
    expect(req.datastores.find((d) => d.value.kind === "postgres")!.evidence.map((e) => e.path)).toContain("config/database.yml");
    expect(req.datastores.find((d) => d.value.kind === "object_store")!.evidence.map((e) => e.path)).toContain("config/storage.yml");
    expect(req.risks.some((r) => r.toLowerCase().includes("sqlite"))).toBe(false);
  });

  it("offers db:migrate and reads names from ERB in yml", () => {
    expect(req.migrations[0].value.command).toBe("bundle exec rails db:migrate");
    expect(env(req, "DATABASE_URL")?.classification).toBe("secret");
    expect(env(req, "S3_BUCKET")?.classification).toBe("config");
    expect(req.runtimes.find((r) => r.value.language === "ruby")?.value.version).toBe("3.3.0");
  });
});

describe("Go + gin + Dockerfile EXPOSE", () => {
  const { req } = analyzeFiles(goGinDockerfile);

  it("uses EXPOSE as the port with high confidence, corroborated by the listen call", () => {
    const web = service(req, "web");
    expect(web.port).toMatchObject({ value: 8080, confidence: "high" });
    expect(web.port!.evidence.map((e) => e.rule)).toEqual(expect.arrayContaining(["dockerfile:EXPOSE", "listen-literal"]));
    expect(web.startCommand?.value).toBe("/app");
    expect(web.healthPath?.value).toBe("/healthz");
  });

  it("reads go version, gin, pgx and the Dockerfile build", () => {
    expect(req.runtimes.find((r) => r.value.language === "go")?.value.version).toBe("1.22");
    expect(req.frameworks.map((f) => f.value.name)).toEqual(["Gin"]);
    expect(datastoreKinds(req)).toEqual(["postgres"]);
    expect(req.builds[0].value.strategy).toBe("dockerfile");
    expect(req.risks).toEqual([]);
  });
});

describe("static Vite SPA", () => {
  const { req } = analyzeFiles(viteSpa);

  it("is a static service with no port, built with the package script", () => {
    expect(req.services).toHaveLength(1);
    const web = service(req, "web");
    expect(web.kind).toBe("static");
    expect(web.port).toBeUndefined();
    expect(req.builds[0].value).toMatchObject({ strategy: "static", installCommand: "npm ci", buildCommand: "npm run build", outputDir: "dist" });
    expect(req.datastores).toEqual([]);
  });

  it("notes the unpinned node version and the client env name", () => {
    expect(req.unknowns.some((u) => u.includes("node version is not pinned"))).toBe(true);
    expect(env(req, "VITE_API_URL")).toMatchObject({ classification: "config" });
  });
});

describe("monorepo with two services", () => {
  const { req } = analyzeFiles(monorepoTwoServices);

  it("detects turborepo and lists workspace packages", () => {
    expect(req.monorepo?.value.tool).toBe("turborepo");
    expect(req.monorepo?.confidence).toBe("high");
    expect(req.monorepo?.value.packages.map((p) => p.root)).toEqual(["apps/api", "apps/web", "packages/db", "packages/ui"]);
  });

  it("finds a candidate service per app, with paths and per-app details", () => {
    expect(req.services.map((s) => `${s.value.name}:${s.value.root}`)).toEqual(["api:apps/api", "web:apps/web"]);
    expect(service(req, "api").port).toMatchObject({ value: 4000, confidence: "high" });
    expect(service(req, "web").port).toMatchObject({ value: 3100, confidence: "high" }); // `next start -p 3100`
    expect(req.builds.find((b) => b.value.root === "apps/api")?.value.dockerfile).toBe("apps/api/Dockerfile");
    expect(req.builds.find((b) => b.value.root === "apps/web")?.value.strategy).toBe("buildpack");
  });

  it("does not treat the workspace root or libraries as services", () => {
    expect(req.services.some((s) => s.value.root === "" || s.value.root.startsWith("packages/"))).toBe(false);
  });

  it("gives the api the database that lives in @acme/db, and the web app none", () => {
    const apiPg = req.datastores.find((d) => d.value.kind === "postgres" && d.value.root === "apps/api");
    expect(apiPg).toBeDefined();
    expect(apiPg!.evidence.some((e) => e.rule === "workspace-dep:@acme/db")).toBe(true);
    expect(apiPg!.confidence).toBe("medium"); // one step below the library's own evidence
    expect(req.datastores.some((d) => d.value.root === "apps/web")).toBe(false);
  });
});

describe("datastores the V1 manifest cannot express", () => {
  const { req } = analyzeFiles(flaskUnsupportedStores);

  it("records mysql, mongodb and rabbitmq as unsupported requirements with notes", () => {
    expect(datastoreKinds(req)).toEqual(["mongodb", "mysql", "rabbitmq"]);
    for (const d of req.datastores) {
      expect(d.value.supportedInV1).toBe(false);
      expect(d.value.note).toMatch(/V1/);
    }
    expect(req.risks.filter((r) => r.startsWith("Unsupported datastore"))).toHaveLength(3);
  });

  it("finds flask on the explicit run port", () => {
    expect(service(req, "web").port).toMatchObject({ value: 5000, confidence: "medium" });
    expect(service(req, "web").startCommand?.value).toBe("gunicorn app:app --bind 0.0.0.0:5000");
    expect(service(req, "web").startCommand?.confidence).toBe("medium"); // gunicorn is a dependency
  });
});

describe("Spring Boot + Maven", () => {
  const { req } = analyzeFiles(springBootMaven);

  it("reads port, java version, datastores, actuator health and Flyway", () => {
    const web = service(req, "web");
    expect(web.port).toMatchObject({ value: 8081, confidence: "medium" });
    expect(web.healthPath?.value).toBe("/actuator/health");
    expect(req.runtimes.find((r) => r.value.language === "java")?.value.version).toBe("21");
    expect(datastoreKinds(req)).toEqual(["postgres", "redis"]);
    expect(req.migrations[0].value).toMatchObject({ tool: "flyway", command: "flyway migrate" });
    expect(req.builds[0].value).toMatchObject({ strategy: "buildpack", language: "java", buildCommand: "mvn -B package -DskipTests" });
  });

  it("takes env names and defaults from Spring placeholders", () => {
    expect(env(req, "DB_HOST")).toMatchObject({ classification: "config", defaultValue: "localhost" });
    expect(env(req, "DB_PASSWORD")).toMatchObject({ classification: "secret" });
  });
});

describe("docker-compose (through the compose importer)", () => {
  const { req } = analyzeFiles(composeStack);

  it("attributes datastore images to the service that uses them", () => {
    expect(datastoreKinds(req)).toEqual(["mongodb", "mysql", "postgres", "rabbitmq", "redis"]);
    const pg = req.datastores.find((d) => d.value.kind === "postgres")!;
    expect(pg.evidence.some((e) => e.path === "docker-compose.yml" && e.rule === "compose:image:postgres")).toBe(true);
    expect(pg.value.root).toBe("");
  });

  it("types mysql and mongo correctly (the importer would call them postgres and a service)", () => {
    expect(req.datastores.find((d) => d.value.kind === "mysql")?.value.supportedInV1).toBe(false);
    expect(req.datastores.find((d) => d.value.kind === "mongodb")?.value.supportedInV1).toBe(false);
    expect(req.services.map((s) => s.value.name)).toEqual(["web"]);
  });

  it("reads the health check and reports images it does not model", () => {
    expect(service(req, "web").healthPath).toMatchObject({ value: "/ready", confidence: "high" });
    expect(req.unknowns.some((u) => u.includes('"search"') && u.includes("elasticsearch"))).toBe(true);
    expect(req.infrastructure.some((i) => i.value.kind === "docker-compose")).toBe(true);
  });

  it("carries environment NAMES from compose but no compose values", () => {
    expect(env(req, "LEGACY_DB")).toMatchObject({ classification: "config" });
    expect(env(req, "LEGACY_DB")?.defaultValue).toBeUndefined();
    expect(JSON.stringify(req)).not.toContain("ledger:ledger");
  });
});

describe("other deployment evidence", () => {
  it("reads vercel.json crons, build output and marks the file as infrastructure", () => {
    const { req } = analyzeFiles({
      "package.json": JSON.stringify({ name: "site", dependencies: { next: "14.0.0" } }),
      "vercel.json": JSON.stringify({ crons: [{ path: "/api/cleanup", schedule: "0 3 * * *" }], outputDirectory: ".next" }),
    });
    const cron = req.services.find((s) => s.value.kind === "cron")!;
    expect(cron.value.schedule).toMatchObject({ value: "0 3 * * *", confidence: "high" });
    expect(cron.value.target).toBe("/api/cleanup");
    expect(req.infrastructure.some((i) => i.value.kind === "vercel")).toBe(true);
  });

  it("marks in-process schedulers as such and warns about replicas", () => {
    const { req } = analyzeFiles({
      "package.json": JSON.stringify({ name: "api", dependencies: { express: "4", "node-cron": "3" } }),
      "server.js": 'const cron = require("node-cron");\ncron.schedule("*/5 * * * *", () => {});\nrequire("express")().listen(3000);\n',
    });
    const cron = req.services.find((s) => s.value.kind === "cron")!;
    expect(cron.value.inProcess).toBe(true);
    expect(cron.value.schedule?.value).toBe("*/5 * * * *");
    expect(req.risks.some((r) => r.includes("In-process scheduler"))).toBe(true);
  });

  it("reads typeorm, sequelize and knex dialects only when the library is a dependency", () => {
    const orm = (dep: string, code: string) =>
      analyzeFiles({ "package.json": JSON.stringify({ dependencies: { [dep]: "1" } }), "src/db.ts": code }).req;
    expect(datastoreKinds(orm("typeorm", 'export default { type: "postgres" }'))).toEqual(["postgres"]);
    expect(datastoreKinds(orm("sequelize", 'new Sequelize({ dialect: "mysql" })'))).toEqual(["mysql"]);
    expect(datastoreKinds(orm("knex", 'export default { client: "pg" }'))).toEqual(["postgres"]);
    expect(datastoreKinds(orm("left-pad", 'export default { type: "postgres", client: "pg", dialect: "mysql" }'))).toEqual([]);
  });

  it("reads Terraform through the importer as evidence for datastores", () => {
    const { req } = analyzeFiles({
      "package.json": JSON.stringify({ dependencies: { express: "4" } }),
      "infra/main.tf": 'resource "aws_db_instance" "main" {\n}\n\n\n\nresource "aws_s3_bucket" "assets" {\n}\n',
    });
    expect(datastoreKinds(req)).toEqual(["object_store", "postgres"]);
    expect(req.infrastructure.find((i) => i.value.kind === "terraform")?.value.detail).toBe("2 recognised resource(s)");
    expect(req.datastores.find((d) => d.value.kind === "postgres")?.evidence[0].rule).toBe("terraform:aws_db_instance");
  });

  it("reads Kubernetes manifests, fly.toml and render.yaml as evidence", () => {
    const { req } = analyzeFiles({
      "package.json": JSON.stringify({ dependencies: { express: "4" } }),
      "k8s/cron.yaml": "apiVersion: batch/v1\nkind: CronJob\nmetadata:\n  name: x\nspec:\n  schedule: \"*/10 * * * *\"\n",
      "fly.toml": 'app = "x"\n[http_service]\n  internal_port = 9090\n[[http_service.checks]]\n  path = "/status"\n',
      "render.yaml": "services:\n  - type: web\n    name: x\n    healthCheckPath: /ping\n    envVars:\n      - key: FROM_RENDER\n",
    });
    expect(req.infrastructure.map((i) => i.value.kind).sort()).toEqual(["fly", "kubernetes", "render"]);
    const web = service(req, "web");
    expect(web.port).toMatchObject({ value: 9090 });
    expect(web.healthPath?.confidence).toBe("high");
    expect(req.services.some((s) => s.value.kind === "cron" && s.value.schedule?.value === "*/10 * * * *")).toBe(true);
    expect(env(req, "FROM_RENDER")).toBeDefined();
  });

  it("flags a Dockerfile-less repo whose build cannot be inferred", () => {
    const { req } = analyzeFiles({ "Cargo.toml": '[package]\nname = "x"\n[dependencies]\naxum = "0.7"\n', "src/main.rs": 'fn main() { let l = std::net::TcpListener::bind("0.0.0.0:3000"); }\n' });
    expect(req.services.map((s) => s.value.kind)).toEqual(["web"]);
    expect(req.builds[0].value).toMatchObject({ strategy: "unknown", needsDockerfile: true, language: "rust" });
    expect(req.unknowns.some((u) => u.startsWith("Needs Dockerfile"))).toBe(true);
    expect(req.services[0].value.port).toMatchObject({ value: 3000 });
  });

  it("returns an honest empty result for a repository with nothing to deploy", () => {
    const { req } = analyzeFiles({ "notes.txt": "hello" });
    expect(req.services).toEqual([]);
    expect(req.unknowns.some((u) => u.includes("No deployable service"))).toBe(true);
  });

  it("warns about conflicting ports rather than picking silently", () => {
    const { req } = analyzeFiles({
      Dockerfile: "FROM node:20\nEXPOSE 8080\nCMD [\"node\",\"a.js\"]\n",
      "package.json": JSON.stringify({ dependencies: { express: "4" } }),
      "a.js": "require('express')().listen(3000);\n",
    });
    expect(service(req, "web").port?.value).toBe(8080);
    expect(req.risks.some((r) => r.includes("Port mismatch"))).toBe(true);
  });

  it("finds nothing in test, docs and vendored directories", () => {
    const { req } = analyzeFiles({
      "package.json": JSON.stringify({ dependencies: { left: "1" } }),
      "tests/db.test.ts": 'import pg from "pg"; const u = "postgres://x/y"; process.env.SHOULD_NOT_APPEAR;\n',
      "node_modules/pg/package.json": "{}",
      "docs/examples/app/package.json": JSON.stringify({ dependencies: { express: "4" } }),
    });
    expect(req.datastores).toEqual([]);
    expect(req.envVars).toEqual([]);
    expect(req.services).toEqual([]);
  });
});

describe("analysis contract", () => {
  it("does not mutate the snapshot", () => {
    const { snapshot } = analyzeFiles(nextjsPrismaRedis);
    const before = JSON.stringify(snapshot);
    analyzeRepository(snapshot);
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it("carries the snapshot source and truncation flag through", () => {
    const { req } = analyzeFiles(goGinDockerfile, { kind: "github", ref: "main", commit: "a".repeat(40), repo: "https://github.com/acme/api" });
    expect(req.source).toEqual({ kind: "github", ref: "main", commit: "a".repeat(40), repo: "https://github.com/acme/api" });
    expect(req.truncated).toBe(false);
    expect(req.schemaVersion).toBe(1);
  });
});
