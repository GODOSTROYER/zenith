/**
 * One-off migration Jobs copy an owned workload's pod settings and secret
 * REFERENCES. Commands are argv. No retries within the Job; TTL and active
 * deadline bound its lifetime. Exit codes come only from a UID-owned pod.
 *
 * A resourceVersion-guarded workload annotation claims each launch before POST.
 * Retries recover the named Job, never recreate a missing claimed Job (including
 * after TTL). Receipts are bounded to 128; deleting the workload deletes this
 * retry history. Regular sidecars are refused. Contract evidence only.
 */
import { ApiException, PatchStrategy, type KubernetesObject } from "@kubernetes/client-node";
import { digest } from "@/lib/controlplane/digest";
import type { MigrationsPort } from "@/lib/execution/ports";
import { StepFailedError } from "@/lib/execution/errors";
import type { ResourceNode } from "@/lib/resources/types";
import { READ_ONLY_KINDS, listByKind, readObject } from "../client";
import { ANNOTATION, LABEL, MANAGED_BY_VALUE, type K8sObject } from "../types";
import { deepEqual, dig, isRecord, plain, redactText, truncate } from "../util";
import { assertKey, assertOwnership, assertPinnedImage, boundedContext, loadWorkload, mainContainer, pause, releaseFailure, type OwnedWorkload, type ReleaseContext } from "./support";

const RECEIPT_PREFIX = "zenith.dev/migration-";
const REQUEST = "zenith.dev/migration-request";
const WORKSPACE = "zenith.dev/workspace";
const JOB_LABEL = "zenith.dev/migration";
interface Receipt { request: string; job: string; container: string; image: string; specDigest: string }

function commandCheck(command: readonly string[]): void {
  if (!Array.isArray(command) || !command.length || !command[0] || command.length > 128 || command.some((arg) => typeof arg !== "string" || arg.includes("\0")) || Buffer.byteLength(JSON.stringify(command)) > 16_384) {
    throw new StepFailedError("Migration command must be a bounded, nonempty argv vector.");
  }
}

function receiptOf(value: unknown, request: string): Receipt {
  let parsed: unknown;
  try { parsed = typeof value === "string" ? JSON.parse(value) : undefined; } catch { /* refuse below */ }
  if (!isRecord(parsed) || parsed.request !== request || typeof parsed.job !== "string" || !/^zenith-migrate-[a-f0-9]{40}$/.test(parsed.job) || typeof parsed.container !== "string" || typeof parsed.image !== "string" || typeof parsed.specDigest !== "string") {
    throw new StepFailedError("Migration launch receipt is invalid or the idempotency key was reused with different input.");
  }
  return parsed as unknown as Receipt;
}

function jobFor(ctx: ReleaseContext, node: ResourceNode, workload: OwnedWorkload, command: readonly string[], timeoutMs: number, name: string, request: string): K8sObject {
  const template = plain<Record<string, unknown>>(dig(workload.live, "spec", "template"));
  if (!isRecord(template) || !isRecord(template.spec)) throw new StepFailedError("Migration workload has no pod template.");
  const containers = template.spec.containers;
  if (!Array.isArray(containers) || containers.length !== 1) throw new StepFailedError("Kubernetes migration Jobs require a single regular workload container.");
  const container = mainContainer(node, template.spec);
  assertPinnedImage(container.image);
  container.command = [...command];
  container.args = [];
  for (const key of ["startupProbe", "readinessProbe", "livenessProbe", "lifecycle"]) delete container[key];
  template.spec.restartPolicy = "Never";
  // Migration pods must not become endpoints of the workload's Service.
  const labels = isRecord(dig(template, "metadata", "labels")) ? { ...dig(template, "metadata", "labels") as Record<string, unknown> } : {};
  const selector = dig(workload.live, "spec", "selector", "matchLabels");
  for (const key of Object.keys(isRecord(selector) ? selector : {})) delete labels[key];
  for (const key of ["pod-template-hash", "controller-uid", "job-name", "batch.kubernetes.io/controller-uid", "batch.kubernetes.io/job-name"]) delete labels[key];
  const ownership = { [ANNOTATION.environment]: ctx.environmentId, [ANNOTATION.resource]: node.address, [WORKSPACE]: ctx.workspaceId, [REQUEST]: request };
  const annotations = isRecord(dig(template, "metadata", "annotations")) ? dig(template, "metadata", "annotations") as Record<string, unknown> : {};
  template.metadata = { labels: { ...labels, [LABEL.managedBy]: MANAGED_BY_VALUE, [JOB_LABEL]: name }, annotations: { ...annotations, ...ownership } };
  return {
    apiVersion: "batch/v1", kind: "Job",
    metadata: {
      name, namespace: workload.ref.namespace,
      labels: { [LABEL.managedBy]: MANAGED_BY_VALUE, [JOB_LABEL]: name },
      annotations: { ...ownership, ...(ctx.fence ? { [ANNOTATION.fenceToken]: String(ctx.fence.token) } : {}) },
      ownerReferences: [{ apiVersion: workload.ref.apiVersion, kind: workload.kind, name: workload.ref.name, uid: dig(workload.live, "metadata", "uid") }],
    },
    spec: { completions: 1, parallelism: 1, backoffLimit: 0, activeDeadlineSeconds: Math.ceil(timeoutMs / 1000), ttlSecondsAfterFinished: 3600, template },
  };
}

