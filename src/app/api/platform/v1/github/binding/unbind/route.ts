/**
 * POST /api/platform/v1/github/binding/unbind  { version }
 * Explicit unbind: compare-and-set revocation of the workspace binding (audit event reason
 * user_unbind), pending install intents deleted. New source acquisition and builds are
 * blocked immediately; existing deployments keep running; the GitHub App installation stays in
 * GitHub (uninstalling there arrives as a signed webhook and revokes the same way).
 */
import { route } from "@/lib/server/request";
import { numericId } from "@/lib/sources/github/types";
import { browserCaller, cookieOptions, currentAdminMutation, safeFailure, GITHUB_INSTALL_COOKIE } from "../../_lib/admin";
import { jsonResponse, onlyKeys, readSmallJson } from "../../_lib/json";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = route({ workspaceRole: "admin" }, async (req) => {
  const caller = await browserCaller(req, true);
  try {
    const body = await readSmallJson(req);
    onlyKeys(body, ["version"]);
    const expectedVersion = numericId(body.version);
    await currentAdminMutation(req, caller, true, current => current.revoke({ workspaceId: caller.workspaceId, actorId: caller.principal.id, expectedVersion }));
    const out = jsonResponse({ state: "revoked" });
    out.cookies.set(GITHUB_INSTALL_COOKIE, "", { ...cookieOptions(req), maxAge: 0 });
    return out;
  } catch (error) { return safeFailure(error); }
});
