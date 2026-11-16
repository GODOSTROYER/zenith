/**
 * `aws:sqs_queue` driver (kind `queue`).
 *
 * Compile: the queue and its dead-letter queue, wired for redrive.
 *
 *   aws_sqs_queue (primary)                 SSE with SQS-managed keys, retention
 *                                           and visibility timeout from
 *                                           `spec.config`, redrive to the DLQ
 *                                           after `maxReceiveCount = 5`
 *   aws_sqs_queue (…_dlq)                   14-day retention, SSE
 *   aws_sqs_queue_redrive_allow_policy      only THIS queue may use the DLQ
 *                                           (`byQueue`); a separate resource
 *                                           because the two queues reference
 *                                           each other's ARN
 *
 * `spec.config` keys read (validated, refused when out of range, never
 * clamped): `visibilityTimeout` (seconds, 0–43200, default 30) and
 * `messageRetentionSeconds` (60–1209600, default 345600 = 4 days).
 *
 * Observe: GetQueueAttributes (all) + ListQueueTags. `Observation.externalId` is
 * the queue ARN; `native` carries `queueUrl`, `queueName` and `tags`. Runtime:
 * `ApproximateNumberOfMessages` / `…NotVisible` / `…Delayed` as counts (SQS
 * documents these as approximate), plus the dead-letter queue's depth when it
 * can be read; messages in the DLQ degrade health.
 *
 * Honest limits: FIFO queues, per-queue KMS keys and custom `maxReceiveCount`
 * are not modelled (the spec has no field for them); contract evidence only.
 */
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ListQueuesCommand,
  ListQueueTagsCommand,
  SQSClient,
  type QueueAttributeName,
} from "@aws-sdk/client-sqs";
import type { CompileContext, DiscoveredResource, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { AwsSession } from "@/lib/credentials/types";
import type { HealthState, Observation, ResourceNode } from "@/lib/resources/types";
import { cloudName, FragmentBuilder, nodeName, paginate, parseArn, REF, resourceTags, tfLabel } from "@/lib/providers/aws/drivers/shared";
import {
  classifyAwsError,
  attrCheck,
  Attributes,
  call,
  candidate,
  configInt,
  EMPTY_FRAGMENT,
  expectedFor,
  findByTags,
  guardObserve,
  guardRuntime,
  isManaged,
  matchesExpectedCheck,
  MAX_TAG_READS,
  scalars,
  tagMap,
  validId,
  verificationOf,
  type AwsDriverContext,
  type ReadResult,
  type RuntimeRead,
} from "./support";

export const SQS_SOURCE = "aws.sqs_queue@1";
export const MAX_RECEIVE_COUNT = 5;
export const DEFAULT_VISIBILITY_TIMEOUT = 30;
export const DEFAULT_RETENTION_SECONDS = 345600;
export const DLQ_RETENTION_SECONDS = 1209600;
export const DLQ_ROLE_TAG = "zenith:role";
export const DLQ_ROLE_VALUE = "dead-letter-queue";

const QUEUE_NAME = /^[A-Za-z0-9_-]{1,80}$/;
const QUEUE_URL = /^https:\/\/sqs\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/\d{12}\/([A-Za-z0-9_-]{1,80})$/;

export interface SqsConfigView {
  visibilityTimeout: number;
  messageRetentionSeconds: number;
}

export function readSqsConfig(node: ResourceNode): SqsConfigView {
  return {
    visibilityTimeout: configInt(node, "visibilityTimeout", 0, 43200) ?? DEFAULT_VISIBILITY_TIMEOUT,
    messageRetentionSeconds: configInt(node, "messageRetentionSeconds", 60, 1209600) ?? DEFAULT_RETENTION_SECONDS,
  };
}

export function compileSqsQueue(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (!isManaged(node)) return { ...EMPTY_FRAGMENT };
  const cfg = readSqsConfig(node);
  const label = tfLabel(node.address);
  const name = cloudName(ctx.namePrefix, nodeName(node.address), 80 - 4);
  const tags = resourceTags(ctx.tags, node.address);
  const b = new FragmentBuilder(node.address);

  b.resource("aws_sqs_queue", label, {
    name,
    sqs_managed_sse_enabled: true,
    visibility_timeout_seconds: cfg.visibilityTimeout,
    message_retention_seconds: cfg.messageRetentionSeconds,
    redrive_policy: `\${jsonencode({ deadLetterTargetArn = aws_sqs_queue.${label}_dlq.arn, maxReceiveCount = ${MAX_RECEIVE_COUNT} })}`,
    tags,
  });
  b.resource("aws_sqs_queue", `${label}_dlq`, {
    name: `${name}-dlq`,
    sqs_managed_sse_enabled: true,
    message_retention_seconds: DLQ_RETENTION_SECONDS,
    // The DLQ carries the node's tags too (it belongs to the node); `zenith:role` tells the tag lookup it is not the queue itself.
    tags: { ...resourceTags(ctx.tags, node.address, `${name}-dlq`), [DLQ_ROLE_TAG]: DLQ_ROLE_VALUE },
  });
  b.resource("aws_sqs_queue_redrive_allow_policy", `${label}_dlq_allow`, {
    queue_url: `\${aws_sqs_queue.${label}_dlq.url}`,
    redrive_allow_policy: `\${jsonencode({ redrivePermission = "byQueue", sourceQueueArns = [aws_sqs_queue.${label}.arn] })}`,
  });

  b.expose(REF.arn, `aws_sqs_queue.${label}.arn`);
  b.expose(REF.id, `aws_sqs_queue.${label}.url`);
  b.expose("url", `aws_sqs_queue.${label}.url`);
  b.expose("name", `aws_sqs_queue.${label}.name`);
  b.output(`${label}_arn`, `\${aws_sqs_queue.${label}.arn}`);
  b.output(`${label}_url`, `\${aws_sqs_queue.${label}.url}`);
  b.output(`${label}_dlq_arn`, `\${aws_sqs_queue.${label}_dlq.arn}`);
  b.output(`${label}_dlq_url`, `\${aws_sqs_queue.${label}_dlq.url}`);
  return b.build();
}

/* --------------------------------- reading --------------------------------- */

const EXPECTED_NAMES = ["visibilityTimeout", "messageRetentionSeconds", "sseEnabled", "hasDeadLetterQueue", "maxReceiveCount"] as const;
const INFORMATIONAL_NAMES = ["deadLetterTargetArn", "delaySeconds", "fifo"] as const;
export const SQS_ATTRIBUTE_NAMES: readonly string[] = [...EXPECTED_NAMES, ...INFORMATIONAL_NAMES];

export function expectedSqsAttributes(node: ResourceNode): Record<string, unknown> {
  return expectedFor(node, () => buildExpectedSqs(node));
}

function buildExpectedSqs(node: ResourceNode): Record<string, unknown> {
  const cfg = readSqsConfig(node);
  return {
    visibilityTimeout: cfg.visibilityTimeout,
    messageRetentionSeconds: cfg.messageRetentionSeconds,
    sseEnabled: true,
    hasDeadLetterQueue: true,
    maxReceiveCount: MAX_RECEIVE_COUNT,
  };
}

export interface QueueRef {
  name: string;
  /** set when the caller supplied a URL */
  url?: string;
  account?: string;
}

/** A queue URL, an ARN (`arn:aws:sqs:region:acct:name`) or a bare queue name. */
export function queueRefOf(externalId: string | undefined): QueueRef | undefined {
  if (externalId === undefined || externalId === "") return undefined;
  const url = QUEUE_URL.exec(externalId);
  if (url) return { name: url[1], url: externalId };
  if (externalId.startsWith("arn:")) {
    const a = parseArn(externalId);
    if (!a || a.service !== "sqs") return undefined;
    const name = validId(a.resource, QUEUE_NAME);
    return name ? { name, account: a.accountId } : undefined;
  }
  const name = validId(externalId, QUEUE_NAME);
  return name ? { name } : undefined;
}

async function queueUrlOf(ctx: AwsDriverContext, ref: QueueRef): Promise<string> {
  if (ref.url) return ref.url;
  const sqs = ctx.session.client(SQSClient);
  const out = await call(ctx, (o) => sqs.send(new GetQueueUrlCommand({ QueueName: ref.name, ...(ref.account ? { QueueOwnerAWSAccountId: ref.account } : {}) }), o));
  if (!out.QueueUrl) throw Object.assign(new Error("QueueDoesNotExist"), { name: "QueueDoesNotExist" });
  return out.QueueUrl;
}

type Resolved = { ref: QueueRef } | "missing" | { ambiguous: string };

async function resolveQueue(ctx: AwsDriverContext, node: ResourceNode, externalId: string | undefined): Promise<Resolved> {
  const ref = queueRefOf(externalId);
  if (externalId !== undefined && externalId !== "" && ref === undefined) return { ambiguous: "externalId is not an SQS queue URL, ARN or name" };
  if (ref) return { ref };
  const { matches } = await findByTags(ctx, node, "sqs");
  // The node's DLQ carries the node's tags too; the primary queue is the one not tagged as a dead-letter queue.
  const primaries = matches.flatMap((m) => {
    const r = queueRefOf(m.arn);
    return r && m.tags[DLQ_ROLE_TAG] !== DLQ_ROLE_VALUE ? [r] : [];
  });
  if (primaries.length === 0) return "missing";
  if (primaries.length > 1) return { ambiguous: `${primaries.length} queues carry the Zenith tags for ${node.address}; refusing to choose one` };
  return { ref: primaries[0] };
}

async function getAttributes(ctx: AwsDriverContext, url: string): Promise<Partial<Record<QueueAttributeName, string>>> {
  const sqs = ctx.session.client(SQSClient);
  const out = await call(ctx, (o) => sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["All"] }), o));
  return out.Attributes ?? {};
}

