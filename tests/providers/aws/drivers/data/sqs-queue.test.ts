import { GetQueueAttributesCommand, GetQueueUrlCommand, ListQueuesCommand, ListQueueTagsCommand, SQSClient } from "@aws-sdk/client-sqs";
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sqsQueueDriver as driver } from "@/lib/providers/aws/drivers/data";
import { DriverCompileError } from "@/lib/providers/aws/drivers/data/_shared";
import { queueRefOf, readSqsConfig } from "@/lib/providers/aws/drivers/data/sqs-queue";
import { driftOf } from "./_drift";
import { awsError, compileCtx, driverCtx, mkNode, queueSpec, tagList, tagRecord } from "./_helpers";

const sqs = mockClient(SQSClient);
const tagging = mockClient(ResourceGroupsTaggingAPIClient);
beforeEach(() => {
  sqs.reset();
  tagging.reset();
});
afterAll(() => {
  sqs.restore();
  tagging.restore();
});

const node = mkNode("queue/jobs", "queue", queueSpec({ config: { visibilityTimeout: 60 } }));
const build = (spec: Record<string, unknown>, over: Partial<typeof node> = {}) => mkNode("queue/jobs", "queue", queueSpec(spec), over);
const compile = (n = node) => driver.compile!(n, compileCtx([n]));
type Body = Record<string, unknown>;
const queues = (f: ReturnType<typeof compile>) => f.resource!.aws_sqs_queue as Record<string, Body>;

describe("aws:sqs_queue compile", () => {
  it("defines the queue first, then its dead-letter queue and the DLQ's redrive allow policy", () => {
    expect(compile().addresses).toEqual(["aws_sqs_queue.queue_jobs", "aws_sqs_queue.queue_jobs_dlq", "aws_sqs_queue_redrive_allow_policy.queue_jobs_dlq_allow"]);
  });

  it("encrypts both queues, redrives after 5 receives and lets only this queue use the DLQ", () => {
    const f = compile();
    expect(queues(f).queue_jobs).toMatchObject({
      name: "zen-prod-jobs",
      sqs_managed_sse_enabled: true,
      visibility_timeout_seconds: 60,
      message_retention_seconds: 345600,
      redrive_policy: "${jsonencode({ deadLetterTargetArn = aws_sqs_queue.queue_jobs_dlq.arn, maxReceiveCount = 5 })}",
    });
    expect(queues(f).queue_jobs_dlq).toMatchObject({ name: "zen-prod-jobs-dlq", sqs_managed_sse_enabled: true, message_retention_seconds: 1209600 });
    expect((f.resource!.aws_sqs_queue_redrive_allow_policy as Record<string, Body>).queue_jobs_dlq_allow).toEqual({
      queue_url: "${aws_sqs_queue.queue_jobs_dlq.url}",
      redrive_allow_policy: '${jsonencode({ redrivePermission = "byQueue", sourceQueueArns = [aws_sqs_queue.queue_jobs.arn] })}',
    });
  });

  it("marks the DLQ as a dead-letter queue by tag so a tag lookup can tell the two queues apart", () => {
    const f = compile();
    expect((queues(f).queue_jobs_dlq.tags as Record<string, string>)["zenith:role"]).toBe("dead-letter-queue");
    expect(queues(f).queue_jobs.tags).not.toHaveProperty("zenith:role");
    expect((queues(f).queue_jobs.tags as Record<string, string>)["zenith:resource"]).toBe("queue/jobs");
  });

  it("takes retention and visibility from config, refusing out-of-range values rather than clamping", () => {
    expect(readSqsConfig(build({ config: { messageRetentionSeconds: 86400, visibilityTimeout: "120" } }))).toEqual({ visibilityTimeout: 120, messageRetentionSeconds: 86400 });
    expect(readSqsConfig(build({}))).toEqual({ visibilityTimeout: 30, messageRetentionSeconds: 345600 });
    for (const config of [{ visibilityTimeout: 43201 }, { visibilityTimeout: -1 }, { messageRetentionSeconds: 59 }, { messageRetentionSeconds: 1209601 }, { visibilityTimeout: "soon" }]) {
      expect(() => compile(build({ config }))).toThrow(DriverCompileError);
    }
  });

  it("publishes arn, url and name; is deterministic; non-managed nodes compile to nothing", () => {
    expect(Object.keys(compile().locals!).sort()).toEqual(["ref_queue_jobs__arn", "ref_queue_jobs__id", "ref_queue_jobs__name", "ref_queue_jobs__url"]);
    expect(JSON.stringify(compile())).toBe(JSON.stringify(compile()));
    expect(compile(build({}, { ownership: "external" }))).toEqual({ addresses: [] });
  });

  it("keeps queue names within SQS's 80 characters, DLQ suffix included", () => {
    const n = mkNode(`queue/${"q".repeat(40)}`, "queue", queueSpec());
    const f = driver.compile!(n, compileCtx([n]));
    for (const q of Object.values(queues(f))) expect((q.name as string).length).toBeLessThanOrEqual(80);
  });
});

