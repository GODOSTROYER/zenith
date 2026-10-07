/**
 * RFC 7009 revocation for every bearer the v3 endpoint accepts.
 *
 * Real: the OAuth verification (jose, runtime-generated ES256 key), the grant
 * journal (SQLite in memory) and its `bindGrant` check, and the plugin store
 * (PGlite; set ZENITH_TEST_PLATFORM_PG_URL for PostgreSQL). Modeled: the
 * credential authority (its Postgres/file implementations have their own
 * suites) and the rate limiter.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import * as repos from "@/lib/controlplane/db/repos";
import { bindGrant, verifyOAuth, type OAuthConfig } from "@/lib/agent-access/control/oauth";
import { Journal, type Principal } from "@/lib/agent-access/control/journal";
import { revokeToken, type RevokeDeps } from "@/lib/agent-access/oauth/revoke";
import { authenticatePluginToken, hashPluginToken, issuePluginToken, registerPlugin, revokePluginTokenByPossession, reviewPlugin, type PluginDeps } from "@/lib/plugins/service";
import { PluginError } from "@/lib/plugins/errors";
import { baseManifest, FakeParents, makePublisher, signManifest } from "../plugins/support";

const ORIGIN = "https://zenith.example.test";
const ISSUER = "https://issuer.example.test";
const V3 = `${ORIGIN}/api/agent/v3/mcp`;
const V2 = `${ORIGIN}/api/agent/v2/mcp`;
const config: OAuthConfig = { issuer: ISSUER, jwksUrl: `${ISSUER}/jwks`, resource: V2, clientClaim: "client_id" };
const ZA = "za_" + "A".repeat(43);

let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let keys: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  pair = await generateKeyPair("ES256");
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "fixture", alg: "ES256" }] });
});
async function jwt(over: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: "user_1", iss: ISSUER, aud: V3, iat: now, exp: now + 300, client_id: "claude-code", scope: "zenith:read zenith:plan", ...over })
    .setProtectedHeader({ alg: "ES256", kid: "fixture", typ: "at+jwt" }).sign(pair.privateKey);
}
const grant: Principal & { clientId: string; revoked?: boolean } = { subject: "user_1", integrationId: "integration_1", workspaceId: "ws1", projectIds: ["p"], scopes: ["read", "plan"],
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(), clientId: "claude-code", oauthIssuer: ISSUER };

const form = (fields: Record<string, string>, headers: Record<string, string> = {}, url = `${ORIGIN}/api/agent/oauth/revoke`) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields) });

function fakeDeps(over: Partial<RevokeDeps> = {}, journal?: Journal) {
  const revoked: string[] = [];
  const deps: RevokeDeps = {
    checkOrigin: (request) => { if (new URL(request.url).origin !== ORIGIN) throw Object.assign(new Error("origin"), { status: 403 }); return ORIGIN; },
    limit: async () => undefined,
    authority: async () => ({
      verify: async (header) => { if (header !== `Bearer ${ZA}`) throw new Error("bad"); return { id: "cred-1", subject: "user_1", workspaceId: "ws1" }; },
      revokeCredential: async (subject, workspaceId, id) => { revoked.push(`${subject}/${workspaceId}/${id}`); return true; },
    }),
    oauth: {
      config: () => config,
      verify: (token, c) => verifyOAuth(token, c, keys),
      revokeGrant: async (identity, workspaceId) => {
        const stored = journal?.getGrant(identity.subject, identity.clientId, workspaceId);
        if (!journal || !stored || stored.oauthIssuer !== identity.issuer) return false;
        journal.setGrant({ ...stored, revoked: true });
        return true;
      },
    },
    resources: () => [V3, V2],
    ...over,
  };
  return { deps, revoked };
}
const error = async (response: Response) => (await response.json()) as { error: string; error_description: string };

describe("request validation (RFC 7009 / RFC 6749 errors)", () => {
  it("only POST", async () => {
    const response = await revokeToken(new Request(`${ORIGIN}/api/agent/oauth/revoke`), fakeDeps().deps);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
  it("refuses another host before reading anything", async () => {
    const limit = vi.fn(async () => undefined);
    const response = await revokeToken(form({ token: ZA }, {}, "https://evil.example.test/api/agent/oauth/revoke"), fakeDeps({ limit }).deps);
    expect(response.status).toBe(403);
    expect(limit).not.toHaveBeenCalled();
  });
  it("rate limits with Retry-After, and fails closed when the limiter is down", async () => {
    const limited = await revokeToken(form({ token: ZA }), fakeDeps({ limit: async () => { throw Object.assign(new Error("limit"), { status: 429 }); } }).deps);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    const down = await revokeToken(form({ token: ZA }), fakeDeps({ limit: async () => { throw new Error("db"); } }).deps);
    expect(down.status).toBe(503);
  });
  it.each([
    ["no token", new Request(`${ORIGIN}/api/agent/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "" }), "invalid_request"],
    ["JSON body", new Request(`${ORIGIN}/api/agent/oauth/revoke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: ZA }) }), "invalid_request"],
    ["oversized token", form({ token: "x".repeat(16_385) }), "invalid_request"],
    ["bad hint", form({ token: ZA, token_type_hint: "id_token" }), "unsupported_token_type"],
  ])("%s -> 400 %s", async (_name, request, code) => {
    const response = await revokeToken(request, fakeDeps().deps);
    expect(response.status).toBe(400);
    expect((await error(response)).error).toBe(code);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("linked credentials (za_)", () => {
  it("revokes the credential the token belongs to and answers 200 with an empty body", async () => {
    const { deps, revoked } = fakeDeps();
    const response = await revokeToken(form({ token: ZA, token_type_hint: "access_token" }), deps);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(revoked).toEqual(["user_1/ws1/cred-1"]);
  });
  it("answers 200 and revokes nothing for an invalid, expired or already revoked token (no oracle)", async () => {
    const { deps, revoked } = fakeDeps();
    const response = await revokeToken(form({ token: "za_" + "B".repeat(43) }), deps);
    expect(response.status).toBe(200);
    expect(revoked).toEqual([]);
  });
  it("answers 503 when the authority cannot be reached, so the client repeats", async () => {
    const { deps } = fakeDeps({ authority: async () => { throw new Error("down"); } });
    expect((await revokeToken(form({ token: ZA }), deps)).status).toBe(503);
  });
});

describe("OAuth access tokens: the Zenith grant is revoked and takes effect on the next request", () => {
  async function withJournal<T>(run: (journal: Journal) => Promise<T>): Promise<T> {
    const journal = new Journal(":memory:");
    try { journal.setGrant(grant); return await run(journal); } finally { journal.close(); }
  }
  const bind = async (journal: Journal, token: string) => bindGrant(await verifyOAuth(token, { ...config, resource: V3 }, keys), journal.getGrant("user_1", "claude-code", "ws1"));

  it("revokes by v3 audience, and the very next bind is refused", async () => {
    await withJournal(async (journal) => {
      const token = await jwt();
      expect((await bind(journal, token)).subject).toBe("user_1");
      const { deps } = fakeDeps({}, journal);
      expect((await revokeToken(form({ token, workspace: "ws1" }), deps)).status).toBe(200);
      await expect(bind(journal, token)).rejects.toMatchObject({ code: "integration_grant_required" });
      // a token the same client gets AFTER revocation is refused too: the grant is what is revoked
      await expect(bind(journal, await jwt())).rejects.toMatchObject({ code: "integration_grant_required" });
      expect((await revokeToken(form({ token, workspace: "ws1" }), deps)).status).toBe(200);
    });
  });
  it("also accepts a v2-audience token, and takes the workspace from x-zenith-workspace", async () => {
    await withJournal(async (journal) => {
      const { deps } = fakeDeps({}, journal);
      expect((await revokeToken(form({ token: await jwt({ aud: V2 }) }, { "x-zenith-workspace": "ws1" }), deps)).status).toBe(200);
      expect(journal.getGrant("user_1", "claude-code", "ws1")?.revoked).toBe(true);
    });
  });
  it("ignores a token minted for another resource, issuer or key (200, nothing revoked)", async () => {
    await withJournal(async (journal) => {
      const { deps } = fakeDeps({}, journal);
      const other = await generateKeyPair("ES256");
      const forged = await new SignJWT({ sub: "user_1", iss: ISSUER, aud: V3, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, client_id: "claude-code", scope: "zenith:read" })
        .setProtectedHeader({ alg: "ES256", kid: "fixture" }).sign(other.privateKey);
      for (const token of [await jwt({ aud: "https://other.example.test/api" }), await jwt({ iss: "https://evil.example.test" }), forged, "not-a-jwt"]) {
        expect((await revokeToken(form({ token, workspace: "ws1" }), deps)).status).toBe(200);
      }
      expect(journal.getGrant("user_1", "claude-code", "ws1")?.revoked).toBeUndefined();
    });
  });
  it("refuses a client_id that is not the token's client, and a missing or malformed workspace", async () => {
    await withJournal(async (journal) => {
      const { deps } = fakeDeps({}, journal);
      const token = await jwt();
      const mismatch = await revokeToken(form({ token, workspace: "ws1", client_id: "someone-else" }), deps);
      expect(mismatch.status).toBe(400);
      expect((await error(mismatch)).error).toBe("invalid_client");
      const missing = await revokeToken(form({ token }), deps);
      expect(missing.status).toBe(400);
      expect((await error(missing)).error).toBe("invalid_request");
      expect((await revokeToken(form({ token, workspace: "../ws1" }), deps)).status).toBe(400);
      expect(journal.getGrant("user_1", "claude-code", "ws1")?.revoked).toBeUndefined();
    });
  });
  it("cannot revoke a grant of another workspace, another client or another issuer", async () => {
    await withJournal(async (journal) => {
      journal.setGrant({ ...grant, workspaceId: "ws2", integrationId: "integration_2" });
      journal.setGrant({ ...grant, clientId: "other-client", integrationId: "integration_3" });
      const { deps } = fakeDeps({}, journal);
      await revokeToken(form({ token: await jwt(), workspace: "ws3" }), deps);
      expect(journal.getGrant("user_1", "claude-code", "ws2")?.revoked).toBeUndefined();
      expect(journal.getGrant("user_1", "other-client", "ws1")?.revoked).toBeUndefined();
      await revokeToken(form({ token: await jwt(), workspace: "ws1" }), deps);
      expect(journal.getGrant("user_1", "claude-code", "ws1")?.revoked).toBe(true);
      expect(journal.getGrant("user_1", "claude-code", "ws2")?.revoked).toBeUndefined();
      expect(journal.getGrant("user_1", "other-client", "ws1")?.revoked).toBeUndefined();
    });
  });
  it("is unavailable, not silent, when OAuth is not configured", async () => {
    const { deps } = fakeDeps({ oauth: { config: () => undefined, verify: async () => { throw new Error("x"); }, revokeGrant: async () => false } });
    expect((await revokeToken(form({ token: await jwt(), workspace: "ws1" }), deps)).status).toBe(503);
  });
});

describe("plugin tokens (zp_) over the real plugin store", () => {
  const opened: PlatformDbHandle[] = [];
  afterAll(async () => { for (const db of opened) await db.close(); });
  const PG_URL = process.env.ZENITH_TEST_PLATFORM_PG_URL?.trim() || undefined;
  afterEach(() => vi.unstubAllEnvs());

  it("revokes by possession, ends authentication at once, keeps audience binding, and is not an oracle", async () => {
    const db = await (PG_URL ? openPlatformDb({ kind: "postgres", url: PG_URL, migrate: true, max: 3 }) : openPlatformDb({ kind: "pglite" }));
    opened.push(db);
    const suffix = Math.random().toString(36).slice(2, 10);
    const ws = `ws-${suffix}`;
    const parents = new FakeParents();
    parents.add({ id: `cred-${suffix}`, workspaceId: ws, projectIds: ["proj-a"] });
    const publisher = makePublisher();
    const deps: PluginDeps = { sql: db, parents: parents.lookup, publishers: () => publisher.publishers };
    const manifest = signManifest(baseManifest({ id: `acme/revoke-${suffix}` }), publisher.privateKey);
    const registration = await registerPlugin(deps, { workspaceId: ws, manifest, requestedBy: "alice" });
    await reviewPlugin(deps, { workspaceId: ws, registrationId: registration.id, manifestDigest: registration.manifestDigest, decision: "approve", tools: ["zenith_get_topology"], scopes: ["read"], reviewedBy: "alice" });
    const issued = await issuePluginToken(deps, { workspaceId: ws, registrationId: registration.id, credentialId: `cred-${suffix}`, subject: "bob", audience: V3, days: 7 });

    expect((await authenticatePluginToken(deps, issued.token, V3)).subject).toBe("bob");
    await expect(authenticatePluginToken(deps, issued.token, V2)).rejects.toBeInstanceOf(PluginError);

    expect(await revokePluginTokenByPossession(deps, "zp_" + "z".repeat(43))).toBe(false);
    expect(await revokePluginTokenByPossession(deps, "not-a-token")).toBe(false);
    expect(await revokePluginTokenByPossession(deps, issued.token)).toBe(true);
    await expect(authenticatePluginToken(deps, issued.token, V3)).rejects.toMatchObject({ code: "plugin_grant_invalid" });
    expect(await revokePluginTokenByPossession(deps, issued.token)).toBe(false);
    const events = await repos.plugins.listEvents(db, ws, registration.id);
    expect(events.some((e) => e.kind === "grant_revoked" && e.actor.startsWith("token:"))).toBe(true);
    expect(hashPluginToken(issued.token)).toMatch(/^[0-9a-f]{64}$/);

    // through the RFC 7009 endpoint
    const second = await issuePluginToken(deps, { workspaceId: ws, registrationId: registration.id, credentialId: `cred-${suffix}`, subject: "bob", audience: V3, days: 7 });
    const { deps: revokeDeps } = fakeDeps({ plugins: { revokeByToken: (token) => revokePluginTokenByPossession(deps, token) } });
    expect((await revokeToken(form({ token: second.token }), revokeDeps)).status).toBe(200);
    await expect(authenticatePluginToken(deps, second.token, V3)).rejects.toMatchObject({ code: "plugin_grant_invalid" });
  });
});
