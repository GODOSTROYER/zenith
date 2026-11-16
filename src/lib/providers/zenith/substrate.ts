/**
 * The Zenith-managed SUBSTRATE: everything about the platform's own cluster and
 * services that is configuration, not code. One function reads it
 * (`readSubstrateConfig`), from `ZENITH_MANAGED_*` variables; nothing else in
 * this provider reads the environment.
 *
 * Invariants:
 *   - Credentials are REFERENCES. The kubeconfig, the database API key and the
 *     object-storage credential are each a `vault:` reference resolved at call
 *     time by an injected resolver. A value that looks inline (a PEM block, a
 *     kubeconfig document, a newline) is refused by name, never stored.
 *   - Fail closed and loud. A missing REQUIRED value makes the substrate
 *     `configured: false` and names every missing variable. A present but
 *     malformed value makes it `configured: false` and names the variable and
 *     the problem; it never starts half-configured on a bad value.
 *   - OPTIONAL components (registry, object storage, managed database) that are
 *     simply absent are absent: their drivers answer `unavailable` with the
 *     variables to set.
 *   - No value read here is ever logged; `describeSubstrate` reports presence
 *     and non-secret shape only.
 *
 * Hostnames: `<service>.<environment-slug>.<workspace-slug>.<base domain>`.
 * TLS: the platform TLS lifecycle renders a wildcard Certificate and Gateway
 * per `*.<env>.<workspace>.<domain>` zone. The operator still configures DNS-01
 * on the ClusterIssuer and provisions DNS; issuance is not proven by apply.
 */
import { createHash } from "node:crypto";
import type { KubernetesConnectionConfig } from "@/lib/credentials/types";
import { isRuntimeClassName, normalizeFqdnRules, type FqdnEngine, type IsolationProfile } from "./isolation-profile";
import { ZenithError, type ZenithTenant } from "./types";

/* --------------------------------- shapes --------------------------------- */

export interface EgressRule {
  cidr: string;
  port: number;
}

export type GatewayMode = "gateway_api" | "ingress";

export interface ZenithSubstrate {
  /** label reported as the driver context's `region` */
  region: string;
  cluster: {
    /** API server URL (https) */
    server: string;
    /** base64 PEM CA bundle; not secret */
    caData?: string;
    /** `vault:` reference to a service-account token or kubeconfig; never inline */
    kubeconfigRef: string;
  };
  /** registrable-ish base domain for app hostnames, e.g. `apps.example.com` */
  baseDomain: string;
  gateway: {
    mode: GatewayMode;
    /** GatewayClass every environment Gateway uses; installed by the operator */
    className: string;
    /** namespace of the platform Gateway, and the only namespace tenants accept ingress from */
    namespace: string;
    /** Naming prefix for per-environment Gateways (not a shared route parent). */
    name: string;
    /** HTTPS listener name on each environment Gateway (default https); always attached explicitly */
    listener?: string;
    /** required when `mode` is `ingress` */
    ingressClass?: string;
  };
  certManager: {
    /** ClusterIssuer the platform certificates use (DNS-01, for the wildcard of each managed zone) */
    clusterIssuer: string;
    /** ACME HTTP-01 ClusterIssuer for verified custom domains (PROD-MAN-03); absent = custom domains are not served */
    httpClusterIssuer?: string;
  };
  /** CIDRs tenants must never reach on 443 (pod/service ranges beyond the private defaults) */
  internalCidrs: string[];
  registry?: {
    host: string;
    /** path prefix under the host, no leading or trailing slash; may be empty */
    repositoryPrefix: string;
  };
  objectStorage?: {
    endpoint: string;
    bucket: string;
    /** key prefix under which every tenant prefix lives, no slashes at the ends */
    prefixRoot: string;
    region?: string;
    /** `vault:` reference to the platform's credential; never per-tenant (see drivers/data/object-store.ts) */
    credentialRef?: string;
    /**
     * Per-tenant scoped credentials (PROD-MAN-03): the IAM-compatible endpoint the platform creates one principal per
     * tenant object store on (absent = the AWS IAM default endpoint) and the `vault:` reference of the IAM-ADMIN credential
     * that may do so. Without the admin reference the object store stays unavailable; tenants never receive the platform
     * credential above.
     */
    iamEndpoint?: string;
    adminCredentialRef?: string;
    /**
     * Brokered revocation (PROD-MAN-03): `<workspaceId>/<connectionId>` of an AWS provider connection in the operator workspace
     * whose session may delete tenant access keys. The durable job reaches the platform credential only through the credential
     * broker with it (custody modes and revocation honoured); without it owed revocations raise an operator alert.
     */
    adminConnection?: { workspaceId: string; connectionId: string };
  };
  database?: {
    provider: "neon";
    apiBase: string;
    /** `vault:` reference to the Neon API key, resolved at call time */
    apiKeyRef: string;
    /** Neon region id, e.g. `aws-us-east-2` */
    regionId: string;
    orgId?: string;
    /** (cidr, port) pairs tenants with a managed database may reach; empty = none (fail closed) */
    egress: EgressRule[];
  };
  /** tenant isolation decisions beyond the baseline (hostname egress, sandbox runtime, per-tenant operator credentials); absent means the baseline alone */
  isolation?: IsolationProfile;
}

