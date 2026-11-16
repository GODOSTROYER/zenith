/**
 * GCP credential session: Zenith OIDC token → STS → service-account
 * impersonation → a short-lived, closure-held access token (ADR-0006).
 *
 *   1. `mintSubjectToken(audience)` — the broker mints a ≤ 5-minute JWT whose
 *      `sub` is `zenith:ws:<ws>:conn:<conn>`. We ask for the default audience of
 *      a workload identity pool provider, `https://iam.googleapis.com/<provider>`;
 *      the customer bootstrap (`deploy/gcp`) pins exactly that value as the
 *      provider's allowed audience.
 *   2. STS `POST https://sts.googleapis.com/v1/token` (RFC 8693 token exchange,
 *      `subject_token_type=jwt`, `audience=//iam.googleapis.com/<provider>`,
 *      `scope=cloud-platform`) → federated access token.
 *   3. IAM Credentials `serviceAccounts.generateAccessToken` impersonates the
 *      observe or deploy service account (by `purpose`) with a lifetime of at
 *      most 900 s.
 *
 * Invariants:
 *   - the access token lives only in this closure. It is not a property of the
 *     session object, not in `JSON.stringify`, `util.inspect`, error messages or
 *     logs (errors go through `scrub`). The only ways out are
 *     `authorizedFetch` (sets the Authorization header on a request to a Google
 *     API host) and `childProcessEnv()` (for OpenTofu, handed straight to spawn);
 *   - `authorizedFetch` only talks to `https://<name>.googleapis.com` on the
 *     default port, without URL userinfo, and never follows redirects (an API
 *     that redirects is treated as an error rather than trusted with the
 *     bearer token); this is the SSRF guard;
 *   - a session is unusable after `expiresAt` or `close()`; it never refreshes
 *     itself, because a longer-lived session than the broker granted would
 *     break the ≤ 1 h / per-operation rule;
 *   - the STS token is used once, to impersonate, and is then dropped.
 *
 * Honest limits: exercised only against a fake STS/IAM server (contract
 * evidence); never against Google. The exact audience string Google accepts
 * for a given provider is the customer's configuration.
 */
import { inspect } from "node:util";
import type { CredentialPurpose, GcpConnectionConfig, GcpSession } from "@/lib/credentials/types";
import { GcpAuthError, GcpSessionError, scrub } from "./errors";
import type { GcpSessionHandle } from "./types";
import { PROJECT_ID_RE, REGION_RE, SA_EMAIL_RE } from "./validate";

export const STS_URL = "https://sts.googleapis.com/v1/token";
export const IAM_CREDENTIALS_ORIGIN = "https://iamcredentials.googleapis.com";
export const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
/** Hard cap on impersonated token lifetime (seconds). */
export const MAX_SESSION_LIFETIME_SEC = 900;

const PROVIDER_PATH = /^projects\/\d{1,20}\/locations\/global\/workloadIdentityPools\/[a-z0-9-]{4,32}\/providers\/[a-z0-9-]{4,32}$/;
const GOOGLEAPIS_HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+googleapis\.com$/;
const MAX_TOKEN_CHARS = 8192;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface CreateGcpSessionInput {
  connection: GcpConnectionConfig;
  /** mints the Zenith-signed OIDC JWT for the requested audience; called once */
  mintSubjectToken: (audience: string) => Promise<string>;
  purpose: CredentialPurpose;
  /** defaults to `globalThis.fetch`; tests route Google hosts to a local fake */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** ≤ 900, default 900 */
  lifetimeSec?: number;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
}

/** The JWT audience Zenith asks the broker to mint for. */
export function subjectAudience(workloadIdentityProvider: string): string {
  return `https://iam.googleapis.com/${workloadIdentityProvider}`;
}

/** The STS `audience` parameter. */
export function stsAudience(workloadIdentityProvider: string): string {
  return `//iam.googleapis.com/${workloadIdentityProvider}`;
}

/**
 * Validate that `url` is a plain `https://<sub>.googleapis.com/...` URL.
 * Exported for the REST client and tests. Throws `GcpSessionError`.
 */
export function assertGoogleApisUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new GcpSessionError("invalid_request", "authorizedFetch needs an absolute URL.");
  }
  if (u.protocol !== "https:") throw new GcpSessionError("host_not_allowed", "Only https:// Google API URLs are allowed.");
  if (u.username || u.password) throw new GcpSessionError("host_not_allowed", "URLs with embedded credentials are refused.");
  if (u.port !== "" && u.port !== "443") throw new GcpSessionError("host_not_allowed", "Non-default ports are refused.");
  if (!GOOGLEAPIS_HOST.test(u.hostname)) throw new GcpSessionError("host_not_allowed", `Host ${scrub(u.hostname, [], 80)} is not a googleapis.com API host.`);
  return u;
}

