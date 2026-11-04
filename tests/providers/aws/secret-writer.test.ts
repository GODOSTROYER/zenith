/** Mocked SDK contract and real broker policy logic; no cloud access. */
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { DescribeSecretCommand, PutSecretValueCommand, SecretsManagerClient, UpdateSecretVersionStageCommand, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { writeAwsSecret } from "@/lib/providers/aws/secret-writer";
import { secretWritePolicy } from "@/lib/credentials/aws/secret-policy";
import { AwsCredentialBroker } from "@/lib/credentials/aws/broker";
import type { AwsClientCtor, AwsSession } from "@/lib/credentials/types";
import { connection, grant, FAKE_CREDS } from "../../credentials/helpers";

const sm = mockClient(SecretsManagerClient);
const sts = mockClient(STSClient);
const CANARY = "delivery-canary-CLOUD-SECRET-77";
const arn = "arn:aws:secretsmanager:ap-south-1:123456789012:secret:zenith/zenith-env1-api-key-abcdef";
const node = { address: "secret/api-key", kind: "secret" as const, provider: "aws" as const, region: "ap-south-1", nativeType: "aws:secretsmanager_secret", ownership: "managed" as const, spec: { secretRef: "vault:API_KEY" }, origin: [], dependsOn: [], specDigest: "digest", labels: {} };
const tags = [{ Key: "zenith:managed", Value: "true" }, { Key: "zenith:workspace", Value: "ws1" }, { Key: "zenith:environment", Value: "env1" }, { Key: "zenith:resource", Value: node.address }];
const session: AwsSession = { provider: "aws", region: node.region, accountId: "123456789012", transport: "direct", expiresAt: "2099-01-01", childProcessEnv: () => ({}), client: <C>(ctor: AwsClientCtor<C>) => new ctor({ region: node.region }) };
const input = () => ({ node, secretArn: arn, workspaceId: "ws1", environmentId: "env1", projectId: "proj1", fingerprintKey: "private-test-fingerprint-key", resolve: async () => CANARY });
beforeEach(() => { sm.reset(); sts.reset(); sm.on(DescribeSecretCommand).resolves({ ARN: arn, Tags: tags, VersionIdsToStages: {} }); sm.on(PutSecretValueCommand).resolves({}); sm.on(UpdateSecretVersionStageCommand).resolves({}); });

describe("AWS value writer", () => {
  it("writes exact ARN, skips unchanged content across operations, and promotes a previous version", async () => {
    const first = await writeAwsSecret(session, input());
    expect(sm.commandCalls(PutSecretValueCommand)[0].args[0].input).toMatchObject({ SecretId: arn, SecretString: CANARY, ClientRequestToken: first.versionId });
    expect(first.versionId).toMatch(/^[a-f0-9]{64}$/);
    sm.on(DescribeSecretCommand).resolves({ ARN: arn, Tags: tags, VersionIdsToStages: { [first.versionId!]: ["AWSCURRENT"] } });
    expect(await writeAwsSecret(session, input())).toEqual({ changed: false, versionId: first.versionId });
    expect(sm.commandCalls(PutSecretValueCommand)).toHaveLength(1);
    sm.on(DescribeSecretCommand).resolves({ ARN: arn, Tags: tags, VersionIdsToStages: { [first.versionId!]: ["AWSPREVIOUS"], other: ["AWSCURRENT"] } });
    expect(await writeAwsSecret(session, input())).toMatchObject({ changed: true });
    expect(sm.commandCalls(UpdateSecretVersionStageCommand)[0].args[0].input).toMatchObject({ SecretId: arn, MoveToVersionId: first.versionId, RemoveFromVersionId: "other" });
    expect(sm.commandCalls(GetSecretValueCommand)).toHaveLength(0);
    expect(JSON.stringify(first)).not.toContain(CANARY);
  });
  it("changes the keyed token on value rotation and does not expose provider version ids", async () => {
    const first = await writeAwsSecret(session, input());
    sm.on(PutSecretValueCommand).resolves({ VersionId: CANARY });
    const second = await writeAwsSecret(session, { ...input(), resolve: async () => "rotated" });
    expect(second.versionId).not.toBe(first.versionId);
    expect(JSON.stringify(second)).not.toContain(CANARY);
  });
  it.each(["foreign-workspace", "deleted", "foreign-arn", "runner"])("refuses %s before resolving", async (caseName) => {
    let reads = 0;
    if (caseName === "foreign-workspace") sm.on(DescribeSecretCommand).resolves({ ARN: arn, Tags: tags.map((t) => t.Key === "zenith:workspace" ? { ...t, Value: "foreign" } : t) });
    if (caseName === "deleted") sm.on(DescribeSecretCommand).resolves({ ARN: arn, Tags: tags, DeletedDate: new Date() });
    const error = await writeAwsSecret(caseName === "runner" ? { ...session, transport: "runner" } : session, { ...input(), secretArn: caseName === "foreign-arn" ? arn.replace("env1", "env2") : arn, resolve: async () => { reads++; return CANARY; } }).catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: caseName === "runner" ? "unsupported" : "denied" });
    expect(reads).toBe(0); expect(sm.commandCalls(PutSecretValueCommand)).toHaveLength(0);
  });
  it.each([["AccessDeniedException", "denied"], ["ThrottlingException", "throttled"], [CANARY, "unreachable"]])("classifies %s and never echoes external errors", async (name, reason) => {
    sm.on(PutSecretValueCommand).rejects(Object.assign(new Error(CANARY), { name, cause: new Error(CANARY) }));
    const error = await writeAwsSecret(session, input()).catch((e: unknown) => e);
    expect(error).toMatchObject({ reason }); expect(String(error)).not.toContain(CANARY); expect(error).not.toHaveProperty("cause");
  });
});

