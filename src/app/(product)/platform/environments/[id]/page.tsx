/** Persisted desired/observed/runtime and drift state; autonomy is read by the same broker as REST. */
import Link from "next/link";
import { loadEnvironment, one, type Search } from "../../_lib/loaders";
import { EvidenceNote, PageState } from "../../_components/page-state";
import { EnvironmentState } from "./environment-state";
import { EnvironmentAutonomy } from "./environment-autonomy";
import { EnvironmentTeardown } from "./environment-teardown";
import { EnvironmentTeardownReview } from "./environment-teardown-review";
export const dynamic = "force-dynamic";
export default async function EnvironmentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const [{ id }, search] = await Promise.all([params, searchParams]);
  const result = await loadEnvironment(id, one(search, "cursor"));
  if ("error" in result) return <PageState {...result} />;
  const { data, context } = result;
  const name = context.environments.find((e) => e.id === id)?.name ?? id;
  return <div className="space-y-5"><h1 className="app-page-title">{name}</h1><EvidenceNote />
    <Link href={`/platform/environments/${encodeURIComponent(id)}/incidents`} className="text-signal hover:underline">Investigations</Link>
    <EnvironmentState key={one(search, "cursor") ?? "first"} resources={data.resources} drift={data.drift} />
    {data.resources.nextCursor && <Link className="text-signal hover:underline" href={`/platform/environments/${encodeURIComponent(id)}?cursor=${encodeURIComponent(data.resources.nextCursor)}`}>Next resources</Link>}
    {one(search, "cursor") && <Link className="text-signal hover:underline" href={`/platform/environments/${encodeURIComponent(id)}`}>First resources</Link>}
    <EnvironmentAutonomy key={data.autonomy.version} initial={data.autonomy} workspaceId={context.workspaceId} viewerRole={context.role} environmentName={name} />
    <section className="app-panel p-5" aria-label="Read-only teardown review">
      <h2 className="mb-3 text-base font-medium">Review teardown</h2>
      <EnvironmentTeardownReview key={`${context.workspaceId}:${id}:${context.role}`} workspaceId={context.workspaceId} environmentId={id} viewerRole={context.role} />
    </section>
    <EnvironmentTeardown workspaceId={context.workspaceId} environmentId={id} viewerRole={context.role} environmentName={context.environments.find((e) => e.id === id)?.name} />
  </div>;
}
