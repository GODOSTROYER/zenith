/**
 * The dispatch worker: the Cloudflare edge's front door for app hosts.
 *
 * It decides nothing. Every request becomes one question to the control
 * service's `/api/hosted/policy/admit`, and the answer is obeyed:
 *
 *   deny  → answer with the status the policy chose, and **do not** invoke any
 *           script. This is the same promise the local gateway's invocation
 *           sentinel proves: a denied request never reaches app code.
 *   serve → invoke the named dispatch script — the release for app paths, the
 *           app's fixed broker for `/_zenith/data/v1/*` — with a request that
 *           has had every platform credential removed.
 *
 * The response guard is applied out here, to everything, including the answers
 * this worker generates itself. The constants are copied from
 * `src/lib/hosted/gateway/guard.ts` because a worker cannot import from the
 * Next application; `tests/hosted/runtime/workers.test.ts` asserts they are
 * still identical, so a change on one side fails the build rather than
 * silently weakening the edge.
 *
 * NOT VERIFIED LIVE. See README.md in this directory.
 */

/** Bindings and variables this worker is deployed with. */
export interface GatewayWorkerEnv {
  /** The Workers for Platforms dispatch namespace holding release and broker scripts. */
  DISPATCH: DispatchNamespace;
  /** Absolute URL of the control service's admission endpoint. */
  POLICY_URL: string;
  /** The same value as the control service's ZENITH_POLICY_SHARED_SECRET. */
  POLICY_SECRET: string;
}

/** Copied from `src/lib/hosted/gateway/guard.ts`; the test asserts they match. */
export const WORKER_CSP =
  "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; " +
  "form-action 'self'; object-src 'none'";

/** Copied from `src/lib/hosted/gateway/guard.ts`; the test asserts they match. */
export const WORKER_SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": WORKER_CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

export const WORKER_CACHE_CONTROL = {
  "no-store": "private, no-store",
  immutable: "private, max-age=300, immutable",
} as const;

/** Copied from the gateway: only a name that changes with its bytes may be cached. */
export const HASHED_ASSET_RE = /^assets\/(?:[^/]+\/)*[^/]*[-.][0-9a-zA-Z_]{6,}\.[0-9a-z]+$/;

/** The app session cookie. The only cookie this platform sets on an app host. */
export const APP_SESSION_COOKIE = "__Host-zenith_app";

/** What the policy endpoint answers. Mirrors `AdmissionDecision` in the gateway. */
export interface PolicyDecision {
  decision: "serve" | "deny";
  status: number;
  code?: string;
  release?: { id: string; digest: string; number: number; script: string };
  session?: { subject: string; email: string; role: string };
  reserved?: string;
  retryAfter?: number;
}

/** Headers the dispatched script is never allowed to receive from the client. */
const STRIPPED_REQUEST_HEADERS = ["cookie", "authorization", "proxy-authorization"];

/** Headers a dispatched script is never allowed to set. */
const STRIPPED_RESPONSE_HEADERS = ["set-cookie", "location", "link"];

/** The value of the app session cookie on a request, or undefined. */
export function readSessionCookie(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() !== APP_SESSION_COOKIE) continue;
    const value = pair.slice(eq + 1).trim();
    return value === "" ? undefined : value;
  }
  return undefined;
}

/** Apply the platform's response guard. The one exit, exactly as on the control service. */
export function guard(
  response: Response,
  opts: { cache: keyof typeof WORKER_CACHE_CONTROL; releaseId?: string }
): Response {
  const headers = new Headers();
  response.headers.forEach((value, rawName) => {
    const name = rawName.toLowerCase();
    if (STRIPPED_RESPONSE_HEADERS.includes(name) || name.startsWith("access-control-")) return;
    headers.set(name, value);
  });
  for (const [name, value] of Object.entries(WORKER_SECURITY_HEADERS)) headers.set(name, value);
  headers.set("cache-control", WORKER_CACHE_CONTROL[opts.cache]);
  if (opts.releaseId) headers.set("x-zenith-release", opts.releaseId);
  const bodiless = response.status === 204 || response.status === 205 || response.status === 304;
  return new Response(bodiless ? null : response.body, { status: response.status, headers });
}

