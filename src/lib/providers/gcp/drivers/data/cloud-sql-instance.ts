/**
 * `gcp:cloud_sql_instance` — Cloud SQL for PostgreSQL (kind `postgres`).
 *
 * Compile (google_sql_database_instance), always:
 *   - PRIVATE IP ONLY: `ipv4_enabled = false`, `private_network` = the
 *     environment VPC, reached through Private Service Access (the network
 *     node owns the connection; this instance `depends_on` it). There is no
 *     public address and no authorized network, ever;
 *   - `ssl_mode = ENCRYPTED_ONLY` (TLS required; client certificates are not);
 *   - IAM database authentication on (`cloudsql.iam_authentication = on`) and
 *     NO built-in user password: no `root_password`, no `google_sql_user` with
 *     a password, nothing for state to hold. Applications connect as their
 *     service account (an IAM database user created by `gcp:service_account`
 *     from the node's `connect` grant). The built-in `postgres` user is left
 *     without a password set, so it cannot be used to log in;
 *   - `deletion_protection` (tofu) and `settings.deletion_protection_enabled`
 *     (API) on, and `deletion_policy = PREVENT`, unless `deletionPolicy` is
 *     `allow`; a final backup is taken on delete (retained 30 days);
 *   - backups per `spec.backup` (`none` disables; `daily` = daily backup +
 *     7-day point-in-time recovery; `hourly` adds no extra schedule because
 *     PITR already gives sub-hourly recovery, so it maps to the same
 *     configuration with 7 days of log retention);
 *   - `availability_type = REGIONAL` when `highAvailability`. Shared-core
 *     tiers do not support HA, so `nano` is raised to `db-custom-1-3840`
 *     when HA is requested;
 *   - Enterprise edition, SSD, disk autoresize on, query insights on.
 *
 * Size → tier: nano `db-f1-micro`, small `db-custom-1-3840`, standard
 * `db-custom-2-7680`, performance `db-custom-4-15360`; `instanceClass`
 * overrides (must look like `db-…`). Disk: 10/20/50/200 GB.
 *
 * Observation reads the instance's configuration only. It never reads users,
 * databases or data, and no credential exists to read.
 */
