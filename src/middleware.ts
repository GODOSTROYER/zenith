import { NextResponse, type NextRequest } from "next/server";
import { hostedRewrite, isPlatformStaticPath } from "@/lib/hosted/edge";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  const hosted = hostedRewrite(request);
  if (hosted) return hosted;
  if (isPlatformStaticPath(request.nextUrl.pathname)) return NextResponse.next({ request });
  // This exact endpoint enforces its own credential and scope on every request.
  // Never let the browser-cookie gate turn it into a login redirect or demo admin.
  if (["/api/agent/v1/mcp", "/api/agent/v2/mcp", "/api/agent/v2/tools", "/api/agent/v2/source", "/.well-known/oauth-protected-resource/api/agent/v2/mcp"].includes(request.nextUrl.pathname)) return NextResponse.next({ request });
  return updateSession(request);
}
export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
