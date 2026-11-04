/**
 * The isolation PROFILE of a managed substrate: the platform decisions that
 * change what a tenant namespace is allowed to do, kept in one validated value
 * so the renderers, the isolation gate and the operator scripts agree.
 *
 *   fqdnEngine          how a hostname egress allowlist is enforced. A plain
 *                       Kubernetes NetworkPolicy matches addresses, not names,
 *                       so a name-based allowlist exists ONLY through a CNI that
 *                       implements it. `cilium` (CiliumNetworkPolicy toFQDNs)
 *                       is the one engine rendered. `none` means: no hostname
 *                       allowlist is possible and asking for one is refused,
 *                       never silently widened to "public 443".
 *   runtimeClass        the RuntimeClass every tenant pod must run under (for
 *                       example a gVisor or Kata class the operator installed).
 *                       Unset means the node's default runtime; a tenant can
 *                       never choose its own.
 *   operatorCredentialPrefix  vault: prefix under which one operator
 *                       credential per tenant namespace is stored, so a session
 *                       for tenant A never holds tenant B's authority.
 *
 * This module is pure: no environment, no I/O.
 */
import { ZenithError } from "./types";

export type FqdnEngine = "none" | "cilium";

export interface IsolationProfile {
  fqdnEngine: FqdnEngine;
  /** hostnames every tenant may reach on TCP 443 (registries, package mirrors); validated, sorted, unique */
  platformFqdns: string[];
  runtimeClass?: string;
  operatorCredentialPrefix?: string;
}

/** Metadata and credential endpoints no tenant may ever reach, whatever else is allowed. */
export const METADATA_ENDPOINT_CIDRS: readonly string[] = [
  "169.254.0.0/16", // link-local: AWS/GCP/Azure/OCI instance metadata, ECS task credentials
  "fe80::/10",
  "fd00:ec2::/32", // AWS IPv6 instance metadata
  "100.100.100.200/32", // Alibaba Cloud metadata
];

/** Hostnames that name internal or metadata services; refused in any FQDN rule. */
const FORBIDDEN_SUFFIXES = [".internal", ".local", ".localhost", ".svc", ".cluster.local", ".home.arpa"];
const FORBIDDEN_EXACT = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data", "kubernetes", "kubernetes.default"]);

const LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
const NAME_RE = new RegExp(`^(?=.{1,253}$)${LABEL}(\\.${LABEL})+$`);
const IPV4_LIKE = /^\d{1,3}(\.\d{1,3}){3}$/;
export const MAX_FQDN_RULES = 100;

export interface FqdnRuleCheck {
  ok: boolean;
  /** `name` is an exact host, `pattern` is `*.<suffix>` */
  kind?: "name" | "pattern";
  value?: string;
  problem?: string;
}

/**
 * One allowlist entry: an exact lowercase hostname with at least two labels, or
 * `*.<suffix>` where the suffix has at least two labels (`*.com` is refused: it
 * would be "the internet"). IP literals, ports, schemes, trailing dots, internal
 * and metadata names are refused by name.
 */
export function checkFqdnRule(raw: string): FqdnRuleCheck {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const bad = (problem: string): FqdnRuleCheck => ({ ok: false, problem });
  if (value === "") return bad("is empty");
  if (value.length > 253) return bad("is longer than 253 characters");
  if (/[\s/:@?#\\]/.test(value)) return bad("must be a bare hostname: no scheme, port, path or credentials");
  if (value.endsWith(".")) return bad("must not end with a dot");
  if (value.includes("[") || value.includes("]") || value.includes(",")) return bad("is not a hostname");
  const pattern = value.startsWith("*.");
  const body = pattern ? value.slice(2) : value;
  if (body.includes("*")) return bad("may only use a single leading *. wildcard");
  if (IPV4_LIKE.test(body)) return bad("is an IP address; an address is not a hostname (use the network CIDR allowlists)");
  if (!NAME_RE.test(body)) return bad("is not a valid DNS name with at least two labels");
  if (body.split(".").some((l) => l.startsWith("xn--"))) return bad("uses an internationalized (xn--) label; allowlist the ASCII punycode name only after review");
  if (FORBIDDEN_EXACT.has(body) || FORBIDDEN_SUFFIXES.some((s) => body.endsWith(s))) return bad("names an internal, link-local or metadata service");
  return { ok: true, kind: pattern ? "pattern" : "name", value };
}

/** Validate and normalize a list: lowercase, sorted, unique. Throws `isolation_violation` naming the first bad entry. */
export function normalizeFqdnRules(list: readonly string[], where = "egress FQDN allowlist"): string[] {
  const out = new Set<string>();
  for (const raw of list) {
    const c = checkFqdnRule(raw);
    if (!c.ok) throw new ZenithError("isolation_violation", `${where}: "${String(raw).slice(0, 80)}" ${c.problem}.`);
    out.add(c.value as string);
  }
  if (out.size > MAX_FQDN_RULES) throw new ZenithError("isolation_violation", `${where}: ${out.size} entries exceed the limit of ${MAX_FQDN_RULES}.`);
  return [...out].sort();
}

/** RuntimeClass names are DNS-1123 subdomains; refuse anything else before it reaches a pod spec. */
export const isRuntimeClassName = (s: string): boolean => /^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$/.test(s) && !s.includes("..");

/** Whether this profile enforces a hostname allowlist (and therefore drops the "any public address on 443" egress rule). */
export const usesFqdnEgress = (p: IsolationProfile | undefined): boolean => p?.fqdnEngine === "cilium";

/** Merge the platform allowlist and a tenant's requested hostnames under the profile. Refuses a request the engine cannot enforce. */
export function effectiveFqdns(profile: IsolationProfile | undefined, requested: readonly string[] | undefined): string[] {
  const asked = normalizeFqdnRules(requested ?? [], "tenant egress FQDN allowlist");
  if (!usesFqdnEgress(profile)) {
    if (asked.length > 0) {
      throw new ZenithError(
        "unsupported",
        "A hostname egress allowlist needs a CNI that enforces one (set ZENITH_MANAGED_FQDN_ENGINE=cilium on a Cilium cluster). A Kubernetes NetworkPolicy matches addresses, not names, and Zenith will not widen the request to an address range."
      );
    }
    return [];
  }
  return normalizeFqdnRules([...(profile?.platformFqdns ?? []), ...asked]);
}
