/**
 * `aws:ecs_scheduled_task` — a container job run on a schedule.
 *
 * Kind `scheduled_job`. Compile reuses the Fargate task plumbing
 * (`ecs-task.ts`: own cluster, security group, execution role, task
 * definition) and adds an EventBridge rule whose target runs the task
 * (`RunTask`) in the private subnets, no public IP.
 *
 * Schedule: the manifest's 5-field Unix cron is translated to EventBridge's
 * 6-field `cron(...)` by `toEventBridgeCron` (day-of-week renumbered, the
 * dom/dow `?` rule, UTC) and anything that cannot be translated faithfully is
 * a compile error. A job with no schedule compiles to its task definition
 * only (nothing triggers it).
 *
 * Events role: may `ecs:RunTask` on EXACTLY this task-definition revision and
 * only into this job's cluster (condition `ecs:cluster`), and `iam:PassRole`
 * on exactly the execution role and the task role, only to ecs-tasks. The
 * target retries a failed invocation twice within an hour (the EventBridge
 * default of 185 attempts over 24 hours would repeat a broken job all day).
 *
 * Observe / runtime / verify: the task definition is read through ECS and the
 * rule's existence through the Resource Groups Tagging API. HONEST LIMIT: the
 * rule's schedule expression, state and target cannot be read because
 * `@aws-sdk/client-eventbridge` is not an installed dependency (this worker
 * may not add one), so `verify` reports a `schedule_observable` check as
 * `unknown` rather than claiming the schedule matches.
 *
 * A built job picks up a new image at the next `infrastructure.apply` (the
 * task definition reads the image pointer, see ecs-task.ts); there is no fast
 * `deployImage` path for jobs because retargeting the rule needs EventBridge
 * writes.
 */
import { DescribeTaskDefinitionCommand, ECSClient, ListTasksCommand, type TaskDefinition } from "@aws-sdk/client-ecs";
import type { AwsSession } from "@/lib/credentials/types";
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { HealthState, Observation, ResourceNode, RuntimeState } from "@/lib/resources/types";
import type { ScheduledJobSpec } from "@/lib/resources/specs";
import { attempt, attributesOf, boundNative, cloudName, failedObservation, nodeName, parseArn, runtimeState, standardVerification, tfLabel, unknownReasonOf, unknownValue } from "./support/aws-shared";
import { toEventBridgeCron } from "./support/cron";
import { compileNode, specOf } from "./support/driver-util";
import { dependencies } from "./support/refs";
import { fargateSize } from "./support/fargate";
import { parseImageRef } from "./support/image";
import { failureOf, findByTags, type AwsCtx } from "./support/sdk";
import { Frag, assumeRoleJson, attr, boundaryArn, policyJson, refOf, tagsFor, type PolicyStatement } from "./support/tf";
import { emitTask } from "./ecs-task";
import { stoppedTaskSignals } from "./ecs-read";
import { DRIVER_IDS } from "./types";

const ID = DRIVER_IDS.ecsScheduledTask;

/* --------------------------------- compile -------------------------------- */

const compile = (node: ResourceNode, ctx: CompileContext): TofuFragment =>
  compileNode(node, () => {
    const spec = specOf<ScheduledJobSpec>(node);
    const label = tfLabel(node.address);
    const name = nodeName(node.address);
    const b = new Frag(node.address);
    const t = emitTask(b, node, ctx, { ...spec, port: undefined });
    if (spec.schedule === undefined || spec.schedule.trim() === "") return b.build(t.taskDefinition);

    const schedule = toEventBridgeCron(spec.schedule);
    const identity = dependencies(ctx, node, "identity")[0];
    const eventsName = cloudName(ctx.namePrefix, `${name}-events`, 64);
    const eventsRole = b.resource("aws_iam_role", `${label}_events`, {
      name: eventsName,
      assume_role_policy: assumeRoleJson("events.amazonaws.com"),
      permissions_boundary: boundaryArn(t.env),
      tags: tagsFor(ctx, node, eventsName),
    });
    const statements: PolicyStatement[] = [
      { Sid: "RunThisTask", Effect: "Allow", Action: ["ecs:RunTask"], Resource: [attr(t.taskDefinition, "arn")], Condition: { ArnEquals: { "ecs:cluster": attr(t.cluster, "arn") } } },
      {
        Sid: "PassTaskRoles",
        Effect: "Allow",
        Action: ["iam:PassRole"],
        Resource: [attr(t.execRole, "arn"), ...(identity ? [refOf(ctx, identity.address, "arn")] : [])],
        Condition: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } },
      },
    ];
    const eventsPolicy = b.resource("aws_iam_role_policy", `${label}_events`, {
      name: "run-task",
      role: attr(eventsRole, "name"),
      policy: policyJson(statements, `${node.address} events role`),
    });
    const ruleName = cloudName(ctx.namePrefix, name, 64);
    const rule = b.resource("aws_cloudwatch_event_rule", label, {
      name: ruleName,
      description: `Runs ${node.address} on ${schedule.source} (UTC)`.slice(0, 512),
      schedule_expression: schedule.expression,
      state: "ENABLED",
      tags: tagsFor(ctx, node, ruleName),
    });
    b.resource("aws_cloudwatch_event_target", label, {
      rule: attr(rule, "name"),
      target_id: "run-task",
      arn: attr(t.cluster, "arn"),
      role_arn: attr(eventsRole, "arn"),
      ecs_target: [
        {
          task_definition_arn: attr(t.taskDefinition, "arn"),
          task_count: 1,
          launch_type: "FARGATE",
          ...(spec.platformVersion ? { platform_version: spec.platformVersion } : {}),
          network_configuration: [{ subnets: t.subnets, security_groups: [t.securityGroup], assign_public_ip: false }],
        },
      ],
      retry_policy: [{ maximum_retry_attempts: 2, maximum_event_age_in_seconds: 3600 }],
      depends_on: [eventsPolicy.expr, ...t.prerequisites],
    });
    b.expose("arn", attr(rule, "arn"));
    b.expose("task_definition_arn", attr(t.taskDefinition, "arn"));
    return b.build(rule);
  });

