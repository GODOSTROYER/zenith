/**
 * What an alert webhook is allowed to reach.
 *
 * Alert channels are operator-supplied URLs that this server POSTs to, which
 * makes them a server-side request forgery primitive unless the destination is
 * constrained. Two things are constrained here and nowhere else:
 *
 *  - **the URL itself** — scheme, credentials, fragment, port;
 *  - **every address the hostname currently resolves to**, so a name that
 *    answers with one public and one private address is refused rather than
 *    half-allowed. The address the caller must connect to is returned, because
 *    resolving a second time at connect is exactly the rebinding window this
 *    check exists to close (see `requestPinned` in ./deliver).
 *
 * ## Two policies, and which one a deployment gets
 *
 * The default — and the *only* policy a hosted or Postgres-backed deployment
 * can have — is strict: `https://` only, a public address only, and one of the
 * allowed ports. A local development machine may need the opposite (a receiver
 * on `http://127.0.0.1:9000`), so exactly one escape hatch exists:
 *
 *     ZENITH_ALERT_WEBHOOK_ALLOW_INSECURE=1
 *
 * It is an *acknowledgement*, not a switch: it is honoured only when this
 * process is plainly a development one — `ZENITH_HOSTED_MODE` unset, the
 * product store on files, and not a serverless instance. Set it on a hosted or
 * Postgres deployment and it is ignored, with the refusal recorded on the
 * policy object (`acknowledgementRefused`) rather than silently dropped.
 *
 * Even when it is honoured, the cloud instance-metadata addresses stay blocked:
 * nothing a developer legitimately needs lives there, and it is the single most
 * valuable target an SSRF has.
 *
 * ## Ports
 *
 * 443 and 8443 by default; an operator adds more with
 * `ZENITH_ALERT_WEBHOOK_ALLOWED_PORTS=9443,10443`. Without this, a public
 * `host:port` of the caller's choosing plus the status code Zenith reports back
 * makes this server a port scanner with an oracle attached.
 */
import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";

export const WEBHOOK_POLICY_TIMEOUT_MS = 10_000;
export const WEBHOOK_RESPONSE_MAX_BYTES = 64 * 1024;

/** The acknowledgement that relaxes the policy on a development machine. */
export const WEBHOOK_ALLOW_INSECURE_ENV = "ZENITH_ALERT_WEBHOOK_ALLOW_INSECURE";

/** The operator's additional port allowlist, comma separated. */
export const WEBHOOK_ALLOWED_PORTS_ENV = "ZENITH_ALERT_WEBHOOK_ALLOWED_PORTS";

/** Allowed without any configuration: HTTPS and the usual alternate HTTPS port. */
export const DEFAULT_WEBHOOK_PORTS: readonly number[] = [443, 8443];

export type WebhookPolicyFailure = "invalid" | "blocked" | "dns" | "timeout";

/** A safe, user-facing failure; target and resolver details are never included. */
export class WebhookPolicyError extends Error {
  constructor(message: string, readonly kind: WebhookPolicyFailure) {
    super(message);
    this.name = "WebhookPolicyError";
  }
}

/**
 * A policy failure is never retried and a resolver/timeout failure always is.
 * `deliver.ts` reads this instead of re-deriving the rule; getting it backwards
 * is what made a 30-second DNS blip a permanent delivery failure before.
 */
export const isTransientPolicyFailure = (kind: WebhookPolicyFailure): boolean =>
  kind === "dns" || kind === "timeout";

export type ResolveAll = (hostname: string, signal: AbortSignal) => Promise<readonly string[]>;

/** The exact address selected for the outbound connection after validation. */
export interface ResolvedWebhookTarget {
  url: URL;
  address: string;
}

/** Injectable only for deterministic tests; production uses a fresh Resolver. */
export const WEBHOOK_POLICY: { resolveAll: ResolveAll } = { resolveAll: resolveAllDns };

/* --------------------------------- policy --------------------------------- */

