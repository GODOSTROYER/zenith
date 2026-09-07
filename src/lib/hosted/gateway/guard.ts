/**
 * The response guard: the single exit every gateway response passes through.
 *
 * An app host serves bytes that came out of a build. The guard is what makes
 * those bytes safe to hand a browser and what stops them from teaching the
 * browser something the platform did not say:
 *
 *  - a fixed CSP, `nosniff`, `no-referrer`, `DENY` framing, same-origin opener
 *    and a permissions policy that turns off camera, microphone and location;
 *  - `set-cookie`, `location`, `link` and every `access-control-*` header is
 *    **stripped unless the gateway itself set it**. An artifact is a static
 *    file today, so this is mostly theoretical — but "mostly theoretical" is
 *    exactly the kind of assumption that stops being true after one refactor,
 *    so the strip is unconditional and tested;
 *  - `cache-control` is `private, no-store` for everything except a hashed
 *    asset, which is immutable under its own name and may be cached.
 *
 * How "the gateway itself set it" is decided: a response the gateway builds
 * carries an `x-zenith-owned` marker naming the headers it deliberately set.
 * The guard keeps those, drops the rest and removes the marker. Nothing that
 * comes back from the artifact store or from app code can forge the marker,
 * because the store never produces headers at all — the marker is added by the
 * constructors below and by nothing else.
 *
 * Workstream W6 (hosted R3).
 */

/**
 * The content policy every app host response carries.
 *
 * `style-src 'unsafe-inline'` is the one concession: the pinned Vite recipe
 * emits an external stylesheet, but React inline styles and the sign-in page
 * below both need it, and refusing it would break apps for no security gain
 * while `script-src` stays strict.
 */
export const GATEWAY_CSP =
  "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; " +
  "form-action 'self'; object-src 'none'";

/** Headers set on every response, whatever its status. Tests read this table. */
export const GATEWAY_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-security-policy": GATEWAY_CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
});

/** `private, no-store` for HTML, JSON and every reserved route; hashed assets may be cached. */
export type CacheMode = "no-store" | "immutable";

export const CACHE_CONTROL: Record<CacheMode, string> = {
  "no-store": "private, no-store",
  immutable: "private, max-age=300, immutable",
};

/** The marker naming the headers the gateway set on purpose. Never leaves the process. */
export const GATEWAY_OWNED_HEADER = "x-zenith-owned";

/** Headers an artifact or a downstream response is never allowed to keep. */
const STRIPPED = (name: string): boolean =>
  name === "set-cookie" ||
  name === "location" ||
  name === "link" ||
  name.startsWith("access-control-");

/** Statuses that must not carry a body, so the guard does not re-attach one. */
const BODILESS = new Set([204, 205, 304]);

/**
 * A hashed asset: under `assets/`, with a name whose stem ends in a content
 * hash. Only these may be cached, because only these change name when their
 * bytes change. `assets/logo.svg` is served `no-store` for that reason.
 */
export function isHashedAssetPath(path: string): boolean {
  return /^assets\/(?:[^/]+\/)*[^/]*[-.][0-9a-zA-Z_]{6,}\.[0-9a-z]+$/.test(path);
}

/** What the guard needs to know about a response it is finishing. */
export interface GuardOptions {
  cache: CacheMode;
  /** Stamped as `x-zenith-release` for attribution when a release served this. */
  releaseId?: string;
}

/**
 * Finish a response: strip what the gateway did not set, add the security
 * headers, decide the cache policy. Every `return` in this directory goes
 * through here, including refusals.
 */
export function applyResponseGuard(response: Response, opts: GuardOptions): Response {
  const owned = new Set(
    (response.headers.get(GATEWAY_OWNED_HEADER) ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
  );
  const keepCookies = owned.has("set-cookie") ? response.headers.getSetCookie() : [];

  const headers = new Headers();
  response.headers.forEach((value, rawName) => {
    const name = rawName.toLowerCase();
    if (name === GATEWAY_OWNED_HEADER) return;
    // set-cookie is never copied by iteration (it can repeat); owned ones are
    // re-appended from getSetCookie() below.
    if (name === "set-cookie") return;
    if (STRIPPED(name) && !owned.has(name)) return;
    headers.set(name, value);
  });
  for (const cookie of keepCookies) headers.append("set-cookie", cookie);

  for (const [name, value] of Object.entries(GATEWAY_SECURITY_HEADERS)) headers.set(name, value);
  headers.set("cache-control", CACHE_CONTROL[opts.cache]);
  if (opts.releaseId) headers.set("x-zenith-release", opts.releaseId);

  const body = BODILESS.has(response.status) ? null : response.body;
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

/** How a gateway-built response is described before the guard finishes it. */
export interface GatewayResponseInit extends GuardOptions {
  status?: number;
  /** Content headers: content-type, etag, content-length, content-range, allow… */
  headers?: Record<string, string>;
  /** A cookie the gateway itself is setting. Survives the strip. */
  setCookie?: string;
  /** A redirect the gateway itself is issuing. Survives the strip. */
  location?: string;
}

/** Build a guarded response. The only constructor the gateway uses. */
export function gatewayResponse(body: BodyInit | null, init: GatewayResponseInit): Response {
  const headers = new Headers(init.headers ?? {});
  const owned: string[] = [];
  if (init.setCookie !== undefined) {
    headers.append("set-cookie", init.setCookie);
    owned.push("set-cookie");
  }
  if (init.location !== undefined) {
    headers.set("location", init.location);
    owned.push("location");
  }
  if (owned.length > 0) headers.set(GATEWAY_OWNED_HEADER, owned.join(","));
  const status = init.status ?? 200;
  const raw = new Response(BODILESS.has(status) ? null : body, { status, headers });
  return applyResponseGuard(raw, { cache: init.cache, releaseId: init.releaseId });
}

/** A guarded JSON response. Always `no-store` unless told otherwise. */
export function gatewayJson(
  value: unknown,
  init: Omit<GatewayResponseInit, "cache"> & { cache?: CacheMode } = {}
): Response {
  return gatewayResponse(JSON.stringify(value), {
    ...init,
    cache: init.cache ?? "no-store",
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers ?? {}) },
  });
}

/** A guarded HTML response. Always `no-store`: these pages are per-recipient. */
export function gatewayHtml(
  html: string,
  init: Omit<GatewayResponseInit, "cache"> & { cache?: CacheMode } = {}
): Response {
  return gatewayResponse(html, {
    ...init,
    cache: init.cache ?? "no-store",
    headers: { "content-type": "text/html; charset=utf-8", ...(init.headers ?? {}) },
  });
}

/** A guarded 303, the only redirect the gateway issues. */
export function gatewaySeeOther(
  location: string,
  init: Omit<GatewayResponseInit, "cache" | "location" | "status"> = {}
): Response {
  return gatewayResponse(null, { ...init, status: 303, location, cache: "no-store" });
}
