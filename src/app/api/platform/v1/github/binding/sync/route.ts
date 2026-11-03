/** Verify live provider access; an outage never masquerades as a confirmed revocation. */
import { platformDb } from "@/lib/controlplane/db/open";
import { route } from "@/lib/server/request";
import { createGithubApp, githubAppConfig } from "@/lib/sources/github/app";
import { createGithubSourceStore } from "@/lib/sources/github/store";
import { GithubSourceError, identifier, numericId } from "@/lib/sources/github/types";
import { browserCaller, currentAdminMutation, safeFailure } from "../../_lib/admin";
import { jsonResponse, onlyKeys, readSmallJson } from "../../_lib/json";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = route({ workspaceRole: "admin" }, async req => {
  const caller = await browserCaller(req, true);
  try {
    const body = await readSmallJson(req);
    onlyKeys(body, ["bindingId", "version"]);
    if (typeof body.bindingId !== "string") throw new GithubSourceError("invalid");
    const bindingId = identifier(body.bindingId), version = numericId(body.version);
    const current = await createGithubSourceStore(await platformDb()).getState(caller.workspaceId, { bindingId });
    if (!current || current.revoked) throw new GithubSourceError("refused");
    if (current.binding.version !== version) throw new GithubSourceError("conflict");
    const config = githubAppConfig();
    if (!config || config.appId !== current.binding.appId) throw new GithubSourceError("unavailable");
    await createGithubApp(config).withRepositoryAccess(current.binding, async () => undefined, AbortSignal.any([req.signal, AbortSignal.timeout(45_000)]));
    await currentAdminMutation(req, caller, true, store => store.assertCurrent(current.binding));
    return jsonResponse({ state: "connected", verifiedAt: new Date().toISOString() });
  } catch (error) { return safeFailure(error); }
});
