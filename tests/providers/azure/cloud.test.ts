/**
 * Azure cloud environment abstraction (PROD-LIFE-04). Pure table checks: the sovereign values are from
 * Microsoft's published endpoint tables and are CONTRACT-LEVEL only (never run against a sovereign cloud).
 */
import { describe, expect, it } from "vitest";
import {
  ANY_ACR_LOGIN_SERVER, AZURE_CLOUD_NAMES, PUBLIC_AZURE_CLOUD, UnknownAzureCloudError, acrLoginServerPattern, armUrl, audienceForCloudHost, azureCloud, blobHost, blobHostPattern,
  cloudOf, isAzureCloudName, keyVaultUri, keyVaultUriPattern,
} from "@/lib/providers/azure/cloud";
import { AUTHORITY_HOST, FEDERATION_AUDIENCE, TOKEN_SCOPES, audienceForHost } from "@/lib/providers/azure/credentials";
import { ARM_ORIGIN } from "@/lib/providers/azure/arm";
import { CreateAzureInput } from "@/lib/connections/schemas";

const clouds = AZURE_CLOUD_NAMES.map((n) => azureCloud(n));

describe("AzureCloud table", () => {
  it("public is the default and the legacy public exports are derived from it", () => {
    expect(azureCloud()).toBe(PUBLIC_AZURE_CLOUD);
    expect(cloudOf({})).toBe(PUBLIC_AZURE_CLOUD);
    expect(ARM_ORIGIN).toBe("https://management.azure.com");
    expect(AUTHORITY_HOST).toBe("https://login.microsoftonline.com");
    expect(FEDERATION_AUDIENCE).toBe(PUBLIC_AZURE_CLOUD.federationAudience);
    expect(TOKEN_SCOPES).toBe(PUBLIC_AZURE_CLOUD.tokenScopes);
  });

  it("an unknown cloud is refused, never defaulted to another cloud", () => {
    expect(() => azureCloud("mars")).toThrow(UnknownAzureCloudError);
    expect(() => azureCloud("__proto__")).toThrow(UnknownAzureCloudError);
    expect(isAzureCloudName("constructor")).toBe(false);
    expect(isAzureCloudName("usgov")).toBe(true);
  });

  it.each(clouds.filter((c) => c.name !== "public").map((c) => [c.name, c] as const))("%s shares no endpoint with the public cloud", (_name, cloud) => {
    const pub = PUBLIC_AZURE_CLOUD;
    expect(cloud.armOrigin).not.toBe(pub.armOrigin);
    expect(cloud.authorityHost).not.toBe(pub.authorityHost);
    expect(cloud.federationAudience).not.toBe(pub.federationAudience);
    for (const key of ["blobSuffix", "keyVaultSuffix", "acrSuffix", "monitorSuffix"] as const) expect(cloud[key], key).not.toBe(pub[key]);
    for (const audience of ["arm", "keyvault", "loganalytics", "monitor"] as const) expect(cloud.tokenScopes[audience], audience).not.toBe(pub.tokenScopes[audience]);
    // the storage resource id is the one value Microsoft keeps identical in every cloud
    expect(cloud.tokenScopes.storage).toBe(pub.tokenScopes.storage);
    expect(cloud.tofuEnvironment).not.toBe("public");
    expect(cloud.liveAcceptance).toBe(false);
  });

  it.each(clouds.map((c) => [c.name, c] as const))("%s: every scope is `<resource>/.default`, every origin https, ARM host matches its origin", (_name, c) => {
    for (const scope of Object.values(c.tokenScopes)) expect(scope).toMatch(/^https:\/\/[a-z0-9.-]+\/\.default$/);
    expect(c.armOrigin).toBe(`https://${c.armHost}`);
    expect(c.authorityHost).toMatch(/^https:\/\/login\.[a-z.]+$/);
    expect(c.federationAudience).toMatch(/^api:\/\/AzureADTokenExchange(USGov|China)?$/);
    expect(armUrl(c, "/subscriptions/x")).toBe(`${c.armOrigin}/subscriptions/x`);
    expect(Object.values(c.privateZones).every((z) => !z.startsWith(".") && !z.endsWith("."))).toBe(true);
  });

  it("only the public cloud is marked for live acceptance", () => {
    expect(clouds.filter((c) => c.liveAcceptance).map((c) => c.name)).toEqual(["public"]);
  });
});

