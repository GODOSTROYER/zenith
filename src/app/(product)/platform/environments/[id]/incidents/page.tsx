/** Render stored investigations; no probes or remediation run when this page is opened. */
import { InvestigationView } from "@/components/platform/investigation-view";
import { Callout } from "@/components/ui/callout";
import { loadInvestigations } from "../../../_lib/loaders";
import { EvidenceNote, PageState } from "../../../_components/page-state";
export const dynamic = "force-dynamic";
export default async function InvestigationsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await loadInvestigations(id);
  if ("error" in result) return <PageState {...result} />;
  return <div className="space-y-5"><h1 className="app-page-title">Investigations</h1><EvidenceNote />
    {result.data.investigations.length === 0 ? <><p className="text-ink-mute">No stored investigations for this environment. This does not establish that it is healthy.</p><InvestigationView /></> : result.data.investigations.map((investigation) => <InvestigationView key={investigation.id} investigation={investigation} />)}
    {result.data.truncated && <Callout tone="info">Showing the latest 20 investigations. Older investigations may exist.</Callout>}
  </div>;
}
