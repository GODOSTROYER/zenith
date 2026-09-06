/**
 * Session refresh + route protection, run by src/middleware.ts on every
 * matched request. Follows the @supabase/ssr contract: getAll/setAll on both
 * the request (so Server Components see the refreshed token) and the
 * response (so the browser stores it). Identity is verified with getClaims()
 * — never getSession() — per Supabase's server-side guidance.
 */
import { createServerClient } from "@supabase/ssr";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_PUBLIC_KEY, SUPABASE_URL, isPublicPath, isSupabaseConfigured } from "./env";

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  // Demo mode: no Supabase keys → no auth gate, app behaves as before.
  if (!isSupabaseConfigured()) return NextResponse.next({ request });

  let supabaseResponse = NextResponse.next({ request });
  const withSessionCookies = (response: NextResponse): NextResponse => {
    for (const cookie of supabaseResponse.cookies.getAll()) response.cookies.set(cookie);
    return response;
  };

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_PUBLIC_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        supabaseResponse = withSessionCookies(NextResponse.next({ request }));
        for (const { name, value, options } of cookiesToSet) {
          supabaseResponse.cookies.set(name, value, options);
        }
      },
    },
  });

  // IMPORTANT: no logic between client creation and getClaims() — it also
  // performs the token refresh that keeps users signed in.
  const { data, error } = await supabase.auth.getClaims();
  if (error) {
    console.warn("[auth] Session verification failed", {
      name: error.name,
      code: error.code,
      status: error.status,
    });
  }
  const unavailable = isAuthRetryableFetchError(error);
  const signedIn = Boolean(data?.claims);
  const { pathname } = request.nextUrl;

  if (!signedIn && !isPublicPath(pathname)) {
    if (pathname.startsWith("/api/")) {
      return withSessionCookies(NextResponse.json(
        { error: { message: "Sign in to use the API.", fix: "Open /login, then retry." } },
        { status: 401, headers: { "cache-control": "no-store" } }
      ));
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    if (unavailable) url.searchParams.set("error", "auth_unavailable");
    return withSessionCookies(NextResponse.redirect(url));
  }

  // Signed-in users skip the auth pages.
  if (signedIn && ["/login", "/signup"].includes(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/overview";
    url.search = "";
    return withSessionCookies(NextResponse.redirect(url));
  }

  return supabaseResponse;
}
