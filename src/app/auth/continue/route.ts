/**
 * `/auth/continue?next=…` — "I am already signed in; where do I belong?"
 *
 * The middleware runs at the edge, where there is no member table to read, so
 * it cannot tell a brand-new account from a returning one. Instead of guessing
 * `/overview` it sends an already-signed-in visitor of `/login` or `/signup`
 * here, where `destinationAfterAuth` can ask the one question that matters.
 *
 * Signed out, this is just the way back to the sign-in page — never a 401: it
 * is a navigation, not an API call.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { safeNextPath } from "@/lib/auth/destination";
import { destinationAfterAuth } from "@/lib/server/workspace";
import { isSupabaseConfigured } from "@/lib/supabase/env";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const next = searchParams.get("next");

  if (isSupabaseConfigured() && !(await getSessionUser())) {
    const url = new URL("/login", origin);
    const safe = safeNextPath(next);
    if (safe) url.searchParams.set("next", safe);
    return NextResponse.redirect(url);
  }
  return NextResponse.redirect(new URL(await destinationAfterAuth(next), origin));
}