export type SubstrateConfig =
  | { configured: true; substrate: ZenithSubstrate; warnings: string[] }
  | { configured: false; missing: string[]; invalid: { variable: string; problem: string }[]; message: string };

export type ZenithEnv = Readonly<Record<string, string | undefined>>;

/** Every variable the substrate reads, in the order docs list them. Pinned by a test so docs and code agree. */
export const SUBSTRATE_ENV_VARS = [
  "ZENITH_MANAGED_REGION",
  "ZENITH_MANAGED_CLUSTER_SERVER",
  "ZENITH_MANAGED_CLUSTER_CA_DATA",
  "ZENITH_MANAGED_KUBECONFIG_REF",
  "ZENITH_MANAGED_APP_DOMAIN",
  "ZENITH_MANAGED_GATEWAY_MODE",
  "ZENITH_MANAGED_GATEWAY_CLASS",
  "ZENITH_MANAGED_GATEWAY_NAMESPACE",
  "ZENITH_MANAGED_GATEWAY_NAME",
  "ZENITH_MANAGED_GATEWAY_LISTENER",
  "ZENITH_MANAGED_INGRESS_CLASS",
  "ZENITH_MANAGED_CLUSTER_ISSUER",
  "ZENITH_MANAGED_HTTP_CLUSTER_ISSUER",
  "ZENITH_MANAGED_INTERNAL_CIDRS",
  "ZENITH_MANAGED_REGISTRY",
  "ZENITH_MANAGED_OBJECT_STORAGE_ENDPOINT",
  "ZENITH_MANAGED_OBJECT_STORAGE_BUCKET",
  "ZENITH_MANAGED_OBJECT_STORAGE_PREFIX",
  "ZENITH_MANAGED_OBJECT_STORAGE_REGION",
  "ZENITH_MANAGED_OBJECT_STORAGE_CREDENTIAL_REF",
  "ZENITH_MANAGED_OBJECT_STORAGE_IAM_ENDPOINT",
  "ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CREDENTIAL_REF",
  "ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CONNECTION",
  "ZENITH_MANAGED_DB_PROVIDER",
  "ZENITH_MANAGED_DB_API_BASE",
  "ZENITH_MANAGED_DB_API_KEY_REF",
  "ZENITH_MANAGED_DB_REGION",
  "ZENITH_MANAGED_DB_ORG_ID",
  "ZENITH_MANAGED_DB_EGRESS",
  "ZENITH_MANAGED_FQDN_ENGINE",
  "ZENITH_MANAGED_EGRESS_FQDNS",
  "ZENITH_MANAGED_RUNTIME_CLASS",
  "ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX",
] as const;

export const DEFAULT_NEON_API_BASE = "https://console.neon.tech/api/v2";

