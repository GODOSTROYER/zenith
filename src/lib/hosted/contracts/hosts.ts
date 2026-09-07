/**
 * App-host naming — pure string rules shared by the edge middleware, the
 * gateway and the control API. No imports, so the edge runtime can use it.
 *
 * SPINE FILE — owned by the integrator. Import from `@/lib/hosted/contracts`.
 */

/** Slug rule: lowercase, 3–40 chars, starts and ends alphanumeric, hyphens inside. */
export const APP_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

/** Names that would collide with platform or well-known hosts. */
export const RESERVED_SLUGS = new Set([
  "www",
  "api",
  "app",
  "apps",
  "admin",
  "auth",
  "login",
  "mail",
  "smtp",
  "static",
  "assets",
  "cdn",
  "control",
  "zenith",
  "orrery",
  "localhost",
  "test",
]);

export const isValidAppSlug = (slug: string): boolean =>
  APP_SLUG_RE.test(slug) && !RESERVED_SLUGS.has(slug);

/**
 * The slug an incoming Host header names, or null when the host is not an
 * app host under `appDomain`. Ports are ignored; case is folded. A host with
 * more than one label before the domain is not an app host.
 */
export function slugFromHost(host: string | null | undefined, appDomain: string): string | null {
  if (!host) return null;
  const bare = host.trim().toLowerCase().replace(/:\d+$/, "");
  const suffix = `.${appDomain.trim().toLowerCase()}`;
  if (!bare.endsWith(suffix)) return null;
  const slug = bare.slice(0, -suffix.length);
  return APP_SLUG_RE.test(slug) ? slug : null;
}

/** The path prefix the middleware rewrites app-host requests onto. */
export const GATEWAY_PREFIX = "/hosted-gateway";

/** Where an app-host request is routed internally: `/hosted-gateway/<host>/<path>`. */
export function gatewayPath(host: string, pathname: string): string {
  const bare = host.trim().toLowerCase();
  const rest = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  return `${GATEWAY_PREFIX}/${encodeURIComponent(bare)}${rest ? `/${rest}` : ""}`;
}
