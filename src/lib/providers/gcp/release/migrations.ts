/**
 * One Cloud Run job per migration key; one task, no task retries. Job create is
 * the atomic launch claim (409 loses). Only its creator invokes :run. A retry
 * recovers its single execution and never invokes :run again. A crash between
 * create and run is UNKNOWN and requires reconciliation, not another launch.
 * Jobs are retained for retry evidence. No command text or cloud errors escape.
 * https://cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs.executions.tasks
 * Contract-tested only; customer IAM and live execution remain unverified.
 */
import type { MigrationsPort } from "@/lib/execution/ports";
import { StepFailedError } from "@/lib/execution/errors";
import { digest } from "@/lib/controlplane/digest";
import { rec } from "@/lib/providers/gcp/read-kit";
import { gcpCall, gcpGet, gcpList } from "@/lib/providers/gcp/rest";
import { context, workload, container, pinned, bounded, pause, get, select, assertLabels, labels, RUN, type Ctx } from "./support";
import type { ResourceNode } from "@/lib/resources/types";

const TASK_KEYS = ["serviceAccount", "executionEnvironment", "encryptionKey", "vpcAccess", "volumes", "nodeSelector"] as const;
const CONTAINER_KEYS = ["name", "image", "env", "resources", "volumeMounts", "workingDir"] as const;

async function execution(ctx: Ctx, name: string): Promise<string | undefined> {
  const result = await gcpList(ctx, `${RUN}/${name}/executions?pageSize=100`, "executions");
  if (result.outcome !== "ok" || result.truncated || result.items.length > 1) throw new Error("Migration executions are unknown or ambiguous; refusing another launch.");
  const id = result.items[0]?.name;
  if (id === undefined && result.items.length === 0) return undefined;
  if (typeof id !== "string" || !id.startsWith(`${name}/executions/`) || !/^[a-z0-9-]+$/.test(id.slice(name.length + 12))) throw new Error("Migration execution identity is unknown.");
  return id;
}

function assertJob(ctx: Ctx, node: ResourceNode, job: Record<string, unknown>, name: string, token: string, command: readonly string[], image: string, sourceTemplate: Record<string, unknown>): void {
  assertLabels(ctx, node, job);
  const template = rec(job.template); const task = rec(template.template); const c = container(task);
  if (job.name !== name || rec(job.labels).zenith_migration !== token || template.taskCount !== 1 || template.parallelism !== 1 || task.maxRetries !== 0 || c.image !== image || JSON.stringify(c.command) !== JSON.stringify([command[0]]) || JSON.stringify(c.args) !== JSON.stringify(command.slice(1))) throw new StepFailedError("Migration job configuration does not match this release.");
  const source = container(sourceTemplate);
  const fields = ["name", "image", "env", "volumeMounts", "workingDir"];
  if (digest(select(task, TASK_KEYS)) !== digest(select(sourceTemplate, TASK_KEYS)) || digest(select(c, fields)) !== digest(select(source, fields)) || digest(rec(c.resources).limits) !== digest(rec(source.resources).limits)) throw new Error("Migration job identity/network/container differs from its owning workload; outcome is unknown.");
}