/* ------------------------------- validators -------------------------------- */

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const DNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const VAULT_REF_RE = /^vault:[A-Za-z0-9._/-]{1,300}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** A DNS label safe to use in a tenant hostname: lowercase, no IDN prefix. */
export const isHostLabel = (s: string): boolean => DNS_LABEL_RE.test(s) && !s.startsWith("xn--");

export function isCidr(s: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(s);
  if (v4) return [v4[1], v4[2], v4[3], v4[4]].every((o) => Number(o) <= 255) && Number(v4[5]) <= 32;
  const v6 = /^([0-9a-fA-F:]{2,39})\/(\d{1,3})$/.exec(s);
  return v6 !== null && v6[1].includes(":") && Number(v6[2]) <= 128;
}

const METADATA_HOSTS = /^(169\.254\.|\[?fe80:|\[?fd00:ec2:|0\.0\.0\.0$|\[::\]$)/i;

function httpsUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password) return undefined;
  const host = url.hostname.toLowerCase();
  if (host === "metadata.google.internal" || host.endsWith(".internal") || METADATA_HOSTS.test(host)) return undefined;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

const looksInline = (v: string): boolean => /[\r\n]/.test(v) || /-----BEGIN /.test(v) || /^\s*(apiVersion|kind|clusters)\s*:/m.test(v);

/* --------------------------------- reader ---------------------------------- */

class Reader {
  readonly missing: string[] = [];
  readonly invalid: { variable: string; problem: string }[] = [];
  readonly warnings: string[] = [];
  constructor(private readonly env: ZenithEnv) {}

  raw(name: string): string | undefined {
    const v = this.env[name];
    return v === undefined || v.trim() === "" ? undefined : v.trim();
  }

  fail(variable: string, problem: string): undefined {
    this.invalid.push({ variable, problem });
    return undefined;
  }

  require(name: string): string | undefined {
    const v = this.raw(name);
    if (v === undefined) this.missing.push(name);
    return v;
  }

  ref(name: string, required: boolean): string | undefined {
    const v = required ? this.require(name) : this.raw(name);
    if (v === undefined) return undefined;
    if (looksInline(v)) return this.fail(name, "looks like an inline credential; provide a vault: reference (vault:<path>), never the value");
    if (!VAULT_REF_RE.test(v)) return this.fail(name, "must be a vault: reference such as vault:zenith-managed/kubeconfig");
    return v;
  }

  url(name: string, required: boolean, fallback?: string): string | undefined {
    const v = required ? this.require(name) : (this.raw(name) ?? fallback);
    if (v === undefined) return undefined;
    const ok = httpsUrl(v);
    return ok ?? this.fail(name, "must be an https URL without credentials, and not a metadata or link-local address");
  }

  label(name: string, fallback: string): string {
    const v = this.raw(name) ?? fallback;
    if (!DNS_LABEL_RE.test(v)) {
      this.fail(name, "must be a DNS-1123 label (lowercase letters, digits and '-', at most 63 characters)");
      return fallback;
    }
    return v;
  }

  list(name: string): string[] {
    const v = this.raw(name);
    return v === undefined ? [] : v.split(",").map((s) => s.trim()).filter(Boolean);
  }
}

function parseEgress(r: Reader, name: string): EgressRule[] {
  const out: EgressRule[] = [];
  for (const entry of r.list(name)) {
    const i = entry.lastIndexOf(":");
    const cidr = i === -1 ? "" : entry.slice(0, i);
    const port = i === -1 ? Number.NaN : Number(entry.slice(i + 1));
    if (!isCidr(cidr) || !Number.isInteger(port) || port < 1 || port > 65535) {
      r.fail(name, `entry "${entry.slice(0, 60)}" must be <cidr>:<port>, for example 203.0.113.0/24:5432`);
      continue;
    }
    out.push({ cidr, port });
  }
  return out;
}

function parseRegistry(r: Reader): ZenithSubstrate["registry"] {
  const v = r.raw("ZENITH_MANAGED_REGISTRY");
  if (v === undefined) return undefined;
  const [host, ...rest] = v.split("/");
  const prefix = rest.join("/");
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(host) || !/^([a-z0-9._-]+(\/[a-z0-9._-]+)*)?$/.test(prefix)) {
    return r.fail("ZENITH_MANAGED_REGISTRY", "must be <host>[:port][/<repository-prefix>], lowercase, no scheme");
  }
  return { host, repositoryPrefix: prefix };
}

