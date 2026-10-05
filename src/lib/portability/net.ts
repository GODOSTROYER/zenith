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
 * Name resolution is checked, not trusted: every address a name resolves to
 * must pass. A resolver race (rebinding between this check and the connect) is
 * not closed here; that needs the connection to be made to the vetted address,
 * which the Postgres and S3 clients do not expose.
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

/** Classify one literal address. `mapped` handles ::ffff:a.b.c.d. */
export function classifyAddress(address: string): "public" | "private" | "loopback" | "never" {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const ip = mapped ? mapped[1]! : address;
  if (net.isIPv4(ip)) {
    const p = v4Parts(ip);
    if (!p) return "never";
    const [a, b] = p as [number, number, number, number];
    if (a === 0 || a >= 224) return "never";
    if (a === 169 && b === 254) return "never";
    if (a === 127) return "loopback";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return "private";
    return "public";
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower.startsWith("ff")) return "never";
    if (lower === "::1") return "loopback";
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return "never";
    if (lower.startsWith("fc") || lower.startsWith("fd")) return "private";
    return "public";
  }
  return "never";
}

const NAME_REFUSED = /(^|\.)(localhost|internal|local|localdomain)$/i;

/** Refuse a host the worker must not connect to. Never echoes a resolved address. */
export async function assertConnectableHost(host: string, opts: { allowPrivate?: boolean; lookup?: HostLookup } = {}): Promise<void> {
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
  if (net.isIP(bare)) return check(classifyAddress(bare));
  if (NAME_REFUSED.test(bare) && !allowPrivate) return refuse();
  let addresses: string[];
  try {
    addresses = await (opts.lookup ?? defaultLookup)(bare);
  } catch {
    throw new PortabilityError("unavailable", "The service host did not resolve.");
  }
  if (addresses.length === 0) return refuse();
  for (const a of addresses) check(classifyAddress(a));
}
