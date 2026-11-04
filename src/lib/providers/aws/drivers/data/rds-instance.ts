/**
 * `aws:rds_instance` driver (PostgreSQL; MySQL via `spec.engine`).
 *
 * Declarative lifecycle is `rds-compile.ts` (OpenTofu). This file holds the
 * read side, all through `ctx.session` and all read-only:
 *
 *   observe   DescribeDBInstances → status, engine + major version, instance
 *             class, Multi-AZ, storage encrypted, publicly accessible, deletion
 *             protection, backup retention, IAM auth, storage type, endpoint
 *             host/port (not secret), the master-credential SECRET ARN (a
 *             pointer; the value is never requested). The provider id (ARN) is
 *             `Observation.externalId`; `native` carries `dbInstanceIdentifier`,
 *             `dbiResourceId`, pending modifications and `tags`.
 *   runtime   `DBInstanceStatus` → health; pending modifications are signals.
 *   verify    exists, available, not public, encrypted, credential held in
 *             Secrets Manager, configuration matches the spec.
 *   discover  PostgreSQL and MySQL instances (Aurora/MariaDB are out of scope),
 *             tagged candidates only marked, never adopted.
 *
 * Find-by: `externalId` (ARN or identifier) when known, else the Zenith tags
 * (`zenith:workspace` + `zenith:environment` + `zenith:resource`) on the
 * instance's own `TagList`. Never by name alone. Zero matches → `missing`; more
 * than one → `unknown` (refusing to guess which one is the node's).
 *
 * Day-two operations: `database.snapshot` (idempotent) in `rds-operations.ts`;
 * `database.restore` and `database.delete` are refusing stubs there.
 *
 * Evidence is `contract` throughout: exercised against a mocked SDK only.
 */
import { DescribeDBInstancesCommand, RDSClient, type DBInstance } from "@aws-sdk/client-rds";
import type { DiscoveredResource, ResourceDriver } from "@/lib/drivers/types";
import type { AwsSession } from "@/lib/credentials/types";
import type { HealthState, Observation, ResourceNode, RuntimeState } from "@/lib/resources/types";
import { paginate } from "@/lib/providers/aws/drivers/shared";
import {
  backupRetentionFor,
  compileRdsInstance,
  deletionProtectionFor,
  majorVersionOf,
  rdsInstanceClassOf,
  readRdsSpec,
} from "./rds-compile";
import { rdsOperations } from "./rds-operations";
import { resolveInstance } from "./rds-read";
import {
  attrCheck,
  Attributes,
  call,
  candidate,
  expectedFor,
  guardObserve,
  guardRuntime,
  matchesExpectedCheck,
  scalars,
  tagMap,
  verificationOf,
  type AwsDriverContext,
  type ReadResult,
  type RuntimeRead,
} from "./support";

export const RDS_SOURCE = "aws.rds_instance@1";

/** Attributes compared with the desired spec (drift). */
const EXPECTED_NAMES = [
  "engine",
  "engineMajorVersion",
  "instanceClass",
  "multiAz",
  "storageEncrypted",
  "publiclyAccessible",
  "deletionProtection",
  "backupRetentionPeriod",
  "iamDatabaseAuthentication",
  "storageType",
] as const;

/** Read for information (endpoint, status…); never compared, because no spec attribute corresponds. */
const INFORMATIONAL_NAMES = ["status", "engineVersion", "allocatedStorage", "endpointAddress", "endpointPort", "masterSecretArn", "masterSecretStatus", "autoMinorVersionUpgrade", "performanceInsightsEnabled"] as const;

export const RDS_ATTRIBUTE_NAMES: readonly string[] = [...EXPECTED_NAMES, ...INFORMATIONAL_NAMES];

/** `expectedAttributes`: what a healthy, compliant instance for this node reports, in observe's units. */
export function expectedRdsAttributes(node: ResourceNode): Record<string, unknown> {
  return expectedFor(node, () => buildExpectedRds(node));
}

function buildExpectedRds(node: ResourceNode): Record<string, unknown> {
  const spec = readRdsSpec(node);
  return {
    engine: spec.engine,
    engineMajorVersion: majorVersionOf(spec.engine, spec.version),
    instanceClass: rdsInstanceClassOf(spec),
    multiAz: spec.highAvailability,
    storageEncrypted: true,
    publiclyAccessible: false,
    deletionProtection: deletionProtectionFor(spec.deletionPolicy),
    backupRetentionPeriod: backupRetentionFor(spec.backup, spec.deletionPolicy),
    iamDatabaseAuthentication: true,
    storageType: "gp3",
  };
}

/* ---------------------------------- reading -------------------------------- */