export interface WebhookEgressPolicy {
  /** `strict` is the production/hosted policy and the default everywhere. */
  mode: "strict" | "local-development";
  /** `http://` targets are accepted. Never true in `strict`. */
  allowInsecureTransport: boolean;
  /** Loopback/private/link-local destinations are accepted. Never true in `strict`. */
  allowPrivateAddresses: boolean;
  /** Ports a target may use, or `"any"` in local development. */
  allowedPorts: readonly number[] | "any";
  /**
   * Set when the acknowledgement was present and deliberately ignored, naming
   * why. Surfaced in the refusal so an operator who set it on a hosted
   * deployment learns that it did nothing.
   */
  acknowledgementRefused?: string;
}

/** An unset variable and one set to whitespace mean the same thing. */
function flag(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function operatorPorts(): number[] {
  const raw = flag(WEBHOOK_ALLOWED_PORTS_ENV);
  if (!raw) return [];
  // A typo is ignored rather than fatal: a malformed list must not take every
  // alert channel in the install offline. The effective list is named in the
  // refusal instead, so the mistake is visible the first time it matters.
  return raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65_535);
}

/**
 * The policy this process is running under. Read per call, like `env()`, so a
 * test (or a reloaded configuration) is never answered from a stale snapshot.
 */
export function webhookEgressPolicy(): WebhookEgressPolicy {
  const strict: WebhookEgressPolicy = {
    mode: "strict",
    allowInsecureTransport: false,
    allowPrivateAddresses: false,
    allowedPorts: [...new Set([...DEFAULT_WEBHOOK_PORTS, ...operatorPorts()])].sort((a, b) => a - b),
  };
  if (flag(WEBHOOK_ALLOW_INSECURE_ENV) !== "1") return strict;

  // The acknowledgement is only meaningful on a machine that is plainly a
  // development one. Each of these three, on its own, means it is not.
  const refusal =
    flag("ZENITH_HOSTED_MODE") === "1"
      ? "hosted mode is on"
      : (flag("ZENITH_STORE") ?? "file") !== "file"
        ? "the product store is PostgreSQL"
        : flag("ZENITH_SERVERLESS") === "1" || flag("VERCEL") !== undefined
          ? "this is a serverless instance"
          : undefined;
  if (refusal) return { ...strict, acknowledgementRefused: refusal };

  return {
    mode: "local-development",
    allowInsecureTransport: true,
    allowPrivateAddresses: true,
    allowedPorts: "any",
  };
}

/** What to tell the operator, without ever naming a lever that is refused. */
function policyHint(policy: WebhookEgressPolicy): string {
  if (policy.acknowledgementRefused)
    return ` ${WEBHOOK_ALLOW_INSECURE_ENV} is set but ignored because ${policy.acknowledgementRefused}.`;
  return "";
}

const portList = (policy: WebhookEgressPolicy): string =>
  policy.allowedPorts === "any" ? "any" : policy.allowedPorts.join(", ");

/* ------------------------------- URL parsing ------------------------------- */

/** Parse and validate the parts of a target that do not require DNS. */
function parseWebhookTarget(target: string, policy = webhookEgressPolicy()): URL {
  const raw = target.trim();
  if (!raw || /[\u0000-\u001f\u007f\s]/.test(raw))
    throw new WebhookPolicyError("The alert endpoint must be a complete https:// URL without whitespace.", "invalid");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookPolicyError("The alert endpoint is not a valid URL. Paste the full https:// endpoint.", "invalid");
  }
  if (url.protocol !== "https:" && !(policy.allowInsecureTransport && url.protocol === "http:"))
    throw new WebhookPolicyError(
      `Alert endpoints must use https://; plaintext http:// endpoints are not allowed. Update this channel under Settings → Alerts to an https:// endpoint.${policyHint(policy)}`,
      "blocked"
    );
  if (url.username || url.password)
    throw new WebhookPolicyError("Alert endpoints must not contain embedded username or password information.", "invalid");
  if (url.hash)
    throw new WebhookPolicyError("Alert endpoints must not contain a URL fragment.", "invalid");
  refusePort(url, policy);

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const normalizedHostname = hostname.replace(/\.$/, "");
  if (!normalizedHostname)
    throw new WebhookPolicyError("This alert endpoint resolves to a local hostname, which is not allowed.", "blocked");
  if (
    !policy.allowPrivateAddresses &&
    (normalizedHostname === "localhost" || normalizedHostname.endsWith(".localhost"))
  )
    throw new WebhookPolicyError(
      `This alert endpoint resolves to a local hostname, which is not allowed. Point this channel at a publicly reachable endpoint under Settings → Alerts.${policyHint(policy)}`,
      "blocked"
    );
  const parsedIp = parseAddress(hostname);
  if (parsedIp) refuseAddress(parsedIp, policy);
  return url;
}

