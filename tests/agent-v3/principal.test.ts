/** Grant restrictions produce the broker's exact tenant-neutral refusal. */
import { describe, expect, it } from "vitest";
import { notFound } from "@/lib/capabilities/errors";
import { assertInGrant, principalFromIdentity } from "@/lib/agent-access/v3/principal";
import { mapError } from "@/lib/agent-access/v3/errors";
import { identity, ids, target } from "./support";

describe("MCP principal", () => {
  it("maps credential id and human without assigning a role", () => {
    const p = principalFromIdentity(identity({ scopes: ["read", "read", "unknown", "logs"] }));
    expect(p.principal).toEqual({ kind: "integration", id: ids.integration, integrationId: ids.integration, onBehalfOf: "bob", name: `integration ${ids.integration}` });
    expect(p.scopes).toEqual(["read", "logs"]);
    expect(p.principal).not.toHaveProperty("role");
  });
  it.each(["2000-01-01T00:00:00Z", "invalid"])("refuses expiry %s", (expiresAt) => {
    expect(() => principalFromIdentity(identity({ expiresAt }))).toThrowError(expect.objectContaining({ code: "credential_expired", status: 401 }));
  });
  it("requires the read scope", () => {
    expect(() => principalFromIdentity(identity({ scopes: ["write"] }))).toThrowError(expect.objectContaining({ code: "insufficient_scope" }));
  });
  it.each(["workspaceId", "projectId", "environmentId"])("%s outside the grant is identical to broker not_found", (key) => {
    let error: unknown;
    try { assertInGrant(principalFromIdentity(identity()), { ...target, [key]: "foreign-or-missing" }); } catch (e) { error = e; }
    expect(mapError(error)).toEqual(mapError(notFound()));
  });
  it("an OAuth grant maps the same principal and retains its expiry", () => {
    const p = principalFromIdentity(identity({ oauthIssuer: "https://issuer.test", grantDigest: "digest" }));
    expect(p.via).toBe("oauth");
    expect(p.principal.onBehalfOf).toBe("bob");
  });
});
