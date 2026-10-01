import { CreateDBSnapshotCommand, DescribeDBInstancesCommand, DescribeDBSnapshotsCommand, RDSClient, type DBInstance, type DBSnapshot } from "@aws-sdk/client-rds";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { rdsInstanceDriver } from "@/lib/providers/aws/drivers/data";
import { rdsHealthOf } from "@/lib/providers/aws/drivers/data/rds-instance";
import { snapshotIdentifierFor } from "@/lib/providers/aws/drivers/data/rds-operations";
import { driftOf } from "./_drift";
import { awsError, driverCtx, mkNode, postgresSpec, tagList } from "./_helpers";

const rds = mockClient(RDSClient);
beforeEach(() => rds.reset());
afterAll(() => rds.restore());

const ARN = "arn:aws:rds:ap-south-1:123456789012:db:zen-prod-db";
const node = mkNode("postgres/db", "postgres", postgresSpec(), { dependsOn: ["subnet/private-a", "subnet/private-b"] });
const driver = rdsInstanceDriver;

const instance = (over: Partial<DBInstance> = {}): DBInstance => ({
  DBInstanceIdentifier: "zen-prod-db",
  DBInstanceArn: ARN,
  DbiResourceId: "db-ABCDEFGHIJKL",
  Engine: "postgres",
  EngineVersion: "16.4",
  DBInstanceClass: "db.t4g.small",
  MultiAZ: false,
  StorageEncrypted: true,
  PubliclyAccessible: false,
  DeletionProtection: true,
  BackupRetentionPeriod: 7,
  IAMDatabaseAuthenticationEnabled: true,
  StorageType: "gp3",
  AllocatedStorage: 20,
  AutoMinorVersionUpgrade: true,
  PerformanceInsightsEnabled: false,
  DBInstanceStatus: "available",
  Endpoint: { Address: "zen-prod-db.abc.ap-south-1.rds.amazonaws.com", Port: 5432 },
  MasterUserSecret: { SecretArn: "arn:aws:secretsmanager:ap-south-1:123456789012:secret:rds!db-1234-AbCdEf", SecretStatus: "active" },
  TagList: tagList("postgres/db"),
  PendingModifiedValues: {},
  ...over,
});

const known = (o: { attributes: Record<string, { state: string; value?: unknown }> }, name: string) => {
  const a = o.attributes[name];
  return a?.state === "known" ? a.value : `<${a?.state}>`;
};

