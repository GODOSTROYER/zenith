/** Real SDK command shapes with scripted responses. No AWS account is used. */
import { DescribeServicesCommand, ECSClient, type Service } from "@aws-sdk/client-ecs";
import { ApplicationAutoScalingClient, DescribeScalableTargetsCommand, type ScalableTarget } from "@aws-sdk/client-application-auto-scaling";
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { readEcsReplicaRepairTarget } from "@/lib/providers/aws/drivers/compute/ecs-replica-repair-read";
import { buildFixture, mkDriverContext } from "./fixtures";
import { CLUSTER, SERVICE_ARN, SERVICE_NAME, service } from "./ecs-mocks";

const ecs = mockClient(ECSClient); const scaling = mockClient(ApplicationAutoScalingClient); const tagging = mockClient(ResourceGroupsTaggingAPIClient);
afterAll(() => { ecs.restore(); scaling.restore(); tagging.restore(); });
const node = buildFixture().service;
const base = mkDriverContext();
const ctx = () => mkDriverContext({ session: { ...base.session, transport: "direct" }, tags: {
  ...base.tags, "zenith:project": "project-1", "zenith:resource": node.address,
} });
const healthy = (over: Partial<Service> = {}) => service({ schedulingStrategy: "REPLICA", createdAt: new Date("2026-09-01T00:00:00Z"),
  tags: [...service().tags!, { key: "zenith:project", value: "project-1" }], ...over });
const registeredTarget = {
  ServiceNamespace: "ecs", ResourceId: `service/${CLUSTER}/${SERVICE_NAME}`, ScalableDimension: "ecs:service:DesiredCount",
  MinCapacity: 1, MaxCapacity: 20,
  RoleARN: `arn:aws:iam::${base.session.accountId}:role/aws-service-role/ecs.application-autoscaling.amazonaws.com/AWSServiceRoleForApplicationAutoScaling_ECSService`,
  CreationTime: new Date("2026-09-01T00:00:00Z"),
} satisfies ScalableTarget;
beforeEach(() => {
  ecs.reset(); scaling.reset(); tagging.reset();
  tagging.on(GetResourcesCommand).resolves({ $metadata: { httpStatusCode: 200 }, ResourceTagMappingList: [{ ResourceARN: SERVICE_ARN,
    Tags: Object.entries(ctx().tags).map(([Key, Value]) => ({ Key, Value })) }] });
  ecs.on(DescribeServicesCommand).resolves({ $metadata: { httpStatusCode: 200 }, services: [healthy()], failures: [] });
  scaling.on(DescribeScalableTargetsCommand).resolves({ $metadata: { httpStatusCode: 200 }, ScalableTargets: [] });
});

