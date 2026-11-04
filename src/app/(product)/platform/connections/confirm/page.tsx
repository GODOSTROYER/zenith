import { listConnections } from "@/lib/connections/service";
import { loadPage } from "../../_lib/loaders";
import { PageState } from "../../_components/page-state";
import { ConnectionConfirmation } from "./confirmation";
export const dynamic = "force-dynamic";

export default async function ConfirmConnectionPage() {
  const result = await loadPage(async (context) => listConnections({ workspaceId: context.workspaceId, actor: { type: "user", id: context.principal.id, name: context.principal.name } }));
  if ("error" in result) return <PageState {...result} />;
  return <div className="space-y-5"><h1 className="app-page-title">Review connection change</h1>
    <ConnectionConfirmation workspaceId={result.context.workspaceId} viewerRole={result.context.role} connections={result.data} />
  </div>;
}
