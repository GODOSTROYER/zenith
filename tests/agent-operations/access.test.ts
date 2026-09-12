import { describe, expect, it, vi } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { authenticateOAuth, authenticateOpaque, parseGrants, ownerOf, select, signReview, verifyReview, boundedBytes, type AgentGrant, type ReviewRequest, type OAuthConfig } from "../../src/lib/agent-operations/access";
const now = Date.now(), token = `za_${"a".repeat(43)}`;
const grant: AgentGrant = { id: "one", kind: "opaque", subject: "member-one", workspaceId: "workspace-one", projectIds: ["project-one"], environmentIds: ["environment-one"], scopes: ["read", "plan", "execute"], tokenHash: createHash("sha256").update(token).digest("hex"), issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60000).toISOString() };
const oauthGrant: AgentGrant = { ...grant, kind: "oauth", tokenHash: undefined, issuer: "https://identity.example/realms/zenith", oauthSubject: "external-one", oauthClientId: "codex" };
const config: OAuthConfig = { issuer: oauthGrant.issuer!, introspectionUrl: "https://identity.example/realms/zenith/protocol/openid-connect/token/introspect", clientId: "zenith-resource", clientSecret: "server-secret-not-a-user-token", resource: "https://control.example/api/agent/v2/mcp" };
const claims = { active: true, iss: config.issuer, aud: config.resource, exp: Math.floor((now + 30000) / 1000), sub: "external-one", client_id: "codex", scope: "zenith:read zenith:plan zenith:execute" };
const fetcher = (value: unknown) => vi.fn(async () => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

describe("scoped agent and independent operator identities", () => {
  it("accepts a valid opaque grant and stable authority identity", () => {
    const loaded = parseGrants(JSON.parse(JSON.stringify({ version: 2, grants: [grant] })));
    const result = authenticateOpaque(`Bearer ${token}`, loaded, now);
    expect(result.subject).toBe("member-one"); expect(ownerOf(result, { workspaceId: grant.workspaceId }).authorizationHash).toHaveLength(64);
  });
  it.each([null, "", "Bearer other", `Cookie ${token}`, `Bearer ${token}x`])("never falls back to demo authority for %s", header => {
    expect(() => authenticateOpaque(header, [grant], now)).toThrow();
  });
  it("refuses expiration, revocation and future grants", () => {
    expect(() => authenticateOpaque(`Bearer ${token}`, [], now)).toThrow(/revoked/);
    expect(() => authenticateOpaque(`Bearer ${token}`, [{ ...grant, expiresAt: new Date(now).toISOString() }], now)).toThrow(/expired/);
    expect(() => authenticateOpaque(`Bearer ${token}`, [{ ...grant, issuedAt: new Date(now + 1000).toISOString() }], now)).toThrow(/not active/);
  });
  it.each(["local", "navigator", "system"])("refuses the %s pseudo-subject", subject => {
    expect(() => parseGrants({ version: 2, grants: [{ ...grant, subject }] })).toThrow();
  });
  it("refuses duplicate grants, unknown fields and scope escalation", () => {
    expect(() => parseGrants({ version: 2, grants: [grant, grant] })).toThrow();
    expect(() => parseGrants({ version: 2, grants: [{ ...grant, approved: true }] })).toThrow();
    expect(() => parseGrants({ version: 2, grants: [{ ...grant, scopes: ["read", "admin"] }] })).toThrow();
  });
  it("uses explicit selection, never a browser workspace", () => {
    expect(select(new Headers({ "x-zenith-project": "project-one", "x-zenith-environment": "environment-one", cookie: "zenith-workspace=other" }), grant).workspaceId).toBe("workspace-one");
    expect(() => select(new Headers({ "x-zenith-workspace": "other" }), grant)).toThrow();
    expect(() => select(new Headers({ "x-zenith-project": "other" }), grant)).toThrow();
    expect(() => select(new Headers({ "x-zenith-environment": "environment-one" }), grant)).toThrow();
  });
  it("checks OAuth resource, issuer, expiry, subject and client enrollment", async () => {
    const result = await authenticateOAuth(`Bearer ${"x".repeat(30)}`, [oauthGrant], config, fetcher(claims), now);
    expect(result.subject).toBe(grant.subject); expect(result.scopes).toEqual(["read", "plan", "execute"]);
    expect(Date.parse(result.expiresAt)).toBe(claims.exp * 1000);
  });
  it.each([
    { active: false }, { iss: "https://attacker.example" }, { aud: "authenticated" }, { aud: [] }, { exp: 1 }, { nbf: Math.floor(now / 1000) + 100 }, { sub: "another" }, { client_id: "another" }, { scope: "openid profile" },
  ])("fails closed for OAuth claim mismatch %j", async patch => {
    await expect(authenticateOAuth(`Bearer ${"x".repeat(30)}`, [oauthGrant], config, fetcher({ ...claims, ...patch }), now)).rejects.toThrow();
  });
  it("intersects token scopes with the enrollment", async () => {
    const result = await authenticateOAuth(`Bearer ${"x".repeat(30)}`, [{ ...oauthGrant, scopes: ["read", "plan"] }], config, fetcher(claims), now);
    expect(result.scopes).toEqual(["read", "plan"]);
  });
  it("fails closed when introspection is unavailable", async () => {
    const fail = vi.fn(async () => { throw new Error("network"); }) as unknown as typeof fetch;
    await expect(authenticateOAuth(`Bearer ${"x".repeat(30)}`, [oauthGrant], config, fail, now)).rejects.toMatchObject({ code: "policy_unavailable", status: 503 });
  });
  it("pins introspection to the trusted issuer and refuses redirects", async () => {
    const spy = fetcher(claims);
    await authenticateOAuth(`Bearer ${"x".repeat(30)}`, [oauthGrant], config, spy, now);
    expect(spy).toHaveBeenCalledWith(config.introspectionUrl, expect.objectContaining({ redirect: "error", method: "POST" }));
    await expect(authenticateOAuth(`Bearer ${"x".repeat(30)}`, [oauthGrant], { ...config, introspectionUrl: "https://attacker.example/introspect" }, spy, now)).rejects.toThrow();
    await expect(authenticateOAuth(`Bearer ${token}`, [oauthGrant], config, spy, now)).rejects.toThrow();
  });
  it("binds operator signatures to path, origin, digest, subject and decision", () => {
    const key = randomBytes(32), origin = "http://127.0.0.1:3400";
    const request: ReviewRequest = { receiptId: randomUUID(), subject: "real-admin", decision: "approve", digest: "a".repeat(64), nonce: randomUUID(), expiresAt: now + 10000 };
    const signature = signReview(key, origin, request);
    expect(() => verifyReview(key, origin, request, signature, now)).not.toThrow();
    for (const patch of [{ subject: "other" }, { digest: "b".repeat(64) }, { decision: "reject" }, { expiresAt: now - 1 }, { approved: true }])
      expect(() => verifyReview(key, origin, { ...request, ...patch } as ReviewRequest, signature, now)).toThrow();
    expect(() => verifyReview(key, "http://localhost:3400", request, signature, now)).toThrow();
    expect(() => verifyReview(key, "https://public.example", request, signature, now)).toThrow();
    expect(() => verifyReview(key, origin, request, token, now)).toThrow();
  });
  it("bounds actual streamed bytes rather than trusting Content-Length", async () => {
    const response = new Response("a".repeat(101), { headers: { "content-length": "1" } });
    await expect(boundedBytes(response, 100)).rejects.toMatchObject({ code: "body_too_large" });
  });
  it("ends a body that never finishes", async () => {
    const response = new Response(new ReadableStream({ start() { /* deliberately silent */ } }));
    await expect(boundedBytes(response, 100, 20)).rejects.toMatchObject({ code: "body_timeout" });
  });
});
