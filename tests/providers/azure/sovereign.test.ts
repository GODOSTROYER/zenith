/**
 * Sovereign-cloud contract tests (PROD-LIFE-04). A fake Entra authority and a fake ARM/Key Vault/ACR/Blob answer
 * on the SOVEREIGN hostnames. These prove Zenith derives every endpoint from the connection's cloud and never
 * sends a bearer token to a public-cloud host from a sovereign session. They are CONTRACT-LEVEL: no sovereign
 * cloud (or any Azure account) is involved, and live acceptance for these clouds is deferred.
 */
import { describe, expect, it } from "vitest";
import { CredentialDeniedError, type AzureConnectionConfig } from "@/lib/credentials/types";
import { createAzureSession, AzureRequestRefusedError, sourceStorageHost } from "@/lib/providers/azure/credentials";
import { armClient, ArmError, pollOperation } from "@/lib/providers/azure/arm";
import { azureCloud, type AzureCloudName } from "@/lib/providers/azure/cloud";
import { syncSecretValue, SecretSyncError } from "@/lib/providers/azure/secrets";
import { assertUploadUrl, runAcrBuild, validateBuildInput, AcrBuildError } from "@/lib/providers/azure/acr-build";
import { scheduleBuild } from "@/lib/providers/azure/release/acr-task";
import { kvSecretName } from "@/lib/providers/azure/drivers/identity/key-vault-secret";
import { AZURE_DRIVERS } from "@/lib/providers/azure/drivers";
import { buildChildEnv } from "@/lib/tofu/env";
import { CLIENT, SUB, TENANT, compileContext, connection, fakeAssertion, sampleGraph } from "./_helpers";

type Reply = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

function world(cloud: AzureCloudName, reply: Reply = () => new Response("{}", { status: 200 })) {
  const c = azureCloud(cloud);
  const exchanges: { url: string; body: URLSearchParams }[] = [];
  const calls: { url: string; method: string; authorization: string | null }[] = [];
  const minted: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(`${c.authorityHost}/`)) {
      const body = new URLSearchParams(String(init?.body ?? ""));
      exchanges.push({ url, body });
      return new Response(JSON.stringify({ access_token: `sov-token-${exchanges.length}-${"x".repeat(24)}`, token_type: "Bearer", expires_in: 3599 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("login.microsoftonline")) return new Response("{}", { status: 404 });
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase(), authorization: new Headers(init?.headers).get("authorization") });
    return reply(new URL(url), init);
  }) as typeof fetch;
  const config: AzureConnectionConfig = { ...connection, ...(cloud === "public" ? {} : { cloud }) };
  const open = (over: Partial<Parameters<typeof createAzureSession>[0]> = {}) =>
    createAzureSession({
      connection: config,
      purpose: "deploy",
      fetchImpl,
      mintClientAssertion: async (audience) => {
        minted.push(audience);
        return fakeAssertion(Math.floor(Date.now() / 1000) + 300, "zenith:ws:ws_1:conn:conn_1", String(minted.length));
      },
      ...over,
    });
  return { c, exchanges, calls, minted, open, config };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const sovereign = ["usgov", "china"] as const;

