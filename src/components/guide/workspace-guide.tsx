"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowUpRight, Check, Circle } from "lucide-react";
import { useShell, type Bootstrap } from "@/components/shell/shell-context";
import { GimbalCharacter } from "@/components/navigator/gimbal-character";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { ErrorNote } from "@/components/screens/shared";
import { guideProgress } from "./progress";

const destinations = [
  ["System", "", "Arrange services, resources and their connections. Review your editable system before planning."],
  ["Source", "/source", "Inspect and edit the manifest. Saving a manifest does not deploy it."],
  ["Deploys", "/deploys", "Preview changes, inspect runs and review Terraform exports. AWS is plan/export only."],
  ["Observe", "/observe", "Read the observations available for this environment. Sandbox observations are simulated."],
  ["Security", "/security", "Review findings and proposed fixes in the context of your environment."],
  ["Navigator", "/navigator", "Work with Gimbal on a plan. Review scope and required approvals before execution."],
  ["Settings", "/settings", "Manage environments, check connections and inspect workspace access."],
  ["Activity", "/activity", "Trace recorded actions and the people or agents that requested them."],
  ["Revisions", "/revisions", "Compare saved system versions and inspect what changed."],
] as const;

export function GuideContent({ boot, initialProjectId }: { boot: Bootstrap; initialProjectId?: string }) {
  const [selected, setSelected] = useState(initialProjectId ?? "");
  const state = guideProgress(boot, selected);
  const project = state.project;
  const base = project ? `/p/${encodeURIComponent(project.slug)}` : undefined;
  const projectHref = (path = "") => `${base}${path}${state.environment ? `?env=${encodeURIComponent(state.environment.id)}` : ""}`;
  const labels = ["Workspace selected", "Connection selected", "Services or resources added"];
  return (
    <div className="space-y-7">
      <div className="flex items-center gap-4 border-b border-line pb-5">
        <div className="h-16 w-16 shrink-0"><GimbalCharacter state={null} className="h-full w-full" /></div>
        <div><h2 className="text-[18px] font-medium text-ink">Your stack, clearly in view.</h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-mute">Pick up where you left off. Choose a project to see what’s ready and find your next step.</p></div>
      </div>
      {boot.projects.length > 0 && <label className="block text-sm text-ink-mute">Project
        <Select aria-label="Guide project" value={project?.id ?? ""} onChange={(e) => setSelected(e.target.value)} className="mt-2 w-full sm:max-w-[420px]" options={boot.projects.filter((p) => p.workspaceId === boot.workspace.id).map((p) => ({ value: p.id, label: p.name }))} />
      </label>}
      <div className="grid gap-6 border-y border-line bg-bg2 px-5 py-6 lg:grid-cols-[1fr_1.3fr] lg:gap-8">
        <div><h3 className="break-words text-sm font-medium text-ink">In {boot.workspace.name}</h3>
          <ul className="mt-4 space-y-3">{labels.map((label, index) => <li key={label} className="flex items-center gap-3 text-sm text-ink-mute">{state.complete[index] ? <Check aria-label="Present" className="h-4 w-4 shrink-0 text-ok" /> : <Circle aria-label="Not yet" className="h-4 w-4 shrink-0 text-ink-faint" />}{label}</li>)}</ul>
          <p className="mt-4 text-xs text-ink-faint">Start blank or build from a blueprint. Review a plan before applying changes.</p>
        </div>
        <div className="border-t border-line pt-5 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-8"><h3 className="text-base font-medium text-ink">{state.next}</h3><p className="mt-2 text-xs text-info">{state.mode}</p>
          <p className="mt-3 text-sm text-ink-mute">{state.connection ? `Environment: ${state.environment?.name}. Connection: ${state.connection.label}.` : "No cloud access is needed to explore this workspace."}</p>
          {state.connection && <p className="mt-2 text-xs text-ink-faint">Last check: {state.connection.status}{state.connection.lastCheckedAt ? ` · ${new Date(state.connection.lastCheckedAt).toLocaleString()}` : " · no check date available"}. Recheck in Settings.</p>}
          <Link className="mt-5 inline-flex min-h-11 items-center rounded-ctl bg-signal px-4 text-sm font-medium text-on-signal" href={base ? projectHref(!state.environment || !state.connection || state.connection.status !== "healthy" ? "/settings" : state.provider?.availability === "preview" ? "/source" : "") : "/onboarding?step=2"}>{!base ? "Open the optional starter" : !state.environment || !state.connection || state.connection.status !== "healthy" ? "Review connection settings" : state.provider?.availability === "preview" ? "Review Source and export" : "Review your system"} →</Link>
        </div>
      </div>
      <div><h3 className="text-lg font-medium text-ink">Find your way around</h3><p className="mt-2 text-sm text-ink-mute">{base ? "Each link opens the selected project. Your existing system stays as it is until you make an explicit change." : "Create or select a project to open these screens. You can read what each one does now."}</p></div>
      <div className="divide-y divide-line border-y border-line"><div className="grid gap-2 py-4 sm:grid-cols-[140px_1fr] sm:gap-6"><Link href="/overview" className="font-medium text-ink hover:text-signal">Overview</Link><p className="text-sm leading-relaxed text-ink-mute">See your workspace’s projects and environments, then choose a system to inspect or start a new project.</p></div>{destinations.map(([title, path, description]) => <div key={title} className="grid gap-2 py-4 sm:grid-cols-[140px_1fr] sm:gap-6">
        {base ? <Link className="flex items-center justify-between font-medium text-ink hover:text-signal" href={projectHref(path)}>{title}<ArrowUpRight className="h-4 w-4" /></Link> : <h4 className="font-medium text-ink">{title}</h4>}
        <p className="text-sm leading-relaxed text-ink-mute">{description}</p>
      </div>)}</div>
      <div className="flex flex-wrap gap-5 text-sm"><Link href="/onboarding?step=1" className="text-signal hover:underline">Revisit the starter</Link><Link href="/overview" className="text-ink-mute hover:underline">Go to overview</Link></div>
    </div>
  );
}

export function WorkspaceGuide() {
  const { boot, loading, error, refresh } = useShell();
  return <section className="product-page h-full overflow-y-auto"><div className="mx-auto max-w-[1080px]"><h1 className="app-page-title mb-6">Get oriented with Gimbal</h1>
    {error ? <div className="space-y-4"><ErrorNote error={error} /><Button onClick={refresh}>Try again</Button>{(error.status === 403 || error.status === 404) && <Link href="/onboarding?step=1" className="block text-sm text-signal underline">Choose or create a workspace →</Link>}</div> : loading && !boot ? <p role="status">Reading your workspace…</p> : boot ? <GuideContent boot={boot} /> : <Link href="/onboarding">Choose a workspace to begin →</Link>}
  </div></section>;
}