/** Engine major version in observe's unit. */
function observedMajor(engine: string | undefined, version: string | undefined): string | undefined {
  if (!version) return undefined;
  return majorVersionOf(engine === "mysql" ? "mysql" : "postgres", version);
}

function attributesOfInstance(ctx: AwsDriverContext, i: DBInstance): Attributes {
  const a = new Attributes(ctx);
  a.set("engine", i.Engine);
  a.set("engineMajorVersion", observedMajor(i.Engine, i.EngineVersion));
  a.set("engineVersion", i.EngineVersion);
  a.set("instanceClass", i.DBInstanceClass);
  a.set("multiAz", i.MultiAZ);
  a.set("storageEncrypted", i.StorageEncrypted);
  a.set("publiclyAccessible", i.PubliclyAccessible);
  a.set("deletionProtection", i.DeletionProtection);
  a.set("backupRetentionPeriod", i.BackupRetentionPeriod);
  a.set("iamDatabaseAuthentication", i.IAMDatabaseAuthenticationEnabled);
  a.set("storageType", i.StorageType);
  a.set("allocatedStorage", i.AllocatedStorage);
  a.set("status", i.DBInstanceStatus);
  a.set("endpointAddress", i.Endpoint?.Address);
  a.set("endpointPort", i.Endpoint?.Port);
  a.set("autoMinorVersionUpgrade", i.AutoMinorVersionUpgrade);
  a.set("performanceInsightsEnabled", i.PerformanceInsightsEnabled);
  // A pointer to the credential in Secrets Manager. DescribeDBInstances never returns the value.
  a.set("masterSecretArn", i.MasterUserSecret?.SecretArn ?? null);
  a.set("masterSecretStatus", i.MasterUserSecret?.SecretStatus);
  return a;
}

function nativeOfInstance(i: DBInstance): Record<string, unknown> {
  return {
    dbInstanceIdentifier: i.DBInstanceIdentifier,
    dbiResourceId: i.DbiResourceId,
    tags: tagMap(i.TagList),
    availabilityZone: i.AvailabilityZone,
    secondaryAvailabilityZone: i.SecondaryAvailabilityZone,
    pendingModifiedValues: i.PendingModifiedValues ? Object.fromEntries(Object.entries(i.PendingModifiedValues).filter(([, v]) => v !== undefined && v !== null)) : {},
    dbParameterGroups: (i.DBParameterGroups ?? []).map((g) => ({ name: g.DBParameterGroupName, status: g.ParameterApplyStatus })),
    latestRestorableTime: i.LatestRestorableTime?.toISOString?.(),
  };
}

function present(ctx: AwsDriverContext, i: DBInstance): ReadResult {
  return {
    kind: "present",
    externalId: i.DBInstanceArn ?? i.DBInstanceIdentifier ?? "",
    attributes: attributesOfInstance(ctx, i).finish(RDS_ATTRIBUTE_NAMES),
    native: nativeOfInstance(i),
  };
}

async function observeRds(ctx: AwsDriverContext, node: ResourceNode, externalId?: string): Promise<Observation> {
  return guardObserve(
    ctx,
    node,
    RDS_SOURCE,
    RDS_ATTRIBUTE_NAMES,
    externalId,
    async () => {
      const found = await resolveInstance(ctx, node, externalId);
      if (found === "missing") return { kind: "missing" };
      if ("ambiguous" in found) return { kind: "ambiguous", detail: found.ambiguous };
      return present(ctx, found);
    },
    ["tags", "dbInstanceIdentifier", "dbiResourceId", "pendingModifiedValues"]
  );
}

/* --------------------------------- runtime --------------------------------- */

const SERVING = new Set(["available"]);
/** Reachable or soon to be, but changing: degraded, not failed. */
const TRANSITIONAL = new Set([
  "backing-up",
  "configuring-enhanced-monitoring",
  "configuring-iam-database-auth",
  "configuring-log-exports",
  "converting-to-vpc",
  "creating",
  "maintenance",
  "modifying",
  "moving-to-vpc",
  "rebooting",
  "renaming",
  "resetting-master-credentials",
  "starting",
  "storage-optimization",
  "upgrading",
]);
const FAILED = new Set([
  "failed",
  "inaccessible-encryption-credentials",
  "inaccessible-encryption-credentials-recoverable",
  "incompatible-network",
  "incompatible-option-group",
  "incompatible-parameters",
  "incompatible-restore",
  "restore-error",
  "storage-full",
  "stopped",
  "stopping",
  "deleting",
]);

/** DBInstanceStatus → health. An unrecognized status is `unknown`, never assumed fine. */
export function rdsHealthOf(status: string | undefined): HealthState {
  if (status === undefined) return "unknown";
  if (SERVING.has(status)) return "healthy";
  if (TRANSITIONAL.has(status)) return "degraded";
  if (FAILED.has(status)) return "unhealthy";
  return "unknown";
}

