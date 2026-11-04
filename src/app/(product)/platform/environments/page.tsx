/** Environment choices come only from projects in the active workspace. */
import Link from "next/link";
import { loadPage } from "../_lib/loaders";
import { PageState } from "../_components/page-state";
export const dynamic = "force-dynamic";
export default async function EnvironmentsPage() {
  const result = await loadPage(async () => null);
  if ("error" in result) return <PageState {...result} />;
  return <div className="space-y-5"><h1 className="app-page-title">Environments</h1>
    {result.context.environments.length === 0 ? <p className="text-ink-mute">No environments in this workspace yet.</p> : <ul className="divide-y divide-line">{result.context.environments.map((e) => <li key={e.id} className="py-4"><Link href={`/platform/environments/${encodeURIComponent(e.id)}`} className="text-signal hover:underline">{e.name}</Link><span className="ml-3 text-[12px] text-ink-mute">{e.class}</span></li>)}</ul>}
  </div>;
}
