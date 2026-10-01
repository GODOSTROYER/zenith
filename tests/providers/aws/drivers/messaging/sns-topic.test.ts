/** SDK contract/compile tests only; no calls to an AWS account. */
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { snsTopicDriver as driver } from "@/lib/providers/aws/drivers/messaging/sns-topic";
import { compileGrantStatements, expectedGrantActions, GRANT_RULES } from "@/lib/providers/aws/drivers/data/iam-grants";
import { awsError, compileCtx, driverCtx, mkNode, tagList } from "../data/_helpers";
import { DriverCompileError, refLocalName } from "@/lib/providers/aws/drivers/shared";

const tagging = mockClient(ResourceGroupsTaggingAPIClient);
beforeEach(() => tagging.reset());
afterAll(() => tagging.restore());
const arn = "arn:aws:sns:ap-south-1:123456789012:events";
const kmsArn = "arn:aws:kms:ap-south-1:123456789012:key/12345678-1234-1234-1234-123456789012";
const topic = (spec: Record<string, unknown> = {}) => mkNode("pubsub/events", "pubsub", spec);
const queue = mkNode("queue/jobs", "queue", {});
const compile = (spec: Record<string, unknown> = {}) => { const n = topic(spec); return driver.compile!(n, compileCtx([n, queue])); };
const found = (address = topic().address, ResourceARN = arn) => ({ ResourceARN, Tags: tagList(address) });
const grants = [{ target: "pubsub/events", access: ["publish"], via: ["binding:publish"] }];
const identity = mkNode("identity/web", "identity", { grants });
const acct = { accountId: "${data.aws_caller_identity.account.account_id}", partition: "${data.aws_partition.partition.partition}" };

