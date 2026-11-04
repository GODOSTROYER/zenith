/**
 * Private, Entra-only MySQL Flexible Server; passwords never enter tofu state.
 * Default creation generates an ephemeral bootstrap password, stores it in
 * a dedicated Key Vault via value_wo, and reads it ephemerally for MySQL's
 * administrator_password_wo. Restore/Replica paths remain password-free.
 * Real cloud apply is unverified. Replicas cannot have HA. A customer UAI
 * with Graph directory-reading permissions must be prepared outside Zenith;
 * no directory-wide permissions are granted by the deployer.
 * Backups map like PostgreSQL (Azure PITR, not a scheduled snapshot promise).
 * Workload database roles are an external SQL step, not Azure role grants.
 * No password/configuration value is ever copied into the observation bag.
 */
import type { ResourceNode } from "@/lib/resources/types";
import { block, configBool, fragment, mergeBlocks, resolveNetwork } from "@/lib/providers/azure/compile-util";
import { exportLocals, exportRef } from "@/lib/providers/azure/exports";
import { azureTags, cloudName, tfLabel } from "@/lib/providers/azure/naming";
import { azureCloud } from "@/lib/providers/azure/cloud";
import { defineAzureDriver, locateByTags, props, pick, unknownRead, locatedFromError, type UnknownRead } from "@/lib/providers/azure/kit";
import { armClient, type ArmResource } from "@/lib/providers/azure/arm";
import { deletionLock, protectFromDestroy } from "@/lib/providers/azure/drivers/data/private-endpoint";
import { armIdSpec, boolSpec, integerSpec, invalid, privateSubnet, readNumber, readString, rejectCredentials, textSpec } from "@/lib/providers/azure/drivers/more-util";
import { mysqlBootstrap } from "@/lib/providers/azure/drivers/data/mysql-bootstrap";

export const MYSQL = { type: "Microsoft.DBforMySQL/flexibleServers", apiVersion: "2023-12-30" } as const;
const SKUS: Record<string, string> = { nano: "B_Standard_B1ms", small: "B_Standard_B2s", standard: "GP_Standard_D2ds_v4", performance: "GP_Standard_D4ds_v4" };
const STORAGE: Record<string, number> = { nano: 32, small: 32, standard: 64, performance: 128 };

function settings(node: ResourceNode) {
  const size = textSpec(node, "size", "small");
  if (!Object.hasOwn(SKUS, size)) invalid(node, "unsupported MySQL size.");
  const sku = textSpec(node, "instanceClass", SKUS[size]);
  if (!/^(B|GP|MO)_Standard_[A-Za-z0-9_]+$/.test(sku)) invalid(node, "invalid MySQL instanceClass.");
  const version = textSpec(node, "version", "8.0.21");
  if (!["8.0", "8.0.21", "8.4"].includes(version)) invalid(node, "only MySQL 8.0 or 8.4 is supported.");
  const backup = textSpec(node, "backup", "daily");
  if (!["none", "daily", "hourly"].includes(backup)) invalid(node, "invalid MySQL backup mapping.");
  const highAvailability = boolSpec(node, "highAvailability", false);
  if (highAvailability && sku.startsWith("B_")) invalid(node, "burstable MySQL SKUs cannot provide HA.");
  const deletionPolicy = textSpec(node, "deletionPolicy", "deny");
  if (!["deny", "approval", "allow"].includes(deletionPolicy)) invalid(node, "invalid MySQL deletionPolicy.");
  return { sku, version: version === "8.0" ? "8.0.21" : version, storageGb: integerSpec(node, "storageGb", STORAGE[size], 20, 16384), highAvailability, deletionPolicy, retentionDays: backup === "hourly" ? 35 : backup === "daily" ? 14 : 7, geo: configBool(node, "geoRedundantBackup") ?? backup === "hourly" };
}

