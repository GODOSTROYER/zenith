/**
 * Edge-side host split for hosted apps. Runs inside `src/middleware.ts` on
 * every request, before the Supabase session gate.
 *
 * A request whose Host names an app (`<slug>.<ZENITH_APP_DOMAIN>`) is rewritten
 * to the gateway route handler and never sees the platform session logic: no
 * `sb-*` cookie is read, no login redirect is issued, no platform credential
 * travels to an app origin. Everything else passes through untouched.
 *
 * Edge runtime: no `node:` imports, no store, no config module — only
 * `process.env` and the pure host rules from the contracts.
 */
import { NextResponse, type NextRequest } from "next/server";
import { gatewayPath, slugFromHost } from "@/lib/hosted/contracts/hosts";

const DEFAULT_APP_DOMAIN = "apps.localhost";

/** The app domain the edge uses; mirrors `hostedConfig().ZENITH_APP_DOMAIN`. */
export const edgeAppDomain = (): string =>
  (process.env.ZENITH_APP_DOMAIN ?? "").trim().toLowerCase() || DEFAULT_APP_DOMAIN;

/**
 * Rewrite an app-host request onto the gateway, or return null when this is a
 * control-origin request. The original Host header is preserved by the
 * rewrite, so the gateway re-derives the app from it rather than trusting the
 * path segment alone.
 */
export function hostedRewrite(request: NextRequest): NextResponse | null {
  const host = request.headers.get("host");
  const slug = slugFromHost(host, edgeAppDomain());
  if (!slug || !host) return null;
  const url = request.nextUrl.clone();
  url.pathname = gatewayPath(host, request.nextUrl.pathname);
  const res = NextResponse.rewrite(url);
  // Sensitive by default; the gateway relaxes this for hashed assets only.
  res.headers.set("cache-control", "no-store");
  return res;
}

/**
 * Paths the platform serves as plain files and must not gate behind sign-in:
 * the favicon, the bundled fonts and image files. This used to live in the
 * middleware matcher; it moved here so app hosts (which need their own
 * `.svg`/`.png` assets admitted by the gateway) still reach the middleware.
 */
export const isPlatformStaticPath = (pathname: string): boolean =>
  pathname === "/favicon.ico" ||
  /^\/fonts\/[^/]+\.woff2$/.test(pathname) ||
  /\.(?:svg|png|jpg|jpeg|gif|webp|ico)$/.test(pathname);