describe("SNS lifecycle and grants", () => {
  it("uses KMS encryption and publishes the topic and exact key ARNs", () => {
    const f = compile();
    expect(f.addresses[0]).toBe("aws_sns_topic.pubsub_events");
    expect(f.resource!.aws_sns_topic.pubsub_events).toMatchObject({ kms_master_key_id: "alias/aws/sns", lifecycle: { prevent_destroy: true } });
    expect(f.data!.aws_kms_key.pubsub_events_key).toEqual({ key_id: "alias/aws/sns" });
    expect(f.locals![refLocalName("pubsub/events", "kms_key_arn")]).toBe("${data.aws_kms_key.pubsub_events_key.arn}");
  });
  it("supports a customer-managed key in the same region and a literal name", () => {
    expect(compile({ kmsKeyArn: kmsArn, name: "domain-events" }).resource!.aws_sns_topic.pubsub_events).toMatchObject({ kms_master_key_id: kmsArn, name: "domain-events" });
  });
  it.each(["deny", "approval", "allow"])("maps deletion policy %s explicitly", (deletionPolicy) => {
    expect(compile({ deletionPolicy }).resource!.aws_sns_topic.pubsub_events.lifecycle).toEqual({ prevent_destroy: deletionPolicy !== "allow" });
  });
  it("supports the existing native config shape without mutating it", () => {
    const n = { ...topic(), kind: "provider_native" as const, spec: { type: "aws:sns_topic", config: { name: "native-events", encrypted: true, fifo: false } } };
    const before = structuredClone(n);
    expect(driver.compile!(n, compileCtx([n])).resource!.aws_sns_topic.pubsub_events.name).toBe("native-events");
    expect(n).toEqual(before);
  });
  it.each([
    { encrypted: false }, { encryption: false }, { fifo: true }, { name: "${file(\"secret\")}" },
    { kmsKeyArn: "arn:aws:kms:ap-south-1:123456789012:key/*" }, { kmsKeyArn: kmsArn.replace("ap-south-1", "us-east-1") },
    { subscriptions: ["queue/absent"] }, { subscriptions: "queue/jobs" }, { config: { password: "secret-canary" } },
    { config: [] }, { config: null }, { name: "a", config: { name: "b" } },
  ])("refuses unsafe/invalid configuration %j", (spec) => {
    expect(() => compile(spec)).toThrow(DriverCompileError);
  });
  it("creates one subscription and a delivery grant to one exact queue/topic pair", () => {
    const f = compile({ subscriptions: [queue.address, queue.address] });
    expect(Object.keys(f.resource!.aws_sns_topic_subscription)).toHaveLength(1);
    const sub = Object.values(f.resource!.aws_sns_topic_subscription)[0];
    expect(sub).toMatchObject({ protocol: "sqs", endpoint: "${local.ref_queue_jobs__arn}", raw_message_delivery: true });
    const policy = JSON.parse(String(f.resource!.aws_sqs_queue_policy.queue_jobs_sns_delivery.policy));
    expect(policy.Statement).toEqual([{ Sid: "SnsDelivery", Effect: "Allow", Principal: { Service: "sns.amazonaws.com" }, Action: "sqs:SendMessage", Resource: "${local.ref_queue_jobs__arn}", Condition: { ArnEquals: { "aws:SourceArn": "${aws_sns_topic.pubsub_events.arn}" } } }]);
    expect(JSON.stringify(policy)).not.toMatch(/\*/);
    expect(sub.depends_on).toEqual(["aws_sqs_queue_policy.queue_jobs_sns_delivery"]);
  });
  it("recognizes queue dependencies as graph subscription bindings", () => {
    const n = { ...topic(), dependsOn: [queue.address] };
    expect(driver.compile!(n, compileCtx([n, queue])).resource!.aws_sns_topic_subscription).toBeDefined();
    expect(compile().resource!.aws_sns_topic_subscription).toBeUndefined();
  });
  it.each([
    { ownership: "referenced" as const }, { provider: "gcp" as const }, { region: "us-east-1" },
  ])("refuses replacing policies on an unsuitable queue %j", (over) => {
    const n = topic({ subscriptions: [queue.address] });
    expect(() => driver.compile!(n, compileCtx([n, { ...queue, ...over }]))).toThrow(DriverCompileError);
  });
  it("adds exact SNS and KMS publish statements with no wildcard actions or resources", () => {
    const rows = compileGrantStatements(identity, compileCtx([identity, topic()]), grants, acct);
    expect(rows.map(({ actions, resources }) => ({ actions, resources }))).toEqual([
      { actions: ["kms:Decrypt", "kms:GenerateDataKey"], resources: ["${local.ref_pubsub_events__kms_key_arn}"] },
      { actions: ["sns:Publish"], resources: ["${local.ref_pubsub_events__arn}"] },
    ]);
    expect(expectedGrantActions(identity.address, grants)).toEqual(["kms:Decrypt", "kms:GenerateDataKey", "sns:Publish"]);
    expect(GRANT_RULES.pubsub.publish.flatMap((r) => r.actions).join(" ")).not.toMatch(/[*?]/);
  });
  it("requires the exact key ARN for a referenced topic's publish grant", () => {
    const foreign = { ...topic({ kmsKeyArn: kmsArn }), ownership: "referenced" as const, externalRef: arn };
    expect(compileGrantStatements(identity, compileCtx([foreign]), grants, acct).flatMap((r) => r.resources).sort()).toEqual([kmsArn, arn].sort());
    expect(() => compileGrantStatements(identity, compileCtx([{ ...foreign, spec: {} }]), grants, acct)).toThrow(/exact regional KMS/);
    expect(() => compileGrantStatements(identity, compileCtx([{ ...foreign, spec: { kmsKeyArn: "*" } }]), grants, acct)).toThrow(DriverCompileError);
  });
  it("supports a native SNS target with a provider_native address", () => {
    const n = { ...topic(), kind: "provider_native" as const, address: "provider_native/events", spec: { type: "aws:sns_topic", config: {} } };
    const nativeGrants = [{ ...grants[0], target: n.address }];
    const rows = compileGrantStatements(identity, compileCtx([n]), nativeGrants, acct);
    expect(rows.flatMap((row) => row.resources).sort()).toEqual(["${local.ref_provider_native_events__arn}", "${local.ref_provider_native_events__kms_key_arn}"].sort());
  });
  it.each(["referenced", "external"] as const)("does not create resources for %s topics", (ownership) => {
    expect(driver.compile!({ ...topic(), ownership }, compileCtx([]))).toEqual({ addresses: [] });
  });
});

