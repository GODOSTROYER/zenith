/** Signed runbooks, their runs and schedules, from the same service the REST routes use. */
import Link from "next/link";
import { Chip } from "@/components/ui/chip";
import { DigestValue } from "@/components/platform/badges";
import { humanizeToken } from "@/components/platform/text";
import { projectRunbookRun } from "@/lib/platform/operator-journey";
import { EvidenceNote, PageState } from "../_components/page-state";
import { loadRunbooks } from "../_lib/loaders";
import { ScheduleActions } from "./schedule-actions";
export const dynamic = "force-dynamic";

type RunbookRow = { runbookId: string; version: number; name: string; definitionDigest: string; createdAt: string; stepCount: number };
type RunRow = { id: string; runbookId: string; version: number; status: Parameters<typeof projectRunbookRun>[0]["status"]; bindingDigest: string; createdAt: string; targetCount: number; requestedBy: string };
type ScheduleRow = { id: string; runbookId: string; version: number; status: string; nextDueAt: string | null; bindingDigest: string; targetCount: number; createdBy: string; creatorId: string; lines: string[] };

export default async function RunbooksPage() {
  const result = await loadRunbooks();
  if ("error" in result) return <PageState {...result} />;
  const { data, context } = result;
  const runbooks = data.runbooks as unknown as RunbookRow[];
  const runs = data.runs as unknown as RunRow[];
  const schedules = data.schedules as unknown as ScheduleRow[];
  return <div className="space-y-6">
    <h1 className="app-page-title">Runbooks</h1><EvidenceNote />
    <p className="max-w-[70ch] text-[13px] text-ink-mute">Runbooks are signed, versioned and approved against the exact version, targets and bounds. Raw command steps remain a high-risk escape hatch. Publishing and approving happen in a signed-in browser session; agents can request runs but never approve them.</p>

    <section aria-labelledby="runs-h" className="space-y-2">
      <h2 id="runs-h" className="text-[15px] font-medium text-ink">Runs</h2>
      {runs.length === 0 ? <p className="text-[13px] text-ink-mute">No runs yet. A run appears here when someone or an agent requests one for a published runbook.</p> :
        <ul className="divide-y divide-line">{runs.map((r) => { const v = projectRunbookRun({ id: r.id, status: r.status, bindingDigest: r.bindingDigest }, []); return <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div><Link className="text-signal hover:underline" href={`/platform/runbooks/runs/${encodeURIComponent(r.id)}`}>{r.runbookId} v{r.version}</Link><p className="text-[12px] text-ink-mute">{r.targetCount} target(s) · requested by {r.requestedBy} · <time dateTime={r.createdAt}>{r.createdAt}</time></p></div>
          <Chip tone={v.tone === "neutral" ? "neutral" : v.tone}>{v.label}</Chip></li>; })}</ul>}
    </section>

    <section aria-labelledby="sched-h" className="space-y-2">
      <h2 id="sched-h" className="text-[15px] font-medium text-ink">Schedules</h2>
      {schedules.length === 0 ? <p className="text-[13px] text-ink-mute">No schedules. Every schedule is bounded by windows and needs its own approval.</p> :
        <ul className="divide-y divide-line">{schedules.map((s) => <li key={s.id} className="space-y-2 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[13px]">{s.runbookId} v{s.version} · {s.targetCount} target(s)</span><Chip tone={s.status === "active" ? "ok" : s.status === "pending_approval" ? "warn" : "neutral"}>{humanizeToken(s.status)}</Chip></div>
          <ul className="list-disc pl-5 text-[12.5px] text-ink-mute">{s.lines.map((l) => <li key={l}>{l}</li>)}</ul>
          <p className="text-[12px] text-ink-mute">Binding <DigestValue digest={s.bindingDigest} what="schedule binding digest" />{s.nextDueAt ? <> · next slot <time dateTime={s.nextDueAt}>{s.nextDueAt}</time></> : null}</p>
          <ScheduleActions workspaceId={context.workspaceId} scheduleId={s.id} bindingDigest={s.bindingDigest} status={s.status} canApprove={context.role === "admin" && s.creatorId !== context.principal.id} />
        </li>)}</ul>}
    </section>

    <section aria-labelledby="rb-h" className="space-y-2">
      <h2 id="rb-h" className="text-[15px] font-medium text-ink">Published runbooks</h2>
      {runbooks.length === 0 ? <p className="text-[13px] text-ink-mute">No runbooks are published in this workspace.</p> :
        <ul className="divide-y divide-line">{runbooks.map((r) => <li key={r.runbookId} className="py-3 text-[13px]"><span className="text-ink">{r.name}</span> <span className="text-ink-mute">({r.runbookId}, version {r.version}, {r.stepCount} step(s))</span><p className="text-[12px] text-ink-mute">Definition <DigestValue digest={r.definitionDigest} what="definition digest" /></p></li>)}</ul>}
    </section>
  </div>;
}
