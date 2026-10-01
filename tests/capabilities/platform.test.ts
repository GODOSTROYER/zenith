/**
 * `platformBroker()` wiring, the credential-broker signer adapter and the
 * secret guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-cap-platform-");

const { generateSigningJwk, serializePrivateJwk, verifyCapabilityGrant } = await import("@/lib/credentials");
const { CredentialGrantSigner } = await import("@/lib/capabilities/credential-signer");
const { MemoryBrokerStore } = await import("@/lib/capabilities/memory-store");
const { PlatformBrokerStore } = await import("@/lib/capabilities/platform-store");
const { findSecret, scrubSecrets, REDACTED } = await import("@/lib/capabilities/secret-guard");
const { platformBroker, registerPlatformBrokerStore, resetPlatformBrokerForTests, registerPlatformBrokerPorts } = await import("@/lib/capabilities/platform");
const { resetPlatformDbForTests } = await import("@/lib/controlplane/db");
const { openPlatformDb } = await import("@/lib/controlplane/db");
const { makeHarness, requestFor, user } = await import("./support");

const claims = (over: Record<string, unknown> = {}) => ({
  jti: "grt_1",
  iss: "zenith-control",
  aud: "worker",
  sub: "bob",
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 300,
  cap: "service.restart",
  op: "op_1",
  digest: "d".repeat(64),
  ws: "ws_1",
  ...over,
});

beforeEach(() => {
  vi.unstubAllEnvs();
  resetPlatformBrokerForTests();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  resetPlatformBrokerForTests();
  await resetPlatformDbForTests();
});

describe("platformBroker() store selection", () => {
  it("never falls back to memory: an unconfigured store is platform_store_unavailable", async () => {
    vi.stubEnv("ZENITH_PLATFORM_BROKER_MEMORY", "");
    vi.stubEnv("ZENITH_PLATFORM_DB", "postgres");
    vi.stubEnv("ZENITH_PLATFORM_DB_URL", "");
    vi.stubEnv("SUPABASE_DB_URL", "");
    await expect(platformBroker()).rejects.toMatchObject({ code: "platform_store_unavailable", status: 503 });
    // only an exact "1" enables memory
    for (const value of ["true", "0", "yes", " 1"]) {
      vi.stubEnv("ZENITH_PLATFORM_BROKER_MEMORY", value);
      resetPlatformBrokerForTests();
      await expect(platformBroker()).rejects.toMatchObject({ code: "platform_store_unavailable" });
    }
  });

  it("uses memory only when ZENITH_PLATFORM_BROKER_MEMORY=1, and the same store every time", async () => {
    vi.stubEnv("ZENITH_PLATFORM_BROKER_MEMORY", "1");
    const a = await platformBroker();
    const b = await platformBroker();
    expect(a).toBe(b);
    expect(a.deps.store).toBeInstanceOf(MemoryBrokerStore);
  });

  it("uses a registered store, which the orchestrator plugs in", async () => {
    vi.stubEnv("ZENITH_PLATFORM_BROKER_MEMORY", "");
    const db = await openPlatformDb({ kind: "pglite" });
    try {
      registerPlatformBrokerStore(new PlatformBrokerStore(db));
      const broker = await platformBroker();
      expect(broker.deps.store).toBeInstanceOf(PlatformBrokerStore);
      const ports = { signer: { ready: async () => undefined, sign: async () => "x.y.z" } };
      registerPlatformBrokerPorts(ports);
      expect((await platformBroker()).deps.signer).toBe(ports.signer);
    } finally {
      resetPlatformBrokerForTests();
      await db.close();
    }
  });

  it("opens the platform control store through platformDb() when nothing else is configured", async () => {
    vi.stubEnv("ZENITH_PLATFORM_BROKER_MEMORY", "");
    vi.stubEnv("ZENITH_PLATFORM_DB", "pglite");
    const broker = await platformBroker();
    expect(broker.deps.store).toBeInstanceOf(PlatformBrokerStore);
    // it really is the platform schema: a decision round-trips through it
    const stored = await broker.deps.store.putWorkspacePolicy({ workspaceId: "ws_wiring", params: { twoPersonProduction: true }, updatedBy: "u" });
    expect(stored.version).toBe(1);
    expect((await broker.deps.store.getWorkspacePolicy("ws_wiring")).params).toEqual({ twoPersonProduction: true });
  });

  it("does not default a production build to PGlite", async () => {
    vi.stubEnv("ZENITH_PLATFORM_BROKER_MEMORY", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ZENITH_PLATFORM_DB", "");
    vi.stubEnv("ZENITH_PLATFORM_DB_URL", "");
    vi.stubEnv("SUPABASE_DB_URL", "");
    await expect(platformBroker()).rejects.toMatchObject({ code: "platform_store_unavailable" });
  });
});

describe("CredentialGrantSigner", () => {
  it("signs with the credential broker's key and the grant verifies with the credential broker's verifier", async () => {
    const key = await generateSigningJwk("EdDSA");
    const signer = new CredentialGrantSigner({ ZENITH_CONTROL_SIGNING_JWK: serializePrivateJwk(key) });
    await signer.ready();
    const jws = await signer.sign(claims());
    const header = JSON.parse(Buffer.from(jws.split(".")[0], "base64url").toString("utf8"));
    expect(header).toMatchObject({ alg: "EdDSA", typ: "zenith-grant+jwt", kid: key.kid });
    const verified = await verifyCapabilityGrant(jws, { audience: "worker", keys: [key.publicJwk] });
    expect(verified).toMatchObject({ jti: "grt_1", cap: "service.restart", op: "op_1", ws: "ws_1" });
    // the wrong audience and a tampered payload do not verify
    await expect(verifyCapabilityGrant(jws, { audience: "runner:r1", keys: [key.publicJwk] })).rejects.toMatchObject({ code: "grant_wrong_audience" });
    const [h, , sig] = jws.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify(claims({ cap: "infrastructure.destroy" }))).toString("base64url")}.${sig}`;
    await expect(verifyCapabilityGrant(forged, { audience: "worker", keys: [key.publicJwk] })).rejects.toMatchObject({ code: "grant_bad_signature" });
  });

  it("is signer_unavailable without a key, and says so before anything is consumed", async () => {
    for (const env of [{}, { ZENITH_CONTROL_SIGNING_JWK: "not json and not base64 json" }, { ZENITH_CONTROL_SIGNING_JWK: JSON.stringify({ kty: "oct", k: "abc" }) }]) {
      const signer = new CredentialGrantSigner(env);
      await expect(signer.ready()).rejects.toMatchObject({ code: "signer_unavailable" });
      await expect(signer.sign(claims())).rejects.toMatchObject({ code: "signer_unavailable" });
    }
  });

  it("refuses malformed claims and over-long lifetimes, without leaking the key", async () => {
    const key = await generateSigningJwk("EdDSA");
    const secret = serializePrivateJwk(key);
    const signer = new CredentialGrantSigner({ ZENITH_CONTROL_SIGNING_JWK: secret });
    const now = Math.floor(Date.now() / 1000);
    for (const bad of [claims({ exp: now - 10 }), claims({ exp: now + 7200 }), claims({ jti: "" }), claims({ fence: -1 })]) {
      const error = (await signer.sign(bad as never).catch((e: unknown) => e)) as { code: string; message: string };
      expect(error.code).toBe("grant_issue_failed");
      expect(JSON.stringify(error)).not.toContain(key.privateJwk.d);
      expect(error.message).not.toContain(key.privateJwk.d);
    }
  });

  it("is what the broker uses by default", async () => {
    vi.stubEnv("ZENITH_PLATFORM_BROKER_MEMORY", "1");
    expect((await platformBroker()).deps.signer).toBeInstanceOf(CredentialGrantSigner);
  });
});

describe("secret guard", () => {
  const AWS = "AKIAIOSFODNN7EXAMPLE";
  const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";

  it("finds secret shapes anywhere, and names only the path", () => {
    const shapes: unknown[] = [
      { a: AWS },
      { a: [{ b: JWT }] },
      { a: "-----BEGIN RSA PRIVATE KEY-----\nabc" },
      { a: "Bearer abcdefghijklmnopqrstuvwxyz0123456789" },
      { a: "postgres://user:hunter2@db.example.com/x" },
      { a: "ghp_" + "a".repeat(36) },
      { a: "xoxb-1234567890-abcdef" },
      { a: "sk_live_" + "a".repeat(24) },
      { a: "sk-ant-" + "a".repeat(30) },
      { a: "za_" + "a".repeat(43) },
      { password: "hunter2hunter2" },
      { nested: { apiKey: "abcdef" } },
      { Authorization: "whatever" },
    ];
    for (const shape of shapes) {
      const found = findSecret(shape, "input");
      expect(found, JSON.stringify(shape)).toBeDefined();
      expect(JSON.stringify(found)).not.toContain("hunter2");
      expect(JSON.stringify(found)).not.toContain(AWS);
    }
  });

  it("passes references, counters and ordinary text", () => {
    for (const ok of [
      { secretRef: "vault:prj/web/KEY", password: "vault:prj/web/PW" },
      { password: "arn:aws:secretsmanager:us-east-1:1:secret:x" },
      { tokenCount: 5, maxTokens: 100, secretName: "prod-db" },
      { note: "restart the web service", n: 3, flag: true, nothing: null },
      { password: "" },
      { token: "[redacted]" },
    ]) {
      expect(findSecret(ok), JSON.stringify(ok)).toBeUndefined();
    }
  });

  it("sanitises the reported path (it is client-controlled text)", () => {
    const found = findSecret({ "weird key\nwith\tcontrol": { password: "hunter2hunter2" } });
    expect(found?.path).toMatch(/^[A-Za-z0-9_.[\]?-]+$/);
    expect((found?.path ?? "").length).toBeLessThanOrEqual(200);
  });

  it("bounds the work it does on hostile input", () => {
    let deep: unknown = "x";
    for (let i = 0; i < 200; i++) deep = { n: deep };
    expect(findSecret(deep)?.what).toContain("too large or deeply nested");
    expect(findSecret({ list: new Array(30_000).fill("a") })?.what).toContain("too large or deeply nested");
    expect(() => scrubSecrets(deep)).not.toThrow();
  });

  it("scrubs secret shapes and secret-named literals, and what it leaves passes the guard", () => {
    const dirty = { log: `connected with ${AWS} and ${JWT}`, nested: [{ password: "hunter2hunter2", ok: "fine" }], count: 3, url: "postgres://u:pw@host/db" };
    const clean = scrubSecrets(dirty);
    const text = JSON.stringify(clean);
    expect(text).not.toContain(AWS);
    expect(text).not.toContain(JWT);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("u:pw@");
    expect(text).toContain(REDACTED);
    expect(clean.nested[0].ok).toBe("fine");
    expect(clean.count).toBe(3);
    expect(findSecret(clean)).toBeUndefined();
    // the original is untouched
    expect(dirty.log).toContain(AWS);
    expect(scrubSecrets("plain text")).toBe("plain text");
    expect(scrubSecrets(null)).toBeNull();
  });
});

describe("a broker built from the wiring answers end to end", () => {
  it("proposes through a harness-built broker and reads it back", async () => {
    const h = await makeHarness({ kind: "memory" });
    const r = await h.broker.propose(requestFor(h, "service.restart", "sbx"), user("bob"));
    expect(r.decision.outcome).toBe("allow");
  });
});