describe("host policy per cloud", () => {
  it.each(clouds.map((c) => [c.name, c] as const))("%s: its own hosts get the right audience and other clouds' hosts get none", (_name, c) => {
    expect(audienceForCloudHost(c, c.armHost)).toBe("arm");
    expect(audienceForCloudHost(c, `vault1.${c.keyVaultSuffix}`)).toBe("keyvault");
    expect(audienceForCloudHost(c, c.logAnalyticsHosts[0])).toBe("loganalytics");
    expect(audienceForCloudHost(c, `westeurope.${c.monitorSuffix}`)).toBe("monitor");
    expect(audienceForCloudHost(c, `acct.${c.blobSuffix}`)).toBeUndefined();
    expect(audienceForCloudHost(c, `acct.${c.blobSuffix}`, `acct.${c.blobSuffix}`)).toBe("storage");
    for (const other of clouds.filter((o) => o.name !== c.name)) {
      expect(audienceForCloudHost(c, other.armHost), `${c.name} must not send a token to ${other.armHost}`).toBeUndefined();
      expect(audienceForCloudHost(c, `v.${other.keyVaultSuffix}`)).toBeUndefined();
    }
  });

  it("rejects lookalike hosts in every cloud", () => {
    for (const c of clouds) {
      for (const host of [`${c.armHost}.`, `x${c.armHost}`, `${c.armHost}.evil.test`, `evil.test/${c.armHost}`, `a.b.${c.keyVaultSuffix}`, `.${c.keyVaultSuffix}`]) {
        expect(audienceForCloudHost(c, host), host).toBeUndefined();
      }
    }
  });

  it("the legacy audienceForHost still defaults to the public cloud", () => {
    expect(audienceForHost("management.azure.com")).toBe("arm");
    expect(audienceForHost("management.usgovcloudapi.net")).toBeUndefined();
    expect(audienceForHost("management.usgovcloudapi.net", undefined, azureCloud("usgov"))).toBe("arm");
  });
});

describe("DNS suffix helpers", () => {
  it("ACR login servers follow the cloud's suffix; the any-cloud pattern accepts all three and nothing else", () => {
    expect(acrLoginServerPattern(azureCloud("usgov")).test("acmereg01.azurecr.us")).toBe(true);
    expect(acrLoginServerPattern(azureCloud("usgov")).test("acmereg01.azurecr.io")).toBe(false);
    expect(acrLoginServerPattern(azureCloud("china")).test("acmereg01.azurecr.cn")).toBe(true);
    for (const ok of ["acmereg01.azurecr.io", "acmereg01.azurecr.us", "acmereg01.azurecr.cn"]) expect(ANY_ACR_LOGIN_SERVER.test(ok)).toBe(true);
    for (const bad of ["acme.azurecr.io", "acmereg01.azurecr.io.evil.test", "acmereg01.azurecrxio", "a.b.azurecr.io", "acmereg01.azurecr.com"]) expect(ANY_ACR_LOGIN_SERVER.test(bad), bad).toBe(false);
  });

  it("Blob hosts and Key Vault URIs are built and matched per cloud, with name validation", () => {
    expect(blobHost(azureCloud("china"), "zenithsource")).toBe("zenithsource.blob.core.chinacloudapi.cn");
    expect(() => blobHost(azureCloud(), "Bad_Name")).toThrow();
    expect(blobHostPattern(azureCloud("usgov")).test("acct1.blob.core.usgovcloudapi.net")).toBe(true);
    expect(blobHostPattern(azureCloud("usgov")).test("acct1.blob.core.windows.net")).toBe(false);
    expect(keyVaultUri(azureCloud("usgov"), "my-vault")).toBe("https://my-vault.vault.usgovcloudapi.net/");
    expect(keyVaultUriPattern(azureCloud("china")).exec("https://my-vault.vault.azure.cn/")?.[1]).toBe("my-vault");
    expect(keyVaultUriPattern(azureCloud("china")).test("https://my-vault.vault.azure.net/")).toBe(false);
    expect(() => keyVaultUri(azureCloud(), "-bad")).toThrow();
  });
});

describe("connection input", () => {
  const base = { region: "eastus", tenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", clientId: "99999999-8888-7777-6666-555555555555", subscriptionId: "11111111-2222-3333-4444-555555555555" };
  it("accepts the three clouds and refuses anything else", () => {
    expect(CreateAzureInput.safeParse({ ...base }).success).toBe(true);
    for (const cloud of AZURE_CLOUD_NAMES) expect(CreateAzureInput.safeParse({ ...base, cloud }).success).toBe(true);
    expect(CreateAzureInput.safeParse({ ...base, cloud: "germany" }).success).toBe(false);
    expect(CreateAzureInput.safeParse({ ...base, cloud: "" }).success).toBe(false);
  });
});
