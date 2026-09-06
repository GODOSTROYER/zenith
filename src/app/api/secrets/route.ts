/**
 * GET /api/secrets?workspace=<id> — what the secret store holds, as metadata.
 *
 * Values never appear here, and there is no route that returns one: the only
 * reader of a plaintext value is the deploy path, in-process. What a caller
 * gets is the reference, its version, when it changed and who changed it —
 * enough for the inspector to say "v3, updated 2 days ago by Alice" beside a
 * variable, and nothing more.
 *
 * When the store is unconfigured this is not an error: it answers with
 * `configured: false` plus the reason and the fix, so a surface can say so
 * plainly instead of showing an empty list that looks like "no secrets yet".
 */
import { listSecrets, secretStoreState } from "@/lib/secrets";
import { ApiError, requireWorkspace, resolveActor, route } from "@/lib/server/context";

export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  // Reading the list is reading configuration, not a secret — but it still
  // needs a caller Zenith.ai recognises, and this is what refuses a signed-out
  // one (and keeps the member list in sync).
  await resolveActor(req);
  const workspace = requireWorkspace();

  const asked = req.nextUrl.searchParams.get("workspace");
  if (asked && asked !== workspace.id && asked !== workspace.slug)
    throw new ApiError(`No workspace "${asked}".`, 404, {
      fix: `The parameter must name the workspace you are currently in: "${workspace.slug}" (${workspace.id}). Drop it, or switch workspaces first with POST /api/workspace/select { "workspaceId": "<id>" } — GET /api/bootstrap lists the workspaces you belong to.`,
    });

  const state = secretStoreState();
  return {
    workspaceId: workspace.id,
    ...state,
    // Each row carries `exists: true` explicitly: a consumer should never have
    // to infer presence from membership in a list it might have filtered.
    secrets: state.configured
      ? listSecrets(workspace.id).map((meta) => ({ ...meta, exists: true as const }))
      : [],
  };
});
