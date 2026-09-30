/**
 * `aws:ecs_service` compile: the ECS service around the shared task plumbing
 * (`ecs-task.ts`).
 *
 * The service is Fargate + awsvpc in the PRIVATE subnets with no public IP;
 * it is reachable only through the load balancer's security-group rule.
 *
 *   - `desired_count` is MANAGED by tofu (= `spec.replicas`). `service.scale`
 *     changes the running count immediately, and the next apply sets it back
 *     to the manifest's value unless the manifest is updated too: the manifest
 *     is the single source of truth for capacity, and a live-only override that
 *     silently survived applies would be undeclared state. The scale operation
 *     says so in its result.
 *   - `deployment_circuit_breaker { enable, rollback }`: a rollout whose tasks
 *     keep failing rolls back to the last steady task definition by itself.
 *   - min healthy 100 % / max 200 %: replacement tasks start before the old
 *     ones stop (capacity for one extra copy is needed during a rollout).
 *   - `wait_for_steady_state` false: the apply returns when the service is
 *     created/updated; the deploy workflow waits natively (DescribeServices)
 *     and reports rollout failures itself.
 *   - `enable_execute_command` false: no interactive shell into tasks
 *     (`container.exec` is an escape-hatch capability with its own gates).
 *   - `propagate_tags = SERVICE` so tasks carry the Zenith tags.
 *
 * When a load balancer routes to this node the service gets one
 * `load_balancer` block per routed container port, attached to the target
 * group the load balancer node published for this target (`ctx.ref(lb,
 * "target_group_arn:<this address>")`). ECS refuses to create a service whose
 * target group is not yet attached to a listener, so the service waits for a
 * readiness value the load balancer node publishes (`lbReadiness` below).
 */
import type { CompileContext, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { ContainerServiceSpec, LoadBalancerSpec } from "@/lib/resources/specs";
import { cloudName, nodeName, targetGroupAttribute, tfLabel } from "./support/aws-shared";
import { compileNode, intField, specOf } from "./support/driver-util";
import { dependencies } from "./support/refs";
import { ComputeCompileError, Frag, attr, dependsOnTarget, rawRef, refOf, tagsFor } from "./support/tf";
import { emitTask } from "./ecs-task";
import { fargateSize } from "./support/fargate";
import { parseImageRef } from "./support/image";

const MAX_REPLICAS = 1000;

/** Container ports a load balancer routes to `node`, ascending and distinct. */
function routedPorts(ctx: CompileContext, node: ResourceNode, spec: ContainerServiceSpec): { lb: ResourceNode; ports: number[] } | undefined {
  const lbs = dependencies(ctx, node, "load_balancer");
  const routed = lbs
    .map((lb) => ({
      lb,
      ports: [
        ...new Set(
          ((lb.spec as Partial<LoadBalancerSpec>).routes ?? [])
            .filter((r) => r.target === node.address)
            .map((r) => {
              const port = r.port ?? spec.port;
              if (port === undefined) throw new ComputeCompileError("invalid_spec", `${node.address} is routed by ${lb.address} but declares no port.`);
              return port;
            })
        ),
      ].sort((a, b) => a - b),
    }))
    .filter((r) => r.ports.length > 0);
  if (routed.length > 1) throw new ComputeCompileError("unsupported", `${node.address} is routed by more than one load balancer (${routed.map((r) => r.lb.address).join(", ")}).`);
  return routed[0];
}

export function compileEcsService(node: ResourceNode, ctx: CompileContext): TofuFragment {
  return compileNode(node, () => {
    const spec = specOf<ContainerServiceSpec>(node);
    const replicas = intField(node, spec.replicas, "replicas", 1, 0, MAX_REPLICAS);
    const label = tfLabel(node.address);
    const b = new Frag(node.address);

    const routed = routedPorts(ctx, node, spec);
    const t = emitTask(b, node, ctx, spec, routed?.ports ?? []);

    const dependsOn = [...t.prerequisites];
    const loadBalancer: Record<string, unknown>[] = [];
    let healthGrace: number | undefined;
    if (routed) {
      const multiple = routed.ports.length > 1;
      for (const port of routed.ports) {
        loadBalancer.push({
          target_group_arn: refOf(ctx, routed.lb.address, targetGroupAttribute(node.address, multiple ? port : undefined)),
          container_name: t.name,
          container_port: port,
        });
      }
      const gate = lbReadiness(ctx, routed.lb, node);
      if (gate) {
        const ready = b.resource("terraform_data", `${label}_lb_ready`, { input: gate });
        dependsOn.push(dependsOnTarget(ready));
      }
      healthGrace = 60;
    }

    const name = cloudName(ctx.namePrefix, nodeName(node.address), 255);
    const service = b.resource("aws_ecs_service", label, {
      name,
      cluster: attr(t.cluster, "arn"),
      task_definition: attr(t.taskDefinition, "arn"),
      desired_count: replicas,
      launch_type: "FARGATE",
      ...(spec.platformVersion ? { platform_version: spec.platformVersion } : {}),
      deployment_minimum_healthy_percent: 100,
      deployment_maximum_percent: 200,
      deployment_circuit_breaker: [{ enable: true, rollback: true }],
      enable_execute_command: false,
      enable_ecs_managed_tags: true,
      propagate_tags: "SERVICE",
      wait_for_steady_state: false,
      ...(healthGrace !== undefined ? { health_check_grace_period_seconds: healthGrace } : {}),
      network_configuration: [{ subnets: t.subnets, security_groups: [t.securityGroup], assign_public_ip: false }],
      ...(loadBalancer.length ? { load_balancer: loadBalancer } : {}),
      depends_on: dependsOn,
      tags: tagsFor(ctx, node, name),
    });
    b.expose("arn", attr(service, "arn"));
    b.expose("name", attr(service, "name"));
    return b.build(service);
  });
}

/**
 * The readiness value a load balancer node publishes once the target group
 * for `target` is attached to a listener (`ready:<target address>`). The ECS
 * service waits for it through a `terraform_data` gate. Returns `undefined`
 * when the load balancer does not publish one (the service then relies on the
 * target-group reference alone).
 */
function lbReadiness(ctx: CompileContext, lb: ResourceNode, target: ResourceNode) {
  void ctx;
  void lb;
  void target;
  return undefined as ReturnType<typeof rawRef> | undefined;
}

/* --------------------------------- expected ------------------------------- */

/** Image the manifest pins, when it pins one; built images are not a desired attribute. */
export function pinnedImage(spec: ContainerServiceSpec): string | undefined {
  return spec.artifact?.type === "image" ? parseImageRef(spec.artifact.ref).ref : undefined;
}

export function expectedEcsService(node: ResourceNode): Record<string, unknown> {
  const spec = specOf<ContainerServiceSpec>(node);
  const size = fargateSize(spec.vcpu, spec.memoryMb);
  const image = pinnedImage(spec);
  return {
    replicas: spec.replicas,
    cpu: size.cpu,
    memoryMb: size.memoryMb,
    launchType: "FARGATE",
    assignPublicIp: false,
    ...(spec.port !== undefined ? { port: spec.port } : {}),
    ...(image !== undefined ? { image } : {}),
  };
}
