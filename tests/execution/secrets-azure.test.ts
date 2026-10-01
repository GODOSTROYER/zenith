/** Scripted ARM/Key Vault transport and real activity/resolver/helper logic. */
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorld, type World } from "./fakes/world";
import { ENV, PROJECT, WS, OP } from "./fakes/fixtures";
import { createRuntime } from "@/lib/execution/runtime";
import { loadExecContext } from "@/lib/execution/context";
import { syncEnvironmentSecrets } from "@/lib/execution/secrets";
import { putSecretAsync } from "@/lib/secrets";
import type { AzureSession } from "@/lib/credentials/types";
import type { ResourceGraph, ResourceNode } from "@/lib/resources/types";
const subscriptionId = "11111111-1111-1111-1111-111111111111";
const vault = "https://zenith-env1-key.vault.azure.net/";
const containerId = `/subscriptions/${subscriptionId}/resourceGroups/zenith-env1/providers/Microsoft.KeyVault/vaults/zenith-env1-key`;
const secretRef = `vault:${PROJECT}/svc-web/API_KEY`;
const targetId = `${vault}secrets/API-KEY`;
const CANARY = "AZURE-SECRET-CANARY-555-only-memory";
let w: World;
afterEach(() => { w?.dispose(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function fixture() {
  w = createWorld({ script: { observe: async (ctx, node) => ({ address: node.address, externalId: containerId, presence: "present", attributes: {}, source: "contract.fake", simulated: false, observedAt: ctx.now().toISOString() }) } });
  vi.stubEnv("ZENITH_DATA", w.planDir); vi.stubEnv("ZENITH_STORE", "file"); vi.stubEnv("ZENITH_SECRET_KEY", randomBytes(32).toString("base64"));
  w.product.base.environment.provider = "azure";
  const connection = { ...w.connections.connections[0], config: { provider: "azure" as const, mode: "oidc_web_identity" as const, tenantId: "tenant", clientId: "client", subscriptionId, region: "centralindia" } };
  await w.activities.markOperation({ operationId: OP, status: "running" }); const lease = await w.lease();
  const rt = createRuntime(w.deps); const ec = await loadExecContext(rt, OP);
  const node: ResourceNode = { address: "secret/api-key", kind: "secret", provider: "azure", region: "centralindia", nativeType: "azure:key_vault_secret", ownership: "managed", spec: { secretRef }, origin: [], dependsOn: [], labels: {}, specDigest: "s" };
  const graph: ResourceGraph = { version: 1, nodes: [node], edges: [], environmentId: ENV, graphDigest: "g", manifestDigest: "m", notes: [] };
  await putSecretAsync(WS, secretRef, CANARY, "actor");
  const fetch = vi.fn<AzureSession["authorizedFetch"]>();
  const session: AzureSession = { provider: "azure", subscriptionId, region: node.region, expiresAt: "2099-01-01", authorizedFetch: fetch, childProcessEnv: () => ({}) };
  vi.spyOn(w.credentials, "withSession").mockImplementation(async (_req, fn) => fn(session));
  const issue = w.broker.issueGrant.bind(w.broker);
  vi.spyOn(w.broker, "issueGrant").mockImplementation(async (...args) => {
    const result = await issue(...args);
    if (result.claims.cap === "secret.write") result.claims.constraints = { secretResources: [targetId] };
    return result;
  });
  const tags = { "zenith:managed": "true", "zenith:workspace": WS, "zenith:environment": ENV, "zenith:resource": node.address };
  const metadata = (patch: Record<string, unknown> = {}) => Response.json({ id: containerId, properties: { vaultUri: vault }, tags: { ...tags, ...patch } });
  return { fetch, metadata, sync: () => syncEnvironmentSecrets(rt, ec, graph, connection, lease, new AbortController().signal) };
}
describe("Azure activity delivery", () => {
  it("reuses the Key Vault writer after exact tenant/container checks and leaks no response values", async () => {
    const { fetch, metadata, sync } = await fixture();
    fetch.mockResolvedValueOnce(metadata()).mockResolvedValueOnce(new Response("", { status: 404 })).mockResolvedValueOnce(Response.json({ id: `${targetId}/${"a".repeat(32)}`, value: CANARY }));
    expect(await sync()).toMatchObject({ status: "done", changed: 1 });
    expect(JSON.parse(fetch.mock.calls[2][1]!.body as string).value).toBe(CANARY);
    expect(w.stored()).not.toContain(CANARY); expect(JSON.stringify(w.logs)).not.toContain(CANARY);
  });
  it("skips an unchanged value without a PUT", async () => {
    const { fetch, metadata, sync } = await fixture();
    fetch.mockResolvedValueOnce(metadata()).mockResolvedValueOnce(Response.json({ id: `${targetId}/${"a".repeat(32)}`, value: CANARY }));
    expect(await sync()).toMatchObject({ changed: 0 }); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("refuses a foreign workspace tag before reading a value", async () => {
    const { fetch, metadata, sync } = await fixture();
    fetch.mockResolvedValueOnce(metadata({ "zenith:workspace": "foreign" }));
    await expect(sync()).rejects.toThrow("denied"); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([[403, "denied"], [429, "throttled"], [503, "unreachable"]])("classifies HTTP %s without reflecting provider body strings", async (status, reason) => {
    const { fetch, metadata, sync } = await fixture();
    fetch.mockResolvedValueOnce(metadata()).mockResolvedValueOnce(Response.json({ error: { code: CANARY, message: CANARY } }, { status: status as number }));
    const error = await sync().catch((e: unknown) => e);
    expect(String(error)).toContain(reason); expect(String(error)).not.toContain(CANARY); expect(w.stored()).not.toContain(CANARY);
  });
});