function validateConnection(c: GcpConnectionConfig, purpose: CredentialPurpose, lifetimeSec: number): string {
  if (c.provider !== "gcp") throw new GcpAuthError("invalid_connection", "Connection is not a GCP connection.");
  if (c.mode !== "oidc_web_identity") throw new GcpAuthError("unsupported_mode", `GCP connection mode "${String(c.mode)}" is not brokered in-process; runner connections use the runner's own identity.`);
  if (!PROJECT_ID_RE.test(c.projectId)) throw new GcpAuthError("invalid_connection", "Connection projectId is not a valid GCP project id.");
  if (!REGION_RE.test(c.region)) throw new GcpAuthError("invalid_connection", "Connection region is not a valid GCP region.");
  if (!PROVIDER_PATH.test(c.workloadIdentityProvider)) throw new GcpAuthError("invalid_connection", "workloadIdentityProvider must be projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>.");
  const sa = purpose === "deploy" ? c.deployServiceAccount : c.observeServiceAccount;
  if (!SA_EMAIL_RE.test(sa)) throw new GcpAuthError("invalid_connection", `The ${purpose} service account is not a service account email.`);
  if (!Number.isInteger(lifetimeSec) || lifetimeSec < 60 || lifetimeSec > MAX_SESSION_LIFETIME_SEC) {
    throw new GcpAuthError("invalid_connection", `Session lifetime must be 60–${MAX_SESSION_LIFETIME_SEC} seconds.`);
  }
  return sa;
}

interface Http {
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  timeoutMs: number;
}

function combinedSignal(h: Http, extra?: AbortSignal | null): AbortSignal {
  const signals = [AbortSignal.timeout(h.timeoutMs)];
  if (h.signal) signals.push(h.signal);
  if (extra) signals.push(extra);
  return AbortSignal.any(signals);
}

async function readJson(res: Response, max = 64 * 1024): Promise<Record<string, unknown>> {
  const text = (await res.text()).slice(0, max);
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function errorSummary(body: Record<string, unknown>, secrets: readonly string[]): string {
  // STS: { error, error_description }; IAM Credentials: { error: { status, message } }
  const err = body.error;
  const parts: string[] = [];
  if (typeof err === "string") parts.push(err);
  else if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.status === "string") parts.push(e.status);
    if (typeof e.message === "string") parts.push(e.message);
  }
  if (typeof body.error_description === "string") parts.push(body.error_description);
  return scrub(parts.join(": "), secrets, 240);
}

/**
 * Exchange and impersonate. Resolves to a live session; rejects with a
 * `GcpAuthError` whose message never contains a token.
 */
