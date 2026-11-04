/** One declarative repair recipe. It never calls native UpdateService. */
import { digest } from "@/lib/controlplane/digest";
import type { ProviderConnection, ProviderSession } from "@/lib/credentials/types";
import type { ResourceGraph, ResourceNode } from "@/lib/resources/types";
import { readEcsReplicaRepairTarget, type EcsReplicaRead } from "@/lib/providers/aws/drivers/compute/ecs-replica-repair-read";
import { configDigestOf } from "@/lib/tofu/config-digest";
import type { ShowJson } from "@/lib/tofu/plan";
import type { NormalizedPlan, TofuWorkspace } from "@/lib/tofu/types";
import type { LeaseRef } from "@/lib/workflows/types";
import { loadExecContext, resolveConnection, type ExecContext } from "./context";
import { requireExecutable } from "./desired";
import { EcsReplicaRepairInput, readRepairBinding, repairBindingDigest, repairBindingEvidenceId, type EcsReplicaRepairBindingV1 } from "./ecs-replica-repair-binding";
import { StepFailedError } from "./errors";
import type { Runtime } from "./runtime";
import { driverContext } from "./session";
import { ecsReplicaRepairRecipe } from "@/lib/resources";

const refuse = (): never => { throw new StepFailedError("This repair does not match the supported, immutable ECS replica-only recipe; nothing was applied."); };