function parseObjectStorage(r: Reader): ZenithSubstrate["objectStorage"] {
  const endpointRaw = r.raw("ZENITH_MANAGED_OBJECT_STORAGE_ENDPOINT");
  const bucketRaw = r.raw("ZENITH_MANAGED_OBJECT_STORAGE_BUCKET");
  if (endpointRaw === undefined && bucketRaw === undefined) return undefined;
  const endpoint = r.url("ZENITH_MANAGED_OBJECT_STORAGE_ENDPOINT", true);
  const bucket = r.require("ZENITH_MANAGED_OBJECT_STORAGE_BUCKET");
  if (bucket !== undefined && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) r.fail("ZENITH_MANAGED_OBJECT_STORAGE_BUCKET", "is not a valid bucket name");
  const prefixRoot = (r.raw("ZENITH_MANAGED_OBJECT_STORAGE_PREFIX") ?? "tenants").replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(prefixRoot) || prefixRoot.split("/").includes("..")) r.fail("ZENITH_MANAGED_OBJECT_STORAGE_PREFIX", "must be a plain key prefix without '..'");
  const region = r.raw("ZENITH_MANAGED_OBJECT_STORAGE_REGION");
  const credentialRef = r.ref("ZENITH_MANAGED_OBJECT_STORAGE_CREDENTIAL_REF", false);
  const iamEndpoint = r.url("ZENITH_MANAGED_OBJECT_STORAGE_IAM_ENDPOINT", false);
  const adminCredentialRef = r.ref("ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CREDENTIAL_REF", false);
  const connRaw = r.raw("ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CONNECTION");
  const connMatch = connRaw === undefined ? undefined : /^([A-Za-z0-9_-]{1,100})\/([A-Za-z0-9_-]{1,100})$/.exec(connRaw);
  if (connRaw !== undefined && !connMatch) r.fail("ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CONNECTION", "must be <workspaceId>/<connectionId>");
  const adminConnection = connMatch ? { workspaceId: connMatch[1], connectionId: connMatch[2] } : undefined;
  if (endpoint === undefined || bucket === undefined) return undefined;
  return { endpoint, bucket, prefixRoot, ...(adminConnection ? { adminConnection } : {}), ...(region ? { region } : {}), ...(credentialRef ? { credentialRef } : {}), ...(iamEndpoint ? { iamEndpoint } : {}), ...(adminCredentialRef ? { adminCredentialRef } : {}) };
}

function parseDatabase(r: Reader): ZenithSubstrate["database"] {
  const provider = r.raw("ZENITH_MANAGED_DB_PROVIDER");
  if (provider === undefined) return undefined;
  if (provider !== "neon") return r.fail("ZENITH_MANAGED_DB_PROVIDER", 'only "neon" has an adapter today');
  const apiBase = r.url("ZENITH_MANAGED_DB_API_BASE", false, DEFAULT_NEON_API_BASE);
  const apiKeyRef = r.ref("ZENITH_MANAGED_DB_API_KEY_REF", true);
  const regionId = r.require("ZENITH_MANAGED_DB_REGION");
  if (regionId !== undefined && !/^[a-z0-9-]{3,40}$/.test(regionId)) r.fail("ZENITH_MANAGED_DB_REGION", "must be a provider region id such as aws-us-east-2");
  const orgId = r.raw("ZENITH_MANAGED_DB_ORG_ID");
  if (orgId !== undefined && !/^[a-z0-9-]{1,60}$/.test(orgId)) r.fail("ZENITH_MANAGED_DB_ORG_ID", "must match [a-z0-9-]{1,60}");
  const egress = parseEgress(r, "ZENITH_MANAGED_DB_EGRESS");
  if (egress.length === 0) {
    r.warnings.push(
      "ZENITH_MANAGED_DB_EGRESS is empty: tenant namespaces get no network path to the managed database, so workloads cannot connect to it until an egress (cidr:port) rule is configured. A NetworkPolicy matches addresses, not hostnames."
    );
  }
  if (apiBase === undefined || apiKeyRef === undefined || regionId === undefined) return undefined;
  return { provider: "neon", apiBase, apiKeyRef, regionId, ...(orgId ? { orgId } : {}), egress };
}