describe("aws:rds_instance observe", () => {
  it("reads configuration by ARN and matches the desired spec exactly (no drift)", async () => {
    rds.on(DescribeDBInstancesCommand, { DBInstanceIdentifier: "zen-prod-db" }).resolves({ DBInstances: [instance()] });
    const obs = await driver.observe!(driverCtx(), node, ARN);
    expect(obs).toMatchObject({ address: "postgres/db", presence: "present", externalId: ARN, source: "aws.rds_instance@1", simulated: false });
    expect(known(obs, "status")).toBe("available");
    expect(known(obs, "engineMajorVersion")).toBe("16");
    expect(known(obs, "instanceClass")).toBe("db.t4g.small");
    expect(known(obs, "endpointAddress")).toBe("zen-prod-db.abc.ap-south-1.rds.amazonaws.com");
    expect(known(obs, "endpointPort")).toBe(5432);
    expect(known(obs, "masterSecretArn")).toMatch(/^arn:aws:secretsmanager:/);
    expect(obs.native).toMatchObject({ dbInstanceIdentifier: "zen-prod-db", dbiResourceId: "db-ABCDEFGHIJKL" });
    expect((obs.native as { tags: Record<string, string> }).tags).toMatchObject({ "zenith:managed": "true", "zenith:environment": "env_test" });
    expect(Buffer.byteLength(JSON.stringify(obs.native))).toBeLessThanOrEqual(4096);

    expect(driftOf(node, obs, driver.expectedAttributes!)).toEqual([]);
  });

  it("accepts a bare identifier and passes the abort signal to the SDK", async () => {
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [instance()] });
    const ctx = driverCtx();
    await driver.observe!(ctx, node, "zen-prod-db");
    const [, options] = rds.commandCalls(DescribeDBInstancesCommand)[0].args as unknown as [unknown, { abortSignal?: AbortSignal }];
    expect(options?.abortSignal).toBe(ctx.signal);
  });

  it("reports drift on what changed: public, unencrypted, protection off, Multi-AZ flipped", async () => {
    rds.on(DescribeDBInstancesCommand).resolves({
      DBInstances: [instance({ PubliclyAccessible: true, StorageEncrypted: false, DeletionProtection: false, MultiAZ: true, BackupRetentionPeriod: 0 })],
    });
    const obs = await driver.observe!(driverCtx(), node, ARN);
    const findings = driftOf(node, obs, driver.expectedAttributes!);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ class: "changed", severity: "high" });
    expect(findings[0].fields!.map((f) => f.attribute).sort()).toEqual(["backupRetentionPeriod", "deletionProtection", "multiAz", "publiclyAccessible", "storageEncrypted"]);
  });

  it("finds the instance by Zenith tags across pages when no id is known", async () => {
    rds
      .on(DescribeDBInstancesCommand)
      .resolvesOnce({ DBInstances: [instance({ DBInstanceIdentifier: "other", TagList: [] })], Marker: "m1" })
      .resolvesOnce({ DBInstances: [instance()] });
    const obs = await driver.observe!(driverCtx(), node);
    expect(obs.presence).toBe("present");
    expect(obs.externalId).toBe(ARN);
    expect(rds.commandCalls(DescribeDBInstancesCommand)).toHaveLength(2);
  });

  it("never matches by name alone: a same-named instance without the node's tags is not the node", async () => {
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [instance({ TagList: tagList("postgres/db", { "zenith:environment": "someone_elses" }) })] });
    const obs = await driver.observe!(driverCtx(), node);
    expect(obs.presence).toBe("missing");
  });

  it("refuses to choose between two instances that carry the node's tags", async () => {
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [instance(), instance({ DBInstanceIdentifier: "twin", DBInstanceArn: ARN.replace("zen-prod-db", "twin") })] });
    const obs = await driver.observe!(driverCtx(), node);
    expect(obs.presence).toBe("unknown");
    expect(obs.error).toMatch(/refusing to choose/);
    expect(Object.values(obs.attributes).every((a) => a.state === "unknown")).toBe(true);
  });

  it("rejects an externalId that is not an RDS ARN or identifier without calling AWS", async () => {
    const obs = await driver.observe!(driverCtx(), node, "arn:aws:s3:::a-bucket");
    expect(obs.presence).toBe("unknown");
    expect(rds.calls()).toHaveLength(0);
  });

  it("classifies NotFound as missing, AccessDenied as inaccessible, throttling as unknown", async () => {
    rds.on(DescribeDBInstancesCommand).rejects(awsError("DBInstanceNotFoundFault", "DBInstance zen-prod-db not found.", 404));
    const missing = await driver.observe!(driverCtx(), node, ARN);
    expect(missing.presence).toBe("missing");
    expect(Object.values(missing.attributes).every((a) => a.state === "unknown")).toBe(true);

    rds.on(DescribeDBInstancesCommand).rejects(awsError("AccessDenied", "not authorized to perform rds:DescribeDBInstances", 403));
    const denied = await driver.observe!(driverCtx(), node, ARN);
    expect(denied.presence).toBe("inaccessible");
    expect(denied.attributes.status).toMatchObject({ state: "unknown", reason: "access_denied" });
    expect(driftOf(node, denied, driver.expectedAttributes!)[0].class).toBe("inaccessible");

    rds.on(DescribeDBInstancesCommand).rejects(awsError("Throttling", "Rate exceeded", 400));
    const throttled = await driver.observe!(driverCtx(), node, ARN);
    expect(throttled.presence).toBe("unknown");
    expect(throttled.attributes.status).toMatchObject({ state: "unknown", reason: "error" });
  });

  it("rethrows an abort instead of turning it into an observation", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(driver.observe!(driverCtx({ signal: ac.signal }), node, ARN)).rejects.toMatchObject({ name: "AbortError" });
    expect(rds.calls()).toHaveLength(0);
  });

  it("reports only a POINTER to the credential: no password-shaped value anywhere in the observation", async () => {
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [instance()] });
    const obs = await driver.observe!(driverCtx(), node, ARN);
    expect(JSON.stringify(obs)).not.toMatch(/password/i);
  });

  it("derives the MySQL major version with its minor", async () => {
    const my = mkNode("mysql/legacy", "mysql", postgresSpec({ engine: "mysql", version: "8.0" }), { dependsOn: ["subnet/private-a", "subnet/private-b"] });
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [instance({ Engine: "mysql", EngineVersion: "8.0.36", TagList: tagList("mysql/legacy") })] });
    const obs = await driver.observe!(driverCtx(), my, "zen-prod-db");
    expect(known(obs, "engineMajorVersion")).toBe("8.0");
    expect(driver.expectedAttributes!(my)).toMatchObject({ engine: "mysql", engineMajorVersion: "8.0" });
  });
});