describe.each(sovereign)("%s federated identity and endpoints", (cloud) => {
  const c = azureCloud(cloud);

  it("exchanges at the cloud's authority with the cloud's federation audience and ARM scope", async () => {
    const w = world(cloud, () => json({ subscriptionId: SUB }));
    const s = await w.open();
    // the assertion for OpenTofu is minted eagerly for this audience
    expect(w.minted).toEqual([c.federationAudience]);
    const res = await s.authorizedFetch(`${c.armOrigin}/subscriptions/${SUB}?api-version=2022-12-01`);
    expect(res.status).toBe(200);
    expect(w.exchanges).toHaveLength(1);
    expect(w.exchanges[0].url).toBe(`${c.authorityHost}/${TENANT}/oauth2/v2.0/token`);
    expect(w.exchanges[0].body.get("scope")).toBe(c.tokenScopes.arm);
    expect(w.exchanges[0].body.get("client_id")).toBe(CLIENT);
    expect(w.minted).toEqual([c.federationAudience, c.federationAudience]);
    expect(w.calls[0].authorization).toMatch(/^Bearer sov-token-1-/);
    expect(s.cloud).toBe(cloud);
  });

  it("never sends a bearer token to a public-cloud host or another sovereign cloud's host", async () => {
    const w = world(cloud);
    const s = await w.open();
    for (const url of ["https://management.azure.com/subscriptions", "https://v.vault.azure.net/secrets", "https://api.loganalytics.io/v1/x", ...sovereign.filter((o) => o !== cloud).map((o) => `${azureCloud(o).armOrigin}/subscriptions`)]) {
      await expect(s.authorizedFetch(url), url).rejects.toBeInstanceOf(AzureRequestRefusedError);
    }
    expect(w.calls).toHaveLength(0);
    expect(w.exchanges).toHaveLength(0);
  });

  it("uses the Key Vault and Log Analytics audiences of the cloud for its own hosts", async () => {
    const w = world(cloud);
    const s = await w.open();
    await s.authorizedFetch(`https://myvault.${c.keyVaultSuffix}/secrets?api-version=7.4`);
    await s.authorizedFetch(`https://${c.logAnalyticsHosts[0]}/v1/workspaces/x/query`, { method: "POST", body: "{}" });
    expect(w.exchanges.map((e) => e.body.get("scope"))).toEqual([c.tokenScopes.keyvault, c.tokenScopes.loganalytics]);
  });

  it("OpenTofu is told the sovereign environment; the public cloud sets nothing", async () => {
    const s = await world(cloud).open();
    expect(s.childProcessEnv()).toMatchObject({ ARM_ENVIRONMENT: c.tofuEnvironment, ARM_USE_OIDC: "true", ARM_STORAGE_USE_AZUREAD: "true", ARM_RESOURCE_PROVIDER_REGISTRATIONS: "none" });
    expect(JSON.stringify(s)).not.toContain("sov-token");
    const pub = await world("public").open();
    expect(pub.childProcessEnv()).not.toHaveProperty("ARM_ENVIRONMENT");
    expect(pub.cloud).toBeUndefined();
  });

  it("builds ARM URLs on the cloud's origin and refuses a nextLink that leaves it", async () => {
    const w = world(cloud, (url) => (url.pathname.endsWith("/page1") ? json({ value: [{ id: "a" }], nextLink: "https://management.azure.com/next?api-version=1" }) : json({ value: [] })));
    const s = await w.open();
    const arm = armClient(s);
    await arm.get("/subscriptions/x/page2", { apiVersion: "2024-01-01" });
    expect(w.calls[0].url.startsWith(`${c.armOrigin}/subscriptions/x/page2?api-version=2024-01-01`)).toBe(true);
    await expect(arm.list("/subscriptions/x/page1", { apiVersion: "2024-01-01" })).rejects.toMatchObject({ kind: "bad_response" });
    // an async-operation URL on the public origin is not polled from a sovereign session
    const out = await pollOperation(s, { status: 202, headers: new Headers({ "azure-asyncoperation": "https://management.azure.com/ops/1?api-version=1" }) });
    expect(out.state).toBe("unknown");
  });

  it("Key Vault secret sync targets the cloud's vault suffix and refuses a public-cloud vault URI", async () => {
    const ref = "vault:ws_1/env_1/DB_URL";
    const w = world(cloud, (url, init) => {
      if (!url.hostname.endsWith(c.keyVaultSuffix)) return new Response("{}", { status: 400 });
      if ((init?.method ?? "GET") === "GET") return json({ error: { code: "SecretNotFound", message: "nf" } }, 404);
      return json({ id: `https://myvault.${c.keyVaultSuffix}/secrets/${kvSecretName(ref)}/0123456789abcdef0123456789abcdef` });
    });
    const s = await w.open();
    const done = await syncSecretValue(s, { vaultUri: `https://myvault.${c.keyVaultSuffix}/`, secretRef: ref, value: "a-secret-value" });
    expect(done.status).toBe("created");
    expect(w.calls.map((x) => new URL(x.url).hostname)).toEqual([`myvault.${c.keyVaultSuffix}`, `myvault.${c.keyVaultSuffix}`]);
    await expect(syncSecretValue(s, { vaultUri: "https://myvault.vault.azure.net/", secretRef: ref, value: "a-secret-value" })).rejects.toMatchObject({ reason: "invalid_input" });
    await expect(syncSecretValue(s, { vaultUri: "https://myvault.vault.azure.net/", secretRef: ref, value: "x" })).rejects.toBeInstanceOf(SecretSyncError);
  });

  it("source storage bindings: the binding cloud must equal an explicit connection cloud", () => {
    const binding = { accountResourceId: `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/zenithsource`, container: "source", resourceAddress: "object_store/src", cloud };
    expect(sourceStorageHost(binding, SUB, cloud)).toBe(`zenithsource.${c.blobSuffix}`);
    expect(sourceStorageHost({ ...binding, cloud: undefined }, SUB, cloud)).toBe(`zenithsource.${c.blobSuffix}`);
    const other = sovereign.find((o) => o !== cloud)!;
    expect(() => sourceStorageHost({ ...binding, cloud: other }, SUB, cloud)).toThrow(AzureRequestRefusedError);
    expect(() => sourceStorageHost({ ...binding, cloud: "public" }, SUB, cloud)).toThrow(AzureRequestRefusedError);
  });

  it("ACR Tasks: upload URL, login server and the whole run are checked against the cloud's suffixes", async () => {
    const registryId = `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.ContainerRegistry/registries/acmereg01`;
    const login = `acmereg01.${c.acrSuffix}`;
    const digest = `sha256:${"b".repeat(64)}`;
    const uploads: string[] = [];
    const w = world(cloud, (url) => {
      if (url.pathname.endsWith("/listBuildSourceUploadUrl")) return json({ uploadUrl: `https://acmestore.${c.blobSuffix}/up/src?sig=abc`, relativePath: "src/archive.tar.gz" });
      if (url.pathname.endsWith("/scheduleRun")) return json({ properties: { runId: "cb1" } });
      if (url.pathname.endsWith("/runs/cb1")) return json({ properties: { status: "Succeeded", outputImages: [{ registry: login, repository: "web", tag: "latest", digest }] } });
      return new Response("{}", { status: 404 });
    });
    const s = await w.open();
    const uploadFetch = (async (u: string) => (uploads.push(u), new Response("", { status: 201 }))) as unknown as typeof fetch;
    const r = await runAcrBuild(s, { registryId, loginServer: login, repository: "web", source: new Uint8Array([1, 2, 3]), uploadFetch, pollIntervalMs: 1 });
    expect(r.images[0]).toEqual({ image: `${login}/web:latest`, digest });
    expect(uploads).toEqual([`https://acmestore.${c.blobSuffix}/up/src?sig=abc`]);
    expect(w.calls.every((x) => x.url.startsWith(c.armOrigin))).toBe(true);
    // a public-cloud login server or public blob upload URL is refused under this cloud
    expect(() => validateBuildInput({ registryId, loginServer: "acmereg01.azurecr.io", repository: "web", source: new Uint8Array([1]) }, SUB, c)).toThrow(AcrBuildError);
    expect(() => assertUploadUrl("https://acmestore.blob.core.windows.net/up?sig=abc", c)).toThrow(AcrBuildError);
    expect(() => assertUploadUrl(`https://acmestore.${c.blobSuffix}/up?sig=abc`, c)).not.toThrow();
  });

  it("the release scheduleBuild path launches against the sovereign registry and refuses a public upload host", async () => {
    const registryId = `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.ContainerRegistry/registries/acmereg01`;
    let host = c.blobSuffix;
    const w = world(cloud, (url) => {
      if (url.pathname.endsWith("/listBuildSourceUploadUrl")) return json({ uploadUrl: `https://acmestore.${host}/up/src?sig=abc`, relativePath: "src/archive.tar.gz" });
      if (url.pathname.endsWith("/scheduleRun")) return json({ properties: { runId: "cb2" } });
      return new Response("{}", { status: 404 });
    });
    const session = await w.open();
    const ctx = { provider: "azure", region: "eastus", workspaceId: "ws", environmentId: "env", operationId: "op", session, signal: new AbortController().signal, log: () => undefined, tags: {}, now: () => new Date() } as unknown as Parameters<typeof scheduleBuild>[0];
    const input = { registryId, loginServer: `acmereg01.${c.acrSuffix}`, repository: "web", source: new Uint8Array([1, 2, 3]), tag: `zn-${"c".repeat(64)}`, uploadFetch: (async () => new Response("", { status: 201 })) as unknown as typeof fetch };
    await expect(scheduleBuild(ctx, input)).resolves.toBe("cb2");
    host = "blob.core.windows.net";
    await expect(scheduleBuild(ctx, input)).rejects.toBeInstanceOf(AcrBuildError);
  });

  it("private-endpoint DNS zones and the Postgres zone follow the cloud when the compile context names it", () => {
    const nodes = sampleGraph();
    const net = nodes.find((n) => n.address === "network/main")!;
    const driver = AZURE_DRIVERS.find((d) => d.nativeType === net.nativeType)!;
    const frag = driver.compile!(net, { ...compileContext(nodes), azureCloud: cloud });
    const names = Object.values(frag.resource!.azurerm_private_dns_zone as Record<string, { name: string }>).map((z) => z.name);
    expect(names).toEqual(expect.arrayContaining([c.privateZones.blob, c.privateZones.queue, c.privateZones.redis, c.privateZones.web]));
    expect(names.some((n) => n.endsWith(`.${c.privateZones.postgres}`))).toBe(true);
    expect(names.some((n) => n.includes("windows.net") || n.includes("database.azure.com"))).toBe(false);
    // the default context (no cloud) still compiles the public zones
    const pub = driver.compile!(net, compileContext(nodes));
    expect(Object.values(pub.resource!.azurerm_private_dns_zone as Record<string, { name: string }>).map((z) => z.name)).toContain("privatelink.blob.core.windows.net");
  });
});

