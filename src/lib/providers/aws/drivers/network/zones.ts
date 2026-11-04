/**
 * Zone letters and subnet addresses for the network drivers.
 *
 * A subnet spec carries a zone LETTER (`a`, `b`, `c`); the provider zone it
 * lands in is decided at apply time from the region's available zones
 * (`data.aws_availability_zones`, sorted by name) and indexed by letter:
 * a → 0, b → 1, c → 2. That is deterministic per account and region, and it
 * is valid where AWS hides a letter from an account (new accounts in
 * us-west-1 see only `a` and `c`: letter `b` is then the second zone, `c`).
 *
 * `subnetAddress` reproduces graph expansion's address convention
 * (`subnet/public-a` in the default network `network/main`, and
 * `subnet/<provider>-<region>-public-a` in `network/<provider>-<region>`). It is
 * only ever used together with `ctx.node()` verification, so a graph that
 * names its subnets differently fails loudly at compile time instead of
 * routing the wrong subnet.
 */
import type { CompileContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { SubnetSpec } from "@/lib/resources/specs";
import { DriverCompileError } from "../shared";

/** AWS regions have at most six zones (us-east-1). */
export const ZONE_LETTERS = ["a", "b", "c", "d", "e", "f"] as const;

export function zoneIndex(letter: unknown): number | undefined {
  const i = typeof letter === "string" ? (ZONE_LETTERS as readonly string[]).indexOf(letter) : -1;
  return i < 0 ? undefined : i;
}

export function zoneLetters(count: number): string[] {
  return ZONE_LETTERS.slice(0, Math.max(0, Math.min(count, ZONE_LETTERS.length)));
}

export function subnetAddress(networkAddress: string, tier: SubnetSpec["tier"], zone: string): string {
  const key = networkAddress.startsWith("network/") ? networkAddress.slice("network/".length) : networkAddress;
  const prefix = key === "main" ? "" : `${key}-`;
  return `subnet/${prefix}${tier}-${zone}`;
}

/** The subnet node of `tier` in `zone` of the network, verified through `ctx.node`; throws when the graph has none. */
export function requireSubnet(ctx: Pick<CompileContext, "node">, owner: string, networkAddress: string, tier: SubnetSpec["tier"], zone: string): ResourceNode {
  const address = subnetAddress(networkAddress, tier, zone);
  const n = ctx.node(address);
  const spec = n?.spec as Partial<SubnetSpec> | undefined;
  if (!n || n.kind !== "subnet" || spec?.network !== networkAddress || spec?.tier !== tier || spec?.zone !== zone) {
    throw new DriverCompileError("missing_node", owner, `expected ${tier} subnet ${address} (zone ${zone}) of ${networkAddress} in the graph, but it is not there.`);
  }
  return n;
}