describe("aws:rds_instance runtime", () => {
  it.each([
    ["available", "healthy"],
    ["backing-up", "degraded"],
    ["modifying", "degraded"],
    ["upgrading", "degraded"],
    ["creating", "degraded"],
    ["failed", "unhealthy"],
    ["storage-full", "unhealthy"],
    ["incompatible-parameters", "unhealthy"],
    ["stopped", "unhealthy"],
    ["some-new-status", "unknown"],
  ] as const)("status %s → %s", (status, health) => {
    expect(rdsHealthOf(status)).toBe(health);
  });

  it("reports status and pending modifications as signals, and counts only what it read", async () => {
    rds.on(DescribeDBInstancesCommand).resolves({
      DBInstances: [instance({ DBInstanceStatus: "available", PendingModifiedValues: { DBInstanceClass: "db.t4g.medium", AllocatedStorage: 50 }, ReadReplicaDBInstanceIdentifiers: ["r1"] })],
    });
    const rt = await driver.runtime!(driverCtx(), node, ARN);
    expect(rt).toMatchObject({ address: "postgres/db", health: "healthy", counts: { pendingModifications: 2, readReplicas: 1 }, source: "aws.rds_instance@1", simulated: false });
    expect(rt.signals).toEqual(["status:available", "pending_modification:AllocatedStorage", "pending_modification:DBInstanceClass"]);
  });

  it("maps NotFound to unhealthy/missing and AccessDenied to unknown", async () => {
    rds.on(DescribeDBInstancesCommand).rejects(awsError("DBInstanceNotFoundFault", "gone", 404));
    expect(await driver.runtime!(driverCtx(), node, ARN)).toMatchObject({ health: "unhealthy", signals: ["missing"] });
    rds.on(DescribeDBInstancesCommand).rejects(awsError("AccessDenied", "no", 403));
    expect(await driver.runtime!(driverCtx(), node, ARN)).toMatchObject({ health: "unknown", signals: ["read_failed:inaccessible:AccessDenied"] });
  });
});

describe("aws:rds_instance verify", () => {
  const verify = async (inst: DBInstance) => {
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [inst] });
    const ctx = driverCtx();
    const obs = await driver.observe!(ctx, node, ARN);
    return driver.verify!(ctx, node, obs, await driver.runtime!(ctx, node, ARN));
  };

  it("passes for an available, private, encrypted, spec-matching instance with a managed credential", async () => {
    const r = await verify(instance());
    expect(r.status).toBe("passed");
    expect(r.checks.map((c) => c.id)).toEqual(["exists", "available", "not_public", "encrypted", "credential_in_secrets_manager", "configuration_matches"]);
    expect(r.simulated).toBe(false);
  });

  it.each([
    ["public", instance({ PubliclyAccessible: true }), "not_public"],
    ["unencrypted", instance({ StorageEncrypted: false }), "encrypted"],
    ["not available", instance({ DBInstanceStatus: "modifying" }), "available"],
    ["credential outside Secrets Manager", instance({ MasterUserSecret: undefined }), "credential_in_secrets_manager"],
    ["drifted class", instance({ DBInstanceClass: "db.m6g.large" }), "configuration_matches"],
  ])("fails when %s", async (_name, inst, checkId) => {
    const r = await verify(inst);
    expect(r.status).toBe("failed");
    expect(r.checks.find((c) => c.id === checkId)!.passed).toBe(false);
  });

  it("is failed for a missing instance and unknown for an unreadable one", async () => {
    rds.on(DescribeDBInstancesCommand).rejects(awsError("DBInstanceNotFoundFault", "gone", 404));
    const ctx = driverCtx();
    const missing = await driver.verify!(ctx, node, await driver.observe!(ctx, node, ARN));
    expect(missing.status).toBe("failed");
    rds.on(DescribeDBInstancesCommand).rejects(awsError("AccessDenied", "no", 403));
    const denied = await driver.verify!(ctx, node, await driver.observe!(ctx, node, ARN));
    expect(denied.status).toBe("unknown");
  });
});

