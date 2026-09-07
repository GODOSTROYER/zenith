/**
 * Supabase configuration, read once. Auth is optional: with no keys present
 * Zenith.ai runs in local demo mode exactly as before (single local "You"),
 * and every auth surface says so honestly instead of breaking.
 *
 * Supports both the current publishable-key variable and the legacy anon-key
 * name so a cloud project or `supabase start` output can be pasted as-is.
 */
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_PUBLIC_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  "";

/** True when the public client can be constructed. Safe to call anywhere. */
export const isSupabaseConfigured = (): boolean =>
  Boolean(SUPABASE_URL && SUPABASE_PUBLIC_KEY);

/* ---------------------------- OAuth providers ----------------------------- */

/** The providers Zenith.ai knows how to label. A name outside this list gets no button. */
export const KNOWN_OAUTH_PROVIDERS = ["github", "google"] as const;
export type OAuthProvider = (typeof KNOWN_OAUTH_PROVIDERS)[number];

/** Button copy, so no provider name is ever built by string-casing. */
export const OAUTH_PROVIDER_LABEL: Record<OAuthProvider, string> = {
  github: "GitHub",
  google: "Google",
};

/**
 * Which OAuth buttons to render — configuration, never a guess. Enabling a
 * provider is a Supabase dashboard action (Authentication → Providers), so a
 * button the operator has not listed here would open a provider the project
 * cannot complete. Unknown names are dropped with a warning rather than
 * rendered: a typo should be visible in the console, not a dead button.
 */
export function parseOAuthProviders(raw: string | undefined | null): OAuthProvider[] {
  const known: readonly string[] = KNOWN_OAUTH_PROVIDERS;
  const out = new Set<OAuthProvider>();
  for (const part of (raw ?? "").split(",")) {
    const name = part.trim().toLowerCase();
    if (!name) continue;
    if (!known.includes(name)) {
      console.warn(
        `Ignoring unknown OAuth provider "${name}" in NEXT_PUBLIC_SUPABASE_OAUTH_PROVIDERS. ` +
          `Known providers: ${known.join(", ")}. Fix the spelling or drop the name.`
      );
      continue;
    }
    out.add(name as OAuthProvider);
  }
  return [...out];
}

/** Read once. The literal `process.env.NEXT_PUBLIC_…` is what Next inlines. */
export const SUPABASE_OAUTH_PROVIDERS = parseOAuthProviders(
  process.env.NEXT_PUBLIC_SUPABASE_OAUTH_PROVIDERS
);

/** Public routes that never require a session. Everything else does. */
export const PUBLIC_PATHS = [
  "/",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/auth",
  // The landing call to action asks who is here; it must answer signed-out too.
  "/api/me",
  // The hosted edge worker's admission call: authenticated by a shared
  // bearer secret inside the handler, never by a browser session.
  "/api/hosted/policy",
] as const;

/**
 * The one public page under /preview: the sandbox activation page you land on
 * from a deploy's URL. The whole prefix used to be public, so any future route
 * under it would have been born unauthenticated.
 */
const PREVIEW_PAGE = /^\/preview\/[^/]+\/[^/]+$/;

export function isPublicPath(pathname: string): boolean {
  return (
    PUBLIC_PATHS.some((p) => pathname === p || (p !== "/" && pathname.startsWith(`${p}/`))) ||
    PREVIEW_PAGE.test(pathname)
  );
}