function parseIsolation(r: Reader): IsolationProfile | undefined {
  const engineRaw = r.raw("ZENITH_MANAGED_FQDN_ENGINE");
  let fqdnEngine: FqdnEngine = "none";
  if (engineRaw === "none" || engineRaw === "cilium") fqdnEngine = engineRaw;
  else if (engineRaw !== undefined) r.fail("ZENITH_MANAGED_FQDN_ENGINE", 'must be "none" or "cilium"; no other CNI has a hostname policy renderer');
  let platformFqdns: string[] = [];
  const listed = r.list("ZENITH_MANAGED_EGRESS_FQDNS");
  if (listed.length > 0) {
    try {
      platformFqdns = normalizeFqdnRules(listed, "ZENITH_MANAGED_EGRESS_FQDNS");
    } catch (e) {
      r.fail("ZENITH_MANAGED_EGRESS_FQDNS", e instanceof Error ? e.message : "invalid hostname list");
    }
    if (fqdnEngine === "none") r.fail("ZENITH_MANAGED_EGRESS_FQDNS", 'needs ZENITH_MANAGED_FQDN_ENGINE=cilium: without an engine that enforces hostnames the list would be silently ignored');
  }
  const runtimeClass = r.raw("ZENITH_MANAGED_RUNTIME_CLASS");
  if (runtimeClass !== undefined && !isRuntimeClassName(runtimeClass)) r.fail("ZENITH_MANAGED_RUNTIME_CLASS", "must be a RuntimeClass name (lowercase DNS-1123)");
  const operatorCredentialPrefix = r.ref("ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX", false);
  if (operatorCredentialPrefix !== undefined && (operatorCredentialPrefix.endsWith("/") || operatorCredentialPrefix.length > 240)) {
    r.fail("ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX", "must be a vault: path prefix without a trailing slash (a per-tenant name is appended)");
  }
  if (fqdnEngine === "none" && runtimeClass === undefined && operatorCredentialPrefix === undefined) return undefined;
  return {
    fqdnEngine,
    platformFqdns,
    ...(runtimeClass ? { runtimeClass } : {}),
    ...(operatorCredentialPrefix ? { operatorCredentialPrefix } : {}),
  };
}

/**
 * Read the substrate from `env` (pass `process.env`; tests pass a plain object).
 * The ONE place `ZENITH_MANAGED_*` is interpreted.
 */
