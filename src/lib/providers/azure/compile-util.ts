/**
 * Small shared helpers for Azure `compile()` implementations.
 *
 * Compile is pure and deterministic: nothing here reads the clock, the
 * environment or the network. A fragment built with `fragment()` lists exactly
 * the tofu addresses it defines (the workspace assembler rejects a fragment
 * that claims an address it does not define).
 */
import type { CompileContext, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";

/** A node cannot be realized on Azure as described (missing neighbour, unsupported combination…). */
export class AzureCompileError extends Error {
  readonly code = "azure_compile_error";
  constructor(
    message: string,
    readonly address?: string
  ) {
    super(address ? `${address}: ${message}` : message);
    this.name = "AzureCompileError";
  }
}

type Blocks = Record<string, Record<string, Record<string, unknown>>>;

export interface FragmentParts {
  resource?: Blocks;
  data?: Blocks;
  locals?: Record<string, unknown>;
  output?: TofuFragment["output"];
}

/** Build a fragment whose `addresses` are exactly the blocks it defines, sorted. */
export function fragment(parts: FragmentParts): TofuFragment {
  const addresses: string[] = [];
  for (const [type, named] of Object.entries(parts.resource ?? {})) for (const name of Object.keys(named)) addresses.push(`${type}.${name}`);
  for (const [type, named] of Object.entries(parts.data ?? {})) for (const name of Object.keys(named)) addresses.push(`data.${type}.${name}`);
  addresses.sort();
  const out: TofuFragment = { addresses };
  if (parts.resource && Object.keys(parts.resource).length) out.resource = parts.resource;
  if (parts.data && Object.keys(parts.data).length) out.data = parts.data;
  if (parts.locals && Object.keys(parts.locals).length) out.locals = parts.locals;
  if (parts.output && Object.keys(parts.output).length) out.output = parts.output;
  return out;
}

/** `{ [type]: { [label]: body } }` for one resource. */
export const block = (type: string, label: string, body: Record<string, unknown>): Blocks => ({ [type]: { [label]: body } });

/** Merge several block maps (labels must be unique within a type; later wins is never intended). */
export function mergeBlocks(...parts: Blocks[]): Blocks {
  const out: Blocks = {};
  for (const p of parts) {
    for (const [type, named] of Object.entries(p)) {
      const target = (out[type] ??= {});
      for (const [label, body] of Object.entries(named)) {
        if (label in target) throw new AzureCompileError(`duplicate tofu block ${type}.${label}`);
        target[label] = body;
      }
    }
  }
  return out;
}

/** Typed read of a node's spec (the shapes live in `@/lib/resources/specs`). */
export const specOf = <T>(node: ResourceNode): T => node.spec as unknown as T;

/** A neighbour that must exist for this node to compile. */
export function requireNode(ctx: CompileContext, address: string, why: string, from?: string): ResourceNode {
  const n = ctx.node(address);
  if (!n) throw new AzureCompileError(`${why}: "${address}" is not in the graph.`, from);
  return n;
}

/**
 * The Azure network node that owns this node's environment landing zone
 * (resource group, VNet, platform subnets, private DNS, Container Apps
 * environment). Resolved from `dependsOn` (directly, through a subnet's
 * `spec.network`, or through a firewall's source/target) and finally by the
 * expansion's naming convention (`network/main`, `network/azure-<region>`).
 * A graph with no Azure network cannot host this node: the resource group is
 * owned by the network node, and there is no other owner.
 */
export function resolveNetwork(node: ResourceNode, ctx: CompileContext): string {
  const seen = new Set<string>();
  const asNetwork = (addr: string): string | undefined => {
    if (seen.has(addr)) return undefined;
    seen.add(addr);
    const n = ctx.node(addr);
    if (!n) return undefined;
    if (n.kind === "network" && n.provider === "azure") return addr;
    if (n.kind === "subnet" && typeof n.spec.network === "string") {
      const net = ctx.node(n.spec.network);
      if (net?.kind === "network" && net.provider === "azure") return n.spec.network;
    }
    return undefined;
  };
  for (const d of node.dependsOn) {
    const r = asNetwork(d);
    if (r) return r;
  }
  for (const d of node.dependsOn) {
    const dep = ctx.node(d);
    if (!dep) continue;
    for (const dd of dep.dependsOn) {
      const r = asNetwork(dd);
      if (r) return r;
    }
  }
  for (const cand of ["network/main", `network/azure-${node.region}`]) {
    const n = ctx.node(cand);
    if (n && n.kind === "network" && n.provider === "azure" && n.region === node.region) return cand;
  }
  throw new AzureCompileError(
    "needs the environment's Azure network node, which owns the resource group, but the graph has none in this region (expansion derives a network only when something needs one; nothing else owns the resource group).",
    node.address
  );
}

/** Dependencies of `node` (by `dependsOn`) whose node satisfies `pick`. */
export function dependencies(node: ResourceNode, ctx: CompileContext, pick: (n: ResourceNode) => boolean): ResourceNode[] {
  const out: ResourceNode[] = [];
  for (const d of node.dependsOn) {
    const n = ctx.node(d);
    if (n && pick(n)) out.push(n);
  }
  return out;
}

/** Normalize a config value the manifest may carry as string/number/boolean. */
export function configString(node: ResourceNode, key: string): string | undefined {
  const c = node.spec.config;
  if (c && typeof c === "object" && key in (c as Record<string, unknown>)) {
    const v = (c as Record<string, unknown>)[key];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  }
  return undefined;
}

export const configBool = (node: ResourceNode, key: string): boolean | undefined => {
  const v = configString(node, key);
  return v === undefined ? undefined : v === "true" || v === "1";
};