export const mysqlDriver = defineAzureDriver({
  id: "azure.mysql_flexible_server@1", kind: "mysql", nativeType: "azure:mysql_flexible_server", arm: MYSQL,
  compile: (node, ctx) => {
    if (node.ownership !== "managed") return fragment({});
    rejectCredentials(node);
    if (node.spec.engine !== undefined && node.spec.engine !== "mysql") invalid(node, "engine must be mysql.");
    const spec = settings(node);
    const mode = textSpec(node, "createMode", "Default");
    if (!["Default", "PointInTimeRestore", "Replica"].includes(mode)) invalid(node, "invalid MySQL createMode.");
    if (node.spec.credentials !== undefined && node.spec.credentials !== "generated") invalid(node, "MySQL credentials must be generated.");
    if (mode === "Default" && (node.spec.sourceServerId !== undefined || node.spec.restoreTime !== undefined)) invalid(node, "Default MySQL creation cannot use sourceServerId or restoreTime.");
    if (mode === "Replica" && spec.highAvailability) invalid(node, "MySQL read replicas do not support HA.");
    const source = mode === "Default" ? undefined : armIdSpec(node, "sourceServerId", MYSQL.type);
    const identity = armIdSpec(node, "entraIdentityId", "Microsoft.ManagedIdentity/userAssignedIdentities");
    const admin = textSpec(node, "entraAdministratorId");
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(admin)) invalid(node, "entraAdministratorId must be a principal UUID.");
    const login = textSpec(node, "entraAdministratorLogin");
    if (!/^[A-Za-z0-9_.@-]{1,128}$/.test(login)) invalid(node, "invalid Entra administrator login.");
    const restore = mode === "PointInTimeRestore" ? textSpec(node, "restoreTime") : undefined;
    if (restore !== undefined && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(restore) || !Number.isFinite(Date.parse(restore)))) invalid(node, "restoreTime must be a UTC timestamp.");
    const subnet = privateSubnet(node, ctx, "mysql");
    const net = resolveNetwork(subnet, ctx);
    const L = (p: string) => tfLabel(node.address, p);
    const srv = `azurerm_mysql_flexible_server.${L("srv")}`;
    const dns = `azurerm_private_dns_zone.${L("dns")}`;
    const tags = azureTags(ctx, node);
    const common = { resource_group_name: exportRef(net, "rg_name"), tags };
    const bootstrap = mode === "Default" ? mysqlBootstrap(node, ctx) : undefined;
    const result = fragment({ resource: mergeBlocks(
      bootstrap?.resource ?? {},
      block("azurerm_private_dns_zone", L("dns"), { ...common, name: `${cloudName(ctx, node.address, { max: 50, suffix: "private" })}.${azureCloud(ctx.azureCloud).privateZones.mysql}` }),
      block("azurerm_private_dns_zone_virtual_network_link", L("dns_link"), { name: "mysql", private_dns_zone_id: `\${${dns}.id}`, virtual_network_id: exportRef(net, "vnet_id"), registration_enabled: false, tags }),
      block("azurerm_mysql_flexible_server", L("srv"), {
        ...common, location: node.region, name: cloudName(ctx, node.address, { max: 63, suffix: "mysql" }),
        create_mode: mode, ...(source ? { source_server_id: source } : {}), ...(restore ? { point_in_time_restore_time_in_utc: restore } : {}),
        ...bootstrap?.server,
        sku_name: spec.sku, version: spec.version, storage: { size_gb: spec.storageGb, auto_grow_enabled: true },
        public_network_access: "Disabled", delegated_subnet_id: exportRef(subnet.address, "id"), private_dns_zone_id: `\${${dns}.id}`,
        backup_retention_days: spec.retentionDays, geo_redundant_backup_enabled: spec.geo,
        identity: { type: "UserAssigned", identity_ids: [identity] },
        ...(spec.highAvailability ? { zone: "1", high_availability: { mode: "ZoneRedundant", standby_availability_zone: "2" } } : {}),
        depends_on: [`azurerm_private_dns_zone_virtual_network_link.${L("dns_link")}`],
        lifecycle: { prevent_destroy: protectFromDestroy(spec.deletionPolicy), ignore_changes: ["zone", "high_availability[0].standby_availability_zone"] },
      }),
      block("azurerm_mysql_flexible_server_active_directory_administrator", L("aad"), { server_id: `\${${srv}.id}`, identity_id: identity, login, object_id: admin, tenant_id: exportRef(net, "tenant_id") }),
      ...[{ name: "aad_auth_only", value: "ON" }, { name: "require_secure_transport", value: "ON" }].map((c) => block("azurerm_mysql_flexible_server_configuration", L(c.name), { name: c.name, resource_group_name: exportRef(net, "rg_name"), server_name: `\${${srv}.name}`, value: c.value, depends_on: [`azurerm_mysql_flexible_server_active_directory_administrator.${L("aad")}`] })),
      deletionLock(node, `\${${srv}.id}`, spec.deletionPolicy)
    ), locals: { ...bootstrap?.locals, ...exportLocals(node.address, { id: `\${${srv}.id}`, name: `\${${srv}.name}`, fqdn: `\${${srv}.fqdn}` }) } });
    if (bootstrap) result.ephemeral = bootstrap.ephemeral;
    return result;
  },
  locate: async (ctx, node, externalId) => {
    const found = await locateByTags(ctx, node, MYSQL, externalId);
    if (found.state !== "found") return found;
    const arm = armClient(ctx.session, ctx.signal);
    const extra: Record<string, unknown> = {};
    for (const [key, path] of [["entraOnly", "configurations/aad_auth_only"], ["tlsRequired", "configurations/require_secure_transport"], ["entraAdministratorConfigured", "administrators/ActiveDirectory"]]) {
      try {
        const child = (await arm.get<ArmResource>(`${found.resource.id}/${path}`, { apiVersion: MYSQL.apiVersion })).body;
        const raw = typeof props(child).value === "string" ? String(props(child).value).toUpperCase() : undefined;
        const value = path.startsWith("administrators") ? typeof props(child).sid === "string" ? true : undefined : raw === "ON" ? true : raw === "OFF" ? false : undefined;
        extra[key] = value;
      } catch (e) {
        const failure = locatedFromError(e, true);
        extra[key] = unknownRead(failure.state === "inaccessible" ? "access_denied" : failure.state === "missing" ? "not_inspected" : "error");
      }
    }
    return { state: "found", resource: { ...found.resource, properties: { ...props(found.resource), zenithAuth: extra } } as ArmResource };
  },
  expected: (node) => { const s = settings(node); return { version: s.version, sku: s.sku.replace(/^(B|GP|MO)_/, ""), storageGb: s.storageGb, highAvailability: s.highAvailability, backupRetentionDays: s.retentionDays, geoRedundantBackup: s.geo, publicNetworkAccess: "Disabled", entraOnly: true, tlsRequired: true, entraAdministratorConfigured: true }; },
  read: (res) => {
    const mode = readString(pick(props(res), "highAvailability", "mode"));
    const geo = readString(pick(props(res), "backup", "geoRedundantBackup"));
    const auth = pick<Record<string, boolean | UnknownRead>>(props(res), "zenithAuth") ?? {};
    return { version: readString(props(res).version), sku: readString(res.sku?.name), storageGb: readNumber(pick(props(res), "storage", "storageSizeGB")), highAvailability: mode === "Disabled" ? false : mode === "ZoneRedundant" || mode === "SameZone" ? true : undefined, backupRetentionDays: readNumber(pick(props(res), "backup", "backupRetentionDays")), geoRedundantBackup: geo === "Enabled" ? true : geo === "Disabled" ? false : undefined, publicNetworkAccess: readString(pick(props(res), "network", "publicNetworkAccess")), entraOnly: auth.entraOnly, tlsRequired: auth.tlsRequired, entraAdministratorConfigured: auth.entraAdministratorConfigured };
  },
  runtime: async (_ctx, node, res) => {
    const state = props(res).state;
    const ha = readString(pick(props(res), "highAvailability", "state"));
    const health = state === "Ready" ? settings(node).highAvailability ? ha === undefined ? "unknown" : ha === "Healthy" ? "healthy" : "degraded" : "healthy" : state === "Stopped" || state === "Disabled" ? "unhealthy" : "unknown";
    return { health, counts: {}, signals: ["database_query_not_inspected", ...(settings(node).highAvailability && ha === undefined ? ["ha_health_not_inspected"] : [])] };
  },
  serving: true,
  native: (res) => ({ state: props(res).state, provisioningState: props(res).provisioningState }),
});