describe("OpenTofu child environment carries the sovereign environment", () => {
  const dirs = { homeDir: "/private/home", tmpDir: "/private/tmp", cliConfigFile: "/private/cli", pluginCacheDir: "/cache" };
  it.each([["usgov", "usgovernment"], ["china", "china"]] as const)("%s session env passes the Azure allowlist as ARM_ENVIRONMENT=%s", async (cloud, environment) => {
    const session = await world(cloud).open();
    const env = buildChildEnv({ ...dirs, sessionProvider: "azure", sessionEnv: session.childProcessEnv() });
    expect(env.ARM_ENVIRONMENT).toBe(environment);
    expect(env.ARM_USE_OIDC).toBe("true");
  });
  it("refuses an ARM_ENVIRONMENT outside the three known values and keeps the public env unchanged", async () => {
    const pub = await world("public").open();
    expect(buildChildEnv({ ...dirs, sessionProvider: "azure", sessionEnv: pub.childProcessEnv() })).not.toHaveProperty("ARM_ENVIRONMENT");
    expect(() => buildChildEnv({ ...dirs, sessionProvider: "azure", sessionEnv: { ...pub.childProcessEnv(), ARM_ENVIRONMENT: "evilcloud" } })).toThrow(/Azure authentication contract/);
  });
});