export function createMigrationsPort(): MigrationsPort {
  return {
    async runOneOffTask(raw, node, command, opts) {
      const original = context(raw);
      if (!command.length || command.length > 256 || command.some((arg) => typeof arg !== "string" || arg.includes("\0")) || !command[0] || Buffer.byteLength(JSON.stringify(command)) > 16_384 || !opts.idempotencyKey) throw new StepFailedError("Migration requires a bounded nonempty argv vector and idempotency key.");
      const wait = bounded(original, opts.timeoutMs); const ctx = wait.ctx;
      try {
        const found = await workload(ctx, node); const current = container(found.template);
        if (typeof current.image !== "string") throw new Error("Migration workload image is unknown.");
        pinned(current.image);
        if (typeof found.template.serviceAccount !== "string" || !found.template.serviceAccount.endsWith(`@${ctx.session.projectId}.iam.gserviceaccount.com`)) throw new StepFailedError("Migration must use the workload's dedicated service account.");
        const token = digest([ctx.workspaceId, ctx.environmentId, node.address, opts.idempotencyKey]).slice(0, 40);
        const name = `projects/${ctx.session.projectId}/locations/${ctx.region}/jobs/zn-migrate-${token}`;
        let prior = await gcpGet(ctx, `${RUN}/${name}`); let created = false;
        if (prior.outcome === "missing") {
          const task = { ...select(found.template, TASK_KEYS), containers: [{ ...select(current, CONTAINER_KEYS), resources: select(rec(current.resources), ["limits"]), command: [command[0]], args: command.slice(1) }], maxRetries: 0, timeout: `${Math.max(1, Math.ceil(opts.timeoutMs / 1000))}s` };
          const made = await gcpCall(ctx, "POST", `${RUN}/projects/${ctx.session.projectId}/locations/${ctx.region}/jobs?jobId=${name.split("/").pop()}`, { name, labels: { ...labels(ctx, node), zenith_migration: token }, template: { taskCount: 1, parallelism: 1, template: task } });
          if (made.outcome !== "ok" && made.status !== 409) throw new Error("Migration job creation is unconfirmed; refusing another launch.");
          if (made.json.error) throw new StepFailedError("Migration job creation failed.");
          created = made.outcome === "ok";
          prior = await gcpGet(ctx, `${RUN}/${name}`);
          while (created && prior.outcome === "missing") {
            if (Date.now() >= wait.deadline) throw new Error("Migration job creation timed out; outcome is unknown.");
            await pause(ctx, wait.deadline);
            prior = await gcpGet(ctx, `${RUN}/${name}`);
          }
        }
        if (prior.outcome !== "ok") throw new Error("Migration job state is unknown.");
        assertJob(ctx, node, prior.json, name, token, command, current.image, found.template);
        if (created) {
          for (;;) {
            const job = await get(ctx, `${RUN}/${name}`);
            assertJob(ctx, node, job, name, token, command, current.image, found.template);
            const terminal = rec(job.terminalCondition);
            if (terminal.state === "CONDITION_FAILED") throw new StepFailedError("Migration job provisioning failed.");
            if (job.reconciling === false && terminal.state === "CONDITION_SUCCEEDED") break;
            if (Date.now() >= wait.deadline) throw new Error("Migration job provisioning timed out; outcome is unknown.");
            await pause(ctx, wait.deadline);
          }
          // No automatic retry of a POST. Losing its response cannot justify executing twice.
          const launched = await gcpCall(ctx, "POST", `${RUN}/${name}:run`, {});
          if (launched.outcome !== "ok") throw new Error("Migration launch is unconfirmed; reconcile before retrying.");
          if (launched.json.error) throw new StepFailedError("Migration launch failed.");
        }
        let id = await execution(ctx, name);
        if (!created && !id) throw new Error("Migration launch outcome is unknown; this key will not launch again.");
        for (;;) {
          id ??= await execution(ctx, name);
          if (id) {
            const observed = await get(ctx, `${RUN}/${id}`);
            if (observed.name !== id || observed.job !== name || observed.taskCount !== 1) throw new Error("Migration execution identity or task count is unknown.");
            if (typeof observed.completionTime === "string" && observed.completionTime) {
              const tasks = await gcpList(ctx, `${RUN}/${id}/tasks?pageSize=100`, "tasks");
              if (tasks.outcome !== "ok" || tasks.truncated || tasks.items.length !== 1) throw new Error("Migration task result is missing or ambiguous.");
              const task = tasks.items[0]; const result = rec(task.lastAttemptResult);
              const exitCode = result.exitCode;
              if (task.execution !== id || task.job !== name || typeof task.completionTime !== "string" || !task.completionTime || !Number.isInteger(exitCode) || typeof exitCode !== "number" || exitCode < 0 || exitCode > 255 || (exitCode === 0 && (observed.succeededCount !== 1 || observed.failedCount !== 0))) throw new Error("Migration stopped without a consistent observed exit code.");
              return { exitCode };
            }
          }
          if (Date.now() >= wait.deadline) throw new Error("Migration execution timed out; outcome is unknown.");
          await pause(ctx, wait.deadline);
        }
      } catch (e) {
        original.signal.throwIfAborted();
        if (wait.timeout.aborted) throw new Error("Migration timed out; outcome is unknown and must be reconciled.");
        throw e;
      }
    },
  };
}
