/** Standing grants: a person's explicit, bounded pre-approval for repeat agent operations, read through the same broker the REST routes use. */
import { CAPABILITIES } from "@/lib/capabilities/catalog";
import { standingIneligibleReason, type StandingGrant, type StandingGrantUse } from "@/lib/capabilities/standing-grants";
import { EvidenceNote, PageState } from "../_components/page-state";
import { loadStandingGrants } from "../_lib/loaders";
import { StandingGrantsPanel } from "./standing-grants-panel";

export const dynamic = "force-dynamic";

const ELIGIBLE = Object.values(CAPABILITIES)
  .filter((c) => !standingIneligibleReason(c) && c.risk !== "critical")
  .map((c) => ({ name: c.name, title: c.title, risk: c.risk }))
  .sort((a, b) => (a.name < b.name ? -1 : 1));

export default async function StandingGrantsPage() {
  const result = await loadStandingGrants();
  if ("error" in result) return <PageState {...result} />;
  const { data, context } = result;
  const rows = data as unknown as { grant: StandingGrant; uses: StandingGrantUse[] }[];
  return <div className="space-y-5">
    <h1 className="app-page-title">Standing grants</h1><EvidenceNote />
    <p className="max-w-[70ch] text-[13px] text-ink-mute">A standing grant lets named agents repeat a narrow set of changes without waiting for you each time. It is bound to one environment, an explicit capability list, a risk ceiling, a number of uses and an expiry. It never covers destructive actions, raw command execution or reviewing a concrete plan, and it stops working the moment it is revoked.</p>
    <StandingGrantsPanel workspaceId={context.workspaceId} viewerRole={context.role} viewerId={context.principal.id} environments={context.environments} capabilities={ELIGIBLE} rows={rows} />
  </div>;
}
