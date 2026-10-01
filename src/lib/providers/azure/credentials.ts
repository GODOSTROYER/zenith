/**
 * Azure credential session (ADR-0006, spec §11): workload identity federation
 * with NO stored secret.
 *
 *   broker ─ mintClientAssertion("api://AzureADTokenExchange") ─▶ Zenith-signed JWT
 *            (sub = zenith:ws:<ws>:conn:<conn>, ≤ 5 minutes, issuer = Zenith OIDC)
 *   session ─ POST https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token
 *             grant_type=client_credentials, client_id=<app registration>,
 *             client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer,
 *             client_assertion=<the JWT>, scope=<resource>/.default
 *           ─▶ Entra access token for ONE resource audience (in memory only)
 *
 * The customer's app registration / user-assigned identity carries a
 * FEDERATED IDENTITY CREDENTIAL pinning issuer, audience and the exact `sub`
 * (deploy/azure). Stealing Zenith's database therefore yields no Azure
 * credential; there is no client secret anywhere in this module.
 *
 * What a session exposes (`AzureSession`, plus `revoke()` for the broker):
 *   - `authorizedFetch(url, init)`: attaches a bearer token chosen by the
 *     URL's host and REFUSES every host outside the allowlist below. The
 *     token never leaves this closure: it is not a property, not in
 *     `toJSON`/`inspect`, not in any error message.
 *   - `childProcessEnv()`: for OpenTofu/azurerm — `ARM_USE_OIDC=true` and the
 *     short-lived client assertion in `ARM_OIDC_TOKEN` (the provider performs
 *     the exchange itself), plus the three non-secret identifiers. Never a
 *     client secret. The assertion is a JWT that expires within minutes; it is
 *     minted when the session is created, so a session must be used promptly
 *     (`childProcessEnv()` throws once the assertion has expired). Consequence
 *     to know: azurerm exchanges the assertion at provider start and re-uses
 *     the resulting access token; an apply that outlives that token (about an
 *     hour) cannot refresh it because the assertion has expired by then.
 *
 * Host allowlist (nothing else ever receives a bearer token):
 *   management.azure.com                    ARM control plane
 *   <vault>.vault.azure.net                 Key Vault data plane (secret sync)
 *   api.loganalytics.io / .azure.com        Log Analytics query API
 *   <region>.monitor.azure.com etc.         Azure Monitor data plane
 *   exact trusted C3 account Blob host      Storage data plane (no redirects)
 * Redirects are never followed to a host outside the list (a 3xx to elsewhere
 * is an error, not a hop that carries the token).
 *
 * Honest limits: exercised against a fake Entra endpoint and a fake ARM
 * server only. Not run against a real tenant. Sovereign clouds (China, US
 * Gov) are not supported: the authority and resource hosts are the public
 * cloud's.
 */
import type { AzureConnectionConfig, AzureSession, CredentialPurpose } from "@/lib/credentials/types";
import { CredentialDeniedError } from "@/lib/credentials/types";

/* -------------------------------- constants -------------------------------- */

export const FEDERATION_AUDIENCE = "api://AzureADTokenExchange" as const;
export const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
export const AUTHORITY_HOST = "https://login.microsoftonline.com";

export type TokenAudience = "arm" | "keyvault" | "loganalytics" | "monitor" | "storage";

export const TOKEN_SCOPES: Readonly<Record<TokenAudience, string>> = {
  arm: "https://management.azure.com/.default",
  storage: "https://storage.azure.com/.default",
  keyvault: "https://vault.azure.net/.default",
  loganalytics: "https://api.loganalytics.io/.default",
  monitor: "https://monitor.azure.com/.default",
};

const DEFAULT_SESSION_SEC = 900;
const MAX_SESSION_SEC = 3600;
const TOKEN_REFRESH_SKEW_MS = 120_000;
const EXCHANGE_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REGION = /^[a-z0-9]{2,40}$/;

/* --------------------------------- errors ---------------------------------- */

