/**
 * Manual Container Apps migration job, one replica, zero replica retries. The
 * owning workload supplies image, identity, networking and secret REFERENCES.
 * A durable launch journal arbitrates creates/starts; a retry only reads the
 * retained job's execution. A response lost before its receipt is recorded is
 * reconciled through the job's execution list, never through another start.
 * ARM reports Succeeded/Failed, not numeric process exits. For our single
 * container and zero-retry job, Succeeded establishes exit 0. Failed cannot
 * establish a numeric exit: throw instead of inventing one. No logs are read.
 * https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/jobs-executions/list?view=rest-resource-manager-containerapps-2024-03-01
 * Contract evidence only; live execution and IAM are unverified.
 */
import type { MigrationsPort } from "@/lib/execution/ports";
import type { ResourceNode } from "@/lib/resources/types";
import { StepFailedError } from "@/lib/execution/errors";
import { digest } from "@/lib/controlplane/digest";
import { ArmError, armClient, type ArmResource } from "@/lib/providers/azure/arm";
import { API } from "@/lib/providers/azure/platform";
import { context, locate, workloadType, pinned, container, rec, arr, select, bounded, pause, tags, assertResource, validId, type Ctx, type LaunchJournal } from "./support";

async function executions(ctx: Ctx, job: string): Promise<string | undefined> {
  let list;
  try { list = await armClient(ctx.session, ctx.signal).list(`${job}/executions`, { apiVersion: API.containerApps }); } catch { throw new Error("Azure migration executions could not be read; launch outcome is unknown."); }
  if (list.truncated || list.items.length > 1) throw new Error("Azure migration executions are ambiguous; refusing another launch.");
  if (list.items.length === 0) return undefined;
  const item = list.items[0]; const name = item.name;
  if (typeof name !== "string" || !/^[a-z0-9-]{1,100}$/.test(name) || (item.id !== undefined && item.id !== `${job}/executions/${name}`)) throw new Error("Azure migration execution identity is unknown.");
  return `${job}/executions/${name}`;
}

async function readJob(ctx: Ctx, node: ResourceNode, jobId: string, key: string, command: readonly string[], image: string, source: ArmResource): Promise<ArmResource> {
  let job: ArmResource;
  try { job = (await armClient(ctx.session, ctx.signal).get<ArmResource>(jobId, { apiVersion: API.containerApps })).body; } catch { throw new Error("Azure migration job state is unknown."); }
  assertResource(ctx, node, job, "Microsoft.App/jobs");
  const props = rec(job.properties); const config = rec(props.configuration); const manual = rec(config.manualTriggerConfig); const c = container(rec(props.template));
  if (job.id !== jobId || job.tags?.["zenith:migration"] !== key || config.triggerType !== "Manual" || config.replicaRetryLimit !== 0 || manual.parallelism !== 1 || manual.replicaCompletionCount !== 1 || c.image !== image || JSON.stringify(c.command) !== JSON.stringify([command[0]]) || JSON.stringify(c.args) !== JSON.stringify(command.slice(1))) throw new StepFailedError("Azure migration job configuration does not match this release.");
  const sourceProps = rec(source.properties); const sourceConfig = rec(sourceProps.configuration); const sourceTemplate = rec(sourceProps.template);
  const sourceIdentity = Object.keys(rec(source.identity?.userAssignedIdentities)).map((id) => id.toLowerCase()).sort();
  const jobIdentity = Object.keys(rec(job.identity?.userAssignedIdentities)).map((id) => id.toLowerCase()).sort();
  const secrets = (value: unknown) => arr(value).map((s) => select(s, ["name", "keyVaultUrl", "identity"]));
  const registries = (value: unknown) => arr(value).map((s) => select(s, ["server", "identity"]));
  const fields = ["name", "image", "resources", "env", "volumeMounts"];
  if (props.environmentId !== (sourceProps.environmentId ?? sourceProps.managedEnvironmentId) || job.identity?.type !== "UserAssigned" || digest(sourceIdentity) !== digest(jobIdentity) || digest(secrets(config.secrets)) !== digest(secrets(sourceConfig.secrets)) || digest(registries(config.registries)) !== digest(registries(sourceConfig.registries)) || digest(select(c, fields)) !== digest(select(container(sourceTemplate), fields)) || digest(rec(props.template).volumes) !== digest(sourceTemplate.volumes)) throw new Error("Azure migration job identity/network/container differs from its owning workload; outcome is unknown.");
  return job;
}

