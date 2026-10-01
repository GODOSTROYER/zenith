/**
 * `azure:container_app_job` — portable `scheduled_job` on Container Apps jobs.
 *
 * A schedule becomes a `schedule_trigger_config` (cron, UTC; Azure takes the
 * standard five-field form). A job with no schedule gets a manual trigger: it
 * exists and can be started, but nothing starts it (the expansion already
 * notes this). One replica per execution, 30-minute timeout, one retry.
 *
 * Image, identity, registry and secret handling are shared with the Container
 * App (`workload.ts`): secrets are Key Vault references resolved with the
 * workload identity, never values.
 *
 * `runtime` reads the most recent executions; the job is "serving" only in the
 * sense that its last run did not fail, so `verify` does not require a steady
 * state.
 */
import type { CompileContext, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { ScheduledJobSpec } from "@/lib/resources/specs";
import { AzureCompileError, block, fragment, resolveNetwork, specOf } from "@/lib/providers/azure/compile-util";
import { exportLocals, exportRef } from "@/lib/providers/azure/exports";
import { defineAzureDriver, pick, props, type RuntimeRead } from "@/lib/providers/azure/kit";
import type { ArmClient, ArmResource, Json } from "@/lib/providers/azure/arm";
import { azureTags, tfLabel } from "@/lib/providers/azure/naming";
import { acaSize, API } from "@/lib/providers/azure/platform";
import { bootstrapArgs, buildWorkload, memoryToMb, RELEASE_ARGS_PATH, RELEASE_IMAGE_PATH } from "@/lib/providers/azure/drivers/compute/workload";

export const CONTAINER_JOB = { type: "Microsoft.App/jobs", apiVersion: API.containerApps } as const;

const CRON_FIELD = /^[0-9*/,\-A-Za-z]+$/;

/** Five whitespace-separated cron fields, restricted to characters a cron field can contain. */
export function assertCron(expr: string, where: string): string {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5 || !fields.every((f) => CRON_FIELD.test(f))) throw new AzureCompileError(`"${expr.slice(0, 60)}" is not a five-field cron expression.`, where);
  return fields.join(" ");
}

export function compileContainerAppJob(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const spec = specOf<ScheduledJobSpec>(node);
  const a = node.address;
  const net = resolveNetwork(node, ctx);
  const w = buildWorkload(node, ctx, spec);
  const L = tfLabel(a, "job");

  const container: Record<string, unknown> = { name: w.containerName, image: w.image, cpu: w.cpu, memory: w.memory, ...(w.env.length ? { env: w.env } : {}), ...(spec.artifact.type === "built" ? { args: bootstrapArgs() } : {}) };
  const body: Record<string, unknown> = {
    name: w.name,
    location: node.region,
    resource_group_name: exportRef(net, "rg_name"),
    container_app_environment_id: exportRef(net, "cae_id"),
    workload_profile_name: "Consumption",
    replica_timeout_in_seconds: 1800,
    replica_retry_limit: 1,
    ...(spec.schedule
      ? { schedule_trigger_config: { cron_expression: assertCron(spec.schedule, a), parallelism: 1, replica_completion_count: 1 } }
      : { manual_trigger_config: { parallelism: 1, replica_completion_count: 1 } }),
    ...(w.identityBlock ? { identity: w.identityBlock } : {}),
    ...(w.registry.length ? { registry: w.registry } : {}),
    ...(w.secrets.length ? { secret: w.secrets } : {}),
    template: { container: [container] },
    ...(spec.artifact.type === "built" ? { lifecycle: { ignore_changes: [RELEASE_IMAGE_PATH, RELEASE_ARGS_PATH] } } : {}),
    tags: azureTags(ctx, node),
  };
  return fragment({
    resource: block("azurerm_container_app_job", L, body),
    locals: exportLocals(a, { id: `\${azurerm_container_app_job.${L}.id}`, name: `\${azurerm_container_app_job.${L}.name}` }),
  });
}

export function expectedContainerAppJob(node: ResourceNode): Record<string, unknown> {
  const spec = specOf<ScheduledJobSpec>(node);
  const out: Record<string, unknown> = { trigger: spec.schedule ? "Schedule" : "Manual" };
  if (spec.schedule) out.schedule = spec.schedule.trim().split(/\s+/).join(" ");
  try {
    const size = acaSize(spec.vcpu, spec.memoryMb);
    out.vcpu = size.cpu;
    out.memoryMb = size.memoryMb;
  } catch {
    /* compile reports it */
  }
  if (spec.artifact.type === "image") out.image = spec.artifact.ref;
  return out;
}

function readJob(res: ArmResource): Record<string, unknown> {
  const c = pick<Json[]>(props(res), "template", "containers")?.[0];
  return {
    trigger: pick<string>(props(res), "configuration", "triggerType"),
    schedule: pick<string>(props(res), "configuration", "scheduleTriggerConfig", "cronExpression"),
    vcpu: pick<number>(c, "resources", "cpu"),
    memoryMb: memoryToMb(pick(c, "resources", "memory")),
    image: pick<string>(c, "image"),
  };
}

async function runtimeJob(_ctx: unknown, _node: ResourceNode, res: ArmResource, arm: ArmClient): Promise<RuntimeRead> {
  const { items } = await arm.list<Json>(`${res.id}/executions`, { apiVersion: API.containerApps }, 1);
  const recent = items.slice(0, 10);
  const counts: Record<string, number> = { executions: recent.length };
  const signals: string[] = [];
  if (recent.length === 0) return { health: "unknown", counts, signals: ["no_executions"] };
  const tally = { running: 0, succeeded: 0, failed: 0, other: 0 };
  for (const e of recent) {
    const s = String(pick<string>(e, "properties", "status") ?? "").toLowerCase();
    if (s === "running" || s === "processing") tally.running++;
    else if (s === "succeeded") tally.succeeded++;
    else if (s === "failed" || s === "degraded" || s === "stopped") tally.failed++;
    else tally.other++;
  }
  Object.assign(counts, tally);
  // newest first is the API's order; judge the job by its latest finished run
  const latest = String(pick<string>(recent[0], "properties", "status") ?? "").toLowerCase();
  if (latest === "failed" || latest === "degraded") signals.push(`last_execution_${latest}`);
  const health = latest === "failed" || latest === "degraded" ? "unhealthy" : tally.failed > 0 ? "degraded" : latest === "succeeded" || latest === "running" || latest === "processing" ? "healthy" : "unknown";
  return { health, counts, signals };
}

export const containerAppJobDriver = defineAzureDriver({
  id: "azure.container_app_job@1",
  kind: "scheduled_job",
  nativeType: "azure:container_app_job",
  arm: CONTAINER_JOB,
  compile: compileContainerAppJob,
  expected: expectedContainerAppJob,
  read: readJob,
  native: (res) => ({ provisioningState: props(res).provisioningState, triggerType: pick(props(res), "configuration", "triggerType") }),
  runtime: runtimeJob,
});
