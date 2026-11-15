/**
 * Building a Kubernetes session from a stored connection (ADR-0006, ADR-0015).
 *
 * A `KubernetesConnectionConfig` holds only non-secret identifiers: the API
 * server URL, a CA bundle, a namespace allowlist and a vault REFERENCE to the
 * credential. This module resolves that reference in memory, builds a
 * `@kubernetes/client-node` `KubeConfig` and hands back a `KubernetesSession`
 * the drivers use for exactly one operation.
 *
 * Invariants:
 *   - The token is resolved through an injected function, lives only inside
 *     the returned session's private `KubeConfig`, and is never logged,
 *     serialized (`JSON.stringify`, `util.inspect` print a redacted summary) or
 *     put in an error message.
 *   - Only a bearer token or client-certificate data is accepted from a
 *     kubeconfig. `exec` plugins, `auth-provider` and file paths are REFUSED:
 *     a stored kubeconfig must never be able to make the worker run a command
 *     or read a local file. Server URL and CA always come from the connection
 *     config, never from the kubeconfig, so a credential cannot be redirected
 *     to another server.
 *   - `server` must be https (plain http only on loopback, and only when the
 *     caller opts in for dev/kind/tests) and never a link-local/metadata
 *     address. This is a floor, not an SSRF policy: egress allowlisting of
 *     private ranges belongs to the worker's network configuration.
 *   - The session refuses to hand out its `KubeConfig` after `expiresAt`.
 *   - `mode: "runner"` is refused here: runner jobs execute inside the
 *     customer's network with the runner's own identity, not in this process.
 *
 * The namespace allowlist rides on the session (`namespaces`) so every driver
 * call can enforce it (`client.ts`). A plain `KubernetesSession` without one is
 * treated as "no namespaces": only Zenith-created, labeled namespaces pass.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import { inspect } from "node:util";
import { load as yamlLoad } from "js-yaml";
import { KubeConfig } from "@kubernetes/client-node";
import type { KubernetesConnectionConfig, KubernetesSession } from "@/lib/credentials/types";
import { classifyAddress, NAME_REFUSED, type HostLookup } from "@/lib/portability/net";
import { K8sError } from "./types";

export interface KubernetesSessionDeps {
  /** vault reference → secret text (a bearer token, or a kubeconfig). Called once, in memory. */
  resolveCredential(ref: string, signal?: AbortSignal): Promise<string>;
  /** EKS: mint a short-lived API token from the AWS connection. */
  eksToken?(eks: { clusterName: string; awsConnectionId: string }, signal?: AbortSignal): Promise<{ token: string; expiresAt: string }>;
  /** `oidc_web_identity`: a token the cluster's OIDC trust accepts for this connection. */
  oidcToken?(config: KubernetesConnectionConfig, signal?: AbortSignal): Promise<{ token: string; expiresAt: string }>;
  now?(): Date;
  /** session lifetime ceiling, default 900 s, max 3600 s */
  ttlSec?: number;
  /** permit `http://` on loopback (dev, kind, tests). Never for a production connection. */
  allowInsecureLoopback?: boolean;
}

/** A `KubernetesSession` that also carries the namespace allowlist the driver layer enforces. */
export interface ScopedKubernetesSession extends KubernetesSession {
  readonly namespaces: readonly string[];
}

/** The allowlist a session carries; empty (fail closed) when it carries none. */
export function sessionNamespaces(session: KubernetesSession): readonly string[] {
  const ns = (session as Partial<ScopedKubernetesSession>).namespaces;
  return Array.isArray(ns) ? ns.filter((n): n is string => typeof n === "string") : [];
}

/* ------------------------------ server policy ------------------------------ */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isMetadataOrLinkLocal(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "metadata.google.internal" || h === "metadata" || h.endsWith(".internal")) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^\[?fe80:/i.test(h)) return true;
  if (/^\[?fd00:ec2:/i.test(h)) return true;
  return h === "0.0.0.0" || h === "[::]";
}

