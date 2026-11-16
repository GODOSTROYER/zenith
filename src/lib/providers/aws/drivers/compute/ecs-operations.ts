/**
 * `aws:ecs_service` day-two operations (native ECS / ECR / SSM calls).
 *
 *   service.restart     UpdateService forceNewDeployment
 *   service.scale       UpdateService desiredCount, clamped to 0..20
 *   deployment.deploy   `deployImage`: roll out a freshly built image digest
 *
 * Every operation first finds its target by the Zenith tags and then
 * re-checks that the object it is about to change carries THIS node's tags in
 * THIS environment (`assertNodeTags`); a service that was renamed, re-tagged
 * or belongs to another environment is refused, not modified.
 *
 * Idempotency. ECS `UpdateService` has no client token, so:
 *   - restart records the operation on the SERVICE before acting
 *     (`zenith:operation` = operation id, `zenith:operation-at` = first
 *     attempt time, `zenith:fence` = lease scope:token, written with
 *     TagResource). A retry of the same operation id reads that marker and, if
 *     any deployment was created at/after the marker time (5 s clock-skew
 *     allowance), reports `alreadyApplied` instead of restarting again. If
 *     TagResource is denied the restart still runs, `idempotency` is
 *     `best_effort` and the result says so.
 *   - scale is naturally idempotent (same desiredCount twice is a no-op).
 *   - deployImage stamps the task-definition revision it registers with the
 *     operation id (RegisterTaskDefinition `tags`); a retry finds that
 *     revision instead of registering a second one, and UpdateService /
 *     PutParameter with the same values are no-ops.
 *
 * Honest limits: none of this has run against a live account (evidence
 * `contract`); the marker's clock comparison assumes the control plane's clock
 * is within seconds of AWS's.
 */