/** Token exchange failed. Carries Entra's error code and ids, never a token or the assertion. */
export class AzureTokenError extends Error {
  readonly code = "azure_token_exchange_failed";
  constructor(
    message: string,
    readonly status: number,
    readonly entraError?: string,
    readonly correlationId?: string
  ) {
    super(message);
    this.name = "AzureTokenError";
  }
}

export type AzureRefusal = "host_not_allowed" | "insecure_url" | "redirect_refused" | "session_revoked" | "session_expired" | "invalid_request";

/**
 * A request was refused by the session itself (host allowlist, redirect,
 * revoked). `refusal` is the Azure-specific cause; the inherited `reason` is
 * the broker-wide `DenialReason` it maps to, so callers that handle every
 * credential denial the same way still can.
 */
export class AzureRequestRefusedError extends CredentialDeniedError {
  readonly refusal: AzureRefusal;
  constructor(refusal: AzureRefusal, message: string) {
    super(message, { reason: refusal === "session_revoked" || refusal === "session_expired" ? "session_ended" : "endpoint_not_permitted" });
    this.name = "AzureRequestRefusedError";
    this.refusal = refusal;
  }
}

/* --------------------------------- host policy ------------------------------ */

/** Which token audience a URL's host is entitled to, or `undefined` when the host is not allowed. */
export function audienceForHost(hostname: string, trustedSourceHost?: string): TokenAudience | undefined {
  const h = hostname.toLowerCase();
  if (trustedSourceHost && h === trustedSourceHost) return "storage";
  if (h === "management.azure.com") return "arm";
  if (h === "api.loganalytics.io" || h === "api.loganalytics.azure.com") return "loganalytics";
  if (isSubdomainOf(h, "vault.azure.net", 1, 1)) return "keyvault";
  if (isSubdomainOf(h, "monitor.azure.com", 1, 3)) return "monitor";
  return undefined;
}

/** Validates trusted source identifiers before any token is minted or host permitted. */
export function sourceStorageHost(binding: NonNullable<AzureConnectionConfig["sourceStorage"]>[string], subscriptionId: string): string {
  const match = typeof binding.accountResourceId === "string" ? /^\/subscriptions\/([a-f0-9-]{36})\/resourceGroups\/([A-Za-z0-9_.()-]{1,90})\/providers\/Microsoft\.Storage\/storageAccounts\/([a-z0-9]{3,24})$/i.exec(binding.accountResourceId) : null;
  const suffixes = { public: "blob.core.windows.net", usgov: "blob.core.usgovcloudapi.net", china: "blob.core.chinacloudapi.cn" } as const;
  const cloud = binding.cloud ?? "public";
  if (!match || !GUID.test(subscriptionId) || match[1].toLowerCase() !== subscriptionId.toLowerCase() || !/^[a-z0-9]{3,24}$/.test(match[3]) || typeof binding.container !== "string" || !/^[a-z0-9](?:[a-z0-9]|-(?!-)){1,61}[a-z0-9]$/.test(binding.container) || typeof binding.resourceAddress !== "string" || !/^object_store\/[A-Za-z0-9_.-]{1,128}$/.test(binding.resourceAddress) || [".", ".."].includes(binding.resourceAddress.split("/")[1]) || !Object.hasOwn(suffixes, cloud)) {
    throw new AzureRequestRefusedError("invalid_request", "Trusted Azure source storage binding is invalid or outside this subscription.");
  }
  return `${match[3]}.${suffixes[cloud]}`;
}

/** `<labels>.<suffix>` with 1..max DNS-safe labels (no empty labels, no odd characters). */
function isSubdomainOf(host: string, suffix: string, minLabels: number, maxLabels: number): boolean {
  if (!host.endsWith(`.${suffix}`)) return false;
  const prefix = host.slice(0, host.length - suffix.length - 1);
  const labels = prefix.split(".");
  return labels.length >= minLabels && labels.length <= maxLabels && labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}