/** Normalize and vet the API server URL; returns it without a trailing slash. */
export function validateServerUrl(server: string, allowInsecureLoopback = false): string {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new K8sError("session_invalid", "Kubernetes server is not a valid URL.");
  }
  if (url.username || url.password) throw new K8sError("session_invalid", "Kubernetes server URL must not carry credentials.");
  if (isMetadataOrLinkLocal(url.hostname)) throw new K8sError("session_invalid", "Kubernetes server resolves to a metadata or link-local address and is refused.");
  if (url.protocol === "http:") {
    if (!(allowInsecureLoopback && LOOPBACK.has(url.hostname))) {
      throw new K8sError("session_invalid", "Kubernetes server must use https (http is allowed only on loopback for development).");
    }
  } else if (url.protocol !== "https:") {
    throw new K8sError("session_invalid", "Kubernetes server must use https.");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

/* --------------------------- tenant server policy --------------------------- */

/**
 * A tenant's API server URL is attacker-influenced input to a process inside Zenith's network. Beyond the floor in
 * `validateServerUrl`, it gets the same address classes as portability targets: metadata, link-local, special-purpose and
 * IPv4-smuggling IPv6 forms are always refused; loopback and private ranges only when the operator opts in
 * (`ZENITH_KUBERNETES_ALLOW_PRIVATE_SERVERS=1`, for a worker inside the tenant's network or a local kind cluster).
 * Operator-configured substrate clusters do not pass through here.
 */
export function allowPrivateServersFromEnv(env: Record<string, string | undefined> = process.env): boolean {
  return env.ZENITH_KUBERNETES_ALLOW_PRIVATE_SERVERS === "1";
}

function refusedAddress(address: string, allowPrivate: boolean): boolean {
  const kind = classifyAddress(address);
  return kind === "never" || ((kind === "private" || kind === "loopback") && !allowPrivate);
}

/** Save-time check without DNS: IP literals (the URL parser normalizes decimal and hex IPv4) and reserved names. */
export function tenantServerRefused(server: string, allowPrivate = allowPrivateServersFromEnv()): boolean {
  let host: string;
  try { host = new URL(server).hostname.replace(/^\[|\]$/g, ""); } catch { return true; }
  if (net.isIP(host)) return refusedAddress(host, allowPrivate);
  return !allowPrivate && NAME_REFUSED.test(host);
}

/** Connect-time check: every address the server name resolves to must pass. */
export async function assertTenantServer(server: string, opts: { allowPrivate?: boolean; lookup?: HostLookup } = {}): Promise<void> {
  const allowPrivate = opts.allowPrivate ?? allowPrivateServersFromEnv();
  const refuse = (): never => { throw new K8sError("session_invalid", "Kubernetes server address is refused (metadata, link-local and special-purpose addresses always; loopback and private unless the operator allows them)."); };
  if (tenantServerRefused(server, allowPrivate)) refuse();
  const host = new URL(server).hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return;
  let addresses: string[];
  // shortcut: a name that does not resolve here is left to the client, which resolves it again and fails the same way;
  // the client does not pin these answers, so a rebinding DNS server can still race this check. Pin addresses in the
  // client's HTTPS agent if tenant clusters ever run outside an egress-filtered worker network.
  try { addresses = await (opts.lookup ?? (async (h) => (await dnsLookup(h, { all: true })).map((r) => r.address)))(host); } catch { return; }
  if (addresses.some((a) => refusedAddress(a, allowPrivate))) refuse();
}

/* ------------------------------- credentials ------------------------------- */

type Credential = { token: string } | { certData: string; keyData: string };

const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{8,8192}$/;

/** A stored kubeconfig larger than this is refused before parsing (YAML alias bombs, pasted bundles). */
const MAX_KUBECONFIG_BYTES = 256 * 1024;

function parseKubeconfigCredential(text: string): Credential {
  if (Buffer.byteLength(text, "utf8") > MAX_KUBECONFIG_BYTES) throw new K8sError("session_invalid", "Stored kubeconfig is too large.");
  let doc: unknown;
  try {
    doc = yamlLoad(text);
  } catch {
    throw new K8sError("session_invalid", "Stored kubeconfig is not valid YAML.");
  }
  const d = doc as { users?: { name?: string; user?: Record<string, unknown> }[]; contexts?: { name?: string; context?: { user?: string } }[]; "current-context"?: string } | null;
  const users = Array.isArray(d?.users) ? d.users : [];
  if (users.length === 0) throw new K8sError("session_invalid", "Stored kubeconfig has no users.");
  const ctx = d?.contexts?.find((c) => c.name === d["current-context"]);
  const wanted = ctx?.context?.user;
  const entry = (wanted ? users.find((u) => u.name === wanted) : undefined) ?? users[0];
  const user = entry.user ?? {};
  const unsupported = ["exec", "auth-provider", "tokenFile", "client-certificate", "client-key", "username", "password", "as", "as-groups"].filter((k) => k in user);
  if (unsupported.length > 0) {
    throw new K8sError(
      "session_invalid",
      `Stored kubeconfig uses an unsupported auth method (${unsupported.join(", ")}). Only a static bearer token or embedded client-certificate data is accepted.`
    );
  }
  if (typeof user.token === "string") return { token: validateToken(user.token) };
  const cert = user["client-certificate-data"];
  const key = user["client-key-data"];
  if (typeof cert === "string" && typeof key === "string") return { certData: cert, keyData: key };
  throw new K8sError("session_invalid", "Stored kubeconfig has neither a token nor client-certificate data.");
}

function validateToken(raw: string): string {
  const token = raw.trim();
  if (!TOKEN_RE.test(token)) throw new K8sError("session_invalid", "Resolved credential is not a well-formed bearer token.");
  return token;
}

function parseCredential(text: string): Credential {
  const t = text.trim();
  // kubectl also writes JSON kubeconfigs (`-o json`); a bearer token never starts with "{".
  if (t.startsWith("{") || /^(apiVersion|kind|clusters|users|contexts|current-context)\s*:/m.test(t)) return parseKubeconfigCredential(t);
  return { token: validateToken(t) };
}

/* --------------------------------- session --------------------------------- */

class Session implements ScopedKubernetesSession {
  readonly provider = "kubernetes" as const;
  readonly server: string;
  readonly expiresAt: string;
  readonly namespaces: readonly string[];
  readonly #kc: KubeConfig;
  readonly #now: () => Date;

  constructor(kc: KubeConfig, server: string, expiresAt: string, namespaces: readonly string[], now: () => Date) {
    this.#kc = kc;
    this.server = server;
    this.expiresAt = expiresAt;
    this.namespaces = [...namespaces];
    this.#now = now;
  }

  kubeConfig(): KubeConfig {
    if (this.#now().getTime() >= Date.parse(this.expiresAt)) {
      throw new K8sError("session_expired", "Kubernetes session has expired; request a new one from the credential broker.");
    }
    return this.#kc;
  }

  private summary() {
    return { provider: this.provider, server: this.server, expiresAt: this.expiresAt, namespaces: this.namespaces };
  }
  toJSON() {
    return this.summary();
  }
  [inspect.custom]() {
    return `KubernetesSession ${inspect(this.summary())}`;
  }
}

function buildKubeConfig(server: string, caData: string | undefined, credential: Credential, insecureHttp: boolean): KubeConfig {
  const kc = new KubeConfig();
  kc.loadFromClusterAndUser(
    // skipTLSVerify is meaningful only as the library's gate for plain http on loopback; https always verifies
    { name: "zenith-cluster", server, caData, skipTLSVerify: insecureHttp },
    "token" in credential
      ? { name: "zenith-user", token: credential.token }
      : { name: "zenith-user", certData: credential.certData, keyData: credential.keyData }
  );
  return kc;
}

const clampTtl = (s: number | undefined) => Math.min(Math.max(Math.floor(s ?? 900), 30), 3600);

/** Resolve the connection's credential and build a scoped, expiring session. */
export async function createKubernetesSession(
  config: KubernetesConnectionConfig,
  deps: KubernetesSessionDeps,
  signal?: AbortSignal
): Promise<ScopedKubernetesSession> {
  if (config.mode === "runner") {
    throw new K8sError("unsupported", "Runner-mode connections execute inside the customer's network; they do not build an in-process session.");
  }
  const now = deps.now ?? (() => new Date());
  const server = validateServerUrl(config.server, deps.allowInsecureLoopback === true);
  const insecureHttp = server.startsWith("http:");
  const ttlMs = clampTtl(deps.ttlSec) * 1000;
  let expiresAt = now().getTime() + ttlMs;

  let credential: Credential;
  if (config.eks) {
    if (!deps.eksToken) throw new K8sError("session_invalid", "An EKS connection needs an EKS token function.");
    const minted = await deps.eksToken(config.eks, signal);
    credential = { token: validateToken(minted.token) };
    expiresAt = Math.min(expiresAt, Date.parse(minted.expiresAt) || expiresAt);
  } else if (config.mode === "oidc_web_identity") {
    if (!deps.oidcToken) throw new K8sError("session_invalid", "An OIDC connection needs an OIDC token function.");
    const minted = await deps.oidcToken(config, signal);
    credential = { token: validateToken(minted.token) };
    expiresAt = Math.min(expiresAt, Date.parse(minted.expiresAt) || expiresAt);
  } else {
    if (!config.credentialRef) throw new K8sError("session_invalid", "Connection has no credential reference.");
    credential = parseCredential(await deps.resolveCredential(config.credentialRef, signal));
  }

  if (expiresAt <= now().getTime()) throw new K8sError("session_expired", "Credential is already expired.");
  const kc = buildKubeConfig(server, config.caData, credential, insecureHttp);
  return new Session(kc, server, new Date(expiresAt).toISOString(), config.namespaces, now);
}

/**
 * Wrap an already-built `KubeConfig` (a local kubeconfig for a kind cluster in
 * the gated real-cluster test, or a runner's in-cluster config) as a session.
 */
export function sessionFromKubeConfig(
  kc: KubeConfig,
  opts: { namespaces: readonly string[]; ttlSec?: number; now?: () => Date }
): ScopedKubernetesSession {
  const now = opts.now ?? (() => new Date());
  const cluster = kc.getCurrentCluster();
  if (!cluster) throw new K8sError("session_invalid", "KubeConfig has no current cluster.");
  return new Session(kc, cluster.server, new Date(now().getTime() + clampTtl(opts.ttlSec) * 1000).toISOString(), opts.namespaces, now);
}