async function claim(ctx: ReleaseContext, node: ResourceNode, workload: OwnedWorkload, command: readonly string[], opts: { timeoutMs: number; idempotencyKey: string }): Promise<{ workload: OwnedWorkload; receipt: Receipt; job?: K8sObject }> {
  const scope = digest([ctx.workspaceId, ctx.environmentId, node.address, opts.idempotencyKey]);
  const marker = `${RECEIPT_PREFIX}${scope.slice(0, 48)}`;
  const request = digest({ scope, command, timeoutMs: opts.timeoutMs, specDigest: node.specDigest });
  const uid = dig(workload.live, "metadata", "uid");
  for (let attempt = 0; attempt < 5; attempt++) {
    if (dig(workload.live, "metadata", "uid") !== uid) throw new Error("Migration workload changed; launch outcome is unknown.");
    const annotations = dig(workload.live, "metadata", "annotations");
    const existing = isRecord(annotations) ? annotations[marker] : undefined;
    if (existing !== undefined) return { workload, receipt: receiptOf(existing, request) };
    if (Object.keys(isRecord(annotations) ? annotations : {}).filter((k) => k.startsWith(RECEIPT_PREFIX)).length >= 128) throw new StepFailedError("Migration launch receipt limit reached; reconcile retained operation history before removing receipts.");
    const job = jobFor(ctx, node, workload, command, opts.timeoutMs, `zenith-migrate-${scope.slice(0, 40)}`, request);
    const container = mainContainer(node, dig(job, "spec", "template", "spec"));
    const receipt = { request, job: job.metadata.name, container: container.name as string, image: container.image as string, specDigest: digest(job.spec) };
    (job.metadata.annotations as Record<string, string>)[ANNOTATION.specDigest] = receipt.specDigest;
    try {
      await workload.client.objects.patch({
        apiVersion: workload.ref.apiVersion, kind: workload.kind,
        metadata: { name: workload.ref.name, namespace: workload.ref.namespace, uid, resourceVersion: dig(workload.live, "metadata", "resourceVersion"), annotations: { [marker]: JSON.stringify(receipt) } },
      } as KubernetesObject, undefined, undefined, "zenith-release", false, PatchStrategy.MergePatch);
      return { workload, receipt, job };
    } catch (e) {
      if (!(e instanceof ApiException) || e.code !== 409) throw e;
      workload = await loadWorkload(ctx, node, workload.client);
    }
  }
  throw new Error("Migration launch claim raced repeatedly; outcome is unknown.");
}

function verifyJob(ctx: ReleaseContext, node: ResourceNode, workload: OwnedWorkload, job: Record<string, unknown>, receipt: Receipt, command: readonly string[], timeoutMs: number): string {
  assertOwnership(ctx, node, job);
  const owners = dig(job, "metadata", "ownerReferences");
  if (dig(job, "metadata", "annotations", WORKSPACE) !== ctx.workspaceId || dig(job, "metadata", "annotations", REQUEST) !== receipt.request || dig(job, "metadata", "annotations", ANNOTATION.specDigest) !== receipt.specDigest || !Array.isArray(owners) || !owners.some((owner) => isRecord(owner) && owner.uid === dig(workload.live, "metadata", "uid") && owner.kind === workload.kind && owner.name === workload.ref.name)) {
    throw new StepFailedError("Migration Job is outside this workload or launch receipt.");
  }
  const container = mainContainer(node, dig(job, "spec", "template", "spec"));
  if (container.name !== receipt.container || container.image !== receipt.image || !deepEqual(container.command, command) || !deepEqual(container.args ?? [], []) || dig(job, "spec", "backoffLimit") !== 0 || dig(job, "spec", "completions") !== 1 || dig(job, "spec", "parallelism") !== 1 || dig(job, "spec", "activeDeadlineSeconds") !== Math.ceil(timeoutMs / 1000) || dig(job, "spec", "ttlSecondsAfterFinished") !== 3600 || dig(job, "spec", "template", "spec", "restartPolicy") !== "Never") {
    throw new StepFailedError("Migration Job does not match the claimed execution.");
  }
  const uid = dig(job, "metadata", "uid");
  if (typeof uid !== "string") throw new Error("Migration Job identity is unknown.");
  return uid;
}

