/**
 * Session refresh + route protection, run by src/middleware.ts on every
 * matched request. Follows the @supabase/ssr contract: getAll/setAll on both
 * the request (so Server Components see the refreshed token) and the
 * response (so the browser stores it). Identity is verified with getClaims()
 * — never getSession() — per Supabase's server-side guidance.
 */
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_PUBLIC_KEY, SUPABASE_URL, isPublicPath, isSupabaseConfigured } from "./env";

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  // Demo mode: no Supabase keys → no auth gate, app behaves as before.
  if (!isSupabaseConfigured()) return NextResponse.next({ request });

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_PUBLIC_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        supabaseResponse = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          supabaseResponse.cookies.set(name, value, options);
        }
      },
    },
  });

  // IMPORTANT: no logic between client creation and getClaims() — it also
  // performs the token refresh that keeps users signed in.
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims);
  const { pathname } = request.nextUrl;

  if (!signedIn && !isPublicPath(pathname)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: { message: "Sign in to use the API.", fix: "Open /login, then retry." } },
        { status: 401, headers: { "cache-control": "no-store" } }
      );
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // Signed-in users skip the auth pages.
  if (signedIn && ["/login", "/signup"].includes(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/overview";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