const ARN = "arn:aws:sqs:ap-south-1:123456789012:zen-prod-jobs";
const DLQ_ARN = `${ARN}-dlq`;
const URL = "https://sqs.ap-south-1.amazonaws.com/123456789012/zen-prod-jobs";
const DLQ_URL = `${URL}-dlq`;
const attrs = (over: Record<string, string> = {}) => ({
  QueueArn: ARN,
  VisibilityTimeout: "60",
  MessageRetentionPeriod: "345600",
  SqsManagedSseEnabled: "true",
  DelaySeconds: "0",
  RedrivePolicy: JSON.stringify({ deadLetterTargetArn: DLQ_ARN, maxReceiveCount: 5 }),
  ApproximateNumberOfMessages: "12",
  ApproximateNumberOfMessagesNotVisible: "3",
  ApproximateNumberOfMessagesDelayed: "1",
  ...over,
});

function healthyQueue() {
  sqs.on(GetQueueUrlCommand, { QueueName: "zen-prod-jobs" }).resolves({ QueueUrl: URL });
  sqs.on(GetQueueUrlCommand, { QueueName: "zen-prod-jobs-dlq" }).resolves({ QueueUrl: DLQ_URL });
  sqs.on(GetQueueAttributesCommand, { QueueUrl: URL }).resolves({ Attributes: attrs() });
  sqs.on(GetQueueAttributesCommand, { QueueUrl: DLQ_URL }).resolves({ Attributes: { QueueArn: DLQ_ARN, ApproximateNumberOfMessages: "0" } });
  sqs.on(ListQueueTagsCommand).resolves({ Tags: tagRecord("queue/jobs") });
}