/* --------------------------------- expected ------------------------------- */

function expected(node: ResourceNode): Record<string, unknown> {
  const spec = specOf<ScheduledJobSpec>(node);
  const size = fargateSize(spec.vcpu, spec.memoryMb);
  return {
    cpu: size.cpu,
    memoryMb: size.memoryMb,
    ...(spec.artifact?.type === "image" ? { image: parseImageRef(spec.artifact.ref).ref } : {}),
  };
}

/* --------------------------------- observe -------------------------------- */

const revisionOf = (arn: string): number => Number(/:(\d+)$/.exec(arn)?.[1] ?? 0);

interface JobObjects {
  taskDefinitionArn?: string;
  ruleArn?: string;
  clusterArn?: string;
  tags: Record<string, string>;
}

async function locate(ctx: AwsCtx, node: ResourceNode, externalId?: string): Promise<JobObjects> {
  const spec = specOf<ScheduledJobSpec>(node);
  const out: JobObjects = { tags: {} };
  if (spec.schedule) {
    const arn = externalId && parseArn(externalId)?.service === "events" ? externalId : undefined;
    if (arn) out.ruleArn = arn;
    else {
      const rules = await findByTags(ctx, node, "events:rule");
      if (rules.length > 1) throw Object.assign(new Error(`${rules.length} EventBridge rules carry the tags of ${node.address}.`), { name: "Ambiguous" });
      if (rules[0]) {
        out.ruleArn = rules[0].arn;
        out.tags = rules[0].tags;
      }
    }
  }
  const tds = await findByTags(ctx, node, "ecs:task-definition");
  const latest = [...tds].sort((a, c) => revisionOf(c.arn) - revisionOf(a.arn))[0];
  if (latest) {
    out.taskDefinitionArn = latest.arn;
    if (!spec.schedule) out.tags = latest.tags;
  }
  const clusters = await findByTags(ctx, node, "ecs:cluster");
  if (clusters[0]) out.clusterArn = clusters[0].arn;
  return out;
}

