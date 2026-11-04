/**
 * `oci:postgresql_db_system` — portable `postgres` on OCI (OCI Database with
 * PostgreSQL).
 *
 * Compiles to:
 *   oci_core_network_security_group   `<label>_nsg`: the VNIC group clients are
 *                                     allowed into (firewall nodes add tcp/5432
 *                                     rules from the workloads' NSGs)
 *   oci_vault_secret                  `<label>_admin`: the admin password,
 *                                     AUTO-GENERATED inside OCI Vault
 *                                     (`DBAAS_DEFAULT_PASSWORD`). It is never
 *                                     seen by OpenTofu, the control plane or
 *                                     state.
 *   oci_psql_db_system                private only (the service has no public
 *                                     endpoint); `password_details` is
 *                                     `VAULT_SECRET` with that secret's id and
 *                                     current version, so NO plaintext password
 *                                     argument exists anywhere in the fragment.
 *   + data sources for the customer's vault/key (vault-lookup.ts) and, for the
 *     non-HA AD-local storage case, the first availability domain.
 *
 * The workload reads the password at runtime with its resource principal
 * (`read secret-bundles` scoped to `local.<label>_admin_secret_id`, which the
 * identity node renders from the `read_credentials` grant).
 *
 * Mapping notes (honest):
 *   highAvailability  → `instance_count` 2 and regionally durable storage;
 *                       otherwise 1 node on AD-local storage in AD 1.
 *   backup            → `none` → NONE, `daily` → DAILY 02:00 UTC, 7 days after
 *                       deletion. OCI PostgreSQL has no hourly schedule:
 *                       `hourly` is realized as DAILY (an RPO of 24 h, not 1 h).
 *   size              → flexible shape VM.Standard.E4.Flex with a fixed
 *                       16 GB per OCPU (nano 1, small 2, standard 4,
 *                       performance 8 OCPU). Ratio, shape and the `02:00`
 *                       backup-start format follow the OCI docs and are not
 *                       exercised against a tenancy.
 *   deletion          → no provider flag exists; `lifecycle.prevent_destroy`
 *                       unless `deletionPolicy` is "allow".
 */
