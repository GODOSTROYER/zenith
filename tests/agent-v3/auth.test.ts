/** Live audience/signature verification with local keys, no JWKS network call. */
import { afterEach, expect, it, vi } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { authenticateMcp, resourceFor, type AuthDeps } from "@/lib/agent-access/v3/auth";
import { bindGrant, verifyOAuth, type OAuthConfig, type VerifiedOAuth } from "@/lib/agent-access/control/oauth";
import { identity, ids, ORIGIN, bearer } from "./support";

afterEach(() => vi.unstubAllEnvs());
const req = (authorization = `Bearer ${bearer}`, more: Record<string, string> = {}) => new Request(`${ORIGIN}/api/agent/v3/mcp`, { headers: { authorization, ...more } });
function deps(): AuthDeps {
  return { checkOrigin: () => ORIGIN, now: Date.now, authority: async () => ({ kind: "postgres", verify: async () => ({ ...identity(), id: ids.integration }), touch: async () => {} }),
    oauth: { config: () => undefined, verify: async () => ({}), bind: async () => identity() } };
}
it("the production OAuth config overrides only the resource audience", async () => {
  vi.stubEnv("ZENITH_AGENT_OAUTH_ISSUER", "https://issuer.test"); vi.stubEnv("ZENITH_AGENT_OAUTH_JWKS", "https://issuer.test/jwks");
  const { defaultAuth } = await import("@/lib/agent-access/v3/auth-default");
  expect(defaultAuth().oauth.config(ORIGIN)).toMatchObject({ issuer: "https://issuer.test", resource: resourceFor(ORIGIN), jwksUrl: "https://issuer.test/jwks" });
});
it("a real signed v2 token is refused, a v3 token is narrowed by the browser grant", async () => {
  const keys = await generateKeyPair("EdDSA");
  const config: OAuthConfig = { issuer: "https://issuer.test", jwksUrl: "https://issuer.test/jwks", resource: resourceFor(ORIGIN), clientClaim: "client_id" };
  const d = deps();
  d.oauth = { config: () => config, verify: (token, cfg) => verifyOAuth(token, cfg as OAuthConfig, async () => keys.publicKey),
    bind: async (verified) => bindGrant(verified as VerifiedOAuth, { ...identity({ scopes: ["read", "logs"], oauthIssuer: config.issuer }), projectIds: [ids.project], environmentIds: [ids.env], appIds: undefined, scopes: ["read", "logs"], clientId: "client-a" }) };
  const token = (aud: string) => new SignJWT({ client_id: "client-a", scope: "zenith:read zenith:write zenith:logs" }).setProtectedHeader({ alg: "EdDSA" }).setSubject("bob").setIssuer(config.issuer).setAudience(aud).setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
  await expect(authenticateMcp(req(`Bearer ${await token(`${ORIGIN}/api/agent/v2/mcp`)}`, { "x-zenith-workspace": ids.ws }), d)).rejects.toMatchObject({ code: "invalid_token", status: 401 });
  const result = await authenticateMcp(req(`Bearer ${await token(resourceFor(ORIGIN))}`, { "x-zenith-workspace": ids.ws }), d);
  expect(result.principal.scopes).toEqual(["read", "logs"]); expect(result.principal.via).toBe("oauth");
});
it("a file authority is refused on a remote HTTPS origin", async () => {
  const d = deps(); d.checkOrigin = () => "https://zenith.test";
  d.authority = async () => ({ kind: "file", verify: vi.fn(), touch: async () => {} });
  await expect(authenticateMcp(req(), d)).rejects.toMatchObject({ code: "oauth_required", status: 401 });
});
it("optional selections cannot widen a grant", async () => {
  await expect(authenticateMcp(req(undefined, { "x-zenith-workspace": ids.foreignWs }), deps())).rejects.toMatchObject({ code: "scope_denied" });
  await expect(authenticateMcp(req(undefined, { "x-zenith-project": ids.foreignProject }), deps())).rejects.toMatchObject({ code: "scope_denied" });
  await expect(authenticateMcp(req(undefined, { "x-zenith-project": ids.project, "x-zenith-environment": ids.foreignEnv }), deps())).rejects.toMatchObject({ code: "scope_denied" });
});
