/**
 * Small helpers every OCI driver shares: ownership handling, spec guards and
 * the "unsupported" driver factory. Kept separate from `naming.ts` (pure
 * strings) because these read nodes.
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { OciCompileError, OciUnsupportedError } from "../errors";
import { ociCapabilities, ociDriverId } from "../evidence";
import { tfLabel } from "../naming";
import type { OciSession } from "../transport";

/** Zenith reads referenced / external nodes and never mutates them: nothing to declare. */
export const isManaged = (node: ResourceNode): boolean => node.ownership === "managed";
export const readOnlyFragment = (): TofuFragment => ({ addresses: [] });

/** The spec as a typed shape; the caller names the contract type from `@/lib/resources/specs`. */
export const specOf = <T>(node: ResourceNode): T => node.spec as unknown as T;

const CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

/** IPv4 CIDR shape check (octets 0-255, prefix 0-32). */
export function assertCidr(node: ResourceNode, cidr: unknown, what = "cidr"): string {
  const m = typeof cidr === "string" ? CIDR.exec(cidr) : null;
  if (!m || m.slice(1, 5).some((o) => Number(o) > 255) || Number(m[5]) > 32) throw new OciCompileError(`${node.address}: ${what} "${String(cidr)}" is not an IPv4 CIDR.`);
  return cidr as string;
}

export function assertPort(node: ResourceNode, port: unknown): number {
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new OciCompileError(`${node.address}: port ${String(port)} is not in 1..65535.`);
  return port;
}

/** deletion_protection equivalent: OCI resources have no flag, so stateful ones get `prevent_destroy` unless the spec allows deletion. */
export const protectFromDestroy = (spec: { deletionPolicy?: string }): { lifecycle?: { prevent_destroy: true } } => (spec.deletionPolicy === "allow" ? {} : { lifecycle: { prevent_destroy: true } });

/** Sorted, de-duplicated addresses: the fragment's ownership list, primary first. */
export function addressList(primary: string, rest: string[]): string[] {
  return [primary, ...[...new Set(rest)].filter((a) => a !== primary).sort()];
}

export const res = (type: string, node: ResourceNode, suffix = ""): { label: string; address: string } => {
  const label = `${tfLabel(node.address)}${suffix}`;
  return { label, address: `${type}.${label}` };
};

/**
 * A driver for a native type OCI (or this workstream) cannot honestly realize.
 * It is REGISTERED so `findDriver` answers with the reason instead of "no
 * driver"; every operation is off and `compile` throws `OciUnsupportedError`.
 */
export function unsupportedDriver(nativeType: string, kind: ResourceDriver["kind"], reason: string): ResourceDriver<OciSession> {
  return {
    id: ociDriverId(nativeType),
    provider: "oci",
    kind,
    nativeType,
    capabilities: ociCapabilities({}),
    compile(node: ResourceNode, _ctx: CompileContext): TofuFragment {
      throw new OciUnsupportedError(`${node.address}: ${nativeType} is not supported by the OCI drivers. ${reason}`);
    },
  };
}
