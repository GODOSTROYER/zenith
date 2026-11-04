/**
 * Read-only SNS configuration, with broker-owned clients and bounded pagination.
 * Policy output contains counts only; principals, conditions and endpoint text
 * never escape. `subscriptions` names confirmed desired queue bindings, not a
 * complete inventory. Tag ambiguity, denied reads and incomplete lists stay
 * unknown. Evidence is SDK contract tests only, never live AWS acceptance.
 */
import { DescribeKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { GetTopicAttributesCommand, ListSubscriptionsByTopicCommand, SNSClient } from "@aws-sdk/client-sns";
import {
  attempt, classifyAwsError, matchesNodeTags, paginate, parseArn, partitionOfRegion,
  throwIfAborted, unknownReasonOf, type AwsDriverContext,
} from "@/lib/providers/aws/drivers/shared";
import { Attributes, call, findByTags } from "@/lib/providers/aws/drivers/data/support";
import { DLQ_ROLE_TAG, DLQ_ROLE_VALUE } from "@/lib/providers/aws/drivers/data/sqs-queue";
import type { ResourceNode } from "@/lib/resources/types";
import { KMS_KEY_ARN } from "./support";

export const SNS_ATTRIBUTES = ["encrypted", "kmsKeyArn", "subscriptions", "policySummary"] as const;
const SQS_ARN = /^arn:aws(?:-cn|-us-gov)?:sqs:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,80}(?:\.fifo)?$/;
const MRK_KEY_ARN = /^arn:aws(?:-cn|-us-gov)?:kms:[a-z0-9-]+:\d{12}:key\/mrk-[a-f0-9]{32}$/;
const KEY_ID = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|mrk-[a-f0-9]{32}|alias\/[A-Za-z0-9/_-]{1,250})$/;

/** Classify errors without copying provider messages or arbitrary error names. */
export async function safeMetadataRead<T>(ctx: AwsDriverContext, read: () => Promise<T>): Promise<T> {
  try {
    throwIfAborted(ctx.signal);
    const value = await read();
    throwIfAborted(ctx.signal);
    return value;
  } catch (error) {
    const name = error instanceof Error ? error.name : undefined;
    const denied = /^(AuthorizationError(?:Exception)?|InvalidSecurity(?:Exception)?)$/.test(name ?? "");
    const failure = classifyAwsError(denied ? { name: "AccessDeniedException" } : error, ctx.signal);
    const safe = new Error(`AWS metadata read ${failure.kind === "inaccessible" ? "was denied" : failure.kind === "missing" ? "reports the resource is missing" : failure.kind === "aborted" ? "was aborted" : "failed"}.`);
    safe.name = { inaccessible: "AccessDeniedException", missing: "NotFoundException", throttled: "ThrottlingException", aborted: "AbortError", error: "Error" }[failure.kind];
    throw safe;
  }
}

/** All strings from a policy are data; only generator-owned count keys leave. */
function policySummary(raw: string | undefined): Record<string, number> | undefined {
  if (raw === undefined || raw.length > 65_536) return undefined;
  try {
    const policy: unknown = JSON.parse(raw);
    if (!policy || typeof policy !== "object" || Array.isArray(policy) || !("Statement" in policy)) return undefined;
    const statements = Array.isArray(policy.Statement) ? policy.Statement : [policy.Statement];
    if (statements.length > 1_000) return undefined;
    const summary = { statements: statements.length, allowStatements: 0, denyStatements: 0, wildcardPrincipalStatements: 0, conditionedStatements: 0 };
    for (const statement of statements) {
      if (!statement || typeof statement !== "object" || Array.isArray(statement)) return undefined;
      if (statement.Effect === "Allow") summary.allowStatements++;
      else if (statement.Effect === "Deny") summary.denyStatements++;
      else return undefined;
      const principal: unknown = statement.Principal;
      const values = principal && typeof principal === "object" && !Array.isArray(principal) ? Object.values(principal) : [principal];
      if (values.some((v) => v === "*" || (Array.isArray(v) && v.includes("*")))) summary.wildcardPrincipalStatements++;
      if (statement.Condition && typeof statement.Condition === "object" && Object.keys(statement.Condition).length > 0) summary.conditionedStatements++;
    }
    return summary;
  } catch { return undefined; }
}

function regionalKey(arn: string, ctx: AwsDriverContext): boolean {
  const parsed = parseArn(arn);
  return (KMS_KEY_ARN.test(arn) || MRK_KEY_ARN.test(arn)) && parsed?.region === ctx.region && parsed.partition === partitionOfRegion(ctx.region);
}

async function readEncryption(ctx: AwsDriverContext, attributes: Attributes, key: string | undefined): Promise<void> {
  if (key === undefined) {
    attributes.unknown("encrypted", "not_inspected", "SNS did not return the encryption field");
    attributes.unknown("kmsKeyArn", "not_inspected", "SNS did not return the encryption field");
  } else if (key === "") {
    attributes.set("encrypted", false);
    attributes.set("kmsKeyArn", null);
  } else if (regionalKey(key, ctx) || KEY_ID.test(key)) {
    attributes.set("encrypted", true);
    if (regionalKey(key, ctx)) { attributes.set("kmsKeyArn", key); return; }
    // SNS can return a key id or alias; an ARN is known only after KMS resolves it.
    const kms = ctx.session.client(KMSClient);
    const result = await attempt(() => safeMetadataRead(ctx, () => call(ctx, (o) => kms.send(new DescribeKeyCommand({ KeyId: key }), o))), ctx.signal);
    if (!result.ok) attributes.unknown("kmsKeyArn", unknownReasonOf(result.failure), result.failure.summary);
    else if (result.value.KeyMetadata?.Arn && regionalKey(result.value.KeyMetadata.Arn, ctx)) attributes.set("kmsKeyArn", result.value.KeyMetadata.Arn);
    else attributes.unknown("kmsKeyArn", "error", "KMS did not return an exact key ARN in this region");
  } else {
    attributes.unknown("encrypted", "error", "SNS returned an invalid encryption key reference");
    attributes.unknown("kmsKeyArn", "error", "SNS returned an invalid encryption key reference");
  }
}

