/**
 * The signature table is the ONLY way log text influences an investigation.
 * These tests pin what it recognizes (messages real runtimes print), what it
 * ignores, how it attributes connection errors to a port, and that it stays
 * fast on adversarial input.
 */
import { describe, expect, it } from "vitest";
import { SIGNATURES, scanText, type SignatureId, type TextItem } from "@/lib/incidents";

const at = (message: string, minute = 0): TextItem => ({ timestamp: new Date(Date.UTC(2026, 8, 30, 11, minute)).toISOString(), message, source: "logs" });
const ids = (...messages: string[]) => scanText(messages.map((m, i) => at(m, i))).hits.map((h) => h.signature);
const only = (id: SignatureId, ...messages: string[]) => expect(ids(...messages)).toContain(id);

describe("signature recognition", () => {
  it.each([
    ["node-postgres", "Error: connect ETIMEDOUT 10.0.3.15:5432"],
    ["psycopg2", 'psycopg2.OperationalError: connection to server at "db.internal" (10.0.3.15), port 5432 failed: timeout expired'],
    ["go pq", "dial tcp 10.0.3.15:5432: i/o timeout"],
    ["jdbc", "java.net.SocketTimeoutException: connect timed out"],
    ["libpq", "could not connect to server: Connection timed out"],
  ])("connect_timeout: %s", (_n, m) => only("connect_timeout", m));

  it.each([
    "Error: connect ECONNREFUSED 10.0.3.15:5432",
    "psycopg2.OperationalError: connection refused",
    "Connection to db:5432 refused. Check that the hostname and port are correct",
  ])("connect_refused: %s", (m) => only("connect_refused", m));

  it.each(["getaddrinfo ENOTFOUND db.internal", "dial tcp: lookup db.internal: no such host", "Temporary failure in name resolution", "java.net.UnknownHostException: db"])("dns_failure: %s", (m) => only("dns_failure", m));

  it.each(['FATAL: password authentication failed for user "app"', "Access denied for user 'app'@'10.0.1.4'", "WRONGPASS invalid username-password pair", "no pg_hba.conf entry for host"])("auth_failure: %s", (m) => only("auth_failure", m));

  it.each(["FATAL: the database system is starting up", "FATAL: remaining connection slots are reserved for non-replication superuser connections", "server closed the connection unexpectedly", "FATAL: terminating connection due to administrator command"])("db_unavailable: %s", (m) => only("db_unavailable", m));

  it.each(["FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory", "java.lang.OutOfMemoryError: Java heap space", "Killed process 4312 (node) total-vm:2048000kB", "container exited with exit code 137", "OOMKilled"])("oom: %s", (m) => only("oom", m));

  it.each([
    "KeyError: 'DATABASE_URL'",
    "Error: Environment variable DATABASE_URL is not set",
    "TypeError: process.env.STRIPE_KEY is undefined",
    "missing required environment variable SESSION_SECRET",
    "SESSION_SECRET is not set",
  ])("missing_env: %s", (m) => only("missing_env", m));

  it.each(["ResourceInitializationError: unable to pull secrets or registry auth: secretsmanager failed", "Secrets Manager can't find the specified secret.", "failed to fetch secret db-url", "ParameterNotFound: /prod/db/url"])("secret_error: %s", (m) => only("secret_error", m));

  it.each([
    "AccessDeniedException: User: arn:aws:sts::1:assumed-role/web/i-1 is not authorized to perform: dynamodb:GetItem on resource: t",
    "An error occurred (AccessDenied) when calling the GetObject operation",
    "UnauthorizedOperation: You are not authorized to perform this operation",
    "PermissionDenied: caller does not have permission",
  ])("iam_denied: %s", (m) => only("iam_denied", m));

  it.each(["CannotPullContainerError: pull image manifest has been retried 5 time(s)", "Back-off pulling image: ImagePullBackOff", "Failed to pull image: manifest unknown", "pull access denied for shop/web, repository does not exist"])("image_pull: %s", (m) => only("image_pull", m));

  it.each(["Error: certificate has expired", "unable to verify the first certificate", "x509: certificate signed by unknown authority", "CERT_HAS_EXPIRED"])("tls_error: %s", (m) => only("tls_error", m));

  it("does not match ordinary lines", () => {
    expect(
      ids(
        "GET /health 200 2ms",
        "listening on port 3000",
        "connected to database",
        "user login ok",
        "request timeout not configured, using default", // a config note is not a connection timeout
        "set NODE_ENV=production",
        'audit: "password" field is required on the form',
        "retrying in 5s"
      )
    ).toEqual([]);
  });

  it("an upper-case 'X is not set' is an env var, but a lower-case sentence is not", () => {
    expect(ids("STRIPE_KEY is not set")).toContain("missing_env");
    expect(ids("the flag is not set")).not.toContain("missing_env");
  });

  it("every signature has at least one alternative and a positive minCount", () => {
    for (const s of SIGNATURES) {
      expect(s.res.length).toBeGreaterThan(0);
      expect(s.minCount).toBeGreaterThanOrEqual(1);
      for (const re of s.res) expect(re.flags).not.toContain("g"); // global regexes carry state between lines
    }
    expect(new Set(SIGNATURES.map((s) => s.id)).size).toBe(SIGNATURES.length);
  });
});