async function runtimeRds(ctx: AwsDriverContext, node: ResourceNode, externalId?: string): Promise<RuntimeState> {
  return guardRuntime(ctx, node, RDS_SOURCE, async (): Promise<RuntimeRead> => {
    const found = await resolveInstance(ctx, node, externalId);
    if (found === "missing") return "missing";
    if ("ambiguous" in found) return { health: "unknown", counts: {}, signals: ["ambiguous_match"] };
    const status = found.DBInstanceStatus;
    const pending = Object.entries(found.PendingModifiedValues ?? {}).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0));
    const signals = [`status:${status ?? "unknown"}`, ...pending.map(([k]) => `pending_modification:${k}`).sort()];
    if (found.DBInstanceStatus === "available" && found.MasterUserSecret?.SecretStatus && found.MasterUserSecret.SecretStatus !== "active") {
      signals.push(`master_secret:${found.MasterUserSecret.SecretStatus}`);
    }
    return {
      health: rdsHealthOf(status),
      counts: { pendingModifications: pending.length, readReplicas: found.ReadReplicaDBInstanceIdentifiers?.length ?? 0 },
      signals,
    };
  });
}

/* --------------------------------- discover -------------------------------- */

async function discoverRds(ctx: AwsDriverContext): Promise<DiscoveredResource[]> {
  const rds = ctx.session.client(RDSClient);
  const { items } = await paginate(
    async (marker) => {
      const out = await call(ctx, (o) => rds.send(new DescribeDBInstancesCommand({ MaxRecords: 100, ...(marker ? { Marker: marker } : {}) }), o));
      return { items: out.DBInstances ?? [], next: out.Marker || undefined };
    },
    { maxPages: 10, signal: ctx.signal }
  );
  const found: DiscoveredResource[] = [];
  for (const i of items) {
    if ((i.Engine !== "postgres" && i.Engine !== "mysql") || !i.DBInstanceIdentifier) continue;
    found.push(
      candidate(ctx, {
        kind: i.Engine,
        nativeType: "aws:rds_instance",
        externalId: i.DBInstanceArn ?? i.DBInstanceIdentifier,
        name: i.DBInstanceIdentifier,
        tags: tagMap(i.TagList),
        attributes: scalars({
          engine: i.Engine,
          engineVersion: i.EngineVersion,
          instanceClass: i.DBInstanceClass,
          multiAz: i.MultiAZ,
          status: i.DBInstanceStatus,
          storageEncrypted: i.StorageEncrypted,
          publiclyAccessible: i.PubliclyAccessible,
        }),
      })
    );
  }
  return found.sort((a, b) => (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0));
}

/* ---------------------------------- driver --------------------------------- */

export const rdsInstanceDriver: ResourceDriver<AwsSession> = {
  id: RDS_SOURCE,
  provider: "aws",
  // One driver serves `postgres` and `mysql` (they share `aws:rds_instance`); `spec.engine` disambiguates.
  kind: "postgres",
  nativeType: "aws:rds_instance",
  capabilities: {
    compile: true,
    observe: true,
    runtime: true,
    verify: true,
    discover: true,
    operations: ["database.snapshot"],
    refuses: ["database.delete", "database.restore"],
    evidence: { compile: "contract", observe: "contract", runtime: "contract", verify: "contract", discover: "contract", "database.snapshot": "contract",
      // Evidence covers the refusal paths too; they are not executable capabilities.
      "database.restore": "contract", "database.delete": "contract" },
  },
  compile: compileRdsInstance,
  observe: observeRds,
  runtime: runtimeRds,
  expectedAttributes: expectedRdsAttributes,
  async verify(ctx, node, observation, runtime) {
    const status = runtime ? runtime.signals.find((s) => s.startsWith("status:"))?.slice(7) : undefined;
    const checks = [
      status !== undefined && runtime?.health !== "unknown"
        ? { id: "available", description: "the instance is available", passed: runtime?.health === "healthy", detail: `status = ${status}` }
        : attrCheck(observation, "available", "the instance is available", "status", (v) => v === "available"),
      attrCheck(observation, "not_public", "the instance is not publicly accessible", "publiclyAccessible", (v) => v === false),
      attrCheck(observation, "encrypted", "storage is encrypted", "storageEncrypted", (v) => v === true),
      attrCheck(observation, "credential_in_secrets_manager", "the master credential is held in Secrets Manager", "masterSecretArn", (v) => typeof v === "string" && v.startsWith("arn:")),
      matchesExpectedCheck(expectedRdsAttributes(node), observation),
    ];
    return verificationOf(ctx, node, observation, checks);
  },
  discover: discoverRds,
  operations: rdsOperations,
};
