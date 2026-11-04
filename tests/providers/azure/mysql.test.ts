/** Offline compilation contracts; gated validation uses the real pinned schema, never Azure. */
import { describe, expect, it } from "vitest";
import type { ResourceNode } from "@/lib/resources/types";
import type { TofuFragment } from "@/lib/drivers/types";
import { AZURE_DRIVERS } from "@/lib/providers/azure/drivers";
import { mysqlDriver } from "@/lib/providers/azure/drivers/data/mysql";
import { tfLabel } from "@/lib/providers/azure/naming";
import { assembleWorkspace, assertWorkspaceIntact } from "@/lib/tofu/workspace";
import { TofuRunner } from "@/lib/tofu/runner";
import { tofuOnPath } from "../../tofu/_helpers";
import { compileAll, compileContext, graphOf, mkNode, REGION, SUB } from "./_helpers";
import { moreGraph } from "./_more-fixtures";

function nodesForCreate(): ResourceNode[] {
  const nodes = moreGraph();
  const node = nodes.find((n) => n.address === "mysql/db")!;
  delete node.spec.createMode;
  delete node.spec.sourceServerId;
  delete node.spec.restoreTime;
  node.spec.credentials = "generated";
  return nodes;
}
function compile(patch: Record<string, unknown> = {}) {
  const nodes = nodesForCreate();
  const node = nodes.find((n) => n.address === "mysql/db")!;
  Object.assign(node.spec, patch);
  return mysqlDriver.compile!(node, compileContext(nodes));
}
const body = (f: TofuFragment, type: string) => Object.values(f.resource![type])[0];
function workspace(nodes = nodesForCreate()) {
  return assembleWorkspace({ graph: graphOf(nodes), fragments: compileAll(nodes, (n) => AZURE_DRIVERS.find((d) => d.nativeType === n.nativeType)),
    providerSet: "azure", region: REGION, backend: { kind: "local", path: "mysql.tfstate" }, tags: {},
    providerConfig: { azurerm: { subscription_id: SUB, storage_use_azuread: true, resource_provider_registrations: "none" } } });
}

