import { describe, expect, it } from "vitest";
import { Manifest } from "@/lib/domain/types";
import { analyzeRepository, proposeArchitecture, snapshotFromFiles, type ProposalIntent, type RepoSnapshot } from "@/lib/analysis";
import { analyzeFiles, allStrings } from "./helpers";
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

const GITHUB = { kind: "github" as const, ref: "main", commit: "b".repeat(40), repo: "https://github.com/acme/app" };
const PROD_HA: ProposalIntent = { environmentClass: "production", availability: "high", provider: "aws", regions: ["us-east-1"] };
const STAGING: ProposalIntent = { environmentClass: "staging", availability: "standard" };

const propose = (files: Record<string, string>, intent: ProposalIntent, source: RepoSnapshot["source"] = GITHUB) => {
  const { req } = analyzeFiles(files, source);
  return { req, proposal: proposeArchitecture(req, intent) };
};

describe("every fixture proposes a valid V1 manifest", () => {
  for (const [name, files] of Object.entries(FIXTURES)) {
    for (const intent of [PROD_HA, STAGING, { environmentClass: "sandbox" as const }]) {
      it(`${name} / ${intent.environmentClass}${intent.availability ? `+${intent.availability}` : ""}`, () => {
        const { proposal } = propose(files, intent);
        const reparsed = Manifest.parse(proposal.manifest);
        expect(reparsed).toEqual(proposal.manifest);
        expect(proposal.manifest.version).toBe(1);
        expect(proposal.explanations.length).toBeGreaterThan(0);
        // ids are unique, and bindings only point at nodes that exist
        const ids = new Set<string>();
        for (const n of [...proposal.manifest.services, ...proposal.manifest.resources, ...proposal.manifest.routes]) {
          expect(ids.has(n.id), `duplicate id ${n.id}`).toBe(false);
          ids.add(n.id);
        }
        for (const b of proposal.manifest.bindings) {
          expect(ids.has(b.from), `binding from ${b.from}`).toBe(true);
          expect(ids.has(b.to), `binding to ${b.to}`).toBe(true);
          expect(b.note && b.note.length > 10).toBe(true);
        }
        // every web/static service has a route to a placeholder host that is flagged
        for (const s of proposal.manifest.services.filter((x) => x.kind === "web" || x.kind === "static")) {
          const route = proposal.manifest.routes.find((r) => r.id === `rt-${s.name}`);
          expect(route?.host).toBe(`${s.name}.example.invalid`);
          expect(proposal.unresolved.some((u) => u.includes(`${s.name}.example.invalid`))).toBe(true);
        }
      });
    }
  }
});

describe("Next.js + Prisma + Redis proposal (production, high availability)", () => {
  const { proposal } = propose(nextjsPrismaRedis, PROD_HA);
  const m = proposal.manifest;

  it("builds the service from the repository with its Dockerfile, 2 replicas and the right port", () => {
    expect(m.services).toHaveLength(1);
    expect(m.services[0]).toMatchObject({
      id: "svc-web",
      name: "web",
      kind: "web",
      port: 3000,
      healthPath: "/api/health",
      replicas: 2,
      size: "standard",
      ownership: "managed",
      source: { type: "git", repo: "https://github.com/acme/app", ref: "main", dockerfile: "Dockerfile" },
    });
  });

  it("creates managed resources for the datastores with explained bindings", () => {
    expect(m.resources.map((r) => `${r.name}:${r.kind}:${r.ownership}`).sort()).toEqual(["cache:redis:managed", "db:postgres:managed"]);
    const sql = m.bindings.find((b) => b.capability === "sql")!;
    expect(sql).toMatchObject({ from: "svc-web", to: "res-db" });
    expect(sql.note).toMatch(/prisma\/schema\.prisma:\d+/); // cites the evidence
    expect(m.bindings.find((b) => b.capability === "cache")?.to).toBe("res-cache");
    expect(m.bindings.find((b) => b.capability === "http")).toMatchObject({ from: "rt-web", to: "svc-web" });
  });

  it("turns secret names into vault placeholders and carries only evident plain defaults", () => {
    const env = Object.fromEntries(m.services[0].env.map((e) => [e.key, e]));
    expect(env.DATABASE_URL).toEqual({ key: "DATABASE_URL", secretRef: "vault:DATABASE_URL" });
    expect(env.REDIS_URL).toEqual({ key: "REDIS_URL", secretRef: "vault:REDIS_URL" });
    expect(env.NEXTAUTH_SECRET).toEqual({ key: "NEXTAUTH_SECRET", secretRef: "vault:NEXTAUTH_SECRET" });
    expect(env.APP_NAME).toEqual({ key: "APP_NAME", value: "Shop" });
    expect(env.NEXT_PUBLIC_SITE_URL).toBeUndefined(); // config with no default is not invented
    for (const e of m.services[0].env) expect(e.value !== undefined && e.secretRef !== undefined).toBe(false);
  });

  it("flags what only a human can decide", () => {
    const text = proposal.unresolved.join("\n");
    expect(text).toContain("web.example.invalid");
    expect(text).toMatch(/3 secret value\(s\).*DATABASE_URL, NEXTAUTH_SECRET, REDIS_URL/);
    expect(text).toContain("NEXT_PUBLIC_SITE_URL");
    expect(text).toContain("npx prisma migrate deploy");
    expect(text).toMatch(/Analysis never runs it/);
  });

  it("passes the intent through as placement hints", () => {
    expect(proposal.placementHints).toEqual({ providerPreference: ["aws"], regions: ["us-east-1"], availabilityTarget: 99.95, tolerateSingleFailure: true });
    expect(proposal.confidence).toBe("high");
  });
});

