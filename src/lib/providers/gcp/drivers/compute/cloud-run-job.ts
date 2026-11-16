/**
 * `gcp:cloud_run_job` — a Cloud Run v2 job plus, when `schedule` is set, a
 * Cloud Scheduler job that runs it.
 *
 * Compile (primary first):
 *   google_cloud_run_v2_job          image, cpu/memory, env + Secret Manager
 *                                    env, Direct VPC egress (see run-common.ts),
 *                                    runtime service account, max_retries 1,
 *                                    600 s task timeout, deletion_protection off
 *                                    built artifacts bootstrap by digest; release
 *                                    owns the image and digest annotation, which
 *                                    OpenTofu retains on subsequent applies
 *   google_service_account (runtime) only when the node has no identity node
 *   when `schedule` is set:
 *     google_service_account         dedicated scheduler identity
 *     google_cloud_run_v2_job_iam_member   run.invoker for that account on THIS job only
 *     google_cloud_scheduler_job     HTTP target POST …/jobs/<job>:run with an OAuth
 *                                    token minted for the scheduler account
 *
 * `schedule` must be a 5-field unix cron expression (Cloud Scheduler syntax).
 * AWS-style `cron(…)`/`rate(…)` expressions are refused, not translated.
 * Time zone is UTC.
 *
 * Observation: the job (image, cpu, memory, env names) and, for scheduled
 * nodes, the Cloud Scheduler job found by its Zenith-tagged description
 * (`schedule`). Runtime: the job's Ready condition and its latest execution.
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import type { ScheduledJobSpec } from "@/lib/resources/specs";
import type { Observation, ObservedValue, ResourceNode } from "@/lib/resources/types";
import { GcpCompileError } from "../../errors";
import { cloudName, labelsMatch, nodeLabels, parseTagDescription, tagDescription, tfLabel, tfSub } from "../../naming";
import { RUN, cloudRunJobName, contractCapabilities, managedOnly, specOf } from "../../driver-util";
import { dataFragment, expr, lastSegment, safeRegion } from "../../hcl";
import { arr, makeReaders, num, rec, str, tail, type ReadSpec } from "../../read-kit";
import { gcpList } from "../../rest";
import { cpuString, directVpcEgress, envBlocks, parseCpu, parseMemoryMb, runCpu, runMemoryMb, runtimeIdentity } from "./run-common";
import { imageOf, ignoredImageChanges } from "./run-image";

export const DRIVER_ID = "gcp.cloud_run_job@1";
const SCHEDULER = "https://cloudscheduler.googleapis.com/v1";
const CRON_FIELD = /^[0-9A-Za-z*/,?-]+$/;

export function assertCron(expression: string, where: string): string {
  const fields = String(expression).trim().split(/\s+/);
  if (fields.length !== 5 || !fields.every((f) => CRON_FIELD.test(f))) {
    throw new GcpCompileError("unsupported_schedule", `${where}: schedule must be a 5-field unix cron expression (Cloud Scheduler); AWS cron()/rate() expressions are not translated.`);
  }
  return fields.join(" ");
}

function sizing(s: ScheduledJobSpec) {
  const cpu = runCpu(s.vcpu);
  return { cpu, memoryMb: runMemoryMb(s.memoryMb, cpu) };
}

function desiredAttributes(node: ResourceNode): Record<string, unknown> {
  const s = specOf<ScheduledJobSpec>(node);
  const { cpu, memoryMb } = sizing(s);
  const a = s.artifact as { type?: string; ref?: string };
  return {
    ...(a?.type === "image" ? { image: a.ref } : {}),
    cpu,
    memory: memoryMb,
    envKeys: (s.env ?? []).map((e) => e.key).sort(),
    ...(s.schedule ? { schedule: String(s.schedule).trim().split(/\s+/).join(" ") } : {}),
  };
}

/** Foreign (`referenced`/`external`) nodes carry only declared attributes; Zenith demands no configuration of them. */
const expectedAttributes = managedOnly(desiredAttributes);

