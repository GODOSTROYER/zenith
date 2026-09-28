import { safeNextPath } from "./destination";

/** Keep invitation and recovery continuations through OAuth and email confirmation. */
export function authCallbackUrl(origin: string, next?: string | null): string {
  const callback = new URL("/auth/callback", origin);
  const safe = safeNextPath(next);
  if (safe) callback.searchParams.set("next", safe);
  return callback.toString();
}

/** Carry a safe destination when switching between sign-in, signup, recovery and the waitlist. */
export function authPageUrl(path: "/login" | "/signup" | "/forgot-password" | "/reset-password" | "/waitlist", next?: string | null): string {
  const safe = safeNextPath(next);
  return safe ? `${path}?next=${encodeURIComponent(safe)}` : path;
}