describe("ECS replica ownership reads", () => {
  it("resolves a missing stored ARN through complete unique scoped tags before exact service reads", async () => {
    expect((await readEcsReplicaRepairTarget(ctx(), node)).serviceArn).toBe(SERVICE_ARN);
    expect(tagging.commandCalls(GetResourcesCommand)[0].args[0].input).toEqual({ ResourceTypeFilters: ["ecs:service"], ResourcesPerPage: 100,
      TagFilters: ["zenith:managed", "zenith:workspace", "zenith:environment", "zenith:project", "zenith:resource"].map((Key) => ({ Key, Values: [ctx().tags[Key]] })) });
    expect(ecs.commandCalls(DescribeServicesCommand)).toHaveLength(1); expect(scaling.commandCalls(DescribeScalableTargetsCommand)).toHaveLength(1);
  });
  it.each(["missing", "ambiguous", "foreign-arn", "foreign-tags", "partial", "missing-result", "failed-metadata", "denied"])("refuses incomplete or foreign initial target lookup (%s)", async (failure) => {
    const mapping = { ResourceARN: failure === "foreign-arn" ? SERVICE_ARN.replace("123456789012", "999999999999") : SERVICE_ARN,
      Tags: Object.entries({ ...ctx().tags, ...(failure === "foreign-tags" ? { "zenith:project": "foreign" } : {}) }).map(([Key, Value]) => ({ Key, Value })) };
    if (failure === "denied") tagging.on(GetResourcesCommand).rejects(new Error("private access-denied payload"));
    else tagging.on(GetResourcesCommand).resolves({ $metadata: { httpStatusCode: failure === "failed-metadata" ? 503 : 200 },
      ...(failure === "missing-result" ? {} : { ResourceTagMappingList: failure === "missing" ? [] : failure === "ambiguous" ? [mapping, mapping] : [mapping] }),
      ...(failure === "partial" ? { PaginationToken: "unread-page" } : {}) });
    await expect(readEcsReplicaRepairTarget(ctx(), node)).rejects.toThrow();
    expect(ecs.calls()).toHaveLength(0); expect(scaling.calls()).toHaveLength(0);
  });
  it("proves exact live identity, tags and complete autoscaler absence with read-only SDK commands", async () => {
    expect(await readEcsReplicaRepairTarget(ctx(), node, SERVICE_ARN)).toMatchObject({ serviceArn: SERVICE_ARN, replicas: 2,
      serviceCreatedAt: "2026-09-01T00:00:00.000Z", autoscalingResourceId: `service/${CLUSTER}/${SERVICE_NAME}` });
    expect(ecs.commandCalls(DescribeServicesCommand)[0].args[0].input).toEqual({ cluster: CLUSTER, services: [SERVICE_NAME], include: ["TAGS"] });
    expect(tagging.calls()).toHaveLength(0);
    expect(scaling.commandCalls(DescribeScalableTargetsCommand)[0].args[0].input).toEqual({
      ServiceNamespace: "ecs", ScalableDimension: "ecs:service:DesiredCount", ResourceIds: [`service/${CLUSTER}/${SERVICE_NAME}`], MaxResults: 50,
    });
  });
  it.each([
    { serviceArn: SERVICE_ARN.replace("123456789012", "999999999999") }, { status: "INACTIVE" },
    { clusterArn: "arn:aws:ecs:eu-west-1:123456789012:cluster/another" }, { launchType: "EC2" },
    { schedulingStrategy: "DAEMON" }, { desiredCount: undefined }, { createdAt: undefined },
    { tags: service().tags }, { tags: [] }, { taskDefinition: undefined },
  ] satisfies Partial<Service>[])("refuses incomplete or foreign service facts %#", async (over) => {
    ecs.on(DescribeServicesCommand).resolves({ $metadata: { httpStatusCode: 200 }, services: [healthy(over)] });
    const message = over.tags?.length === 0
      ? `ECS service does not carry the Zenith tags of ${node.address} in this environment; refusing to act on it.`
      : "ECS replica repair target ownership or field controller could not be confirmed.";
    await expect(readEcsReplicaRepairTarget(ctx(), node, SERVICE_ARN)).rejects.toMatchObject({ name: "OperationRefused", code: "operation_refused", message });
    expect(ecs.commandCalls(DescribeServicesCommand)).toHaveLength(1); expect(ecs.calls()).toHaveLength(1);
    expect(scaling.calls()).toHaveLength(0); expect(tagging.calls()).toHaveLength(0);
  });
  it.each(["missing", "partial", "registered", "missing-result", "denied"])("never assumes autoscaler absence (%s)", async (failure) => {
    if (failure === "denied") scaling.on(DescribeScalableTargetsCommand).rejects(new Error("AccessDenied private-payload"));
    else scaling.on(DescribeScalableTargetsCommand).resolves({ $metadata: { httpStatusCode: failure === "missing" ? 503 : 200 },
      ...(failure === "missing-result" ? {} : { ScalableTargets: failure === "registered" ? [registeredTarget] : [] }),
      ...(failure === "partial" ? { NextToken: "remaining-page" } : {}),
    });
    await expect(readEcsReplicaRepairTarget(ctx(), node, SERVICE_ARN)).rejects.toThrow();
  });
  it("refuses emulator proof before any SDK request", async () => {
    await expect(readEcsReplicaRepairTarget(base, node, SERVICE_ARN)).rejects.toThrow();
    expect(ecs.calls()).toHaveLength(0); expect(scaling.calls()).toHaveLength(0);
  });
});
