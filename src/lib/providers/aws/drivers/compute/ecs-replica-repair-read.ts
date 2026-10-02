/** Exact, read-only ownership and field-controller proof for replica repair. */
import { DescribeServicesCommand, ECSClient } from "@aws-sdk/client-ecs";
import { ApplicationAutoScalingClient, DescribeScalableTargetsCommand } from "@aws-sdk/client-application-auto-scaling";
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { digest } from "@/lib/controlplane/digest";
import type { ResourceNode } from "@/lib/resources/types";
import { locationFromArn } from "./ecs-read";
import { assertNodeTags, lowerTagMap, tagsOf, OperationRefused, type AwsCtx } from "./support/sdk";

export interface EcsReplicaRead {
  serviceArn: string; clusterArn: string; serviceCreatedAt: string; taskDefinitionArn: string;
  ownershipTagsDigest: string; replicas: number; autoscalingResourceId: string;
}

export async function readEcsReplicaRepairTarget(ctx: AwsCtx, node: ResourceNode, externalId?: string): Promise<EcsReplicaRead> {
  const refuse = (): never => { throw new OperationRefused("ECS replica repair target ownership or field controller could not be confirmed."); };
  const ownershipKeys = ["zenith:managed", "zenith:workspace", "zenith:environment", "zenith:project", "zenith:resource"];
  if (ctx.session.region !== ctx.region || ctx.session.transport === "emulator" || node.provider !== "aws"
    || node.kind !== "container_service" || node.ownership !== "managed" || node.nativeType !== "aws:ecs_service"
    || ctx.tags["zenith:managed"] !== "true" || ctx.tags["zenith:workspace"] !== ctx.workspaceId
    || ctx.tags["zenith:environment"] !== ctx.environmentId || ctx.tags["zenith:resource"] !== node.address
    || ownershipKeys.some((key) => !ctx.tags[key])) refuse();
  let targetArn = externalId;
  if (!targetArn) {
    // Generic findByTags discards its pagination completeness flag. This
    // initial immutable binding needs explicit complete unique-target proof.
    const lookup = await ctx.session.client(ResourceGroupsTaggingAPIClient).send(new GetResourcesCommand({
      ResourceTypeFilters: ["ecs:service"], ResourcesPerPage: 100,
      TagFilters: ownershipKeys.map((Key) => ({ Key, Values: [ctx.tags[Key]] })),
    }), { abortSignal: ctx.signal });
    const mapping = lookup.ResourceTagMappingList?.[0];
    if (lookup.$metadata.httpStatusCode !== 200 || !Array.isArray(lookup.ResourceTagMappingList)
      || lookup.ResourceTagMappingList.length !== 1 || lookup.PaginationToken || !mapping?.ResourceARN) refuse();
    const tags = tagsOf(mapping!.Tags);
    if (ownershipKeys.some((key) => tags[key] !== ctx.tags[key])) refuse();
    targetArn = mapping!.ResourceARN;
  }
  const loc = locationFromArn(targetArn!);
  const prefix = `arn:aws:ecs:${ctx.region}:${ctx.session.accountId}:`;
  if (!loc || !targetArn!.startsWith(`${prefix}service/`)) refuse();
  // Do not infer absence from API errors, a partial page or an omitted result.
  const serviceResult = await ctx.session.client(ECSClient).send(new DescribeServicesCommand({
    cluster: loc!.cluster, services: [loc!.service], include: ["TAGS"],
  }), { abortSignal: ctx.signal });
  const service = serviceResult.services?.[0];
  if (serviceResult.$metadata.httpStatusCode !== 200 || (serviceResult.failures?.length ?? 0) !== 0
    || serviceResult.services?.length !== 1 || !service || service.serviceArn !== targetArn || service.status !== "ACTIVE"
    || service.serviceName !== loc!.service || service.clusterArn !== `${prefix}cluster/${loc!.cluster}`
    || service.launchType !== "FARGATE" || service.schedulingStrategy !== "REPLICA"
    || !Number.isInteger(service.desiredCount) || service.desiredCount! < 0 || service.desiredCount! > 1000
    || !(service.createdAt instanceof Date) || !Number.isFinite(service.createdAt.getTime())
    || !service.taskDefinition?.startsWith(`${prefix}task-definition/`)) refuse();
  const tags = lowerTagMap(service!.tags);
  assertNodeTags(ctx, node, tags, "ECS service");
  for (const key of ownershipKeys) {
    if (!ctx.tags[key] || tags[key] !== ctx.tags[key]) refuse();
  }
  const autoscalingResourceId = `service/${loc!.cluster}/${loc!.service}`;
  const scaling = await ctx.session.client(ApplicationAutoScalingClient).send(new DescribeScalableTargetsCommand({
    ServiceNamespace: "ecs", ScalableDimension: "ecs:service:DesiredCount", ResourceIds: [autoscalingResourceId], MaxResults: 50,
  }), { abortSignal: ctx.signal });
  if (scaling.$metadata.httpStatusCode !== 200 || !Array.isArray(scaling.ScalableTargets)
    || scaling.ScalableTargets.length !== 0 || scaling.NextToken) refuse();
  return {
    serviceArn: targetArn!, clusterArn: service!.clusterArn!, serviceCreatedAt: service!.createdAt!.toISOString(),
    taskDefinitionArn: service!.taskDefinition!, replicas: service!.desiredCount!,
    ownershipTagsDigest: digest(Object.fromEntries(Object.keys(ctx.tags).sort().map((key) => [key, tags[key]]))), autoscalingResourceId,
  };
}
