/** Backend assembly and refusal contracts; cloud state operations stay gated. */
import { describe, expect, it } from "vitest";
import type { ConnectionConfig, ProviderConnection } from "@/lib/credentials/types";
import { backendForConnection } from "@/lib/tofu/backends";
import { TofuRunner } from "@/lib/tofu/runner";
import { assembleWorkspace, assertWorkspaceIntact, configDigestOf, type BackendConfig } from "@/lib/tofu/workspace";
import { stableJson } from "@/lib/tofu/stable";
import { graphOf, tofuOnPath } from "./_helpers";

const scope = { workspaceId: "ws_1", environmentId: "env_1" };
const KEY = "zenith/ws_1/env_1/terraform.tfstate";
const KMS = "projects/acme-prod/locations/us-central1/keyRings/state/cryptoKeys/tofu";
const OCI = "https://axnamespace.compat.objectstorage.us-ashburn-1.oraclecloud.com";
const configs: ConnectionConfig[] = [
  { provider: "aws", mode: "oidc_web_identity", accountId: "123456789012", observeRoleArn: "arn:aws:iam::123456789012:role/observe", deployRoleArn: "arn:aws:iam::123456789012:role/deploy", region: "ap-south-1", stateBucket: "acme-state", stateKmsKeyArn: "arn:aws:kms:ap-south-1:123456789012:key/11111111-1111-1111-1111-111111111111" },
  { provider: "gcp", mode: "oidc_web_identity", projectId: "acme-prod", workloadIdentityProvider: "projects/123/locations/global/workloadIdentityPools/pool/providers/zenith", observeServiceAccount: "observe@acme-prod.iam.gserviceaccount.com", deployServiceAccount: "deploy@acme-prod.iam.gserviceaccount.com", region: "us-central1", stateBucket: "acme-state", stateKmsKey: KMS },
  { provider: "azure", mode: "oidc_web_identity", tenantId: "11111111-1111-1111-1111-111111111111", clientId: "22222222-2222-2222-2222-222222222222", subscriptionId: "33333333-3333-3333-3333-333333333333", region: "westeurope", stateStorageAccount: "acmestate123", stateContainer: "tfstate" },
  { provider: "oci", mode: "runner", tenancyOcid: "ocid1.tenancy.oc1..abc", compartmentOcid: "ocid1.compartment.oc1..abc", region: "us-ashburn-1", runnerId: "runner1", stateBucket: "acme-state", stateNamespace: "axnamespace" },
];
function connection(config: ConnectionConfig): ProviderConnection {
  return { id: "conn_1", workspaceId: scope.workspaceId, config, status: "verified", createdBy: "user", createdAt: "now" };
}
function assemble(backend: BackendConfig, stateKey: string | undefined = KEY) {
  return assembleWorkspace({ graph: graphOf([]), fragments: new Map(), providerSet: "builtin", region: "ap-south-1", backend, stateKey, tags: {} });
}
function block(backend: BackendConfig, stateKey?: string) {
  const ws = assemble(backend, stateKey);
  return JSON.parse(ws.files.find((f) => f.path === "backend.tf.json")!.content).terraform;
}

