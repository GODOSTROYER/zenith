import { NextResponse, type NextRequest } from "next/server";
import { hostedRewrite, isPlatformStaticPath } from "@/lib/hosted/edge";
import { updateSession } from "@/lib/supabase/middleware";

/**
 * Three decisions, in order:
 *
 *  1. An app host (`<slug>.<ZENITH_APP_DOMAIN>`) is rewritten to the hosted
 *     gateway and never reaches the platform session logic — no platform
 *     cookie is read on an app origin, no login redirect leaks the control
 *     origin's shape, and every path (HTML, assets, HEAD, Range) is admitted
 *     by the gateway rather than by a matcher exclusion.
 *  2. The platform's own static files (favicon, bundled fonts, images) pass
 *     through without a session check, exactly as the old matcher exclusion
 *     did — that exclusion moved into code so app-host asset requests still
 *     reach step 1.
 *  3. Everything else is the Supabase session refresh + route protection.
 */
export async function middleware(request: NextRequest) {
  const hosted = hostedRewrite(request);
  if (hosted) return hosted;
  if (isPlatformStaticPath(request.nextUrl.pathname)) return NextResponse.next({ request });
  return updateSession(request);
}

export const config = {
  // Everything except Next's own static chunks and image optimization. Image
  // extensions and fonts are no longer excluded here — see step 2 above —
  // because an app host must have its `.svg`/`.png` assets gated too.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
