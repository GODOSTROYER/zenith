/** Native directory protocol with explicit modeled credential and OAuth journal replies. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/lib/controlplane/types";
const model = vi.hoisted(() => ({ credentials: [] as unknown[], grants: [] as unknown[], retained: undefined as unknown,
  credentialRead: vi.fn(), grantRead: vi.fn(), retainedRead: vi.fn(), journal: vi.fn() }));
vi.mock("@/lib/agent-access/authority", () => ({ credentialAuthority: () => ({ listCredentials: model.credentialRead }) }));
vi.mock("@/lib/agent-access/control/boundary", () => ({ controlOrigin: () => "https://zenith.example" }));
vi.mock("@/lib/agent-access/control/runtime", () => ({ agentJournal: model.journal }));
import { currentIntegrationGrant } from "@/lib/capabilities/current-integration-grants";

const oauthId = "integration_11111111-1111-4111-8111-111111111111";
const nativeId = "cred_22222222-2222-4222-8222-222222222222";
const principal = (integrationId: string): Principal => ({ kind: "integration", id: integrationId, name: "Modeled integration",
  integrationId, onBehalfOf: "bob" });
const fields = () => ({ subject: "bob", workspaceId: "ws-a", projectIds: ["project-a"], environmentIds: ["environment-a"],
  scopes: ["read", "write"], expiresAt: new Date(Date.now() + 60_000).toISOString() });
const native = () => ({ ...fields(), id: nativeId });
const oauth = () => ({ ...fields(), integrationId: oauthId, clientId: "reviewed-client", oauthIssuer: "https://issuer.example/" });
beforeEach(() => {
  vi.stubEnv("ZENITH_AGENT_OAUTH_ISSUER", "https://issuer.example/");
  vi.stubEnv("ZENITH_AGENT_OAUTH_JWKS", "https://issuer.example/keys");
  model.credentials = []; model.grants = []; model.retained = undefined; vi.clearAllMocks();
  model.credentialRead.mockImplementation(async () => model.credentials);
  model.grantRead.mockImplementation(async () => model.grants);
  model.retainedRead.mockImplementation(async () => model.retained);
  model.journal.mockResolvedValue({ grants: model.grantRead, getGrant: model.retainedRead });
});
afterEach(() => { vi.unstubAllEnvs(); });
describe("trusted current integration grant directory [modeled authority reads]", () => {
  it("returns bounded native scopes from one current owning credential without asking OAuth", async () => {
    model.credentials = [native()];
    expect(await currentIntegrationGrant(principal(nativeId), "ws-a")).toEqual({ scopes: ["read", "write"], projectIds: ["project-a"], environmentIds: ["environment-a"] });
    expect(model.credentialRead).toHaveBeenCalledExactlyOnceWith("bob", "ws-a"); expect(model.journal).not.toHaveBeenCalled();
  });
  it.each(["revoked", "expired", "malformed expiry", "missing"])("a %s native credential is never restored by journal fallback", async change => {
    model.credentials = change === "missing" ? [] : [{ ...native(), ...(change === "revoked" ? { revokedAt: new Date().toISOString() }
      : { expiresAt: change === "malformed expiry" ? "invalid" : new Date(0).toISOString() }) }];
    model.grants = [{ ...oauth(), integrationId: nativeId }]; model.retained = model.grants[0];
    expect(await currentIntegrationGrant(principal(nativeId), "ws-a")).toBeNull(); expect(model.journal).not.toHaveBeenCalled();
  });
  it("recognizes the exact current browser grant and unique client key under the configured issuer", async () => {
    const grant = oauth(); model.grants = [grant]; model.retained = grant;
    expect(await currentIntegrationGrant(principal(oauthId), "ws-a")).toEqual({ scopes: ["read", "write"], projectIds: ["project-a"], environmentIds: ["environment-a"] });
    expect(model.grantRead).toHaveBeenCalledExactlyOnceWith("bob", "ws-a");
    expect(model.retainedRead).toHaveBeenCalledExactlyOnceWith("bob", "reviewed-client", "ws-a");
  });
  it.each(["revoked", "expired", "malformed expiry", "missing"])("a %s OAuth grant supplies no authority", async change => {
    const grant = { ...oauth(), ...(change === "revoked" ? { revoked: true }
      : change === "missing" ? {} : { expiresAt: change === "malformed expiry" ? "invalid" : new Date(0).toISOString() }) };
    model.grants = change === "missing" ? [] : [grant]; model.retained = grant;
    expect(await currentIntegrationGrant(principal(oauthId), "ws-a")).toBeNull();
  });
  it.each(["foreign workspace", "foreign human", "wrong issuer", "duplicate identity", "duplicate scopes", "malformed projects", "changed key read", "missing key read"])("OAuth %s refuses rather than choosing a permissive document", async change => {
    const grant = { ...oauth(), ...(change === "foreign workspace" ? { workspaceId: "ws-b" } : {}),
      ...(change === "foreign human" ? { subject: "alice" } : {}), ...(change === "wrong issuer" ? { oauthIssuer: "https://other-issuer.example/" } : {}),
      ...(change === "duplicate scopes" ? { scopes: ["read", "write", "write"] } : {}), ...(change === "malformed projects" ? { projectIds: "project-a" } : {}) };
    model.grants = change === "duplicate identity" ? [grant, { ...grant, revoked: true }] : [grant];
    model.retained = change === "missing key read" ? undefined : change === "changed key read" ? { ...grant, revoked: true } : grant;
    await expect(currentIntegrationGrant(principal(oauthId), "ws-a")).rejects.toMatchObject({ code: "current_integration_grant_unconfirmed" });
  });
  it.each(["foreign workspace", "foreign human", "duplicate", "malformed scopes"])("native %s refuses before any alternate grant lookup", async change => {
    const credential = { ...native(), ...(change === "foreign workspace" ? { workspaceId: "ws-b" } : {}),
      ...(change === "foreign human" ? { subject: "alice" } : {}), ...(change === "malformed scopes" ? { scopes: "write" } : {}) };
    model.credentials = change === "duplicate" ? [credential, credential] : [credential];
    await expect(currentIntegrationGrant(principal(nativeId), "ws-a")).rejects.toMatchObject({ code: "current_integration_grant_unconfirmed" });
    expect(model.journal).not.toHaveBeenCalled();
  });
  it("a native tombstone colliding with an OAuth namespace refuses the live journal grant", async () => {
    model.credentials = [{ ...native(), id: oauthId, revokedAt: new Date().toISOString() }];
    model.grants = [oauth()]; model.retained = model.grants[0];
    await expect(currentIntegrationGrant(principal(oauthId), "ws-a")).rejects.toMatchObject({ code: "current_integration_grant_unconfirmed" });
    expect(model.journal).not.toHaveBeenCalled();
  });
  it.each(["native unavailable", "journal unavailable", "OAuth unconfigured", "OAuth misconfigured"])("%s cannot grant permission", async change => {
    const grant = oauth(); model.grants = [grant]; model.retained = grant;
    if (change === "native unavailable") model.credentialRead.mockRejectedValue(new Error("Modeled private authority diagnostic"));
    if (change === "journal unavailable") model.journal.mockRejectedValue(new Error("Modeled private journal diagnostic"));
    if (change === "OAuth unconfigured") { vi.stubEnv("ZENITH_AGENT_OAUTH_ISSUER", ""); vi.stubEnv("ZENITH_AGENT_OAUTH_JWKS", ""); }
    if (change === "OAuth misconfigured") vi.stubEnv("ZENITH_AGENT_OAUTH_JWKS", "http://untrusted.example/keys");
    if (change === "OAuth unconfigured") expect(await currentIntegrationGrant(principal(oauthId), "ws-a")).toBeNull();
    else await expect(currentIntegrationGrant(principal(oauthId), "ws-a")).rejects.toMatchObject({ message: "The current integration grant could not be confirmed." });
  });
  it("cancellation excludes a late successful current authority reply", async () => {
    let finish!: (value: unknown[]) => void;
    model.credentialRead.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const cancellation = new AbortController(), pending = currentIntegrationGrant(principal(nativeId), "ws-a", cancellation.signal);
    while (!finish) await Promise.resolve();
    cancellation.abort(); finish([native()]);
    await expect(pending).rejects.toMatchObject({ code: "current_integration_grant_unconfirmed" });
    expect(model.journal).not.toHaveBeenCalled();
  });
  it("copied caller identity metadata and an unknown namespace never select the OAuth authority", async () => {
    model.grants = [{ ...oauth(), integrationId: "unknown-integration" }]; model.retained = model.grants[0];
    expect(await currentIntegrationGrant({ ...principal("unknown-integration"), name: "oauth read write admin" }, "ws-a")).toBeNull();
    expect(model.journal).not.toHaveBeenCalled();
  });
});