interface Redrive {
  deadLetterTargetArn?: string;
  maxReceiveCount?: number;
}

function redriveOf(raw: string | undefined): Redrive | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as { deadLetterTargetArn?: unknown; maxReceiveCount?: unknown };
    return {
      ...(typeof v.deadLetterTargetArn === "string" ? { deadLetterTargetArn: v.deadLetterTargetArn } : {}),
      ...(v.maxReceiveCount !== undefined && Number.isFinite(Number(v.maxReceiveCount)) ? { maxReceiveCount: Number(v.maxReceiveCount) } : {}),
    };
  } catch {
    return undefined;
  }
}

const int = (s: string | undefined): number | undefined => (s !== undefined && /^\d+$/.test(s) ? Number(s) : undefined);

async function observeQueue(ctx: AwsDriverContext, node: ResourceNode, externalId?: string): Promise<Observation> {
  return guardObserve(
    ctx,
    node,
    SQS_SOURCE,
    SQS_ATTRIBUTE_NAMES,
    externalId,
    async (): Promise<ReadResult> => {
      const found = await resolveQueue(ctx, node, externalId);
      if (found === "missing") return { kind: "missing" };
      if ("ambiguous" in found) return { kind: "ambiguous", detail: found.ambiguous };
      const url = await queueUrlOf(ctx, found.ref);
      const attrs = await getAttributes(ctx, url);
      const redrive = redriveOf(attrs.RedrivePolicy);
      const a = new Attributes(ctx);
      a.set("visibilityTimeout", int(attrs.VisibilityTimeout));
      a.set("messageRetentionSeconds", int(attrs.MessageRetentionPeriod));
      a.set("sseEnabled", attrs.SqsManagedSseEnabled === "true" || (attrs.KmsMasterKeyId !== undefined && attrs.KmsMasterKeyId !== ""));
      a.set("hasDeadLetterQueue", redrive?.deadLetterTargetArn !== undefined);
      a.set("maxReceiveCount", redrive?.maxReceiveCount);
      a.set("deadLetterTargetArn", redrive?.deadLetterTargetArn);
      a.set("delaySeconds", int(attrs.DelaySeconds));
      a.set("fifo", attrs.FifoQueue === "true");

      let tags: Record<string, string> | undefined;
      let tagsFailure: string | undefined;
      try {
        const sqs = ctx.session.client(SQSClient);
        tags = tagMap((await call(ctx, (o) => sqs.send(new ListQueueTagsCommand({ QueueUrl: url }), o))).Tags);
      } catch (err) {
        const f = classifyAwsError(err, ctx.signal);
        if (f.kind === "aborted") throw err;
        tagsFailure = f.code;
      }
      return {
        kind: "present",
        externalId: attrs.QueueArn ?? url,
        attributes: a.finish(SQS_ATTRIBUTE_NAMES),
        native: { queueUrl: url, queueName: found.ref.name, ...(tags ? { tags } : { tagsUnreadable: tagsFailure ?? "unknown" }) },
      };
    },
    ["tags", "queueUrl", "queueName"]
  );
}

