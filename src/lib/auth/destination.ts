/**
 * Where a person lands after they authenticate — one rule, every door.
 *
 * Email confirmation, a password sign-in, a magic link and an OAuth return all
 * used to hard-code `/overview`, so the account that had nothing to look at yet
 * was sent to the screen that is empty for exactly that reason. The signal for
 * "new" is membership, not a stored flag: `workspacesFor` already answers it,
 * `/api/me` already publishes it, and the landing CTA already branches on it.
 *
 * Three cases, in this order:
 *
 *  1. A `next` that *is* the rest of an auth flow — the reset-password page, an
 *     app invitation, onboarding itself — is honoured whatever the account
 *     looks like. Resetting a password must not be interrupted by a setup
 *     wizard, and an invitation link is the whole reason that person signed in.
 *  2. No workspace membership → `/onboarding`. A workspace invite has already
 *     been turned into a membership by `ensureMember` before this is asked, so
 *     an invited person reads as a member here, not as a new account.
 *  3. A member goes to their requested `next`, else `/overview` — so a
 *     returning user is never sent to onboarding.
 *
 * This module is pure: no env, no store, no `next/*`. The browser, the auth
 * callback and the middleware's resolver all import the same function.
 */

export const ONBOARDING = "/onboarding";
export const OVERVIEW = "/overview";

/** Paths that are themselves the continuation of an auth flow (case 1). */
const FLOW_PATHS = [ONBOARDING, "/reset-password", "/apps/accept"] as const;

/**
 * Pages that exist to get a session. Honouring one as `next` would hand the
 * caller straight back to the door they just came through.
 */
const AUTH_PAGES = ["/login", "/signup", "/forgot-password", "/auth"] as const;

const underPrefix = (path: string, prefixes: readonly string[]): boolean =>
  prefixes.some((p) => path === p || path.startsWith(`${p}/`));

/**
 * A `next` we are willing to redirect to: a same-origin path, never another
 * origin wearing a path's clothes (`//host`, `/\host`), never an auth page.
 * Returns undefined for anything else, so the caller falls back to the default.
 */
export function safeNextPath(next: string | null | undefined): string | undefined {
  if (typeof next !== "string") return undefined;
  const value = next.trim();
  if (!value.startsWith("/")) return undefined;
  if (/^\/[/\\]/.test(value)) return undefined;
  if (underPrefix(value.split(/[?#]/)[0], AUTH_PAGES)) return undefined;
  return value;
}

export interface DestinationInput {
  /** Does this account belong to at least one workspace? (`workspacesFor`) */
  hasWorkspace: boolean;
  /** The `next` the caller asked for, unvalidated. */
  next?: string | null;
}

/** The one post-authentication destination decision. */
export function postAuthDestination({ hasWorkspace, next }: DestinationInput): string {
  const requested = safeNextPath(next);
  if (requested && underPrefix(requested.split(/[?#]/)[0], FLOW_PATHS)) return requested;
  if (!hasWorkspace) return ONBOARDING;
  return requested ?? OVERVIEW;
}

/**
 * The same decision for the browser, which cannot read the member table: it
 * asks `/api/me`, the endpoint that already publishes `hasWorkspace`.
 *
 * A failed probe answers as if the account has a workspace. "Unknown" is not
 * "new": sending a returning user to a setup wizard because one fetch failed
 * would be a worse wrong answer than the extra click the old behaviour cost.
 */
export async function destinationAfterSignIn(next?: string | null): Promise<string> {
  try {
    const res = await fetch("/api/me", { cache: "no-store" });
    if (!res.ok) throw new Error(`/api/me answered ${res.status}`);
    const me = (await res.json()) as { hasWorkspace?: unknown };
    return postAuthDestination({ hasWorkspace: me.hasWorkspace === true, next });
  } catch {
    return postAuthDestination({ hasWorkspace: true, next });
  }
}