import {
  DescribeTaskDefinitionCommand,
  ECSClient,
  ListTaskDefinitionsCommand,
  RegisterTaskDefinitionCommand,
  TagResourceCommand,
  UpdateServiceCommand,
  type RegisterTaskDefinitionCommandInput,
  type Service,
  type Tag,
  type TaskDefinition,
} from "@aws-sdk/client-ecs";
import { DescribeImagesCommand, ECRClient } from "@aws-sdk/client-ecr";
import { PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { NativeOperation, NativeOperationResult } from "@/lib/drivers/types";
import type { AwsSession } from "@/lib/credentials/types";
import type { ContainerServiceSpec } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";
import { nodeName, parseArn } from "@/lib/providers/aws/drivers/shared";
import { ecrCoordinates, parseImageRef, ImageRefError } from "./support/image";
import { OperationRefused, assertNodeTags, failureOf, findByTags, lowerTagMap, sleep, type AwsCtx } from "./support/sdk";
import { describeService, ecsRuntime, locateService, type ServiceLocation } from "./ecs-read";
import { imagePointerName } from "./ecs-task";

export const MAX_SCALE = 20;
export const MARKER_SKEW_MS = 5000;

/* ---------------------------------- shared -------------------------------- */

interface Target {
  loc: ServiceLocation;
  service: Service;
  ecs: ECSClient;
}

async function resolveTarget(ctx: AwsCtx, node: ResourceNode, input: Record<string, unknown>): Promise<Target> {
  const externalId = typeof input.externalId === "string" ? input.externalId : undefined;
  const located = await locateService(ctx, node, externalId);
  if (!located.ok) throw new OperationRefused(`cannot find the service of ${node.address}: ${located.failure.summary}`);
  const ecs = ctx.session.client(ECSClient);
  const service = await describeService(ctx, ecs, located.value);
  if (!service) throw new OperationRefused(`the service of ${node.address} does not exist or is inactive.`);
  assertNodeTags(ctx, node, lowerTagMap(service.tags), "the ECS service");
  return { loc: located.value, service, ecs };
}

/** Run an operation body; refusals and provider errors become `ok: false` results, aborts propagate. */
async function guarded(ctx: AwsCtx, body: () => Promise<NativeOperationResult>): Promise<NativeOperationResult> {
  try {
    return await body();
  } catch (e) {
    if (e instanceof OperationRefused || e instanceof ImageRefError) return { ok: false, summary: e.message, data: { refused: true }, simulated: false };
    const f = failureOf(ctx, e); // rethrows aborts
    return { ok: false, summary: `${f.code}: ${f.summary}`, data: { failure: f.kind, code: f.code }, ...(f.requestId ? { requestIds: [f.requestId] } : {}), simulated: false };
  }
}

const requestIds = (...metas: ({ requestId?: string } | undefined)[]): string[] => metas.map((m) => m?.requestId).filter((x): x is string => typeof x === "string");

/* --------------------------------- restart -------------------------------- */

export const restartService: NativeOperation<AwsSession> = (ctx, node, input) =>
  guarded(ctx, async () => {
    const { loc, service, ecs } = await resolveTarget(ctx, node, input);
    const tags = lowerTagMap(service.tags);
    const opId = ctx.operationId;
    let idempotency: "marker" | "best_effort" | "none" = "none";
    let markerAt: number | undefined;

    if (opId) {
      if (tags["zenith:operation"] === opId && tags["zenith:operation-at"]) {
        markerAt = Date.parse(tags["zenith:operation-at"]);
        idempotency = "marker";
        const landed = Number.isFinite(markerAt) && (service.deployments ?? []).some((d) => d.createdAt && d.createdAt.getTime() >= (markerAt as number) - MARKER_SKEW_MS);
        if (landed) {
          return { ok: true, summary: `The restart of ${node.address} for this operation was already issued; not restarting again.`, data: { serviceArn: loc.arn, alreadyApplied: true, idempotency }, simulated: false };
        }
      } else {
        const marker: Tag[] = [
          { key: "zenith:operation", value: opId },
          { key: "zenith:operation-at", value: ctx.now().toISOString() },
          ...(ctx.fence ? [{ key: "zenith:fence", value: `${ctx.fence.scope}:${ctx.fence.token}`.slice(0, 256) }] : []),
        ];
        try {
          await ecs.send(new TagResourceCommand({ resourceArn: loc.arn, tags: marker }), { abortSignal: ctx.signal });
          idempotency = "marker";
        } catch (e) {
          const f = failureOf(ctx, e);
          idempotency = "best_effort";
          ctx.log(`service.restart: could not record the operation marker (${f.code}); a retry of this operation may restart twice.`, "warn");
        }
      }
    }

    const res = await ecs.send(new UpdateServiceCommand({ cluster: loc.cluster, service: loc.service, forceNewDeployment: true }), { abortSignal: ctx.signal });
    const primary = (res.service?.deployments ?? []).find((d) => d.status === "PRIMARY");
    return {
      ok: true,
      summary: `Started a new deployment of ${node.address}; ECS replaces its tasks one rollout step at a time.`,
      data: { serviceArn: loc.arn, deploymentId: primary?.id, desiredCount: res.service?.desiredCount, alreadyApplied: false, idempotency },
      requestIds: requestIds(res.$metadata),
      simulated: false,
    };
  });

/* ---------------------------------- scale --------------------------------- */

export const scaleService: NativeOperation<AwsSession> = (ctx, node, input) =>
  guarded(ctx, async () => {
    const requested = input.replicas;
    if (typeof requested !== "number" || !Number.isInteger(requested)) throw new OperationRefused("replicas must be an integer.");
    const target = Math.min(MAX_SCALE, Math.max(0, requested));
    const clamped = target !== requested;
    const { loc, service, ecs } = await resolveTarget(ctx, node, input);
    const manifestReplicas = (node.spec as Partial<ContainerServiceSpec>).replicas;
    const warning =
      manifestReplicas !== undefined && manifestReplicas !== target
        ? `The next infrastructure apply sets desiredCount back to ${manifestReplicas} (the manifest's replicas). Update the manifest to ${target} to make this permanent.`
        : undefined;
    const previous = service.desiredCount;
    if (previous === target) {
      return { ok: true, summary: `${node.address} already runs ${target} task${target === 1 ? "" : "s"}; nothing to change.`, data: { serviceArn: loc.arn, previousReplicas: previous, replicas: target, clamped, unchanged: true, ...(warning ? { warning } : {}) }, simulated: false };
    }
    const res = await ecs.send(new UpdateServiceCommand({ cluster: loc.cluster, service: loc.service, desiredCount: target }), { abortSignal: ctx.signal });
    return {
      ok: true,
      summary: `Scaled ${node.address} from ${previous ?? "unknown"} to ${target}${clamped ? ` (requested ${requested}, limited to 0-${MAX_SCALE})` : ""}.`,
      data: { serviceArn: loc.arn, previousReplicas: previous, replicas: target, clamped, unchanged: false, ...(warning ? { warning } : {}) },
      requestIds: requestIds(res.$metadata),
      simulated: false,
    };
  });

/* -------------------------------- deployImage ----------------------------- */

const REGISTER_FIELDS = ["taskRoleArn", "executionRoleArn", "networkMode", "volumes", "placementConstraints", "requiresCompatibilities", "cpu", "memory", "pidMode", "ipcMode", "proxyConfiguration", "inferenceAccelerators", "ephemeralStorage", "runtimePlatform", "enableFaultInjection"] as const;

/** A RegisterTaskDefinition request that is `td` with the main container's image replaced. */
export function registerInputFrom(td: TaskDefinition, containerName: string, image: string, tags: Tag[]): RegisterTaskDefinitionCommandInput {
  const defs = td.containerDefinitions ?? [];
  const mainIndex = Math.max(0, defs.findIndex((c) => c.name === containerName));
  const input: RegisterTaskDefinitionCommandInput = {
    family: td.family,
    containerDefinitions: defs.map((c, i) => (i === mainIndex ? { ...c, image } : c)),
    tags,
  };
  for (const f of REGISTER_FIELDS) {
    const v = td[f];
    if (v !== undefined && !(Array.isArray(v) && v.length === 0)) (input as unknown as Record<string, unknown>)[f] = v;
  }
  return input;
}

/** The pointer the tofu task definition reads (see ecs-task.ts). */
export async function setImagePointer(ctx: AwsCtx, node: ResourceNode, image: string): Promise<string[]> {
  const ssm = ctx.session.client(SSMClient);
  const res = await ssm.send(new PutParameterCommand({ Name: imagePointerName(ctx.environmentId, node.address, ctx.awsBootstrap?.bootstrapNameSuffix), Value: image, Type: "String", Overwrite: true }), { abortSignal: ctx.signal });
  return requestIds(res.$metadata);
}

async function findRevisionOfOperation(ctx: AwsCtx, ecs: ECSClient, family: string, opId: string): Promise<TaskDefinition | undefined> {
  const listed = await ecs.send(new ListTaskDefinitionsCommand({ familyPrefix: family, status: "ACTIVE", sort: "DESC", maxResults: 5 }), { abortSignal: ctx.signal });
  for (const arn of (listed.taskDefinitionArns ?? []).slice(0, 5)) {
    const d = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: arn, include: ["TAGS"] }), { abortSignal: ctx.signal });
    if (d.taskDefinition?.family === family && lowerTagMap(d.tags)["zenith:operation"] === opId) return d.taskDefinition;
  }
  return undefined;
}

