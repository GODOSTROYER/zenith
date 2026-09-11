/**
 * Which workspace a request acts in, and who may act in it.
 *
 * The selection cookie is httpOnly, so only the server writes it — and only
 * `POST /api/workspace/select`, after checking that the caller is a member. It
 * is a preference, never an authorisation: every read re-checks membership, so
 * a stale cookie from a previous sign-in is ignored rather than obeyed.
 *
 * Split out of `server/context.ts`, which re-exports everything here.
 */
import { db } from "@/lib/db/store";
import type { Workspace } from "@/lib/domain/types";
import { getSessionUser, type SessionUser } from "@/lib/auth/session";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { ApiError } from "@/lib/server/errors";
import { ensureMember } from "@/lib/server/membership";
import { currentRequest } from "@/lib/server/request";
import type { SseGuard } from "@/lib/server/sse";

export const WORKSPACE_COOKIE = "orrery-workspace";

/**
 * Workspaces this caller may act in. Demo mode (no Supabase keys) is one local
 * user who is in all of them; a signed-in user is in the ones they belong to,
 * matched by id or by the email an invite named before they first signed in.
 */
export function workspacesFor(user: SessionUser | null): Workspace[] {
  const d = db();
  if (!user) return isSupabaseConfigured() ? [] : d.workspaces;
  const email = user.email.toLowerCase();
  const mine = new Set(
    d.members
      .filter((m) => m.id === user.id || m.email.toLowerCase() === email)
      .map((m) => m.workspaceId)
  );
  return d.workspaces.filter((w) => mine.has(w.id));
}

/** Cookie if it still names a workspace the caller belongs to, else their first. */
export const pickWorkspace = (
  cookie: string | undefined,
  user: SessionUser | null
): Workspace | undefined => {
  const allowed = workspacesFor(user);
  return allowed.find((w) => w.id === cookie) ?? allowed[0];
};

const noWorkspace = (user: SessionUser | null): ApiError =>
  db().workspaces.length === 0
    ? new ApiError("No workspace exists yet.", 404, {
        fix: "Complete onboarding at /onboarding, or run `npm run seed`.",
      })
    : new ApiError(`${user?.email || "You"} are not a member of any workspace here.`, 404, {
        fix: "Ask an admin of the workspace you should be in to invite you from Settings → Members, or create your own at /onboarding.",
      });

/**
 * The workspace this request acts in. Every scoped read and write goes through
 * here, so there is one answer per request and no route can pick a different
 * one. Routes never create a workspace implicitly.
 */
export function requireWorkspace(): Workspace {
  const state = currentRequest();
  if (state) {
    if (state.workspace) return state.workspace;
    // "Nothing exists yet" is a 404 for everybody; only once something does is
    // being kept out of it a refusal, and then the denial names who can let
    // this caller in.
    if (state.denial && db().workspaces.length)
      throw new ApiError(state.denial.message, 403, { fix: state.denial.fix });
    throw noWorkspace(state.user);
  }
  // Outside a route handler: a script, a test, or a server component that
  // should be calling `currentWorkspace()`. Demo mode is one local user in one
  // workspace, so the first one is the only answer there is; with auth
  // configured there is a real caller to resolve and guessing would leak.
  const w = db().workspaces[0];
  if (!w || isSupabaseConfigured()) throw noWorkspace(null);
  return w;
}

/**
 * A membership answer that keeps answering, for requests that outlive `route()`.
 *
 * `requireWorkspace()` resolves once, before the handler runs. That is the
 * whole truth for a request measured in milliseconds and a lie for an SSE
 * connection held open for hours: without this, removing someone from a
 * workspace would stop their next request while their live stream kept
 * delivering payloads until they chose to disconnect. So every stream carries
 * one of these and `sseResponse` re-asks it on every push and heartbeat.
 *
 * The closure captures who and where at connect and re-reads the member table
 * each time — it never touches the request scope, so it is safe to call long
 * after the handler returned. It reuses `workspacesFor` rather than restating
 * the membership rule, at the cost of one filter per poll; that is cheaper than
 * two copies of the rule drifting apart.
 */
export function membershipCheck(): SseGuard {
  const workspace = requireWorkspace();
  const user = currentRequest()?.user ?? null;
  // Demo mode and the Navigator have no member row to lose: one local user, in
  // every workspace, for as long as the process runs.
  if (!user) return () => undefined;
  return () =>
    workspacesFor(user).some((w) => w.id === workspace.id)
      ? undefined
      : {
          message: `Your membership in ${workspace.name} ended, so this stream stopped.`,
          fix: `Ask an admin of ${workspace.name} to invite you back, then reload the page.`,
        };
}

/**
 * The same resolution for server components and server actions, which have
 * `cookies()` instead of a NextRequest. `next/headers` is imported lazily: the
 * /api layer and the tests import this module and must not drag it in.
 */
export async function currentWorkspace(): Promise<Workspace | undefined> {
  const user = await getSessionUser();
  if (user) ensureMember(user);
  return pickWorkspace(await workspaceCookie(), user);
}

/** The selection cookie, or undefined outside a request scope (a unit test). */
async function workspaceCookie(): Promise<string | undefined> {
  try {
    const { cookies } = await import("next/headers");
    return (await cookies()).get(WORKSPACE_COOKIE)?.value;
  } catch {
    return undefined;
  }
}