describe("aws:rds_instance discover", () => {
  it("lists PostgreSQL and MySQL instances only, marks Zenith-tagged ones and never adopts", async () => {
    rds.on(DescribeDBInstancesCommand).resolves({
      DBInstances: [
        instance(),
        instance({ DBInstanceIdentifier: "legacy", DBInstanceArn: ARN.replace("zen-prod-db", "legacy"), Engine: "mysql", EngineVersion: "8.0.36", TagList: [] }),
        instance({ DBInstanceIdentifier: "aur", DBInstanceArn: ARN.replace("zen-prod-db", "aur"), Engine: "aurora-postgresql" }),
        instance({ DBInstanceIdentifier: "maria", DBInstanceArn: ARN.replace("zen-prod-db", "maria"), Engine: "mariadb" }),
      ],
    });
    const found = await driver.discover!(driverCtx());
    expect(found.map((f) => [f.name, f.kind, f.zenithTagged])).toEqual([
      ["legacy", "mysql", false],
      ["zen-prod-db", "postgres", true],
    ]);
    expect(found[1]).toMatchObject({ provider: "aws", nativeType: "aws:rds_instance", externalId: ARN, region: "ap-south-1", attributes: { engine: "postgres", status: "available", publiclyAccessible: false } });
  });

  it("bounds pagination and propagates access denial as a thrown error for the caller", async () => {
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [instance()], Marker: "again" });
    await driver.discover!(driverCtx());
    expect(rds.commandCalls(DescribeDBInstancesCommand).length).toBeLessThanOrEqual(10);
    rds.reset();
    rds.on(DescribeDBInstancesCommand).rejects(awsError("AccessDenied", "no", 403));
    await expect(driver.discover!(driverCtx())).rejects.toMatchObject({ name: "AccessDenied" });
  });
});