/** The effective port of a target, with the scheme's default filled in. */
export function targetPort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "http:" ? 80 : 443;
}

function refusePort(url: URL, policy: WebhookEgressPolicy): void {
  if (policy.allowedPorts === "any") return;
  const port = targetPort(url);
  if (policy.allowedPorts.includes(port)) return;
  throw new WebhookPolicyError(
    `Alert endpoints may only use port ${portList(policy)}; this endpoint uses ${port}. Change the channel's port under Settings → Alerts, or add the port to ${WEBHOOK_ALLOWED_PORTS_ENV} and restart the server.`,
    "blocked"
  );
}

/**
 * Categories a development machine may opt into. Everything else — metadata
 * services, the IPv6 transition ranges, multicast, documentation prefixes —
 * stays blocked under every policy, because nothing legitimate points there.
 */
const RELAXABLE_CATEGORIES = new Set(["loopback", "private", "link-local"]);

function refuseAddress(address: string, policy: WebhookEgressPolicy): void {
  const category = blockedCategory(address);
  if (!category) return;
  if (policy.allowPrivateAddresses && RELAXABLE_CATEGORIES.has(category)) return;
  throw new WebhookPolicyError(
    `The alert endpoint resolves to a restricted network destination and was blocked. Point this channel at a publicly reachable https:// endpoint under Settings → Alerts.${policyHint(policy)}`,
    "blocked"
  );
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
  const policy = webhookEgressPolicy();
  const url = parseWebhookTarget(target, policy);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  const signal = options.signal ?? AbortSignal.timeout(WEBHOOK_POLICY_TIMEOUT_MS);
  if (signal.aborted) throw timeoutFailure();
  const parsedIp = parseAddress(hostname);
  // `localhost` is a hosts-file name, not a DNS one: a resolver lookup for it
  // usually fails outright. Answer it directly so a development receiver on
  // http://localhost:9000 works under the acknowledged policy.
  const addresses = parsedIp
    ? [parsedIp]
    : policy.allowPrivateAddresses && localHostname(hostname)
      ? ["127.0.0.1"]
      : await resolveWithSafeErrors(hostname, signal, options.resolveAll);
  for (const address of addresses) refuseAddress(address, policy);
  return { url, address: addresses[0] };
}

const localHostname = (hostname: string): boolean => {
  const normalized = hostname.replace(/\.$/, "");
  return normalized === "localhost" || normalized.endsWith(".localhost");
};

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

/* -------------------------------- addresses ------------------------------- */

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
  // The metadata services first: they are the highest-value SSRF target, and
  // they are the one thing the development acknowledgement never unblocks.
  if (a === 169 && b === 254 && c === 169 && d === 254) return "metadata";
  if (a === 100 && b === 100 && c === 100 && d === 200) return "metadata";
  if (a === 127) return "loopback";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
  if (a === 0 || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && c === 0)) return "reserved";
  if (a === 169 && b === 254) return "link-local";
  // 6to4 relay anycast: a packet to it is delivered to an arbitrary relay and
  // from there to the embedded IPv4 destination, so it is an egress bypass.
  if (a === 192 && b === 88 && c === 99) return "6to4-relay";
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

/** The IPv4 category of 32 bits embedded in an IPv6 address, for the label. */
function embeddedIpv4Category(value: bigint): string | undefined {
  const v4 = Number(value & 0xffffffffn);
  return ipv4Category([(v4 >>> 24) & 0xff, (v4 >>> 16) & 0xff, (v4 >>> 8) & 0xff, v4 & 0xff]);
}

