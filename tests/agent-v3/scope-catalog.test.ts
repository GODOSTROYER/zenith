/** The scopes a person consents to are the scopes the token, the metadata and the tool catalog use. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAUTH_SCOPE_PREFIX, SCOPE_SUMMARY, consentFacts, scopeCatalog } from "@/lib/agent-access/scope-catalog";
import { INTEGRATION_SCOPES, TOOL_NAMES } from "@/lib/agent-access/v3/contract";
import { catalogFor } from "@/lib/agent-access/v3/catalog";
import { metadata } from "@/lib/agent-access/v3/auth-metadata";

describe("scope catalog", () => {
  it("lists exactly the integration scopes with their literal OAuth strings", () => {
    expect(scopeCatalog().map((s) => s.name)).toEqual([...INTEGRATION_SCOPES]);
    for (const scope of scopeCatalog()) {
      expect(scope.oauthScope).toBe(`${OAUTH_SCOPE_PREFIX}${scope.name}`);
      expect(scope.summary).toBe(SCOPE_SUMMARY[scope.name]);
      expect(scope.alwaysIncluded).toBe(scope.name === "read");
    }
  });

  it("partitions the tool catalog: every tool is unlocked by exactly one scope, and consenting to a scope unlocks only those tools", () => {
    const all = scopeCatalog().flatMap((s) => s.tools).sort();
    expect(all).toEqual([...TOOL_NAMES].sort());
    for (const scope of scopeCatalog()) {
      const unlocked = catalogFor(["read", scope.name]).map((t) => t.name);
      for (const tool of scope.tools) expect(unlocked).toContain(tool);
      // read plus this scope never unlocks a tool that another scope owns
      const owned = new Set([...scopeCatalog().find((s) => s.name === "read")!.tools, ...scope.tools]);
      expect(unlocked.every((name) => owned.has(name))).toBe(true);
    }
  });

  it("consentFacts carries the exact issuer, both resources and the revocation endpoint", () => {
    const facts = consentFacts("https://zenith.example.test", "https://issuer.example.test");
    expect(facts.issuer).toBe("https://issuer.example.test");
    expect(facts.resources).toEqual({ v2: "https://zenith.example.test/api/agent/v2/mcp", v3: "https://zenith.example.test/api/agent/v3/mcp" });
    expect(facts.revocationEndpoint).toBe("https://zenith.example.test/api/agent/oauth/revoke");
    expect(consentFacts("https://zenith.example.test", null).issuer).toBeNull();
  });
});

describe("protected resource metadata agrees with the consent screen", () => {
  beforeEach(() => {
    vi.stubEnv("ZENITH_AGENT_ORIGIN", "https://zenith.example.test");
    vi.stubEnv("ZENITH_AGENT_OAUTH_ISSUER", "https://issuer.example.test/tenant");
    vi.stubEnv("ZENITH_AGENT_OAUTH_JWKS", "https://issuer.example.test/keys");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("advertises the same scope strings, resource and issuer", async () => {
    const body = await metadata(new Request("https://zenith.example.test/.well-known/oauth-protected-resource/api/agent/v3/mcp")).json();
    const facts = consentFacts("https://zenith.example.test", "https://issuer.example.test/tenant");
    expect(body.scopes_supported).toEqual(facts.scopeCatalog.map((s) => s.oauthScope));
    expect(body.resource).toBe(facts.resources.v3);
    expect(body.authorization_servers).toEqual([facts.issuer]);
  });
});