describe("intent shapes the defaults", () => {
  it("high availability gives web and worker two replicas; cron and static stay at one", () => {
    const { proposal } = propose(djangoCeleryPostgres, PROD_HA);
    const by = Object.fromEntries(proposal.manifest.services.map((s) => [s.name, s]));
    expect(by.web.replicas).toBe(2);
    expect(by.worker.replicas).toBe(2);
    expect(by.beat.replicas).toBe(1);
    expect(proposeArchitecture(analyzeFiles(viteSpa).req, PROD_HA).manifest.services[0].replicas).toBe(1);
  });

  it("standard availability and sandbox run one replica; sizes follow the environment class", () => {
    const std = propose(djangoCeleryPostgres, STAGING).proposal.manifest;
    expect(std.services.every((s) => s.replicas === 1)).toBe(true);
    expect(std.services.find((s) => s.name === "web")?.size).toBe("small");
    expect(std.resources.every((r) => r.size === "small")).toBe(true);
    const sandbox = propose(djangoCeleryPostgres, { environmentClass: "sandbox" }).proposal;
    expect(sandbox.manifest.services.every((s) => s.size === "nano" && s.replicas === 1)).toBe(true);
    expect(sandbox.placementHints).toEqual({});
  });

  it("warns that production without high availability is a single point of failure", () => {
    const { proposal } = propose(goGinDockerfile, { environmentClass: "production" });
    expect(proposal.explanations.some((e) => e.includes("single failure is an outage"))).toBe(true);
    expect(proposal.manifest.services[0].replicas).toBe(1);
  });

  it("ignores region strings that are not plain names and says so", () => {
    const { proposal } = propose(goGinDockerfile, { environmentClass: "staging", regions: ["us-east-1", "eu west; rm -rf /", "$(id)"] });
    expect(proposal.placementHints.regions).toEqual(["us-east-1"]);
    expect(proposal.unresolved.some((u) => u.includes("regions were ignored"))).toBe(true);
  });
});

