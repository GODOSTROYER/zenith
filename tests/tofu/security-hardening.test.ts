/** Regression coverage for closed provider/env contracts and visible Unicode. */
import { describe, expect, it } from "vitest";
import { buildChildEnv, validateExtraEnv, type SessionEnvProvider } from "@/lib/tofu/env";
import { planView } from "@/lib/tofu/plan";
import { stableJson } from "@/lib/tofu/stable";
import type { NormalizedPlan } from "@/lib/tofu/types";
import { assertWorkspaceIntact, configDigestOf } from "@/lib/tofu/workspace";
import { builtinWorkspace, dataFragment } from "./_helpers";

describe("provider config allowlist", () => {
  it.each(["aws", "google", "azurerm", "oci", "kubernetes", "random"])("refuses unknown routing and identity arguments for %s even outside the set", (name) => {
    for (const key of ["endpoints", "http_proxy", "insecure", "assume_role", "profile", "access_token", "credentials", "auth_token", "host", "exec", "__proto__"]) {
      expect(() => builtinWorkspace("terraform.tfstate", {}, { providerConfig: { [name]: { [key]: "secret-canary" } } })).toThrow(/allowlist/);
    }
  });

  it("keeps existing non-secret cloud config and refuses unsafe nested/features/auth settings", () => {
    const providerConfig = {
      google: { project: "acme-prod", region: "us-central1" },
      azurerm: { subscription_id: "11111111-2222-3333-4444-555555555555", features: {}, storage_use_azuread: true, resource_provider_registrations: "none" },
      oci: { region: "us-ashburn-1", auth: "InstancePrincipal" },
    };
    expect(() => builtinWorkspace("terraform.tfstate", {}, { providerConfig })).not.toThrow();
    for (const unsafe of [
      { azurerm: { features: { key_vault: { purge_soft_delete_on_destroy: true } } } },
      { azurerm: { storage_use_azuread: false } },
      { azurerm: { resource_provider_registrations: "all" } },
      { google: { project: { credentials: "secret-canary" } } },
      { oci: { auth: "APIKey" } },
      { oci: { auth: "SecurityToken" } },
    ]) expect(() => builtinWorkspace("terraform.tfstate", {}, { providerConfig: unsafe })).toThrow(/allowlist/);
  });

  it("rechecks provider config in serialized workspaces with matching digests", () => {
    const ws = builtinWorkspace("terraform.tfstate", {});
    const files = ws.files.map((f) => f.path === "providers.tf.json" ? { ...f, content: stableJson({ provider: { aws: { endpoints: [{ sts: "https://exfil.invalid" }] } } }) } : f);
    expect(() => assertWorkspaceIntact({ ...ws, files, configDigest: configDigestOf(files) })).toThrow(/allowlist/);
  });

  it("stable JSON preserves prototype-named ordinary data keys", () => {
    const data = JSON.parse('{"__proto__":{"x":1},"constructor":2}');
    expect(JSON.parse(stableJson(data))).toEqual(data);
    const ws = builtinWorkspace("terraform.tfstate", { ["__proto__"]: dataFragment("a", data) });
    expect(ws.addressMap["__proto__"]).toEqual(["terraform_data.a"]);
    const main = JSON.parse(ws.files.find((f) => f.path === "main.tf.json")!.content);
    expect(main.resource.terraform_data.a.input).toEqual(data);
    expect(() => assertWorkspaceIntact(ws)).not.toThrow();
  });
});

const CONTRACTS: [SessionEnvProvider, Record<string, string>][] = [
  ["aws", { AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "canary-secret", AWS_SESSION_TOKEN: "canary-token", AWS_REGION: "ap-south-1", AWS_DEFAULT_REGION: "ap-south-1" }],
  ["gcp", { GOOGLE_OAUTH_ACCESS_TOKEN: "canary-token", GOOGLE_PROJECT: "acme-prod", GOOGLE_REGION: "us-central1" }],
  ["azure", { ARM_USE_OIDC: "true", ARM_OIDC_TOKEN: "canary-token", ARM_CLIENT_ID: "id", ARM_TENANT_ID: "id", ARM_SUBSCRIPTION_ID: "id", ARM_STORAGE_USE_AZUREAD: "true", ARM_RESOURCE_PROVIDER_REGISTRATIONS: "none" }],
  ["oci", { AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "canary-secret", OCI_RESOURCE_PRINCIPAL_VERSION: "2.2", OCI_RESOURCE_PRINCIPAL_RPST: "canary-token", OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM: "canary-key", OCI_RESOURCE_PRINCIPAL_REGION: "us-ashburn-1" }],
];

