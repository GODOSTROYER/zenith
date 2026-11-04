/**
 * Threat class: token forgery and audience confusion (PROD-OPS-08).
 *
 * Attacker model: someone who holds one valid token of one kind (or none) and tries to be accepted as a different
 * principal, for a different resource, kind or workspace, or after the token should have died. Token kinds in play:
 * `za_` agent credentials, OAuth access tokens (v2 and v3 resources), `zp_` plugin tokens and the scheduler's cron
 * bearer. Capability-grant forgery lives in approvals-forgery.test.ts; runner request signing has its own deep suite
 * in tests/runners (signing, request-auth, protocol-window).
 *
 * The verifiers are driven through their exported functions with attacker-built input generated from mutation
 * operators, so a verifier that tolerates any one mutation fails by name.
 */
import { createHash, randomBytes } from "node:crypto";
import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticate, type Credential } from "@/lib/agent-access/security";
import { verifyOAuth, type OAuthConfig } from "@/lib/agent-access/control/oauth";
import { authorizeCron } from "@/lib/server/cron";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import { authenticatePluginToken, hashPluginToken, issuePluginToken, registerPlugin, reviewPlugin, type PluginDeps } from "@/lib/plugins/service";
import { baseManifest, FakeParents, makePublisher, signManifest } from "../plugins/support";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const rejects = async (promise: Promise<unknown>): Promise<boolean> => {
  try { await promise; return false; } catch { return true; }
};
const throws = (fn: () => unknown): boolean => {
  try { fn(); return false; } catch { return true; }
};

/** Mutation operators over a token string: each one is an attacker's guess at a near-miss. */
function mutations(token: string): Record<string, string> {
  const flip = (at: number) => token.slice(0, at) + (token[at] === "A" ? "B" : "A") + token.slice(at + 1);
  return {
    "first body char flipped": flip(token.indexOf("_") + 1),
    "last char flipped": flip(token.length - 1),
    truncated: token.slice(0, -1),
    extended: `${token}A`,
    "trailing space": `${token} `,
    "leading space": ` ${token}`,
    "trailing newline": `${token}\n`,
    uppercased: token.toUpperCase(),
    lowercased: token.toLowerCase(),
    "prefix removed": token.slice(token.indexOf("_") + 1),
    "other kind prefix": token.replace(/^[a-z]+_/, token.startsWith("za_") ? "zp_" : "za_"),
    doubled: token + token,
    "sha256 of the token presented as the token": sha256(token),
    "NUL appended": `${token}\0`,
    empty: "",
  };
}

/* ----------------------------- agent credentials za_ ---------------------------- */

describe("agent credential bearer (za_)", () => {
  const token = `za_${randomBytes(32).toString("base64url")}`;
  const now = Date.now();
  const record = (over: Partial<Credential> = {}): Credential => ({
    id: "cred_1", tokenHash: sha256(token), subject: "alice", workspaceId: "ws_a", projectIds: ["prj_a"], scopes: ["read"],
    issuedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(), ...over,
  });
  const other = (): Credential => record({ id: "cred_2", tokenHash: sha256(`za_${randomBytes(32).toString("base64url")}`), workspaceId: "ws_b", subject: "mallory" });

  it("accepts the genuine token and returns only its own record (the control)", () => {
    expect(authenticate(`Bearer ${token}`, [other(), record()], now).id).toBe("cred_1");
  });

  it("refuses every near-miss spelling of the token and every header-shape trick", () => {
    const accepted: string[] = [];
    for (const [label, forged] of Object.entries(mutations(token))) {
      for (const header of [`Bearer ${forged}`, forged]) if (!throws(() => authenticate(header, [record(), other()], now))) accepted.push(`${label} / ${header.slice(0, 12)}`);
    }
    for (const header of [null, "", "Bearer", "Bearer ", `bearer ${token}`, `BEARER ${token}`, `Basic ${token}`, `Bearer  ${token}`, `Bearer ${token}, Bearer ${token}`, `Bearer\t${token}`, `Token ${token}`]) {
      if (!throws(() => authenticate(header, [record()], now))) accepted.push(`header ${JSON.stringify(header)}`);
    }
    expect(accepted).toEqual([]);
  });

  it("refuses expired, not-yet-valid and revoked credentials, and an empty authority", () => {
    expect(throws(() => authenticate(`Bearer ${token}`, [record({ expiresAt: new Date(now - 1).toISOString() })], now))).toBe(true);
    expect(throws(() => authenticate(`Bearer ${token}`, [record({ expiresAt: new Date(now).toISOString() })], now))).toBe(true);
    expect(throws(() => authenticate(`Bearer ${token}`, [record({ issuedAt: new Date(now + 1000).toISOString() })], now))).toBe(true);
    expect(throws(() => authenticate(`Bearer ${token}`, [record({ revokedAt: new Date(now - 1000).toISOString() })], now))).toBe(true);
    expect(throws(() => authenticate(`Bearer ${token}`, [], now))).toBe(true);
  });

  it("never lets one tenant's record answer for another's token", () => {
    const foreign = `za_${randomBytes(32).toString("base64url")}`;
    expect(throws(() => authenticate(`Bearer ${foreign}`, [record(), other()], now))).toBe(true);
  });
});

