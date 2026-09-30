/**
 * `gcp:pubsub_topic` — Pub/Sub, for both `queue` and `pubsub` nodes (the
 * native-type table maps both kinds here; `node.kind` decides the shape).
 *
 *   pubsub   one topic.
 *   queue    a topic, a pull subscription (60 s ack deadline, 7-day
 *            retention, never expires, 5 delivery attempts then dead-letter,
 *            exponential backoff 10–600 s), a dead-letter topic with its own
 *            retaining subscription, and the two bindings Pub/Sub needs to
 *            dead-letter: the Pub/Sub service agent publishes to the DLQ topic
 *            and subscribes on the main subscription (both resource-level).
 *
 * Encryption is Google-managed (`encryption: true`). Topics are data-bearing:
 * `deletion_policy = PREVENT` unless `deletionPolicy` is `allow`.
 *
 * Observation reads the topic (labels, encryption key). The subscription is a
 * secondary resource: its existence is proven by the tofu plan, and its IAM
 * grants by `gcp:service_account`; it is not read natively here.
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import type { ResourceNode } from "@/lib/resources/types";
import { cloudName, nodeLabels, tfLabel, tfSub, SUBSCRIPTION_SUFFIX } from "../../naming";
import { contractCapabilities, deletionGuard, nameResolver, specOf } from "../../driver-util";
import { dataFragment, expr, lastSegment, safeRegion } from "../../hcl";
import { makeReaders, rec, str, tail, type ReadSpec } from "../../read-kit";

export const DRIVER_ID = "gcp.pubsub_topic@1";
const PUBSUB = "https://pubsub.googleapis.com/v1";
const RETENTION = "604800s";

function expectedAttributes(_node: ResourceNode): Record<string, unknown> {
  return { encryption: "google-managed" };
}

function compile(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const L = tfLabel(node.address);
  if (node.ownership !== "managed") return dataFragment("google_pubsub_topic", L, { name: lastSegment(node.externalRef, node.address) });
  safeRegion(ctx.region);
  const guard = deletionGuard(specOf<{ deletionPolicy?: string }>(node));
  const labels = nodeLabels(ctx.tags, node);
  const topicName = cloudName(ctx.namePrefix, node.address, { max: 200 });
  const resource: NonNullable<TofuFragment["resource"]> = {
    google_pubsub_topic: { [L]: { name: topicName, labels, deletion_policy: guard.policy } },
  };
  const addresses = [`google_pubsub_topic.${L}`];
  const outputs: NonNullable<TofuFragment["output"]> = { [`${L}_topic`]: { value: expr(`google_pubsub_topic.${L}.name`), description: "topic name" } };
  let data: TofuFragment["data"];

  if (node.kind === "queue") {
    const dlq = tfSub(node.address, "dlq");
    const sub = tfSub(node.address, SUBSCRIPTION_SUFFIX);
    const dlqSub = tfSub(node.address, "dlq_sub");
    const dlqPub = tfSub(node.address, "dlq_publisher");
    const subScope = tfSub(node.address, "dlq_subscriber");
    const project = tfSub(node.address, "project");
    const agent = `serviceAccount:service-\${data.google_project.${project}.number}@gcp-sa-pubsub.iam.gserviceaccount.com`;
    data = { google_project: { [project]: {} } };
    resource.google_pubsub_topic[dlq] = { name: cloudName(ctx.namePrefix, node.address, { max: 200, suffix: "dlq" }), labels, deletion_policy: guard.policy };
    resource.google_pubsub_subscription = {
      [sub]: {
        name: cloudName(ctx.namePrefix, node.address, { max: 200, suffix: "sub" }),
        topic: expr(`google_pubsub_topic.${L}.id`),
        labels,
        ack_deadline_seconds: 60,
        message_retention_duration: RETENTION,
        retain_acked_messages: false,
        expiration_policy: [{ ttl: "" }],
        dead_letter_policy: [{ dead_letter_topic: expr(`google_pubsub_topic.${dlq}.id`), max_delivery_attempts: 5 }],
        retry_policy: [{ minimum_backoff: "10s", maximum_backoff: "600s" }],
        deletion_policy: guard.policy,
        depends_on: [`google_pubsub_topic_iam_member.${dlqPub}`],
      },
      [dlqSub]: {
        name: cloudName(ctx.namePrefix, node.address, { max: 200, suffix: "dlq-sub" }),
        topic: expr(`google_pubsub_topic.${dlq}.id`),
        labels,
        ack_deadline_seconds: 600,
        message_retention_duration: RETENTION,
        expiration_policy: [{ ttl: "" }],
        deletion_policy: guard.policy,
      },
    };
    // The Pub/Sub service agent forwards failed messages: publish to the DLQ topic, ack on the source subscription.
    resource.google_pubsub_topic_iam_member = { [dlqPub]: { topic: expr(`google_pubsub_topic.${dlq}.name`), role: "roles/pubsub.publisher", member: agent } };
    resource.google_pubsub_subscription_iam_member = {
      [subScope]: { subscription: expr(`google_pubsub_subscription.${sub}.name`), role: "roles/pubsub.subscriber", member: agent },
    };
    addresses.push(`google_pubsub_topic.${dlq}`, `google_pubsub_subscription.${sub}`, `google_pubsub_subscription.${dlqSub}`, `google_pubsub_topic_iam_member.${dlqPub}`, `google_pubsub_subscription_iam_member.${subScope}`, `data.google_project.${project}`);
    outputs[`${L}_subscription`] = { value: expr(`google_pubsub_subscription.${sub}.name`), description: "pull subscription name" };
    outputs[`${L}_dead_letter_topic`] = { value: expr(`google_pubsub_topic.${dlq}.name`), description: "dead-letter topic name" };
  }
  return { resource, ...(data ? { data } : {}), output: outputs, addresses };
}

const spec: ReadSpec = {
  driverId: DRIVER_ID,
  nativeType: "gcp:pubsub_topic",
  kind: "queue",
  attributes: ["encryption"],
  resolve: nameResolver((p) => `projects/${p}/topics/[A-Za-z][A-Za-z0-9_.~+%-]{2,254}`, PUBSUB, "Pub/Sub topic"),
  list: {
    url: (ctx) => `${PUBSUB}/projects/${ctx.session.projectId}/topics?pageSize=100`,
    itemsKey: "topics",
    labelsOf: (item) => rec(item.labels),
  },
  extract(o) {
    const name = str(o.name);
    if (!name) throw new Error("no name");
    const kms = str(o.kmsKeyName);
    return {
      externalId: name,
      name: tail(name),
      attributes: { encryption: kms ? "customer-managed" : "google-managed" },
      native: { state: str(o.state), messageRetentionDuration: str(o.messageRetentionDuration), hasSchema: !!str(rec(o.schemaSettings).schema) },
    };
  },
};

const readers = makeReaders(spec, expectedAttributes);

export const pubsubTopicDriver: ResourceDriver<GcpSession> = {
  id: DRIVER_ID,
  provider: "gcp",
  // serves both `queue` and `pubsub` nodes; the registry key is (provider, nativeType)
  kind: "queue",
  nativeType: "gcp:pubsub_topic",
  capabilities: contractCapabilities({ discover: true }),
  compile,
  observe: readers.observe,
  verify: readers.verify,
  discover: readers.discover,
  expectedAttributes,
};