/** Validate a URL for an authorized call; returns the parsed URL and the audience it gets. */
export function checkAuthorizedUrl(raw: string, trustedSourceHost?: string): { url: URL; audience: TokenAudience } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AzureRequestRefusedError("invalid_request", "authorizedFetch needs an absolute URL.");
  }
  if (url.protocol !== "https:") throw new AzureRequestRefusedError("insecure_url", "authorizedFetch only calls https URLs.");
  if (url.username || url.password) throw new AzureRequestRefusedError("invalid_request", "URLs with embedded credentials are refused.");
  if (url.port && url.port !== "443") throw new AzureRequestRefusedError("host_not_allowed", "Only the default https port is allowed.");
  const audience = audienceForHost(url.hostname, trustedSourceHost);
  if (!audience) {
    throw new AzureRequestRefusedError("host_not_allowed", `Host "${safeHost(url.hostname)}" is not an Azure endpoint this session may call.`);
  }
  return { url, audience };
}

const safeHost = (h: string): string => h.replace(/[^a-z0-9.-]/gi, "?").slice(0, 80);

/* --------------------------------- helpers --------------------------------- */

const JWT_SHAPE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;

function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 8) out = out.split(s).join("[REDACTED]");
  return out.replace(JWT_SHAPE, "[REDACTED:jwt]").replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]");
}

