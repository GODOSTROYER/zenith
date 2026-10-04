/** Native IAM SDK commands with explicit modeled replies. No cloud authorization evidence. */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { GetPolicyCommand, GetPolicyVersionCommand, GetRoleCommand, IAMClient, NoSuchEntityException, type Policy, type Role } from "@aws-sdk/client-iam";
import { awsBootstrapPreflightSessionPolicy, preflightAwsBootstrap, type AwsBootstrapRoleInventory } from "@/lib/credentials/aws/bootstrap-preflight";
import { SessionPolicyError, validateSessionPolicy } from "@/lib/credentials/aws/policy";
import { AWS_ROLE_BOUNDARIES, awsBootstrapContextForConnection, resolveAwsRoleBoundaries, type AwsRoleFamily } from "@/lib/credentials/aws/naming";
import { createRunnerAwsSession } from "@/lib/credentials/aws/session";
import type { AwsConnectionConfig } from "@/lib/credentials/types";
import { POLICIES_DIR, TEMPLATE_PATH } from "../../../deploy/aws/tools/generate-tofu-policies";
import { loadTemplate, makeEvaluator, resolveResource } from "../cfn";

const iam = mockClient(IAMClient);
const FAMILIES = ["app", "build", "machine", "scheduler", "eksCluster", "eksNode"] as const;
const CONFIG: AwsConnectionConfig = {
  provider: "aws", mode: "runner", accountId: "123456789012", region: "us-east-1", bootstrapNameSuffix: "-team-a",
  observeRoleArn: "arn:aws:iam::123456789012:role/ZenithObserveRole-team-a",
  deployRoleArn: "arn:aws:iam::123456789012:role/ZenithDeployRole-team-a", stateBucket: "zenith-state-123456789012-us-east-1",
};
const INVENTORY: AwsBootstrapRoleInventory = { workspaceId: "ws-alpha", environmentId: "env-alpha", roleArns: [] };
const arnFor = (family: AwsRoleFamily, config = CONFIG): string => resolveAwsRoleBoundaries(awsBootstrapContextForConnection(config))[family];
const legacyArn = (config = CONFIG): string => `arn:aws:iam::${config.accountId}:policy/ZenithWorkloadBoundary${config.bootstrapNameSuffix ?? ""}`;
const roleArn = (family: AwsRoleFamily): string => `arn:aws:iam::${CONFIG.accountId}:role/zenith-env-alpha-service${AWS_ROLE_BOUNDARIES[family].suffixes[0]}`;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function session() {
  // Existing scoped session implementation with a modeled native SDK runner transport; no keys.
  return createRunnerAwsSession({
    accountId: CONFIG.accountId, region: CONFIG.region, expiresAt: new Date("2099-01-01T00:00:00Z"), now: () => new Date("2026-10-04T00:00:00Z"),
    transport: { client: (ctor, overrides) => new ctor({ region: overrides?.region ?? CONFIG.region }) },
  });
}

function metadata(arn: string): Policy {
  return { Arn: arn, PolicyName: arn.slice(arn.lastIndexOf("/") + 1), Path: "/", PolicyId: "ANPA12345678901234567", IsAttachable: true, DefaultVersionId: "v3" };
}

function cfnDocument(family: AwsRoleFamily, config = CONFIG): Record<string, unknown> {
  const template = loadTemplate(TEMPLATE_PATH);
  const evaluator = makeEvaluator(template, {
    params: { NameSuffix: config.bootstrapNameSuffix ?? "" }, pseudo: { partition: "aws", accountId: config.accountId, region: config.region },
    resourceOverrides: { StateBucket: { ref: config.stateBucket!, attrs: { Arn: `arn:aws:s3:::${config.stateBucket}` } } },
  });
  const document: unknown = resolveResource(template, evaluator, AWS_ROLE_BOUNDARIES[family].logicalId)?.PolicyDocument;
  if (!record(document)) throw new Error("Invalid committed policy fixture.");
  return document;
}

function model(config = CONFIG): void {
  for (const family of FAMILIES) {
    const arn = arnFor(family, config);
    iam.on(GetPolicyCommand, { PolicyArn: arn }).resolves({ Policy: metadata(arn) });
    iam.on(GetPolicyVersionCommand, { PolicyArn: arn, VersionId: "v3" }).resolves({ PolicyVersion: { Document: encodeURIComponent(JSON.stringify(cfnDocument(family, config))), VersionId: "v3", IsDefaultVersion: true } });
  }
  iam.on(GetPolicyCommand, { PolicyArn: legacyArn(config) }).resolves({ Policy: metadata(legacyArn(config)) });
}

