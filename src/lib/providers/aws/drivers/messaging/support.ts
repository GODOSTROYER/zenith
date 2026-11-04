/**
 * Validation for the remaining AWS native drivers. Only declared fields reach
 * tofu; invalid values are never echoed in errors. Portable fields and native
 * spec.config share one schema, with conflicting declarations refused.
 */
import { z } from "zod";
import type { CompileContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { DriverCompileError } from "@/lib/providers/aws/drivers/shared";

export const KMS_KEY_ARN = /^arn:aws(?:-cn|-us-gov)?:kms:[a-z0-9-]+:\d{12}:key\/[a-f0-9-]{36}$/;
export const SNS_TOPIC_ARN = /^arn:aws(?:-cn|-us-gov)?:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}(?:\.fifo)?$/;

export function readSpec<S extends z.ZodRawShape>(node: ResourceNode, schema: z.ZodObject<S>): z.infer<typeof schema> {
  const keys = Object.keys(schema.shape);
  const input: Record<string, unknown> = {};
  for (const key of keys) if (node.spec[key] !== undefined) input[key] = node.spec[key];
  const config = node.spec.config;
  if (config !== undefined) {
    if (config === null || typeof config !== "object" || Array.isArray(config)) {
      throw new DriverCompileError("invalid_spec", node.address, "spec.config must be an object.");
    }
    for (const [key, value] of Object.entries(config)) {
      if (!keys.includes(key)) throw new DriverCompileError("invalid_spec", node.address, "spec.config contains an unsupported field.");
      if (key in input && JSON.stringify(input[key]) !== JSON.stringify(value)) {
        throw new DriverCompileError("invalid_spec", node.address, "spec and spec.config contain conflicting declarations.");
      }
      input[key] = value;
    }
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new DriverCompileError("invalid_spec", node.address, "the desired configuration has an invalid or missing field.");
  return parsed.data;
}

/** Providers/regions cannot be silently mixed in a single AWS fragment. */
export function assertAwsNode(node: ResourceNode, ctx: CompileContext): void {
  if (node.provider !== "aws" || node.region !== ctx.region) {
    throw new DriverCompileError("unsupported", node.address, "the node must be in this AWS provider region.");
  }
}

export function neighbour(node: ResourceNode, ctx: CompileContext, address: string, nativeType: string): ResourceNode {
  const target = ctx.node(address);
  if (!target) throw new DriverCompileError("missing_node", node.address, "a named dependency is missing from the graph.");
  if (target.nativeType !== nativeType || target.provider !== "aws" || target.region !== node.region) {
    throw new DriverCompileError("unsupported", node.address, "a named dependency has the wrong AWS native type or region.");
  }
  return target;
}