export function readSubstrateConfig(env: ZenithEnv): SubstrateConfig {
  const r = new Reader(env);
  const server = r.url("ZENITH_MANAGED_CLUSTER_SERVER", true);
  const kubeconfigRef = r.ref("ZENITH_MANAGED_KUBECONFIG_REF", true);
  const baseDomain = r.require("ZENITH_MANAGED_APP_DOMAIN");
  if (baseDomain !== undefined && (!HOST_RE.test(baseDomain) || !baseDomain.includes(".") || /^\d+(\.\d+){3}$/.test(baseDomain))) {
    r.fail("ZENITH_MANAGED_APP_DOMAIN", "must be a bare lowercase hostname with at least two labels, such as apps.example.com");
  }
  const caData = r.raw("ZENITH_MANAGED_CLUSTER_CA_DATA");
  if (caData !== undefined && (!BASE64_RE.test(caData) || looksInline(caData))) r.fail("ZENITH_MANAGED_CLUSTER_CA_DATA", "must be a base64-encoded PEM bundle");

  const modeRaw = r.raw("ZENITH_MANAGED_GATEWAY_MODE") ?? "gateway_api";
  let mode: GatewayMode = "gateway_api";
  if (modeRaw === "gateway_api" || modeRaw === "ingress") mode = modeRaw;
  else r.fail("ZENITH_MANAGED_GATEWAY_MODE", 'must be "gateway_api" or "ingress"');
  const gatewayClass = r.label("ZENITH_MANAGED_GATEWAY_CLASS", "zenith");
  const gatewayNamespace = r.label("ZENITH_MANAGED_GATEWAY_NAMESPACE", "zenith-gateway");
  const gatewayName = r.label("ZENITH_MANAGED_GATEWAY_NAME", "zenith-gateway");
  const listener = r.raw("ZENITH_MANAGED_GATEWAY_LISTENER");
  if (listener !== undefined && !DNS_LABEL_RE.test(listener)) r.fail("ZENITH_MANAGED_GATEWAY_LISTENER", "must be a DNS-1123 label");
  const ingressClass = r.raw("ZENITH_MANAGED_INGRESS_CLASS");
  if (mode === "ingress" && ingressClass === undefined) r.missing.push("ZENITH_MANAGED_INGRESS_CLASS");
  if (ingressClass !== undefined && !DNS_LABEL_RE.test(ingressClass)) r.fail("ZENITH_MANAGED_INGRESS_CLASS", "must be a DNS-1123 label");
  const clusterIssuer = r.label("ZENITH_MANAGED_CLUSTER_ISSUER", "zenith-letsencrypt-dns01");
  const httpIssuerRaw = r.raw("ZENITH_MANAGED_HTTP_CLUSTER_ISSUER");
  if (httpIssuerRaw !== undefined && !DNS_LABEL_RE.test(httpIssuerRaw)) r.fail("ZENITH_MANAGED_HTTP_CLUSTER_ISSUER", "must be a DNS-1123 label");
  const httpClusterIssuer = httpIssuerRaw !== undefined && DNS_LABEL_RE.test(httpIssuerRaw) ? httpIssuerRaw : undefined;
  const region = r.label("ZENITH_MANAGED_REGION", "zenith-managed");

  const internalCidrs = r.list("ZENITH_MANAGED_INTERNAL_CIDRS");
  for (const c of internalCidrs) if (!isCidr(c)) r.fail("ZENITH_MANAGED_INTERNAL_CIDRS", `"${c.slice(0, 60)}" is not a CIDR`);

  const registry = parseRegistry(r);
  const objectStorage = parseObjectStorage(r);
  const database = parseDatabase(r);
  const isolation = parseIsolation(r);

  if (r.missing.length > 0 || r.invalid.length > 0 || server === undefined || kubeconfigRef === undefined || baseDomain === undefined) {
    const parts: string[] = [];
    if (r.missing.length > 0) parts.push(`missing: ${r.missing.join(", ")}`);
    if (r.invalid.length > 0) parts.push(`invalid: ${r.invalid.map((i) => `${i.variable} (${i.problem})`).join("; ")}`);
    return { configured: false, missing: [...r.missing], invalid: [...r.invalid], message: `Zenith-managed hosting is not configured (${parts.join(" | ")}).` };
  }

  const substrate: ZenithSubstrate = {
    region,
    cluster: { server, ...(caData ? { caData } : {}), kubeconfigRef },
    baseDomain,
    gateway: { mode, className: gatewayClass, namespace: gatewayNamespace, name: gatewayName, ...(listener ? { listener } : {}), ...(ingressClass ? { ingressClass } : {}) },
    certManager: { clusterIssuer, ...(httpClusterIssuer ? { httpClusterIssuer } : {}) },
    internalCidrs,
    ...(registry ? { registry } : {}),
    ...(objectStorage ? { objectStorage } : {}),
    ...(database ? { database } : {}),
    ...(isolation ? { isolation } : {}),
  };
  return { configured: true, substrate, warnings: r.warnings };
}

/* --------------------------------- tenant ---------------------------------- */

const ID_RE = /^[^\u0000-\u001f\u007f]{1,200}$/;