describe("aws:rds_instance day-two operations", () => {
  const snapshot = driver.operations!["database.snapshot"];
  const OP = "op_snap_1";
  const snapId = snapshotIdentifierFor("zen-prod-db", OP);
  const snap = (over: Partial<DBSnapshot> = {}): DBSnapshot => ({ DBSnapshotIdentifier: snapId, DBInstanceIdentifier: "zen-prod-db", Status: "creating", DBSnapshotArn: `arn:aws:rds:ap-south-1:123456789012:snapshot:${snapId}`, Engine: "postgres", ...over });

  it("declares only database.snapshot as executable; restore and delete are refusing stubs", () => {
    expect(driver.capabilities.operations).toEqual(["database.snapshot"]);
    expect(Object.keys(driver.operations!).sort()).toEqual(["database.delete", "database.restore", "database.snapshot"]);
    expect(Object.keys(driver.capabilities.evidence).sort()).toEqual(["compile", "database.delete", "database.restore", "database.snapshot", "discover", "observe", "runtime", "verify"]);
  });

  it("derives a deterministic, valid snapshot id from the operation id", () => {
    expect(snapshotIdentifierFor("zen-prod-db", "op_a")).toBe(snapshotIdentifierFor("zen-prod-db", "op_a"));
    expect(snapshotIdentifierFor("zen-prod-db", "op_a")).not.toBe(snapshotIdentifierFor("zen-prod-db", "op_b"));
    expect(snapshotIdentifierFor("zen-prod-db", "op_a")).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
    expect(snapshotIdentifierFor("zen-prod-db", "op_a").length).toBeLessThanOrEqual(255);
  });

  it("takes a snapshot with the operation-derived id, Zenith tags and the fence token", async () => {
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [instance()] });
    rds.on(DescribeDBSnapshotsCommand).rejects(awsError("DBSnapshotNotFoundFault", "no snapshot", 404));
    rds.on(CreateDBSnapshotCommand).resolves({ DBSnapshot: snap(), $metadata: { requestId: "req-snap" } });
    const r = await snapshot(driverCtx({ operationId: OP, fence: { scope: "env:env_test", token: 42 } }), node, { externalId: "zen-prod-db" });
    expect(r).toMatchObject({ ok: true, simulated: false, requestIds: ["req-snap"], data: { snapshotIdentifier: snapId, instanceIdentifier: "zen-prod-db", created: true, status: "creating" } });
    const input = rds.commandCalls(CreateDBSnapshotCommand)[0].args[0].input;
    expect(input).toMatchObject({ DBInstanceIdentifier: "zen-prod-db", DBSnapshotIdentifier: snapId });
    const tags = Object.fromEntries((input.Tags ?? []).map((t) => [t.Key, t.Value]));
    expect(tags).toMatchObject({ "zenith:resource": "postgres/db", "zenith:environment": "env_test", "zenith:operation": OP, "zenith:fence": "env:env_test:42" });
  });

  it("is idempotent: a replay finds the existing snapshot and does not create a second", async () => {
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [instance()] });
    rds.on(DescribeDBSnapshotsCommand).resolves({ DBSnapshots: [snap({ Status: "available" })] });
    const r = await snapshot(driverCtx({ operationId: OP }), node, { externalId: ARN });
    expect(r).toMatchObject({ ok: true, data: { snapshotIdentifier: snapId, created: false, status: "available" } });
    expect(rds.commandCalls(CreateDBSnapshotCommand)).toHaveLength(0);
  });

  it("treats a concurrent duplicate (AlreadyExists on create) as success", async () => {
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [instance()] });
    rds.on(DescribeDBSnapshotsCommand).rejectsOnce(awsError("DBSnapshotNotFoundFault", "none", 404)).resolves({ DBSnapshots: [snap()] });
    rds.on(CreateDBSnapshotCommand).rejects(awsError("DBSnapshotAlreadyExistsFault", "exists", 400));
    const r = await snapshot(driverCtx({ operationId: OP }), node, { externalId: ARN });
    expect(r).toMatchObject({ ok: true, data: { created: false } });
  });

  it("refuses to reuse a snapshot id that belongs to a different instance", async () => {
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [instance()] });
    rds.on(DescribeDBSnapshotsCommand).resolves({ DBSnapshots: [snap({ DBInstanceIdentifier: "another-db" })] });
    const r = await snapshot(driverCtx({ operationId: OP }), node, { externalId: ARN });
    expect(r.ok).toBe(false);
    expect(rds.commandCalls(CreateDBSnapshotCommand)).toHaveLength(0);
  });

  it("refuses an instance that does not carry this node's Zenith tags, even when an id is supplied", async () => {
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [instance({ TagList: tagList("postgres/other") })] });
    const r = await snapshot(driverCtx({ operationId: OP }), node, { externalId: ARN });
    expect(r).toMatchObject({ ok: false });
    expect(r.summary).toMatch(/does not carry the Zenith tags/);
    expect(rds.commandCalls(CreateDBSnapshotCommand)).toHaveLength(0);
  });

  it("needs an operation id and a sane externalId, and reports provider failures as results, not throws", async () => {
    expect((await snapshot(driverCtx({ operationId: undefined }), node, {})).ok).toBe(false);
    expect((await snapshot(driverCtx({ operationId: OP }), node, { externalId: "s3://x" })).ok).toBe(false);
    rds.on(DescribeDBInstancesCommand).rejects(awsError("AccessDenied", "no", 403));
    const denied = await snapshot(driverCtx({ operationId: OP }), node, { externalId: ARN });
    expect(denied).toMatchObject({ ok: false, data: { failure: "inaccessible" } });
  });

  it.each(["database.restore", "database.delete"] as const)("%s is refused and makes no AWS call", async (capability) => {
    const r = await driver.operations![capability](driverCtx(), node, { externalId: ARN, snapshot: "s" });
    expect(r).toMatchObject({ ok: false, simulated: false, data: { refusedCapability: capability } });
    expect(r.summary).toMatch(/infrastructure plan and approval/);
    expect(rds.calls()).toHaveLength(0);
  });
});
