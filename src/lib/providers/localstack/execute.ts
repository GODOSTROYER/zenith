/**
 * Running one step: the real S3 and SQS calls, the simulated waits, and the
 * refusals that protect data the operator did not ask to lose. Split out of
 * the single-file adapter; the code is unchanged.
 */
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
} from "@aws-sdk/client-sqs";
import { log } from "@/lib/log";
import {
  FAST,
  LOCALSTACK_ENDPOINT,
  REAL_KINDS,
  SIMULATED_NOTE,
  bucketName,
  queueName,
  s3,
  sqs,
} from "./clients";
import { FAILURE_LABEL, health } from "./health";
import { DELETE_BUCKET, DELETE_QUEUE, looksLikeTeardown, teardownIntent } from "./teardown";
import { stepBudgetMs, type StepRuntime } from "@/lib/providers/types";


/* --------------------------------- execute --------------------------------- */

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, FAST() ? 15 : ms));

/** Already gone. Deleting twice is success, not failure — steps get retried. */
export const ABSENT = new Set([
  "NoSuchBucket",
  "NotFound",
  "QueueDoesNotExist",
  "AWS.SimpleQueueService.NonExistentQueue",
]);
export function absent(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return ABSENT.has(e?.name ?? "") || ABSENT.has(e?.Code ?? "") || e?.$metadata?.httpStatusCode === 404;
}

export const EMPTY_IT_YOURSELF = (name: string) =>
  `aws --endpoint-url ${LOCALSTACK_ENDPOINT} s3 rm s3://${name} --recursive`;

export const ALLOW_IT =
  'turn on "Allow deleting databases and other stateful resources" for this environment in Settings → Environments';

/**
 * Emptying policy, stated once: Zenith empties a bucket ONLY when the
 * environment sets `allowStatefulDeletion`. S3 refuses to delete a bucket that
 * still has objects in it, and Zenith will not quietly destroy data to get past
 * that — so with the policy off the step FAILS and names both ways forward.
 *
 * Failing is the honest outcome: the deployment stops, the revision is not
 * marked converged, and drift keeps reporting the bucket. The alternative —
 * skipping the delete and reporting success — is the bug.
 */
export async function deleteBucket(rt: StepRuntime, name: string): Promise<void> {
  const client = s3();
  rt.log(`${DELETE_BUCKET} ${name}`, "provider");

  let removed = 0;
  for (let pass = 0; pass < 100; pass++) {
    let page;
    try {
      page = await client.send(new ListObjectsV2Command({ Bucket: name, MaxKeys: 1000 }));
    } catch (err) {
      if (!absent(err)) throw err;
      rt.log(`bucket ${name} is already gone — nothing to delete`, "info");
      return;
    }
    const objects = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
    if (objects.length === 0) break;
    if (!rt.env.policies.allowStatefulDeletion)
      throw new Error(
        `Bucket "${name}" is no longer in this revision, but it still holds objects. Zenith does not destroy data to complete a removal, so this deployment stops here rather than reporting a convergence it did not reach — the bucket is still live in LocalStack. Empty it yourself (\`${EMPTY_IT_YOURSELF(name)}\`), or ${ALLOW_IT} and deploy again.`
      );
    rt.log(`s3:DeleteObjects ${name} (${objects.length})`, "provider");
    await client.send(
      new DeleteObjectsCommand({ Bucket: name, Delete: { Objects: objects, Quiet: true } })
    );
    removed += objects.length;
  }
  if (removed)
    rt.log(`emptied ${name} — ${removed} object(s) destroyed (this environment allows stateful deletion)`, "info");

  try {
    await client.send(new DeleteBucketCommand({ Bucket: name }));
  } catch (err) {
    if (!absent(err)) throw err;
    rt.log(`bucket ${name} was already gone`, "info");
    return;
  }
  rt.log(`bucket ${name} deleted — LocalStack now matches this revision`, "info");
}

/** Same policy for queues: undelivered messages are data. */
export async function deleteQueue(rt: StepRuntime, name: string): Promise<void> {
  const client = sqs();
  rt.log(`${DELETE_QUEUE} ${name}`, "provider");

  let url: string | undefined;
  try {
    url = (await client.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl;
  } catch (err) {
    if (!absent(err)) throw err;
    rt.log(`queue ${name} is already gone — nothing to delete`, "info");
    return;
  }
  if (!url)
    throw new Error(
      `LocalStack answered sqs:GetQueueUrl for "${name}" without a queue URL, so Zenith cannot confirm the queue was deleted. Check the container (\`localstack logs\`) and deploy again.`
    );

  const attrs = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    })
  );
  const n = (v?: string) => Number(v ?? 0) || 0;
  const held =
    n(attrs.Attributes?.ApproximateNumberOfMessages) +
    n(attrs.Attributes?.ApproximateNumberOfMessagesNotVisible);
  if (held > 0 && !rt.env.policies.allowStatefulDeletion)
    throw new Error(
      `Queue "${name}" is no longer in this revision, but it still holds roughly ${held} message(s). Zenith does not destroy data to complete a removal, so this deployment stops here rather than reporting a convergence it did not reach — the queue is still live in LocalStack. Drain it, or ${ALLOW_IT} and deploy again.`
    );

  await client.send(new DeleteQueueCommand({ QueueUrl: url }));
  rt.log(
    held > 0
      ? `queue ${name} deleted — roughly ${held} message(s) destroyed (this environment allows stateful deletion)`
      : `queue ${name} deleted — LocalStack now matches this revision`,
    "info"
  );
}

