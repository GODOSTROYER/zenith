/** GitHub source binding: the workspace's one bound repository, why access stopped, bind/unbind and static inspection. */
import { platformDb } from "@/lib/controlplane/db/open";
import { createGithubSourceStore } from "@/lib/sources/github/store";
import { loadPage } from "../_lib/loaders";
import { PageState } from "../_components/page-state";
import { SourcePanel, type SourceBindingView } from "./source-panel";
export const dynamic = "force-dynamic";
export default async function SourcePage() {
  const result = await loadPage(async (context) => {
    const state = await createGithubSourceStore(await platformDb()).getState(context.workspaceId);
    const view: SourceBindingView | null = state ? {
      owner: state.binding.owner, repo: state.binding.repo, version: state.binding.version,
      state: state.revoked ? "revoked" : "connected", revokedReason: state.revokedReason,
    } : null;
    return view;
  });
  if ("error" in result) return <PageState {...result} />;
  return <div className="space-y-5"><h1 className="app-page-title">GitHub source</h1>
    <SourcePanel workspaceId={result.context.workspaceId} viewerRole={result.context.role} initial={result.data} />
  </div>;
}
