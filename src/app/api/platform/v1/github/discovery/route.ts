/** Actor-owned, expiring metadata picker. OAuth tokens never enter storage or responses. */
import { platformDb } from "@/lib/controlplane/db/open";
import { route } from "@/lib/server/request";
import { createGithubApp, githubAppConfig } from "@/lib/sources/github/app";
import { createGithubSourceStore, digest, githubReturnTo } from "@/lib/sources/github/store";
import { GithubSourceError, numericId } from "@/lib/sources/github/types";
import { browserCaller, callbackUrl, cookieOptions, currentAdminMutation, safeFailure, GITHUB_INSTALL_COOKIE } from "../_lib/admin";
import { jsonResponse, onlyKeys, readSmallJson } from "../_lib/json";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route({ workspaceRole: "admin" }, async req => {
  const caller = await browserCaller(req, false);
  try {
    const params = req.nextUrl.searchParams;
    if ([...params.keys()].some(k => !["session", "q", "cursor"].includes(k) || params.getAll(k).length !== 1)) throw new GithubSourceError("invalid");
    const q = (params.get("q") ?? "").trim().toLowerCase(), cursor = params.get("cursor") ?? "0";
    if (q.length > 140 || !/^(0|[1-9]\d{0,3})$/.test(cursor)) throw new GithubSourceError("invalid");
    const session = await createGithubSourceStore(await platformDb()).getDiscovery(caller.workspaceId, caller.principal.id, params.get("session") ?? "");
    const repositories = session.repositories.filter(r => `${r.owner}/${r.repo}`.includes(q)).sort((a, b) => `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`));
    const offset = Number(cursor), page = repositories.slice(offset, offset + 50);
    return jsonResponse({ repositories: page, nextCursor: offset + page.length < repositories.length ? String(offset + page.length) : null, expiresAt: session.expiresAt, truncated: session.truncated });
  } catch (error) { return safeFailure(error); }
});

export const POST = route({ workspaceRole: "admin" }, async req => {
  const caller = await browserCaller(req, true);
  try {
    const body = await readSmallJson(req);
    onlyKeys(body, ["session", "repositoryId", "returnTo"]);
    const config = githubAppConfig();
    if (!config?.clientId || !/^[A-Za-z0-9._-]{1,100}$/.test(config.clientId) || !config.clientSecretFile) throw new GithubSourceError("unavailable");
    const callback = callbackUrl(req);
    const returnTo = githubReturnTo(body.returnTo);
    if (body.session === undefined && body.repositoryId === undefined) {
      const intent = await currentAdminMutation(req, caller, true, store => store.beginDiscovery(caller.workspaceId, caller.principal.id));
      const installUrl = await createGithubApp(config).installUrl(intent.state, req.signal);
      const out = jsonResponse({ installUrl });
      out.cookies.set(GITHUB_INSTALL_COOKIE, intent.browserProof, cookieOptions(req));
      return out;
    }
    if (typeof body.session !== "string") throw new GithubSourceError("invalid");
    const repositoryId = numericId(body.repositoryId);
    const session = await createGithubSourceStore(await platformDb()).getDiscovery(caller.workspaceId, caller.principal.id, body.session);
    if (session.appId !== config.appId) throw new GithubSourceError("refused");
    const selected = session.repositories.find(repo => repo.repositoryId === repositoryId);
    if (!selected) throw new GithubSourceError("refused");
    // Discovery is metadata, not durable authority. A fresh user OAuth proof and
    // installation generation check are required before every selected binding.
    const intent = await currentAdminMutation(req, caller, true, async store => {
      const created = await store.begin(caller.workspaceId, caller.principal.id, selected, returnTo ?? "/platform/source");
      await store.authorize({ ...created, workspaceId: caller.workspaceId, actorId: caller.principal.id }, session.installationId, config.appId);
      return created;
    }, { appId: session.appId, installationId: session.installationId, generation: session.installationGeneration });
    const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: callback, state: intent.state,
      code_challenge: Buffer.from(digest(intent.browserProof), "hex").toString("base64url"), code_challenge_method: "S256" });
    const out = jsonResponse({ authorizeUrl: `https://github.com/login/oauth/authorize?${params}` });
    out.cookies.set(GITHUB_INSTALL_COOKIE, intent.browserProof, cookieOptions(req));
    return out;
  } catch (error) { return safeFailure(error); }
});
