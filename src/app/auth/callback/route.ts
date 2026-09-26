/** Complete PKCE/email authentication and explicit account identity linking. */
import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/auth/destination";
import { resolveAuthDestination } from "@/lib/auth/server-destination";
import { IDENTITY_LINK_COOKIE, readIdentityLinkIntent } from "@/lib/auth/identity-link";
import { callbackErrorCode } from "@/components/auth/messages";
import { getWaitlistAccess } from "@/lib/waitlist/access";

export const dynamic = "force-dynamic";
const EMAIL_TYPES = new Set<EmailOtpType>(["signup", "invite", "magiclink", "recovery", "email_change", "email"]);

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const next = safeNextPath(searchParams.get("next"));
  const linking = searchParams.get("intent") === "link";
  const redirect = (path: string) => {
    const response = NextResponse.redirect(new URL(path, origin));
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    if (linking) response.cookies.set(IDENTITY_LINK_COOKIE, "", {
      httpOnly: true, secure: request.nextUrl.protocol === "https:",
      sameSite: "lax", path: "/auth/callback", maxAge: 0,
    });
    return response;
  };
  const fail = (code: string) => {
    const url = new URL(linking ? "/account" : "/login", origin);
    url.searchParams.set(linking ? "identity_error" : "error", code);
    if (!linking && next) url.searchParams.set("next", next);
    return redirect(url.pathname + url.search);
  };

  try {
    const supabase = await createClient();
    const intent = linking ? readIdentityLinkIntent(request.cookies.get(IDENTITY_LINK_COOKIE)?.value) : null;
    if (linking) {
      if (!intent || intent.state !== searchParams.get("link_state")) return fail("identity_link_expired");
      const { data, error } = await supabase.auth.getUser();
      if (error || data.user?.id !== intent.userId) return fail("identity_link_mismatch");
    }

    // Provider text is untrusted. Redirect only stable message codes, never
    // raw descriptions or URLs supplied by the provider or query string.
    const refused = ["error", "error_code", "error_description"]
      .map((key) => searchParams.get(key)).filter(Boolean).join(" ");
    if (refused) {
      if (linking) return fail(/cancel|denied/i.test(refused) ? "identity_link_cancelled" :
        /already|identity.*exist/i.test(refused) ? "identity_link_conflict" : "identity_link_failed");
      return fail(callbackErrorCode(refused));
    }

    const code = searchParams.get("code");
    const tokenHash = searchParams.get("token_hash");
    const type = searchParams.get("type") as EmailOtpType | null;
    let errorMessage: string | undefined;
    if (code) {
      // Newer Auth clients can keep concurrent PKCE verifiers per flow. Pass
      // the returned identifier so another tab cannot replace this verifier.
      const flowId = intent?.flowId ?? searchParams.get("sb_flow_id");
      const { error } = flowId
        ? await supabase.auth.exchangeCodeForSession(code, { flowId })
        : await supabase.auth.exchangeCodeForSession(code);
      errorMessage = error?.message;
    } else if (!linking && tokenHash && type && EMAIL_TYPES.has(type)) {
      const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
      errorMessage = error?.message;
    } else {
      errorMessage = "The link is missing its confirmation code — request a fresh one.";
    }
    if (errorMessage) return fail(linking ? "identity_link_failed" : callbackErrorCode(errorMessage));

    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return fail(linking ? "identity_link_failed" : "auth_unavailable");
    if (intent && data.user.id !== intent.userId) {
      // Never continue in an unexpected account if another tab changed the
      // session or a malformed callback exchanged a different identity.
      await supabase.auth.signOut({ scope: "local" });
      return redirect("/login?error=identity_link_mismatch");
    }
    if (intent && !data.user.identities?.some((identity) => identity.provider === intent.provider))
      return fail("identity_link_failed");
    // Admission controls product access, not account recovery. A confirmed
    // reset session must be allowed to finish even while its user is waiting.
    if (!linking && next && new URL(next, origin).pathname === "/reset-password") return redirect(next);
    const access = await getWaitlistAccess({ id: data.user.id, email: data.user.email ?? "" });
    if (!access.allowed) return redirect("/waitlist");
    if (intent) return redirect("/account?identity=linked#sign-in");
    return redirect(await resolveAuthDestination(next));
  } catch {
    return fail(linking ? "identity_link_failed" : "auth_unavailable");
  }
}
