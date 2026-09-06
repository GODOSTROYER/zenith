"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useJson } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { Wordmark } from "@/components/shell/wordmark";
import { GimbalCharacter } from "@/components/navigator/gimbal-character";
import { GuideContent } from "@/components/guide/workspace-guide";
import { canEditGuide, choiceFromDraft, guideProgress, guideStorageKey, restoreGuide } from "@/components/guide/progress";
import { ErrorNote } from "./shared";
import { Rail } from "./onboarding/rail";
import { StepProvider } from "./onboarding/step-provider";
import { StepSystem } from "./onboarding/step-system";
import { StepWorkspace } from "./onboarding/step-workspace";
import { STEPS, type BlueprintCard, type Bootstrap, type ProviderChoice } from "./onboarding/types";
export type { BlueprintCard };
export interface OnboardingFlowProps { blueprints: BlueprintCard[]; sampleCompose: string }

export function OnboardingFlow({ blueprints, sampleCompose }: OnboardingFlowProps) {
  const router = useRouter();
  const params = useSearchParams();
  const boot = useJson<Bootstrap>("/api/bootstrap");
  const me = useJson<{ signedIn: boolean; configured: boolean; hasWorkspace: boolean }>("/api/me");
  const hasWorkspace = !!boot.data?.workspace;
  const newAccount = me.data?.signedIn && !me.data.hasWorkspace;
  const bootFailed = boot.error && boot.error.status !== 404 && !(boot.error.status === 403 && newAccount);
  const [step, setStep] = useState(1);
  const [choice, setChoice] = useState<ProviderChoice>();
  const [projectId, setProjectId] = useState<string>();
  const [createdSlug, setCreatedSlug] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [ready, setReady] = useState(false);
  const [hydratedScope, setHydratedScope] = useState<string>();
  const loadedScope = useRef<string | undefined>(undefined);
  const lastStepParam = useRef<string | null>(null);
  const navigation = useRef({ ready, hasWorkspace, hasChoice: !!choice });
  navigation.current = { ready, hasWorkspace, hasChoice: !!choice };
  const scope = boot.data ? `${boot.data.user?.id ?? "demo"}:${boot.data.workspace.id}` : undefined;

  useEffect(() => {
    if (boot.loading || (bootFailed && me.loading)) return;
    if (loadedScope.current === (scope ?? "no-workspace")) return;
    loadedScope.current = scope ?? "no-workspace";
    const data = boot.data;
    let draft;
    if (data) {
      const key = guideStorageKey(data);
      try { draft = restoreGuide(key ? localStorage.getItem(key) : null, data); } catch { /* storage may be disabled */ }
    }
    const restored = data ? choiceFromDraft(draft, data) : undefined;
    setChoice(restored);
    setProjectId(draft?.projectId);
    const raw = params.get("step");
    lastStepParam.current = raw;
    const requested = raw === null ? draft?.step ?? 1 : Number(raw);
    let target = Number.isInteger(requested) && requested >= 1 && requested <= 4 ? requested : 1;
    if (!data?.workspace) target = 1;
    if (target === 3 && !restored) {
      target = 2;
      setMessage("Choose a connection explicitly before creating a project. You can also skip straight to the guide.");
    }
    setStep(target);
    setHydratedScope(scope);
    setReady(true);
  }, [boot.loading, boot.data, bootFailed, me.loading, scope, params]);

  useEffect(() => {
    if (!ready || !boot.data || hydratedScope !== scope) return;
    const key = guideStorageKey(boot.data);
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify({
      version: 1, workspaceId: boot.data.workspace.id, userId: boot.data.user!.id,
      step, providerId: choice?.providerId, connectionId: choice?.connectionId, projectId,
    })); } catch { /* resume remains available in this tab */ }
  }, [ready, scope, hydratedScope, boot.data, step, choice, projectId]);

  useEffect(() => {
    const raw = params.get("step");
    if (!navigation.current.ready || raw === lastStepParam.current) return;
    lastStepParam.current = raw;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 4)
      setStep(!navigation.current.hasWorkspace ? 1 : n === 3 && !navigation.current.hasChoice ? 2 : n);
  }, [params]);

  const selectedProjectId = boot.data?.projects.find((p) => p.slug === createdSlug)?.id ?? projectId;
  const progress = guideProgress(boot.data, selectedProjectId);
  const editingAllowed = canEditGuide(boot.data);
  const go = (n: number) => { setMessage(undefined); lastStepParam.current = String(n); setStep(n); router.replace(`/onboarding?step=${n}`, { scroll: false }); };
  return <div className="mx-auto min-h-screen w-full max-w-[1240px] px-5 py-6 sm:px-8 lg:px-12">
    <header className="mb-8 flex flex-wrap items-center justify-between gap-4 border-b border-line pb-5"><Wordmark size={24} /><div className="flex items-center gap-2"><Link href={hasWorkspace ? "/overview" : "/"} className="inline-flex min-h-9 items-center px-2 text-sm text-ink-mute hover:text-ink">Leave setup</Link><ThemeToggle /></div></header>
    <div className="flex flex-col gap-7 md:flex-row md:gap-10 lg:gap-14">
    <Rail step={step} complete={progress.complete} hasWorkspace={hasWorkspace} hasChoice={!!choice} onGo={go} />
    <main className="min-w-0 flex-1 pb-12">
      <div className="mb-7 flex items-center justify-between gap-4 border-b border-line pb-6">
        <div><h1 className="app-page-title">{STEPS[step - 1].title}</h1><p className="mt-3 text-[12px] text-ink-mute">Step {step} of {STEPS.length} · Optional starter · Return whenever you need</p></div>
        {step !== 4 && <div className="h-16 w-16 shrink-0"><GimbalCharacter state={null} className="h-full w-full" /></div>}
      </div>
      {message && <Callout tone="info" live="status" className="mb-6">{message}</Callout>}
      {bootFailed ? <div className="space-y-4"><ErrorNote error={boot.error} /><Button onClick={() => { boot.refresh(); me.refresh(); }}>Try again</Button></div> : !ready ? <p role="status">Reading your workspace…</p> : <>
        {step === 1 && <StepWorkspace boot={boot.data} loading={boot.loading} onDone={() => { window.location.assign("/onboarding?step=2"); }} />}
        {step === 2 && hasWorkspace && <StepProvider key={scope} providers={boot.data?.providers ?? []} connections={boot.data?.connections ?? []} loading={boot.loading} initialChoice={choice} onBack={() => go(1)} onNext={(next) => { setChoice(next); go(3); }} />}
        {step === 3 && boot.data && choice && <div className="space-y-6">
          {boot.data.projects.length > 0 && <div className="space-y-3 rounded-card border border-line bg-bg1 p-5"><h2 className="font-medium text-ink">Continue with an existing project</h2><p className="text-sm text-ink-mute">The starter never replaces an existing manifest. Select a project to get oriented, or create a separate one below.</p><div className="flex flex-wrap gap-2">{boot.data.projects.map((p) => <Button key={p.id} onClick={() => { setProjectId(p.id); go(4); }}>{p.name}</Button>)}</div></div>}
          {editingAllowed ? <StepSystem key={`${scope}:${choice.providerId}:${choice.connectionId ?? "new"}`} blueprints={blueprints} sampleCompose={sampleCompose} choice={choice} boot={boot.data} onBack={() => go(2)} onCreated={(slug, summary, id) => { setProjectId(id); setCreatedSlug(slug); go(4); setMessage(summary); boot.refresh(); }} /> : <Callout tone="info">Your {boot.data.role ?? "unavailable"} role can explore projects. An editor or admin can create a project; an admin creates connections, and editors can recheck existing ones. You can skip to the guide.</Callout>}
        </div>}
        {step === 4 && boot.data && <><GuideContent key={selectedProjectId ?? scope} boot={boot.data} initialProjectId={selectedProjectId} /><Link href="/guide" className="mt-6 inline-flex text-sm text-signal hover:underline">Open the workspace guide anytime →</Link></>}
        {hasWorkspace && step !== 4 && <div className="mt-8 border-t border-line pt-5"><Button variant="ghost" onClick={() => go(4)}>Skip setup — I’ll explore with the guide</Button></div>}
        {step === 4 && <Button className="mt-5" variant="ghost" onClick={() => go(choice ? 3 : 2)}>Back to setup</Button>}
      </>}
    </main></div>
  </div>;
}