export const deployImage: NativeOperation<AwsSession> = (ctx, node, input) =>
  guarded(ctx, async () => {
    const spec = node.spec as Partial<ContainerServiceSpec>;
    if (spec.artifact?.type !== "built") throw new OperationRefused(`${node.address} pins its image in the manifest; change the manifest instead of deploying an image over it.`);
    const image = parseImageRef(input.image);
    if (!image.digest) throw new OperationRefused("deployments pin the image by digest: give <registry>/<repository>@sha256:<digest>.");
    const coords = ecrCoordinates(image);
    if (!coords || coords.account !== ctx.session.accountId || coords.region !== ctx.region) {
      throw new OperationRefused("only images in this account's ECR registry (same region) can be deployed.");
    }
    const { loc, service, ecs } = await resolveTarget(ctx, node, input);

    // the image must come from THIS workload's registry and must exist there
    const registryAddress = spec.artifact.registry;
    if (!registryAddress) throw new OperationRefused(`${node.address} has no registry to deploy from.`);
    const repos = await findByTags(ctx, { address: registryAddress }, "ecr:repository");
    const names = repos.map((r) => parseArn(r.arn)?.resource.replace(/^repository\//, ""));
    if (!names.includes(coords.repository)) throw new OperationRefused(`${coords.repository} is not the registry of ${node.address}; refusing to deploy an image from another repository.`);
    const ecr = ctx.session.client(ECRClient);
    const found = await ecr.send(new DescribeImagesCommand({ repositoryName: coords.repository, imageIds: [{ imageDigest: image.digest }] }), { abortSignal: ctx.signal });
    if (!(found.imageDetails ?? []).length) throw new OperationRefused(`image ${image.digest.slice(0, 19)}… does not exist in ${coords.repository}.`);

    if (!service.taskDefinition) throw new OperationRefused("the service has no task definition to copy.");
    const current = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: service.taskDefinition, include: ["TAGS"] }), { abortSignal: ctx.signal });
    const td = current.taskDefinition;
    if (!td?.family) throw new OperationRefused("the service's task definition could not be read.");
    const containerName = nodeName(node.address);
    const mainNow = (td.containerDefinitions ?? []).find((c) => c.name === containerName) ?? td.containerDefinitions?.[0];
    const ids: string[] = [];

    if (mainNow?.image === image.ref) {
      ids.push(...(await setImagePointer(ctx, node, image.ref)));
      return { ok: true, summary: `${node.address} already runs this image; the image pointer is up to date.`, data: { serviceArn: loc.arn, image: image.ref, taskDefinitionArn: td.taskDefinitionArn, alreadyApplied: true }, requestIds: ids, simulated: false };
    }

    let revision = ctx.operationId ? await findRevisionOfOperation(ctx, ecs, td.family, ctx.operationId) : undefined;
    const reused = revision !== undefined;
    if (!revision) {
      const tags: Tag[] = [
        ...Object.entries(lowerTagMap(current.tags))
          .filter(([k]) => !k.startsWith("aws:"))
          .map(([key, value]) => ({ key, value })),
        ...(ctx.operationId ? [{ key: "zenith:operation", value: ctx.operationId }] : []),
        ...(ctx.fence ? [{ key: "zenith:fence", value: `${ctx.fence.scope}:${ctx.fence.token}`.slice(0, 256) }] : []),
      ].filter((t, i, all) => all.findIndex((u) => u.key === t.key) === i);
      const reg = await ecs.send(new RegisterTaskDefinitionCommand(registerInputFrom(td, containerName, image.ref, tags)), { abortSignal: ctx.signal });
      revision = reg.taskDefinition;
      ids.push(...requestIds(reg.$metadata));
    }
    const newArn = revision?.taskDefinitionArn;
    if (!newArn) throw new OperationRefused("RegisterTaskDefinition returned no task definition ARN.");

    const upd = await ecs.send(new UpdateServiceCommand({ cluster: loc.cluster, service: loc.service, taskDefinition: newArn }), { abortSignal: ctx.signal });
    ids.push(...requestIds(upd.$metadata));
    // The pointer is what a later `tofu apply` renders the task definition from; if it cannot be
    // written the deployment is reported as failed so the workflow retries (every step is idempotent).
    let pointerIds: string[];
    try {
      pointerIds = await setImagePointer(ctx, node, image.ref);
    } catch (e) {
      const f = failureOf(ctx, e);
      return {
        ok: false,
        summary: `The new image is rolling out but the image pointer could not be updated (${f.code}); a later infrastructure apply would roll it back. Retry this operation.`,
        data: { partial: true, serviceArn: loc.arn, image: image.ref, taskDefinitionArn: newArn, failure: f.kind },
        requestIds: ids,
        simulated: false,
      };
    }
    ids.push(...pointerIds);
    const primary = (upd.service?.deployments ?? []).find((d) => d.status === "PRIMARY");
    return {
      ok: true,
      summary: `Deploying ${image.digest.slice(0, 19)}… to ${node.address}; wait for steady state to confirm the rollout.`,
      data: { serviceArn: loc.arn, image: image.ref, taskDefinitionArn: newArn, previousTaskDefinitionArn: td.taskDefinitionArn, deploymentId: primary?.id, reusedRevision: reused, alreadyApplied: false },
      requestIds: ids,
      simulated: false,
    };
  });

