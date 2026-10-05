/** Connection administration: create, verify, rotate and revoke for every supported provider. */
import { loadPage } from "../_lib/loaders";
import { EvidenceNote, PageState } from "../_components/page-state";
import { listConnections } from "@/lib/connections/service";
import { ConnectionAdmin } from "./connection-admin";
export const dynamic = "force-dynamic";
export default async function ConnectionsPage() {
  const result = await loadPage(async (context) =>
    listConnections({ workspaceId: context.workspaceId, actor: { type: "user", id: context.principal.id, name: context.principal.name } }));
  if ("error" in result) return <PageState {...result} />;
  return <div className="space-y-5"><h1 className="app-page-title">Cloud connections</h1><EvidenceNote />
    <ConnectionAdmin workspaceId={result.context.workspaceId} viewerRole={result.context.role} initial={result.data} />
  </div>;
}
