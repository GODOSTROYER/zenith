/**
 * Switch the workspace this browser is in.
 *
 *   POST /api/workspace/select  body { workspaceId } → { workspace }
 *
 * The cookie is httpOnly and set only here, only after checking membership —
 * and `requireWorkspace()` re-checks membership on every read, so the cookie
 * is a preference the server can ignore, never a capability.
 */
import { z } from "zod";
import {
  ApiError,
  WORKSPACE_COOKIE,
  currentRequest,
  json,
  route,
  workspacesFor,
} from "@/lib/server/context";

export const dynamic = "force-dynamic";

const Body = z.object({ workspaceId: z.string().trim().min(1) });

/** A year: switching workspaces is not a session, it is where you work. */
const MAX_AGE = 365 * 24 * 60 * 60;

export const POST = route(async (req) => {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    throw new ApiError("That request did not name a workspace.", 400, {
      fix: 'Send { "workspaceId": "<id>" }. GET /api/bootstrap lists the ones you belong to as `workspaces`.',
    });

  const mine = workspacesFor(currentRequest()?.user ?? null);
  const workspace = mine.find((w) => w.id === parsed.data.workspaceId);
  // One answer for "no such workspace" and "not yours", so ids are not
  // enumerable — the same reason the id-lookup routes 404 instead of 403.
  if (!workspace)
    throw new ApiError(`You are not a member of workspace "${parsed.data.workspaceId}".`, 403, {
      fix: mine.length
        ? `Switch to one you belong to: ${mine.map((w) => `${w.name} (${w.id})`).join(", ")}.`
        : "Ask an admin of that workspace to invite you from Settings → Members, or create your own at /onboarding.",
    });

  const res = json({ workspace });
  res.cookies.set(WORKSPACE_COOKIE, workspace.id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
    secure: process.env.NODE_ENV === "production",
  });
  return res;
});
