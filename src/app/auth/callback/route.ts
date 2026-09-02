/**
 * Auth callback: completes email confirmation, magic links, password resets
 * and OAuth sign-in. Handles both the PKCE `code` form (email links and every
 * OAuth provider) and the `token_hash` + `type` form Supabase uses in email
 * templates.
 *
 * A refused or failed OAuth handshake arrives here with no code at all — just
 * Supabase's `error*` params — so those are read first. Otherwise a user who
 * pressed "Cancel" at GitHub would be told to request a fresh email link.
 */
import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { callbackErrorCode } from "@/components/auth/messages";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const next = searchParams.get("next") ?? "/overview";
  // Only ever redirect within this origin.
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/overview";
  const supabase = await createClient();

  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  /** What the provider/Supabase said went wrong. Mapped to a code, never rendered. */
  const refused = ["error", "error_code", "error_description"]
    .map((k) => searchParams.get(k))
    .filter(Boolean)
    .join(" ");

  let errorMessage: string | undefined;
  if (refused) {
    errorMessage = refused;
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    errorMessage = error?.message;
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    errorMessage = error?.message;
  } else {
    errorMessage = "The link is missing its confirmation code — request a fresh one.";
  }

  if (errorMessage) {
    // A code, never the provider's text: the sign-in page must not render
    // anything an attacker can put in a link.
    const url = new URL("/login", origin);
    url.searchParams.set("error", callbackErrorCode(errorMessage));
    return NextResponse.redirect(url);
  }
  return NextResponse.redirect(new URL(safeNext, origin));
}