import { createHash } from "node:crypto";
import type { CompileContext, NativeOperationResult, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { PostgresSpec } from "@/lib/resources/specs";
import type { HealthState, Observation, ResourceNode, RuntimeState } from "@/lib/resources/types";
import { compartmentOf } from "../../context";
import { OciCompileError, OciUnsupportedError } from "../../errors";
import { ociCapabilities, ociDriverId } from "../../evidence";
import { auxName, cloudName, interp, nameOf, networkOf, nodeCloudName, tfLabel, zenithTags } from "../../naming";
import {
  arrayOrItems,
  asArray,
  asNumber,
  asRecord,
  asString,
  attributesOf,
  discoverWith,
  isZenithObject,
  locate,
  observationOf,
  runtimeOf,
  verifyWith,
  type LocateDef,
  type OciContext,
} from "../../observe-kit";
import { ociPath } from "../../services";
import { ociCall, type OciSession } from "../../transport";
import { vaultLookup } from "../../vault-lookup";
import { addressList, isManaged, protectFromDestroy, readOnlyFragment, res, specOf } from "../shared";

export const POSTGRES_NATIVE_TYPE = "oci:postgresql_db_system";
const ID = ociDriverId(POSTGRES_NATIVE_TYPE);

const OCPU: Record<string, number> = { nano: 1, small: 2, standard: 4, performance: 8 };
const GB_PER_OCPU = 16;
const MAJOR = /^\d{1,2}$/;

export function sizeOf(node: ResourceNode, size: unknown): { ocpu: number; memoryGb: number } {
  const ocpu = typeof size === "string" ? OCPU[size] : undefined;
  if (ocpu === undefined) throw new OciCompileError(`${node.address}: unknown size "${String(size)}" (expected nano, small, standard or performance).`);
  return { ocpu, memoryGb: ocpu * GB_PER_OCPU };
}

export function backupKind(backup: PostgresSpec["backup"]): "NONE" | "DAILY" {
  return backup === "none" ? "NONE" : "DAILY";
}

export function compilePostgres(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (!isManaged(node)) return readOnlyFragment();
  const spec = specOf<PostgresSpec>(node);
  if (spec.engine !== "postgres") throw new OciUnsupportedError(`${node.address}: oci:postgresql_db_system serves engine "postgres" only (got "${String(spec.engine)}").`);
  if (spec.credentials !== "generated") throw new OciCompileError(`${node.address}: credentials must be "generated"; a password is never part of a spec.`);
  if (!MAJOR.test(String(spec.version))) throw new OciCompileError(`${node.address}: version "${String(spec.version)}" is not a major version number.`);
  const { ocpu, memoryGb } = sizeOf(node, spec.size);
  const compartment = compartmentOf(ctx);
  const placement = networkOf(ctx, node, "private");
  const tags = zenithTags(ctx, node);
  const name = nodeCloudName(ctx, node, 100);
  const ha = spec.highAvailability === true;

  const nsg = res("oci_core_network_security_group", node, "_nsg");
  const secret = res("oci_vault_secret", node, "_admin");
  const db = res("oci_psql_db_system", node);
  const ad = res("oci_identity_availability_domain", node, "_ad");
  const lookup = vaultLookup(ctx, node);

  const storage: Record<string, unknown> = { system_type: "OCI_OPTIMIZED_STORAGE", is_regionally_durable: ha };
  const data: NonNullable<TofuFragment["data"]> = { ...lookup.data };
  const dataAddresses = [...lookup.addresses];
  if (!ha) {
    storage.availability_domain = interp(`data.${ad.address}.name`);
    data.oci_identity_availability_domain = { [ad.label]: { compartment_id: compartment, ad_number: 1 } };
    dataAddresses.push(`data.${ad.address}`);
  }

  const backup = backupKind(spec.backup);
  return {
    data,
    resource: {
      oci_core_network_security_group: { [nsg.label]: { compartment_id: compartment, vcn_id: ctx.ref(placement.network, "id"), display_name: `${name}-nsg`, freeform_tags: tags } },
      oci_vault_secret: {
        [secret.label]: {
          compartment_id: compartment,
          vault_id: lookup.vaultId,
          key_id: lookup.keyId,
          secret_name: cloudName(ctx.namePrefix, `${nameOf(node.address)}-admin`, 255),
          description: `Generated admin password for ${node.address}; never read by Zenith.`,
          enable_auto_generation: true,
          secret_generation_context: { generation_type: "PASSPHRASE", generation_template: "DBAAS_DEFAULT_PASSWORD", passphrase_length: 24 },
          freeform_tags: tags,
          lifecycle: { ignore_changes: ["secret_content", "enable_auto_generation", "secret_generation_context", "metadata"] },
        },
      },
      oci_psql_db_system: {
        [db.label]: {
          compartment_id: compartment,
          display_name: name,
          db_version: String(spec.version),
          shape: "VM.Standard.E4.Flex",
          instance_count: ha ? 2 : 1,
          instance_ocpu_count: ocpu,
          instance_memory_size_in_gbs: memoryGb,
          credentials: {
            username: "zenith_admin",
            password_details: { password_type: "VAULT_SECRET", secret_id: interp(`${secret.address}.id`), secret_version: interp(`${secret.address}.current_version_number`) },
          },
          network_details: { subnet_id: ctx.ref(placement.subnets[0], "id"), nsg_ids: [interp(`${nsg.address}.id`)] },
          storage_details: storage,
          management_policy: { backup_policy: backup === "NONE" ? { kind: "NONE" } : { kind: "DAILY", backup_start: "02:00", retention_days: 7 } },
          freeform_tags: tags,
          ...protectFromDestroy(spec),
        },
      },
    },
    locals: {
      [auxName(node.address, "nsg_id")]: interp(`${nsg.address}.id`),
      [auxName(node.address, "admin_secret_id")]: interp(`${secret.address}.id`),
    },
    output: { [`${db.label}_endpoint`]: { value: interp(`${db.address}.network_details[0].primary_db_endpoint_private_ip`), description: `Private endpoint of ${node.address}` } },
    addresses: addressList(db.address, [nsg.address, secret.address, ...dataAddresses]),
  };
}

export function postgresExpected(node: ResourceNode): Record<string, unknown> {
  const spec = specOf<PostgresSpec>(node);
  return {
    engine: "postgres",
    version: String(spec.version),
    highAvailability: spec.highAvailability === true,
    backup: spec.backup === "none" ? "none" : "daily",
  };
}

const locateDef: LocateDef = {
  service: "postgresql",
  get: (id) => ({ path: ociPath("postgresql", "dbSystems", id) }),
  list: (compartmentId) => ({ path: ociPath("postgresql", "dbSystems"), query: { compartmentId } }),
  items: arrayOrItems,
  idOf: (i) => asString(asRecord(i)?.id),
};

/** List summaries omit most attributes: read the db system itself. */
async function fullDb(ctx: OciContext, node: ResourceNode, id: string, requestIds: string[]): Promise<Record<string, unknown> | undefined> {
  const r = await ociCall(ctx, { service: "postgresql", region: node.region || ctx.region, method: "GET", path: ociPath("postgresql", "dbSystems", id) });
  if (r.requestId) requestIds.push(r.requestId);
  return r.ok ? asRecord(r.body) : undefined;
}

export async function observePostgres(ctx: OciContext, node: ResourceNode, externalId?: string): Promise<Observation> {
  const located = await locate(ctx, node, externalId, locateDef);
  if (located.presence !== "present" || !located.item || !located.externalId) return observationOf(ctx, node, ID, located);
  const full = (await fullDb(ctx, node, located.externalId, located.requestIds)) ?? located.item;
  const at = ctx.now().toISOString();
  const count = asNumber(full.instanceCount);
  const kind = asString(asRecord(asRecord(full.managementPolicy)?.backupPolicy)?.kind);
  const attributes = attributesOf(at, {
    engine: "postgres",
    version: asString(full.dbVersion),
    highAvailability: count === undefined ? undefined : count >= 2,
    backup: kind === undefined ? undefined : kind === "NONE" ? "none" : "daily",
  });
  return observationOf(ctx, node, ID, located, attributes, {
    lifecycleState: full.lifecycleState,
    dbVersion: full.dbVersion,
    shape: full.shape,
    instanceCount: count ?? null,
    regionallyDurable: asRecord(full.storageDetails)?.isRegionallyDurable ?? null,
  });
}

export async function runtimePostgres(ctx: OciContext, node: ResourceNode, externalId?: string): Promise<RuntimeState> {
  const located = await locate(ctx, node, externalId, locateDef);
  if (located.presence !== "present" || !located.externalId) return runtimeOf(ctx, node, ID, "unknown", {}, [`presence:${located.presence}`]);
  const full = (await fullDb(ctx, node, located.externalId, located.requestIds)) ?? located.item;
  const state = asString(full?.lifecycleState);
  const instances = asArray(full?.instances).map((i) => asString(asRecord(i)?.lifecycleState));
  const counts: Record<string, number> = {};
  if (asNumber(full?.instanceCount) !== undefined) counts.desired = asNumber(full?.instanceCount)!;
  if (instances.length > 0) {
    counts.instances = instances.length;
    counts.active = instances.filter((s) => s === "ACTIVE").length;
    counts.notActive = instances.length - counts.active;
  }
  const signals = state ? [`state:${state}`] : [];
  if ((counts.notActive ?? 0) > 0) signals.push(`instances_not_active:${counts.notActive}`);
  let health: HealthState = "unknown";
  if (state === "ACTIVE") health = (counts.notActive ?? 0) > 0 ? "degraded" : "healthy";
  else if (state === "FAILED" || state === "DELETED") health = "unhealthy";
  else if (state) health = "degraded";
  return runtimeOf(ctx, node, ID, health, counts, signals);
}

/** `database.snapshot`: a manual backup, retry-token idempotent, tags re-checked first. */
async function snapshot(ctx: OciContext, node: ResourceNode, input: Record<string, unknown>): Promise<NativeOperationResult> {
  const opId = ctx.operationId;
  if (!opId) return { ok: false, simulated: false, summary: "database.snapshot needs an operation id for idempotency." };
  const located = await locate(ctx, node, typeof input.externalId === "string" ? input.externalId : undefined, locateDef);
  if (located.presence !== "present" || !located.item || !located.externalId) return { ok: false, simulated: false, summary: `The database for ${node.address} was not found (${located.presence}); no backup was requested.`, requestIds: located.requestIds };
  if (!isZenithObject(located.item, ctx.environmentId, node.address)) return { ok: false, simulated: false, summary: `The DB system ${located.externalId} is not tagged as ${node.address} in this environment; refusing to act on it.`, requestIds: located.requestIds };
  const token = `zenith-${createHash("sha256").update(`oci-backup\0${opId}`).digest("hex").slice(0, 32)}`;
  const tags: Record<string, string> = { zenith_operation: opId.slice(0, 120), zenith_environment: ctx.environmentId, zenith_resource: node.address, zenith_managed: "true" };
  if (ctx.fence) tags.zenith_fence = `${ctx.fence.scope}:${ctx.fence.token}`.slice(0, 200);
  const r = await ociCall(ctx, {
    service: "postgresql",
    region: node.region || ctx.region,
    method: "POST",
    path: ociPath("postgresql", "backups"),
    headers: { "opc-retry-token": token },
    body: { displayName: `zenith-${tfLabel(opId).slice(0, 40)}`, dbSystemId: located.externalId, freeformTags: tags },
  });
  const requestIds = [...located.requestIds, ...(r.requestId ? [r.requestId] : [])];
  if (!r.ok) return { ok: false, simulated: false, summary: r.message, requestIds };
  return { ok: true, simulated: false, summary: `Backup requested for ${node.address}.`, data: { accepted: true, status: r.status }, requestIds };
}

export const postgresDriver: ResourceDriver<OciSession> = {
  id: ID,
  provider: "oci",
  kind: "postgres",
  nativeType: POSTGRES_NATIVE_TYPE,
  capabilities: ociCapabilities({ compile: true, observe: true, runtime: true, verify: true, discover: true, operations: ["database.snapshot"] }),
  compile: compilePostgres,
  observe: observePostgres,
  runtime: runtimePostgres,
  expectedAttributes: postgresExpected,
  verify: async (ctx, node, observation, runtime) => verifyWith({ node, observation, expected: postgresExpected(node), runtime, now: ctx.now() }),
  discover: (ctx) =>
    discoverWith(ctx, {
      ...locateDef,
      kind: "postgres",
      nativeType: POSTGRES_NATIVE_TYPE,
      nameOf: (i) => asString(i.displayName) ?? asString(i.id) ?? "postgres",
      attributes: (i) => ({ state: asString(i.lifecycleState) ?? "", version: asString(i.dbVersion) ?? "" }),
    }),
  operations: { "database.snapshot": snapshot },
};
