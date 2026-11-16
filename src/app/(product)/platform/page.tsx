/** Workspace operations, filtered and paginated through the same broker read as REST. */
import Link from "next/link";
import { OperationStatusBadge } from "@/components/platform/operation-status";
import { humanizeToken } from "@/components/platform/text";
import { loadOperations, one, OPERATION_STATUSES, type Search } from "./_lib/loaders";
import { EvidenceNote, PageState } from "./_components/page-state";
export const dynamic = "force-dynamic";
export default async function OperationsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const result = await loadOperations(params);
  if ("error" in result) return <PageState {...result} />;
  const { data, context } = result;
  const next = new URLSearchParams();
  for (const key of ["status", "environmentId"]) { const value = one(params, key); if (value) next.set(key, value); }
  if (data.nextCursor) next.set("cursor", data.nextCursor);
  return <div className="space-y-5"><h1 className="app-page-title">Operations</h1><EvidenceNote />
    <form action="/platform" className="flex flex-wrap items-end gap-4">
      <label className="text-[13px]">Status<select name="status" defaultValue={one(params, "status") ?? ""} className="ml-2 rounded-ctl border border-line bg-bg1 p-2"><option value="">All statuses</option>{OPERATION_STATUSES.map((s) => <option key={s} value={s}>{humanizeToken(s)}</option>)}</select></label>
      <label className="text-[13px]">Environment<select name="environmentId" defaultValue={one(params, "environmentId") ?? ""} className="ml-2 rounded-ctl border border-line bg-bg1 p-2"><option value="">All environments</option>{context.environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
      <button className="rounded-ctl bg-signal px-4 py-2 text-[13px] text-on-signal">Apply filters</button>
    </form>
    {data.items.length === 0 ? <p className="text-ink-mute">No operations match these filters.</p> : <ul className="divide-y divide-line">{data.items.map((op) => <li key={op.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
      <div><Link href={`/platform/operations/${encodeURIComponent(op.id)}`} className="text-signal hover:underline">{op.proposal.summary}</Link><p className="text-[12px] text-ink-mute">{context.environments.find((e) => e.id === op.environmentId)?.name ?? op.environmentId ?? "Workspace"} · {op.principal.name} · <time dateTime={op.createdAt}>{op.createdAt}</time></p></div><OperationStatusBadge status={op.status} />
    </li>)}</ul>}
    {data.nextCursor && <Link href={`/platform?${next}`} className="text-signal hover:underline">Next page</Link>}
  </div>;
}
