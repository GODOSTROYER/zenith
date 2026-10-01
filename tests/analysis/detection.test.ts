import { describe, expect, it } from "vitest";
import { analyzeFiles, datastoreKinds, service } from "./helpers";

const pkg = (dependencies: Record<string, string>, extra: Record<string, unknown> = {}) => JSON.stringify({ name: "app", dependencies, ...extra });

describe("framework detection", () => {
  interface Row {
    name: string;
    files: Record<string, string>;
    framework: string;
    kind: "web" | "static";
    port?: { value: number; confidence: "high" | "medium" | "low" };
  }
  const rows: Row[] = [
    { name: "Remix", files: { "package.json": pkg({ "@remix-run/node": "2", "@remix-run/react": "2" }) }, framework: "Remix", kind: "web", port: { value: 3000, confidence: "low" } },
    { name: "Express", files: { "package.json": pkg({ express: "4" }), "app.js": "const app = require('express')();\napp.listen(5001);\n" }, framework: "Express", kind: "web", port: { value: 5001, confidence: "medium" } },
    { name: "Fastify", files: { "package.json": pkg({ fastify: "4" }), "s.js": "fastify.listen({ port: 3999 })\n" }, framework: "Fastify", kind: "web", port: { value: 3999, confidence: "medium" } },
    { name: "NestJS", files: { "package.json": pkg({ "@nestjs/core": "10" }), "src/main.ts": "await app.listen(process.env.PORT ?? 3300);\n" }, framework: "NestJS", kind: "web", port: { value: 3300, confidence: "medium" } },
    { name: "Hono", files: { "package.json": pkg({ hono: "4", "@hono/node-server": "1" }), "src/index.ts": "serve({ fetch: app.fetch, port: 8787 });\n" }, framework: "Hono", kind: "web", port: { value: 8787, confidence: "medium" } },
    { name: "Django", files: { "requirements.txt": "django==5\n", "manage.py": "" }, framework: "Django", kind: "web", port: { value: 8000, confidence: "low" } },
    { name: "Flask", files: { "requirements.txt": "flask\n", "app.py": "app = Flask(__name__)\napp.run(port=5050)\n" }, framework: "Flask", kind: "web", port: { value: 5050, confidence: "medium" } },
    { name: "FastAPI", files: { "requirements.txt": "fastapi\nuvicorn\n", "main.py": "import uvicorn\napp = FastAPI()\nuvicorn.run(app, port=8123)\n" }, framework: "FastAPI", kind: "web", port: { value: 8123, confidence: "medium" } },
    { name: "Rails", files: { Gemfile: 'gem "rails"\n' }, framework: "Rails", kind: "web", port: { value: 3000, confidence: "low" } },
    { name: "Sinatra", files: { Gemfile: 'gem "sinatra"\n', "config.ru": "run App\n", "app.rb": "set :port, 4599\n" }, framework: "Sinatra", kind: "web", port: { value: 4599, confidence: "medium" } },
    {
      name: "Spring Boot (Gradle)",
      files: { "build.gradle": "plugins {\n  id 'org.springframework.boot' version '3.2.0'\n}\nsourceCompatibility = '17'\ndependencies {\n  implementation 'org.springframework.boot:spring-boot-starter-web'\n}\n" },
      framework: "Spring Boot",
      kind: "web",
      port: { value: 8080, confidence: "low" },
    },
    { name: "Go net/http", files: { "go.mod": "module x\ngo 1.22\n", "main.go": 'package main\nimport "net/http"\nfunc main() { http.ListenAndServe(":9191", nil) }\n' }, framework: "Go net/http", kind: "web", port: { value: 9191, confidence: "medium" } },
    { name: "Gin", files: { "go.mod": "module x\nrequire github.com/gin-gonic/gin v1.9.0\n", "main.go": 'package main\nfunc main() { r.Run(":8181") }\n' }, framework: "Gin", kind: "web", port: { value: 8181, confidence: "medium" } },
    { name: "Echo", files: { "go.mod": "module x\nrequire github.com/labstack/echo/v4 v4.11.0\n", "main.go": 'package main\nfunc main() { e.Start(":1424") }\n' }, framework: "Echo", kind: "web", port: { value: 1424, confidence: "medium" } },
    { name: "Fiber", files: { "go.mod": "module x\nrequire (\n\tgithub.com/gofiber/fiber/v2 v2.52.0\n)\n", "main.go": 'package main\nfunc main() { app.Listen(":3111") }\n' }, framework: "Fiber", kind: "web", port: { value: 3111, confidence: "medium" } },
    { name: "Laravel", files: { "composer.json": JSON.stringify({ require: { "laravel/framework": "^11" } }) }, framework: "Laravel", kind: "web", port: { value: 8000, confidence: "low" } },
    { name: "Vite SPA", files: { "package.json": pkg({ react: "18" }, { devDependencies: { vite: "5" } }), "index.html": "<html></html>" }, framework: "Vite", kind: "static" },
    { name: "Create React App", files: { "package.json": pkg({ react: "18", "react-scripts": "5" }), "public/index.html": "<html></html>" }, framework: "Create React App", kind: "static" },
  ];

  for (const row of rows) {
    it(`${row.name}: framework, service kind${row.port ? " and port" : ""}`, () => {
      const { req } = analyzeFiles(row.files);
      expect(req.frameworks.map((f) => f.value.name)).toContain(row.framework);
      const svc = req.services.find((s) => s.value.kind === row.kind);
      expect(svc, `no ${row.kind} service; have ${JSON.stringify(req.services.map((s) => s.value.name))}`).toBeDefined();
      if (row.port) expect(svc!.value.port).toMatchObject(row.port);
      else expect(svc!.value.port).toBeUndefined();
    });
  }

  it("CRA builds into build/, Vite into dist/", () => {
    expect(analyzeFiles(rows.find((r) => r.name === "Create React App")!.files).req.builds[0].value.outputDir).toBe("build");
    expect(analyzeFiles(rows.find((r) => r.name === "Vite SPA")!.files).req.builds[0].value.outputDir).toBe("dist");
    const custom = analyzeFiles({ ...rows.find((r) => r.name === "Vite SPA")!.files, "vite.config.ts": 'export default { build: { outDir: "out-site" } };\n' }).req;
    expect(custom.builds[0].value.outputDir).toBe("out-site");
  });

  it("a Vite package with no HTML entry is a library or tool, not a site", () => {
    const { req } = analyzeFiles({ "package.json": pkg({ react: "18" }, { devDependencies: { vite: "5" }, main: "dist/index.js" }), "vite.config.ts": "export default { build: { lib: {} } };\n" });
    expect(req.services).toEqual([]);
  });

  it("a Vite app inside a monorepo package counts (its index.html is kept)", () => {
    const { req } = analyzeFiles({
      "package.json": JSON.stringify({ private: true, workspaces: ["apps/*"] }),
      "apps/site/package.json": pkg({ react: "18" }, { name: "@x/site", devDependencies: { vite: "5" } }),
      "apps/site/index.html": "<html></html>",
    });
    expect(req.services.map((s) => `${s.value.name}:${s.value.kind}`)).toEqual(["site:static"]);
  });
});

