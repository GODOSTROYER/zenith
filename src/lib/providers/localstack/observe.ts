/**
 * Reading LocalStack back: what is really there, whether the deployment
 * converged, and what a fresh connection can discover. Split out of the
 * single-file adapter; the code is unchanged.
 */
import { HeadBucketCommand, ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import { GetQueueUrlCommand, ListQueuesCommand } from "@aws-sdk/client-sqs";
import type { CloudConnection, Environment, Manifest } from "@/lib/domain/types";
import { LOCALSTACK_ENDPOINT, REAL_KINDS, bucketName, queueName, s3, sqs } from "./clients";
import { FAILURE_LABEL, health } from "./health";
import { absent } from "./execute";
import type {
  Discovery,
  DiscoveredResource,
  LiveResource,
  LiveState,
  ProviderVerification,
} from "@/lib/providers/types";


/* ---------------------------- observe / discover --------------------------- */

/**
 * Everything LocalStack can actually be asked about, in two calls. Buckets and
 * queues are the kinds this adapter provisions for real; the rest were labeled
 * simulations at deploy time and there is nothing on the endpoint to read back.
 */
export async function inventory(): Promise<{
  buckets: { name: string; createdAt: string }[];
  queues: { name: string; url: string }[];
}> {
  const [b, q] = await Promise.all([
    s3().send(new ListBucketsCommand({})),
    sqs().send(new ListQueuesCommand({})),
  ]);
  return {
    buckets: (b.Buckets ?? [])
      .filter((x) => x.Name)
      .map((x) => ({ name: x.Name!, createdAt: x.CreationDate?.toISOString() ?? "" })),
    queues: (q.QueueUrls ?? []).map((u) => ({ name: u.split("/").pop() ?? u, url: u })),
  };
}

/** Every read path needs LocalStack up and reports failure the same way. */
export async function requireHealthy(): Promise<void> {
  const h = await health();
  if (!h.ok)
    throw new Error(
      `${FAILURE_LABEL[h.kind]} at ${LOCALSTACK_ENDPOINT}. ${h.detail} ${h.fix}`
    );
}

/** Complete read-back for the subset this adapter actually provisions. */
export async function verify(env: Environment, deployed: Manifest, previous?: Manifest): Promise<ProviderVerification> {
  const supported = (m: Manifest) => !m.services.length && !m.routes.length && !m.bindings.length &&
    m.resources.every((r) => r.ownership === "managed" && REAL_KINDS.has(r.kind) && Object.keys(r.config).length === 0);
  // This adapter only provisions names/presence for S3 and SQS. Configuration,
  // routing, bindings and simulated kinds must never inherit an existence check.
  if (!supported(deployed) || (previous && !supported(previous)))
    return { status: "unavailable", simulated: false, checkedAt: new Date().toISOString(), checks: [],
      detail: "LocalStack can fully verify only managed S3 buckets and SQS queues with default configuration, without services, routes or bindings. This deployment has incomplete verification coverage." };
  const physicalName = (r: Manifest["resources"][number]) =>
    `${r.kind}:${r.kind === "object_store" ? bucketName(r.name, env) : queueName(r.name, env)}`;
  const kept = new Set(deployed.resources.map(physicalName));
  const removed = (previous?.resources ?? []).filter((r) => !kept.has(physicalName(r)))
    .map((r, i) => ({ ...r, id: `removed:${i}:${r.id}` }));
  await requireHealthy();
  // Direct reads avoid interpreting a truncated inventory page as absence.
  const checks = await Promise.all([...deployed.resources, ...removed].map(async (r) => {
    const shouldExist = kept.has(physicalName(r));
    let exists = true;
    const client = r.kind === "object_store" ? s3() : sqs();
    try {
      if (client instanceof S3Client) await client.send(new HeadBucketCommand({ Bucket: bucketName(r.name, env) }));
      else {
        const result = await client.send(new GetQueueUrlCommand({ QueueName: queueName(r.name, env) }));
        if (!result.QueueUrl) throw new Error(`LocalStack did not return a queue URL for ${r.name}. Verification is unavailable.`);
      }
    } catch (error) {
      if (!absent(error)) throw error;
      exists = false;
    } finally { client.destroy(); }
    return { detail: `${physicalName(r)} — expected ${shouldExist ? "present" : "absent"}, observed ${exists ? "present" : "absent"}.`,
      passed: exists === shouldExist };
  }));
  const checkedAt = new Date().toISOString();
  if (!checks.length) return { status: "unavailable", simulated: false, checkedAt, checks,
    detail: "There are no resource changes to verify." };
  const passed = checks.every((check) => check.passed);
  return { status: passed ? "passed" : "failed", simulated: false, checkedAt, checks,
    detail: passed ? `Verified ${checks.length} resource presence/removal checks against LocalStack.`
      : "LocalStack resource state does not match the deployment. Inspect the failed checks before deploying again." };
}

/**
 * Real read-back. Reports on the buckets and queues this adapter provisions,
 * by the names it provisions them under, plus anything else on the endpoint
 * that this environment does not own.
 *
 * Kinds LocalStack Community cannot emulate are deliberately ABSENT rather
 * than reported as present: drift treats a missing key as "not looked at", so
 * omitting them is what stops this from claiming an RDS instance is healthy
 * when no RDS instance was ever created.
 *
 * ponytail: "unowned" means unowned *by this environment*. Two Zenith
 * environments sharing one LocalStack each list the other's buckets as extra
 * drift. Scope the owned-set across the workspace's environments if that
 * combination stops being a corner case.
 */
export async function observe(env: Environment, deployed: Manifest): Promise<LiveState> {
  await requireHealthy();
  const inv = await inventory();
  const observedAt = new Date().toISOString();
  const resources: LiveResource[] = [];
  const owned = new Set<string>();

  for (const r of deployed.resources) {
    if (r.ownership !== "managed") continue;
    if (r.kind === "object_store") {
      const name = bucketName(r.name, env);
      owned.add(`s3:${name}`);
      const hit = inv.buckets.find((b) => b.name === name);
      resources.push({
        nodeId: r.id,
        kind: r.kind,
        exists: !!hit,
        attributes: hit
          ? { externalRef: `s3://${hit.name}`, name: hit.name, createdAt: hit.createdAt }
          : {},
        observedAt,
      });
    } else if (r.kind === "queue") {
      const name = queueName(r.name, env);
      owned.add(`sqs:${name}`);
      const hit = inv.queues.find((x) => x.name === name);
      resources.push({
        nodeId: r.id,
        kind: r.kind,
        exists: !!hit,
        attributes: hit ? { externalRef: hit.url, name: hit.name } : {},
        observedAt,
      });
    }
  }

  for (const b of inv.buckets)
    if (!owned.has(`s3:${b.name}`))
      resources.push({
        nodeId: "",
        kind: "object_store",
        exists: true,
        attributes: { externalRef: `s3://${b.name}`, name: b.name, createdAt: b.createdAt },
        observedAt,
      });

  for (const x of inv.queues)
    if (!owned.has(`sqs:${x.name}`))
      resources.push({
        nodeId: "",
        kind: "queue",
        exists: true,
        attributes: { externalRef: x.url, name: x.name },
        observedAt,
      });

  return { simulated: false, observedAt, resources };
}

/**
 * Everything visible at the endpoint. The adapter has a connection, not a
 * manifest, so it cannot know what is already imported — callers de-duplicate
 * by `externalRef` (the discover route filters against a project's working
 * copy, and `project.importResources` skips duplicates again).
 */
export async function discover(_conn: CloudConnection, _region?: string): Promise<Discovery> {
  await requireHealthy();
  const inv = await inventory();
  const resources: DiscoveredResource[] = [
    ...inv.buckets.map((b) => ({
      externalRef: `s3://${b.name}`,
      kind: "object_store" as const,
      name: b.name,
      attributes: { endpoint: LOCALSTACK_ENDPOINT, createdAt: b.createdAt },
    })),
    ...inv.queues.map((x) => ({
      externalRef: x.url,
      kind: "queue" as const,
      name: x.name,
      attributes: { endpoint: LOCALSTACK_ENDPOINT },
    })),
  ];
  return { simulated: false, resources };
}