describe("Azure MySQL Default creation", () => {
  it("generates only an ephemeral password and persists it only through write-only arguments", () => {
    const f = compile();
    const server = body(f, "azurerm_mysql_flexible_server");
    const stored = body(f, "azurerm_key_vault_secret");
    const label = tfLabel("mysql/db", "bootstrap");
    expect(f.resource).not.toHaveProperty("random_password");
    expect(f.data ?? {}).not.toHaveProperty("azurerm_key_vault_secret");
    expect(f.ephemeral!.random_password[label]).toMatchObject({ length: 32, min_lower: 1, min_upper: 1, min_numeric: 1, min_special: 1 });
    expect(stored).toMatchObject({ name: "password", value_wo: `\${ephemeral.random_password.${label}.result}`, value_wo_version: 1, lifecycle: { prevent_destroy: true } });
    expect(stored).not.toHaveProperty("value");
    expect(server).toMatchObject({ create_mode: "Default", administrator_login: "zenith_admin", administrator_password_wo: `\${ephemeral.azurerm_key_vault_secret.${label}.value}`, public_network_access: "Disabled", lifecycle: { prevent_destroy: true } });
    for (const key of ["administrator_password", "source_server_id", "point_in_time_restore_time_in_utc"]) expect(server).not.toHaveProperty(key);
    expect(f.addresses.some((address) => address.startsWith("ephemeral.") || address.startsWith("random_password."))).toBe(false);
  });

  it("reads back the persisted version for retries and ties the server password marker to that version", () => {
    const f = compile();
    const label = tfLabel("mysql/db", "bootstrap");
    expect(f.ephemeral!.azurerm_key_vault_secret[label]).toEqual({ name: "password", key_vault_id: "${local.mysql_db__vault_id}", version: `\${azurerm_key_vault_secret.${label}.version}` });
    expect(body(f, "azurerm_mysql_flexible_server").administrator_password_wo_version).toBe(`\${parseint(substr(sha256(azurerm_key_vault_secret.${label}.version), 0, 12), 16) + 1}`);
    // No-op operations do not rotate value_wo_version. A partial create reads
    // the already stored version instead of the new random_password result.
    expect(compile()).toEqual(f);
    expect(JSON.stringify(f.locals)).not.toMatch(/ephemeral\.|\.value|\.result/);
    expect(f.output).toBeUndefined();
  });

  it("reuses protected, per-resource vaults without sharing a name with an environment secret", () => {
    const nodes = nodesForCreate();
    const mysql = nodes.find((n) => n.address === "mysql/db")!;
    const secret = mkNode("secret/db", "secret", "azure:key_vault_secret", { secretRef: "vault:ws_1/env_azure_1/DB", store: "zenith_vault", purpose: "environment" });
    nodes.push(secret);
    const ctx = compileContext(nodes);
    const f = mysqlDriver.compile!(mysql, ctx);
    const s = AZURE_DRIVERS.find((d) => d.nativeType === secret.nativeType)!.compile!(secret, ctx);
    expect(body(f, "azurerm_key_vault").name).not.toBe(body(s, "azurerm_key_vault").name);
    expect(body(f, "azurerm_key_vault")).toMatchObject({ rbac_authorization_enabled: true, purge_protection_enabled: true, soft_delete_retention_days: 90, tags: { "zenith:workspace": "ws_1", "zenith:environment": "env_azure_1", "zenith:resource": "mysql/db" } });
    expect(f.locals!.mysql_db__secret_uri).toMatch(/secrets\/password$/);
    expect(nodes.filter((n) => n.kind === "secret").some((n) => n.address === mysql.address)).toBe(false);
  });

  it("preserves private networking, HA, backups, Entra-only auth and TLS", () => {
    const f = compile();
    expect(body(f, "azurerm_mysql_flexible_server")).toMatchObject({ version: "8.0.21", high_availability: { mode: "ZoneRedundant" }, backup_retention_days: 14, delegated_subnet_id: "${local.subnet_mysql__id}" });
    expect(Object.values(f.resource!.azurerm_mysql_flexible_server_configuration).map((b) => [b.name, b.value])).toEqual([["aad_auth_only", "ON"], ["require_secure_transport", "ON"]]);
  });

  it("assembles the full graph and rechecks serialized ephemeral references", () => {
    const ws = workspace();
    expect(() => assertWorkspaceIntact(ws)).not.toThrow();
    const main = JSON.parse(ws.files.find((f) => f.path === "main.tf.json")!.content);
    expect(main.ephemeral).toHaveProperty("random_password");
    expect(ws.addressMap["mysql/db"]).toContain("azurerm_key_vault_secret.mysql_db_bootstrap");
    expect(ws.addressMap["mysql/db"]).not.toContain("ephemeral.random_password.mysql_db_bootstrap");
  });

  it("does not mutate graph input or generate values while compiling", () => {
    const nodes = nodesForCreate();
    const before = structuredClone(nodes);
    const mysql = nodes.find((n) => n.address === "mysql/db")!;
    expect(mysqlDriver.compile!(mysql, compileContext(nodes))).toEqual(mysqlDriver.compile!(mysql, compileContext(nodes)));
    expect(nodes).toEqual(before);
  });

  it.each(["referenced", "external"] as const)("emits nothing for %s MySQL", (ownership) => {
    const nodes = nodesForCreate();
    const node = { ...nodes.find((n) => n.address === "mysql/db")!, ownership };
    expect(mysqlDriver.compile!(node, compileContext(nodes))).toEqual({ addresses: [] });
  });

  it.each(["PointInTimeRestore", "Replica"])("preserves the password-free %s path", (createMode) => {
    const nodes = moreGraph();
    const node = nodes.find((n) => n.address === "mysql/db")!;
    Object.assign(node.spec, { createMode, highAvailability: false });
    const f = mysqlDriver.compile!(node, compileContext(nodes));
    expect(f.ephemeral).toBeUndefined();
    expect(JSON.stringify(f)).not.toMatch(/password|azurerm_key_vault/);
  });

  it.each([
    { createMode: "unknown" }, { sourceServerId: "synthetic" }, { restoreTime: "2026-09-30T12:00:00Z" },
    { credentials: "inline" }, { size: "constructor" }, { subnet: "subnet/private-a" },
    { entraAdministratorId: "bad" }, { highAvailability: true, instanceClass: "B_Standard_B1ms" },
  ])("refuses invalid create input (%j)", (patch) => {
    expect(() => compile(patch)).toThrow();
  });

  it.each(["administrator_password", "adminPassword", "config"])("rejects inline credentials without reflecting them (%s)", (key) => {
    const marker = "SYNTHETIC_SECRET_MARKER";
    const patch = { [key]: key === "config" ? { password: marker } : marker };
    try { compile(patch); throw new Error("accepted"); }
    catch (error) { expect((error as Error).message).toMatch(/inline credentials/); expect((error as Error).message).not.toContain(marker); }
  });
});

describe.skipIf(process.env.ZENITH_TEST_TOFU_NETWORK !== "1" || !tofuOnPath())("Azure MySQL real pinned tofu validate (network, no Azure account)", () => {
  it.each([true, false])("accepts write-only bootstrap storage, ephemeral readback and HA=%s", async (highAvailability) => {
    const nodes = nodesForCreate();
    Object.assign(nodes.find((n) => n.address === "mysql/db")!.spec, { highAvailability });
    await new TofuRunner({ limits: { timeoutMs: 600_000 } }).run(workspace(nodes), {}, async (run) => {
      await run.init({ backend: false });
      const validated = await run.validate();
      expect(validated.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(validated.valid).toBe(true);
    });
  }, 900_000);
});