describe("source and build handling", () => {
  it("falls back to the local path and says the repository is unknown for an uploaded archive", () => {
    const { proposal } = propose(goGinDockerfile, PROD_HA, { kind: "tarball" });
    expect(proposal.manifest.services[0].source).toMatchObject({ type: "git", repo: ".", ref: "main", dockerfile: "Dockerfile" });
    expect(proposal.unresolved.some((u) => u.includes("repository location is not known"))).toBe(true);
  });

  it("does not use a ref or repo that could smuggle syntax", () => {
    const { req } = analyzeFiles(goGinDockerfile, { kind: "github", ref: 'main"; rm -rf /', repo: "https://github.com/a/b\nx" });
    const proposal = proposeArchitecture(req, PROD_HA);
    expect(proposal.manifest.services[0].source).toMatchObject({ repo: ".", ref: "main" });
  });

  it("names the inferred recipe once per project directory when there is no Dockerfile", () => {
    const { proposal } = propose(djangoCeleryPostgres, STAGING);
    const notes = proposal.unresolved.filter((u) => u.includes("no Dockerfile"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/web, worker, beat.*have no Dockerfile.*pip install -r requirements\.txt/);
    expect(proposal.confidence).toBe("medium");
  });

  it("lowers confidence for a framework-default port", () => {
    expect(propose(fastapiSqlalchemyAlembic, STAGING).proposal.confidence).toBe("low");
  });

  it("static site: a nano static service, no port, no datastore", () => {
    const { proposal } = propose(viteSpa, STAGING);
    expect(proposal.manifest.services[0]).toMatchObject({ kind: "static", size: "nano" });
    expect(proposal.manifest.services[0].port).toBeUndefined();
    expect(proposal.manifest.resources).toEqual([]);
  });

  it("proposes nothing when nothing deployable was found, and says so", () => {
    const { proposal } = propose({ "notes.txt": "hi" }, PROD_HA);
    expect(proposal.manifest.services).toEqual([]);
    expect(proposal.confidence).toBe("low");
    expect(proposal.unresolved.some((u) => u.includes("No deployable service"))).toBe(true);
  });
});

describe("datastores V1 cannot express are reported, not mapped", () => {
  it("leaves mysql, mongodb and rabbitmq out of the manifest and lists them as unresolved", () => {
    const { proposal } = propose(flaskUnsupportedStores, PROD_HA);
    expect(proposal.manifest.resources).toEqual([]);
    expect(proposal.manifest.bindings.every((b) => b.capability === "http")).toBe(true);
    for (const kind of ["mysql", "mongodb", "rabbitmq"]) expect(proposal.unresolved.some((u) => u.startsWith(`${kind} is required`))).toBe(true);
    expect(proposal.confidence).not.toBe("high");
  });

  it("compose: postgres and redis become resources, mysql/mongo/rabbitmq/elasticsearch are reported", () => {
    const { proposal } = propose(composeStack, PROD_HA);
    expect(proposal.manifest.resources.map((r) => r.kind).sort()).toEqual(["postgres", "redis"]);
    const text = proposal.unresolved.join("\n");
    expect(text).toContain("mysql is required");
    expect(text).toContain("mongodb is required");
    expect(text).toContain("elasticsearch");
  });

  it("does not add a low-confidence datastore, it asks", () => {
    const { proposal } = propose({ "package.json": JSON.stringify({ dependencies: { express: "4", "aws-sdk": "2" } }), "index.js": "require('express')().listen(3000)" }, STAGING);
    expect(proposal.manifest.resources).toEqual([]);
    expect(proposal.unresolved.some((u) => u.startsWith("A object_store may be needed (low confidence"))).toBe(true);
  });
});

describe("bindings and capabilities", () => {
  it("monorepo: only the service that depends on the database package is bound to it", () => {
    const { proposal } = propose(monorepoTwoServices, PROD_HA);
    expect(proposal.manifest.services.map((s) => s.name)).toEqual(["api", "web"]);
    expect(proposal.manifest.bindings.filter((b) => b.capability === "sql").map((b) => b.from)).toEqual(["svc-api"]);
    expect(proposal.manifest.services.find((s) => s.name === "api")?.source).toMatchObject({ dockerfile: "apps/api/Dockerfile" });
    expect(proposal.manifest.services.find((s) => s.name === "web")?.source).not.toHaveProperty("dockerfile");
  });

  it("queues: producers publish, workers consume", () => {
    const { proposal } = propose(
      {
        "package.json": JSON.stringify({ name: "q", dependencies: { express: "4", "@aws-sdk/client-sqs": "3" } }),
        Procfile: "web: node server.js\nworker: node worker.js\n",
        "server.js": "require('express')().listen(process.env.PORT || 3000);\n",
        "worker.js": "console.log('x')\n",
      },
      STAGING
    );
    const caps = proposal.manifest.bindings.filter((b) => b.to === "res-jobs").map((b) => `${b.from}:${b.capability}`).sort();
    expect(caps).toEqual(["svc-web:queue_publish", "svc-worker:queue_consume"]);
  });

  it("a queue client in a service with no worker both publishes and consumes", () => {
    const { proposal } = propose({ "package.json": JSON.stringify({ dependencies: { express: "4", "@aws-sdk/client-sqs": "3" } }), "server.js": "require('express')().listen(3000);\n" }, STAGING);
    expect(proposal.manifest.bindings.filter((b) => b.to === "res-jobs").map((b) => b.capability).sort()).toEqual(["queue_consume", "queue_publish"]);
  });

  it("http-triggered cron calls the web service of the same directory", () => {
    const { proposal } = propose(
      { "package.json": JSON.stringify({ dependencies: { next: "14" } }), "vercel.json": JSON.stringify({ crons: [{ path: "/api/cleanup", schedule: "0 3 * * *" }] }) },
      STAGING
    );
    const cron = proposal.manifest.services.find((s) => s.kind === "cron")!;
    expect(cron.schedule).toBe("0 3 * * *");
    expect(proposal.manifest.bindings.some((b) => b.from === cron.id && b.capability === "http" && b.note?.includes("/api/cleanup"))).toBe(true);
  });

  it("an in-process scheduler is not a service and is called out", () => {
    const { proposal } = propose(
      {
        "package.json": JSON.stringify({ dependencies: { express: "4", "node-cron": "3" } }),
        "server.js": 'const cron = require("node-cron");\ncron.schedule("0 * * * *", () => {});\nrequire("express")().listen(3000);\n',
      },
      PROD_HA
    );
    expect(proposal.manifest.services.map((s) => s.kind)).toEqual(["web"]);
    expect(proposal.unresolved.some((u) => u.includes("scheduler runs inside a service process") && u.includes("2 replicas"))).toBe(true);
  });
});

describe("determinism and secrecy of the proposal", () => {
  it("same requirements, same proposal, byte for byte", () => {
    const { req } = analyzeFiles(djangoCeleryPostgres, GITHUB);
    const a = JSON.stringify(proposeArchitecture(req, PROD_HA));
    const b = JSON.stringify(proposeArchitecture(JSON.parse(JSON.stringify(req)), PROD_HA));
    expect(a).toBe(b);
  });

  it("never turns a secret-named variable into a value, whatever the code says", () => {
    const { proposal } = propose(
      {
        "package.json": JSON.stringify({ dependencies: { express: "4" } }),
        "server.js": [
          "require('express')().listen(3000);",
          "const a = process.env.API_TOKEN || 'tok_live_abcdef1234567890abcdef';",
          "const b = process.env.SESSION_SECRET ?? 'hunter2';",
          "const c = process.env.STRIPE_KEY || 'sk_live_4eC39HqLyjWDarjtT1zdp7dc';",
          "const d = process.env.SERVICE_NAME || 'billing';",
          "const e = process.env.CONNECTION || 'postgres://user:pw@db.example.com/x';",
        ].join("\n"),
      },
      STAGING
    );
    const env = proposal.manifest.services[0].env;
    for (const k of ["API_TOKEN", "SESSION_SECRET", "STRIPE_KEY"]) expect(env.find((e) => e.key === k)).toEqual({ key: k, secretRef: `vault:${k}` });
    expect(env.find((e) => e.key === "SERVICE_NAME")).toEqual({ key: "SERVICE_NAME", value: "billing" });
    expect(env.find((e) => e.key === "CONNECTION")).toBeUndefined(); // looks like a credential: no default carried
    const text = JSON.stringify(proposal);
    for (const canary of ["tok_live_abcdef", "hunter2", "sk_live_4eC39", "user:pw@"]) expect(text).not.toContain(canary);
  });

  it("emits no strings with control characters", () => {
    const { proposal } = propose(nextjsPrismaRedis, PROD_HA);
    for (const s of allStrings(proposal)) expect(/[\u0000-\u0008\u000b-\u001f]/.test(s), s).toBe(false);
  });

  it("does not call the network or the filesystem (pure function of its inputs)", () => {
    const snap = snapshotFromFiles(goGinDockerfile);
    const req = analyzeRepository(snap);
    expect(() => proposeArchitecture(req, PROD_HA)).not.toThrow();
  });
});
