/**
 * The customer bootstrap module (deploy/azure). Static assertions always run;
 * `tofu validate` against the real azurerm schema is gated like the rest
 * (ZENITH_TEST_TOFU_NETWORK=1). Nothing here applies anything to Azure.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTofuBinary } from "@/lib/tofu/binary";
import { buildChildEnv } from "@/lib/tofu/env";
import { BUILTIN_ROLE_IDS } from "@/lib/providers/azure/drivers/identity/identity";
import { FEDERATION_AUDIENCE } from "@/lib/providers/azure/credentials";
import { FORBIDDEN_ROLE_NAMES } from "@/lib/providers/azure/platform";

const MODULE = path.resolve(__dirname, "../../../deploy/azure");
const read = (f: string) => readFileSync(path.join(MODULE, f), "utf8");
const main = read("main.tf");
/** the module's HCL without comments and description strings, so prose cannot trip (or hide from) the checks */
const code = (text: string) =>
  text
    .split("\n")
    .filter((l) => !/^\s*(#|\/\*|\*)/.test(l) && !/^\s*description\s*=/.test(l))
    .join("\n");
const all = code(readdirSync(MODULE).filter((f) => f.endsWith(".tf")).map(read).join("\n"));

describe("deploy/azure bootstrap module (static)", () => {
  it("additional providers have explicit lifecycle actions and never add credential listing or broad roles", () => {
    for (const provider of ["Microsoft.Compute", "Microsoft.Web", "Microsoft.ContainerService", "Microsoft.DBforMySQL"]) expect(main).toContain(`"${provider}",`);
    for (const type of ["Microsoft.Compute/virtualMachines", "Microsoft.Compute/disks", "Microsoft.ContainerService/managedClusters", "Microsoft.Web/sites", "Microsoft.Web/staticSites", "Microsoft.DBforMySQL/flexibleServers", "Microsoft.Resources/deployments"]) {
      for (const verb of ["read", "write", "delete"]) expect(main).toContain(`"${type}/${verb}"`);
      expect(main).not.toContain(`"${type}/*"`);
    }
    const actions = main.slice(main.indexOf("actions = ["), main.indexOf("not_actions"));
    expect(actions).not.toMatch(/listSecrets|listClusterUserCredential|listClusterAdminCredential|sites\/(publishingCredentials|publishxml)\/action|config\/list\/action|runCommand\/action/i);
    expect(main).toContain('"b7e6dc6d-f1e8-4753-8033-0f276bb0955b"');
    expect(main).toContain('"974c5e8b-45b9-4653-ba55-5f855dd0fb88"');
  });
  it("trusts exactly Zenith's issuer, the exchange audience and an exact per-connection subject", () => {
    expect(main).toContain(`token_audience     = "${FEDERATION_AUDIENCE}"`);
    expect(main).toContain('observe_subject = "zenith:ws:${var.workspace_id}:conn:${var.observe_connection_id}"');
    expect(main).toContain('deploy_subject  = "zenith:ws:${var.workspace_id}:conn:${var.deploy_connection_id}"');
    expect(main.match(/resource "azurerm_federated_identity_credential"/g)).toHaveLength(2);
    expect(main.match(/issuer\s+= var\.zenith_issuer/g)).toHaveLength(2);
    expect(main.match(/audience\s+= \[local\.token_audience\]/g)).toHaveLength(2);
    // a wildcard subject or a shared subject would let one connection mint the other's token
    expect(main).not.toMatch(/subject\s*=\s*"[^"]*\*/);
    expect(read("variables.tf")).toContain("deploy_connection_id must differ from observe_connection_id");
  });

  it("uses managed identities: no app registration, secret, password or certificate anywhere", () => {
    expect(all).not.toMatch(/azuread_/);
    expect(all).not.toMatch(/client_secret|password|azurerm_key_vault_certificate|sas_token|primary_access_key|connection_string|azurerm_key_vault_secret/i);
    expect(all).toContain("azurerm_user_assigned_identity");
  });

  it("the deploy identity is neither Owner nor Contributor; the observe identity is read-only", () => {
    for (const name of FORBIDDEN_ROLE_NAMES.filter((n) => n !== "Role Based Access Control Administrator")) {
      expect(main, name).not.toMatch(new RegExp(`role_definition_name\\s*=\\s*"${name}"`));
      expect(main, name).not.toMatch(new RegExp(`"${name}"\\s*,`));
    }
    expect(main).toContain('toset(["Reader", "Monitoring Reader", "Log Analytics Reader", "Key Vault Reader"])');
    // the custom role has no `*` action and no wildcard-everything
    const actions = main.slice(main.indexOf("actions = ["), main.indexOf("not_actions"));
    expect(actions).not.toMatch(/"\*"/);
    expect(actions).not.toMatch(/"Microsoft\.Authorization\/\*"/);
    expect(actions).not.toMatch(/roleAssignments\/write|roleDefinitions/);
    for (const key of ["listKeys", "regenerateKey", "listAccountSas", "listCredentials"]) expect(main).toContain(key);
  });

  it("role assignments written by the deploy identity are limited to exactly the data roles the identity driver can produce", () => {
    const listed = [...main.matchAll(/"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",?\s*#/g)].map((m) => m[1]).sort();
    expect(listed).toEqual(Object.keys(BUILTIN_ROLE_IDS).sort());
    expect(main).toContain('role_definition_name = "Role Based Access Control Administrator"');
    expect(main).toContain('condition_version    = "2.0"');
    expect(main).toContain("ForAnyOfAnyValues:GuidEquals");
    expect(main).toContain("StringEqualsIgnoreCase 'ServicePrincipal'");
  });

  it("state storage is Entra-only, versioned, locked, and only the deploy identity may use it, on the container", () => {
    expect(main).toMatch(/shared_access_key_enabled\s+= false/);
    expect(main).toMatch(/min_tls_version\s+= "TLS1_2"/);
    expect(main).toMatch(/allow_nested_items_to_be_public\s+= false/);
    expect(main).toMatch(/versioning_enabled\s+= true/);
    expect(main).toContain('lock_level = "CanNotDelete"');
    expect(main).toMatch(/scope\s+= azurerm_storage_container\.state\.id/);
  });

  it("outputs are identifiers only", () => {
    const outputs = code(read("outputs.tf"));
    expect(outputs).not.toMatch(/sensitive|secret|token|access_key|primary_key|connection_string/i);
    for (const name of ["observe_client_id", "deploy_client_id", "tenant_id", "state_storage_account", "zenith_observe_connection", "zenith_deploy_connection"]) expect(outputs).toContain(`output "${name}"`);
    // the connection objects match AzureConnectionConfig
    expect(outputs).toContain('mode           = "oidc_web_identity"');
  });

  it("documents the subscription-scope trade-off and the unverified parts", () => {
    const readme = read("README.md");
    expect(readme).toMatch(/subscription scope/i);
    expect(readme).toMatch(/Not applied to a real\s+subscription/i);
  });
});

const enabled = process.env.ZENITH_TEST_TOFU_NETWORK === "1" && (() => { try { resolveTofuBinary(); return true; } catch { return false; } })();

describe.skipIf(!enabled)("deploy/azure validates against the real azurerm 5.7.0 schema (network)", () => {
  it(
    "tofu init (azurerm pinned to 5.7.0) and tofu validate succeed",
    () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "zenith-azure-deploy-"));
      try {
        for (const f of readdirSync(MODULE).filter((x) => x.endsWith(".tf"))) copyFileSync(path.join(MODULE, f), path.join(dir, f));
        // the module allows any 5.x >= 5.7.0; validate against exactly the version Zenith pins and locks
        writeFileSync(path.join(dir, "versions.tf"), readFileSync(path.join(dir, "versions.tf"), "utf8").replace(/version = ">= 5\.7\.0, < 6\.0\.0"/, 'version = "5.7.0"'));
        copyFileSync(path.resolve(__dirname, "../../../src/lib/tofu/locks/azure.terraform.lock.hcl"), path.join(dir, ".terraform.lock.hcl"));
        writeFileSync(path.join(dir, "provider.tf"), 'provider "azurerm" {\n  features {}\n  subscription_id = "11111111-2222-3333-4444-555555555555"\n  resource_provider_registrations = "none"\n  storage_use_azuread = true\n}\n');
        const home = path.join(dir, "home");
        mkdirSync(home);
        const cli = path.join(dir, "cli.tfrc");
        writeFileSync(cli, "");
        const env = buildChildEnv({ homeDir: home, tmpDir: home, cliConfigFile: cli, pluginCacheDir: process.env.ZENITH_TOFU_PLUGIN_CACHE ?? path.join(os.tmpdir(), "zenith-tofu-plugin-cache") }) as NodeJS.ProcessEnv;
        const tofu = resolveTofuBinary();
        const init = spawnSync(tofu, ["init", "-backend=false", "-input=false", "-no-color"], { cwd: dir, env, encoding: "utf8" });
        expect(init.status, init.stdout + init.stderr).toBe(0);
        const validate = spawnSync(tofu, ["validate", "-json", "-no-color"], { cwd: dir, env, encoding: "utf8" });
        const result = JSON.parse(validate.stdout) as { valid: boolean; diagnostics: { summary: string }[] };
        expect(result.diagnostics.map((d) => d.summary)).toEqual([]);
        expect(result.valid).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      }
    },
    900_000
  );
});
