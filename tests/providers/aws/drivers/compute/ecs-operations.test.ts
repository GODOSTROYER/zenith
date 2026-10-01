/**
 * `aws:ecs_service` day-two operations: service.restart, service.scale,
 * deployment.deploy (`deployImage`) and the steady-state wait, against mocked
 * ECS / ECR / SSM / tagging clients. Contract evidence only.
 */
import {
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  ECSClient,
  ListTaskDefinitionsCommand,
  ListTasksCommand,
  RegisterTaskDefinitionCommand,
  TagResourceCommand,
  UpdateServiceCommand,
} from "@aws-sdk/client-ecs";
import { DescribeImagesCommand, ECRClient } from "@aws-sdk/client-ecr";
import { PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ecsServiceDriver } from "@/lib/providers/aws/drivers/compute/ecs-service";
import { MARKER_SKEW_MS, registerInputFrom, waitForServiceSteady } from "@/lib/providers/aws/drivers/compute/ecs-operations";
import { imagePointerName } from "@/lib/providers/aws/drivers/compute/ecs-task";
import { buildFixture, mkDriverContext, zenithTagList } from "./fixtures";
import { CLUSTER, DIGEST, IMAGE, OLD_IMAGE, REGISTRY_ARN, REGISTRY_HOST, SERVICE_ARN, SERVICE_NAME, TD_ARN, TD_FAMILY, deployment, ecsTags, service, taskDefinition } from "./ecs-mocks";

const ecs = mockClient(ECSClient);
const ecr = mockClient(ECRClient);
const ssm = mockClient(SSMClient);
const tagging = mockClient(ResourceGroupsTaggingAPIClient);
afterAll(() => [ecs, ecr, ssm, tagging].forEach((m) => m.restore()));

const fx = buildFixture();
const node = fx.service;
const ops = ecsServiceDriver.operations!;
const OP = "op_restart_1";
const ctxFor = (over: Parameters<typeof mkDriverContext>[0] = {}) => mkDriverContext({ operationId: OP, fence: { scope: "environment:env_1", token: 7 }, ...over });

function installService(over: Parameters<typeof service>[0] = {}) {
  ecs.on(DescribeServicesCommand).resolves({ services: [service(over)], failures: [] });
  tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: SERVICE_ARN, Tags: zenithTagList("container_service/web") }] });
}

beforeEach(() => {
  [ecs, ecr, ssm, tagging].forEach((m) => m.reset());
});

