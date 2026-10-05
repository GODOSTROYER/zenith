/**
 * PROD-LIFE-12: the ECS service compile asks the field-ownership registry
 * whether tofu may keep writing desired_count. A manifest-owned count keeps
 * today's output byte for byte; an attached autoscaler gets ignore_changes.
 */
import { describe, expect, it } from "vitest";
import type { ResourceNode } from "@/lib/resources/types";
import { ecsServiceDriver } from "@/lib/providers/aws/drivers/compute/ecs-service";
import { buildFixture, mkCompileContext } from "./fixtures";

type Body = Record<string, unknown>;
const compile = (autoscaling?: Record<string, unknown>) => {
  const fx = buildFixture({});
  const node = fx.byAddress.get("container_service/web")!;
  const next: ResourceNode = autoscaling ? { ...node, spec: { ...node.spec, autoscaling } } : node;
  fx.byAddress.set(node.address, next);
  const fragment = ecsServiceDriver.compile!(next, mkCompileContext(fx.byAddress));
  return (fragment.resource as Record<string, Record<string, Body>>).aws_ecs_service.container_service_web;
};

describe("aws_ecs_service lifecycle from field ownership", () => {
  it("emits no lifecycle block while the manifest owns desired_count", () => {
    expect(compile().lifecycle).toBeUndefined();
  });

  it("ignores desired_count once an autoscaler owns it", () => {
    expect(compile({ min: 1, max: 4 }).lifecycle).toEqual({ ignore_changes: ["desired_count"] });
  });
});