/* --------------------------------- runtime --------------------------------- */

async function runtimeQueue(ctx: AwsDriverContext, node: ResourceNode, externalId?: string) {
  return guardRuntime(ctx, node, SQS_SOURCE, async (): Promise<RuntimeRead> => {
    const found = await resolveQueue(ctx, node, externalId);
    if (found === "missing") return "missing";
    if ("ambiguous" in found) return { health: "unknown", counts: {}, signals: ["ambiguous_match"] };
    const url = await queueUrlOf(ctx, found.ref);
    const attrs = await getAttributes(ctx, url);
    const counts: Record<string, number> = {};
    const visible = int(attrs.ApproximateNumberOfMessages);
    const inFlight = int(attrs.ApproximateNumberOfMessagesNotVisible);
    const delayed = int(attrs.ApproximateNumberOfMessagesDelayed);
    if (visible !== undefined) counts.visible = visible;
    if (inFlight !== undefined) counts.inFlight = inFlight;
    if (delayed !== undefined) counts.delayed = delayed;
    const signals = ["counts_approximate"];

    // A non-empty dead-letter queue means messages are failing repeatedly.
    const dlqArn = redriveOf(attrs.RedrivePolicy)?.deadLetterTargetArn;
    let health: HealthState = "healthy";
    const dlq = dlqArn ? queueRefOf(dlqArn) : undefined;
    if (dlq) {
      try {
        const dlqAttrs = await getAttributes(ctx, await queueUrlOf(ctx, dlq));
        const depth = int(dlqAttrs.ApproximateNumberOfMessages);
        if (depth !== undefined) {
          counts.deadLettered = depth;
          if (depth > 0) {
            signals.push(`dead_letter_messages:${depth}`);
            health = "degraded";
          }
        }
      } catch (err) {
        const f = classifyAwsError(err, ctx.signal);
        if (f.kind === "aborted") throw err;
        signals.push(`dead_letter_queue_unreadable:${f.kind}`);
      }
    }
    return { health, counts, signals };
  });
}

