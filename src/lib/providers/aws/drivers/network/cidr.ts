/**
 * IPv4 CIDR parsing for the network drivers. Pure; rejects anything that is not
 * a canonical `a.b.c.d/n` (four decimal octets without leading zeros, prefix
 * 0–32, host bits zero) so a manifest string can never reach a tofu attribute
 * as something other than an address range.
 */

export interface Cidr {
  /** network address as an unsigned 32-bit integer */
  base: number;
  prefix: number;
}

const OCTET = "(0|[1-9][0-9]{0,2})";
const CIDR = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}/(0|[1-9][0-9]?)$`);

/** Parse a canonical IPv4 CIDR; `undefined` for anything else (including non-zero host bits). */
export function parseCidr(value: unknown): Cidr | undefined {
  if (typeof value !== "string") return undefined;
  const m = CIDR.exec(value);
  if (!m) return undefined;
  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  const prefix = Number(m[5]);
  if (octets.some((o) => o > 255) || prefix > 32) return undefined;
  const base = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  if ((base & mask) >>> 0 !== base) return undefined;
  return { base, prefix };
}

/** True when `inner` lies entirely within `outer`. */
export function cidrContains(outer: Cidr, inner: Cidr): boolean {
  if (inner.prefix < outer.prefix) return false;
  const mask = outer.prefix === 0 ? 0 : (0xffffffff << (32 - outer.prefix)) >>> 0;
  return ((inner.base & mask) >>> 0) === outer.base;
}

const RFC1918: Cidr[] = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"].map((c) => parseCidr(c) as Cidr);

/** True when the whole range lies inside RFC 1918 private space. */
export function isPrivateCidr(cidr: Cidr): boolean {
  return RFC1918.some((r) => cidrContains(r, cidr));
}

export function formatCidr(c: Cidr): string {
  const o = [(c.base >>> 24) & 255, (c.base >>> 16) & 255, (c.base >>> 8) & 255, c.base & 255];
  return `${o.join(".")}/${c.prefix}`;
}

/** Whether two ranges share any address. */
export function cidrsOverlap(a: Cidr, b: Cidr): boolean {
  return cidrContains(a, b) || cidrContains(b, a);
}
