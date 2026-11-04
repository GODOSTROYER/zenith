/**
 * Small pieces every compute driver's `compile` and operations share.
 */
import type { TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { DriverCompileError } from "@/lib/providers/aws/drivers/shared";
import { CronError } from "./cron";
import { ImageRefError } from "./image";
import { ComputeCompileError } from "./tf";

/** Node addresses end up in descriptions and tags; refuse anything that is not plain address text. */
const SAFE_ADDRESS = /^[A-Za-z0-9][A-Za-z0-9/_.:-]*$/;

/**
 * Run a compile body. Errors from the support modules are re-thrown as
 * `DriverCompileError` carrying the node address; a node Zenith does not
 * manage compiles to an empty fragment (it may only ever be a data source).
 */
export function compileNode(node: ResourceNode, body: () => TofuFragment): TofuFragment {
  if (node.provider !== "aws") throw new DriverCompileError("unsupported", node.address, `an AWS driver cannot compile a ${node.provider} node.`);
  if (!SAFE_ADDRESS.test(node.address)) throw new DriverCompileError("invalid_spec", node.address, "the node address contains characters that are not allowed in a tofu fragment.");
  if (node.ownership !== "managed") return { addresses: [] };
  try {
    return body();
  } catch (e) {
    if (e instanceof DriverCompileError) throw e;
    if (e instanceof ComputeCompileError) throw new DriverCompileError(e.code === "missing_neighbour" ? "missing_node" : e.code === "unsupported" ? "unsupported" : "invalid_spec", node.address, e.message);
    if (e instanceof CronError) throw new DriverCompileError("invalid_spec", node.address, `schedule: ${e.message}`);
    if (e instanceof ImageRefError) throw new DriverCompileError("invalid_spec", node.address, e.message);
    throw e;
  }
}

/** The spec as a typed record; a node with no spec object is a graph bug, not a default. */
export function specOf<T>(node: ResourceNode): T {
  if (node.spec === null || typeof node.spec !== "object") throw new DriverCompileError("invalid_spec", node.address, "the node has no spec.");
  return node.spec as unknown as T;
}

/** A positive integer from a spec field, with a default when absent. */
export function intField(node: ResourceNode, value: unknown, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new DriverCompileError("invalid_spec", node.address, `${name} must be an integer from ${min} to ${max} (got ${String(value)}).`);
  }
  return value;
}