describe("backendForConnection", () => {
  it.each(configs.map((config) => [config.provider, config] as const))("%s assembles its deterministic state location", (_provider, config) => {
    const result = backendForConnection(connection(config), scope);
    const ws = assemble(result.backend, result.stateKey);
    expect(ws.backend).toBe(config.provider === "gcp" ? "gcs" : config.provider === "azure" ? "azurerm" : "s3");
    expect(backendForConnection(connection(config), scope)).toEqual(result);
    if (config.provider === "gcp") {
      expect(result.stateKey).toBe("zenith/ws_1/env_1/default.tfstate");
      expect(block(result.backend, result.stateKey).backend.gcs).toEqual({ bucket: "acme-state", prefix: "zenith/ws_1/env_1", kms_encryption_key: KMS });
    } else {
      expect(result.stateKey).toBe(KEY);
    }
    if (config.provider === "azure") expect(block(result.backend).backend.azurerm).toEqual({ storage_account_name: "acmestate123", container_name: "tfstate", key: KEY, use_azuread_auth: true, use_oidc: true, use_cli: false });
    if (config.provider === "oci") expect(block(result.backend).backend.s3).toEqual({ bucket: "acme-state", key: KEY, region: "us-ashburn-1", encrypt: false, use_lockfile: true, endpoints: { s3: OCI }, use_path_style: true, skip_region_validation: true, skip_credentials_validation: true, skip_requesting_account_id: true, skip_s3_checksum: true, skip_metadata_api_check: true });
    if (config.provider === "aws") expect(block(result.backend).encryption.state.enforced).toBe(true);
  });

  it.each(configs.map((config) => [config.provider, config] as const))("%s refuses incomplete state settings", (_provider, config) => {
    const bad = { ...config };
    for (const key of ["stateBucket", "stateNamespace", "stateStorageAccount", "stateContainer"]) delete (bad as unknown as Record<string, unknown>)[key];
    expect(() => backendForConnection(connection(bad), scope)).toThrow(/state/);
  });

  it("refuses tenant/path escapes, invalid stored settings and unsupported connections", () => {
    const c = connection(configs[0]);
    expect(() => backendForConnection({ ...c, workspaceId: "ws_foreign" }, scope)).toThrow(/workspace/);
    for (const id of ["../other", "a/b", "", "a..b", "a%2Fb", "a\n", "x".repeat(129)]) {
      expect(() => backendForConnection(c, { ...scope, workspaceId: id })).toThrow();
      expect(() => backendForConnection(c, { ...scope, environmentId: id })).toThrow();
    }
    const invalid = { ...configs[3], stateNamespace: "other.oraclecloud.com/?secret=canary" } as ConnectionConfig;
    try { backendForConnection(connection(invalid), scope); throw new Error("accepted"); }
    catch (error) { expect(error).toHaveProperty("code", "invalid_input"); expect(String(error)).not.toContain("canary"); }
    expect(() => backendForConnection(connection({ provider: "kubernetes", mode: "runner", server: "https://cluster.internal", namespaces: [] }), scope)).toThrow(/override/);
  });

  it("Azure runner mode delegates OIDC selection to ARM_USE_OIDC without enabling CLI auth", () => {
    const azure = { ...configs[2], mode: "runner" } as ConnectionConfig;
    const result = backendForConnection(connection(azure), scope);
    expect(block(result.backend).backend.azurerm).toEqual({ storage_account_name: "acmestate123", container_name: "tfstate", key: KEY, use_azuread_auth: true, use_cli: false });
  });
});

