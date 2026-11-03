/** Workspace repository grants and the shared source-inspection entry point. */
import { loadPage } from "../_lib/loaders";
import { PageState } from "../_components/page-state";
import { SourcePanel } from "./source-panel";
export const dynamic = "force-dynamic";
export default async function SourcePage({ searchParams }: { searchParams?: Promise<{ discovery?: string }> }) {
  const query = searchParams ? await searchParams : {};
  const result = await loadPage(async () => null);
  if ("error" in result) return <PageState {...result} />;
  const discovery = typeof query.discovery === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(query.discovery) ? query.discovery : undefined;
  return <div className="space-y-5"><h1 className="app-page-title">Repository connections</h1>
    <p className="text-[13px] text-ink-mute">Choose which code Zenith can read, inspect it, and manage access as your projects change.</p>
    <SourcePanel workspaceId={result.context.workspaceId} viewerRole={result.context.role} discoverySession={discovery} />
  </div>;
}
