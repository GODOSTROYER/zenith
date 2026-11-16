import {
  BatchGetSecretValueCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { secretsManagerSecretDriver as driver, syncSecretValue } from "@/lib/providers/aws/drivers/data";
import { secretSyncToken } from "@/lib/providers/aws/drivers/data/secretsmanager-sync";
import { secretIdOf } from "@/lib/providers/aws/drivers/data/secretsmanager-secret";
import { driftOf } from "./_drift";
import { awsError, compileCtx, driverCtx, mkNode, tagList } from "./_helpers";

const sm = mockClient(SecretsManagerClient);
const tagging = mockClient(ResourceGroupsTaggingAPIClient);
beforeEach(() => {
  sm.reset();
  tagging.reset();
  // Any read of a secret VALUE is a test failure by construction.
  sm.on(GetSecretValueCommand).callsFake(() => {
    throw new Error("FORBIDDEN: GetSecretValue was called");
  });
  sm.on(BatchGetSecretValueCommand).callsFake(() => {
    throw new Error("FORBIDDEN: BatchGetSecretValue was called");
  });
});
afterAll(() => {
  sm.restore();
  tagging.restore();
});

const ADDRESS = "secret/api-key-deadbeef";
const node = mkNode(ADDRESS, "secret", { secretRef: "vault:ws_test/API_KEY", store: "zenith_vault", purpose: "environment" });
const ARN = "arn:aws:secretsmanager:ap-south-1:123456789012:secret:zenith/zen-prod-api-key-deadbeef-AbCdEf";
const compile = (n = node) => driver.compile!(n, compileCtx([n]));

describe("aws:secretsmanager_secret compile: the container only", () => {
  it("emits one secret and nothing else: no version, no value, no random password", () => {
    const f = compile();
    expect(f.addresses).toEqual(["aws_secretsmanager_secret.secret_api_key_deadbeef"]);
    expect(Object.keys(f.resource!)).toEqual(["aws_secretsmanager_secret"]);
    const body = (f.resource!.aws_secretsmanager_secret as Record<string, Record<string, unknown>>).secret_api_key_deadbeef;
    expect(body).toMatchObject({ name: "zenith/zen-prod-api-key-deadbeef", recovery_window_in_days: 7 });
    expect(body).not.toHaveProperty("kms_key_id"); // the AWS-managed default key
    expect(body).not.toHaveProperty("secret_string");
    expect((body.tags as Record<string, string>)["zenith:resource"]).toBe(ADDRESS);
    const text = JSON.stringify(f);
    for (const forbidden of ["secret_version", "secret_string", "secret_binary", "random_password", "vault:"]) expect(text).not.toContain(forbidden);
  });

  it("never copies the vault reference or any spec text into the fragment", () => {
    const canary = "vault:ws_test/CANARY_NAME_SHOULD_NOT_APPEAR";
    const text = JSON.stringify(compile(mkNode(ADDRESS, "secret", { secretRef: canary, store: "zenith_vault", purpose: "environment", value: "CANARY-VALUE" })));
    expect(text).not.toContain("CANARY");
  });

  it("publishes arn, id and name; is deterministic; referenced secrets compile to nothing", () => {
    expect(Object.keys(compile().locals!).sort()).toEqual(["ref_secret_api_key_deadbeef__arn", "ref_secret_api_key_deadbeef__id", "ref_secret_api_key_deadbeef__name"]);
    expect(JSON.stringify(compile())).toBe(JSON.stringify(compile()));
    const referenced = mkNode("secret/ext-00000000", "secret", { secretRef: "arn:aws:secretsmanager:ap-south-1:123456789012:secret:ext-x", store: "provider_secret_manager", purpose: "environment" }, { ownership: "referenced", externalRef: ARN });
    expect(compile(referenced)).toEqual({ addresses: [] });
  });
});

const describeOut = (over: Record<string, unknown> = {}) => ({
  ARN,
  Name: "zenith/zen-prod-api-key-deadbeef",
  Tags: tagList(ADDRESS),
  VersionIdsToStages: { v1: ["AWSCURRENT"] },
  LastChangedDate: new Date("2026-09-01T00:00:00Z"),
  ...over,
});

describe("aws:secretsmanager_secret observe: DescribeSecret only", () => {
  it("reads metadata, reports a value-synced container and never a value", async () => {
    sm.on(DescribeSecretCommand).resolves(describeOut());
    const obs = await driver.observe!(driverCtx(), node, ARN);
    expect(obs).toMatchObject({ presence: "present", externalId: ARN, source: "aws.secretsmanager_secret@1" });
    const v = (n: string) => (obs.attributes[n] as { value: unknown }).value;
    expect([v("pendingDeletion"), v("hasCurrentVersion"), v("versionCount"), v("kmsKey"), v("rotationEnabled")]).toEqual([false, true, 1, "aws/secretsmanager", false]);
    expect(obs.native).toMatchObject({ name: "zenith/zen-prod-api-key-deadbeef" });
    expect(driftOf(node, obs, driver.expectedAttributes!)).toEqual([]);
    expect(sm.commandCalls(DescribeSecretCommand)[0].args[0].input).toEqual({ SecretId: ARN });
    expect(sm.commandCalls(GetSecretValueCommand)).toHaveLength(0);
    expect(sm.commandCalls(BatchGetSecretValueCommand)).toHaveLength(0);
  });

  it("reports a secret scheduled for deletion as drift", async () => {
    sm.on(DescribeSecretCommand).resolves(describeOut({ DeletedDate: new Date("2026-09-20T00:00:00Z") }));
    const obs = await driver.observe!(driverCtx(), node, ARN);
    expect(driftOf(node, obs, driver.expectedAttributes!)[0].fields!.map((f) => f.attribute)).toEqual(["pendingDeletion"]);
  });

  it("finds the secret by Zenith tags through the tagging API when no id is known", async () => {
    sm.on(DescribeSecretCommand).resolves(describeOut());
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: ARN }] });
    expect((await driver.observe!(driverCtx(), node)).presence).toBe("present");
    expect(tagging.commandCalls(GetResourcesCommand)[0].args[0].input.ResourceTypeFilters).toEqual(["secretsmanager:secret"]);
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [] });
    expect((await driver.observe!(driverCtx(), node)).presence).toBe("missing");
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: ARN }, { ResourceARN: `${ARN}x` }] });
    expect((await driver.observe!(driverCtx(), node)).presence).toBe("unknown");
  });

  it("classifies ResourceNotFoundException as missing, AccessDenied as inaccessible, throttling as unknown", async () => {
    sm.on(DescribeSecretCommand).rejects(awsError("ResourceNotFoundException", "Secrets Manager can't find the specified secret.", 400));
    expect((await driver.observe!(driverCtx(), node, ARN)).presence).toBe("missing");
    sm.on(DescribeSecretCommand).rejects(awsError("AccessDeniedException", "no", 400));
    expect((await driver.observe!(driverCtx(), node, ARN)).presence).toBe("inaccessible");
    sm.on(DescribeSecretCommand).rejects(awsError("ThrottlingException", "slow", 400));
    expect((await driver.observe!(driverCtx(), node, ARN)).presence).toBe("unknown");
  });

  it("verify: passes with a current version, fails when the vault value was never synced", async () => {
    sm.on(DescribeSecretCommand).resolves(describeOut());
    const ctx = driverCtx();
    expect((await driver.verify!(ctx, node, await driver.observe!(ctx, node, ARN))).status).toBe("passed");
    sm.on(DescribeSecretCommand).resolves(describeOut({ VersionIdsToStages: {} }));
    const r = await driver.verify!(ctx, node, await driver.observe!(ctx, node, ARN));
    expect(r.status).toBe("failed");
    expect(r.checks.find((c) => c.id === "value_synced")!.passed).toBe(false);
  });

  it("discover: lists secrets, skips ones another AWS service owns, marks Zenith-tagged ones", async () => {
    sm.on(ListSecretsCommand).resolves({
      SecretList: [
        { ARN, Name: "zenith/zen-prod-api-key-deadbeef", Tags: tagList(ADDRESS) },
        { ARN: "arn:aws:secretsmanager:ap-south-1:123456789012:secret:rds!db-1-AbCdEf", Name: "rds!db-1", OwningService: "rds" },
        { ARN: "arn:aws:secretsmanager:ap-south-1:123456789012:secret:app-x-ZzZzZz", Name: "app-x" },
      ],
    });
    const found = await driver.discover!(driverCtx());
    expect(found.map((f) => [f.name, f.zenithTagged])).toEqual([
      ["app-x", false],
      ["zenith/zen-prod-api-key-deadbeef", true],
    ]);
  });

  it("parses secret ids strictly", () => {
    expect(secretIdOf(ARN)).toBe(ARN);
    expect(secretIdOf("prod/db-password")).toBe("prod/db-password");
    expect(secretIdOf("arn:aws:s3:::bucket")).toBeUndefined();
    expect(secretIdOf("has space")).toBeUndefined();
  });
});