describe("secret.write broker purpose", () => {
  const writer = "arn:aws:iam::123456789012:role/ZenithSecretWriterRole";
  const claims = () => grant({ cap: "secret.write", ws: "ws1", env: "env1", fence: 1, constraints: { secretResources: [arn] } });
  it("uses the distinct role and a mandatory exact-ARN policy even when normal derivation is disabled", async () => {
    sts.on(AssumeRoleCommand).resolves({ Credentials: { ...FAKE_CREDS, Expiration: new Date(Date.now() + 3600000) } });
    const c = connection({ workspaceId: "ws1" }, { mode: "aws_assume_role", externalId: "external-id-123", secretWriterRoleArn: writer });
    const events: unknown[] = [];
    const broker = new AwsCredentialBroker({ resolveConnection: async () => c, deriveSessionPolicy: false, emit: (e) => { events.push(e); } });
    await broker.withSession({ connectionId: c.id, grant: claims(), purpose: "secret.write", secretResources: [arn] }, async () => undefined);
    const request = sts.commandCalls(AssumeRoleCommand)[0].args[0].input;
    expect(request.RoleArn).toBe(writer);
    const policy = JSON.parse(request.Policy!);
    expect(policy.Statement[0].Resource).toEqual([arn]);
    expect(policy.Statement[0].Action).not.toContain("secretsmanager:GetSecretValue");
    expect(JSON.stringify(events)).not.toContain(FAKE_CREDS.SecretAccessKey);
  });
  it.each(["missing-role", "deploy-role", "wildcard", "other-env", "missing-targets", "caller-policy", "wrong-purpose"])("refuses %s before STS", async (kind) => {
    const c = connection({ workspaceId: "ws1" }, { mode: "aws_assume_role", externalId: "external-id-123", secretWriterRoleArn: kind === "missing-role" ? undefined : kind === "deploy-role" ? "arn:aws:iam::123456789012:role/ZenithDeployRole" : writer });
    const g = claims();
    if (kind === "wildcard") g.constraints = { secretResources: ["*"] };
    if (kind === "other-env") g.env = "env2";
    if (kind === "missing-targets") g.constraints = {};
    const broker = new AwsCredentialBroker({ resolveConnection: async () => c });
    await expect(broker.withSession({ connectionId: c.id, grant: g, purpose: kind === "wrong-purpose" ? "deploy" : "secret.write", ...(kind === "caller-policy" ? { sessionPolicy: { Version: "2012-10-17", Statement: [] } } : {}) }, async () => undefined)).rejects.toMatchObject({ code: "credential_denied" });
    expect(sts.commandCalls(AssumeRoleCommand)).toHaveLength(0);
  });
  it("refuses widening or cross-account resources", () => {
    expect(() => secretWritePolicy(claims(), "123456789012", "ap-south-1", [arn + "foreign"])).toThrow();
    expect(() => secretWritePolicy(claims(), "000000000000", "ap-south-1")).toThrow();
  });
  it("ends writer sessions at the grant deadline despite the STS duration floor", async () => {
    const g = claims();
    sts.on(AssumeRoleCommand).resolves({ Credentials: { ...FAKE_CREDS, Expiration: new Date((g.exp + 1000) * 1000) } });
    const c = connection({ workspaceId: "ws1" }, { mode: "aws_assume_role", externalId: "external-id-123", secretWriterRoleArn: writer });
    const broker = new AwsCredentialBroker({ resolveConnection: async () => c });
    await broker.withSession({ connectionId: c.id, grant: g, purpose: "secret.write" }, async (session) => {
      expect(session.expiresAt).toBe(new Date(g.exp * 1000).toISOString());
    });
  });
});