/** Validate a tenant descriptor; throws `invalid_tenant` naming the field (never echoing long input). */
export function assertTenant(t: ZenithTenant): ZenithTenant {
  const bad = (field: string, why: string): never => {
    throw new ZenithError("invalid_tenant", `Tenant ${field} ${why}.`);
  };
  if (typeof t?.workspaceId !== "string" || !ID_RE.test(t.workspaceId)) bad("workspaceId", "must be a non-empty string of at most 200 characters without control characters");
  if (typeof t.environmentId !== "string" || !ID_RE.test(t.environmentId)) bad("environmentId", "must be a non-empty string of at most 200 characters without control characters");
  if (typeof t.workspaceSlug !== "string" || !isHostLabel(t.workspaceSlug)) bad("workspaceSlug", "must be a lowercase DNS label (letters, digits, '-')");
  if (typeof t.environmentSlug !== "string" || !isHostLabel(t.environmentSlug)) bad("environmentSlug", "must be a lowercase DNS label (letters, digits, '-')");
  if (t.planTier !== "free" && t.planTier !== "starter" && t.planTier !== "pro") bad("planTier", 'must be "free", "starter" or "pro"');
  return t;
}

/* -------------------------------- hostnames -------------------------------- */

export interface HostnameParts {
  service: string;
  environmentSlug: string;
  workspaceSlug: string;
  baseDomain: string;
}

/**
 * `<service>.<env>.<workspace-slug>.<base domain>`, validated label by label.
 * Nothing is sanitized: a label that is not a valid lowercase DNS label (or
 * that starts `xn--`) is an error, because a silently altered hostname could
 * collide with another tenant's.
 */
export function managedHostname(p: HostnameParts): string {
  const check = (what: string, v: string): void => {
    if (!isHostLabel(v)) throw new ZenithError("invalid_hostname", `${what} "${String(v).slice(0, 70)}" is not a valid DNS label for a managed hostname (lowercase letters, digits and '-', at most 63 characters, not starting with xn--).`);
  };
  check("service name", p.service);
  check("environment slug", p.environmentSlug);
  check("workspace slug", p.workspaceSlug);
  if (!HOST_RE.test(p.baseDomain) || !p.baseDomain.includes(".")) throw new ZenithError("invalid_hostname", "Base domain is not a valid hostname.");
  const host = `${p.service}.${p.environmentSlug}.${p.workspaceSlug}.${p.baseDomain}`;
  if (host.length > 253) throw new ZenithError("invalid_hostname", "The managed hostname would exceed 253 characters.");
  return host;
}

/** The suffix every hostname of this tenant ends with, leading dot included. */
export const managedHostSuffix = (t: Pick<ZenithTenant, "environmentSlug" | "workspaceSlug">, baseDomain: string): string =>
  `.${t.environmentSlug}.${t.workspaceSlug}.${baseDomain}`;

/** True only for `<one valid label><tenant suffix>`: never a wildcard, never a deeper name, never another tenant's. */
export function isManagedHost(host: string, t: Pick<ZenithTenant, "environmentSlug" | "workspaceSlug">, baseDomain: string): boolean {
  const suffix = managedHostSuffix(t, baseDomain);
  if (!host.endsWith(suffix)) return false;
  return isHostLabel(host.slice(0, host.length - suffix.length));
}

/** The service label a node address contributes to its hostname (`service/web` → `web`). */
export function serviceLabelOf(address: string): string {
  const i = address.indexOf("/");
  return (i === -1 ? address : address.slice(i + 1)).toLowerCase();
}

/* ----------------------------- object storage ------------------------------ */

