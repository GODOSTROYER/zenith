/** Workspace policy comes from the broker; only admins get an editable draft. */
import { loadPolicy } from "../_lib/loaders";
import { PageState } from "../_components/page-state";
import { WorkspacePolicyEditor } from "./policy-editor";
import { MfaControls } from "./mfa-controls";
export const dynamic = "force-dynamic";
export default async function PolicyPage() {
  const result = await loadPolicy();
  if ("error" in result) return <PageState {...result} />;
  return <div className="space-y-5"><h1 className="app-page-title">Workspace policy</h1>
    <MfaControls key={result.context.workspaceId} workspaceId={result.context.workspaceId} viewerRole={result.context.role} />
    <WorkspacePolicyEditor key={result.data.version} initial={result.data} viewerRole={result.context.role} />
  </div>;
}