describe("strict backend fields", () => {
  const valid: BackendConfig[] = [
    { kind: "gcs", bucket: "acme-state", prefix: "zenith/ws/env", kmsEncryptionKey: KMS },
    { kind: "azurerm", storageAccountName: "acmestate123", containerName: "tfstate", useOidc: true },
    { kind: "s3", bucket: "acme-state", region: "us-ashburn-1", endpoint: OCI, usePathStyle: true },
  ];
  it.each(valid.map((b) => [b.kind, b] as const))("%s refuses all undeclared keys, including credentials", (_kind, backend) => {
    for (const key of ["access_key", "secret_key", "credentials", "access_token", "sas_token", "accessKey", "encryption_key", "profile", "insecure", "http_proxy", "unknown", "__proto__"]) {
      expect(() => assemble({ ...backend, [key]: "secret-canary" } as BackendConfig)).toThrow(/allowlist/);
    }
  });
  it("GCS prefix/KMS and Azure account/container enforce their safe alphabets", () => {
    expect(block({ kind: "gcs", bucket: "acme-state" }).backend.gcs.prefix).toBe(KEY);
    for (const prefix of ["", "../x", "/x", "x/", "x//y", "x\n", "${local.x}", "x".repeat(1025)]) expect(() => assemble({ kind: "gcs", bucket: "acme-state", prefix })).toThrow();
    expect(() => assembleWorkspace({ graph: graphOf([]), fragments: new Map(), providerSet: "builtin", region: "us-central1", tags: {}, backend: { kind: "gcs", bucket: "acme-state" } })).toThrow(/stateKey/);
    for (const value of ["", "UPPER", "x;echo", "abc/def", "x\n", "${local.x}"]) {
      expect(() => assemble({ kind: "azurerm", storageAccountName: value, containerName: "tfstate" })).toThrow();
      expect(() => assemble({ kind: "azurerm", storageAccountName: "acmestate123", containerName: value })).toThrow();
      expect(() => assemble({ kind: "gcs", bucket: "acme-state", kmsEncryptionKey: value })).toThrow();
    }
    for (const bucket of ["Bad_Bucket", "ab", "a..b", "127.0.0.1", "x\n", "${local.x}"]) expect(() => assemble({ kind: "gcs", bucket })).toThrow();
    expect(() => assemble({ kind: "azurerm", storageAccountName: "acmestate123", containerName: "tf--state" })).toThrow();
    expect(() => assemble({ kind: "azurerm", storageAccountName: "acmestate123", containerName: "tfstate", useOidc: false })).toThrow();
  });
  it("OCI endpoint is https on the exact compatibility host in the configured region", () => {
    for (const endpoint of ["http://axnamespace.compat.objectstorage.us-ashburn-1.oraclecloud.com", "https://user:secret@axnamespace.compat.objectstorage.us-ashburn-1.oraclecloud.com", `${OCI}.evil.invalid`, `${OCI}:443`, `${OCI}?token=secret`, `${OCI}/path`, `${OCI}#fragment`, OCI.replace("us-ashburn-1", "eu-frankfurt-1"), "https://127.0.0.1", "https://metadata.google.internal"]) expect(() => assemble({ kind: "s3", bucket: "acme-state", region: "us-ashburn-1", endpoint })).toThrow();
    for (const field of ["usePathStyle", "skipRegionValidation", "skipCredentialsValidation", "skipRequestingAccountId", "skipS3Checksum", "skipMetadataApiCheck"]) {
      expect(() => assemble({ ...valid[2], [field]: "true" } as BackendConfig)).toThrow();
      expect(() => assemble({ kind: "s3", bucket: "acme-state", [field]: true } as BackendConfig)).toThrow();
    }
    expect(() => assemble({ ...valid[2], encryptionKmsKeyArn: configs[0].provider === "aws" ? configs[0].stateKmsKeyArn : "" } as BackendConfig)).toThrow(/AWS KMS/);
  });
  it("bad runtime types, missing keys, and every HTTP backend URL are refused", () => {
    for (const backend of [null, { kind: "unknown" }, { kind: "gcs", bucket: 123 }, { kind: "gcs", bucket: "acme-state", prefix: 123 }, { kind: "azurerm", storageAccountName: 123, containerName: "tfstate" }]) expect(() => assemble(backend as BackendConfig)).toThrow();
    for (const field of ["address", "lockAddress", "unlockAddress"]) {
      expect(() => assemble({ kind: "http", address: "https://state.internal", [field]: "https://user:secret@state.internal" })).toThrow(/credentials/);
    }
  });
  it.each(valid.map((b) => [b.kind, b] as const))("%s serialized backend cannot inject credentials under a matching digest", (_kind, backend) => {
    const ws = assemble(backend);
    const files = ws.files.map((f) => {
      if (f.path !== "backend.tf.json") return f;
      const value = JSON.parse(f.content);
      value.terraform.backend[backend.kind].access_token = "private-canary";
      return { ...f, content: stableJson(value) };
    });
    expect(() => assertWorkspaceIntact({ ...ws, files, configDigest: configDigestOf(files) })).toThrow(/allowlist/);
  });
});

// No cloud credentials or backend init: this is real binary schema validation
// only, gated exactly like the existing provider network suites.
describe.skipIf(process.env.ZENITH_TEST_TOFU_NETWORK !== "1" || !tofuOnPath())("real backend block validation (network gate, no cloud calls)", () => {
  it.each(configs.map((config) => [config.provider, config] as const))("%s: tofu init -backend=false then tofu validate", async (_provider, config) => {
    // Client-side AWS encryption initializes KMS key material; checking it
    // here would require real credentials. Unit coverage checks its shape.
    const nonEncrypted = { ...config };
    if (nonEncrypted.provider === "aws") delete nonEncrypted.stateKmsKeyArn;
    const result = backendForConnection(connection(nonEncrypted), scope);
    const runner = new TofuRunner();
    await runner.run(assemble(result.backend, result.stateKey), {}, async (run) => {
      await run.init({ backend: false });
      expect((await run.validate()).valid).toBe(true);
    });
  }, 120_000);
});
