import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";

export const WEBHOOK_POLICY_TIMEOUT_MS = 10_000;
export const WEBHOOK_RESPONSE_MAX_BYTES = 64 * 1024;

export type WebhookPolicyFailure = "invalid" | "blocked" | "dns" | "timeout";

/** A safe, user-facing failure; target and resolver details are never included. */
export class WebhookPolicyError extends Error {
  constructor(message: string, readonly kind: WebhookPolicyFailure) {
    super(message);
    this.name = "WebhookPolicyError";
  }
}

export type ResolveAll = (hostname: string, signal: AbortSignal) => Promise<readonly string[]>;

/** The exact address selected for the outbound connection after validation. */
export interface ResolvedWebhookTarget {
  url: URL;
  address: string;
}

/** Injectable only for deterministic tests; production uses a fresh Resolver. */
export const WEBHOOK_POLICY: { resolveAll: ResolveAll } = { resolveAll: resolveAllDns };

/** Parse and validate the parts of a target that do not require DNS. */
function parseWebhookTarget(target: string): URL {
  const raw = target.trim();
  if (!raw || /[\u0000-\u001f\u007f\s]/.test(raw))
    throw new WebhookPolicyError("The alert endpoint must be a complete https:// URL without whitespace.", "invalid");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookPolicyError("The alert endpoint is not a valid URL. Paste the full https:// endpoint.", "invalid");
  }
  if (url.protocol !== "https:")
    throw new WebhookPolicyError("Alert endpoints must use https://; plaintext http:// endpoints are not allowed.", "invalid");
  if (url.username || url.password)
    throw new WebhookPolicyError("Alert endpoints must not contain embedded username or password information.", "invalid");
  if (url.hash)
    throw new WebhookPolicyError("Alert endpoints must not contain a URL fragment.", "invalid");

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const normalizedHostname = hostname.replace(/\.$/, "");
  if (!normalizedHostname || normalizedHostname === "localhost" || normalizedHostname.endsWith(".localhost"))
    throw new WebhookPolicyError("This alert endpoint resolves to a local hostname, which is not allowed.", "blocked");
  const parsedIp = parseAddress(hostname);
  if (parsedIp && blockedCategory(parsedIp))
    throw new WebhookPolicyError("The alert endpoint resolves to a restricted network destination and was blocked.", "blocked");
  return url;
}

/** Synchronous validation used by channel actions; DNS is checked at send time. */
export function webhookTargetInputProblem(target: string): string | undefined {
  try {
    parseWebhookTarget(target);
    return undefined;
  } catch (error) {
    return webhookTargetProblem(error);
  }
}

/** Validate HTTPS and every currently resolved destination before a POST. */
export async function validateWebhookTarget(
  target: string,
  options: { signal?: AbortSignal; resolveAll?: ResolveAll } = {}
): Promise<URL> {
  return (await resolveWebhookTarget(target, options)).url;
}

/**
 * Validate and select the address used for delivery. The delivery transport
 * must use this address rather than resolving the hostname a second time;
 * otherwise DNS rebinding can turn a successful policy check into an SSRF.
 */
export async function resolveWebhookTarget(
  target: string,
  options: { signal?: AbortSignal; resolveAll?: ResolveAll } = {}
): Promise<ResolvedWebhookTarget> {
  const url = parseWebhookTarget(target);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  const signal = options.signal ?? AbortSignal.timeout(WEBHOOK_POLICY_TIMEOUT_MS);
  if (signal.aborted) throw timeoutFailure();
  const parsedIp = parseAddress(hostname);
  const addresses = parsedIp ? [parsedIp] : await resolveWithSafeErrors(hostname, signal, options.resolveAll);
  for (const address of addresses) {
    if (blockedCategory(address))
      throw new WebhookPolicyError("The alert endpoint resolves to a restricted network destination and was blocked.", "blocked");
  }
  return { url, address: addresses[0] };
}

export function webhookTargetProblem(error: unknown): string {
  if (error instanceof WebhookPolicyError) return error.message;
  return "The alert endpoint could not be validated safely. Check the URL and DNS configuration.";
}

