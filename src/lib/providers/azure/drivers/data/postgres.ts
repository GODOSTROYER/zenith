/**
 * `azure:postgresql_flexible_server` — portable `postgres` on Azure Database
 * for PostgreSQL flexible server. (`mysql` has its own native type,
 * `azure:mysql_flexible_server`, which is not implemented.)
 *
 * Security posture, all compile-time and all asserted by tests:
 *   - PRIVATE ONLY: VNet-integrated in the dedicated delegated subnet, private
 *     DNS zone from the landing zone, `public_network_access_enabled = false`.
 *   - ENTRA ID ONLY: `active_directory_auth_enabled = true`,
 *     `password_auth_enabled = false`. There is NO administrator login or
 *     password anywhere — not in config, not in plan, not in state. (The
 *     portable `credentials: "generated"` is realized as "no password exists":
 *     workloads authenticate with their managed identity.) The deploy
 *     principal is registered as the Entra administrator so someone can create
 *     database roles for workload identities (`pgaadauth_create_principal`);
 *     doing that is a data-plane SQL step this driver does NOT perform, so a
 *     workload's `read_credentials` grant produces no Azure role assignment.
 *     Unverified live: Azure's validation of `principal_name` for a service
 *     principal administrator.
 *   - HA: `highAvailability` → ZoneRedundant (primary zone 1, standby zone 2;
 *     zones are ignored by plans afterwards because a failover swaps them).
 *     Burstable SKUs do not support HA: compile refuses rather than silently
 *     changing the price class (set `instanceClass` or a larger size).
 *   - Backups: Azure backups cannot be switched off. `none` → 7 days (the
 *     minimum), `daily` → 14, `hourly` → 35 with geo-redundant backup (point in
 *     time recovery is continuous either way). `config.geoRedundantBackup`
 *     (boolean) overrides geo-redundancy; it cannot change after creation.
 *   - Deletion: `prevent_destroy` and an Azure `CanNotDelete` lock unless
 *     `deletionPolicy === "allow"`. There is no final snapshot on delete (Azure
 *     offers none); on-demand backups are the `database.snapshot` operation.
 *   - Encryption at rest is always on (service-managed keys).
 *
 * Day two: `database.snapshot` → on-demand backup named from the operation id
 * (idempotent: the same operation id yields the same backup name).
 */