export async function prepareEcsReplicaRepair(rt: Runtime, ec: ExecContext, graph: ResourceGraph, ws: TofuWorkspace,
  connection: ProviderConnection, session: ProviderSession, signal: AbortSignal, lease: LeaseRef): Promise<{ binding: EcsReplicaRepairBindingV1; node: ResourceNode; ws: TofuWorkspace }> {
  const input = EcsReplicaRepairInput.safeParse(ec.op.proposal.input);
  const node = input.success ? graph.nodes.find((n) => n.address === input.data.address) : undefined;
  const row = ec.op.resourceId ? await rt.d.resources.get(ec.workspaceId, ec.op.resourceId) : null;
  const revision = ec.product.revision;
  const current = await loadExecContext(rt, ec.op.id);
  const currentConnection = await resolveConnection(rt, current);
  const currentGraph = requireExecutable(rt, current).graph;
  const recipe = input.success && node ? ecsReplicaRepairRecipe(node, input.data) : undefined;
  if (!input.success || input.data.graphDigest !== graph.graphDigest || ec.op.capability !== "drift.repair"
    || !revision || ec.product.environment.deployedRevisionId !== revision.id || !node || !row
    || ec.product.environment.provider !== "aws" || connection.config.provider !== "aws" || session.provider !== "aws"
    || connection.workspaceId !== ec.workspaceId || connection.status !== "verified"
    || current.op.status !== "running" || current.op.capability !== "drift.repair" || current.op.workspaceId !== ec.workspaceId || current.op.environmentId !== ec.environmentId
    || ec.op.projectId !== ec.product.project.id || current.op.projectId !== ec.product.project.id
    || current.op.resourceId !== ec.op.resourceId || current.op.proposalDigest !== ec.op.proposalDigest
    || current.product.workspace.id !== ec.workspaceId || current.product.environment.id !== ec.environmentId
    || current.product.project.id !== ec.product.project.id || current.product.environment.region !== ec.product.environment.region
    || current.product.environment.deployedRevisionId !== revision?.id || current.product.revision?.id !== revision?.id
    || currentGraph.graphDigest !== graph.graphDigest || current.product.environment.connectionId !== ec.product.environment.connectionId
    || currentConnection.id !== connection.id || digest(currentConnection.config) !== digest(connection.config)
    || session.accountId !== connection.config.accountId || session.region !== ec.product.environment.region
    || node.provider !== "aws" || node.kind !== "container_service" || node.nativeType !== "aws:ecs_service" || node.ownership !== "managed"
    || row.workspaceId !== ec.workspaceId || row.environmentId !== ec.environmentId || row.address !== node.address
    || row.ownership !== "managed" || row.nativeType !== node.nativeType || row.specDigest !== node.specDigest
    || row.kind !== node.kind || (node.region && node.region !== ec.product.environment.region)
    || (row.region && row.region !== ec.product.environment.region) || row.projectId !== ec.product.project.id
    || ws.backend !== "s3" || ws.files.filter((f) => f.path === "backend.tf.json").length !== 1
    || row.status === "deleted" || row.provider !== "aws" || !recipe) refuse();
  const tofuAddresses = ws.addressMap[node!.address]?.filter((a) => /^aws_ecs_service\.[A-Za-z0-9_]+$/.test(a));
  if (tofuAddresses?.length !== 1) refuse();
  let read: EcsReplicaRead;
  try {
    await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
    read = await readEcsReplicaRepairTarget({ ...driverContext(rt, ec, session, signal, { node, fence: lease, connection }), session: session as Extract<ProviderSession, { provider: "aws" }> }, node!, row!.externalId);
  } catch {
    if (signal.aborted) throw new Error("ECS replica repair ownership read was interrupted.");
    throw new StepFailedError("ECS replica repair requires a complete real ownership and autoscaler read; nothing was applied.");
  }
  await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
  const candidate: EcsReplicaRepairBindingV1 = {
    version: 1, recipe: "aws.ecs.replicas", workspaceId: ec.workspaceId, environmentId: ec.environmentId,
    projectId: ec.product.project.id, operationId: ec.op.id, resourceId: row!.id, address: node!.address,
    revisionId: revision!.id, graphDigest: graph.graphDigest, specDigest: node!.specDigest,
    provider: "aws", nativeType: "aws:ecs_service", connectionId: connection.id,
    productConnectionId: ec.product.environment.connectionId, accountId: (connection.config as Extract<ProviderConnection["config"], { provider: "aws" }>).accountId,
    region: ec.product.environment.region, backendDigest: digest(ws.files.filter((f) => f.path === "backend.tf.json")),
    tofuAddress: tofuAddresses![0], serviceArn: read.serviceArn, clusterArn: read.clusterArn,
    serviceCreatedAt: read.serviceCreatedAt, taskDefinitionArn: read.taskDefinitionArn, ownershipTagsDigest: read.ownershipTagsDigest,
    field: recipe!.field, desiredReplicas: recipe!.desiredReplicas, observedReplicas: read.replicas,
    readProvenance: { service: "ecs:DescribeServices", autoscaling: "application-autoscaling:DescribeScalableTargets",
      resourceId: read.autoscalingResourceId, namespace: "ecs", dimension: "ecs:service:DesiredCount", complete: true, scalableTargets: 0, simulated: false },
  };
  const bindingDigest = repairBindingDigest(candidate);
  // The port returns the ORIGINAL row on a repeated deterministic id. Compare
  // it; do not silently rematerialize a moved target during an activity retry.
  const evidence = await rt.d.evidence.append({ id: repairBindingEvidenceId(ec.op.id), workspaceId: ec.workspaceId,
    operationId: ec.op.id, kind: "observation", digest: bindingDigest, simulated: false,
    summary: { recipe: "aws.ecs.replicas", binding: candidate } });
  const binding = readRepairBinding(evidence.summary.binding);
  if (!binding || evidence.simulated || evidence.workspaceId !== ec.workspaceId || evidence.operationId !== ec.op.id
    || evidence.digest !== bindingDigest || repairBindingDigest(binding) !== bindingDigest) refuse();
  const file = { path: "zenith-repair-binding.tf.json", content: JSON.stringify({ locals: { zenith_repair_binding_digest: bindingDigest } }) };
  if (ws.files.some((f) => f.path === file.path)) refuse();
  const files = [...ws.files, file];
  return { binding: binding!, node: node!, ws: { ...ws, files, configDigest: configDigestOf(files) } };
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const hasTrue = (value: unknown): boolean => value === true || (value !== null && typeof value === "object" && Object.values(value).some(hasTrue));

/** Raw plans stay inside this callback. Every managed write must be accounted for. */
export function assertEcsReplicaRepairPlan(plan: NormalizedPlan, raw: ShowJson, binding: EcsReplicaRepairBindingV1, ws: TofuWorkspace): void {
  const writes = plan.resourceChanges.filter((c) => !["no-op", "read"].includes(c.action));
  const change = writes[0];
  if (plan.configDigest !== ws.configDigest || plan.lockDigest !== ws.lockDigest || writes.length !== 1
    || !change || change.address !== binding.tofuAddress || change.nodeAddress !== binding.address
    || change.type !== "aws_ecs_service" || change.action !== "update" || change.destroysData
    || change.changes.length !== 1 || change.changes[0].path !== "desired_count" || change.changes[0].sensitive
    || change.changes[0].forcesReplacement || change.changes[0].before !== binding.observedReplicas
    || change.changes[0].after !== binding.desiredReplicas
    || plan.outputChanges.some((o) => o.action !== "no-op") || !Array.isArray(raw.resource_changes)) refuse();
  let updates = 0;
  for (const resource of raw.resource_changes!) {
    const actions = resource.change?.actions;
    if (JSON.stringify(actions) === '["no-op"]' || (resource.mode === "data" && JSON.stringify(actions) === '["read"]')) continue;
    if (resource.mode !== "managed" || resource.address !== binding.tofuAddress || resource.type !== "aws_ecs_service"
      || resource.provider_name !== "registry.opentofu.org/hashicorp/aws"
      || JSON.stringify(actions) !== '["update"]' || resource.deposed
      || (resource.change?.replace_paths !== undefined && (!Array.isArray(resource.change.replace_paths) || resource.change.replace_paths.length !== 0))
      || hasTrue(resource.change?.after_unknown) || hasTrue(resource.change?.before_sensitive) || hasTrue(resource.change?.after_sensitive)) refuse();
    const before = object(resource.change?.before); const after = object(resource.change?.after);
    if (!before || !after || before.id !== binding.serviceArn || after.id !== binding.serviceArn
      || before.cluster !== binding.clusterArn || after.cluster !== binding.clusterArn
      || before.task_definition !== binding.taskDefinitionArn || after.task_definition !== binding.taskDefinitionArn
      || before.desired_count !== binding.observedReplicas || after.desired_count !== binding.desiredReplicas) refuse();
    const beforeRest = Object.fromEntries(Object.entries(before!).filter(([key]) => key !== "desired_count"));
    const afterRest = Object.fromEntries(Object.entries(after!).filter(([key]) => key !== "desired_count"));
    if (digest(beforeRest) !== digest(afterRest)) refuse();
    updates++;
  }
  if (updates !== 1 || Object.values(raw.output_changes ?? {}).some((c) => JSON.stringify(c.actions) !== '["no-op"]')) refuse();
}

export async function recordEcsReplicaRepairReadback(rt: Runtime, ec: ExecContext, binding: EcsReplicaRepairBindingV1,
  node: ResourceNode, connection: ProviderConnection, session: ProviderSession, signal: AbortSignal, lease: LeaseRef, planDigest: string): Promise<void> {
  // Every failure here follows a possible mutation. Keep it unclassified so
  // the workflow records uncertainty rather than a definite pre-write refusal.
  try {
    if (session.provider !== "aws") throw new Error("Wrong read session.");
    await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
    const read = await readEcsReplicaRepairTarget({ ...driverContext(rt, ec, session, signal, { node, fence: lease, connection }), session }, node, binding.serviceArn);
    if (read.serviceArn !== binding.serviceArn || read.clusterArn !== binding.clusterArn || read.serviceCreatedAt !== binding.serviceCreatedAt
      || read.taskDefinitionArn !== binding.taskDefinitionArn || read.ownershipTagsDigest !== binding.ownershipTagsDigest
      || read.replicas !== binding.desiredReplicas) throw new Error("Readback mismatch.");
    await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
    const bindingDigest = repairBindingDigest(binding);
    const evidenceDigest = digest({ planDigest, bindingDigest, replicas: read.replicas });
    const summary = { recipe: binding.recipe, planDigest, bindingDigest, address: binding.address,
      status: "passed", checks: 1, field: "desired_count", desiredReplicas: binding.desiredReplicas, observedReplicas: read.replicas };
    const receipt = await rt.evidence(ec.scope, { kind: "verification", digest: evidenceDigest,
      summary,
      simulated: false, key: `ecs-replica-readback:${planDigest}` }, { critical: true });
    // Critical mutation evidence can exhaust its retries and return no receipt.
    // A matching read is not durable verification until the exact row exists.
    if (!receipt || receipt.workspaceId !== ec.workspaceId || receipt.operationId !== ec.op.id || receipt.kind !== "verification"
      || receipt.digest !== evidenceDigest || receipt.simulated || digest(receipt.summary) !== digest(summary)) {
      throw new Error("Replica readback evidence is unconfirmed.");
    }
  } catch { throw new Error("ECS replica repair may have applied, but its exact owned target and replica readback are unconfirmed. Inspect this operation before any further write."); }
}