function timeoutFailure(): WebhookPolicyError {
  return new WebhookPolicyError("The alert endpoint could not be validated within 10s. Check DNS and network access.", "timeout");
}

async function resolveWithSafeErrors(hostname: string, signal: AbortSignal, override?: ResolveAll): Promise<readonly string[]> {
  try {
    const result = await (override ?? WEBHOOK_POLICY.resolveAll)(hostname, signal);
    if (signal.aborted) throw timeoutFailure();
    if (!result.length) throw new Error("no addresses");
    return result;
  } catch (error) {
    if (error instanceof WebhookPolicyError) throw error;
    if (signal.aborted) throw timeoutFailure();
    throw new WebhookPolicyError("The alert endpoint's hostname did not resolve to a usable address.", "dns");
  }
}

async function resolveAllDns(hostname: string, signal: AbortSignal): Promise<readonly string[]> {
  const resolver = new Resolver();
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const answers = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    if (signal.aborted) throw timeoutFailure();
    const addresses = answers.flatMap((answer) => (answer.status === "fulfilled" ? answer.value : []));
    if (!addresses.length) throw new Error("no addresses");
    return addresses;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function parseAddress(address: string): string | undefined {
  if (isIP(address) === 4 || isIP(address) === 6) return address.toLowerCase();
  return undefined;
}

function ipv4Parts(address: string): number[] | undefined {
  const pieces = address.split(".");
  const parts = pieces.map(Number);
  return parts.length === 4 && parts.every((n, i) => Number.isInteger(n) && n >= 0 && n <= 255 && pieces[i] === String(n)) ? parts : undefined;
}

function ipv4Category(parts: number[]): string | undefined {
  const [a, b, c, d] = parts;
  if (a === 127) return "loopback";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
  if (a === 0 || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && c === 0)) return "reserved";
  if (a === 169 && b === 254) return "link-local";
  if (a === 100 && b === 100 && c === 100 && d === 200) return "metadata";
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return "documentation";
  if (a === 198 && b >= 18 && b <= 19) return "reserved";
  if (a >= 224) return "multicast/reserved";
  return undefined;
}

function ipv6Value(address: string): bigint | undefined {
  const lower = address.toLowerCase();
  const dotted = lower.includes(".") ? lower.slice(lower.lastIndexOf(":") + 1) : undefined;
  let source = lower;
  if (dotted) {
    const parts = ipv4Parts(dotted);
    if (!parts) return undefined;
    const [a, b, c, d] = parts;
    source = `${lower.slice(0, lower.lastIndexOf(":"))}:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
  return [...left, ...Array.from({ length: missing }, () => "0"), ...right].map((x) => parseInt(x, 16)).reduce((value, word) => (value << 16n) | BigInt(word), 0n);
}

function prefix(value: bigint, bits: number): bigint {
  return value >> BigInt(128 - bits);
}

function blockedCategory(address: string): string | undefined {
  const v4 = ipv4Parts(address);
  if (v4) return ipv4Category(v4);
  const v6 = ipv6Value(address);
  if (v6 === undefined) return "invalid";
  if (v6 === 1n) return "loopback";
  if (v6 === 0n) return "reserved";
  // IPv4-mapped IPv6 addresses carry the IPv4 value in their low 32 bits.
  if (prefix(v6, 96) === 0xffffn) {
    const mapped = Number(v6 & 0xffffffffn);
    return ipv4Category([(mapped >>> 24) & 0xff, (mapped >>> 16) & 0xff, (mapped >>> 8) & 0xff, mapped & 0xff]) ?? "mapped";
  }
  if (prefix(v6, 7) === 0x7en) return "private";
  if (prefix(v6, 10) === 0x3fan) return "link-local";
  if (prefix(v6, 8) === 0xffn) return "multicast";
  if (prefix(v6, 32) === 0x20010db8n) return "documentation";
  if (prefix(v6, 32) === 0x20010000n) return "reserved";
  return undefined;
}