/** `exp` of a JWT in ms, or undefined for anything that is not a decodable JWT. Does NOT verify the signature. */
function jwtExpiryMs(jwt: string): number | undefined {
  const parts = jwt.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export interface CreateAzureSessionOptions {
  connection: AzureConnectionConfig;
  /** One trusted environment binding supplied by the broker, never request input. */
  sourceStorage?: NonNullable<AzureConnectionConfig["sourceStorage"]>[string];
  /** mints the ≤5-minute Zenith-signed assertion for the given audience */
  mintClientAssertion: (audience: typeof FEDERATION_AUDIENCE) => Promise<string>;
  purpose: CredentialPurpose;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** session lifetime in seconds; default 900, max 3600 */
  durationSec?: number;
  /** token endpoint timeout in ms; default 15 s (tests shorten it) */
  exchangeTimeoutMs?: number;
}

/** An `AzureSession` plus the broker's end-of-callback hook. */
export interface AzureSessionHandle extends AzureSession {
  readonly purpose: CredentialPurpose;
  /** after this, every call refuses; the broker calls it when the `withSession` callback settles */
  revoke(): void;
}

/* --------------------------------- session --------------------------------- */

/**
 * Create a session for one operation. Mints ONE client assertion eagerly (for
 * `childProcessEnv()`), and mints a fresh one per token exchange thereafter:
 * Entra does not accept an assertion twice.
 */
export async function createAzureSession(opts: CreateAzureSessionOptions): Promise<AzureSessionHandle> {
  const { connection, purpose } = opts;
  const now = opts.now ?? (() => new Date());
  const doFetch = opts.fetchImpl ?? fetch;

  if (connection.provider !== "azure") throw new CredentialDeniedError("Not an Azure connection.");
  if (connection.mode !== "oidc_web_identity") {
    throw new CredentialDeniedError(`Azure connection mode "${connection.mode}" does not use a federated session; runner connections never reach this code.`);
  }
  for (const [label, value] of [
    ["tenantId", connection.tenantId],
    ["clientId", connection.clientId],
    ["subscriptionId", connection.subscriptionId],
  ] as const) {
    if (!GUID.test(value)) throw new CredentialDeniedError(`Azure connection ${label} is not a GUID.`);
  }
  if (!REGION.test(connection.region)) throw new CredentialDeniedError("Azure connection region is not a valid region name.");
  const durationSec = Math.min(Math.max(Math.trunc(opts.durationSec ?? DEFAULT_SESSION_SEC), 60), MAX_SESSION_SEC);

  const { tenantId, clientId, subscriptionId, region } = connection;
  const sourceHost = opts.sourceStorage ? sourceStorageHost(opts.sourceStorage, subscriptionId) : undefined;
  const startedMs = now().getTime();
  const expiresAtMs = startedMs + durationSec * 1000;
  let revoked = false;

  /** every secret this session ever held, for scrubbing error text */
  const secrets: string[] = [];
  const tokens = new Map<TokenAudience, { token: string; expiresAtMs: number }>();
  const inflight = new Map<TokenAudience, Promise<string>>();

  const mint = async (): Promise<string> => {
    const assertion = await opts.mintClientAssertion(FEDERATION_AUDIENCE);
    if (typeof assertion !== "string" || assertion.length < 16) throw new CredentialDeniedError("The client assertion minter returned no usable assertion.");
    secrets.push(assertion);
    return assertion;
  };

  const tofuAssertion = await mint();
  const tofuAssertionExpiryMs = jwtExpiryMs(tofuAssertion);

  const assertLive = (): void => {
    if (revoked) throw new AzureRequestRefusedError("session_revoked", "This Azure session has ended.");
    if (now().getTime() >= expiresAtMs) throw new AzureRequestRefusedError("session_expired", "This Azure session has expired.");
  };

  async function exchange(audience: TokenAudience): Promise<string> {
    const assertion = await mint();
    const body = new URLSearchParams({
      client_id: clientId,
      scope: TOKEN_SCOPES[audience],
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: assertion,
      grant_type: "client_credentials",
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.exchangeTimeoutMs ?? EXCHANGE_TIMEOUT_MS);
    let res: Response;
    try {
      res = await doFetch(`${AUTHORITY_HOST}/${tenantId}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: body.toString(),
        signal: controller.signal,
        redirect: "error",
      });
    } catch (e) {
      const reason = controller.signal.aborted ? "timed out" : e instanceof Error ? e.name : "network error";
      throw new AzureTokenError(`Entra token exchange failed: ${scrub(reason, secrets)}.`, 0);
    } finally {
      clearTimeout(timer);
    }
    if (res.redirected || (res.url && res.url !== `${AUTHORITY_HOST}/${tenantId}/oauth2/v2.0/token`)) {
      await res.body?.cancel().catch(() => undefined);
      throw new AzureTokenError("Entra token exchange returned a redirected or foreign response.", res.status);
    }
    const text = (await res.text().catch(() => "")).slice(0, 16_384);
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* non-JSON error body: reported by status only */
    }
    if (!res.ok) {
      const code = typeof json.error === "string" ? json.error.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 60) : undefined;
      const codes = Array.isArray(json.error_codes) ? json.error_codes.filter((c): c is number => typeof c === "number").slice(0, 3).join(",") : "";
      const correlation = typeof json.correlation_id === "string" && GUID.test(json.correlation_id) ? json.correlation_id : undefined;
      const firstLine = typeof json.error_description === "string" ? scrub(json.error_description.split(/\r?\n/)[0] ?? "", secrets).slice(0, 200) : "";
      throw new AzureTokenError(
        `Entra token exchange failed (HTTP ${res.status}${code ? `, ${code}` : ""}${codes ? `, AADSTS${codes}` : ""})${firstLine ? `: ${firstLine}` : ""}${correlation ? ` [correlation ${correlation}]` : ""}`,
        res.status,
        code,
        correlation
      );
    }
    const token = json.access_token;
    const type = typeof json.token_type === "string" ? json.token_type.toLowerCase() : "";
    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : Number(json.expires_in);
    if (typeof token !== "string" || token.length < 16 || type !== "bearer" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new AzureTokenError("Entra token exchange returned an unusable response.", res.status);
    }
    secrets.push(token);
    tokens.set(audience, { token, expiresAtMs: now().getTime() + expiresIn * 1000 });
    return token;
  }

  async function tokenFor(audience: TokenAudience): Promise<string> {
    const hit = tokens.get(audience);
    if (hit && hit.expiresAtMs - now().getTime() > TOKEN_REFRESH_SKEW_MS) return hit.token;
    let pending = inflight.get(audience);
    if (!pending) {
      pending = exchange(audience).finally(() => inflight.delete(audience));
      inflight.set(audience, pending);
    }
    return pending;
  }

  async function authorizedFetch(input: string, init: RequestInit = {}): Promise<Response> {
    assertLive();
    let target = checkAuthorizedUrl(input, sourceHost);
    if (target.audience === "storage" && init.redirect !== "error") throw new AzureRequestRefusedError("invalid_request", "Source Blob requests require redirect refusal.");
    const headers = new Headers(init.headers);
    // the caller can never choose the credential
    headers.delete("authorization");
    headers.delete("proxy-authorization");
    let method = (init.method ?? "GET").toUpperCase();
    let body = init.body;
    for (let hop = 0; ; hop++) {
      const token = await tokenFor(target.audience);
      assertLive();
      const h = new Headers(headers);
      h.set("authorization", `Bearer ${token}`);
      const noRedirect = init.redirect === "error" || target.audience === "storage";
      let res: Response;
      try {
        res = await doFetch(target.url.toString(), { ...init, method, body, headers: h, redirect: noRedirect ? "error" : "manual" });
      } catch (error) {
        if (!noRedirect) throw error;
        throw new AzureRequestRefusedError("invalid_request", "Azure authorized request failed or a redirect was refused.");
      }
      if (noRedirect && (res.redirected || (res.url && res.url !== target.url.toString()))) {
        await res.body?.cancel().catch(() => undefined);
        throw new AzureRequestRefusedError("redirect_refused", "Azure authorized request returned a redirected or foreign response.");
      }
      if (res.status < 300 || res.status >= 400 || res.status === 304) return res;
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (noRedirect || !location || hop >= MAX_REDIRECTS) throw new AzureRequestRefusedError("redirect_refused", "The Azure endpoint redirected in a way this session will not follow.");
      let next: { url: URL; audience: TokenAudience };
      try {
        next = checkAuthorizedUrl(new URL(location, target.url).toString());
      } catch {
        throw new AzureRequestRefusedError("redirect_refused", "The Azure endpoint redirected to a host this session may not call.");
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== "GET" && method !== "HEAD")) {
        method = "GET";
        body = undefined;
      }
      target = next;
    }
  }

  function childProcessEnv(): Record<string, string> {
    assertLive();
    if (tofuAssertionExpiryMs !== undefined && now().getTime() >= tofuAssertionExpiryMs - 5_000) {
      throw new AzureRequestRefusedError("session_expired", "The client assertion for OpenTofu has expired; create a new session.");
    }
    return {
      ARM_USE_OIDC: "true",
      // The ONLY secret-shaped value here: a short-lived JWT the provider exchanges itself.
      ARM_OIDC_TOKEN: tofuAssertion,
      ARM_CLIENT_ID: clientId,
      ARM_TENANT_ID: tenantId,
      ARM_SUBSCRIPTION_ID: subscriptionId,
      // Shared-key access is disabled on Zenith storage accounts; the provider must use Entra for data-plane calls.
      ARM_STORAGE_USE_AZUREAD: "true",
      // The deploy identity has no subscription-level rights; the customer bootstrap registers the resource providers.
      ARM_RESOURCE_PROVIDER_REGISTRATIONS: "none",
    };
  }

  const view = { provider: "azure" as const, subscriptionId, region, expiresAt: new Date(expiresAtMs).toISOString(), purpose };
  const session: AzureSessionHandle = {
    provider: "azure",
    subscriptionId,
    region,
    expiresAt: view.expiresAt,
    purpose,
    authorizedFetch,
    childProcessEnv,
    revoke() {
      revoked = true;
      tokens.clear();
      inflight.clear();
    },
  };
  // Nothing in the object holds key material, but keep accidental serialization to the public view.
  Object.defineProperty(session, "toJSON", { value: () => ({ ...view }), enumerable: false });
  Object.defineProperty(session, Symbol.for("nodejs.util.inspect.custom"), { value: () => `AzureSession(${subscriptionId}, ${region}, ${purpose})`, enumerable: false });
  return session;
}