import type { CompileContext, NativeOperation, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import type { PostgresSpec } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";
import { GcpCompileError } from "../../errors";
import { cloudName, labelsMatch, nodeLabels, tfLabel } from "../../naming";
import { contractCapabilities, deletionGuard, nameResolver, specOf } from "../../driver-util";
import { dataFragment, depsOfKind, expr, lastSegment, lit, ref, safeRegion } from "../../hcl";
import { arr, fetchObject, makeReaders, rec, str, tail, type ReadSpec } from "../../read-kit";
import { gcpCall } from "../../rest";
import { psaConnectionAddress } from "../network/vpc-network";

export const DRIVER_ID = "gcp.cloud_sql_instance@1";
const SQLADMIN = "https://sqladmin.googleapis.com/v1";

const TIERS: Record<string, { tier: string; diskGb: number }> = {
  nano: { tier: "db-f1-micro", diskGb: 10 },
  small: { tier: "db-custom-1-3840", diskGb: 20 },
  standard: { tier: "db-custom-2-7680", diskGb: 50 },
  performance: { tier: "db-custom-4-15360", diskGb: 200 },
};

export function sqlVersion(version: string, where: string): string {
  const m = /^(\d{2})(?:\.\d+)*$/.exec(String(version).trim());
  if (!m || Number(m[1]) < 12 || Number(m[1]) > 18) throw new GcpCompileError("unsupported_version", `${where}: PostgreSQL version "${lit(String(version)).slice(0, 12)}" is not a supported major (12-18).`);
  return `POSTGRES_${m[1]}`;
}

export function sqlTier(s: Pick<PostgresSpec, "size" | "instanceClass" | "highAvailability">, where: string): { tier: string; diskGb: number } {
  const base = TIERS[s.size] ?? TIERS.small;
  if (s.instanceClass) {
    if (!/^db-[a-z0-9-]{3,40}$/.test(s.instanceClass)) throw new GcpCompileError("invalid_spec", `${where}: instanceClass must be a Cloud SQL tier such as db-custom-2-7680.`);
    return { tier: s.instanceClass, diskGb: base.diskGb };
  }
  if (s.highAvailability && base.tier === "db-f1-micro") return { tier: TIERS.small.tier, diskGb: base.diskGb };
  return base;
}

function expectedAttributes(node: ResourceNode): Record<string, unknown> {
  const s = specOf<PostgresSpec>(node);
  const guard = deletionGuard(s);
  return {
    databaseVersion: sqlVersion(s.version, node.address),
    tier: sqlTier(s, node.address).tier,
    availabilityType: s.highAvailability ? "REGIONAL" : "ZONAL",
    publicIp: false,
    sslMode: "ENCRYPTED_ONLY",
    iamAuthentication: true,
    backupEnabled: s.backup !== "none",
    pointInTimeRecovery: s.backup !== "none",
    deletionProtection: guard.protect,
  };
}

function compile(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const L = tfLabel(node.address);
  if (node.ownership !== "managed") {
    return dataFragment("google_sql_database_instance", L, { name: lastSegment(node.externalRef, node.address) });
  }
  safeRegion(ctx.region);
  const s = specOf<PostgresSpec>(node);
  if (s.engine !== "postgres") throw new GcpCompileError("unsupported_engine", `${node.address}: this driver realizes postgres only.`);
  const network = depsOfKind(node, ctx, "network")[0];
  if (!network) throw new GcpCompileError("missing_network", `${node.address}: a private-IP-only database needs a network node among its dependencies.`);
  const { tier, diskGb } = sqlTier(s, node.address);
  const guard = deletionGuard(s);
  const backups = s.backup !== "none";

  const settings: Record<string, unknown> = {
    tier,
    edition: "ENTERPRISE",
    availability_type: s.highAvailability ? "REGIONAL" : "ZONAL",
    disk_type: "PD_SSD",
    disk_size: diskGb,
    disk_autoresize: true,
    deletion_protection_enabled: guard.protect,
    user_labels: nodeLabels(ctx.tags, node),
    ip_configuration: [
      {
        ipv4_enabled: false,
        private_network: ref(ctx, network.address, "id"),
        ssl_mode: "ENCRYPTED_ONLY",
      },
    ],
    database_flags: [{ name: "cloudsql.iam_authentication", value: "on" }],
    backup_configuration: [
      {
        enabled: backups,
        ...(backups
          ? {
              start_time: "03:00",
              point_in_time_recovery_enabled: true,
              transaction_log_retention_days: 7,
              backup_retention_settings: [{ retained_backups: 7, retention_unit: "COUNT" }],
            }
          : {}),
      },
    ],
    final_backup_config: [{ enabled: true, retention_days: 30 }],
    insights_config: [{ query_insights_enabled: true }],
    maintenance_window: [{ day: 7, hour: 3, update_track: "stable" }],
  };

  return {
    resource: {
      google_sql_database_instance: {
        [L]: {
          name: cloudName(ctx.namePrefix, node.address, { max: 90, suffix: "pg" }),
          region: ctx.region,
          database_version: sqlVersion(s.version, node.address),
          deletion_protection: guard.protect,
          deletion_policy: guard.policy,
          settings: [settings],
          depends_on: [psaConnectionAddress(network.address)],
        },
      },
    },
    output: {
      [`${L}_connection_name`]: { value: expr(`google_sql_database_instance.${L}.connection_name`), description: "Cloud SQL connection name" },
      [`${L}_private_ip`]: { value: expr(`google_sql_database_instance.${L}.private_ip_address`), description: "private IP (no public address exists)" },
    },
    addresses: [`google_sql_database_instance.${L}`],
  };
}

/* --------------------------------- reading --------------------------------- */

const resolveName = nameResolver((p) => `projects/${p}/instances/[a-z][a-z0-9-]{0,97}`, SQLADMIN, "Cloud SQL instance");

const spec: ReadSpec = {
  driverId: DRIVER_ID,
  nativeType: "gcp:cloud_sql_instance",
  kind: "postgres",
  attributes: ["databaseVersion", "tier", "availabilityType", "publicIp", "sslMode", "iamAuthentication", "backupEnabled", "pointInTimeRecovery", "deletionProtection"],
  resolve: resolveName,
  list: {
    url: (ctx) => `${SQLADMIN}/projects/${ctx.session.projectId}/instances?maxResults=200`,
    itemsKey: "items",
    pageTokenParam: "pageToken",
    labelsOf: (item) => rec(rec(item.settings).userLabels),
  },
  extract(o, ctx) {
    const name = str(o.name);
    const project = str(o.project) ?? ctx.session.projectId;
    if (!name) throw new Error("no name");
    const settings = rec(o.settings);
    const ip = rec(settings.ipConfiguration);
    const backup = rec(settings.backupConfiguration);
    const flags = arr(settings.databaseFlags).map((f) => rec(f));
    const iamFlag = flags.find((f) => f.name === "cloudsql.iam_authentication");
    const addresses = arr(o.ipAddresses).map((a) => rec(a));
    const hasPublic = addresses.some((a) => a.type === "PRIMARY");
    return {
      externalId: `projects/${project}/instances/${name}`,
      name,
      attributes: {
        databaseVersion: str(o.databaseVersion),
        tier: str(settings.tier),
        availabilityType: str(settings.availabilityType) ?? "ZONAL",
        publicIp: hasPublic || ip.ipv4Enabled === true,
        sslMode: str(ip.sslMode),
        iamAuthentication: iamFlag?.value === "on",
        backupEnabled: backup.enabled === true,
        pointInTimeRecovery: backup.pointInTimeRecoveryEnabled === true,
        deletionProtection: settings.deletionProtectionEnabled === true,
      },
      native: {
        state: str(o.state),
        region: str(o.region),
        connectionName: str(o.connectionName),
        privateIpPresent: addresses.some((a) => a.type === "PRIVATE"),
        diskSizeGb: str(settings.dataDiskSizeGb),
        activationPolicy: str(settings.activationPolicy),
      },
    };
  },
  runtime(o) {
    const state = str(o.state);
    const policy = str(rec(o.settings).activationPolicy);
    const signals: string[] = [];
    let health: "healthy" | "degraded" | "unhealthy" | "unknown" = "unknown";
    if (state === "RUNNABLE") health = policy === "NEVER" ? "unhealthy" : "healthy";
    else if (state === "PENDING_CREATE" || state === "MAINTENANCE" || state === "PENDING_DELETE") health = "degraded";
    else if (state === "SUSPENDED" || state === "FAILED") health = "unhealthy";
    if (state) signals.push(`state:${state.replace(/[^A-Z_]/g, "").slice(0, 32)}`);
    if (policy === "NEVER") signals.push("activation_policy:never");
    return { health, counts: {}, signals };
  },
};

const readers = makeReaders(spec, expectedAttributes, { serving: true });

/* ------------------------------ day-two: snapshot --------------------------- */

/**
 * `database.snapshot`: an on-demand backup run. Idempotent per operation id:
 * the backup's description is `zenith:<operationId>` and an existing run with
 * that description is reported instead of creating a second one.
 */
const snapshot: NativeOperation<GcpSession> = async (ctx, node, input) => {
  const fail = (summary: string) => ({ ok: false, summary, simulated: false as const });
  const token = ctx.operationId;
  if (!token || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,100}$/.test(token)) return fail("database.snapshot needs an operation id so a retry cannot take two backups.");
  const f = await fetchObject(spec, ctx, node, typeof input.externalId === "string" ? input.externalId : undefined);
  if (f.kind === "invalid") return fail(`database.snapshot: ${f.error}`);
  if (f.kind === "none") return fail(`database.snapshot: the instance could not be read (${f.outcome}).`);
  if (!labelsMatch(rec(rec(f.obj.settings).userLabels), nodeLabels(ctx.tags, node))) return fail(`database.snapshot: refusing; the instance does not carry this environment's Zenith labels for ${node.address}.`);
  const name = str(f.obj.name);
  if (!name) return fail("database.snapshot: the instance response had no name.");
  const base = `${SQLADMIN}/projects/${ctx.session.projectId}/instances/${name}/backupRuns`;
  const description = `zenith:${token}`;
  const existing = await gcpCall(ctx, "GET", `${base}?maxResults=20`);
  if (existing.outcome === "ok") {
    const found = arr(existing.json.items).map((b) => rec(b)).find((b) => b.description === description);
    if (found) return { ok: true, summary: "A backup for this operation already exists.", data: { instance: name, backupId: str(found.id), status: str(found.status), changed: false }, requestIds: existing.requestId ? [existing.requestId] : [], simulated: false };
  }
  const res = await gcpCall(ctx, "POST", base, { description });
  if (res.outcome !== "ok") return { ...fail(`database.snapshot: Cloud SQL rejected the backup (${res.outcome}${res.detail ? `: ${res.detail}` : ""}).`), requestIds: res.requestId ? [res.requestId] : [] };
  return {
    ok: true,
    summary: "Started an on-demand backup.",
    data: { instance: name, operation: tail(str(res.json.name)), status: str(res.json.status), changed: true },
    requestIds: [res.requestId, str(res.json.name)].filter((x): x is string => !!x),
    simulated: false,
  };
};

export const cloudSqlInstanceDriver: ResourceDriver<GcpSession> = {
  id: DRIVER_ID,
  provider: "gcp",
  kind: "postgres",
  nativeType: "gcp:cloud_sql_instance",
  capabilities: contractCapabilities({ runtime: true, discover: true, operations: ["database.snapshot"] }),
  compile,
  observe: readers.observe,
  runtime: readers.runtime,
  verify: readers.verify,
  discover: readers.discover,
  expectedAttributes,
  operations: { "database.snapshot": snapshot },
};