/* -------------------------------- OAuth access tokens -------------------------------- */

describe("OAuth access token (verifyOAuth)", () => {
  const V2 = "https://zenith.test/api/agent/v2/mcp";
  const V3 = "https://zenith.test/api/agent/v3/mcp";
  const ISSUER = "https://issuer.example/";
  const config = (resource: string): OAuthConfig => ({ issuer: ISSUER, jwksUrl: "https://issuer.example/jwks", resource, clientClaim: "client_id" });

  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let attacker: Awaited<ReturnType<typeof generateKeyPair>>;
  let getKey: JWTVerifyGetKey;
  const ready = (async () => {
    keys = await generateKeyPair("ES256");
    attacker = await generateKeyPair("ES256");
    getKey = (async () => keys.publicKey) as unknown as JWTVerifyGetKey;
  })();

  async function mint(over: { aud?: string | string[]; iss?: string; sub?: string; client?: string; scope?: string; iat?: number; exp?: number; key?: "real" | "attacker"; alg?: string } = {}) {
    await ready;
    const iat = over.iat ?? Math.floor(Date.now() / 1000) - 5;
    const jwt = new SignJWT({ client_id: over.client ?? "client_1", scope: over.scope ?? "zenith:read zenith:write" })
      .setProtectedHeader({ alg: over.alg ?? "ES256", kid: "k1" })
      .setIssuer(over.iss ?? ISSUER)
      .setSubject(over.sub ?? "alice")
      .setAudience(over.aud ?? V3)
      .setIssuedAt(iat)
      .setExpirationTime(over.exp ?? iat + 600);
    return jwt.sign(over.key === "attacker" ? attacker.privateKey : keys.privateKey);
  }

  it("accepts a well-formed token for exactly its resource (the control)", async () => {
    const verified = await verifyOAuth(await mint(), config(V3), getKey);
    expect(verified).toMatchObject({ subject: "alice", clientId: "client_1", issuer: ISSUER });
  });

  it("audience confusion: a token for one resource is refused at every other resource", async () => {
    const forV2 = await mint({ aud: V2 });
    const forV3 = await mint({ aud: V3 });
    expect(await rejects(verifyOAuth(forV2, config(V3), getKey))).toBe(true);
    expect(await rejects(verifyOAuth(forV3, config(V2), getKey))).toBe(true);
    for (const aud of ["https://zenith.test/api/agent/v3/mcp/", "https://zenith.test", "https://evil.test/api/agent/v3/mcp", "HTTPS://ZENITH.TEST/api/agent/v3/mcp", "", V3.replace("https", "http")]) {
      expect(await rejects(verifyOAuth(await mint({ aud: aud || "x" }), config(V3), getKey)), aud).toBe(true);
    }
    expect(await rejects(verifyOAuth(await mint({ aud: ["https://other.test", V2] }), config(V3), getKey))).toBe(true);
  });

  it("refuses wrong issuer, foreign signature, none/HS256 algorithms and tampered payloads", async () => {
    expect(await rejects(verifyOAuth(await mint({ iss: "https://evil.example/" }), config(V3), getKey))).toBe(true);
    expect(await rejects(verifyOAuth(await mint({ iss: ISSUER.slice(0, -1) }), config(V3), getKey))).toBe(true);
    expect(await rejects(verifyOAuth(await mint({ key: "attacker" }), config(V3), getKey))).toBe(true);
    const good = await mint();
    const [h, p, s] = good.split(".") as [string, string, string];
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>;
    const tamper = (change: Record<string, unknown>) => `${h}.${Buffer.from(JSON.stringify({ ...payload, ...change })).toString("base64url")}.${s}`;
    for (const change of [{ sub: "admin" }, { scope: "zenith:read zenith:publish zenith:write" }, { aud: V2 }, { exp: Number(payload.exp) + 86_400 }, { client_id: "other" }]) {
      expect(await rejects(verifyOAuth(tamper(change), config(V3), getKey)), JSON.stringify(change)).toBe(true);
    }
    const noneHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    expect(await rejects(verifyOAuth(`${noneHeader}.${p}.`, config(V3), getKey))).toBe(true);
    expect(await rejects(verifyOAuth(`${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")}.${p}.${s}`, config(V3), getKey))).toBe(true);
    expect(await rejects(verifyOAuth("a".repeat(20_000), config(V3), getKey))).toBe(true);
    for (const garbage of ["", "x", "a.b", "a.b.c", "..", `${good}.x`]) expect(await rejects(verifyOAuth(garbage, config(V3), getKey)), garbage).toBe(true);
  });

  it("refuses unbounded or backdated lifetimes and the reserved subjects", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await rejects(verifyOAuth(await mint({ iat: now - 10, exp: now - 5 }), config(V3), getKey))).toBe(true);
    expect(await rejects(verifyOAuth(await mint({ iat: now - 10, exp: now + 7200 }), config(V3), getKey))).toBe(true);
    expect(await rejects(verifyOAuth(await mint({ iat: now + 3600, exp: now + 3700 }), config(V3), getKey))).toBe(true);
    for (const sub of ["local", "navigator", "system", "a b", "x".repeat(101), "../x"]) expect(await rejects(verifyOAuth(await mint({ sub }), config(V3), getKey)), sub).toBe(true);
    expect(await rejects(verifyOAuth(await mint({ scope: "zenith:write" }), config(V3), getKey))).toBe(true);
    expect(await rejects(verifyOAuth(await mint({ scope: "" }), config(V3), getKey))).toBe(true);
    expect(await rejects(verifyOAuth(await mint({ client: "" }), config(V3), getKey))).toBe(true);
  });
});

