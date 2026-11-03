/**
 * GET  /api/platform/v1/github/binding  current source binding state (human admin browser).
 * POST /api/platform/v1/github/binding  { repository: "owner/name" } begins the install flow and
 *      returns the fixed github.com install URL; the PKCE proof rides an httpOnly cookie. The
 *      callback route completes the binding (installation fence, user OAuth, CAS bind).
 * Agent credentials are refused by the browser guard; the response never carries a token.
 */
import { platformDb } from "@/lib/controlplane/db/open";
import { route } from "@/lib/server/request";
import { createGithubApp, githubAppConfig } from "@/lib/sources/github/app";
import { createGithubSourceStore, githubReturnTo } from "@/lib/sources/github/store";
import { GithubSourceError, repository } from "@/lib/sources/github/types";
import { browserCaller, callbackUrl, cookieOptions, currentAdminMutation, safeFailure, GITHUB_INSTALL_COOKIE } from "../_lib/admin";
import { jsonResponse, onlyKeys, readSmallJson } from "../_lib/json";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route({ workspaceRole: "admin" }, async (req) => {
  const caller = await browserCaller(req, false);
  try {
    if (req.nextUrl.searchParams.size) throw new GithubSourceError("invalid");
    const database = await platformDb();
    const states = await createGithubSourceStore(database).listStates(caller.workspaceId);
    const counts = await database.query<{ binding_id: string; count: string }>("select binding_id,count(*)::text as count from platform.github_project_sources where workspace_id=$1 and detached_at is null group by binding_id", [caller.workspaceId]);
    const bindings = states.map(current => ({
      bindingId: current.bindingId, owner: current.binding.owner, repo: current.binding.repo, version: current.binding.version,
      repositoryId: current.binding.repositoryId, installationId: current.binding.installationId,
      state: current.revoked ? "revoked" : "connected", ...(current.revokedReason ? { revokedReason: current.revokedReason } : {}),
      manageUrl: "https://github.com/settings/installations", affectedProjectCount: Number(counts.find(row => row.binding_id === current.bindingId)?.count ?? 0),
    }));
    let appConfigured = false;
    try { appConfigured = Boolean(githubAppConfig()?.clientId); } catch { appConfigured = false; }
    return jsonResponse({ appConfigured, bindings, binding: bindings.length === 1 ? bindings[0] : null });
  } catch (error) { return safeFailure(error); }
});

export const POST = route({ workspaceRole: "admin" }, async (req) => {
  const caller = await browserCaller(req, true);
  try {
    const body = await readSmallJson(req);
    onlyKeys(body, ["repository", "returnTo"]);
    if (typeof body.repository !== "string") throw new GithubSourceError("invalid");
    const parts = body.repository.split("/");
    if (parts.length !== 2) throw new GithubSourceError("invalid");
    const repo = repository(parts[0], parts[1]);
    const config = githubAppConfig();
    if (!config?.clientId || !/^[A-Za-z0-9._-]{1,100}$/.test(config.clientId) || !config.clientSecretFile) throw new GithubSourceError("unavailable");
    callbackUrl(req);
    const intent = await currentAdminMutation(req, caller, true, current => current.begin(caller.workspaceId, caller.principal.id, repo, githubReturnTo(body.returnTo)));
    const installUrl = await createGithubApp(config).installUrl(intent.state, req.signal);
    const out = jsonResponse({ installUrl });
    out.cookies.set(GITHUB_INSTALL_COOKIE, intent.browserProof, cookieOptions(req));
    return out;
  } catch (error) { return safeFailure(error); }
});
