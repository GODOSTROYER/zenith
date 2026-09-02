/**
 * Auth copy, kept pure so it can be tested without a browser.
 *
 * Two different sources of failure, two different rules:
 *  - supabase-js errors reach us in-process, so `explain` may quote them —
 *    but it always ends by naming a fix.
 *  - `?error=` reaches us from a redirect, so it is never quoted. The
 *    callback route puts a *code* there; anything else falls back to one
 *    fixed sentence.
 */

/** Codes `/auth/callback` may put in `?error=`. Nothing else is honoured. */
export const AUTH_ERROR_CODES: Record<string, string> = {
  link_expired:
    "That link has expired or was already used. Request a fresh one below — links last an hour.",
  link_missing_code:
    "That link is missing its confirmation code. Open the most recent email, or request a fresh link below.",
  link_failed:
    "That link could not be completed. Request a fresh one below and open it in this browser.",
  oauth_denied:
    "That sign-in was cancelled before it finished. Try it again and approve the permission prompt, or sign in with your email and password below.",
  oauth_unavailable:
    "The provider could not complete that sign-in. Try again in a moment, or use your email and password below. If it keeps failing, that provider is probably not enabled on this project — an operator turns it on under Authentication → Providers in the Supabase dashboard.",
};

/** Shown for an `?error=` we do not recognise. Never includes the raw value. */
export const AUTH_ERROR_FALLBACK =
  "That link could not be completed. Request a fresh one below and open it in this browser.";

/** `?error=` → copy. Unknown codes get fixed copy; the param is never rendered. */
export function messageForErrorCode(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  return AUTH_ERROR_CODES[raw] ?? AUTH_ERROR_FALLBACK;
}

/**
 * Supabase's callback error → a stable code, so no provider text enters the URL.
 *
 * The OAuth tests come first on purpose: a provider's `invalid_request` or
 * `unauthorized_client` would otherwise be read as an expired email link and
 * tell the user to request a fresh one that does not exist.
 */
export function callbackErrorCode(message: string | undefined): keyof typeof AUTH_ERROR_CODES {
  const m = (message ?? "").toLowerCase();
  if (m.includes("missing its confirmation code")) return "link_missing_code";
  if (m.includes("denied") || m.includes("cancel")) return "oauth_denied";
  if (
    m.includes("provider") ||
    m.includes("server_error") ||
    m.includes("temporarily_unavailable") ||
    m.includes("unauthorized_client")
  )
    return "oauth_unavailable";
  if (m.includes("expired") || m.includes("invalid") || m.includes("already")) return "link_expired";
  return "link_failed";
}

/** True when the account exists but the address was never confirmed. */
export function isUnconfirmedEmail(message: string): boolean {
  return message.toLowerCase().includes("email not confirmed");
}

/** Translate Supabase auth errors into calm, fix-naming copy. */
export function explain(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid login credentials"))
    return "That email and password do not match. Check both, or reset your password below.";
  if (isUnconfirmedEmail(message))
    return "Confirm your email first — the link is in your inbox. Then sign in again.";
  if (m.includes("already registered") || m.includes("already exists"))
    return "An account with that email already exists. Sign in instead, or reset the password.";
  if (m.includes("password") && m.includes("least"))
    return "Password is too short — use at least 8 characters.";
  if (m.includes("rate limit") || m.includes("too many"))
    return "Too many attempts in a row. Wait a minute, then try again.";
  if (m.includes("fetch") || m.includes("network"))
    return "Could not reach the auth server. Is Supabase running? Check NEXT_PUBLIC_SUPABASE_URL and retry.";
  return `${message}. Try once more — if it keeps happening, check that NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local match your project, then restart the dev server.`;
}