function compile(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const L = tfLabel(node.address);
  if (node.ownership !== "managed") {
    return dataFragment("google_cloud_run_v2_job", L, { name: lastSegment(node.externalRef, node.address), location: safeRegion(node.region) });
  }
  safeRegion(ctx.region);
  const s = specOf<ScheduledJobSpec>(node);
  const { cpu, memoryMb } = sizing(s);
  const identity = runtimeIdentity(node, ctx);
  const vpc = directVpcEgress(node, ctx);
  const container: Record<string, unknown> = {
    name: "job",
    image: imageOf(node, ctx),
    resources: [{ limits: { cpu: cpuString(cpu), memory: `${memoryMb}Mi` } }],
  };
  const env = envBlocks(s.env, node, ctx);
  if (env.length) container.env = env;
  const task: Record<string, unknown> = {
    service_account: identity.email,
    max_retries: 1,
    timeout: "600s",
    execution_environment: "EXECUTION_ENVIRONMENT_GEN2",
    containers: [container],
  };
  if (vpc) task.vpc_access = [vpc];

  const job = `google_cloud_run_v2_job.${L}`;
  const resource: NonNullable<TofuFragment["resource"]> = {
    google_cloud_run_v2_job: {
      [L]: {
        name: cloudName(ctx.namePrefix, node.address, { max: 63 }),
        location: ctx.region,
        labels: nodeLabels(ctx.tags, node),
        deletion_protection: false,
        template: [{ template: [task] }],
        ...(ignoredImageChanges(node).length ? { lifecycle: { ignore_changes: ignoredImageChanges(node) } } : {}),
      },
    },
  };
  const addresses = [job];
  if (identity.extra) {
    resource[identity.extra.type] = { [identity.extra.label]: identity.extra.body };
    addresses.push(`${identity.extra.type}.${identity.extra.label}`);
  }
  if (s.schedule) {
    const cron = assertCron(s.schedule, node.address);
    const sa = tfSub(node.address, "sched");
    const member = tfSub(node.address, "sched_invoker");
    const sched = tfSub(node.address, "schedule");
    resource.google_service_account = {
      ...(resource.google_service_account ?? {}),
      [sa]: {
        account_id: cloudName(ctx.namePrefix, node.address, { max: 30, min: 6, suffix: "sch" }),
        display_name: "Zenith job scheduler",
        description: tagDescription(ctx.tags, node, "scheduler identity", 256),
      },
    };
    resource.google_cloud_run_v2_job_iam_member = {
      [member]: { name: expr(`${job}.name`), location: ctx.region, role: "roles/run.invoker", member: `serviceAccount:\${google_service_account.${sa}.email}` },
    };
    resource.google_cloud_scheduler_job = {
      [sched]: {
        name: cloudName(ctx.namePrefix, node.address, { max: 100, suffix: "run" }),
        region: ctx.region,
        description: tagDescription(ctx.tags, node, "job schedule", 500),
        schedule: cron,
        time_zone: "Etc/UTC",
        attempt_deadline: "320s",
        retry_config: [{ retry_count: 1 }],
        http_target: [
          {
            http_method: "POST",
            uri: `https://run.googleapis.com/v2/\${${job}.id}:run`,
            oauth_token: [{ service_account_email: expr(`google_service_account.${sa}.email`), scope: "https://www.googleapis.com/auth/cloud-platform" }],
          },
        ],
        depends_on: [`google_cloud_run_v2_job_iam_member.${member}`],
      },
    };
    addresses.push(`google_service_account.${sa}`, `google_cloud_run_v2_job_iam_member.${member}`, `google_cloud_scheduler_job.${sched}`);
  }
  return { resource, addresses };
}

const spec: ReadSpec = {
  driverId: DRIVER_ID,
  nativeType: "gcp:cloud_run_job",
  kind: "scheduled_job",
  attributes: ["image", "cpu", "memory", "envKeys", "schedule"],
  resolve: cloudRunJobName,
  list: {
    url: (ctx) => `${RUN}/projects/${ctx.session.projectId}/locations/${ctx.region}/jobs?pageSize=100`,
    itemsKey: "jobs",
    labelsOf: (item) => rec(item.labels),
  },
  extract(o) {
    const name = str(o.name);
    if (!name) throw new Error("no name");
    const task = rec(rec(rec(o.template).template));
    const c = rec(arr(task.containers)[0]);
    const limits = rec(rec(c.resources).limits);
    return {
      externalId: name,
      name: tail(name),
      attributes: {
        image: str(c.image),
        cpu: parseCpu(str(limits.cpu)),
        memory: parseMemoryMb(str(limits.memory)),
        envKeys: arr(c.env).map((e) => str(rec(e).name)).filter((n): n is string => !!n).sort(),
      },
      native: { generation: str(o.generation), executionCount: num(o.executionCount), maxRetries: num(task.maxRetries), timeout: str(task.timeout) },
    };
  },
  runtime(o) {
    const state = str(rec(o.terminalCondition).state);
    const health = state === "CONDITION_SUCCEEDED" ? "healthy" : state === "CONDITION_FAILED" ? "unhealthy" : state === "CONDITION_RECONCILING" || state === "CONDITION_PENDING" ? "degraded" : "unknown";
    const signals: string[] = [];
    const last = rec(o.latestCreatedExecution);
    if (str(last.name)) {
      const done = !!str(last.completionTime);
      signals.push(done ? "last_execution:completed" : "last_execution:running");
    } else {
      signals.push("never_executed");
    }
    const counts: Record<string, number> = {};
    const n = num(o.executionCount);
    if (n !== undefined) counts.executionCount = n;
    return { health, counts, signals };
  },
};

const readers = makeReaders(spec, expectedAttributes, { serving: true });

/** Augment the job observation with the Cloud Scheduler schedule for scheduled nodes. */
async function observe(...args: Parameters<typeof readers.observe>): Promise<Observation> {
  const [ctx, node] = args;
  const obs = await readers.observe(...args);
  const s = specOf<ScheduledJobSpec>(node);
  if (!s.schedule || obs.presence !== "present") return obs;
  const at = ctx.now().toISOString();
  const list = await gcpList(ctx, `${SCHEDULER}/projects/${ctx.session.projectId}/locations/${ctx.region}/jobs?pageSize=500`, "jobs");
  let value: ObservedValue;
  if (list.outcome !== "ok") {
    value = { state: "unknown", reason: list.outcome === "inaccessible" ? "access_denied" : "error", detail: list.detail };
  } else {
    const want = nodeLabels(ctx.tags, node);
    const found = list.items.filter((j) => labelsMatch(parseTagDescription(j.description), want));
    if (found.length === 1 && str(found[0].schedule)) value = { state: "known", value: String(found[0].schedule).trim().split(/\s+/).join(" "), observedAt: at };
    else value = { state: "unknown", reason: "not_inspected", detail: found.length === 0 ? "no scheduler job carries this node's Zenith tags" : "ambiguous scheduler job tags" };
  }
  return { ...obs, attributes: { ...obs.attributes, schedule: value } };
}

export const cloudRunJobDriver: ResourceDriver<GcpSession> = {
  id: DRIVER_ID,
  provider: "gcp",
  kind: "scheduled_job",
  nativeType: "gcp:cloud_run_job",
  capabilities: contractCapabilities({ runtime: true, discover: true }),
  compile,
  observe,
  runtime: readers.runtime,
  verify: readers.verify,
  discover: readers.discover,
  expectedAttributes,
};