describe("attribution and ordering", () => {
  it("groups connection errors per target port and records hosts", () => {
    const { hits } = scanText([at("connect ETIMEDOUT 10.0.3.15:5432", 1), at("connect ETIMEDOUT 10.0.3.15:5432", 2), at("connect ETIMEDOUT 10.0.4.9:6379", 3)]);
    expect(hits.map((h) => [h.signature, h.port, h.count])).toEqual([
      ["connect_timeout", 5432, 2],
      ["connect_timeout", 6379, 1],
    ]);
    expect(hits[0].hosts).toEqual(["10.0.3.15"]);
    expect(hits[0].firstAt).toBe(new Date(Date.UTC(2026, 8, 30, 11, 1)).toISOString());
    expect(hits[0].lastAt).toBe(new Date(Date.UTC(2026, 8, 30, 11, 2)).toISOString());
  });

  it("reads the port from 'port N' phrasing, and ignores clock times", () => {
    const { hits } = scanText([at('12:30:45 connection to server at "db.internal" (10.0.3.15), port 5432 failed: timeout expired')]);
    expect(hits[0].port).toBe(5432);
    expect(hits[0].ports).not.toContain(30);
  });

  it("is independent of the order backends return lines in", () => {
    const items = [at("connect ETIMEDOUT 10.0.3.15:5432", 3), at("KeyError: 'X_Y'", 1), at("connect ETIMEDOUT 10.0.3.15:5432", 2), at("java.lang.OutOfMemoryError", 4)];
    const a = scanText(items);
    const b = scanText([...items].reverse());
    expect(b).toEqual(a);
  });

  it("keeps at most three distinct samples, newest last, each at most 300 characters", () => {
    const items = Array.from({ length: 10 }, (_, i) => at(`connect ETIMEDOUT 10.0.3.${i}:5432 ${"x".repeat(1000)}`, i));
    const hit = scanText(items).hits[0];
    expect(hit.count).toBe(10);
    expect(hit.samples).toHaveLength(3);
    for (const s of hit.samples) expect(s.length).toBeLessThanOrEqual(300);
    expect(hit.samples[2]).toContain("10.0.3.9");
  });

  it("centres the excerpt on the signature when the line is long", () => {
    const { hits } = scanText([at(`${"pad ".repeat(200)}connect ETIMEDOUT 10.0.3.15:5432 ${"tail ".repeat(200)}`)]);
    expect(hits[0].samples[0]).toContain("ETIMEDOUT");
    expect(hits[0].samples[0].length).toBeLessThanOrEqual(300);
  });

  it("extracts env var names and denied actions as plain identifiers only", () => {
    const { hits } = scanText([at("KeyError: 'DATABASE_URL'"), at("is not authorized to perform: secretsmanager:GetSecretValue on resource")]);
    expect(hits.find((h) => h.signature === "missing_env")?.envVars).toEqual(["DATABASE_URL"]);
    expect(hits.find((h) => h.signature === "iam_denied")?.actions).toEqual(["secretsmanager:GetSecretValue"]);
  });

  it("scans at most the most recent 1000 items and says it truncated", () => {
    const items = Array.from({ length: 1500 }, (_, i) => at("connect ETIMEDOUT 10.0.3.15:5432", i % 60));
    const r = scanText(items);
    expect(r.scanned).toBe(1000);
    expect(r.truncated).toBe(true);
  });

  it("ignores empty and non-string messages without throwing", () => {
    const r = scanText([at(""), { timestamp: "x", message: undefined as never, source: "logs" }]);
    expect(r.hits).toEqual([]);
  });
});

describe("performance on adversarial input", () => {
  const cases: Record<string, string> = {
    "1 MB of one character": "a".repeat(1_000_000),
    "1 MB of timeouts": "ETIMEDOUT ".repeat(100_000),
    "dotted run": "1.".repeat(500_000),
    "port-like run": "a:".repeat(500_000),
    "almost-host": `${"a".repeat(130)}:5432 `.repeat(5000),
    "unterminated quotes": `KeyError: '${"A".repeat(500_000)}`,
    "env-like run": "A_".repeat(500_000) + " not set",
    "many partial keywords": "connection ".repeat(100_000),
    "5xx bait": '" 50'.repeat(200_000),
  };
  for (const [name, input] of Object.entries(cases)) {
    it(`a ${name} line costs about the same as a short one`, () => {
      const t0 = Date.now();
      scanText([at(input)]);
      expect(Date.now() - t0).toBeLessThan(500);
    });
  }

  it("1000 lines of 4 KB each scan well within a couple of seconds", () => {
    const line = `${"lorem ipsum ".repeat(300)}connect ETIMEDOUT 10.0.3.15:5432`;
    const t0 = Date.now();
    scanText(Array.from({ length: 1000 }, (_, i) => at(line, i % 60)));
    expect(Date.now() - t0).toBeLessThan(2500);
  });
});
