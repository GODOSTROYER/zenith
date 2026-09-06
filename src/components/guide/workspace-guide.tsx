"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowUpRight, Check, Circle } from "lucide-react";
import { useShell, type Bootstrap } from "@/components/shell/shell-context";
import { GimbalCharacter } from "@/components/navigator/gimbal-character";
import { Button } from "@/components/ui/button";
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
  const labels = ["Workspace exists", "Environment has a connection", "Editable system has nodes"];
  return (
    <div className="space-y-8">
      <div className="flex flex-col items-start gap-5 rounded-card border border-line bg-bg1 p-5 sm:flex-row sm:items-center">
        <div className="h-28 w-28 shrink-0"><GimbalCharacter state={null} className="h-full w-full" /></div>
        <div><h2 className="text-xl font-medium text-ink">Your stack, clearly in view.</h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-mute">Pick up wherever you are. This guide reads your workspace records; visiting a screen never marks infrastructure deployed or verified.</p></div>
      </div>
      {boot.projects.length > 0 && <label className="block text-sm text-ink-mute">Project
        <select aria-label="Guide project" value={project?.id ?? ""} onChange={(e) => setSelected(e.target.value)} className="mt-2 block w-full rounded-ctl border border-line bg-bg1 p-3 text-ink">
          {boot.projects.filter((p) => p.workspaceId === boot.workspace.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-card border border-line p-5"><h3 className="text-sm font-medium text-ink">In {boot.workspace.name}</h3>
          <ul className="mt-4 space-y-3">{labels.map((label, index) => <li key={label} className="flex items-center gap-3 text-sm text-ink-mute">{state.complete[index] ? <Check aria-label="Present" className="h-4 w-4 text-signal" /> : <Circle aria-label="Not yet" className="h-4 w-4 text-ink-faint" />}{label}</li>)}</ul>
          <p className="mt-4 text-xs text-ink-faint">A blank project is a valid starting point. Deployment readiness requires a separate plan and checks.</p>
        </div>
        <div className="rounded-card border border-line bg-bg1 p-5"><p className="text-xs text-signal">{state.mode}</p><h3 className="mt-3 text-base text-ink">{state.next}</h3>
          <p className="mt-3 text-sm text-ink-mute">{state.connection ? `Environment: ${state.environment?.name}. Connection: ${state.connection.label} · last recorded status: ${state.connection.status}.` : "No cloud access is needed to explore this workspace."}</p>
          {state.connection?.lastCheckedAt && <p className="mt-2 text-xs text-ink-faint">Last check: {new Date(state.connection.lastCheckedAt).toLocaleString()}. Open Settings for a fresh check.</p>}
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
  return <section className="h-full overflow-y-auto"><div className="mx-auto max-w-6xl px-5 py-8 sm:px-8"><h1 className="mb-6 text-3xl font-medium text-ink">Get oriented with Gimbal</h1>
    {error ? <div className="space-y-4"><ErrorNote error={error} /><Button onClick={refresh}>Try again</Button>{(error.status === 403 || error.status === 404) && <Link href="/onboarding?step=1" className="block text-sm text-signal underline">Choose or create a workspace →</Link>}</div> : loading && !boot ? <p role="status">Reading your workspace…</p> : boot ? <GuideContent boot={boot} /> : <Link href="/onboarding">Choose a workspace to begin →</Link>}
  </div></section>;
}