import type { AzureSession } from "@/lib/credentials/types";
import type { CompileContext, NativeOperation, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { PostgresSpec } from "@/lib/resources/specs";
import { AzureCompileError, block, configBool, fragment, mergeBlocks, resolveNetwork, specOf } from "@/lib/providers/azure/compile-util";
import { exportLocals, exportRef } from "@/lib/providers/azure/exports";
import { defineAzureDriver, locateByTags, pick, props, type RuntimeRead } from "@/lib/providers/azure/kit";
import { armClient, ArmError, pollOperation, type ArmClient, type ArmResource } from "@/lib/providers/azure/arm";
import { azureTags, cloudName, tfLabel } from "@/lib/providers/azure/naming";
import { API, POSTGRES_SKU_BY_SIZE, POSTGRES_STORAGE_MB_BY_SIZE } from "@/lib/providers/azure/platform";
import { clientRequestId, notManagedHere, opFailure, opFailureFromError } from "@/lib/providers/azure/ops";

export const POSTGRES = { type: "Microsoft.DBforPostgreSQL/flexibleServers", apiVersion: API.postgres } as const;

const SUPPORTED_VERSIONS = new Set(["13", "14", "15", "16", "17"]);

export function postgresSku(spec: PostgresSpec): string {
  return spec.instanceClass ?? POSTGRES_SKU_BY_SIZE[spec.size] ?? POSTGRES_SKU_BY_SIZE.small;
}

export function backupPlan(spec: PostgresSpec, geoOverride: boolean | undefined): { retentionDays: number; geoRedundant: boolean } {
  const retentionDays = spec.backup === "hourly" ? 35 : spec.backup === "daily" ? 14 : 7;
  return { retentionDays, geoRedundant: geoOverride ?? spec.backup === "hourly" };
}

export function compilePostgres(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const spec = specOf<PostgresSpec>(node);
  const a = node.address;
  if (spec.engine !== "postgres") throw new AzureCompileError(`engine "${String(spec.engine)}" is not PostgreSQL.`, a);
  if (!SUPPORTED_VERSIONS.has(String(spec.version))) throw new AzureCompileError(`PostgreSQL version "${String(spec.version)}" is not offered by flexible server (13–17).`, a);
  const net = resolveNetwork(node, ctx);
  const sku = postgresSku(spec);
  if (spec.highAvailability && sku.startsWith("B_")) {
    throw new AzureCompileError(`zone-redundant HA is not available on the burstable SKU ${sku}; pick a larger size or set instanceClass to a General Purpose SKU.`, a);
  }
  const backup = backupPlan(spec, configBool(node, "geoRedundantBackup"));
  const L = (part: string) => tfLabel(a, part);
  const tags = azureTags(ctx, node);
  const protect = spec.deletionPolicy !== "allow";
  const srv = `azurerm_postgresql_flexible_server.${L("srv")}`;
  const rg = exportRef(net, "rg_name");

  const resource = mergeBlocks(
    block("azurerm_postgresql_flexible_server", L("srv"), {
      name: cloudName(ctx, a, { max: 63, suffix: "pg" }),
      resource_group_name: rg,
      location: node.region,
      version: String(spec.version),
      sku_name: sku,
      storage_mb: POSTGRES_STORAGE_MB_BY_SIZE[spec.size] ?? POSTGRES_STORAGE_MB_BY_SIZE.small,
      auto_grow_enabled: true,
      delegated_subnet_id: exportRef(net, "snet_pg_id"),
      private_dns_zone_id: exportRef(net, "dns_pg_id"),
      public_network_access_enabled: false,
      authentication: { active_directory_auth_enabled: true, password_auth_enabled: false, tenant_id: exportRef(net, "tenant_id") },
      backup_retention_days: backup.retentionDays,
      geo_redundant_backup_enabled: backup.geoRedundant,
      ...(spec.highAvailability ? { zone: "1", high_availability: { mode: "ZoneRedundant", standby_availability_zone: "2" } } : {}),
      tags,
      lifecycle: {
        prevent_destroy: protect,
        // a failover swaps primary and standby zones; that is not drift to repair
        ignore_changes: ["zone", "high_availability[0].standby_availability_zone"],
      },
    }),
    block("azurerm_postgresql_flexible_server_active_directory_administrator", L("aad"), {
      server_name: `\${${srv}.name}`,
      resource_group_name: rg,
      tenant_id: exportRef(net, "tenant_id"),
      object_id: exportRef(net, "object_id"),
      principal_name: "zenith-deploy",
      principal_type: "ServicePrincipal",
    }),
    protect
      ? block("azurerm_management_lock", L("lock"), { name: "zenith-protect", scope: `\${${srv}.id}`, lock_level: "CanNotDelete", notes: "Zenith: deletionPolicy is not allow" })
      : {}
  );
  return fragment({
    resource,
    locals: exportLocals(a, { id: `\${${srv}.id}`, name: `\${${srv}.name}`, fqdn: `\${${srv}.fqdn}` }),
  });
}

/* --------------------------------- observe ---------------------------------- */

export function expectedPostgres(node: ResourceNode): Record<string, unknown> {
  const spec = specOf<PostgresSpec>(node);
  const backup = backupPlan(spec, configBool(node, "geoRedundantBackup"));
  return {
    version: String(spec.version),
    sku: postgresSku(spec),
    storageMb: POSTGRES_STORAGE_MB_BY_SIZE[spec.size] ?? POSTGRES_STORAGE_MB_BY_SIZE.small,
    highAvailability: Boolean(spec.highAvailability),
    backupRetentionDays: backup.retentionDays,
    geoRedundantBackup: backup.geoRedundant,
    publicNetworkAccess: "Disabled",
    passwordAuth: "Disabled",
    entraAuth: "Enabled",
  };
}

function readPostgres(res: ArmResource): Record<string, unknown> {
  const p = props(res);
  const gb = pick<number>(p, "storage", "storageSizeGB");
  const mode = pick<string>(p, "highAvailability", "mode");
  return {
    version: pick<string>(p, "version"),
    sku: pick<string>(res.sku, "name"),
    storageMb: typeof gb === "number" ? gb * 1024 : undefined,
    highAvailability: mode === undefined ? undefined : mode !== "Disabled",
    backupRetentionDays: pick<number>(p, "backup", "backupRetentionDays"),
    geoRedundantBackup: pick<string>(p, "backup", "geoRedundantBackup") === undefined ? undefined : pick<string>(p, "backup", "geoRedundantBackup") === "Enabled",
    publicNetworkAccess: pick<string>(p, "network", "publicNetworkAccess"),
    passwordAuth: pick<string>(p, "authConfig", "passwordAuth"),
    entraAuth: pick<string>(p, "authConfig", "activeDirectoryAuth"),
  };
}

async function runtimePostgres(_ctx: unknown, _node: ResourceNode, res: ArmResource, _arm: ArmClient): Promise<RuntimeRead> {
  const p = props(res);
  const state = pick<string>(p, "state") ?? "Unknown";
  const ha = pick<string>(p, "highAvailability", "state");
  const signals = [`state:${state}`];
  if (ha && ha !== "NotEnabled" && ha !== "Healthy") signals.push(`ha:${ha}`);
  let health: RuntimeRead["health"];
  if (state === "Ready") health = ha && ha !== "NotEnabled" && ha !== "Healthy" ? "degraded" : "healthy";
  else if (["Updating", "Starting", "Stopping", "Restarting", "Provisioning"].includes(state)) health = "degraded";
  else if (["Stopped", "Disabled", "Dropping", "Dropped"].includes(state)) health = "unhealthy";
  else health = "unknown";
  return { health, counts: {}, signals };
}

/* ------------------------------- day-two ops -------------------------------- */

const snapshot: NativeOperation<AzureSession> = async (ctx, node, input) => {
  const arm = armClient(ctx.session, ctx.signal);
  try {
    const found = await locateByTags(ctx, node, POSTGRES, typeof input.externalId === "string" ? input.externalId : undefined);
    if (found.state !== "found") return opFailure(`Cannot snapshot ${node.address}: ${found.state}.`);
    const refused = notManagedHere(ctx, node, found.resource);
    if (refused) return opFailure(`Refusing to snapshot ${node.address}: ${refused}.`);
    const suffix = (ctx.operationId ?? `t${ctx.now().getTime()}`).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "manual";
    const name = `zenith-${suffix}`;
    try {
      const r = await arm.put(`${found.resource.id}/backups/${name}`, { apiVersion: API.postgres, body: {}, headers: { "x-ms-client-request-id": clientRequestId(ctx) } });
      const outcome = await pollOperation(ctx.session, r, { signal: ctx.signal });
      const requestIds = [r.requestId, ...outcome.requestIds].filter((x): x is string => Boolean(x));
      if (outcome.state === "failed") return opFailure(`On-demand backup ${name} failed: ${outcome.detail ?? "the operation reported failure"}.`, { requestIds });
      return { ok: true, summary: `${outcome.state === "pending" ? "Started" : "Created"} on-demand backup ${name} of ${node.address}.`, data: { backup: name, operation: outcome.state }, requestIds, simulated: false };
    } catch (e) {
      // the same operation id retried: the backup already exists, which is the desired end state
      if (e instanceof ArmError && e.kind === "conflict") return { ok: true, summary: `On-demand backup ${name} of ${node.address} already exists.`, data: { backup: name, operation: "exists" }, requestIds: e.requestId ? [e.requestId] : undefined, simulated: false };
      throw e;
    }
  } catch (e) {
    return opFailureFromError(e, `Snapshot of ${node.address}`);
  }
};

export const postgresDriver = defineAzureDriver({
  id: "azure.postgresql_flexible_server@1",
  kind: "postgres",
  nativeType: "azure:postgresql_flexible_server",
  arm: POSTGRES,
  compile: compilePostgres,
  expected: expectedPostgres,
  read: readPostgres,
  native: (res) => ({ state: props(res).state, fqdn: props(res).fullyQualifiedDomainName, haState: pick(props(res), "highAvailability", "state"), availabilityZone: props(res).availabilityZone }),
  runtime: runtimePostgres,
  serving: true,
  operations: { "database.snapshot": snapshot },
});