const safeSegment = (id: string): string =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes("..") ? id : `~${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;

/**
 * The object-store location reserved for one tenant: the shared bucket and the
 * key prefix `<prefixRoot>/<workspace>/<environment>/`. A derivation only: no
 * driver hands out credentials for it yet (see drivers/data/object-store.ts).
 */
export function tenantObjectPrefix(t: Pick<ZenithTenant, "workspaceId" | "environmentId">, substrate: ZenithSubstrate): { bucket: string; prefix: string } | undefined {
  const os = substrate.objectStorage;
  if (!os) return undefined;
  return { bucket: os.bucket, prefix: `${os.prefixRoot}/${safeSegment(t.workspaceId)}/${safeSegment(t.environmentId)}/` };
}

/* ------------------------- kubernetes connection ---------------------------- */

/**
 * The connection config the Kubernetes provider's `createKubernetesSession`
 * turns into a session for ONE tenant: server, CA, the vault reference to the
 * credential, and a namespace allowlist of exactly the tenant namespace. The
 * credential itself never appears here.
 */
export function substrateConnectionConfig(substrate: ZenithSubstrate, tenantNamespaceName: string): KubernetesConnectionConfig {
  return {
    provider: "kubernetes",
    mode: "kubeconfig_ref",
    server: substrate.cluster.server,
    ...(substrate.cluster.caData ? { caData: substrate.cluster.caData } : {}),
    // with a per-tenant prefix the session holds THIS tenant's operator credential, never the platform-wide one
    credentialRef: substrate.isolation?.operatorCredentialPrefix ? `${substrate.isolation.operatorCredentialPrefix}/${tenantNamespaceName}` : substrate.cluster.kubeconfigRef,
    namespaces: [tenantNamespaceName],
  };
}

/* ------------------------------- description ------------------------------- */

export interface SubstrateDescription {
  configured: boolean;
  components: Record<"cluster" | "gateway" | "registry" | "objectStorage" | "managedDatabase", { state: "configured" | "not_configured" | "invalid"; detail: string }>;
  warnings: string[];
}

/** Presence and non-secret shape only; safe for status pages and logs. */
export function describeSubstrate(cfg: SubstrateConfig): SubstrateDescription {
  if (!cfg.configured) {
    const vars = new Set([...cfg.missing, ...cfg.invalid.map((i) => i.variable)]);
    const component = (prefixes: string[]): SubstrateDescription["components"]["cluster"] => {
      const hit = [...vars].filter((v) => prefixes.some((p) => v.startsWith(p)));
      return hit.length === 0 ? { state: "not_configured", detail: "not configured" } : { state: "invalid", detail: `fix: ${hit.join(", ")}` };
    };
    return {
      configured: false,
      components: {
        cluster: component(["ZENITH_MANAGED_CLUSTER_", "ZENITH_MANAGED_KUBECONFIG", "ZENITH_MANAGED_APP_DOMAIN"]),
        gateway: component(["ZENITH_MANAGED_GATEWAY", "ZENITH_MANAGED_INGRESS"]),
        registry: component(["ZENITH_MANAGED_REGISTRY"]),
        objectStorage: component(["ZENITH_MANAGED_OBJECT_STORAGE"]),
        managedDatabase: component(["ZENITH_MANAGED_DB_"]),
      },
      warnings: [cfg.message],
    };
  }
  const s = cfg.substrate;
  return {
    configured: true,
    components: {
      cluster: { state: "configured", detail: `${new URL(s.cluster.server).host}, domain ${s.baseDomain}` },
      gateway: { state: "configured", detail: s.gateway.mode === "gateway_api" ? `Gateway ${s.gateway.namespace}/${s.gateway.name}` : `Ingress class ${s.gateway.ingressClass ?? "?"}` },
      registry: s.registry ? { state: "configured", detail: s.registry.host } : { state: "not_configured", detail: "no built-image registry; only prebuilt image references run" },
      objectStorage: s.objectStorage ? { state: "configured", detail: s.objectStorage.adminCredentialRef ? `bucket ${s.objectStorage.bucket}, per-tenant scoped credentials enabled` : `bucket ${s.objectStorage.bucket} (no admin credential reference: per-tenant object stores unavailable)` } : { state: "not_configured", detail: "not configured" },
      managedDatabase: s.database ? { state: "configured", detail: `${s.database.provider} ${s.database.regionId}` } : { state: "not_configured", detail: "no managed database provider; postgres resources are unavailable" },
    },
    warnings: cfg.warnings,
  };
}
