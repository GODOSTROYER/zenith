/**
 * Auth callback: completes email confirmation, magic links and password
 * resets (and OAuth later). Handles both the PKCE `code` form and the
 * `token_hash` + `type` form Supabase uses in email templates.
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

  let errorMessage: string | undefined;
  if (code) {
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