describe("SNS honest tag-based observation", () => {
  it("reports scoped tags/presence and leaves every uninspected configuration attribute unknown", async () => {
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [found()] });
    const obs = await driver.observe!(driverCtx(), topic());
    expect(obs).toMatchObject({ presence: "present", externalId: arn, simulated: false });
    expect(Object.values(obs.attributes).every((a) => a.state === "unknown")).toBe(true);
    expect((await driver.verify!(driverCtx(), topic(), obs)).status).toBe("unknown");
    const request = tagging.commandCalls(GetResourcesCommand)[0].args;
    expect(request[0].input).toMatchObject({ ResourceTypeFilters: ["sns:topic"], TagFilters: expect.arrayContaining([{ Key: "zenith:workspace", Values: ["ws_test"] }]) });
    expect((request as unknown[])[1]).toHaveProperty("abortSignal");
  });
  it.each([
    [], [found(), found(topic().address, arn + "-second")],
    [{ ...found(), Tags: tagList(topic().address, { "zenith:workspace": "other" }) }],
    [found(topic().address, arn.replace("ap-south-1", "us-east-1"))],
  ])("does not infer presence or absence from an ambiguous/unscoped index %j", async (...mappings) => {
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: mappings });
    expect((await driver.observe!(driverCtx(), topic())).presence).toBe("unknown");
  });
  it("does not treat a truncated lookup as a unique match", async () => {
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [found()], PaginationToken: "repeated" });
    expect((await driver.observe!(driverCtx(), topic())).presence).toBe("unknown");
  });
  it("deduplicates repeated indexed rows across pagination", async () => {
    tagging.on(GetResourcesCommand).resolvesOnce({ ResourceTagMappingList: [found()], PaginationToken: "next" }).resolves({ ResourceTagMappingList: [found()] });
    expect((await driver.observe!(driverCtx(), topic())).presence).toBe("present");
  });
  it.each(["not-an-arn", arn.replace("123456789012", "999999999999"), arn + "*"])("refuses unsafe explicit identifier %s without any SDK call", async (id) => {
    expect((await driver.observe!(driverCtx(), topic(), id)).presence).toBe("unknown");
    expect(tagging.calls()).toHaveLength(0);
  });
  it("does not silently replace an explicit ARN with another tagged topic", async () => {
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [found()] });
    expect((await driver.observe!(driverCtx(), topic(), arn + "-other")).presence).toBe("unknown");
  });
  it.each([["AccessDeniedException", "inaccessible"], ["ThrottlingException", "unknown"]])("classifies %s honestly", async (name, presence) => {
    tagging.on(GetResourcesCommand).rejects(awsError(name));
    expect((await driver.observe!(driverCtx(), topic())).presence).toBe(presence);
  });
  it("rethrows cancellation before sending a request", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(driver.observe!(driverCtx({ signal: controller.signal }), topic())).rejects.toHaveProperty("name", "AbortError");
    expect(tagging.calls()).toHaveLength(0);
  });
  it("refuses config secrets without echoing their values", () => {
    const canary = "sensitive-canary";
    try { compile({ config: { password: canary } }); throw new Error("expected compile refusal"); }
    catch (error) { expect(error).toBeInstanceOf(DriverCompileError); expect(String(error)).not.toContain(canary); }
  });
});