describe("aws:sqs_queue observe", () => {
  it("reads attributes by ARN, carries queueUrl/queueName/tags, and matches the spec", async () => {
    healthyQueue();
    const obs = await driver.observe!(driverCtx(), node, ARN);
    expect(obs).toMatchObject({ presence: "present", externalId: ARN, source: "aws.sqs_queue@1" });
    expect(obs.native).toMatchObject({ queueUrl: URL, queueName: "zen-prod-jobs" });
    expect((obs.native as { tags: Record<string, string> }).tags["zenith:environment"]).toBe("env_test");
    const v = (n: string) => (obs.attributes[n] as { value: unknown }).value;
    expect([v("visibilityTimeout"), v("messageRetentionSeconds"), v("sseEnabled"), v("hasDeadLetterQueue"), v("maxReceiveCount")]).toEqual([60, 345600, true, true, 5]);
    expect(driftOf(node, obs, driver.expectedAttributes!)).toEqual([]);
  });

  it("accepts a queue URL and resolves an ARN through GetQueueUrl with its account", async () => {
    healthyQueue();
    await driver.observe!(driverCtx(), node, URL);
    expect(sqs.commandCalls(GetQueueUrlCommand)).toHaveLength(0);
    await driver.observe!(driverCtx(), node, ARN);
    expect(sqs.commandCalls(GetQueueUrlCommand)[0].args[0].input).toEqual({ QueueName: "zen-prod-jobs", QueueOwnerAWSAccountId: "123456789012" });
  });

  it("reports drift: a queue without SSE or redrive, a changed timeout", async () => {
    healthyQueue();
    sqs.on(GetQueueAttributesCommand, { QueueUrl: URL }).resolves({ Attributes: attrs({ SqsManagedSseEnabled: "false", RedrivePolicy: "", VisibilityTimeout: "30" }) });
    const obs = await driver.observe!(driverCtx(), node, ARN);
    const f = driftOf(node, obs, driver.expectedAttributes!);
    expect(f[0].fields!.map((x) => x.attribute).sort()).toEqual(["hasDeadLetterQueue", "sseEnabled", "visibilityTimeout"]);
    // there is no redrive policy to read maxReceiveCount from: unknown, never "matches"
    expect(obs.attributes.maxReceiveCount).toMatchObject({ state: "unknown", reason: "not_applicable" });
  });

  it("finds the primary queue by tags and ignores the dead-letter queue that shares them", async () => {
    healthyQueue();
    tagging.on(GetResourcesCommand).resolves({
      ResourceTagMappingList: [
        { ResourceARN: DLQ_ARN, Tags: [...tagList("queue/jobs"), { Key: "zenith:role", Value: "dead-letter-queue" }] },
        { ResourceARN: ARN, Tags: tagList("queue/jobs") },
      ],
    });
    const obs = await driver.observe!(driverCtx(), node);
    expect(obs).toMatchObject({ presence: "present", externalId: ARN });
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [] });
    expect((await driver.observe!(driverCtx(), node)).presence).toBe("missing");
  });

  it("classifies QueueDoesNotExist as missing, AccessDenied as inaccessible, throttling as unknown", async () => {
    sqs.on(GetQueueUrlCommand).rejects(awsError("QueueDoesNotExist", "The specified queue does not exist.", 400));
    expect((await driver.observe!(driverCtx(), node, ARN)).presence).toBe("missing");
    sqs.on(GetQueueUrlCommand).rejects(awsError("AWS.SimpleQueueService.NonExistentQueue", "nope", 400));
    expect((await driver.observe!(driverCtx(), node, ARN)).presence).toBe("missing");
    sqs.on(GetQueueUrlCommand).rejects(awsError("AccessDenied", "no", 403));
    expect((await driver.observe!(driverCtx(), node, ARN)).presence).toBe("inaccessible");
    sqs.on(GetQueueUrlCommand).rejects(awsError("RequestThrottled", "slow", 400));
    expect((await driver.observe!(driverCtx(), node, ARN)).presence).toBe("unknown");
  });

  it("keeps the observation when only the tag read fails", async () => {
    healthyQueue();
    sqs.on(ListQueueTagsCommand).rejects(awsError("AccessDenied", "no", 403));
    const obs = await driver.observe!(driverCtx(), node, ARN);
    expect(obs.presence).toBe("present");
    expect(obs.native).toMatchObject({ tagsUnreadable: "AccessDenied" });
  });

  it("parses queue references strictly", () => {
    expect(queueRefOf(URL)).toEqual({ name: "zen-prod-jobs", url: URL });
    expect(queueRefOf(ARN)).toEqual({ name: "zen-prod-jobs", account: "123456789012" });
    expect(queueRefOf("zen-prod-jobs")).toEqual({ name: "zen-prod-jobs" });
    expect(queueRefOf("http://evil.example/123456789012/q")).toBeUndefined();
    expect(queueRefOf("arn:aws:s3:::bucket")).toBeUndefined();
    expect(queueRefOf("a b")).toBeUndefined();
  });
});

