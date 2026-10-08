/** Server-only human step-up. Credentials and execution authority stay with their existing owners. */
import { createServerClient } from "@supabase/ssr";
import type { NextRequest } from "next/server";
import { ApiError } from "@/lib/server/errors";
import { SUPABASE_PUBLIC_KEY, SUPABASE_URL, isSupabaseConfigured } from "@/lib/supabase/env";
import { workspaceMfaControl } from "./mfa-policy";

export const MFA_REQUIRED = "Verify your authenticator before continuing with this privileged action.";
const unavailable = () => new ApiError("MFA could not be verified. This action was refused.", 503, { fix: "Check the identity provider and workspace MFA configuration, then retry." });
const required = () => new ApiError(MFA_REQUIRED, 403, { fix: "Open /account/mfa/challenge, verify your authenticator, then review and submit the action again." });

/**
 * Signature-verified claims AND live provider identity, from this request's cookies.
 * Never trusts getSession(), metadata, headers, role claims or an AAL on another session.
 * No demo bypass. No positive cache. AAL2 is additional to membership/policy/approval.
 */
export async function requireStepUp(req: NextRequest, options: { subject: string; workspaceId?: string; sessionId?: string }): Promise<{ subject: string; aal: "aal2" }> {
  if (req.headers.has("authorization") || req.headers.has("x-zenith-actor") || req.headers.has("x-zenith-actor-key")) throw required();
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase())) {
    const configured = process.env.ZENITH_PLATFORM_ORIGIN ?? process.env.ZENITH_AGENT_ORIGIN;
    const origin = configured ?? new URL(req.url).origin;
    // A malformed configured origin refuses rather than falling back to the request host.
    let validOrigin = false;
    try { validOrigin = new URL(origin).origin === origin; } catch { /* refuse invalid configuration */ }
    if (!validOrigin || req.headers.get("origin") !== origin) throw required();
    const site = req.headers.get("sec-fetch-site");
    if (site !== null && site !== "same-origin") throw required();
  }
  if (!isSupabaseConfigured()) throw unavailable();
  if (!options.subject) throw new ApiError("Sign in again to verify your session.", 401);
  const policy = await workspaceMfaControl(options.workspaceId);
  try {
    const client = createServerClient(SUPABASE_URL, SUPABASE_PUBLIC_KEY, {
      cookies: { getAll: () => req.cookies.getAll(), setAll: () => { /* middleware owns refresh */ } },
    });
    const verified = await client.auth.getClaims();
    if (verified.error) throw unavailable();
    const claims = verified.data?.claims;
    if (!claims || claims.sub !== options.subject || !options.subject) throw new ApiError("Sign in again to verify your session.", 401);
    if (options.sessionId !== undefined && (!options.sessionId || claims.session_id !== options.sessionId)) throw required();
    if (claims.aal !== "aal2") throw required();
    // getClaims verifies expiration; explicitly refuse incomplete provider responses too.
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000) throw required();
    if (policy.maxAgeSeconds !== null) {
      const amr = claims.amr as { method?: unknown; timestamp?: unknown }[] | undefined;
      const times = Array.isArray(amr) ? amr.filter((entry) => entry?.method === "totp" || entry?.method === "mfa").map((entry) => entry.timestamp).filter((at): at is number => typeof at === "number" && Number.isFinite(at)) : [];
      const at = Math.max(...times);
      const now = Date.now() / 1000;
      if (!Number.isFinite(at) || at > now || now - at > policy.maxAgeSeconds) throw required();
    }
    const live = await client.auth.getUser();
    if (live.error) {
      const status = live.error.status;
      if (status !== undefined && status >= 400 && status < 500 && status !== 429) throw new ApiError("Your session has ended. Sign in again.", 401);
      throw unavailable();
    }
    if (live.data.user?.id !== options.subject || !live.data.user.email_confirmed_at) throw new ApiError("Sign in with a verified account to continue.", 401);
    // A removed factor must not keep granting access through an old signed AAL2 token.
    if (!live.data.user.factors?.some((factor) => factor.factor_type === "totp" && factor.status === "verified")) throw required();
    return { subject: options.subject, aal: "aal2" };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // Never expose SDK responses (tokens, codes, provider diagnostics) in errors/logs.
    throw unavailable();
  }
}
