/** Keyless AWS setup uses the existing human-only product actions. No credential configuration is serialized. */
import { loadPage } from "../../_lib/loaders";
import { EvidenceNote, PageState } from "../../_components/page-state";
import { AwsConnectionFlow } from "./aws-flow";
export const dynamic = "force-dynamic";
export default async function AwsConnectionPage() {
  const result = await loadPage(async () => null);
  if ("error" in result) return <PageState {...result} />;
  return <div className="space-y-5"><h1 className="app-page-title">Connect AWS</h1><EvidenceNote />
    <AwsConnectionFlow workspaceId={result.context.workspaceId} viewerRole={result.context.role} />
  </div>;
}