/** A guarded JSON refusal in the platform's envelope. */
function refuse(
  status: number,
  code: string,
  message: string,
  fix: string,
  extra: Record<string, string> = {}
): Response {
  return guard(
    new Response(JSON.stringify({ error: { code, message, fix } }), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", ...extra },
    }),
    { cache: "no-store" }
  );
}

/** Ask the control service. Any failure to get an answer is 503, never a pass. */
export async function askPolicy(
  env: GatewayWorkerEnv,
  question: { host: string; method: string; path: string; cookie?: string; origin?: string }
): Promise<PolicyDecision> {
  const response = await fetch(env.POLICY_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.POLICY_SECRET}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(question),
  });
  if (!response.ok) return { decision: "deny", status: 503, code: "policy_unavailable" };
  const body = (await response.json()) as PolicyDecision;
  if (body?.decision !== "serve" && body?.decision !== "deny")
    return { decision: "deny", status: 503, code: "policy_unavailable" };
  return body;
}

/**
 * Rebuild the request for the dispatched script.
 *
 * Everything the platform uses to know who the caller is comes off, and the
 * identity the policy decided goes on in its place. A client cannot forge the
 * `x-zenith-*` headers, because they are deleted before they are set.
 */
export function forDispatch(request: Request, decision: PolicyDecision): Request {
  const headers = new Headers(request.headers);
  for (const name of STRIPPED_REQUEST_HEADERS) headers.delete(name);
  for (const name of [...headers.keys()]) if (name.toLowerCase().startsWith("x-zenith-")) headers.delete(name);
  if (decision.session) {
    headers.set("x-zenith-subject", decision.session.subject);
    headers.set("x-zenith-email", decision.session.email);
    headers.set("x-zenith-role", decision.session.role);
  }
  if (decision.release) {
    headers.set("x-zenith-release", decision.release.id);
    headers.set("x-zenith-digest", decision.release.digest);
  }
  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
  });
}

/** The cache mode for a served path: only a hashed asset may be cached. */
export function cacheModeFor(pathname: string): keyof typeof WORKER_CACHE_CONTROL {
  return HASHED_ASSET_RE.test(pathname.replace(/^\/+/, "")) ? "immutable" : "no-store";
}

const gatewayWorker = {
  async fetch(request: Request, env: GatewayWorkerEnv, ctx: ExecutionContext): Promise<Response> {
    void ctx;
    const url = new URL(request.url);
    const host = request.headers.get("host") ?? url.host;

    let decision: PolicyDecision;
    try {
      decision = await askPolicy(env, {
        host,
        method: request.method,
        path: url.pathname,
        cookie: readSessionCookie(request.headers.get("cookie")),
        origin: request.headers.get("origin") ?? undefined,
      });
    } catch {
      decision = { decision: "deny", status: 503, code: "policy_unavailable" };
    }

    if (decision.decision === "deny")
      return refuse(
        decision.status,
        decision.code ?? "forbidden",
        "This request was not admitted.",
        "Open the app from your Zenith apps page. If you were signed in a moment ago, your session may have ended.",
        decision.retryAfter ? { "retry-after": String(decision.retryAfter) } : {}
      );

    // Zenith serves its own reserved paths. `data.requests` is the app's fixed
    // broker, which is a dispatch script like any other; the rest — sign-in,
    // the exchange callback, session and health — are control-service pages
    // and must be routed there by a Cloudflare route rule ahead of this
    // worker. This worker will not invent them.
    if (decision.reserved && decision.reserved !== "data.requests")
      return refuse(
        503,
        "policy_unavailable",
        "This address is served by Zenith itself, and this edge deployment has not been given a route to it.",
        "Route /_zenith/auth/*, /_zenith/session and /_zenith/health on this hostname to the Zenith control service, ahead of the dispatch worker. See workers/README.md."
      );

    if (!decision.release)
      return refuse(
        503,
        "policy_unavailable",
        "The control service admitted this request without naming a release to serve it.",
        "This is a control-service fault, not a configuration problem. Try again; if it persists, the policy endpoint needs looking at."
      );

    const script = env.DISPATCH.get(decision.release.script);
    const answer = await script.fetch(forDispatch(request, decision));
    return guard(answer, { cache: cacheModeFor(url.pathname), releaseId: decision.release.id });
  },
};

export default gatewayWorker;
