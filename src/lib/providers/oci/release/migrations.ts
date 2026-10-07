/**
 * One-off OCI Container Instances, argv only, restart policy NEVER. Stable retry
 * tokens and tagged recovery avoid automatic relaunch of an observed execution.
 * Raw logs are fully suppressed (runner result bodies are persisted). New IDs
 * receive trusted runner-created bindings. Terminal outcomes are durable runner
 * receipts; cleanup is limited to the receipt-owning signed workspace/operation.
 */
import { digest } from "@/lib/controlplane/digest";
import type { MigrationsPort } from "@/lib/execution/ports";
import { StepFailedError } from "@/lib/execution/errors";
import type { ResourceNode } from "@/lib/resources/types";
import { isPointerKey, looksSecretKey, urlHasCredentials } from "@/lib/resources/secrets";
import { asRecord, tagsOf } from "../observe-kit";
import { ociPath } from "../services";
import { readDeletionEvidence } from "../deletion-evidence";
import { awaitWorkRequest, receiptWorkRequestIds, WORK_REQUEST_APIS } from "../work-requests";
import { container, id, instance, instances, liveWorkloads, MIGRATION_TAG, owned, pause, releaseContext, request, timeoutSignal, workload,
  type RecordValue, type ReleaseContext } from "./support";

/** Reconstruct only manifest env and OCID pointers; never copy arbitrary cloud env. */
function environment(node: ResourceNode, c: RecordValue): Record<string, string> {
  const out: Record<string, string> = {};
  const source = asRecord(c.environmentVariables) ?? {};
  const entries = node.spec.env ?? [];
  if (!Array.isArray(entries) || entries.length > 100) throw new StepFailedError("OCI migration environment is invalid.");
  for (const raw of entries) {
    const entry = asRecord(raw);
    const key = entry?.key;
    if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,200}$/.test(key)) throw new StepFailedError("OCI migration environment key is invalid.");
    if (entry && "secretRef" in entry) {
      const pointer = `ZENITH_SECRET_OCID_${key.toUpperCase()}`;
      out[pointer] = id(source[pointer], "vaultsecret");
    } else {
      const value = entry?.value;
      if (typeof value !== "string" || value.length > 4096 || value.includes("\0") ||
          (looksSecretKey(key) && !isPointerKey(key)) || urlHasCredentials(value) || source[key] !== value) {
        throw new StepFailedError("OCI migration environment must match non-secret manifest values or Vault OCID pointers.");
      }
      out[key] = value;
    }
  }
  return out;
}

async function launchBody(ctx: ReleaseContext, node: ResourceNode, source: RecordValue, c: RecordValue,
  image: string, command: readonly string[], token: string): Promise<RecordValue> {
  const vnics = source.vnics;
  const config = asRecord(source.shapeConfig);
  if (!Array.isArray(vnics) || vnics.length !== 1 ||
      (Array.isArray(source.volumes) && source.volumes.length) ||
      (Array.isArray(source.imagePullSecrets) && source.imagePullSecrets.length) ||
      source.securityContext || source.dnsConfig || c.securityContext || c.resourceConfig ||
      (Array.isArray(c.volumeMounts) && c.volumeMounts.length) ||
      typeof source.availabilityDomain !== "string" || !/^[A-Za-z0-9:-]{1,128}$/.test(source.availabilityDomain) ||
      typeof source.shape !== "string" || !/^CI\.[A-Za-z0-9.]+\.Flex$/.test(source.shape) ||
      typeof config?.ocpus !== "number" || !Number.isFinite(config.ocpus) || config.ocpus < 1 || config.ocpus > 64 ||
      typeof config.memoryInGBs !== "number" || !Number.isFinite(config.memoryInGBs) || config.memoryInGBs < 1 || config.memoryInGBs > 1024 ||
      typeof c.isResourcePrincipalDisabled !== "boolean") {
    throw new StepFailedError("OCI migration requires the supported single-container, single-VNIC workload template without extra volumes, registry secrets or security overrides.");
  }
  const vnicId = id(asRecord(vnics[0])?.vnicId, "vnic");
  const res = await request(ctx, { service: "core", region: ctx.region, method: "GET", path: ociPath("core", "vnics", vnicId) });
  const vnic = asRecord(res.body);
  if (!vnic || vnic.id !== vnicId || vnic.compartmentId !== ctx.session.compartmentOcid ||
      vnic.publicIp || !Array.isArray(vnic.nsgIds) || vnic.nsgIds.length === 0) {
    throw new StepFailedError("OCI migration requires the workload's private, compartment-bound VNIC and security groups.");
  }
  const tags = { zenith_workspace: ctx.workspaceId, zenith_environment: ctx.environmentId,
    zenith_resource: node.address, zenith_managed: "true", [MIGRATION_TAG]: token };
  return {
    compartmentId: ctx.session.compartmentOcid, availabilityDomain: source.availabilityDomain,
    shape: source.shape, shapeConfig: { ocpus: config.ocpus, memoryInGBs: config.memoryInGBs },
    displayName: `zenith-migrate-${token}`, containerRestartPolicy: "NEVER", freeformTags: tags,
    containers: [{ imageUrl: image, command: [...command], arguments: [], environmentVariables: environment(node, c),
      isResourcePrincipalDisabled: c.isResourcePrincipalDisabled }],
    vnics: [{ subnetId: id(vnic.subnetId, "subnet"), nsgIds: vnic.nsgIds.map((n) => id(n, "networksecuritygroup")), isPublicIpAssigned: false }],
  };
}

