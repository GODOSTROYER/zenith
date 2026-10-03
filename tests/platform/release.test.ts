/** Release adapters over native SDK helpers: contract evidence, synthetic sessions. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { CodeBuildClient } from "@aws-sdk/client-codebuild";
import { ECRClient } from "@aws-sdk/client-ecr";
import { DescribeServicesCommand, DescribeTaskDefinitionCommand, DescribeTasksCommand, ECSClient, RunTaskCommand, ListTasksCommand } from "@aws-sdk/client-ecs";
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { createAwsBuildPort, createAwsMigrationsPort, createAwsWorkloadsPort } from "@/lib/platform/release";
import { buildFullFixture, mkDriverContext, zenithTagList, CTX_TAGS } from "../providers/aws/drivers/compute/fixtures";
import { ACCOUNT, DIGEST, IMAGE, SERVICE_ARN, TD_ARN, service as fakeService, taskDefinition as fakeTaskDefinition } from "../providers/aws/drivers/compute/ecs-mocks";

const cb = mockClient(CodeBuildClient), ecr = mockClient(ECRClient), ecs = mockClient(ECSClient), tagging = mockClient(ResourceGroupsTaggingAPIClient);
const buildId = "zn-acme-web:00000000-0000-0000-0000-000000000001";
beforeEach(() => { cb.reset(); ecr.reset(); ecs.reset(); tagging.reset(); });
afterAll(() => { cb.restore(); ecr.restore(); ecs.restore(); tagging.restore(); });

describe("AWS build output adapter", () => {
  it("refuses output recovery without canonical receipt authority before provider calls", async () => {
    await expect(createAwsBuildPort().waitForBuild(mkDriverContext(), { buildId }, { timeoutMs: 1000 }))
      .rejects.toMatchObject({ code: "build_launch_unconfirmed" });
    expect(cb.calls()).toHaveLength(0);
    expect(ecr.calls()).toHaveLength(0);
  });
  // Positive output/digest and ownership readback contracts use actual PostgreSQL
  // launch authority in codebuild-launch-authority.test.ts.
});

describe("AWS one-off migration adapter", () => {
  const fixture = buildFullFixture(); const ctx = () => mkDriverContext(); const node = { ...fixture.service, externalRef: SERVICE_ARN };
  function install(over: { foreign?: boolean; exitCode?: number; unknown?: boolean } = {}) {
    ecs.on(DescribeServicesCommand).resolves({ services: [fakeService({ tags: Object.entries({ ...CTX_TAGS, "zenith:resource": node.address, ...(over.foreign ? { "zenith:workspace": "foreign" } : {}) }).map(([key, value]) => ({ key, value })) })] });
    ecs.on(DescribeTaskDefinitionCommand).resolves({ taskDefinition: fakeTaskDefinition() });
    ecs.on(RunTaskCommand).resolves({ tasks: [{ taskArn: `arn:aws:ecs:eu-west-1:${ACCOUNT}:task/zn-acme-web/fixture` }] });
    ecs.on(DescribeTasksCommand).resolves({ tasks: over.unknown ? [] : [{ lastStatus: "STOPPED", containers: [{ name: "web", exitCode: over.exitCode ?? 0 }] }] });
  }
  it("uses the owning service task/network, argv, stable launch token, and observed exit code", async () => {
    install(); const port = createAwsMigrationsPort(); const command = ["node", "migrate.js", "$(external-string)"];
    expect(await port.runOneOffTask(ctx(), node, command, { timeoutMs: 1000, idempotencyKey: "op:migrate" })).toEqual({ exitCode: 0 });
    await port.runOneOffTask(ctx(), node, command, { timeoutMs: 1000, idempotencyKey: "op:migrate" });
    const calls = ecs.commandCalls(RunTaskCommand).map((c) => c.args[0].input);
    expect(calls[0]).toMatchObject({ taskDefinition: TD_ARN, count: 1, launchType: "FARGATE", overrides: { containerOverrides: [{ name: "web", command }] } });
    expect(calls[0].networkConfiguration).toEqual(fakeService().networkConfiguration);
    expect(calls[0].clientToken).toBe(calls[1].clientToken);
  });
  it("refuses a foreign service before any launch", async () => {
    install({ foreign: true });
    await expect(createAwsMigrationsPort().runOneOffTask(ctx(), node, ["node", "migrate.js"], { timeoutMs: 1000, idempotencyKey: "op:migrate" })).rejects.toThrow("tags");
    expect(ecs.commandCalls(RunTaskCommand)).toHaveLength(0);
  });
  it("does not turn missing task state into successful completion", async () => {
    install({ unknown: true });
    await expect(createAwsMigrationsPort().runOneOffTask(ctx(), node, ["node", "migrate.js"], { timeoutMs: 1000, idempotencyKey: "op:migrate" })).rejects.toThrow("unknown");
    expect(ecs.commandCalls(RunTaskCommand)).toHaveLength(1);
  });
});

describe("AWS workload adapter", () => {
  it("keeps a manifest-pinned image in tofu's task definition and refuses a different image", async () => {
    const node = buildFullFixture({ artifact: { type: "image", ref: IMAGE } }).service;
    const port = createAwsWorkloadsPort();
    expect(await port.deployImage(mkDriverContext(), node, { uri: IMAGE, digest: DIGEST }, { idempotencyKey: "op:deploy" })).toMatchObject({ detail: expect.stringContaining("OpenTofu") });
    await expect(port.deployImage(mkDriverContext(), node, { uri: IMAGE.replace(DIGEST, `sha256:${"a".repeat(64)}`), digest: `sha256:${"a".repeat(64)}` }, { idempotencyKey: "op:deploy" })).rejects.toThrow("manifest");
    expect(ecs.calls()).toHaveLength(0);
  });
  it("returns steady only after real native ECS state reads", async () => {
    const node = buildFullFixture().service;
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: SERVICE_ARN, Tags: zenithTagList(node.address) }] });
    ecs.on(DescribeServicesCommand).resolves({ services: [fakeService()] });
    ecs.on(ListTasksCommand).resolves({ taskArns: [] });
    expect(await createAwsWorkloadsPort().waitSteady(mkDriverContext(), node, { timeoutMs: 1000 })).toMatchObject({ steady: true });
    expect(ecs.commandCalls(DescribeServicesCommand)).toHaveLength(1);
  });
});