function ownedRole(family: AwsRoleFamily, boundary = arnFor(family)): Role {
  const arn = roleArn(family);
  return {
    Arn: arn, RoleName: arn.slice(arn.lastIndexOf("/") + 1), Path: "/", RoleId: "AROA12345678901234567", CreateDate: new Date("2026-10-04T00:00:00Z"),
    Tags: [{ Key: "zenith:managed", Value: "true" }, { Key: "zenith:workspace", Value: INVENTORY.workspaceId }, { Key: "zenith:environment", Value: INVENTORY.environmentId }],
    PermissionsBoundary: { PermissionsBoundaryType: "PermissionsBoundaryPolicy", PermissionsBoundaryArn: boundary },
  };
}

function modelRole(family: AwsRoleFamily, role = ownedRole(family)): void {
  iam.on(GetRoleCommand, { RoleName: ownedRole(family).RoleName }).resolves({ Role: role });
}

function missing(): NoSuchEntityException {
  return new NoSuchEntityException({ $metadata: {}, message: "Modeled missing entity." });
}

beforeEach(() => iam.reset());
afterAll(() => iam.restore());

describe("read-only AWS bootstrap preflight", () => {
  it("derives a dedicated exact-ARN read policy for the existing broker API without write actions or wildcards", () => {
    const inventory = { ...INVENTORY, roleArns: [roleArn("build"), roleArn("app")] };
    const policy = awsBootstrapPreflightSessionPolicy(CONFIG, inventory);
    expect(policy).toEqual({ Version: "2012-10-17", Statement: [
      { Effect: "Allow", Action: ["iam:GetPolicy", "iam:GetPolicyVersion"], Resource: [...FAMILIES.map((family) => arnFor(family)), legacyArn()] },
      { Effect: "Allow", Action: "iam:GetRole", Resource: inventory.roleArns.sort() },
    ] });
    expect(validateSessionPolicy(policy).length).toBeLessThanOrEqual(2048);
    expect(JSON.stringify(policy)).not.toContain("*");
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.Statement)).toBe(true);
    expect(iam.calls()).toHaveLength(0);
  });

  it("fails the dedicated session policy closed at the STS size limit and on foreign inventories", () => {
    const config = { ...CONFIG, bootstrapNameSuffix: `-${"a".repeat(19)}` };
    const roleArns = Array.from({ length: 32 }, (_, index) => `arn:aws:iam::123456789012:role/zenith-env-alpha-${index}-role`);
    expect(() => awsBootstrapPreflightSessionPolicy(config, { ...INVENTORY, roleArns })).toThrow(SessionPolicyError);
    expect(() => awsBootstrapPreflightSessionPolicy(CONFIG, { ...INVENTORY, roleArns: [roleArn("app").replace(CONFIG.accountId, "210987654321")] })).toThrow("AWS bootstrap preflight scope is invalid.");
    expect(iam.calls()).toHaveLength(0);
  });

  it.each(["", `-${"a".repeat(19)}`])("fits a six-family role inventory into the narrow read policy with suffix %j", (bootstrapNameSuffix) => {
    const policy = awsBootstrapPreflightSessionPolicy({ ...CONFIG, bootstrapNameSuffix }, { ...INVENTORY, roleArns: FAMILIES.map(roleArn) });
    expect(validateSessionPolicy(policy).length).toBeLessThanOrEqual(2048);
  });

  it("reads all six exact default versions through a scoped session and returns no document or credentials", async () => {
    model();
    for (const family of FAMILIES) modelRole(family);
    const handle = session();
    const childEnv = vi.spyOn(handle.session, "childProcessEnv");
    const output = await preflightAwsBootstrap(handle.session, CONFIG, { ...INVENTORY, roleArns: FAMILIES.map(roleArn).reverse() });
    expect(output.status).toBe("readback_compatible");
    expect(output.families.map((item) => item.family)).toEqual(FAMILIES);
    expect(output.roles.map((item) => item.roleArn)).toEqual(FAMILIES.map(roleArn).sort());
    expect(iam.commandCalls(GetPolicyCommand)).toHaveLength(13);
    expect(iam.commandCalls(GetPolicyVersionCommand)).toHaveLength(6);
    expect(iam.commandCalls(GetRoleCommand)).toHaveLength(6);
    expect(childEnv).not.toHaveBeenCalled();
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.families)).toBe(true);
    expect(output.families.every((item) => Object.isFrozen(item) && item.policySize! <= 6144 && item.defaultVersionId === "v3")).toBe(true);
    const serialized = JSON.stringify(output);
    for (const forbidden of ["Document", "Statement", "Action", "Resource", "sessionToken", "secretAccessKey", "accessKeyId"]) expect(serialized).not.toContain(forbidden);
    expect(iam.calls().every((call) => call.args[0] instanceof GetPolicyCommand || call.args[0] instanceof GetPolicyVersionCommand || call.args[0] instanceof GetRoleCommand)).toBe(true);
    handle.revoke();
  });

  it.each(["", `-${"a".repeat(19)}`])("uses the saved suffix %j exactly rather than the legacy override", async (bootstrapNameSuffix) => {
    const config = { ...CONFIG, bootstrapNameSuffix, permissionsBoundaryArn: "arn:aws:iam::123456789012:policy/unrelated" };
    model(config);
    const output = await preflightAwsBootstrap(session().session, config, INVENTORY);
    expect(output.status).toBe("readback_compatible");
    expect(output.families.map((item) => item.policyArn)).toEqual(FAMILIES.map((family) => arnFor(family, config)));
    expect(iam.commandCalls(GetPolicyCommand).every((call) => call.args[0].input.PolicyArn?.endsWith(bootstrapNameSuffix))).toBe(true);
  });

  it("bounds native SDK sends to 51 for 32 roles and shares one abort signal", async () => {
    model();
    const roles = Array.from({ length: 32 }, (_, index) => `arn:aws:iam::${CONFIG.accountId}:role/zenith-env-alpha-${index}-role`);
    for (const arn of roles) {
      const Role = { ...ownedRole("app"), Arn: arn, RoleName: arn.slice(arn.lastIndexOf("/") + 1) };
      iam.on(GetRoleCommand, { RoleName: Role.RoleName }).resolves({ Role });
    }
    expect((await preflightAwsBootstrap(session().session, CONFIG, { ...INVENTORY, roleArns: roles })).status).toBe("readback_compatible");
    expect(iam.calls()).toHaveLength(51);
    const firstArgs: readonly unknown[] = iam.calls()[0].args;
    const options: unknown = firstArgs[1];
    if (!record(options) || !(options.abortSignal instanceof AbortSignal)) throw new Error("Missing native request bound.");
    for (const call of iam.calls()) {
      const args: readonly unknown[] = call.args;
      expect(args[1]).toEqual({ abortSignal: options.abortSignal });
    }
  });

  it("captures native inventory before awaited reads so later caller mutation cannot change its owning tags", async () => {
    model();
    modelRole("app");
    const inventory = { ...INVENTORY, roleArns: [roleArn("app")] };
    const arn = arnFor("app");
    iam.on(GetPolicyCommand, { PolicyArn: arn }).callsFake(() => {
      inventory.workspaceId = "ws-other";
      inventory.roleArns.length = 0;
      return { Policy: metadata(arn) };
    });
    const output = await preflightAwsBootstrap(session().session, CONFIG, inventory);
    expect(output.status).toBe("readback_compatible");
    expect(output.roles).toHaveLength(1);
    expect(JSON.stringify(output)).not.toContain("ws-other");
  });

  it.each(FAMILIES)("accepts the paired committed CloudFormation and generated OpenTofu family discriminator for %s", async (family) => {
    model();
    const document = fs.readFileSync(path.join(POLICIES_DIR, `${AWS_ROLE_BOUNDARIES[family].template}.json.tftpl`), "utf8")
      .replaceAll("${partition}", "aws").replaceAll("${account_id}", CONFIG.accountId)
      .replaceAll("${state_bucket_arn}", `arn:aws:s3:::${CONFIG.stateBucket}`).replaceAll("${environment_tag_value}", "*").replaceAll("${dns_suffix}", "amazonaws.com");
    expect(JSON.parse(document)).toEqual(cfnDocument(family));
    iam.on(GetPolicyVersionCommand, { PolicyArn: arnFor(family), VersionId: "v3" }).resolves({ PolicyVersion: { Document: document, VersionId: "v3", IsDefaultVersion: true } });
    expect((await preflightAwsBootstrap(session().session, CONFIG, INVENTORY)).status).toBe("readback_compatible");
  });

  it("requires the stack upgrade when a family is absent and keeps the legacy policy in the migration checklist", async () => {
    model();
    iam.on(GetPolicyCommand, { PolicyArn: arnFor("machine") }).rejects(missing());
    const output = await preflightAwsBootstrap(session().session, CONFIG, INVENTORY);
    expect(output).toMatchObject({ status: "needs_stack_upgrade", code: "policy_missing", legacyPolicy: "present" });
    expect(output.checklist.join(" ")).toContain("Never detach a boundary");
    expect(output.checklist[1]).toContain("stack");
  });

  it("distinguishes a missing policy after capture from a stack that has not been upgraded", async () => {
    model();
    const arn = arnFor("app");
    iam.on(GetPolicyCommand, { PolicyArn: arn }).resolvesOnce({ Policy: metadata(arn) }).rejects(missing());
    expect(await preflightAwsBootstrap(session().session, CONFIG, INVENTORY)).toMatchObject({ status: "conflict", code: "policy_changed" });
  });

  it.each([
    { Arn: arnFor("app").replace(CONFIG.accountId, "210987654321") },
    { Arn: arnFor("app").replace("arn:aws:", "arn:aws-cn:") },
    { Arn: arnFor("app").replace("-team-a", "-other") },
    { PolicyName: AWS_ROLE_BOUNDARIES.build.policyName }, { Path: "/foreign/" }, { IsAttachable: false },
    { PolicyId: "short" }, { DefaultVersionId: "V1" }, { DefaultVersionId: "v0" }, { DefaultVersionId: `v${"1".repeat(64)}` },
  ])("refuses malformed or foreign policy metadata without echoing it: %j", async (over) => {
    model();
    iam.on(GetPolicyCommand, { PolicyArn: arnFor("app") }).resolves({ Policy: { ...metadata(arnFor("app")), ...over } });
    expect(await preflightAwsBootstrap(session().session, CONFIG, INVENTORY)).toMatchObject({ status: "conflict", code: "policy_identity" });
  });

  it.each([{ VersionId: "v4", IsDefaultVersion: true }, { VersionId: "v3", IsDefaultVersion: false }])("refuses a mismatched default version %j", async (over) => {
    model();
    iam.on(GetPolicyVersionCommand, { PolicyArn: arnFor("app"), VersionId: "v3" }).resolves({ PolicyVersion: { Document: JSON.stringify(cfnDocument("app")), ...over } });
    expect(await preflightAwsBootstrap(session().session, CONFIG, INVENTORY)).toMatchObject({ status: "conflict", code: "policy_version" });
  });

  it.each([{ DefaultVersionId: "v4" }, { PolicyId: "ANPA98765432109876543" }])("refuses default replacement or policy recreation during readback %j", async (over) => {
    model();
    const arn = arnFor("app");
    iam.on(GetPolicyCommand, { PolicyArn: arn }).resolvesOnce({ Policy: metadata(arn) }).resolves({ Policy: { ...metadata(arn), ...over } });
    expect(await preflightAwsBootstrap(session().session, CONFIG, INVENTORY)).toMatchObject({ status: "conflict", code: "policy_changed" });
  });

  it.each(["%", "%E0%A4%A", "not-json", "[]", encodeURIComponent(encodeURIComponent(JSON.stringify(cfnDocument("app")))), "x".repeat(131073), JSON.stringify({ Version: "2012-10-17", Statement: [], marker: "\u0100" })])("bounds malformed or multiply encoded documents without retaining their values", async (Document) => {
    model();
    iam.on(GetPolicyVersionCommand, { PolicyArn: arnFor("app"), VersionId: "v3" }).resolves({ PolicyVersion: { Document, VersionId: "v3", IsDefaultVersion: true } });
    expect(await preflightAwsBootstrap(session().session, CONFIG, INVENTORY)).toMatchObject({ status: "conflict", code: "policy_document" });
  });

  it("enforces the 6144-character managed-policy ceiling and bounded JSON nesting", async () => {
    model();
    const large = { ...cfnDocument("app"), marker: Array.from({ length: 16 }, () => "x".repeat(512)) };
    iam.on(GetPolicyVersionCommand, { PolicyArn: arnFor("app"), VersionId: "v3" }).resolves({ PolicyVersion: { Document: JSON.stringify(large), VersionId: "v3", IsDefaultVersion: true } });
    expect(await preflightAwsBootstrap(session().session, CONFIG, INVENTORY)).toMatchObject({ status: "conflict", code: "policy_size" });
    let nested: unknown = "value";
    for (let index = 0; index < 15; index++) nested = { nested };
    iam.on(GetPolicyVersionCommand, { PolicyArn: arnFor("app"), VersionId: "v3" }).resolves({ PolicyVersion: { Document: JSON.stringify({ ...cfnDocument("app"), nested }), VersionId: "v3", IsDefaultVersion: true } });
    expect(await preflightAwsBootstrap(session().session, CONFIG, INVENTORY)).toMatchObject({ status: "conflict", code: "policy_document" });
  });

  it.each([6144, 6145])("admits the exact quota boundary and refuses one character beyond it: %i", async (size) => {
    model();
    const document = { ...cfnDocument("app"), Id: "" };
    document.Id = "a".repeat(size - JSON.stringify(document).replace(/\s+/g, "").length);
    const Document = JSON.stringify(document, null, 2);
    expect(JSON.stringify(document).replace(/\s+/g, "").length).toBe(size);
    iam.on(GetPolicyVersionCommand, { PolicyArn: arnFor("app"), VersionId: "v3" }).resolves({ PolicyVersion: { Document, VersionId: "v3", IsDefaultVersion: true } });
    const output = await preflightAwsBootstrap(session().session, CONFIG, INVENTORY);
    expect(output.status).toBe(size === 6144 ? "readback_compatible" : "conflict");
    expect(output.families[0]).toMatchObject({ policySize: size, code: size === 6144 ? "compatible" : "policy_size" });
  });

  it.each(["build", "machine", "scheduler", "eksCluster", "eksNode"] as const)("refuses another family's document at the app ARN: %s", async (family) => {
    model();
    iam.on(GetPolicyVersionCommand, { PolicyArn: arnFor("app"), VersionId: "v3" }).resolves({ PolicyVersion: { Document: JSON.stringify(cfnDocument(family)), VersionId: "v3", IsDefaultVersion: true } });
    expect(await preflightAwsBootstrap(session().session, CONFIG, INVENTORY)).toMatchObject({ status: "conflict", code: "policy_family" });
  });

  it("refuses a removed family deny or a foreign-account principal discriminator", async () => {
    model();
    const original = JSON.stringify(cfnDocument("scheduler"));
    iam.on(GetPolicyVersionCommand, { PolicyArn: arnFor("scheduler"), VersionId: "v3" }).resolves({ PolicyVersion: { Document: original.replaceAll("ArnNotLike", "ArnLike"), VersionId: "v3", IsDefaultVersion: true } });
    expect(await preflightAwsBootstrap(session().session, CONFIG, INVENTORY)).toMatchObject({ status: "conflict", code: "policy_family" });
    iam.on(GetPolicyVersionCommand, { PolicyArn: arnFor("scheduler"), VersionId: "v3" }).resolves({ PolicyVersion: { Document: original.replaceAll(CONFIG.accountId, "210987654321"), VersionId: "v3", IsDefaultVersion: true } });
    expect(await preflightAwsBootstrap(session().session, CONFIG, INVENTORY)).toMatchObject({ status: "conflict", code: "policy_family" });
  });

  it.each(FAMILIES)("maps an owned legacy role to its exact %s boundary without planning a detach", async (family) => {
    model();
    modelRole(family, ownedRole(family, legacyArn()));
    const output = await preflightAwsBootstrap(session().session, CONFIG, { ...INVENTORY, roleArns: [roleArn(family)] });
    expect(output.status).toBe("migration_required");
    expect(output.roles).toEqual([{ roleArn: roleArn(family), family, expectedBoundaryArn: arnFor(family), status: "migration_required", code: "legacy_boundary" }]);
  });

  it.each([
    { Arn: roleArn("app").replace(CONFIG.accountId, "210987654321") }, { Path: "/foreign/" }, { RoleId: "short" },
    { Tags: [{ Key: "zenith:managed", Value: "true" }, { Key: "zenith:workspace", Value: "ws-other" }, { Key: "zenith:environment", Value: INVENTORY.environmentId }] },
    { Tags: [{ Key: "zenith:managed", Value: "true" }, { Key: "zenith:workspace", Value: INVENTORY.workspaceId }, { Key: "zenith:environment", Value: "env-alpha-other" }] },
    { Tags: [{ Key: "zenith:managed", Value: "false" }] }, { PermissionsBoundary: undefined },
    { PermissionsBoundary: { PermissionsBoundaryType: "PermissionsBoundaryPolicy", PermissionsBoundaryArn: arnFor("build") } },
    { PermissionsBoundary: { PermissionsBoundaryType: "PermissionsBoundaryPolicy", PermissionsBoundaryArn: arnFor("app").replace(CONFIG.accountId, "210987654321") } },
  ] satisfies Partial<Role>[])("refuses foreign ownership, identity and boundary mappings %j", async (over) => {
    model();
    modelRole("app", { ...ownedRole("app"), ...over });
    expect((await preflightAwsBootstrap(session().session, CONFIG, { ...INVENTORY, roleArns: [roleArn("app")] })).status).toBe("conflict");
  });

  it("treats a deleted role or absent legacy policy still reported on a role as a conflict", async () => {
    model();
    iam.on(GetRoleCommand, { RoleName: ownedRole("app").RoleName }).rejects(missing());
    expect(await preflightAwsBootstrap(session().session, CONFIG, { ...INVENTORY, roleArns: [roleArn("app")] })).toMatchObject({ status: "conflict", code: "role_missing" });
    modelRole("app", ownedRole("app", legacyArn()));
    iam.on(GetPolicyCommand, { PolicyArn: legacyArn() }).rejects(missing());
    expect((await preflightAwsBootstrap(session().session, CONFIG, { ...INVENTORY, roleArns: [roleArn("app")] })).status).toBe("conflict");
  });

  it.each([
    { accountId: "210987654321" }, { observeRoleArn: CONFIG.observeRoleArn.replace("arn:aws:", "arn:aws-cn:") },
    { deployRoleArn: CONFIG.deployRoleArn.replace("arn:aws:", "arn:aws-us-gov:") }, { region: "cn-north-1" },
    { bootstrapNameSuffix: "-A" }, { bootstrapNameSuffix: `-${"a".repeat(20)}` },
    { endpoint: "http://localhost:4566" }, { mode: "static_dev" },
  ] satisfies Partial<AwsConnectionConfig>[])("refuses invalid saved account, partition or suffix before any SDK call %j", async (over) => {
    expect(await preflightAwsBootstrap(session().session, { ...CONFIG, ...over }, INVENTORY)).toMatchObject({ status: "conflict", code: "invalid_scope" });
    expect(iam.calls()).toHaveLength(0);
  });

  it.each([
    { roleArns: [roleArn("app").replace(CONFIG.accountId, "210987654321")] },
    { roleArns: [roleArn("app").replace("arn:aws:", "arn:aws-us-gov:")] },
    { roleArns: [roleArn("app").replace(":role/", ":role/foreign/")] },
    { roleArns: ["arn:aws:iam::123456789012:role/customer-role"] },
    { roleArns: [roleArn("app"), roleArn("app")] },
    { roleArns: Array.from({ length: 33 }, (_, index) => `arn:aws:iam::123456789012:role/zenith-env-alpha-${index}-role`) },
    { workspaceId: "ws/*" }, { environmentId: "env/*" },
  ])("refuses unbounded or foreign role inventory before any SDK call %j", async (over) => {
    expect(await preflightAwsBootstrap(session().session, CONFIG, { ...INVENTORY, ...over })).toMatchObject({ status: "conflict", code: "invalid_scope" });
    expect(iam.calls()).toHaveLength(0);
  });

  it("sanitizes denied reads and revoked sessions without credentials, policy values or error text", async () => {
    model();
    const marker = "modeled-sensitive-value";
    iam.on(GetPolicyCommand, { PolicyArn: arnFor("app") }).rejects(new Error(marker));
    const output = await preflightAwsBootstrap(session().session, CONFIG, INVENTORY);
    expect(output).toMatchObject({ status: "unavailable", code: "read_unavailable" });
    expect(JSON.stringify(output)).not.toContain(marker);
    const handle = session();
    handle.revoke();
    expect(await preflightAwsBootstrap(handle.session, CONFIG, INVENTORY)).toMatchObject({ status: "unavailable", code: "session_unavailable" });
  });

  it("refuses a scoped session for another account before constructing an IAM client", async () => {
    const handle = createRunnerAwsSession({
      accountId: "210987654321", region: CONFIG.region, expiresAt: new Date("2099-01-01T00:00:00Z"), now: () => new Date("2026-10-04T00:00:00Z"),
      transport: { client: (ctor) => new ctor({ region: CONFIG.region }) },
    });
    expect(await preflightAwsBootstrap(handle.session, CONFIG, INVENTORY)).toMatchObject({ status: "conflict", code: "invalid_scope" });
    expect(iam.calls()).toHaveLength(0);
    handle.revoke();
  });
});