describe("session env allowlists", () => {
  it.each(CONTRACTS)("accepts the %s contract with and without explicit provider identity", (provider, env) => {
    expect(validateExtraEnv(env, "Session", provider)).toEqual(env);
    expect(validateExtraEnv(env, "Session")).toEqual(env);
  });
  it.each(CONTRACTS)("%s refuses unknown variables without echoing their values", (provider, env) => {
    for (const key of ["__proto__", "NODE_OPTIONS", "LD_PRELOAD", "AWS_ENDPOINT_URL_STS", "ARM_ACCESS_KEY", "ARM_SAS_TOKEN", "GOOGLE_CREDENTIALS", "GOOGLE_BACKEND_STORAGE_CUSTOM_ENDPOINT", "OCI_CONFIG_FILE", "HTTP_PROXY", "aws_region"]) {
      try { validateExtraEnv({ ...env, [key]: "private-canary" }, "Session", provider); throw new Error("accepted"); }
      catch (error) { expect(error).toHaveProperty("code", "tofu_env_invalid"); expect(String(error)).not.toContain("private-canary"); }
    }
  });
  it("refuses cross-provider env maps and extras outside the operator contract", () => {
    expect(() => validateExtraEnv({ AWS_REGION: "x", ARM_OIDC_TOKEN: "canary" }, "Session")).toThrow(/allowlist/);
    expect(() => validateExtraEnv({ GOOGLE_PROJECT: "x" }, "Session", "aws")).toThrow(/allowlist/);
    for (const key of ["NODE_OPTIONS", "LD_PRELOAD", "AWS_ACCESS_KEY_ID", "ARM_SAS_TOKEN", "DATABASE_URL"]) expect(() => validateExtraEnv({ [key]: "canary" }, "Runner")).toThrow(/allowlist/);
    const env = buildChildEnv({ homeDir: "/private/home", tmpDir: "/private/tmp", cliConfigFile: "/private/cli", pluginCacheDir: "/cache", sessionProvider: "gcp", sessionEnv: CONTRACTS[1][1], extraEnv: { HTTPS_PROXY: "https://operator.internal" } });
    expect(env.GOOGLE_OAUTH_ACCESS_TOKEN).toBe("canary-token");
    expect(env.HTTPS_PROXY).toBe("https://operator.internal");
  });
});

describe("model view Unicode", () => {
  it("visibly escapes invisible characters on every external string surface without changing the plan", () => {
    const text = "ad\u200Bmin\u202E\uFEFF\u{e0061}\u034f\uFE0F";
    const plan: NormalizedPlan = {
      tofuVersion: "1.12.5", formatVersion: "1.2", planDigest: "p", configDigest: "c", lockDigest: "l", createdAt: "now", empty: false,
      summary: { create: 1, update: 0, delete: 0, replace: 0, noop: 0 },
      resourceChanges: [{ address: text, nodeAddress: text, type: text, providerName: "external", action: "create", destroysData: false, changes: [{ path: text, before: null, after: text, sensitive: false, forcesReplacement: false }] }],
      outputChanges: [{ name: text, action: "create", sensitive: false }], diagnostics: [{ severity: "warning", summary: text, detail: text }],
    };
    const original = JSON.stringify(plan);
    const view = planView(plan);
    const safe = "ad\\u{200B}min\\u{202E}\\u{FEFF}\\u{E0061}\\u{34F}\\u{FE0F}";
    expect(view.resources[0]).toMatchObject({ address: safe, nodeAddress: safe, type: safe, changes: [{ path: safe, after: safe }] });
    expect(view.outputs[0].name).toBe(safe);
    expect(view.diagnostics[0]).toMatchObject({ summary: safe, detail: safe });
    expect(JSON.stringify(plan)).toBe(original);
  });
});
