/**
 * Where the worker may connect on a tenant's behalf. A connection string or
 * endpoint comes from the tenant's own vault, so it is attacker-influenced
 * input to a process that sits inside Zenith's network: it must never be turned
 * into a request to the cloud metadata service, loopback or an internal address.
 *
 * Public addresses are always allowed. Private ranges and loopback are allowed
 * only when the operator opts in (`ZENITH_PORTABILITY_ALLOW_PRIVATE_HOSTS=1`),
 * for a worker deployed inside the tenant's own network or for local
 * development. Link-local, unspecified and multicast are never allowed.
 *
 * Every answer must pass. Transports resolve anew for each connection and use
 * only the returned literals, preserving the original hostname for TLS identity.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import { PortabilityError } from "./types";

export type HostLookup = (host: string) => Promise<string[]>;

const defaultLookup: HostLookup = async (host) => (await dnsLookup(host, { all: true })).map((r) => r.address);

export function allowPrivateHostsFromEnv(env: Record<string, string | undefined> = process.env): boolean {
  return env.ZENITH_PORTABILITY_ALLOW_PRIVATE_HOSTS === "1";
}

function v4Parts(ip: string): number[] | null {
  const parts = ip.split(".").map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

/** Expand a valid IPv6 literal before classifying equivalent spellings. */
function v6Parts(address: string): number[] {
  let ip = address.split("%")[0]!.toLowerCase();
  if (ip.includes(".")) {
    const split = ip.lastIndexOf(":");
    const v4 = v4Parts(ip.slice(split + 1))!;
    ip = `${ip.slice(0, split)}:${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const [left, right] = ip.split("::");
  const a = left ? left.split(":").map((x) => parseInt(x, 16)) : [];
  const b = right ? right.split(":").map((x) => parseInt(x, 16)) : [];
  return right === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill(0), ...b];
}

/** Classify literals, including dotted and hexadecimal IPv4 mapped IPv6. */
export function classifyAddress(address: string): "public" | "private" | "loopback" | "never" {
  let ip = address;
  if (net.isIPv6(address)) {
    const p = v6Parts(address);
    if (p.slice(0, 5).every((n) => n === 0) && p[5] === 0xffff) {
      ip = `${p[6]! >> 8}.${p[6]! & 255}.${p[7]! >> 8}.${p[7]! & 255}`;
    }
  }
  if (net.isIPv4(ip)) {
    const p = v4Parts(ip);
    if (!p) return "never";
    const [a, b] = p as [number, number, number, number];
    if (a === 0 || a >= 224) return "never";
    if (a === 169 && b === 254) return "never";
    if (a === 127) return "loopback";
    // Alibaba Cloud instance metadata: reachable only through the private-range opt-in otherwise, and never a service.
    if (a === 100 && b === 100 && (p as number[])[2] === 100 && (p as number[])[3] === 200) return "never";
    const c = (p as number[])[2]!;
    // IETF protocol assignments, documentation and the deprecated 6to4 relay never carry a legitimate service.
    if ((a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return "never";
    // Benchmarking space is internal use: private, so only an operator opt-in reaches it.
    if (a === 198 && (b === 18 || b === 19)) return "private";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return "private";
    return "public";
  }
  if (net.isIPv6(ip)) {
    const p = v6Parts(ip);
    if (p.every((n) => n === 0) || (p[0]! & 0xff00) === 0xff00) return "never";
    if (p.slice(0, 7).every((n) => n === 0) && p[7] === 1) return "loopback";
    if ((p[0]! & 0xffc0) === 0xfe80) return "never";
    // Transition and special-purpose prefixes that smuggle an IPv4 destination past the checks above (a NAT64 or 6to4
    // literal of 169.254.169.254 or 127.0.0.1) or never name a tenant service: IPv4-compatible ::/96, IPv4-translated
    // ::ffff:0:0:0/96, NAT64 64:ff9b::/96 and 64:ff9b:1::/48, discard 100::/64, 2001::/23 (Teredo, ORCHID, documentation),
    // 6to4 2002::/16, 3fff::/20 documentation and deprecated site-local fec0::/10.
    if (p.slice(0, 6).every((n) => n === 0)) return "never";
    if (p.slice(0, 4).every((n) => n === 0) && p[4] === 0xffff && p[5] === 0) return "never";
    if (p[0] === 0x64 && p[1] === 0xff9b && (p.slice(2, 6).every((n) => n === 0) || p[2] === 1)) return "never";
    if (p[0] === 0x100 && p.slice(1, 4).every((n) => n === 0)) return "never";
    if (p[0] === 0x2001 && (p[1]! < 0x200 || p[1] === 0xdb8)) return "never";
    if (p[0] === 0x2002 || (p[0] === 0x3fff && p[1]! < 0x1000) || (p[0]! & 0xffc0) === 0xfec0) return "never";
    // The AWS IPv6 instance-metadata address lives inside fc00::/7; the private-range opt-in must not open it.
    if (p[0] === 0xfd00 && p[1] === 0xec2 && p.slice(2, 7).every((n) => n === 0) && p[7] === 0x254) return "never";
    if ((p[0]! & 0xfe00) === 0xfc00) return "private";
    return "public";
  }
  return "never";
}

const NAME_REFUSED = /(^|\.)(localhost|internal|local|localdomain)$/i;

/** Refuse a host the worker must not connect to. Never echoes a resolved address. */
export async function resolveConnectableHost(host: string, opts: { allowPrivate?: boolean; lookup?: HostLookup } = {}): Promise<readonly { address: string; family: 4 | 6 }[]> {
  const allowPrivate = opts.allowPrivate ?? allowPrivateHostsFromEnv();
  const refuse = (): never => {
    throw new PortabilityError("invalid_input", "The service host is not one the worker may connect to (loopback, private, link-local and metadata addresses are refused).");
  };
  const bare = host.replace(/^\[|\]$/g, "");
  if (bare.length === 0 || bare.length > 253) return refuse();
  const check = (kind: ReturnType<typeof classifyAddress>): void => {
    if (kind === "never") refuse();
    if ((kind === "private" || kind === "loopback") && !allowPrivate) refuse();
  };
  if (net.isIP(bare)) {
    check(classifyAddress(bare));
    return [{ address: bare, family: net.isIPv4(bare) ? 4 : 6 }];
  }
  if (NAME_REFUSED.test(bare) && !allowPrivate) return refuse();
  let addresses: string[];
  try {
    addresses = await (opts.lookup ?? defaultLookup)(bare);
  } catch {
    throw new PortabilityError("unavailable", "The service host did not resolve.");
  }
  if (addresses.length === 0) return refuse();
  for (const a of addresses) check(classifyAddress(a));
  return addresses.map((address) => ({ address, family: net.isIPv4(address) ? 4 : 6 }));
}

/** Compatibility preflight; actual transports must use the validated literals. */
export async function assertConnectableHost(host: string, opts: { allowPrivate?: boolean; lookup?: HostLookup } = {}): Promise<void> {
  await resolveConnectableHost(host, opts);
}