describe("the driver module never reads a secret value", () => {
  it("contains no reference to the value-reading commands in any data-driver source file", () => {
    const dir = path.resolve(__dirname, "../../../../../src/lib/providers/aws/drivers/data");
    const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const text = readFileSync(path.join(f.parentPath, f.name), "utf8");
      expect(text, f.name).not.toMatch(/GetSecretValueCommand|BatchGetSecretValueCommand/);
    }
  });
});

/* --------------------------------- value sync ------------------------------- */

const CANARY = "CANARY-secret-value-9d41c7e2b0a84f6d-7777";
const OP = "op_sync_1";

function ownedSecret(over: Record<string, unknown> = {}) {
  sm.on(DescribeSecretCommand).resolves(describeOut(over));
}

describe("syncSecretValue", () => {
  it("writes the value with an idempotency token derived from operation id and value, and returns only the version id", async () => {
    ownedSecret();
    sm.on(PutSecretValueCommand).callsFake((input: { ClientRequestToken: string }) => ({ ARN, VersionId: input.ClientRequestToken, $metadata: { requestId: "req-put" } }));
    const ctx = driverCtx({ operationId: OP });
    const r = await syncSecretValue(ctx, node, async () => CANARY, { externalId: ARN });
    const token = secretSyncToken(OP, ADDRESS, CANARY);
    expect(r).toEqual({ ok: true, summary: "Wrote a new version of zenith/zen-prod-api-key-deadbeef.", versionId: token, requestId: "req-put" });
    const put = sm.commandCalls(PutSecretValueCommand)[0].args[0].input;
    expect(put).toEqual({ SecretId: ARN, SecretString: CANARY, ClientRequestToken: token });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(sm.commandCalls(GetSecretValueCommand)).toHaveLength(0);
  });

  it("derives a stable token per (operation, node, value): replays match, anything else differs", () => {
    const t = secretSyncToken(OP, ADDRESS, CANARY);
    expect(secretSyncToken(OP, ADDRESS, CANARY)).toBe(t);
    expect(secretSyncToken("op_other", ADDRESS, CANARY)).not.toBe(t);
    expect(secretSyncToken(OP, ADDRESS, `${CANARY}!`)).not.toBe(t);
    expect(secretSyncToken(OP, "secret/other-00000000", CANARY)).not.toBe(t);
    // a keyed token: it is NOT a plain hash of the value, so version ids (visible via DescribeSecret) cannot confirm a guess
    expect(t).not.toBe(createHash("sha256").update(CANARY).digest("hex"));
  });

  it("is idempotent on replay: the same operation sends the same token both times", async () => {
    ownedSecret();
    sm.on(PutSecretValueCommand).callsFake((input: { ClientRequestToken: string }) => ({ VersionId: input.ClientRequestToken }));
    const ctx = driverCtx({ operationId: OP });
    const a = await syncSecretValue(ctx, node, async () => CANARY, { externalId: ARN });
    const b = await syncSecretValue(ctx, node, async () => CANARY, { externalId: ARN });
    expect(a.versionId).toBe(b.versionId);
    const tokens = sm.commandCalls(PutSecretValueCommand).map((c) => c.args[0].input.ClientRequestToken);
    expect(new Set(tokens).size).toBe(1);
  });

  it("never leaks the value into logs, results, errors or tags, on success or on any failure", async () => {
    const outputs: unknown[] = [];
    const ctx = driverCtx({ operationId: OP });

    ownedSecret();
    sm.on(PutSecretValueCommand).resolves({ VersionId: "v2" });
    outputs.push(await syncSecretValue(ctx, node, async () => CANARY, { externalId: ARN }));

    // the SDK echoing the request body in its error message
    for (const name of ["AccessDeniedException", "ThrottlingException", "ResourceExistsException", "InvalidRequestException", "InternalServiceError"]) {
      sm.on(PutSecretValueCommand).rejects(awsError(name, `request failed: SecretString=${CANARY}`, 400));
      outputs.push(await syncSecretValue(ctx, node, async () => CANARY, { externalId: ARN }));
    }

    // the vault closure failing with the value in its message
    outputs.push(
      await syncSecretValue(ctx, node, async () => {
        throw new Error(`decrypt failed for ${CANARY}`);
      }, { externalId: ARN })
    );

    const text = JSON.stringify({ outputs, logs: ctx.logs });
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain(CANARY.slice(0, 24));
    // the value only ever appears in the PutSecretValue request body
    for (const call of sm.calls()) {
      const input = JSON.stringify((call.args[0] as { input: unknown }).input);
      if (call.args[0] instanceof PutSecretValueCommand) continue;
      expect(input).not.toContain(CANARY);
    }
    // and failures carry only a safe code
    expect(outputs.slice(1, 6).map((o) => (o as { failure: string }).failure)).toEqual(["access_denied", "throttled", "conflict", "error", "error"]);
  });

  it("never throws the value: a thrown-from-SDK non-AWS error still yields a value-free result", async () => {
    ownedSecret();
    sm.on(PutSecretValueCommand).callsFake(() => {
      throw new TypeError(`cannot serialize ${CANARY}`);
    });
    const ctx = driverCtx({ operationId: OP });
    const r = await syncSecretValue(ctx, node, async () => CANARY, { externalId: ARN });
    expect(r.ok).toBe(false);
    expect(JSON.stringify([r, ctx.logs])).not.toContain(CANARY);
  });

  it("does not even read the value when the target is missing, ambiguous, not Zenith's, or pending deletion", async () => {
    const cases: [string, () => void, string][] = [
      ["missing", () => sm.on(DescribeSecretCommand).rejects(awsError("ResourceNotFoundException", "gone", 400)), "target_missing"],
      ["not owned", () => ownedSecret({ Tags: tagList("secret/someone-else") }), "target_not_owned"],
      ["another environment", () => ownedSecret({ Tags: tagList(ADDRESS, { "zenith:environment": "env_other" }) }), "target_not_owned"],
      ["untagged", () => ownedSecret({ Tags: [] }), "target_not_owned"],
      ["pending deletion", () => ownedSecret({ DeletedDate: new Date() }), "target_pending_deletion"],
    ];
    for (const [name, arrange, failure] of cases) {
      sm.reset();
      arrange();
      let read = 0;
      const r = await syncSecretValue(driverCtx({ operationId: OP }), node, async () => {
        read++;
        return CANARY;
      }, { externalId: ARN });
      expect(r, name).toMatchObject({ ok: false, failure });
      expect(read, name).toBe(0);
      expect(sm.commandCalls(PutSecretValueCommand), name).toHaveLength(0);
    }
    // two secrets carry the tags
    sm.reset();
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: ARN }, { ResourceARN: `${ARN}2` }] });
    let read = 0;
    const r = await syncSecretValue(driverCtx({ operationId: OP }), node, async () => {
      read++;
      return CANARY;
    });
    expect(r).toMatchObject({ ok: false, failure: "target_ambiguous" });
    expect(read).toBe(0);
  });

  it("needs an operation id and refuses before touching AWS or the vault", async () => {
    let read = 0;
    const r = await syncSecretValue(driverCtx({ operationId: undefined }), node, async () => {
      read++;
      return CANARY;
    });
    expect(r).toMatchObject({ ok: false, failure: "no_operation_id" });
    expect(read).toBe(0);
    expect(sm.calls()).toHaveLength(0);
  });

  it.each([
    ["empty", ""],
    ["oversized", "x".repeat(65537)],
  ])("refuses a %s value without sending it", async (_n, value) => {
    ownedSecret();
    const r = await syncSecretValue(driverCtx({ operationId: OP }), node, async () => value, { externalId: ARN });
    expect(r).toMatchObject({ ok: false, failure: "value_invalid" });
    expect(sm.commandCalls(PutSecretValueCommand)).toHaveLength(0);
  });

  it("refuses a non-string value from the vault closure", async () => {
    ownedSecret();
    const r = await syncSecretValue(driverCtx({ operationId: OP }), node, (async () => 42) as unknown as () => Promise<string>, { externalId: ARN });
    expect(r).toMatchObject({ ok: false, failure: "value_invalid" });
  });

  it("finds the secret by tags when no id is given, then writes to its ARN", async () => {
    ownedSecret();
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: ARN }] });
    sm.on(PutSecretValueCommand).resolves({ VersionId: "v9" });
    const r = await syncSecretValue(driverCtx({ operationId: OP }), node, async () => CANARY);
    expect(r).toMatchObject({ ok: true, versionId: "v9" });
    expect(sm.commandCalls(PutSecretValueCommand)[0].args[0].input.SecretId).toBe(ARN);
  });

  it("rethrows an abort instead of reporting a result", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(syncSecretValue(driverCtx({ operationId: OP, signal: ac.signal }), node, async () => CANARY, { externalId: ARN })).rejects.toMatchObject({ name: "AbortError" });
    expect(sm.calls()).toHaveLength(0);
  });

  it("the driver declares no value-writing operation: values are not a catalog capability here", () => {
    expect(driver.operations).toBeUndefined();
    expect(driver.capabilities.operations).toEqual([]);
  });
});