describe("aws:sqs_queue runtime", () => {
  it("reports approximate message counts and a healthy queue with an empty DLQ", async () => {
    healthyQueue();
    const rt = await driver.runtime!(driverCtx(), node, ARN);
    expect(rt).toMatchObject({ health: "healthy", counts: { visible: 12, inFlight: 3, delayed: 1, deadLettered: 0 }, source: "aws.sqs_queue@1" });
    expect(rt.signals).toEqual(["counts_approximate"]);
  });

  it("degrades health and signals when messages are in the dead-letter queue", async () => {
    healthyQueue();
    sqs.on(GetQueueAttributesCommand, { QueueUrl: DLQ_URL }).resolves({ Attributes: { ApproximateNumberOfMessages: "7" } });
    const rt = await driver.runtime!(driverCtx(), node, ARN);
    expect(rt).toMatchObject({ health: "degraded", counts: { deadLettered: 7 } });
    expect(rt.signals).toContain("dead_letter_messages:7");
  });

  it("still reports the main queue when the DLQ cannot be read, and says so", async () => {
    healthyQueue();
    sqs.on(GetQueueUrlCommand, { QueueName: "zen-prod-jobs-dlq" }).rejects(awsError("AccessDenied", "no", 403));
    const rt = await driver.runtime!(driverCtx(), node, ARN);
    expect(rt.health).toBe("healthy");
    expect(rt.counts.deadLettered).toBeUndefined();
    expect(rt.signals).toContain("dead_letter_queue_unreadable:inaccessible");
  });

  it("omits counts SQS did not return instead of inventing zeros", async () => {
    sqs.on(GetQueueUrlCommand).resolves({ QueueUrl: URL });
    sqs.on(GetQueueAttributesCommand).resolves({ Attributes: { QueueArn: ARN } });
    expect((await driver.runtime!(driverCtx(), node, ARN)).counts).toEqual({});
  });

  it("maps a missing queue to unhealthy and a denied read to unknown", async () => {
    sqs.on(GetQueueUrlCommand).rejects(awsError("QueueDoesNotExist", "gone", 400));
    expect(await driver.runtime!(driverCtx(), node, ARN)).toMatchObject({ health: "unhealthy", signals: ["missing"] });
    sqs.on(GetQueueUrlCommand).rejects(awsError("AccessDenied", "no", 403));
    expect(await driver.runtime!(driverCtx(), node, ARN)).toMatchObject({ health: "unknown" });
  });
});

describe("aws:sqs_queue verify and discover", () => {
  it("verify passes for an encrypted queue with a DLQ and fails without either", async () => {
    healthyQueue();
    const ctx = driverCtx();
    expect((await driver.verify!(ctx, node, await driver.observe!(ctx, node, ARN))).status).toBe("passed");
    sqs.on(GetQueueAttributesCommand, { QueueUrl: URL }).resolves({ Attributes: attrs({ SqsManagedSseEnabled: "false", RedrivePolicy: "" }) });
    const r = await driver.verify!(ctx, node, await driver.observe!(ctx, node, ARN));
    expect(r.status).toBe("failed");
    expect(r.checks.filter((c) => c.passed === false).map((c) => c.id).sort()).toEqual(["configuration_matches", "dead_letter_queue", "encrypted"]);
  });

  it("discover lists queues with ARNs built from their URLs and marks Zenith-tagged ones", async () => {
    sqs.on(ListQueuesCommand).resolves({ QueueUrls: [URL, "https://sqs.ap-south-1.amazonaws.com/123456789012/foreign"] });
    sqs.on(ListQueueTagsCommand, { QueueUrl: URL }).resolves({ Tags: tagRecord("queue/jobs") });
    sqs.on(ListQueueTagsCommand, { QueueUrl: "https://sqs.ap-south-1.amazonaws.com/123456789012/foreign" }).resolves({});
    const found = await driver.discover!(driverCtx());
    expect(found.map((f) => [f.name, f.externalId, f.zenithTagged])).toEqual([
      ["foreign", "arn:aws:sqs:ap-south-1:123456789012:foreign", false],
      ["zen-prod-jobs", ARN, true],
    ]);
  });
});
