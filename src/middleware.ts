import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Everything except static assets and image optimization.
  //
  // The dots are `\\.` so the regex sees `\.`: with a single backslash the
  // string literal drops it, the dot matches any character, and every path
  // ending in "-png" / "_svg" / "xico" (e.g. /p/design-png) skipped the gate.
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|fonts/[^/]+\\.woff2$|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
