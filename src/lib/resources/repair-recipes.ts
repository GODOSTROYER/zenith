/** Pure declarative admission only. A recipe is not a grant or ownership proof. */
import { z } from "zod";
import type { DriftFinding, ResourceNode } from "./types";

export const EcsReplicaRepairInput = z.object({
  action: z.literal("reapply_desired_state"), address: z.string().min(1).max(500),
  kind: z.literal("container_service"), findingClass: z.literal("changed"),
  severity: z.enum(["low", "medium"]), attributes: z.tuple([z.literal("replicas")]),
  graphDigest: z.string().regex(/^[a-f0-9]{64}$/), reportComputedAt: z.string().datetime(),
}).strict();
export type EcsReplicaRepairInputV1 = z.infer<typeof EcsReplicaRepairInput>;
export interface EcsReplicaRepairRecipeV1 {
  version: 1;
  recipe: "aws.ecs.replicas";
  field: "desired_count";
  desiredReplicas: number;
}

/**
 * Supports one changed replica field, never a missing/replaced resource or a
 * generic native operation. Finding flags are not authority: this predicate
 * supplies truthful recipe availability before the reconciler derives them.
 * Live ownership, autoscaler absence and the complete saved plan remain worker
 * checks. Calling this function never authorizes a mutation.
 */
export function ecsReplicaRepairRecipe(node: ResourceNode, findingOrInput: DriftFinding | EcsReplicaRepairInputV1): EcsReplicaRepairRecipeV1 | undefined {
  const replicas = node.spec.replicas;
  const artifact = node.spec.artifact;
  if (node.provider !== "aws" || node.ownership !== "managed" || node.kind !== "container_service" || node.nativeType !== "aws:ecs_service"
    || typeof replicas !== "number" || !Number.isInteger(replicas) || replicas < 1 || replicas > 20
    || artifact === null || typeof artifact !== "object" || Array.isArray(artifact)
    || !("type" in artifact) || artifact.type !== "image" || !("ref" in artifact) || typeof artifact.ref !== "string"
    || !/@sha256:[a-f0-9]{64}$/.test(artifact.ref)) return undefined;
  if ("class" in findingOrInput) {
    const finding = findingOrInput;
    const field = finding.fields?.[0];
    if (finding.address !== node.address || finding.class !== "changed" || finding.severity === "high"
      || finding.fields?.length !== 1 || !field || field.attribute !== "replicas" || field.desired !== replicas
      || typeof field.observed !== "number" || !Number.isInteger(field.observed) || field.observed < 0 || field.observed > 1000
      || field.observed === replicas) return undefined;
  } else {
    const input = EcsReplicaRepairInput.safeParse(findingOrInput);
    if (!input.success || input.data.address !== node.address) return undefined;
  }
  return { version: 1, recipe: "aws.ecs.replicas", field: "desired_count", desiredReplicas: replicas };
}

export function supportsDeclarativeRepair(node: ResourceNode, finding: DriftFinding): boolean {
  return ecsReplicaRepairRecipe(node, finding) !== undefined;
}