async function logTail(ctx: ReleaseContext, workload: OwnedWorkload, job: Record<string, unknown>, pod: Record<string, unknown>, receipt: Receipt, command: readonly string[]): Promise<void> {
  const name = dig(pod, "metadata", "name");
  if (typeof name !== "string") return;
  try {
    const text = await workload.client.core.readNamespacedPodLog({ namespace: workload.ref.namespace as string, name, container: receipt.container, tailLines: 40, limitBytes: 4096, timestamps: false });
    const known = [...command];
    const podSpec = dig(job, "spec", "template", "spec");
    for (const key of ["containers", "initContainers"]) {
      const containers = dig(podSpec, key);
      for (const container of Array.isArray(containers) ? containers : []) {
        const env = dig(container, "env");
        for (const entry of Array.isArray(env) ? env : []) {
          if (isRecord(entry) && typeof entry.value === "string") known.push(entry.value);
        }
      }
    }
    // Scrub BEFORE truncation so a boundary cannot expose part of a known value.
    let scrubbed = text;
    for (const value of [...new Set(known)].filter(Boolean).sort((a, b) => b.length - a.length)) {
      // The API's byte cap can cut a known value: also redact a matching suffix.
      for (let length = Math.min(value.length - 1, scrubbed.length); length > 0; length--) {
        if (scrubbed.endsWith(value.slice(0, length))) { scrubbed = `${scrubbed.slice(0, -length)}[redacted]`; break; }
      }
      scrubbed = scrubbed.split(value).join("[redacted]");
    }
    const tail = truncate(redactText(scrubbed).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""), 4096);
    if (tail) ctx.log(`Kubernetes migration log tail (external data):\n${tail}`);
  } catch { ctx.log("Kubernetes migration log tail unavailable.", "warn"); }
}

export function createMigrationsPort(): MigrationsPort {
  return {
    async runOneOffTask(ctx, node, command, opts) {
      let mayHaveLaunched = false;
      try {
        commandCheck(command);
        assertKey(opts.idempotencyKey);
        const scoped = boundedContext(ctx, opts.timeoutMs);
        const claimed = await claim(scoped, node, await loadWorkload(scoped, node), command, opts);
        const { workload, receipt } = claimed;
        if (claimed.job) {
          try { await workload.client.objects.create(claimed.job as KubernetesObject, undefined, undefined, "zenith-release"); }
          catch (e) { if (!(e instanceof ApiException) || e.code !== 409) throw e; }
        }
        mayHaveLaunched = true;
        const ref = { apiVersion: "batch/v1", kind: "Job", name: receipt.job, namespace: workload.ref.namespace };
        let jobUid: string | undefined;
        for (;;) {
          const job = await readObject(workload.client, ref);
          if (!job) throw new Error("Claimed migration Job is absent; outcome is unknown and it will not be relaunched.");
          const uid = verifyJob(scoped, node, workload, job, receipt, command, opts.timeoutMs);
          if (jobUid && uid !== jobUid) throw new Error("Migration Job was replaced; outcome is unknown.");
          jobUid = uid;
          const conditions = dig(job, "status", "conditions");
          const complete = Array.isArray(conditions) && conditions.some((c) => isRecord(c) && c.type === "Complete" && c.status === "True");
          const failed = Array.isArray(conditions) && conditions.some((c) => isRecord(c) && c.type === "Failed" && c.status === "True");
          if (complete || failed) {
            const result = await listByKind(workload.client, READ_ONLY_KINDS.Pod, ref.namespace, { labelSelector: `batch.kubernetes.io/controller-uid=${uid}`, limit: 20, maxPages: 1 });
            const pods = result.items.filter((p) => {
              const owners = dig(p, "metadata", "ownerReferences");
              return Array.isArray(owners) && owners.some((o) => isRecord(o) && o.kind === "Job" && o.uid === uid && o.controller === true);
            });
            if (result.truncated || pods.length !== 1) throw new Error("Migration pod identity is unknown.");
            const statuses = dig(pods[0], "status", "containerStatuses");
            const container = Array.isArray(statuses) ? statuses.find((c) => isRecord(c) && c.name === receipt.container) : undefined;
            const exitCode = dig(container, "state", "terminated", "exitCode");
            if (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255 || (complete && failed) || (complete && exitCode !== 0) || (failed && exitCode === 0)) throw new Error("Migration Job ended without a consistent observed exit code; outcome is unknown.");
            await logTail(scoped, workload, job, pods[0], receipt, command);
            return { exitCode, logsRef: `k8s-job:${ref.namespace}/${receipt.job}` };
          }
          await pause(scoped.signal);
        }
      } catch (e) {
        // Once launched/recovered, refused observation cannot establish the task's outcome.
        if (mayHaveLaunched) throw new Error("Kubernetes migration outcome is unknown; the claimed Job must be reconciled.");
        return releaseFailure(e);
      }
    },
  };
}
