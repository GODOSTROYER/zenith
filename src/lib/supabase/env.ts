/**
 * Supabase configuration, read once. Auth is optional: with no keys present
 * Orrery runs in local demo mode exactly as before (single local "You"),
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

/** Public routes that never require a session. Everything else does. */
export const PUBLIC_PATHS = [
  "/",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/auth",
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