/* -------------------------------- discover --------------------------------- */

async function discoverQueues(ctx: AwsDriverContext): Promise<DiscoveredResource[]> {
  const sqs = ctx.session.client(SQSClient);
  const { items } = await paginate(
    async (token) => {
      const out = await call(ctx, (o) => sqs.send(new ListQueuesCommand({ MaxResults: 1000, ...(token ? { NextToken: token } : {}) }), o));
      return { items: out.QueueUrls ?? [], next: out.NextToken || undefined };
    },
    { maxPages: 5, signal: ctx.signal }
  );
  const found: DiscoveredResource[] = [];
  let reads = 0;
  for (const url of items) {
    const m = QUEUE_URL.exec(url);
    if (!m) continue;
    const parts = url.split("/");
    const region = /^https:\/\/sqs\.([a-z0-9-]+)\./.exec(url)?.[1] ?? ctx.region;
    let tags: Record<string, string> | undefined;
    if (reads < MAX_TAG_READS) {
      reads++;
      try {
        tags = tagMap((await call(ctx, (o) => sqs.send(new ListQueueTagsCommand({ QueueUrl: url }), o))).Tags);
      } catch (err) {
        const f = classifyAwsError(err, ctx.signal);
        if (f.kind === "aborted") throw err;
      }
    }
    found.push(
      candidate(ctx, {
        kind: "queue",
        nativeType: "aws:sqs_queue",
        externalId: `arn:aws:sqs:${region}:${parts[3]}:${m[1]}`,
        name: m[1],
        region,
        ...(tags ? { tags } : {}),
        attributes: scalars({ queueUrl: url, tagsRead: tags !== undefined, fifo: m[1].endsWith(".fifo") }),
      })
    );
  }
  return found.sort((a, b) => (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0));
}

export const sqsQueueDriver: ResourceDriver<AwsSession> = {
  id: SQS_SOURCE,
  provider: "aws",
  kind: "queue",
  nativeType: "aws:sqs_queue",
  capabilities: {
    compile: true,
    observe: true,
    runtime: true,
    verify: true,
    discover: true,
    operations: [],
    evidence: { compile: "contract", observe: "contract", runtime: "contract", verify: "contract", discover: "contract" },
  },
  compile: compileSqsQueue,
  observe: observeQueue,
  runtime: runtimeQueue,
  expectedAttributes: expectedSqsAttributes,
  async verify(ctx, node, observation) {
    const checks = [
      attrCheck(observation, "encrypted", "messages are encrypted at rest", "sseEnabled", (v) => v === true),
      attrCheck(observation, "dead_letter_queue", "a dead-letter queue is configured", "hasDeadLetterQueue", (v) => v === true),
      matchesExpectedCheck(expectedSqsAttributes(node), observation),
    ];
    return verificationOf(ctx, node, observation, checks);
  },
  discover: discoverQueues,
};