/**
 * A transition range is refused outright, whatever it wraps.
 *
 * `64:ff9b::7f00:1` is 127.0.0.1 behind NAT64 and `2002:7f00:1::` is 127.0.0.1
 * behind 6to4 — but the embedded address is only the *usual* payload, and a
 * relay decides where the packet really goes. The returned label carries the
 * decoded IPv4 category for a reader; it is deliberately not one of
 * `RELAXABLE_CATEGORIES`, so the development acknowledgement cannot open it.
 */
const transition = (kind: string, embedded: bigint): string => {
  const inner = embeddedIpv4Category(embedded);
  return inner ? `${kind} (${inner})` : kind;
};

/** A literal's own top `bits`, so a prefix test cannot be mis-shifted by hand. */
const prefixOf = (literal: string, bits: number): bigint => prefix(ipv6Value(literal)!, bits);

/** NAT64: the well-known prefix (RFC 6052) and the local-use one (RFC 8215). */
const NAT64_WELL_KNOWN = prefixOf("64:ff9b::", 96);
const NAT64_LOCAL_USE = prefixOf("64:ff9b:1::", 48);
/** The AWS IPv6 instance-metadata address, which lives inside fc00::/7. */
const IMDS_V6 = ipv6Value("fd00:ec2::254")!;

function blockedCategory(address: string): string | undefined {
  const v4 = ipv4Parts(address);
  if (v4) return ipv4Category(v4);
  const v6 = ipv6Value(address);
  if (v6 === undefined) return "invalid";
  if (v6 === 1n) return "loopback";
  if (v6 === 0n) return "reserved";
  // IPv4-mapped IPv6 addresses carry the IPv4 value in their low 32 bits.
  if (prefix(v6, 96) === 0xffffn) return embeddedIpv4Category(v6) ?? "mapped";
  // IPv4-compatible IPv6 (`::a.b.c.d`), deprecated by RFC 4291 and still
  // routed as the embedded address by some stacks.
  if (prefix(v6, 96) === 0n) return transition("ipv4-compatible", v6);
  // IPv4-translated (RFC 2765 SIIT, `::ffff:0:a.b.c.d`) is the same smuggling shape as the compatible form.
  if (prefix(v6, 96) === 0xffff0000n) return transition("ipv4-translated", v6);
  // NAT64, both the well-known prefix and RFC 8215's local-use prefix.
  if (prefix(v6, 96) === NAT64_WELL_KNOWN) return transition("nat64", v6);
  if (prefix(v6, 48) === NAT64_LOCAL_USE) return transition("nat64", v6);
  // 6to4: the embedded IPv4 is bits 16..48, not the low 32.
  if (prefix(v6, 16) === 0x2002n) return transition("6to4", (v6 >> 80n) & 0xffffffffn);
  // The AWS IPv6 instance-metadata address sits inside fc00::/7; name it
  // explicitly so the development acknowledgement cannot open it either.
  if (v6 === IMDS_V6) return "metadata";
  if (prefix(v6, 7) === 0x7en) return "private";
  if (prefix(v6, 10) === 0x3fan) return "link-local";
  if (prefix(v6, 8) === 0xffn) return "multicast";
  if (prefix(v6, 32) === 0x20010db8n) return "documentation";
  // Teredo, 2001::/32 — a tunnelled path to an arbitrary IPv4 destination.
  if (prefix(v6, 32) === 0x20010000n) return "teredo";
  // Remaining special-purpose space is not a tenant's public endpoint either: IETF protocol assignments 2001::/23
  // (ORCHID, benchmarking), the discard prefix 100::/64, documentation 3fff::/20 and deprecated site-local fec0::/10.
  if (prefix(v6, 23) === prefixOf("2001::", 23)) return "reserved";
  if (prefix(v6, 64) === prefixOf("100::", 64)) return "reserved";
  if (prefix(v6, 20) === prefixOf("3fff::", 20)) return "documentation";
  if (prefix(v6, 10) === 0x3fbn) return "site-local";
  return undefined;
}

/** Exposed for the policy tests; never used to decide anything at run time. */
export const addressCategoryForTest = (address: string): string | undefined =>
  blockedCategory(address);