async function readSubscriptions(ctx: AwsDriverContext, node: ResourceNode, arn: string, queues: string[], attributes: Attributes): Promise<Record<string, unknown>> {
  if (queues.length > 100) {
    attributes.unknown("subscriptions", "not_inspected", "the desired queue bindings exceed the bounded lookup limit");
    return {};
  }
  const sns = ctx.session.client(SNSClient);
  const result = await attempt(() => safeMetadataRead(ctx, () => paginate(async (token) => {
    const page = await call(ctx, (o) => sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: arn, ...(token ? { NextToken: token } : {}) }), o));
    return { items: page.Subscriptions ?? [], next: page.NextToken || undefined };
  }, { maxPages: 20, signal: ctx.signal })), ctx.signal);
  if (!result.ok) {
    attributes.unknown("subscriptions", unknownReasonOf(result.failure), result.failure.summary);
    return {};
  }
  const { items, truncated } = result.value;
  const native = { subscriptionCount: items.length, subscriptionsTruncated: truncated };
  if (truncated) {
    attributes.unknown("subscriptions", "not_inspected", "the SNS subscription list is incomplete");
    return native;
  }
  // Reject malformed SQS rows before inferring that a desired binding is absent.
  const endpoints = new Set<string>();
  for (const item of items) {
    if (!item.Protocol || item.TopicArn !== arn) {
      attributes.unknown("subscriptions", "error", "SNS returned an incomplete or mismatched subscription");
      return native;
    }
    if (item.Protocol !== "sqs") continue;
    if (!item.Endpoint || !SQS_ARN.test(item.Endpoint) || !item.SubscriptionArn) {
      attributes.unknown("subscriptions", "error", "SNS returned an invalid SQS subscription");
      return native;
    }
    if (item.SubscriptionArn === "PendingConfirmation" || item.SubscriptionArn === "Deleted") continue;
    const suffix = item.SubscriptionArn.slice(arn.length + 1);
    if (!item.SubscriptionArn.startsWith(`${arn}:`) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(suffix)) {
      attributes.unknown("subscriptions", "error", "SNS did not return an exact subscription ARN");
      return native;
    }
    endpoints.add(item.Endpoint);
  }
  const confirmed: string[] = [];
  for (const address of queues) {
    const lookup = await attempt(() => safeMetadataRead(ctx, () => findByTags(ctx, { ...node, address }, "sqs")), ctx.signal);
    if (!lookup.ok) {
      attributes.unknown("subscriptions", unknownReasonOf(lookup.failure), lookup.failure.summary);
      return native;
    }
    const matches = [...new Set(lookup.value.matches.filter((m) => SQS_ARN.test(m.arn)
      && parseArn(m.arn)?.accountId === ctx.session.accountId && parseArn(m.arn)?.region === ctx.region
      && parseArn(m.arn)?.partition === partitionOfRegion(ctx.region) && matchesNodeTags(m.tags, ctx, address)
      && m.tags[DLQ_ROLE_TAG] !== DLQ_ROLE_VALUE).map((m) => m.arn))];
    if (lookup.value.truncated || matches.length !== 1) {
      attributes.unknown("subscriptions", "not_inspected", "the tagging index did not resolve exactly one scoped primary bound queue");
      return native;
    }
    if (endpoints.has(matches[0])) confirmed.push(address);
  }
  // The observation contract has no graph lookup to identify native dependency
  // types. Explicit subscriptions are supported; untyped native edges stay unknown.
  if (node.dependsOn.some((address) => address.startsWith("provider_native/") && !queues.includes(address))) {
    attributes.unknown("subscriptions", "not_inspected", "a native dependency's type cannot be resolved without the resource graph");
  } else attributes.set("subscriptions", confirmed);
  return native;
}

export async function readSnsTopic(ctx: AwsDriverContext, node: ResourceNode, arn: string, queues: string[]) {
  const sns = ctx.session.client(SNSClient);
  const topic = await safeMetadataRead(ctx, () => call(ctx, (o) => sns.send(new GetTopicAttributesCommand({ TopicArn: arn }), o)));
  const attributes = new Attributes(ctx);
  if (topic.Attributes?.TopicArn !== arn) {
    for (const name of SNS_ATTRIBUTES) attributes.unknown(name, "error", "SNS did not return the requested topic ARN");
    return { attributes: attributes.finish(SNS_ATTRIBUTES), native: {} };
  }
  await readEncryption(ctx, attributes, topic.Attributes.KmsMasterKeyId);
  const summary = policySummary(topic.Attributes.Policy);
  if (summary) attributes.set("policySummary", summary);
  else attributes.unknown("policySummary", topic.Attributes.Policy === undefined ? "not_inspected" : "error", "SNS did not return a valid bounded topic policy");
  const native = await readSubscriptions(ctx, node, arn, queues, attributes);
  return { attributes: attributes.finish(SNS_ATTRIBUTES), native };
}
