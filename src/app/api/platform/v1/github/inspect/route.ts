/**
 * GET /api/platform/v1/github/inspect?ref=<ref>[&root=<subdir>][&repository=<owner/name>]
 * Static build detection (monorepo roots, Dockerfile, buildpack) for the workspace's bound
 * repository, or a PUBLIC repository when the workspace has no binding. Human admin browser
 * only. Source is read as text through the installation-scoped immutable access; nothing in the
 * repository is executed or written to disk on this host. A revoked binding is refused.
 */
import type { NextRequest } from "next/server";
import { platformDb } from "@/lib/controlplane/db/open";
import { route } from "@/lib/server/request";
import { createGithubSourceInspector } from "@/lib/sources/github/inspect";
import { createGithubSourceStore } from "@/lib/sources/github/store";
import { GithubSourceError, repository } from "@/lib/sources/github/types";
import { browserCaller, safeFailure } from "../_lib/admin";
import { jsonResponse } from "../_lib/json";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const inspector = createGithubSourceInspector({ db: platformDb });

function single(req: NextRequest, key: string): string | undefined {
  const values = req.nextUrl.searchParams.getAll(key);
  if (values.length > 1) throw new GithubSourceError("invalid");
  return values[0];
}

export const GET = route({ workspaceRole: "admin" }, async (req) => {
  const caller = await browserCaller(req, false);
  try {
    if ([...req.nextUrl.searchParams.keys()].some(key => !["ref", "root", "repository"].includes(key))) throw new GithubSourceError("invalid");
    const store = createGithubSourceStore(await platformDb());
    const state = await store.getState(caller.workspaceId);
    // A revoked binding is never an anonymous fallback.
    if (state?.revoked) throw new GithubSourceError("refused");
    let location: { owner: string; repo: string };
    if (state) {
      location = { owner: state.binding.owner, repo: state.binding.repo };
      const requested = single(req, "repository");
      if (requested !== undefined) {
        const parts = requested.split("/");
        if (parts.length !== 2) throw new GithubSourceError("invalid");
        const asked = repository(parts[0], parts[1]);
        if (asked.owner !== location.owner || asked.repo !== location.repo) throw new GithubSourceError("refused");
      }
    } else {
      const parts = (single(req, "repository") ?? "").split("/");
      if (parts.length !== 2) throw new GithubSourceError("invalid");
      location = repository(parts[0], parts[1]);
    }
    const result = await inspector({
      workspaceId: caller.workspaceId, ...location, ref: single(req, "ref") ?? "HEAD", root: single(req, "root"),
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(60_000)]),
    });
    return jsonResponse(result);
  } catch (error) { return safeFailure(error); }
});
