/** Mocked SDK contracts only. No AWS account or cloud credentials are used. */
import { DescribeKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { GetTopicAttributesCommand, ListSubscriptionsByTopicCommand, SNSClient } from "@aws-sdk/client-sns";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { snsTopicDriver as driver } from "@/lib/providers/aws/drivers/messaging/sns-topic";
import { awsError, driverCtx, mkNode, tagList } from "../data/_helpers";

const tagging = mockClient(ResourceGroupsTaggingAPIClient);
const sns = mockClient(SNSClient);
const kms = mockClient(KMSClient);
const arn = "arn:aws:sns:ap-south-1:123456789012:events";
const key = "arn:aws:kms:ap-south-1:123456789012:key/12345678-1234-1234-1234-123456789012";
const queueArn = "arn:aws:sqs:ap-south-1:123456789012:jobs";
const topic = (spec: Record<string, unknown> = {}, dependsOn: string[] = []) => mkNode("pubsub/events", "pubsub", spec, { dependsOn });
const found = (ResourceARN = arn, address = "pubsub/events", over: Record<string, string> = {}) => ({ ResourceARN, Tags: tagList(address, over) });
const subscription = (Endpoint = queueArn, SubscriptionArn = `${arn}:12345678-1234-1234-1234-123456789012`) => ({ TopicArn: arn, Protocol: "sqs", Endpoint, SubscriptionArn });
const attrs = (over: Record<string, string> = {}) => ({ Attributes: { TopicArn: arn, KmsMasterKeyId: key, ...over } });
const observe = (spec: Record<string, unknown> = {}, dependsOn: string[] = []) => driver.observe!(driverCtx(), topic(spec, dependsOn));
const canary = "sensitive-value-canary";

beforeEach(() => {
  tagging.reset(); sns.reset(); kms.reset();
  tagging.on(GetResourcesCommand).callsFake((input) => {
    const address = input.TagFilters.find((f: { Key: string }) => f.Key === "zenith:resource").Values[0];
    return { ResourceTagMappingList: address === "pubsub/events" ? [found()] : [found(queueArn, address), found(`${queueArn}-dlq`, address, { "zenith:role": "dead-letter-queue" })] };
  });
  sns.on(GetTopicAttributesCommand).resolves(attrs());
  sns.on(ListSubscriptionsByTopicCommand).resolves({ Subscriptions: [] });
});
afterAll(() => { tagging.restore(); sns.restore(); kms.restore(); });

describe("SNS encryption and policy reads", () => {
  it("verifies an exact configured KMS key and confirmed bound queue", async () => {
    sns.on(ListSubscriptionsByTopicCommand).resolves({ Subscriptions: [subscription()] });
    const n = topic({ kmsKeyArn: key, subscriptions: ["queue/jobs", "queue/jobs"] });
    const observation = await driver.observe!(driverCtx(), n, arn);
    expect(observation.attributes).toMatchObject({ encrypted: { state: "known", value: true }, kmsKeyArn: { state: "known", value: key }, subscriptions: { state: "known", value: ["queue/jobs"] } });
    expect((await driver.verify!(driverCtx(), n, observation)).status).toBe("passed");
    expect(kms.calls()).toHaveLength(0);
    expect(sns.commandCalls(GetTopicAttributesCommand)[0].args[0].input).toEqual({ TopicArn: arn });
    expect(sns.commandCalls(ListSubscriptionsByTopicCommand)[0].args[0].input).toEqual({ TopicArn: arn });
    for (const request of [...tagging.calls(), ...sns.calls()]) expect((request.args as unknown[])[1]).toHaveProperty("abortSignal");
  });
  it.each(["alias/aws/sns", "12345678-1234-1234-1234-123456789012", `mrk-${"a".repeat(32)}`])("resolves key reference %s without inventing an ARN", async (reference) => {
    sns.on(GetTopicAttributesCommand).resolves(attrs({ KmsMasterKeyId: reference }));
    kms.on(DescribeKeyCommand).resolves({ KeyMetadata: { Arn: key, KeyId: "12345678-1234-1234-1234-123456789012" } });
    expect((await observe({ kmsKeyArn: key })).attributes.kmsKeyArn).toMatchObject({ state: "known", value: key });
    expect(kms.commandCalls(DescribeKeyCommand)[0].args[0].input).toEqual({ KeyId: reference });
    expect((kms.commandCalls(DescribeKeyCommand)[0].args as unknown[])[1]).toHaveProperty("abortSignal");
  });
  it("retains observed encryption when KMS metadata is denied", async () => {
    sns.on(GetTopicAttributesCommand).resolves(attrs({ KmsMasterKeyId: "alias/aws/sns" }));
    kms.on(DescribeKeyCommand).rejects(awsError("AccessDeniedException", canary));
    const observation = await observe({ kmsKeyArn: key });
    expect(observation.attributes.encrypted).toMatchObject({ state: "known", value: true });
    expect(observation.attributes.kmsKeyArn).toMatchObject({ state: "unknown", reason: "access_denied" });
    expect((await driver.verify!(driverCtx(), topic({ kmsKeyArn: key }), observation)).status).toBe("unknown");
    expect(JSON.stringify(observation)).not.toContain(canary);
  });
  it("observes a multi-region key ARN without treating it as an alias", async () => {
    const mrk = key.replace(/key\/.+$/, `key/mrk-${"a".repeat(32)}`);
    sns.on(GetTopicAttributesCommand).resolves(attrs({ KmsMasterKeyId: mrk }));
    expect((await observe()).attributes.kmsKeyArn).toMatchObject({ state: "known", value: mrk });
    expect(kms.calls()).toHaveLength(0);
  });
  it.each([undefined, key.replace("ap-south-1", "us-east-1"), "not-an-arn"])("keeps malformed/mismatched KMS metadata unknown: %s", async (Arn) => {
    sns.on(GetTopicAttributesCommand).resolves(attrs({ KmsMasterKeyId: "alias/aws/sns" }));
    kms.on(DescribeKeyCommand).resolves({ KeyMetadata: { Arn, KeyId: "id" } });
    expect((await observe()).attributes.kmsKeyArn.state).toBe("unknown");
  });
  it("fails encryption verification when SNS explicitly reports no key", async () => {
    sns.on(GetTopicAttributesCommand).resolves(attrs({ KmsMasterKeyId: "" }));
    const observation = await observe();
    expect(observation.attributes).toMatchObject({ encrypted: { state: "known", value: false }, kmsKeyArn: { state: "known", value: null } });
    expect((await driver.verify!(driverCtx(), topic(), observation)).status).toBe("failed");
  });
  it("fails verification when SNS reports a different exact key", async () => {
    const observation = await observe({ kmsKeyArn: key.replace("12345678-", "87654321-") });
    expect((await driver.verify!(driverCtx(), topic({ kmsKeyArn: key.replace("12345678-", "87654321-") }), observation)).status).toBe("failed");
  });
  it.each([undefined, "", arn + "-other"])("does not trust incomplete/mismatched topic attributes: %s", async (TopicArn) => {
    sns.on(GetTopicAttributesCommand).resolves({ Attributes: { ...(TopicArn !== undefined ? { TopicArn } : {}), KmsMasterKeyId: key } });
    const observation = await observe();
    expect(Object.values(observation.attributes).every((v) => v.state === "unknown")).toBe(true);
    expect((await driver.verify!(driverCtx(), topic(), observation)).status).toBe("unknown");
    expect(sns.commandCalls(ListSubscriptionsByTopicCommand)).toHaveLength(0);
  });
  it.each([undefined, canary, key.replace("ap-south-1", "us-east-1")])("does not invent encryption from omitted/invalid key metadata: %s", async (KmsMasterKeyId) => {
    sns.on(GetTopicAttributesCommand).resolves({ Attributes: { TopicArn: arn, ...(KmsMasterKeyId !== undefined ? { KmsMasterKeyId } : {}) } });
    const observation = await observe();
    expect(observation.attributes.encrypted.state).toBe("unknown");
    expect(kms.calls()).toHaveLength(0);
    expect(JSON.stringify(observation)).not.toContain(canary);
  });
  it("summarizes policy counts without returning principals, conditions, actions or arbitrary strings", async () => {
    sns.on(GetTopicAttributesCommand).resolves(attrs({ Policy: JSON.stringify({ Id: canary, Statement: [
      { Sid: canary, Effect: "Allow", Principal: { AWS: ["*", canary] }, Action: canary, Resource: canary, Condition: { StringEquals: { [canary]: canary } } },
      { Effect: "Deny", Principal: canary },
      { Effect: "Allow", Principal: "*" },
    ] }) }));
    const observation = await observe();
    expect(observation.attributes.policySummary).toMatchObject({ state: "known", value: { statements: 3, allowStatements: 2, denyStatements: 1, wildcardPrincipalStatements: 2, conditionedStatements: 1 } });
    expect(JSON.stringify(observation)).not.toContain(canary);
  });
  it("supports a single policy statement object", async () => {
    sns.on(GetTopicAttributesCommand).resolves(attrs({ Policy: JSON.stringify({ Statement: { Effect: "Allow", Principal: { Service: "sns.amazonaws.com" } } }) }));
    expect((await observe()).attributes.policySummary).toMatchObject({ state: "known", value: { statements: 1, allowStatements: 1, wildcardPrincipalStatements: 0 } });
  });
  it.each(["{", "null", "[]", "{}", '{"Statement":[null]}', '{"Statement":[{"Effect":"Unknown"}]}', "x".repeat(65_537)])("keeps malformed/oversize policy unknown (case %#)", async (Policy) => {
    sns.on(GetTopicAttributesCommand).resolves(attrs({ Policy }));
    const observation = await observe();
    expect(observation.attributes.policySummary.state).toBe("unknown");
    expect(observation.attributes.encrypted).toMatchObject({ state: "known", value: true });
  });
});

describe("SNS bound subscription verification", () => {
  it("verifies a queue dependency after paginating and deduplicating endpoints", async () => {
    sns.on(ListSubscriptionsByTopicCommand).resolvesOnce({ Subscriptions: [subscription()], NextToken: "opaque-next" }).resolves({ Subscriptions: [subscription()] });
    const n = topic({}, ["queue/jobs", "network/main"]);
    const observation = await driver.observe!(driverCtx(), n);
    expect(observation.attributes.subscriptions).toMatchObject({ state: "known", value: ["queue/jobs"] });
    expect((await driver.verify!(driverCtx(), n, observation)).status).toBe("passed");
    expect(sns.commandCalls(ListSubscriptionsByTopicCommand)[1].args[0].input).toEqual({ TopicArn: arn, NextToken: "opaque-next" });
  });
  it.each([[], [subscription(`${queueArn}-other`)], [subscription(queueArn, "PendingConfirmation")], [subscription(queueArn, "Deleted")], [subscription(`${queueArn}-dlq`)]])("fails a complete inventory missing the bound primary queue (case %#)", async (...Subscriptions) => {
    sns.on(ListSubscriptionsByTopicCommand).resolves({ Subscriptions });
    const n = topic({ subscriptions: ["queue/jobs"] });
    const observation = await driver.observe!(driverCtx(), n);
    expect(observation.attributes.subscriptions).toMatchObject({ state: "known", value: [] });
    expect((await driver.verify!(driverCtx(), n, observation)).status).toBe("failed");
  });
  it("uses a deterministic binding order and ignores non-SQS endpoint text", async () => {
    sns.on(ListSubscriptionsByTopicCommand).resolves({ Subscriptions: [subscription(), { ...subscription(), Protocol: "email", Endpoint: canary }, { ...subscription(), Protocol: "https", Endpoint: `https://example.test/${canary}` }] });
    const observation = await observe({ subscriptions: ["queue/z", "queue/a", "queue/a"] });
    expect(observation.attributes.subscriptions).toMatchObject({ state: "known", value: ["queue/a", "queue/z"] });
    expect(JSON.stringify(observation)).not.toContain(canary);
  });
  it.each([
    { ...subscription(), TopicArn: arn + "-other" }, { ...subscription(), TopicArn: undefined },
    { ...subscription(), Protocol: undefined }, { ...subscription(), Endpoint: undefined },
    { ...subscription(), Endpoint: canary }, { ...subscription(), SubscriptionArn: undefined },
    { ...subscription(), SubscriptionArn: "arbitrary" }, { ...subscription(), SubscriptionArn: `${arn}-other:12345678-1234-1234-1234-123456789012` },
  ])("does not infer missing bindings from malformed subscription rows (case %#)", async (row) => {
    sns.on(ListSubscriptionsByTopicCommand).resolves({ Subscriptions: [row] });
    const observation = await observe({ subscriptions: ["queue/jobs"] });
    expect(observation.attributes.subscriptions.state).toBe("unknown");
    expect((await driver.verify!(driverCtx(), topic({ subscriptions: ["queue/jobs"] }), observation)).status).toBe("unknown");
    expect(JSON.stringify(observation)).not.toContain(canary);
  });
  it("keeps truncated inventory unknown even if the desired endpoint was seen", async () => {
    sns.on(ListSubscriptionsByTopicCommand).resolves({ Subscriptions: [subscription()], NextToken: "stuck" });
    const observation = await observe({ subscriptions: ["queue/jobs"] });
    expect(observation.attributes.subscriptions.state).toBe("unknown");
    expect(observation.native).toMatchObject({ subscriptionsTruncated: true });
    expect(sns.commandCalls(ListSubscriptionsByTopicCommand)).toHaveLength(2);
  });
  it("bounds advancing tokens to twenty pages", async () => {
    let page = 0;
    sns.on(ListSubscriptionsByTopicCommand).callsFake(() => ({ Subscriptions: [subscription()], NextToken: `page-${++page}` }));
    expect((await observe()).attributes.subscriptions.state).toBe("unknown");
    expect(sns.commandCalls(ListSubscriptionsByTopicCommand)).toHaveLength(20);
  });
  it("bounds queue lookup work while preserving encryption", async () => {
    const observation = await observe({}, Array.from({ length: 101 }, (_, i) => `queue/jobs-${i}`));
    expect(observation.attributes.subscriptions.state).toBe("unknown");
    expect(observation.attributes.encrypted).toMatchObject({ state: "known", value: true });
    expect(sns.commandCalls(ListSubscriptionsByTopicCommand)).toHaveLength(0);
    expect(tagging.calls()).toHaveLength(1);
  });
  it.each([[], [found(queueArn, "queue/jobs"), found(`${queueArn}-other`, "queue/jobs")],
    [found(queueArn, "queue/jobs", { "zenith:workspace": "other" })], [found(queueArn, "queue/jobs", { "zenith:environment": "other" })],
    [found(queueArn, "queue/other")], [found(queueArn.replace("123456789012", "999999999999"), "queue/jobs")],
    [found(queueArn.replace("ap-south-1", "us-east-1"), "queue/jobs")], [found(queueArn.replace("arn:aws:", "arn:aws-cn:"), "queue/jobs")],
    [found(`${queueArn}-dlq`, "queue/jobs", { "zenith:role": "dead-letter-queue" })],
  ])("leaves queue tag ambiguity/out-of-scope mappings unknown (case %#)", async (...ResourceTagMappingList) => {
    tagging.on(GetResourcesCommand, { ResourceTypeFilters: ["sqs"] }).resolves({ ResourceTagMappingList });
    sns.on(ListSubscriptionsByTopicCommand).resolves({ Subscriptions: [subscription()] });
    const observation = await observe({ subscriptions: ["queue/jobs"] });
    expect(observation.attributes.subscriptions.state).toBe("unknown");
    expect((await driver.verify!(driverCtx(), topic({ subscriptions: ["queue/jobs"] }), observation)).status).toBe("unknown");
  });
  it("does not claim uniqueness from truncated queue tag lookup", async () => {
    tagging.on(GetResourcesCommand, { ResourceTypeFilters: ["sqs"] }).resolves({ ResourceTagMappingList: [found(queueArn, "queue/jobs")], PaginationToken: "stuck" });
    expect((await observe({ subscriptions: ["queue/jobs"] })).attributes.subscriptions.state).toBe("unknown");
  });
  it("keeps a denied queue lookup unknown while retaining encryption", async () => {
    tagging.on(GetResourcesCommand, { ResourceTypeFilters: ["sqs"] }).rejects(awsError("AccessDeniedException", canary));
    const observation = await observe({ subscriptions: ["queue/jobs"] });
    expect(observation.attributes.subscriptions).toMatchObject({ state: "unknown", reason: "access_denied" });
    expect(observation.attributes.encrypted).toMatchObject({ state: "known", value: true });
    expect(JSON.stringify(observation)).not.toContain(canary);
  });
  it("supports explicit native-address bindings and keeps untyped native edges unknown", async () => {
    sns.on(ListSubscriptionsByTopicCommand).resolves({ Subscriptions: [subscription()] });
    const explicit = await observe({ subscriptions: ["provider_native/jobs"] }, ["provider_native/jobs"]);
    expect(explicit.attributes.subscriptions).toMatchObject({ state: "known", value: ["provider_native/jobs"] });
    const untyped = await observe({}, ["provider_native/jobs"]);
    expect(untyped.attributes.subscriptions.state).toBe("unknown");
    expect((await driver.verify!(driverCtx(), topic({}, ["provider_native/jobs"]), untyped)).status).toBe("unknown");
  });
});

describe("SNS failure isolation, tenant scope and cancellation", () => {
  it.each([["AuthorizationErrorException", "inaccessible"], ["InvalidSecurityException", "inaccessible"], ["NotFoundException", "missing"], ["ThrottlingException", "unknown"], ["InternalErrorException", "unknown"], [canary, "unknown"]])("classifies %s without leaking provider text", async (name, presence) => {
    sns.on(GetTopicAttributesCommand).rejects(awsError(name, canary));
    const observation = await observe();
    expect(observation.presence).toBe(presence);
    expect(JSON.stringify(observation)).not.toContain(canary);
    expect(sns.commandCalls(ListSubscriptionsByTopicCommand)).toHaveLength(0);
  });
  it.each(["AuthorizationErrorException", "NotFoundException", "ThrottlingException"])("keeps subscriptions unknown after sub-read %s and retains encryption", async (name) => {
    sns.on(ListSubscriptionsByTopicCommand).rejects(awsError(name, canary));
    const observation = await observe();
    expect(observation.presence).toBe("present");
    expect(observation.attributes.encrypted).toMatchObject({ state: "known", value: true });
    expect(observation.attributes.subscriptions.state).toBe("unknown");
    expect((await driver.verify!(driverCtx(), topic(), observation)).status).toBe("unknown");
    expect(JSON.stringify(observation)).not.toContain(canary);
  });
  it("discards partial subscription pages when a later page fails", async () => {
    sns.on(ListSubscriptionsByTopicCommand).resolvesOnce({ Subscriptions: [subscription()], NextToken: "next" }).rejects(awsError("ThrottlingException", canary));
    expect((await observe({ subscriptions: ["queue/jobs"] })).attributes.subscriptions.state).toBe("unknown");
  });
  it.each([arn.replace("ap-south-1", "us-east-1"), arn.replace("arn:aws:", "arn:aws-cn:"), `${arn}:${canary}`])("rejects invalid region/partition/subscription identifier without any SDK read (case %#)", async (id) => {
    expect((await driver.observe!(driverCtx(), topic(), id)).presence).toBe("unknown");
    expect(tagging.calls()).toHaveLength(0); expect(sns.calls()).toHaveLength(0);
  });
  it.each([{ provider: "gcp" as const }, { region: "us-east-1" }])("rejects a mismatched node before reading AWS (case %#)", async (over) => {
    expect((await driver.observe!(driverCtx(), { ...topic(), ...over })).presence).toBe("unknown");
    expect(tagging.calls()).toHaveLength(0); expect(sns.calls()).toHaveLength(0);
  });
  it("never sends SNS reads for a topic outside this tenant", async () => {
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [found(arn, "pubsub/events", { "zenith:environment": "other" })] });
    expect((await observe()).presence).toBe("unknown");
    expect(sns.calls()).toHaveLength(0);
  });
  it("does not echo tagging errors", async () => {
    tagging.on(GetResourcesCommand).rejects(awsError("AccessDeniedException", canary));
    expect(JSON.stringify(await observe())).not.toContain(canary);
  });
  it("preserves only validated scope tags and never returns arbitrary cloud metadata", async () => {
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [found(arn, "pubsub/events", { team: canary, "zenith:managed": canary })] });
    sns.on(GetTopicAttributesCommand).resolves(attrs({ DisplayName: canary, DeliveryPolicy: canary }));
    const observation = await observe();
    expect(observation.native?.tags).toEqual({ "zenith:workspace": "ws_test", "zenith:environment": "env_test", "zenith:resource": "pubsub/events" });
    expect(JSON.stringify(observation)).not.toContain(canary);
  });
  it.each([GetTopicAttributesCommand, ListSubscriptionsByTopicCommand])("rethrows SDK cancellation from %s", async (command) => {
    sns.on(command).rejects(awsError("AbortError", canary));
    await expect(observe()).rejects.toHaveProperty("name", "AbortError");
  });
  it("stops between subscription pages when the signal fires", async () => {
    const controller = new AbortController();
    sns.on(ListSubscriptionsByTopicCommand).callsFake(() => {
      controller.abort();
      return { Subscriptions: [subscription()], NextToken: "next" };
    });
    await expect(driver.observe!(driverCtx({ signal: controller.signal }), topic())).rejects.toHaveProperty("name", "AbortError");
    expect(sns.commandCalls(ListSubscriptionsByTopicCommand)).toHaveLength(1);
  });
});