const observe: NonNullable<ResourceDriver<AwsSession>["observe"]> = async (ctx, node, externalId): Promise<Observation> => {
  const names = Object.keys(expected(node));
  const spec = specOf<ScheduledJobSpec>(node);
  let objects: JobObjects;
  try {
    objects = await locate(ctx, node, externalId);
  } catch (e) {
    const f = failureOf(ctx, e);
    return failedObservation(ctx, node, ID, names, f.code === "Ambiguous" ? { ...f, kind: "error" } : f, externalId);
  }
  const primary = spec.schedule ? objects.ruleArn : objects.taskDefinitionArn;
  if (!primary || !objects.taskDefinitionArn) {
    return failedObservation(ctx, node, ID, names, { kind: "missing", code: "NotFoundByTags", summary: `${spec.schedule && !objects.ruleArn ? "The EventBridge rule" : "The task definition"} of ${node.address} was not found by its Zenith tags (the tag index is eventually consistent).` }, primary);
  }
  const ecs = ctx.session.client(ECSClient);
  const td = await attempt(async () => (await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: objects.taskDefinitionArn }), { abortSignal: ctx.signal })).taskDefinition, ctx.signal);
  const def: TaskDefinition | undefined = td.ok ? td.value : undefined;
  const container = def?.containerDefinitions?.find((c) => c.name === nodeName(node.address)) ?? def?.containerDefinitions?.[0];
  const values: Record<string, unknown> = {};
  if (def?.cpu !== undefined && Number.isFinite(Number(def.cpu))) values.cpu = Number(def.cpu);
  if (def?.memory !== undefined && Number.isFinite(Number(def.memory))) values.memoryMb = Number(def.memory);
  if (container?.image) values.image = container.image;
  const attributes = attributesOf(ctx, names, values);
  if (!td.ok) for (const n of names) attributes[n] = unknownValue(unknownReasonOf(td.failure), td.failure.summary);
  return {
    address: node.address,
    externalId: primary,
    presence: "present",
    attributes,
    native: boundNative(
      {
        ...(objects.ruleArn ? { ruleArn: objects.ruleArn } : {}),
        taskDefinitionArn: objects.taskDefinitionArn,
        ...(objects.clusterArn ? { clusterArn: objects.clusterArn, clusterName: objects.clusterArn.slice(objects.clusterArn.lastIndexOf("/") + 1) } : {}),
        ...(container?.logConfiguration?.options?.["awslogs-group"] ? { logGroupName: container.logConfiguration.options["awslogs-group"] } : {}),
        tags: objects.tags,
      },
      { priority: ["ruleArn", "taskDefinitionArn", "clusterName", "logGroupName", "tags"] }
    ),
    observedAt: ctx.now().toISOString(),
    source: ID,
    simulated: false,
  };
};

/* --------------------------------- runtime -------------------------------- */

const runtime: NonNullable<ResourceDriver<AwsSession>["runtime"]> = async (ctx, node, externalId): Promise<RuntimeState> => {
  let objects: JobObjects;
  try {
    objects = await locate(ctx, node, externalId);
  } catch (e) {
    const f = failureOf(ctx, e);
    return runtimeState(ctx, node, ID, "unknown", {}, [f.kind === "inaccessible" ? "access_denied" : `read_failed:${f.code}`]);
  }
  if (!objects.taskDefinitionArn || !objects.clusterArn) return runtimeState(ctx, node, ID, "unknown", {}, ["job_not_found"]);
  const cluster = objects.clusterArn.slice(objects.clusterArn.lastIndexOf("/") + 1);
  const family = /task-definition\/([^:]+):\d+$/.exec(objects.taskDefinitionArn)?.[1];
  const ecs = ctx.session.client(ECSClient);
  const signals: string[] = [];
  const counts: Record<string, number> = {};

  const running = await attempt(() => ecs.send(new ListTasksCommand({ cluster, desiredStatus: "RUNNING", ...(family ? { family } : {}), maxResults: 100 }), { abortSignal: ctx.signal }), ctx.signal);
  if (running.ok) counts.running = (running.value.taskArns ?? []).length;
  else signals.push("running_tasks_unreadable");

  const stopped = await stoppedTaskSignals(ctx, ecs, { cluster, ...(family ? { family } : {}), oneShot: true });
  let health: HealthState = "unknown";
  if ("unreadable" in stopped) signals.push("stopped_tasks_unreadable");
  else {
    counts.stoppedSampled = stopped.sampled;
    counts.stoppedFailures = stopped.failures;
    signals.push(...stopped.signals);
    if (stopped.sampled === 0) signals.push("no_recent_runs");
    else if (stopped.failures === 0) health = "healthy";
    else health = stopped.failures >= stopped.sampled ? "unhealthy" : "degraded";
  }
  return runtimeState(ctx, node, ID, health, counts, signals);
};

/* ---------------------------------- driver -------------------------------- */

export const ecsScheduledTaskDriver: ResourceDriver<AwsSession> = {
  id: ID,
  provider: "aws",
  kind: "scheduled_job",
  nativeType: "aws:ecs_scheduled_task",
  capabilities: {
    compile: true,
    observe: true,
    runtime: true,
    verify: true,
    discover: false,
    operations: [],
    evidence: { compile: "contract", observe: "contract", runtime: "contract", verify: "contract" },
  },
  compile,
  observe,
  runtime,
  expectedAttributes: expected,
  verify: async (ctx, node, observation) => {
    const result = standardVerification(ctx, node, observation, expected(node), "The scheduled job");
    if (observation.presence !== "present") return result;
    const checks = [
      ...result.checks,
      {
        id: "schedule_observable",
        description: "The EventBridge rule's schedule and target match the desired configuration",
        passed: "unknown" as const,
        detail: "The rule's schedule, state and target cannot be read: @aws-sdk/client-eventbridge is not installed. Only its existence (by tags) and the task definition are verified.",
      },
    ];
    return { ...result, checks, status: checks.some((c) => c.passed === false) ? "failed" : "unknown" };
  },
};