/* ------------------------------------ cron bearer ------------------------------------ */

describe("scheduler bearer (authorizeCron)", () => {
  const SECRET = `cs_${randomBytes(24).toString("base64url")}`;
  const saved = process.env.CRON_SECRET;
  beforeEach(() => { process.env.CRON_SECRET = SECRET; });
  afterEach(() => { if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved; });
  const req = (authorization?: string) => new NextRequest("https://zenith.test/api/internal/tick/jobs", { method: "POST", headers: authorization === undefined ? {} : { authorization } });

  it("accepts the secret and nothing near it", () => {
    expect(throws(() => authorizeCron(req(`Bearer ${SECRET}`)))).toBe(false);
    const accepted: string[] = [];
    for (const [label, forged] of Object.entries(mutations(SECRET))) if (!throws(() => authorizeCron(req(`Bearer ${forged}`)))) {
      // surrounding whitespace is trimmed by design; every other mutation must fail
      if (!/space|newline/.test(label)) accepted.push(label);
    }
    for (const header of [undefined, "", "Bearer", "Bearer ", SECRET, `Basic ${SECRET}`, "Bearer undefined", "Bearer null", `Bearer ${SECRET.slice(0, 8)}`]) {
      if (!throws(() => authorizeCron(req(header)))) accepted.push(`header ${JSON.stringify(header)}`);
    }
    expect(accepted).toEqual([]);
  });

  it("runs nothing when the secret is unset or blank, whatever the bearer says", () => {
    for (const blank of [undefined, "", "   "]) {
      if (blank === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = blank;
      for (const header of [undefined, "Bearer ", "Bearer x", "Bearer undefined", `Bearer ${blank ?? ""}`]) {
        expect(throws(() => authorizeCron(req(header))), `${JSON.stringify(blank)} / ${JSON.stringify(header)}`).toBe(true);
      }
    }
  });
});

/* ------------------------------------ plugin tokens zp_ ------------------------------------ */

describe("plugin token (zp_)", () => {
  const AUD = "http://127.0.0.1:3400/api/agent/v3/mcp";
  const opened: PlatformDbHandle[] = [];
  afterAll(async () => { for (const db of opened) await db.close(); });

  async function setup() {
    const db = await openPlatformDb({ kind: "pglite" });
    opened.push(db);
    const publisher = makePublisher();
    const parents = new FakeParents();
    const suffix = Math.random().toString(36).slice(2, 10);
    const ws = `ws-${suffix}`;
    const credentialId = `cred-${suffix}`;
    parents.add({ id: credentialId, workspaceId: ws, projectIds: ["proj-a"], environmentIds: ["env-a"] });
    const deps: PluginDeps = { sql: db, parents: parents.lookup, publishers: () => publisher.publishers };
    const manifest = signManifest(baseManifest({ id: `acme/adv-${suffix}` }), publisher.privateKey);
    const registration = await registerPlugin(deps, { workspaceId: ws, manifest, requestedBy: "alice" });
    const approved = await reviewPlugin(deps, { workspaceId: ws, registrationId: registration.id, manifestDigest: registration.manifestDigest, decision: "approve", tools: ["zenith_get_topology"], scopes: ["read"], reviewedBy: "alice" });
    const issued = await issuePluginToken(deps, { workspaceId: ws, registrationId: approved.id, credentialId, subject: "bob", audience: AUD, days: 7 });
    return { deps, parents, credentialId, issued, ws, registrationId: approved.id };
  }

  it("accepts the genuine token for its audience only (the control)", async () => {
    const h = await setup();
    await expect(authenticatePluginToken(h.deps, h.issued.token, AUD)).resolves.toBeTruthy();
  });

  it("refuses every near-miss spelling and every other kind of token", async () => {
    const h = await setup();
    const accepted: string[] = [];
    for (const [label, forged] of Object.entries(mutations(h.issued.token))) {
      if (!(await rejects(authenticatePluginToken(h.deps, forged, AUD)))) accepted.push(label);
    }
    for (const foreign of [`za_${randomBytes(32).toString("base64url")}`, `zp_${randomBytes(32).toString("base64url")}`, hashPluginToken(h.issued.token)]) {
      if (!(await rejects(authenticatePluginToken(h.deps, foreign, AUD)))) accepted.push(foreign.slice(0, 6));
    }
    expect(accepted).toEqual([]);
  });

  it("audience confusion: the token is useless at the v2 resource, a sibling origin or a variant spelling", async () => {
    const h = await setup();
    const accepted: string[] = [];
    for (const aud of ["http://127.0.0.1:3400/api/agent/v2/mcp", `${AUD}/`, AUD.toUpperCase(), "", "https://zenith.test/api/agent/v3/mcp", `${AUD}?x=1`, "worker", "runner:r1"]) {
      if (!(await rejects(authenticatePluginToken(h.deps, h.issued.token, aud)))) accepted.push(aud);
    }
    expect(accepted).toEqual([]);
  });

  it("dies with its parent credential (revocation is immediate, nothing is cached)", async () => {
    const h = await setup();
    h.parents.rows.get(h.credentialId)!.revokedAt = new Date().toISOString();
    expect(await rejects(authenticatePluginToken(h.deps, h.issued.token, AUD))).toBe(true);
  });

  it("cannot be issued to someone else's credential, for a pending plugin, or for a subject that does not own the parent", async () => {
    const h = await setup();
    const publisher = makePublisher();
    const deps: PluginDeps = { ...h.deps, publishers: () => publisher.publishers };
    const other = signManifest(baseManifest({ id: "acme/pending-one" }), publisher.privateKey);
    const pending = await registerPlugin(deps, { workspaceId: h.ws, manifest: other, requestedBy: "alice" });
    expect(await rejects(issuePluginToken(deps, { workspaceId: h.ws, registrationId: pending.id, credentialId: h.credentialId, subject: "bob", audience: AUD, days: 7 }))).toBe(true);
    const mine = h.registrationId;
    {
      expect(await rejects(issuePluginToken(h.deps, { workspaceId: h.ws, registrationId: mine, credentialId: h.credentialId, subject: "mallory", audience: AUD, days: 7 }))).toBe(true);
      expect(await rejects(issuePluginToken(h.deps, { workspaceId: `${h.ws}-foreign`, registrationId: mine, credentialId: h.credentialId, subject: "bob", audience: AUD, days: 7 }))).toBe(true);
    }
  });
});