describe("service.restart", () => {
  it("records the operation on the service, then forces a new deployment", async () => {
    installService();
    ecs.on(TagResourceCommand).resolves({});
    ecs.on(UpdateServiceCommand).resolves({ service: service({ deployments: [deployment({ id: "ecs-svc/2222", createdAt: new Date("2026-09-30T12:00:01.000Z") })] }), $metadata: { requestId: "req-update" } });
    const r = await ops["service.restart"](ctxFor(), node, {});
    expect(r).toMatchObject({ ok: true, simulated: false, requestIds: ["req-update"], data: { serviceArn: SERVICE_ARN, deploymentId: "ecs-svc/2222", alreadyApplied: false, idempotency: "marker" } });
    const tag = ecs.commandCalls(TagResourceCommand)[0].args[0].input;
    expect(tag.resourceArn).toBe(SERVICE_ARN);
    expect(Object.fromEntries((tag.tags ?? []).map((t) => [t.key, t.value]))).toEqual({
      "zenith:operation": OP,
      "zenith:operation-at": "2026-09-30T12:00:00.000Z",
      "zenith:fence": "environment:env_1:7",
    });
    expect(ecs.commandCalls(UpdateServiceCommand)[0].args[0].input).toEqual({ cluster: CLUSTER, service: SERVICE_NAME, forceNewDeployment: true });
    // the marker is written BEFORE the call so a crash in between is recoverable
    const order = ecs.calls().map((c) => c.args[0].constructor.name);
    expect(order.indexOf("TagResourceCommand")).toBeLessThan(order.indexOf("UpdateServiceCommand"));
  });

  it("a retry of the same operation does not restart again when a deployment started after the marker", async () => {
    const markerAt = "2026-09-30T11:59:00.000Z";
    installService({ tags: ecsTags("container_service/web", { "zenith:operation": OP, "zenith:operation-at": markerAt }), deployments: [deployment({ createdAt: new Date("2026-09-30T11:59:02.000Z") })] });
    const r = await ops["service.restart"](ctxFor(), node, {});
    expect(r).toMatchObject({ ok: true, data: { alreadyApplied: true, idempotency: "marker" } });
    expect(ecs.commandCalls(UpdateServiceCommand)).toHaveLength(0);
    expect(ecs.commandCalls(TagResourceCommand)).toHaveLength(0);
  });

  it("a retry whose marker has no later deployment (the first attempt died before the call) restarts once and keeps the original marker", async () => {
    installService({ tags: ecsTags("container_service/web", { "zenith:operation": OP, "zenith:operation-at": "2026-09-30T11:59:00.000Z" }), deployments: [deployment({ createdAt: new Date("2026-09-30T08:00:00.000Z") })] });
    ecs.on(UpdateServiceCommand).resolves({ service: service() });
    const r = await ops["service.restart"](ctxFor(), node, {});
    expect(r).toMatchObject({ ok: true, data: { alreadyApplied: false } });
    expect(ecs.commandCalls(UpdateServiceCommand)).toHaveLength(1);
    expect(ecs.commandCalls(TagResourceCommand)).toHaveLength(0);
  });

  it("allows a few seconds of clock skew between the marker and AWS's deployment timestamp, and no more", async () => {
    const markerAt = new Date("2026-09-30T11:59:00.000Z");
    const within = new Date(markerAt.getTime() - MARKER_SKEW_MS + 1000);
    const outside = new Date(markerAt.getTime() - MARKER_SKEW_MS - 1000);
    installService({ tags: ecsTags("container_service/web", { "zenith:operation": OP, "zenith:operation-at": markerAt.toISOString() }), deployments: [deployment({ createdAt: within })] });
    expect(await ops["service.restart"](ctxFor(), node, {})).toMatchObject({ data: { alreadyApplied: true } });
    ecs.reset();
    tagging.reset();
    installService({ tags: ecsTags("container_service/web", { "zenith:operation": OP, "zenith:operation-at": markerAt.toISOString() }), deployments: [deployment({ createdAt: outside })] });
    ecs.on(UpdateServiceCommand).resolves({ service: service() });
    expect(await ops["service.restart"](ctxFor(), node, {})).toMatchObject({ data: { alreadyApplied: false } });
  });

  it("a DIFFERENT operation's marker does not suppress the restart", async () => {
    installService({ tags: ecsTags("container_service/web", { "zenith:operation": "op_other", "zenith:operation-at": "2026-09-30T11:59:00.000Z" }) });
    ecs.on(TagResourceCommand).resolves({});
    ecs.on(UpdateServiceCommand).resolves({ service: service() });
    expect(await ops["service.restart"](ctxFor(), node, {})).toMatchObject({ ok: true, data: { alreadyApplied: false } });
    expect(ecs.commandCalls(TagResourceCommand)).toHaveLength(1);
  });

  it("still restarts when the marker cannot be written, and says the idempotency is best effort", async () => {
    installService();
    ecs.on(TagResourceCommand).rejects(Object.assign(new Error("not authorized"), { name: "AccessDeniedException" }));
    ecs.on(UpdateServiceCommand).resolves({ service: service() });
    const ctx = ctxFor();
    const r = await ops["service.restart"](ctx, node, {});
    expect(r).toMatchObject({ ok: true, data: { idempotency: "best_effort" } });
    expect(ctx.logs.some((l) => /may restart twice/.test(l))).toBe(true);
  });

  it("without an operation id there is no marker", async () => {
    installService();
    ecs.on(UpdateServiceCommand).resolves({ service: service() });
    const r = await ops["service.restart"](mkDriverContext({ operationId: undefined }), node, {});
    expect(r).toMatchObject({ ok: true, data: { idempotency: "none" } });
    expect(ecs.commandCalls(TagResourceCommand)).toHaveLength(0);
  });

  it.each([
    ["another environment", ecsTags("container_service/web", { "zenith:environment": "env_other" })],
    ["another node", ecsTags("container_service/api")],
    ["no zenith tags", [{ key: "team", value: "x" }]],
  ])("refuses a service that belongs to %s", async (_name, tags) => {
    installService({ tags });
    const r = await ops["service.restart"](ctxFor(), node, {});
    expect(r).toMatchObject({ ok: false, data: { refused: true } });
    expect(r.summary).toMatch(/does not carry the Zenith tags/);
    expect(ecs.commandCalls(UpdateServiceCommand)).toHaveLength(0);
    expect(ecs.commandCalls(TagResourceCommand)).toHaveLength(0);
  });

  it("refuses an explicit externalId whose service carries someone else's tags", async () => {
    ecs.on(DescribeServicesCommand).resolves({ services: [service({ tags: ecsTags("container_service/api") })] });
    const r = await ops["service.restart"](ctxFor(), node, { externalId: SERVICE_ARN });
    expect(r.ok).toBe(false);
    expect(ecs.commandCalls(UpdateServiceCommand)).toHaveLength(0);
  });

  it("refuses when the service does not exist", async () => {
    ecs.on(DescribeServicesCommand).resolves({ services: [], failures: [{ arn: SERVICE_ARN, reason: "MISSING" }] });
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: SERVICE_ARN, Tags: zenithTagList("container_service/web") }] });
    expect(await ops["service.restart"](ctxFor(), node, {})).toMatchObject({ ok: false, summary: expect.stringMatching(/does not exist or is inactive/) });
    tagging.reset();
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [] });
    expect(await ops["service.restart"](ctxFor(), node, {})).toMatchObject({ ok: false, summary: expect.stringMatching(/cannot find the service/) });
  });

  it("returns a classified failure with the request id when ECS throttles, instead of throwing", async () => {
    installService();
    ecs.on(TagResourceCommand).resolves({});
    ecs.on(UpdateServiceCommand).rejects(Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException", $metadata: { requestId: "req-9", httpStatusCode: 400 } }));
    const r = await ops["service.restart"](ctxFor(), node, {});
    expect(r).toMatchObject({ ok: false, data: { failure: "throttled", code: "ThrottlingException" }, requestIds: ["req-9"] });
  });

  it("propagates an abort as an abort, never as a failed result", async () => {
    installService();
    const ac = new AbortController();
    ecs.on(TagResourceCommand).callsFake(() => {
      ac.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    await expect(ops["service.restart"](ctxFor({ signal: ac.signal }), node, {})).rejects.toMatchObject({ name: "AbortError" });
    expect(ecs.commandCalls(UpdateServiceCommand)).toHaveLength(0);
  });
});

describe("service.scale", () => {
  it("sets the desired count and warns that the next apply reconciles to the manifest", async () => {
    installService();
    ecs.on(UpdateServiceCommand).resolves({ service: service({ desiredCount: 5 }), $metadata: { requestId: "req-s" } });
    const r = await ops["service.scale"](ctxFor(), node, { replicas: 5 });
    expect(r).toMatchObject({ ok: true, requestIds: ["req-s"], data: { previousReplicas: 2, replicas: 5, clamped: false, unchanged: false } });
    expect(r.data!.warning).toMatch(/next infrastructure apply sets desiredCount back to 2/);
    expect(ecs.commandCalls(UpdateServiceCommand)[0].args[0].input).toEqual({ cluster: CLUSTER, service: SERVICE_NAME, desiredCount: 5 });
  });

  it.each([
    [50, 20, true],
    [21, 20, true],
    [20, 20, false],
    [0, 0, false],
    [-3, 0, true],
  ])("clamps %s to 0..20 (→ %s, clamped %s)", async (requested, applied, clamped) => {
    installService({ desiredCount: 7 });
    ecs.on(UpdateServiceCommand).resolves({ service: service() });
    const r = await ops["service.scale"](ctxFor(), node, { replicas: requested });
    expect(r).toMatchObject({ ok: true, data: { replicas: applied, clamped } });
    expect(ecs.commandCalls(UpdateServiceCommand)[0].args[0].input.desiredCount).toBe(applied);
    if (clamped) expect(r.summary).toMatch(/limited to 0-20/);
  });

  it("does nothing when the count is already right, and does not warn when it matches the manifest", async () => {
    installService({ desiredCount: 2 });
    const r = await ops["service.scale"](ctxFor(), node, { replicas: 2 });
    expect(r).toMatchObject({ ok: true, data: { unchanged: true, replicas: 2 } });
    expect(r.data).not.toHaveProperty("warning");
    expect(ecs.commandCalls(UpdateServiceCommand)).toHaveLength(0);
  });

  it.each([2.5, NaN, "3", null, undefined, Infinity])("refuses replicas %j", async (replicas) => {
    installService();
    const r = await ops["service.scale"](ctxFor(), node, { replicas });
    expect(r).toMatchObject({ ok: false, summary: "replicas must be an integer." });
    expect(ecs.commandCalls(DescribeServicesCommand)).toHaveLength(0);
    expect(ecs.commandCalls(UpdateServiceCommand)).toHaveLength(0);
  });

  it("refuses a service it does not own", async () => {
    installService({ tags: ecsTags("container_service/api") });
    expect((await ops["service.scale"](ctxFor(), node, { replicas: 3 })).ok).toBe(false);
    expect(ecs.commandCalls(UpdateServiceCommand)).toHaveLength(0);
  });
});

describe("deployment.deploy (deployImage)", () => {
  function installDeploy(over: { td?: Parameters<typeof taskDefinition>[0]; repos?: string[]; taggedRevision?: boolean } = {}) {
    installService();
    tagging.on(GetResourcesCommand).callsFake((input: { ResourceTypeFilters?: string[] }) =>
      input.ResourceTypeFilters?.[0] === "ecr:repository"
        ? { ResourceTagMappingList: (over.repos ?? [REGISTRY_ARN]).map((ResourceARN) => ({ ResourceARN, Tags: zenithTagList("container_registry/web") })) }
        : { ResourceTagMappingList: [{ ResourceARN: SERVICE_ARN, Tags: zenithTagList("container_service/web") }] }
    );
    ecr.on(DescribeImagesCommand).resolves({ imageDetails: [{ imageDigest: DIGEST }] });
    ecs.on(DescribeTaskDefinitionCommand).callsFake((input: { taskDefinition: string }) => {
      if (input.taskDefinition === TD_ARN) return { taskDefinition: taskDefinition(over.td), tags: [{ key: "zenith:resource", value: "container_service/web" }, { key: "aws:cloudformation:x", value: "no" }] };
      return { taskDefinition: taskDefinition({ taskDefinitionArn: input.taskDefinition, revision: 8 }), tags: over.taggedRevision ? [{ key: "zenith:operation", value: OP }] : [] };
    });
    ecs.on(ListTaskDefinitionsCommand).resolves({ taskDefinitionArns: [] });
    ecs.on(RegisterTaskDefinitionCommand).resolves({ taskDefinition: taskDefinition({ taskDefinitionArn: `${TD_ARN.slice(0, -1)}8`, revision: 8 }), $metadata: { requestId: "req-reg" } });
    ecs.on(UpdateServiceCommand).resolves({ service: service({ deployments: [deployment({ id: "ecs-svc/3333" })] }), $metadata: { requestId: "req-upd" } });
    ssm.on(PutParameterCommand).resolves({ $metadata: { requestId: "req-ssm" } });
  }
  const run = (input: Record<string, unknown> = { image: IMAGE }, ctx = ctxFor()) => ops["deployment.deploy"](ctx, node, input);

  it("registers a copy of the current task definition with only the image changed, updates the service, then writes the image pointer", async () => {
    installDeploy();
    const r = await run();
    expect(r).toMatchObject({ ok: true, requestIds: ["req-reg", "req-upd", "req-ssm"], data: { image: IMAGE, taskDefinitionArn: `${TD_ARN.slice(0, -1)}8`, previousTaskDefinitionArn: TD_ARN, deploymentId: "ecs-svc/3333", reusedRevision: false, alreadyApplied: false } });

    const reg = ecs.commandCalls(RegisterTaskDefinitionCommand)[0].args[0].input;
    const original = taskDefinition();
    expect(reg.family).toBe(TD_FAMILY);
    expect(reg.cpu).toBe("512");
    expect(reg.memory).toBe("1024");
    expect(reg.taskRoleArn).toBe(original.taskRoleArn);
    expect(reg.executionRoleArn).toBe(original.executionRoleArn);
    expect(reg.networkMode).toBe("awsvpc");
    expect(reg.requiresCompatibilities).toEqual(["FARGATE"]);
    expect(reg.runtimePlatform).toEqual(original.runtimePlatform);
    expect(reg.containerDefinitions).toEqual([{ ...original.containerDefinitions![0], image: IMAGE }]);
    // the copy carries no response-only fields
    expect(reg).not.toHaveProperty("taskDefinitionArn");
    expect(reg).not.toHaveProperty("revision");
    expect(reg).not.toHaveProperty("status");
    const tags = Object.fromEntries((reg.tags ?? []).map((t) => [t.key, t.value]));
    expect(tags).toEqual({ "zenith:resource": "container_service/web", "zenith:operation": OP, "zenith:fence": "environment:env_1:7" });

    expect(ecs.commandCalls(UpdateServiceCommand)[0].args[0].input).toEqual({ cluster: CLUSTER, service: SERVICE_NAME, taskDefinition: `${TD_ARN.slice(0, -1)}8` });
    expect(ssm.commandCalls(PutParameterCommand)[0].args[0].input).toEqual({ Name: imagePointerName("env_1", "container_service/web"), Value: IMAGE, Type: "String", Overwrite: true });
    const ecsOrder = ecs.calls().map((c) => c.args[0].constructor.name);
    expect(ecsOrder.indexOf("RegisterTaskDefinitionCommand")).toBeLessThan(ecsOrder.indexOf("UpdateServiceCommand"));
  });

  it("writes the image pointer only after the service accepted the new revision", async () => {
    installDeploy();
    let updatesSeenWhenPointerWritten = -1;
    ssm.on(PutParameterCommand).callsFake(() => {
      updatesSeenWhenPointerWritten = ecs.commandCalls(UpdateServiceCommand).length;
      return {};
    });
    await run();
    expect(updatesSeenWhenPointerWritten).toBe(1);
  });

  it("leaves other containers of the task definition untouched", async () => {
    const td = taskDefinition();
    td.containerDefinitions = [{ name: "sidecar", image: "public.ecr.aws/x/sidecar:1" }, ...td.containerDefinitions!];
    installDeploy({ td });
    await run();
    const defs = ecs.commandCalls(RegisterTaskDefinitionCommand)[0].args[0].input.containerDefinitions!;
    expect(defs.find((d) => d.name === "sidecar")!.image).toBe("public.ecr.aws/x/sidecar:1");
    expect(defs.find((d) => d.name === "web")!.image).toBe(IMAGE);
  });

  it("a retried operation reuses the revision it already registered and does not register a second", async () => {
    installDeploy({ taggedRevision: true });
    ecs.on(ListTaskDefinitionsCommand).resolves({ taskDefinitionArns: [`${TD_ARN.slice(0, -1)}8`, TD_ARN] });
    const r = await run();
    expect(r).toMatchObject({ ok: true, data: { reusedRevision: true, taskDefinitionArn: `${TD_ARN.slice(0, -1)}8` } });
    expect(ecs.commandCalls(RegisterTaskDefinitionCommand)).toHaveLength(0);
    expect(ecs.commandCalls(UpdateServiceCommand)).toHaveLength(1);
    expect(ecs.commandCalls(ListTaskDefinitionsCommand)[0].args[0].input).toMatchObject({ familyPrefix: TD_FAMILY, status: "ACTIVE", sort: "DESC", maxResults: 5 });
  });

  it("does not look for a previous revision without an operation id", async () => {
    installDeploy();
    await run({ image: IMAGE }, mkDriverContext({ operationId: undefined }));
    expect(ecs.commandCalls(ListTaskDefinitionsCommand)).toHaveLength(0);
    expect(ecs.commandCalls(RegisterTaskDefinitionCommand)).toHaveLength(1);
  });

  it("is a no-op when the service already runs the image, but still makes the pointer current", async () => {
    installDeploy({ td: { containerDefinitions: [{ name: "web", image: IMAGE, portMappings: [{ containerPort: 8080 }] }] } });
    const r = await run();
    expect(r).toMatchObject({ ok: true, data: { alreadyApplied: true } });
    expect(ecs.commandCalls(RegisterTaskDefinitionCommand)).toHaveLength(0);
    expect(ecs.commandCalls(UpdateServiceCommand)).toHaveLength(0);
    expect(ssm.commandCalls(PutParameterCommand)).toHaveLength(1);
  });

  it("reports failure (partial) when the image pointer cannot be written, so the workflow retries instead of trusting a rollout a later apply would undo", async () => {
    installDeploy();
    ssm.on(PutParameterCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
    const r = await run();
    expect(r).toMatchObject({ ok: false, data: { partial: true, failure: "inaccessible", image: IMAGE } });
    expect(r.summary).toMatch(/rolling back|roll it back/);
    expect(ecs.commandCalls(UpdateServiceCommand)).toHaveLength(1);
  });

  describe("refusals (nothing is registered or updated)", () => {
    const expectUntouched = () => {
      expect(ecs.commandCalls(RegisterTaskDefinitionCommand)).toHaveLength(0);
      expect(ecs.commandCalls(UpdateServiceCommand)).toHaveLength(0);
      expect(ssm.commandCalls(PutParameterCommand)).toHaveLength(0);
    };

    it.each([
      ["a tag instead of a digest", { image: `${REGISTRY_HOST}/zn-acme-web:latest` }, /pin the image by digest/],
      ["another account's registry", { image: `999999999999.dkr.ecr.eu-west-1.amazonaws.com/zn-acme-web@${DIGEST}` }, /this account's ECR registry/],
      ["another region's registry", { image: `${ACCOUNT_HOST("us-east-1")}/zn-acme-web@${DIGEST}` }, /this account's ECR registry/],
      ["a public registry", { image: `ghcr.io/acme/web@${DIGEST}` }, /this account's ECR registry/],
      ["another repository of the same registry", { image: `${REGISTRY_HOST}/someone-elses@${DIGEST}` }, /not the registry of container_service\/web/],
      ["an injected reference", { image: `${REGISTRY_HOST}/zn-acme-web@${DIGEST}; rm -rf /` }, /characters outside/],
      ["a missing image", {}, /1-255 characters/],
    ])("%s", async (_name, input, message) => {
      installDeploy();
      const r = await run(input as Record<string, unknown>);
      expect(r).toMatchObject({ ok: false });
      expect(r.summary).toMatch(message);
      expectUntouched();
    });

    it("an image digest that is not in the registry", async () => {
      installDeploy();
      ecr.on(DescribeImagesCommand).resolves({ imageDetails: [] });
      const r = await run();
      expect(r.summary).toMatch(/does not exist in zn-acme-web/);
      expectUntouched();
      ecr.reset();
      ecr.on(DescribeImagesCommand).rejects(Object.assign(new Error("not found"), { name: "ImageNotFoundException" }));
      expect((await run()).ok).toBe(false);
      expectUntouched();
    });

    it("a repository that cannot be proven to be this workload's registry (tag lookup empty)", async () => {
      installDeploy({ repos: [] });
      expect((await run()).summary).toMatch(/is not the registry of/);
      expectUntouched();
    });

    it("a workload whose manifest pins its image", async () => {
      installDeploy();
      const pinned = buildFixture({ artifact: { type: "image", ref: "ghcr.io/acme/web:2.0.1" }, withSecret: false });
      const r = await ops["deployment.deploy"](ctxFor(), pinned.service, { image: IMAGE });
      expect(r).toMatchObject({ ok: false, summary: expect.stringMatching(/pins its image in the manifest/) });
      expectUntouched();
    });

    it("a service it does not own", async () => {
      installDeploy();
      ecs.on(DescribeServicesCommand).resolves({ services: [service({ tags: ecsTags("container_service/api") })] });
      expect((await run()).summary).toMatch(/does not carry the Zenith tags/);
      expectUntouched();
    });
  });

  it("an abort while registering stops the operation", async () => {
    installDeploy();
    const ac = new AbortController();
    ecs.on(RegisterTaskDefinitionCommand).callsFake(() => {
      ac.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    await expect(run({ image: IMAGE }, ctxFor({ signal: ac.signal }))).rejects.toMatchObject({ name: "AbortError" });
    expect(ecs.commandCalls(UpdateServiceCommand)).toHaveLength(0);
    expect(ssm.commandCalls(PutParameterCommand)).toHaveLength(0);
  });

  it("registerInputFrom copies the registrable fields and nothing response-only", () => {
    const td = taskDefinition({ volumes: [{ name: "scratch" }], ephemeralStorage: { sizeInGiB: 40 }, placementConstraints: [] });
    const input = registerInputFrom(td, "web", IMAGE, [{ key: "a", value: "b" }]);
    expect(input).toMatchObject({ family: TD_FAMILY, volumes: [{ name: "scratch" }], ephemeralStorage: { sizeInGiB: 40 }, tags: [{ key: "a", value: "b" }] });
    expect(input).not.toHaveProperty("placementConstraints"); // empty lists are not sent
    expect(input).not.toHaveProperty("taskDefinitionArn");
    expect(OLD_IMAGE).not.toBe(IMAGE);
  });
});

function ACCOUNT_HOST(region: string) {
  return `123456789012.dkr.ecr.${region}.amazonaws.com`;
}

describe("waitForServiceSteady", () => {
  const instant = async () => undefined;
  const clock = () => {
    let t = 0;
    return () => (t += 1000);
  };

  it("polls until the rollout completes", async () => {
    ecs.on(ListTasksCommand).resolves({ taskArns: [] });
    ecs.on(DescribeServicesCommand)
      .resolvesOnce({ services: [service({ runningCount: 1, pendingCount: 1, deployments: [deployment({ rolloutState: "IN_PROGRESS" }), deployment({ id: "old", status: "ACTIVE" })] })] })
      .resolvesOnce({ services: [service({ runningCount: 2, deployments: [deployment({ rolloutState: "IN_PROGRESS" })] })] })
      .resolves({ services: [service()] });
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: SERVICE_ARN, Tags: zenithTagList("container_service/web") }] });
    const r = await waitForServiceSteady(mkDriverContext(), node, { sleep: instant, now: clock(), pollMs: 1, timeoutMs: 600_000 });
    expect(r.state).toBe("steady");
    expect(ecs.commandCalls(DescribeServicesCommand)).toHaveLength(3);
  });

  it("stops at once when the rollout failed", async () => {
    ecs.on(ListTasksCommand).resolves({ taskArns: [] });
    ecs.on(DescribeServicesCommand).resolves({ services: [service({ runningCount: 0, deployments: [deployment({ rolloutState: "FAILED" })] })] });
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: SERVICE_ARN, Tags: zenithTagList("container_service/web") }] });
    const r = await waitForServiceSteady(mkDriverContext(), node, { sleep: instant, now: clock(), pollMs: 1 });
    expect(r.state).toBe("rollout_failed");
    expect(ecs.commandCalls(DescribeServicesCommand)).toHaveLength(1);
  });

  it("gives up at its deadline with the last signals", async () => {
    ecs.on(ListTasksCommand).resolves({ taskArns: [] });
    ecs.on(DescribeServicesCommand).resolves({ services: [service({ runningCount: 1, pendingCount: 1, deployments: [deployment({ rolloutState: "IN_PROGRESS" })] })] });
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: SERVICE_ARN, Tags: zenithTagList("container_service/web") }] });
    const r = await waitForServiceSteady(mkDriverContext(), node, { sleep: instant, now: clock(), pollMs: 1000, timeoutMs: 5000 });
    expect(r.state).toBe("timeout");
    expect(r.signals).toContain("rollout_in_progress");
    expect(ecs.commandCalls(DescribeServicesCommand).length).toBeGreaterThan(1);
    expect(ecs.commandCalls(DescribeServicesCommand).length).toBeLessThan(10);
  });

  it("honours the abort signal between polls", async () => {
    ecs.on(ListTasksCommand).resolves({ taskArns: [] });
    ecs.on(DescribeServicesCommand).resolves({ services: [service({ runningCount: 1, deployments: [deployment({ rolloutState: "IN_PROGRESS" })] })] });
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: SERVICE_ARN, Tags: zenithTagList("container_service/web") }] });
    const ac = new AbortController();
    const ctx = mkDriverContext({ signal: ac.signal });
    const p = waitForServiceSteady(ctx, node, { pollMs: 60_000, timeoutMs: 600_000 });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});