/** The receipt journal's view of this execution (GET list with the selector never reaches OCI). */
async function runnerReceipt(ctx: ReleaseContext, token: string): Promise<RecordValue | undefined> {
  const res = await request(ctx, { service: "containerinstances", region: ctx.region, method: "GET",
    path: ociPath("containerinstances", "containerInstances"), query: { compartmentId: ctx.session.compartmentOcid }, migrationKey: token });
  return asRecord(res.body);
}

/**
 * Evidence-only: read the create work request recorded by the runner's journal. A
 * replacement runner that inherits the journal resumes here with GETs alone, so it
 * can never re-execute. FAILED/CANCELED creation is refused; unreadable or in-flight
 * work is not a conclusion and does not block observing the instance itself.
 */
async function checkCreateWorkRequest(ctx: ReleaseContext, token: string, workRequestId: string | undefined): Promise<void> {
  const api = WORK_REQUEST_APIS.containerinstances;
  if (!workRequestId || !api) return;
  const read = await awaitWorkRequest(ctx, api, workRequestId, { migrationKey: token, maxPolls: 1 });
  if (!read.ok) { ctx.log("OCI migration create work request could not be read; relying on instance readback.", "info"); return; }
  if (read.receipt.state === "failed" || read.receipt.state === "canceled") throw new Error("OCI migration creation work request did not succeed; outcome is unknown.");
  ctx.log(`OCI migration create work request is ${read.receipt.state}.`, "info");
}

/** One second apart: deletion usually finishes within seconds; the wait is bounded and never blocks the exit code. */
export const CLEANUP_CONFIRM_ATTEMPTS = 3;

async function cleanup(ctx: ReleaseContext, node: ResourceNode, migrationId: string, token: string): Promise<void> {
  try {
    await request(ctx, { service: "containerinstances", region: ctx.region, method: "DELETE",
      path: ociPath("containerinstances", "containerInstances", migrationId), migrationKey: token });
    ctx.log("OCI migration cleanup requested.", "info");
  } catch {
    ctx.log("OCI migration cleanup failed or was cancelled; cleanup remains unknown. The observed migration exit is preserved.", "info");
    return;
  }
  // Independent completion check. It never changes the observed exit code: it only
  // says whether OCI confirms the one-off is gone, and says "not confirmed" otherwise.
  try {
    let found: Awaited<ReturnType<typeof readDeletionEvidence>> | undefined;
    for (let attempt = 0; attempt < CLEANUP_CONFIRM_ATTEMPTS; attempt++) {
      // The journal gains the delete work-request id once the runner has recorded it.
      const journal = await runnerReceipt(ctx, token);
      found = await readDeletionEvidence(ctx, { ...node, nativeType: "oci:container_instance" }, migrationId,
        { migrationKey: token, workRequestId: receiptWorkRequestIds(journal).delete, wait: { maxPolls: 1 } });
      if (found.state !== "deleting" && found.state !== "present") break;
      if (attempt < CLEANUP_CONFIRM_ATTEMPTS - 1) await pause(ctx.signal);
    }
    if (!found) throw new Error("no evidence");
    ctx.log(found.state === "deleted" ? "OCI migration cleanup confirmed by independent readback." : `OCI migration cleanup is not confirmed (${found.state}); the one-off may still exist.`, "info");
  } catch {
    ctx.log("OCI migration cleanup could not be independently confirmed.", "info");
  }
}

