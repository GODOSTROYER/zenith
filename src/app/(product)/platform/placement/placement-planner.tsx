"use client";
/** Review a deterministic recommendation, then use the shared plan-first
 * action dialog to stage it. Changing selection discards old results. */
import { useRef, useState } from "react";
import { PlacementComparison, candidateLabel } from "@/components/platform/placement-comparison";
import { ActionConfirm, ErrorNote } from "@/components/screens/action-confirm";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { executeAction } from "@/lib/client/api";
import type { PlacementRecommendation } from "@/lib/placement/recommend";

export interface PlacementProject { id: string; name: string; environments: { id: string; name: string }[] }

export function PlacementPlanner({ projects }: { projects: PlacementProject[] }) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [environmentId, setEnvironmentId] = useState("");
  const [includeUnconnected, setIncludeUnconnected] = useState(false);
  const [userRegion, setUserRegion] = useState("");
  const [recommendation, setRecommendation] = useState<PlacementRecommendation>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [candidateId, setCandidateId] = useState<string>();
  const sequence = useRef(0);
  const project = projects.find((p) => p.id === projectId);
  const clear = () => { sequence.current++; setRecommendation(undefined); setCandidateId(undefined); setError(undefined); setBusy(false); };
  const request = async () => {
    const turn = ++sequence.current;
    setBusy(true); setError(undefined); setRecommendation(undefined);
    try {
      const result = await executeAction("placement.recommend", { input: { projectId, environmentId: environmentId || undefined, includeUnconnected, constraints: userRegion ? { userRegions: [userRegion] } : undefined }, scope: { projectId, environmentId: environmentId || undefined } });
      if (!result.ok) throw new Error(result.error ?? result.summary);
      if (sequence.current === turn) setRecommendation(result.data as PlacementRecommendation);
    } catch (failure) { if (sequence.current === turn) setError(failure); }
    finally { if (sequence.current === turn) setBusy(false); }
  };
  const candidates = recommendation ? [...(recommendation.result.chosen ? [recommendation.result.chosen] : []), ...recommendation.result.alternatives] : [];
  return <div className="mx-auto max-w-[1200px] space-y-6 p-4 sm:p-8">
    <div><h1 className="text-xl font-medium text-ink">Where should this run?</h1>
      <p className="mt-2 text-sm text-ink-mute">Compare your working manifest across verified cloud connections. Review a recommendation before staging a change.</p></div>
    {projects.length === 0 ? <Callout tone="info" title="No projects yet">Create a project to compare placement options.</Callout> : <div className="flex flex-wrap items-end gap-4">
      <label className="space-y-1 text-sm">Project<select className="block rounded border border-line bg-bg2 p-2" value={projectId} onChange={(e) => { clear(); setProjectId(e.target.value); setEnvironmentId(""); }}>
        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label>
      <label className="space-y-1 text-sm">User region<select className="block rounded border border-line bg-bg2 p-2" value={userRegion} onChange={(e) => { clear(); setUserRegion(e.target.value); }}>
        <option value="">Use manifest user regions</option>{["india", "singapore", "us-east", "us-west", "europe", "japan", "australia", "brazil"].map((r) => <option key={r} value={r}>{r}</option>)}
      </select></label>
      <label className="space-y-1 text-sm">Environment<select className="block rounded border border-line bg-bg2 p-2" value={environmentId} onChange={(e) => { clear(); setEnvironmentId(e.target.value); }}>
        <option value="">Working copy without an environment</option>{project?.environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
      </select></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={includeUnconnected} onChange={(e) => { clear(); setIncludeUnconnected(e.target.checked); }} />Also explore unconnected clouds</label>
      <Button variant="primary" busy={busy} disabled={!projectId || busy} disabledReason={busy ? "Placement is being computed." : "Choose a project."} onClick={() => void request()}>Compare placement</Button>
    </div>}
    {error ? <ErrorNote error={error} /> : null}
    <PlacementComparison result={recommendation?.result} loading={busy} />
    {recommendation && <>
      <section aria-label="Placement explanation"><h2 className="mb-2 font-medium">Why this placement</h2><pre className="whitespace-pre-wrap break-words text-sm text-ink-mute">{recommendation.explanation}</pre></section>
      {candidates.length > 0 && <section className="space-y-2" aria-label="Apply placement"><h2 className="font-medium">Stage a reviewed recommendation</h2><p className="text-sm text-ink-mute">This edits the working manifest. Review the environment connection separately before deploying.</p>
        {candidates.map((c) => <Button key={c.id} className="mr-2" disabled={c.requiresConnection || c.topology === "multi_region"} disabledReason={c.requiresConnection ? "Connect and verify this provider first." : "Multi-region application requires deployment wiring."} onClick={() => setCandidateId(c.id)}>Review {candidateLabel(c)}</Button>)}
      </section>}
      {recommendation.unconnectedCandidates.length > 0 && <section aria-label="Unconnected discovery" className="space-y-2"><h2 className="font-medium">Explore after connecting</h2><p className="text-sm text-ink-mute">These options require a verified connection and are listed separately from connected recommendations.</p>
        {recommendation.unconnectedCandidates.map((c) => <Callout key={c.id} tone="warn" title={candidateLabel(c)}>Estimate ${c.cost.monthlyUsd.toFixed(2)}/month. Connect and verify {c.missingProviders.join(", ")} before applying.</Callout>)}
      </section>}
    </>}
    {recommendation && candidateId && <ActionConfirm open onClose={() => setCandidateId(undefined)} actionId="placement.apply" title="Apply placement to working manifest" confirmLabel="Stage placement"
      input={{ projectId, environmentId: environmentId || undefined, includeUnconnected, constraints: userRegion ? { userRegions: [userRegion] } : undefined, candidateId, expectedHash: recommendation.manifestHash, expectedSeed: recommendation.result.deterministicSeed }}
      scope={{ projectId, environmentId: environmentId || undefined }} onDone={() => clear()} />}
  </div>;
}