/* ---------------------------- waiting for a rollout ------------------------- */

export interface SteadyOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** injectable for tests */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface SteadyResult {
  state: "steady" | "rollout_failed" | "timeout";
  signals: string[];
  counts: Record<string, number>;
}

/**
 * Poll the service until it is at steady state (one deployment, running =
 * desired, rollout not in progress), its rollout failed, or the deadline
 * passes. Honours `ctx.signal`; read-only.
 */
export async function waitForServiceSteady(ctx: AwsCtx, node: ResourceNode, opts: SteadyOptions = {}): Promise<SteadyResult> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const pollMs = opts.pollMs ?? 10_000;
  const wait = opts.sleep ?? sleep;
  const now = opts.now ?? Date.now;
  const deadline = now() + timeoutMs;
  for (;;) {
    const r = await ecsRuntime(ctx, node);
    if (r.signals.includes("rollout_failed")) return { state: "rollout_failed", signals: r.signals, counts: r.counts };
    const steady = r.health === "healthy" && r.counts.deployments === 1 && !r.signals.includes("rollout_in_progress");
    if (steady) return { state: "steady", signals: r.signals, counts: r.counts };
    if (now() + pollMs > deadline) return { state: "timeout", signals: r.signals, counts: r.counts };
    await wait(pollMs, ctx.signal);
  }
}

export const ecsOperations: Record<string, NativeOperation<AwsSession>> = {
  "service.restart": restartService,
  "service.scale": scaleService,
  "deployment.deploy": deployImage,
};