describe("sovereign session guards", () => {
  it("an unknown cloud name cannot create a session", async () => {
    const w = world("public");
    await expect(w.open({ connection: { ...w.config, cloud: "mars" as never } })).rejects.toBeInstanceOf(CredentialDeniedError);
    expect(w.exchanges).toHaveLength(0);
  });

  it("a public session keeps the verified public behaviour end to end", async () => {
    const w = world("public", () => json({ ok: true }));
    const s = await w.open();
    await s.authorizedFetch("https://management.azure.com/subscriptions?api-version=2022-12-01");
    expect(w.exchanges[0].url).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    expect(w.exchanges[0].body.get("scope")).toBe("https://management.azure.com/.default");
    expect(w.minted[0]).toBe("api://AzureADTokenExchange");
    await expect(s.authorizedFetch("https://management.usgovcloudapi.net/subscriptions")).rejects.toBeInstanceOf(AzureRequestRefusedError);
  });

  it("ArmError classification is unchanged under a sovereign session", async () => {
    const w = world("usgov", () => json({ error: { code: "AuthorizationFailed", message: "no" } }, 403));
    const s = await w.open();
    await expect(armClient(s).get("/subscriptions/x", { apiVersion: "1" })).rejects.toBeInstanceOf(ArmError);
  });
});
