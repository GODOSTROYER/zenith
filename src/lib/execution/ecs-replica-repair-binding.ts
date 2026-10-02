/** Server-authored, immutable effect materialization. No credentials or raw plans. */
import { z } from "zod";
import { digest } from "@/lib/controlplane/digest";

const id = z.string().min(1).max(500);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export { EcsReplicaRepairInput } from "@/lib/resources";

export const EcsReplicaRepairBinding = z.object({
  version: z.literal(1), recipe: z.literal("aws.ecs.replicas"),
  workspaceId: id, environmentId: id, projectId: id, operationId: id,
  resourceId: id, address: id, revisionId: id, graphDigest: sha, specDigest: sha,
  provider: z.literal("aws"), nativeType: z.literal("aws:ecs_service"),
  connectionId: id, productConnectionId: id, accountId: z.string().regex(/^\d{12}$/), region: id,
  backendDigest: sha, tofuAddress: z.string().regex(/^aws_ecs_service\.[A-Za-z0-9_]+$/),
  serviceArn: id, clusterArn: id, serviceCreatedAt: z.string().datetime(), taskDefinitionArn: id,
  ownershipTagsDigest: sha, field: z.literal("desired_count"), desiredReplicas: z.number().int().min(1).max(20),
  observedReplicas: z.number().int().min(0).max(1000),
  readProvenance: z.object({
    service: z.literal("ecs:DescribeServices"), autoscaling: z.literal("application-autoscaling:DescribeScalableTargets"),
    resourceId: id, namespace: z.literal("ecs"), dimension: z.literal("ecs:service:DesiredCount"),
    complete: z.literal(true), scalableTargets: z.literal(0), simulated: z.literal(false),
  }).strict(),
}).strict();

export type EcsReplicaRepairBindingV1 = z.infer<typeof EcsReplicaRepairBinding>;
export const repairBindingDigest = (binding: EcsReplicaRepairBindingV1): string => digest(binding);
export const repairBindingEvidenceId = (operationId: string): string =>
  `evd_${digest({ operationId, recipe: "aws.ecs.replicas", version: 1 }).slice(0, 32)}`;

export function readRepairBinding(value: unknown): EcsReplicaRepairBindingV1 | undefined {
  const parsed = EcsReplicaRepairBinding.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