export async function createGcpSession(input: CreateGcpSessionInput): Promise<GcpSessionHandle> {
  const now = input.now ?? (() => new Date());
  const lifetimeSec = input.lifetimeSec ?? MAX_SESSION_LIFETIME_SEC;
  const c = input.connection;
  const serviceAccount = validateConnection(c, input.purpose, lifetimeSec);
  const http: Http = { fetchImpl: input.fetchImpl ?? globalThis.fetch.bind(globalThis), signal: input.signal, timeoutMs: input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS };

  const secrets: string[] = [];

  /* 1. the Zenith-signed subject token */
  let subject: string;
  try {
    subject = await input.mintSubjectToken(subjectAudience(c.workloadIdentityProvider));
  } catch (e) {
    // the broker's own error text is not trusted to be token-free
    throw new GcpAuthError("subject_token_unavailable", `The Zenith OIDC token could not be minted: ${scrub(e instanceof Error ? e.message : String(e), [], 160)}`);
  }
  if (typeof subject !== "string" || subject.length < 16 || subject.length > MAX_TOKEN_CHARS || /\s/.test(subject)) {
    throw new GcpAuthError("subject_token_unavailable", "The broker returned an unusable OIDC token.");
  }
  secrets.push(subject);

  /* 2. STS token exchange */
  let federated: string;
  {
    let res: Response;
    try {
      res = await http.fetchImpl(STS_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
          requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
          subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
          scope: CLOUD_PLATFORM_SCOPE,
          audience: stsAudience(c.workloadIdentityProvider),
          subjectToken: subject,
        }),
        redirect: "manual",
        signal: combinedSignal(http),
      });
    } catch (e) {
      throw new GcpAuthError("sts_unavailable", `STS token exchange could not be reached: ${scrub(e instanceof Error ? e.message : String(e), secrets, 160)}`);
    }
    const body = await readJson(res);
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      throw new GcpAuthError(retryable ? "sts_unavailable" : "sts_exchange_failed", `STS token exchange failed (HTTP ${res.status}): ${errorSummary(body, secrets) || "no detail"}`, res.status);
    }
    const tok = body.access_token;
    if (typeof tok !== "string" || tok.length < 10 || tok.length > MAX_TOKEN_CHARS || /\s/.test(tok)) {
      throw new GcpAuthError("malformed_response", "STS returned no usable access token.", res.status);
    }
    federated = tok;
    secrets.push(federated);
  }

  /* 3. service-account impersonation */
  let accessToken: string;
  let expiresMs: number;
  {
    const url = `${IAM_CREDENTIALS_ORIGIN}/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccount)}:generateAccessToken`;
    let res: Response;
    try {
      res = await http.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${federated}` },
        body: JSON.stringify({ scope: [CLOUD_PLATFORM_SCOPE], lifetime: `${lifetimeSec}s` }),
        redirect: "manual",
        signal: combinedSignal(http),
      });
    } catch (e) {
      throw new GcpAuthError("impersonation_unavailable", `Service account impersonation could not be reached: ${scrub(e instanceof Error ? e.message : String(e), secrets, 160)}`);
    }
    const body = await readJson(res);
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      throw new GcpAuthError(retryable ? "impersonation_unavailable" : "impersonation_failed", `Impersonating the ${input.purpose} service account failed (HTTP ${res.status}): ${errorSummary(body, secrets) || "no detail"}`, res.status);
    }
    const tok = body.accessToken;
    if (typeof tok !== "string" || tok.length < 10 || tok.length > MAX_TOKEN_CHARS || /\s/.test(tok)) {
      throw new GcpAuthError("malformed_response", "IAM Credentials returned no usable access token.", res.status);
    }
    accessToken = tok;
    secrets.push(accessToken);
    const capMs = now().getTime() + lifetimeSec * 1000;
    const reported = typeof body.expireTime === "string" ? Date.parse(body.expireTime) : Number.NaN;
    expiresMs = Number.isFinite(reported) ? Math.min(reported, capMs) : capMs;
  }
  // `federated` is not needed again; drop the reference.
  federated = "";

  /* the session: token in this closure only */
  let closed = false;
  const expiresAt = new Date(expiresMs).toISOString();

  const assertLive = () => {
    if (closed) throw new GcpSessionError("session_closed", "This GCP session was closed.");
    if (now().getTime() >= expiresMs) throw new GcpSessionError("session_expired", "This GCP session has expired; request a new one from the broker.");
  };

  const authorizedFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    assertLive();
    if (typeof url !== "string") throw new GcpSessionError("invalid_request", "authorizedFetch takes a URL string.");
    assertGoogleApisUrl(url);
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${accessToken}`);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    let res: Response;
    try {
      res = await http.fetchImpl(url, { ...init, headers, redirect: "manual", signal: combinedSignal(http, init?.signal) });
    } catch (e) {
      if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) throw e;
      throw new Error(`Google API request failed: ${scrub(e instanceof Error ? e.message : String(e), [accessToken], 160)}`);
    }
    if (res.status >= 300 && res.status < 400) {
      throw new GcpSessionError("redirect_refused", "A Google API answered with a redirect; it was not followed because the request carried a bearer token.");
    }
    return res;
  };

  const session: GcpSessionHandle = {
    provider: "gcp",
    projectId: c.projectId,
    region: c.region,
    expiresAt,
    purpose: input.purpose,
    authorizedFetch,
    childProcessEnv(): Record<string, string> {
      assertLive();
      return { GOOGLE_OAUTH_ACCESS_TOKEN: accessToken, GOOGLE_PROJECT: c.projectId, GOOGLE_REGION: c.region };
    },
    close(): void {
      closed = true;
    },
    get closed(): boolean {
      return closed;
    },
    toJSON(): Record<string, unknown> {
      return { provider: "gcp", projectId: c.projectId, region: c.region, expiresAt, purpose: input.purpose, closed };
    },
  } as GcpSessionHandle;
  Object.defineProperty(session, inspect.custom, {
    enumerable: false,
    value: () => `GcpSession { projectId: '${c.projectId}', purpose: '${input.purpose}', expiresAt: '${expiresAt}', closed: ${closed} }`,
  });
  return session;
}

/** Narrow a handle to the contract type the drivers accept. */
export function asGcpSession(s: GcpSessionHandle): GcpSession {
  return s;
}
