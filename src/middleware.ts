import { NextResponse, type NextRequest } from "next/server";
import { hostedRewrite, isPlatformStaticPath } from "@/lib/hosted/edge";
import { updateSession } from "@/lib/supabase/middleware";
import { isAgentSignedPath } from "@/lib/runners/paths";
import { isPlatformBearerRequest, platformAccess } from "@/app/api/platform/v1/_lib/bearer-paths";

export async function middleware(request: NextRequest) {
  const hosted = hostedRewrite(request);
  if (hosted) return hosted;
  if (isPlatformStaticPath(request.nextUrl.pathname)) return NextResponse.next({ request });
  // Only this POST transport authenticates raw bytes with the configured App
  // webhook secret before boot, identity lookup, or platform database access.
  if (platformAccess(request.nextUrl.pathname, request.method) === "webhook-signed") return NextResponse.next({ request });
  // This exact endpoint enforces its own credential and scope on every request.
  // Never let the browser-cookie gate turn it into a login redirect or demo admin.
  // `/agent/link` is deliberately absent — the page must keep getting the
  // `/login?next=…` redirect (src/lib/supabase/middleware.ts:57-70).
  if (["/api/agent/v1/mcp", "/api/agent/v2/mcp", "/api/agent/v3/mcp", "/api/agent/v2/tools", "/api/agent/v2/source",
    "/api/agent/link/start", "/api/agent/link/token",
    // RFC 7009: authorized by possession of the token being revoked, no cookie.
    "/api/agent/oauth/revoke",
    "/.well-known/oauth-protected-resource/api/agent/v2/mcp",
    "/.well-known/oauth-protected-resource/api/agent/v3/mcp",
    // The workload-identity OIDC issuer (ADR-0006): cloud STS services fetch
    // discovery and JWKS anonymously. Public keys only; see src/lib/credentials/oidc.
    "/api/oidc/.well-known/openid-configuration", "/api/oidc/jwks",
  ].includes(request.nextUrl.pathname)) return NextResponse.next({ request });
  // zenith-runner / zenithd endpoints authenticate every request with the
  // agent's Ed25519 request signature (docs/platform/RUNNER-PROTOCOL.md §3);
  // a session cookie means nothing to them. Token creation, revoke and the
  // list routes are NOT in this set and keep the browser gate.
  if (isAgentSignedPath(request.nextUrl.pathname)) return NextResponse.next({ request });
  // Only these method/path pairs accept integrations. Their route wrapper
  // verifies the credential before admission or tenant reads; browser-only
  // approvals, settings writes and runner/machine administration stay gated.
  if (isPlatformBearerRequest(request.nextUrl.pathname, request.method, request.headers.get("authorization"))) {
    return NextResponse.next({ request });
  }
  return updateSession(request);
}
export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
