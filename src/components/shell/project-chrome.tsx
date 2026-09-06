"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { type ReactNode } from "react";
import { ChevronRight, ShieldCheck } from "lucide-react";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useProjectData } from "./project-context";
import { useShell } from "./shell-context";
import { useChromeSlot } from "./chrome-slot";
import { monthlyCostUsd } from "@/lib/cost/pricing";
import { cx, fmtUsd } from "@/lib/format";

/** Controls keep their project provider ancestry inside the single context bar. */
export function ProjectChrome({ slug, children }: { slug: string; children: ReactNode }) {
  const { project, environments, selectedEnv, selectedEnvId, setSelectedEnv, changesets } = useProjectData();
  const { boot } = useShell();
  const router = useRouter();
  const slot = useChromeSlot();
  const projects = boot?.projects ?? [];
  const isProd = selectedEnv?.class === "production";
  const pending = changesets[selectedEnvId]?.items.length ?? 0;
  const controls = <div className="workbench-project-context" data-production={isProd}>
    <h1 className="sr-only">{project.name}</h1>
    {projects.length > 1 ? <Select
      aria-label="Project" title={`Project: ${project.name}. Switch project.`}
      className="workbench-project-select" value={project.slug}
      onChange={(event) => { if (event.target.value !== slug) router.push(`/p/${event.target.value}`); }}
      options={projects.map((entry) => ({ value: entry.slug, label: entry.name }))}
    /> : <span className="workbench-project-name" title={project.name}>{project.name}</span>}
    <ChevronRight size={13} className="workbench-context-divider" aria-hidden="true" />
    {environments.length > 0 && <div className={cx("workbench-environment", isProd && "workbench-environment-production")}>
      {isProd && <ShieldCheck size={14} aria-hidden="true" />}
      <Select aria-label="Environment" title={`${selectedEnv?.name ?? "Environment"} · ${selectedEnv?.class ?? ""} · ${selectedEnv?.region ?? ""}`}
        className="workbench-environment-select" value={selectedEnvId} onChange={(event) => setSelectedEnv(event.target.value)}
        options={environments.map((environment) => ({ value: environment.id,
          label: environment.class === "production" && !/production/i.test(environment.name)
            ? `Production · ${environment.name}` : environment.name }))}
      />
    </div>}
    <span className="workbench-context-evidence" title="Estimated monthly list-price cost of the working configuration.">
      <span className="font-mono tnum">{fmtUsd(monthlyCostUsd(project.workingManifest))}</span><span>/mo est.</span>
    </span>
    {pending > 0 && <Link href={`/p/${slug}`} className="workbench-pending" title={`${pending} undeployed changes in ${selectedEnv?.name ?? "this environment"}`}>
      <span className="tnum">{pending}</span><span>pending</span>
    </Link>}
  </div>;
  return <div className="workbench-project-surface" data-production={isProd}>
    {slot && createPortal(controls, slot)}
    <div className="min-h-0 min-w-0 flex-1 bg-bg0">{children}</div>
  </div>;
}

export function ProjectChromeFallback({ loading, message, fix }: { loading: boolean; message?: string; fix?: string }) {
  if (loading) return <div className="space-y-5 p-7" role="status" aria-label="Loading project">
    <Skeleton className="h-7 w-56" /><Skeleton className="h-12 w-full" /><Skeleton className="h-64 w-full" />
  </div>;
  return <div className="grid h-full place-items-center p-6">
    <div className="max-w-[480px] border-t border-line pt-6">
      <p className="mb-3 text-[12px] text-err">Project unavailable</p>
      <h1 className="app-page-title">{message ?? "We couldn’t open this project"}</h1>
      <p className="mt-3 text-[14px] leading-relaxed text-ink-mute">{fix ?? "Check the URL, or choose a project from your workspace overview."}</p>
      <Link href="/overview" className="mt-6 inline-flex min-h-9 items-center text-[13px] font-medium text-signal hover:underline">Return to workspace overview →</Link>
    </div>
  </div>;
}
