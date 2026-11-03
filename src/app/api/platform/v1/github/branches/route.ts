import { platformDb } from "@/lib/controlplane/db/open";
import { route } from "@/lib/server/request";
import { createGithubApp, githubAppConfig } from "@/lib/sources/github/app";
import { createGithubSourceStore } from "@/lib/sources/github/store";
import { GithubSourceError, identifier } from "@/lib/sources/github/types";
import { browserCaller, safeFailure } from "../_lib/admin";
import { jsonResponse } from "../_lib/json";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route({ workspaceRole: "admin" }, async req => {
  const caller = await browserCaller(req, false);
  try {
    const params = req.nextUrl.searchParams;
    if ([...params.keys()].some(k => !["bindingId", "cursor"].includes(k) || params.getAll(k).length !== 1)) throw new GithubSourceError("invalid");
    const bindingId = identifier(params.get("bindingId") ?? ""), cursor = params.get("cursor") ?? "1";
    if (!/^[1-9]\d{0,3}$/.test(cursor)) throw new GithubSourceError("invalid");
    const store = createGithubSourceStore(await platformDb()), state = await store.getState(caller.workspaceId, { bindingId });
    if (!state || state.revoked) throw new GithubSourceError("refused");
    const config = githubAppConfig();
    if (!config || state.binding.appId !== config.appId) throw new GithubSourceError("unavailable");
    const result = await createGithubApp(config).branches(state.binding, Number(cursor), AbortSignal.any([req.signal, AbortSignal.timeout(45_000)]));
    await store.assertCurrent(state.binding);
    return jsonResponse(result);
  } catch (error) { return safeFailure(error); }
});