export function createMigrationsPort(): MigrationsPort {
  return {
    async runOneOffTask(ctx, node, command, opts) {
      const oci = releaseContext(ctx);
      const desired = workload(oci, node);
      if (!ctx.operationId || typeof opts.idempotencyKey !== "string" || !opts.idempotencyKey || opts.idempotencyKey.length > 200 ||
          !Array.isArray(command) || command.length === 0 || command.length > 100 ||
          command.some((arg) => typeof arg !== "string" || arg.length > 4096 || arg.includes("\0") ||
            urlHasCredentials(arg) || /BEGIN [A-Z ]*PRIVATE KEY|(?:password|passwd|token|api[_-]?key|secret)\s*[=:]/i.test(arg)) || !command[0]) {
        throw new StepFailedError("OCI migration needs an operation, bounded idempotency key and nonempty argv vector.");
      }
      const bounded = { ...oci, signal: timeoutSignal(oci, opts.timeoutMs) };
      const token = digest({ workspace: ctx.workspaceId, environment: ctx.environmentId, operation: ctx.operationId,
        service: node.address, spec: node.specDigest, image: desired.image, command, key: opts.idempotencyKey }).slice(0, 48);
      const receiptResponse = await request(bounded, { service: "containerinstances", region: bounded.region, method: "GET",
        path: ociPath("containerinstances", "containerInstances"), query: { compartmentId: bounded.session.compartmentOcid }, migrationKey: token });
      const receipt = asRecord(receiptResponse.body);
      if (!receipt || !["absent", "running", "completed"].includes(String(receipt.state))) throw new Error("OCI migration durable execution intent is unresolved; outcome is unknown.");
      if (receipt.state === "completed") {
        if (!Number.isSafeInteger(receipt.exitCode) || (receipt.exitCode as number) < 0 || (receipt.exitCode as number) > 255) throw new Error("OCI migration receipt is malformed; outcome is unknown.");
        await cleanup(bounded, node, id(receipt.instanceId, "computecontainerinstance"), token);
        return { exitCode: receipt.exitCode as number };
      }
      await checkCreateWorkRequest(bounded, token, receiptWorkRequestIds(receipt).create);
      const all = await instances(bounded);
      const existing = all.filter((item) => owned(bounded, item, node.address) && tagsOf(item)[MIGRATION_TAG] === token);
      if (existing.length > 1) throw new Error("OCI migration has duplicate executions; outcome is unknown.");
      let migrationId: string;
      if (receipt.state === "running") {
        migrationId = id(receipt.instanceId, "computecontainerinstance");
        if (existing.length && existing[0].id !== migrationId) throw new Error("OCI migration receipt disagrees with cloud execution; outcome is unknown.");
      } else {
        if (existing.length) throw new Error("OCI migration has no trusted creation receipt; outcome is unknown.");
        const sources = liveWorkloads(bounded, all, node).sort((a, b) => String(a.id).localeCompare(String(b.id)));
        if (sources.length !== desired.replicas || !sources.length) throw new StepFailedError("OCI migration requires all desired workload replicas to exist.");
        const full = await instance(bounded, id(sources[0].id, "computecontainerinstance"), node.address);
        const c = await container(bounded, full, desired.image);
        if (full.lifecycleState !== "ACTIVE" || c.lifecycleState !== "ACTIVE") throw new StepFailedError("OCI migration source workload is not ACTIVE.");
        const body = await launchBody(bounded, node, full, c, desired.image, command, token);
        const launched = await request(bounded, { service: "containerinstances", region: bounded.region, method: "POST",
          path: ociPath("containerinstances", "containerInstances"), headers: { "opc-retry-token": `zenith-${token}` }, body, migrationKey: token });
        migrationId = id(asRecord(launched.body)?.id, "computecontainerinstance");
      }
      for (;;) {
        const full = await instance(bounded, migrationId, node.address, token);
        if (tagsOf(full)[MIGRATION_TAG] !== token || full.containerRestartPolicy !== "NEVER") throw new Error("OCI migration execution identity is unknown.");
        const c = await container(bounded, full, desired.image, token);
        if (digest(c.command) !== digest(command) || !Array.isArray(c.arguments) || c.arguments.length !== 0) {
          throw new Error("OCI migration command does not match its execution identity; outcome is unknown.");
        }
        if (c.lifecycleState === "INACTIVE") {
          const exitCode = c.exitCode;
          if (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255) {
            throw new Error("OCI migration stopped without an observed exit code; outcome is unknown.");
          }
          ctx.log(`OCI migration exited with code ${exitCode}; container logs suppressed.`, "info");
          await cleanup(bounded, node, migrationId, token);
          return { exitCode };
        }
        if (["FAILED", "DELETING", "DELETED"].includes(String(full.lifecycleState)) ||
            ["FAILED", "DELETING", "DELETED"].includes(String(c.lifecycleState))) {
          throw new Error("OCI migration ended without proven completion; outcome is unknown.");
        }
        await pause(bounded.signal);
      }
    },
  };
}