export function createMigrationsPort(launches?: LaunchJournal): MigrationsPort {
  return {
    async runOneOffTask(raw, node, command, opts) {
      const original = context(raw);
      if (!command.length || command.length > 256 || command.some((arg) => typeof arg !== "string" || arg.includes("\0")) || !command[0] || Buffer.byteLength(JSON.stringify(command)) > 16_384 || !opts.idempotencyKey) throw new StepFailedError("Migration requires a bounded nonempty argv vector and idempotency key.");
      if (!launches) throw new StepFailedError("Azure migrations require a durable tenant-scoped launch journal.");
      const wait = bounded(original, opts.timeoutMs); const ctx = wait.ctx;
      try {
        const res = await locate(ctx, node, workloadType(node)); const props = rec(res.properties); const current = container(rec(props.template));
        if (typeof current.image !== "string") throw new Error("Azure migration image is unknown.");
        pinned(current.image);
        const config = rec(props.configuration); const secrets = arr(config.secrets);
        if (secrets.some((s) => s.value !== undefined || typeof s.keyVaultUrl !== "string" || typeof s.identity !== "string")) throw new StepFailedError("Azure migration secrets must be Key Vault references only.");
        const environment = props.environmentId ?? props.managedEnvironmentId;
        const identityIds = Object.keys(rec(res.identity?.userAssignedIdentities));
        if (typeof environment !== "string" || !validId(ctx, environment, "Microsoft.App/managedEnvironments") || typeof res.identity?.type !== "string" || !res.identity.type.includes("UserAssigned") || identityIds.length === 0 || identityIds.some((id) => !validId(ctx, id, "Microsoft.ManagedIdentity/userAssignedIdentities"))) throw new StepFailedError("Azure migration requires the workload's environment and reusable user-assigned identity.");
        if ([...secrets, ...arr(config.registries)].some((entry) => typeof entry.identity !== "string" || !identityIds.some((id) => id.toLowerCase() === String(entry.identity).toLowerCase()))) throw new StepFailedError("Azure migration registry/secret references must use the workload's own user-assigned identity.");
        const identity = { type: "UserAssigned", userAssignedIdentities: Object.fromEntries(identityIds.map((id) => [id, {}])) };
        const key = digest([ctx.session.subscriptionId, ctx.workspaceId, ctx.environmentId, "migrate", node.address, opts.idempotencyKey]);
        const jobId = `${res.id.slice(0, res.id.toLowerCase().lastIndexOf("/providers/"))}/providers/Microsoft.App/jobs/zn-migrate-${key.slice(0, 20)}`;
        const journalScope = { workspaceId: ctx.workspaceId, environmentId: ctx.environmentId, key };
        let claimed: boolean;
        try { claimed = await launches.claim(journalScope); } catch { throw new Error("Azure migration launch claim is unknown."); }
        let execution: string | undefined;
        if (claimed) {
          // A deterministic name collision must never overwrite a foreign job.
          try { await armClient(ctx.session, ctx.signal).get(jobId, { apiVersion: API.containerApps }); throw new StepFailedError("Azure migration job already exists without a matching launch receipt."); } catch (e) { if (!(e instanceof ArmError && e.kind === "not_found")) throw new Error("Azure migration job creation is unsafe or unconfirmed."); }
          try {
            await armClient(ctx.session, ctx.signal).put(jobId, { apiVersion: API.containerApps, headers: { "if-none-match": "*" }, body: { location: res.location, identity, tags: { ...tags(ctx, node), "zenith:migration": key }, properties: { environmentId: environment, ...(typeof props.workloadProfileName === "string" ? { workloadProfileName: props.workloadProfileName } : {}), configuration: { triggerType: "Manual", replicaTimeout: Math.max(1, Math.ceil(opts.timeoutMs / 1000)), replicaRetryLimit: 0, manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }, ...select(config, ["registries", "secrets"]) }, template: { containers: [{ ...select(current, ["name", "image", "resources", "env", "volumeMounts"]), command: [command[0]], args: command.slice(1) }], ...select(rec(props.template), ["volumes"]) } } } });
          } catch { throw new Error("Azure migration job creation is unconfirmed; this key will not launch again."); }
          for (;;) {
            const job = await readJob(ctx, node, jobId, key, command, current.image, res);
            const state = rec(job.properties).provisioningState;
            if (state === "Succeeded") break;
            if (state === "Failed" || state === "Canceled") throw new StepFailedError("Azure migration job provisioning failed.");
            if (Date.now() >= wait.deadline) throw new Error("Azure migration provisioning timed out; outcome is unknown.");
            await pause(ctx, wait.deadline);
          }
          try { await armClient(ctx.session, ctx.signal).post(`${jobId}/start`, { apiVersion: API.containerApps }); } catch { throw new Error("Azure migration launch is unconfirmed; reconcile before retrying."); }
        } else {
          await readJob(ctx, node, jobId, key, command, current.image, res);
          try { execution = await launches.read(journalScope); } catch { throw new Error("Azure migration launch receipt is unknown."); }
          if (execution && (!execution.startsWith(`${jobId}/executions/`) || !/^[a-z0-9-]{1,100}$/.test(execution.slice(jobId.length + 12)))) throw new StepFailedError("Azure migration receipt names a foreign execution.");
        }
        execution ??= await executions(ctx, jobId);
        if (!claimed && !execution) throw new Error("Azure migration launch outcome is unknown; this key will not launch again.");
        let recorded = !claimed;
        for (;;) {
          execution ??= await executions(ctx, jobId);
          if (execution) {
            if (!recorded) {
              try { await launches.record(journalScope, execution); } catch { throw new Error("Azure migration receipt could not be persisted; reconcile before retrying."); }
              recorded = true;
            }
            // The documented 2024-03-01 API lists executions; do not invent a
            // GET-execution endpoint or numeric exit field that it does not expose.
            const list = await armClient(ctx.session, ctx.signal).list(`${jobId}/executions`, { apiVersion: API.containerApps });
            if (list.truncated || list.items.length !== 1 || `${jobId}/executions/${list.items[0].name}` !== execution) throw new Error("Azure migration execution state is unknown or ambiguous.");
            const run = rec(list.items[0].properties); const c = container(rec(run.template));
            if (c.image !== current.image || JSON.stringify(c.command) !== JSON.stringify([command[0]]) || JSON.stringify(c.args) !== JSON.stringify(command.slice(1))) throw new Error("Azure migration execution template does not match its job.");
            if (run.status === "Succeeded" && typeof run.endTime === "string" && run.endTime) return { exitCode: 0 };
            if (["Failed", "Degraded", "Stopped"].includes(String(run.status))) throw new StepFailedError("Azure migration failed; ARM does not expose its numeric exit code. The database may be partially migrated.");
            if (!["Running", "Processing", "Succeeded"].includes(String(run.status))) throw new Error("Azure migration execution status is unknown.");
          }
          if (Date.now() >= wait.deadline) throw new Error("Azure migration timed out; outcome is unknown.");
          await pause(ctx, wait.deadline);
        }
      } catch (e) { original.signal.throwIfAborted(); if (wait.timeout.aborted) throw new Error("Azure migration timed out; outcome is unknown and must be reconciled."); if (e instanceof ArmError) throw new Error("Azure migration state could not be read; outcome is unknown."); throw e; }
    },
  };
}