export async function executeStep(rt: StepRuntime): Promise<void> {
  const { step, env, revision } = rt;
  const m = revision.manifest;
  const est = stepBudgetMs(rt, 1500);

  if (step.phase === "prepare") {
    rt.log(`GET ${LOCALSTACK_ENDPOINT}/_localstack/health`, "provider");
    const result = await health();
    if (!result.ok) {
      log.warn("localstack health check failed", {
        kind: result.kind,
        endpoint: LOCALSTACK_ENDPOINT,
        deploymentId: rt.deployment.id,
        detail: result.detail,
      });
      throw new Error(
        `${FAILURE_LABEL[result.kind]} at ${LOCALSTACK_ENDPOINT}. ${result.detail} ${result.fix} Then deploy again.`
      );
    }
    const h = result.health;
    rt.log(
      `LocalStack ${h.version ?? "(unknown version)"} up — ${Object.values(h.services ?? {}).filter((s) => s === "running" || s === "available").length} services available`,
      "info"
    );
    return;
  }

  // Teardown first: the node is NOT in `m` — that is what makes it a teardown —
  // so the lookups below would miss it and the tail would sleep and report
  // success while the bucket or queue stayed live. The step's detail names what
  // to delete; a step that reads as a teardown but no longer parses fails.
  const detail = step.detail ?? "";
  const intent = teardownIntent(detail);
  if (intent?.kind === "bucket") return deleteBucket(rt, intent.name);
  if (intent?.kind === "queue") return deleteQueue(rt, intent.name);
  if (intent?.kind === "simulated") {
    rt.log(detail, "info");
    await sleep(Math.min(est, 600));
    return;
  }
  if (looksLikeTeardown(step.title))
    throw new Error(
      `Step "${step.title}" removes something from LocalStack but carries no provider detail naming it, so Zenith cannot delete it or confirm it is gone. Re-plan the deployment. Reporting success here would claim this revision converged while the resource is still live.`
    );

  const resource = m.resources.find((r) => r.id === step.targetId);
  const service = m.services.find((s) => s.id === step.targetId);

  // Real S3 bucket.
  if (resource?.kind === "object_store" && REAL_KINDS.has(resource.kind)) {
    const name = bucketName(resource.name, env);
    const client = s3();
    rt.log(`s3:CreateBucket ${name}`, "provider");
    try {
      await client.send(new CreateBucketCommand({ Bucket: name }));
    } catch (err) {
      const code = (err as { name?: string }).name ?? "";
      if (code !== "BucketAlreadyOwnedByYou" && code !== "BucketAlreadyExists") throw err;
      rt.log(`bucket ${name} already exists — idempotent, continuing`, "info");
    }
    await client.send(new HeadBucketCommand({ Bucket: name }));
    rt.output({
      key: `bucket-${resource.id}`,
      label: `${resource.name} — s3://${name} (LocalStack)`,
      value: `${LOCALSTACK_ENDPOINT}/${name}`,
      kind: "connection",
      targetId: resource.id,
    });
    rt.log(`bucket ${name} live at ${LOCALSTACK_ENDPOINT}/${name}`, "info");
    return;
  }

  // Real SQS queue.
  if (resource?.kind === "queue" && REAL_KINDS.has(resource.kind)) {
    const name = queueName(resource.name, env);
    rt.log(`sqs:CreateQueue ${name}`, "provider");
    const res = await sqs().send(new CreateQueueCommand({ QueueName: name }));
    rt.output({
      key: `queue-${resource.id}`,
      label: `${resource.name} — SQS queue (LocalStack)`,
      value: res.QueueUrl ?? `${LOCALSTACK_ENDPOINT}/000000000000/${name}`,
      kind: "connection",
      targetId: resource.id,
    });
    rt.log(`queue live: ${res.QueueUrl}`, "info");
    return;
  }

  // Labeled local simulations for everything LocalStack Community can't run.
  if (resource) {
    rt.log(`simulating ${resource.kind} "${resource.name}" — ${SIMULATED_NOTE[resource.kind] ?? "local simulation"}`, "info");
    await sleep(est);
    rt.output({
      key: `sim-${resource.id}`,
      label: `${resource.name} — simulated locally (real on AWS via export)`,
      value: `local://${resource.name}`,
      kind: "text",
      targetId: resource.id,
    });
    return;
  }

  if (service) {
    rt.log(`simulating ${service.kind} "${service.name}" (${service.replicas} replica${service.replicas === 1 ? "" : "s"})`, "info");
    await sleep(est);
    if (service.kind === "web" || service.kind === "static") {
      rt.output({
        key: `url-${service.id}`,
        label: `${service.name} — simulated preview (ECS is Pro/AWS territory)`,
        value: `/preview/${rt.deployment.id}/${service.id}`,
        kind: "url",
        targetId: service.id,
      });
    }
    return;
  }

  // Routes + verify.
  await sleep(est);
  if (step.phase === "verify") rt.log("outputs recorded — LocalStack deploy complete", "info");
}