describe("datastore detection by ecosystem", () => {
  interface Row {
    name: string;
    files: Record<string, string>;
    kinds: string[];
    unsupported?: string[];
  }
  const rows: Row[] = [
    { name: "npm pg", files: { "package.json": pkg({ pg: "8" }) }, kinds: ["postgres"] },
    { name: "npm postgres.js", files: { "package.json": pkg({ postgres: "3" }) }, kinds: ["postgres"] },
    { name: "npm prisma provider postgresql", files: { "package.json": pkg({ "@prisma/client": "5" }), "prisma/schema.prisma": 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n' }, kinds: ["postgres"] },
    { name: "npm prisma provider mysql", files: { "prisma/schema.prisma": 'datasource db {\n  provider = "mysql"\n  url = env("DATABASE_URL")\n}\n' }, kinds: ["mysql"], unsupported: ["mysql"] },
    { name: "npm prisma provider mongodb", files: { "prisma/schema.prisma": 'datasource db {\n  provider = "mongodb"\n}\n' }, kinds: ["mongodb"], unsupported: ["mongodb"] },
    { name: "npm mysql2", files: { "package.json": pkg({ mysql2: "3" }) }, kinds: ["mysql"], unsupported: ["mysql"] },
    { name: "npm mongoose", files: { "package.json": pkg({ mongoose: "8" }) }, kinds: ["mongodb"], unsupported: ["mongodb"] },
    { name: "npm redis", files: { "package.json": pkg({ redis: "4" }) }, kinds: ["redis"] },
    { name: "npm ioredis", files: { "package.json": pkg({ ioredis: "5" }) }, kinds: ["redis"] },
    { name: "npm bullmq implies redis", files: { "package.json": pkg({ bullmq: "5" }) }, kinds: ["redis"] },
    { name: "npm s3 client", files: { "package.json": pkg({ "@aws-sdk/client-s3": "3" }) }, kinds: ["object_store"] },
    { name: "npm multer-s3", files: { "package.json": pkg({ "multer-s3": "3" }) }, kinds: ["object_store"] },
    { name: "npm sqs client", files: { "package.json": pkg({ "@aws-sdk/client-sqs": "3" }) }, kinds: ["queue"] },
    { name: "npm amqplib is rabbitmq", files: { "package.json": pkg({ amqplib: "0.10" }) }, kinds: ["rabbitmq"], unsupported: ["rabbitmq"] },
    { name: "npm nodemailer", files: { "package.json": pkg({ nodemailer: "6" }) }, kinds: ["email"] },
    { name: "npm SES client", files: { "package.json": pkg({ "@aws-sdk/client-ses": "3" }) }, kinds: ["email"] },
    { name: "npm sendgrid", files: { "package.json": pkg({ "@sendgrid/mail": "8" }) }, kinds: ["email"] },
    { name: "python psycopg (extras)", files: { "requirements.txt": "psycopg[binary]==3.1\n" }, kinds: ["postgres"] },
    { name: "python asyncpg", files: { "requirements.txt": "asyncpg\n" }, kinds: ["postgres"] },
    { name: "python sqlalchemy postgres url", files: { "requirements.txt": "sqlalchemy\n", "db.py": 'engine = create_engine("postgresql+psycopg2://app@db.internal/app")\n' }, kinds: ["postgres"] },
    { name: "python django engine mysql", files: { "requirements.txt": "django\n", "app/settings.py": 'DATABASES = {"default": {"ENGINE": "django.db.backends.mysql"}}\n' }, kinds: ["mysql"], unsupported: ["mysql"] },
    { name: "python celery redis broker (extras)", files: { "requirements.txt": "celery[redis]\n" }, kinds: ["redis"] },
    { name: "python celery amqp broker url", files: { "requirements.txt": "celery\n", "c.py": 'BROKER = "amqp://guest@rabbit//"\n' }, kinds: ["rabbitmq"], unsupported: ["rabbitmq"] },
    { name: "python boto3 s3", files: { "requirements.txt": "boto3\n", "s.py": 's3 = boto3.client("s3")\n' }, kinds: ["object_store"] },
    { name: "python boto3 sqs", files: { "requirements.txt": "boto3\n", "q.py": 'q = boto3.client("sqs")\n' }, kinds: ["queue"] },
    { name: "python boto3 alone says nothing", files: { "requirements.txt": "boto3\n" }, kinds: [] },
    { name: "python pymongo", files: { "requirements.txt": "pymongo\n" }, kinds: ["mongodb"], unsupported: ["mongodb"] },
    { name: "python pyproject dependencies array", files: { "pyproject.toml": '[project]\nname = "x"\ndependencies = ["redis>=5", "psycopg2-binary"]\n' }, kinds: ["postgres", "redis"] },
    { name: "python poetry dependencies table", files: { "pyproject.toml": '[tool.poetry.dependencies]\npython = "^3.11"\nasyncpg = "^0.29"\n' }, kinds: ["postgres"] },
    { name: "python Pipfile", files: { Pipfile: '[packages]\npsycopg2 = "*"\n[requires]\npython_version = "3.11"\n' }, kinds: ["postgres"] },
    { name: "ruby pg + redis", files: { Gemfile: 'gem "pg"\ngem "redis"\n' }, kinds: ["postgres", "redis"] },
    { name: "ruby database.yml mysql2", files: { Gemfile: 'gem "rails"\n', "config/database.yml": "production:\n  adapter: mysql2\n" }, kinds: ["mysql"], unsupported: ["mysql"] },
    { name: "ruby active storage S3", files: { Gemfile: 'gem "rails"\n', "config/storage.yml": "amazon:\n  service: S3\n" }, kinds: ["object_store"] },
    { name: "go pq", files: { "go.mod": "module x\nrequire github.com/lib/pq v1.10.0\n" }, kinds: ["postgres"] },
    { name: "go redis (v9 path)", files: { "go.mod": "module x\nrequire github.com/redis/go-redis/v9 v9.0.0\n" }, kinds: ["redis"] },
    { name: "go aws s3 v2", files: { "go.mod": "module x\nrequire github.com/aws/aws-sdk-go-v2/service/s3 v1.0.0\n" }, kinds: ["object_store"] },
    { name: "go sql.Open mysql", files: { "go.mod": "module x\n", "db.go": 'package db\nfunc f() { sql.Open("mysql", dsn) }\n' }, kinds: ["mysql"], unsupported: ["mysql"] },
    { name: "spring datasource url", files: { "src/main/resources/application.properties": "spring.datasource.url=jdbc:postgresql://db/app\n" }, kinds: ["postgres"] },
    { name: "spring yaml jdbc mysql", files: { "src/main/resources/application.yml": "spring:\n  datasource:\n    url: jdbc:mysql://db/app\n" }, kinds: ["mysql"], unsupported: ["mysql"] },
    { name: "spring maven redis + mail", files: { "pom.xml": "<artifactId>spring-boot-starter-data-redis</artifactId><artifactId>spring-boot-starter-mail</artifactId>" }, kinds: ["email", "redis"] },
    { name: "sqlite is called out, not adopted", files: { "package.json": pkg({ "better-sqlite3": "9" }) }, kinds: ["sqlite"], unsupported: ["sqlite"] },
    { name: "sqlite in devDependencies is ignored", files: { "package.json": JSON.stringify({ devDependencies: { "better-sqlite3": "9" } }) }, kinds: [] },
    { name: "kafka", files: { "package.json": pkg({ kafkajs: "2" }) }, kinds: ["kafka"], unsupported: ["kafka"] },
    { name: "connection-string scheme in code", files: { "package.json": pkg({}), "a.js": 'const u = "mongodb+srv://cluster.example.net/db";\nconst r = "rediss://cache.example.net:6380";\n' }, kinds: ["mongodb", "redis"], unsupported: ["mongodb"] },
    { name: "hits in comments and tests do not count in ignored dirs", files: { "package.json": pkg({}), "tests/a.test.js": 'const u = "postgres://x/y";\n' }, kinds: [] },
  ];

  for (const row of rows) {
    it(row.name, () => {
      const { req } = analyzeFiles(row.files);
      expect(datastoreKinds(req)).toEqual(row.kinds);
      const unsupported = [...new Set(req.datastores.filter((d) => !d.value.supportedInV1).map((d) => d.value.kind))].sort();
      expect(unsupported).toEqual(row.unsupported ?? []);
      for (const d of req.datastores) expect(d.evidence.length).toBeGreaterThan(0);
    });
  }

  it("a queue client is both sides unless the code says otherwise", () => {
    const { req } = analyzeFiles({ "package.json": pkg({ "@aws-sdk/client-sqs": "3" }) });
    expect(req.datastores[0].value).toMatchObject({ kind: "queue", engine: "sqs", role: "both" });
  });
});

describe("migration detection", () => {
  const cases: { name: string; files: Record<string, string>; command: string; tool: string }[] = [
    { name: "prisma migrate deploy", files: { "package.json": pkg({ "@prisma/client": "5" }, { devDependencies: { prisma: "5" } }), "prisma/schema.prisma": 'datasource db { provider = "postgresql" }', "prisma/migrations/1/migration.sql": "x" }, command: "npx prisma migrate deploy", tool: "prisma" },
    { name: "knex", files: { "package.json": pkg({ knex: "3" }), "knexfile.js": "module.exports = {}" }, command: "npx knex migrate:latest", tool: "knex" },
    { name: "typeorm (script)", files: { "package.json": pkg({ typeorm: "0.3" }, { scripts: { "migration:run": "typeorm-ts-node-commonjs migration:run -d src/ds.ts" } }) }, command: "npm run migration:run", tool: "typeorm" },
    { name: "sequelize-cli", files: { "package.json": pkg({ sequelize: "6" }, { devDependencies: { "sequelize-cli": "6" } }) }, command: "npx sequelize-cli db:migrate", tool: "sequelize" },
    { name: "alembic", files: { "requirements.txt": "alembic\n", "alembic.ini": "[alembic]" }, command: "alembic upgrade head", tool: "alembic" },
    { name: "django", files: { "requirements.txt": "django\n", "manage.py": "" }, command: "python manage.py migrate --noinput", tool: "django" },
    { name: "rails", files: { Gemfile: 'gem "rails"\n', "db/migrate/1_x.rb": "class X; end" }, command: "bundle exec rails db:migrate", tool: "rails" },
    { name: "liquibase", files: { "pom.xml": "<artifactId>liquibase-core</artifactId>" }, command: "liquibase update", tool: "liquibase" },
    { name: "goose", files: { "go.mod": "module x\nrequire github.com/pressly/goose/v3 v3.0.0\n" }, command: "goose up", tool: "goose" },
    { name: "golang-migrate", files: { "go.mod": "module x\nrequire github.com/golang-migrate/migrate/v4 v4.0.0\n" }, command: 'migrate -path migrations -database "$DATABASE_URL" up', tool: "golang-migrate" },
    { name: "laravel", files: { "composer.json": JSON.stringify({ require: { "laravel/framework": "^11" } }) }, command: "php artisan migrate --force", tool: "laravel" },
  ];
  for (const c of cases) {
    it(`${c.name}: a candidate command, never executed`, () => {
      const { req } = analyzeFiles(c.files);
      const m = req.migrations.find((x) => x.value.tool === c.tool);
      expect(m?.value.command).toBe(c.command);
      expect(m!.evidence.length).toBeGreaterThan(0);
    });
  }
  it("finds nothing to migrate when there is no migration tool", () => {
    expect(analyzeFiles({ "package.json": pkg({ express: "4" }) }).req.migrations).toEqual([]);
  });
});

describe("environment variable extraction by language", () => {
  const names = (files: Record<string, string>): Record<string, string | undefined> => {
    const { req } = analyzeFiles(files);
    return Object.fromEntries(req.envVars.map((e) => [e.value.name, e.value.defaultValue]));
  };

  it("node: process.env forms, destructuring, import.meta.env and defaults", () => {
    expect(
      names({
        "package.json": pkg({}),
        "a.ts": [
          "const a = process.env.ALPHA;",
          'const b = process.env["BRAVO"] || "two";',
          "const { CHARLIE, DELTA = 'four' } = process.env;",
          "const e = import.meta.env.VITE_ECHO;",
          "const f = process.env.FOXTROT ?? 12;",
          'const g = parseInt(process.env.GOLF, 10) || 7;',
        ].join("\n"),
      })
    ).toEqual({ ALPHA: undefined, BRAVO: "two", CHARLIE: undefined, DELTA: "four", VITE_ECHO: undefined, FOXTROT: "12", GOLF: "7" });
  });

  it("python: os.environ, os.getenv, environ.get and django-environ/decouple helpers", () => {
    expect(
      names({
        "requirements.txt": "django\n",
        "s.py": ['A = os.environ["A_ONE"]', 'B = os.environ.get("B_TWO", "two")', 'C = os.getenv("C_THREE", 3)', 'D = env("D_FOUR")', 'E = config("E_FIVE", default="five")', 'F = env.bool("F_SIX", default=True)'].join("\n"),
      })
    ).toEqual({ A_ONE: undefined, B_TWO: "two", C_THREE: "3", D_FOUR: undefined, E_FIVE: "five", F_SIX: "true" });
  });

  it("ruby, go, java, php and rust", () => {
    expect(names({ Gemfile: "", "a.rb": 'x = ENV["RB_ONE"]\ny = ENV.fetch("RB_TWO", "two")\nz = ENV.fetch("RB_THREE") { "three" }\n' })).toEqual({ RB_ONE: undefined, RB_TWO: "two", RB_THREE: "three" });
    expect(names({ "go.mod": "module x\n", "a.go": 'package main\nvar a = os.Getenv("GO_ONE")\nvar b = getEnv("GO_TWO", "two")\n' })).toEqual({ GO_ONE: undefined, GO_TWO: "two" });
    expect(names({ "pom.xml": "", "A.java": 'String a = System.getenv("JV_ONE");\n@Value("${JV_TWO:two}") String b;\n' })).toEqual({ JV_ONE: undefined, JV_TWO: "two" });
    expect(names({ "composer.json": "{}", "a.php": "$a = env('PHP_ONE');\n$b = getenv('PHP_TWO');\n$c = env('PHP_THREE', 'three');\n" })).toEqual({ PHP_ONE: undefined, PHP_TWO: undefined, PHP_THREE: "three" });
    expect(names({ "Cargo.toml": "", "a.rs": 'let a = std::env::var("RS_ONE");\n' })).toEqual({ RS_ONE: undefined });
  });

  it("conflicting defaults for one name cancel out; secrets never keep one", () => {
    expect(names({ "package.json": pkg({}), "a.js": 'const a = process.env.MODE || "x";\n', "b.js": 'const b = process.env.MODE || "y";\nconst t = process.env.API_TOKEN || "abc";\n' })).toEqual({ MODE: undefined, API_TOKEN: undefined });
  });

  it("names from example env files, Dockerfile ENV, compose and Prisma, but never values", () => {
    const { req } = analyzeFiles({
      "package.json": pkg({}),
      ".env.sample": "SAMPLE_ONE=hello\nSAMPLE_SECRET=\n",
      Dockerfile: "FROM node:22\nENV DF_ONE=one DF_TOKEN=abc\n",
    });
    const byName = Object.fromEntries(req.envVars.map((e) => [e.value.name, e.value]));
    expect(byName.SAMPLE_ONE).toMatchObject({ classification: "config" });
    expect(byName.SAMPLE_ONE.defaultValue).toBeUndefined(); // example files are names only
    expect(byName.SAMPLE_SECRET.classification).toBe("secret");
    expect(byName.DF_ONE).toMatchObject({ classification: "config", defaultValue: "one" });
    expect(byName.DF_TOKEN).toMatchObject({ classification: "secret" });
    expect(byName.DF_TOKEN.defaultValue).toBeUndefined();
    expect(JSON.stringify(req)).not.toContain("hello");
  });
});

describe("worker, cron and health signals", () => {
  it("bullmq Worker in its own file becomes a worker with an npm script command", () => {
    const { req } = analyzeFiles({ "package.json": pkg({ bullmq: "5" }, { scripts: { worker: "node dist/worker.js" } }), "src/worker.ts": "import { Worker } from 'bullmq';\nnew Worker('q', async () => {});\n" });
    expect(service(req, "worker").startCommand).toMatchObject({ value: "npm run worker", confidence: "high" });
  });

  it("a bullmq Worker in the web server's own file is not a separate service", () => {
    const { req } = analyzeFiles({ "package.json": pkg({ express: "4", bullmq: "5" }), "server.js": "const { Worker } = require('bullmq');\nnew Worker('q', async () => {});\nrequire('express')().listen(3000);\n" });
    expect(req.services.map((s) => s.value.kind)).toEqual(["web"]);
    expect(req.unknowns.some((u) => u.includes("runs in the same file as the web server"))).toBe(true);
  });

  it("celery worker recipe uses the app module found in code", () => {
    const { req } = analyzeFiles({ "requirements.txt": "celery\n", "proj/celery.py": "from celery import Celery\napp = Celery('proj')\n" });
    expect(service(req, "worker").startCommand).toMatchObject({ value: "celery -A proj.celery worker --loglevel=info", confidence: "medium" });
  });

  it("finds each of the required health routes and prefers a declared health check", () => {
    for (const route of ["/health", "/healthz", "/api/health", "/up", "/_health"]) {
      const { req } = analyzeFiles({ "package.json": pkg({ express: "4" }), "s.js": `app.get('${route}', h);\napp.listen(3000);\n` });
      expect(service(req, "web").healthPath?.value, route).toBe(route);
    }
    const { req } = analyzeFiles({ "package.json": pkg({ express: "4" }), "s.js": "app.get('/health', h);\napp.listen(3000);\n", Dockerfile: "FROM node:22\nEXPOSE 3000\nHEALTHCHECK CMD curl -f http://localhost:3000/ready\nCMD [\"node\",\"s.js\"]\n" });
    expect(service(req, "web").healthPath).toMatchObject({ value: "/ready", confidence: "high" });
    expect(req.healthEndpoints.map((h) => h.value.path).sort()).toEqual(["/health", "/ready"]);
  });

  it("finds Next.js file-based health routes", () => {
    const { req } = analyzeFiles({ "package.json": pkg({ next: "14" }), "pages/api/health.ts": "export default function h() {}\n" });
    expect(service(req, "web").healthPath?.value).toBe("/api/health");
  });
});

describe("layout and launcher details", () => {
  it("pnpm workspaces: an app directory called docs is a real app; a top-level docs/ is not", () => {
    const { req } = analyzeFiles({
      "package.json": JSON.stringify({ name: "root", private: true, packageManager: "pnpm@9.0.0" }),
      "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
      "apps/web/package.json": JSON.stringify({ name: "web", scripts: { start: "next start" }, dependencies: { next: "14" } }),
      "apps/docs/package.json": JSON.stringify({ name: "docs", scripts: { start: "node server.js" }, dependencies: { express: "4" } }),
      "apps/docs/server.js": "require('express')().listen(4000);\n",
      "docs/package.json": JSON.stringify({ name: "readme-site", dependencies: { express: "4" } }),
      "examples/demo/package.json": JSON.stringify({ name: "demo", dependencies: { express: "4" } }),
    });
    expect(req.monorepo?.value.tool).toBe("pnpm workspaces");
    expect(req.services.map((s) => `${s.value.name}:${s.value.root}`)).toEqual(["docs:apps/docs", "web:apps/web"]);
    expect(service(req, "docs").port).toMatchObject({ value: 4000, confidence: "medium" });
  });

  it("a gunicorn or uvicorn launcher with no port means 8000, not the framework's own default", () => {
    const flask = analyzeFiles({ "requirements.txt": "flask\ngunicorn\n", Procfile: "web: gunicorn app:app\n", "app.py": "app = Flask(__name__)\n" }).req;
    expect(service(flask, "web").port).toMatchObject({ value: 8000, confidence: "low" });
    const explicit = analyzeFiles({ "requirements.txt": "flask\ngunicorn\n", Procfile: "web: gunicorn app:app --bind 0.0.0.0:9001\n", "app.py": "app = Flask(__name__)\n" }).req;
    expect(service(explicit, "web").port).toMatchObject({ value: 9001, confidence: "high" });
  });

  it("reads ENV names from a Dockerfile instruction that continues over several lines", () => {
    const { req } = analyzeFiles({ Dockerfile: 'FROM ruby:3.3-slim\nENV RAILS_ENV="production" \\n    BUNDLE_WITHOUT="development" \\n    SECRET_KEY_BASE=dummy\nEXPOSE 3000\n' });
    const byName = Object.fromEntries(req.envVars.map((e) => [e.value.name, e.value]));
    expect(byName.RAILS_ENV).toMatchObject({ classification: "config", defaultValue: "production" });
    expect(byName.BUNDLE_WITHOUT).toMatchObject({ defaultValue: "development" });
    expect(byName.SECRET_KEY_BASE).toMatchObject({ classification: "secret" });
    expect(byName.SECRET_KEY_BASE.defaultValue).toBeUndefined();
  });
});
