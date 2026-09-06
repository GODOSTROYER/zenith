"use client";
/**
 * The project cards, and the controls over them.
 *
 * The card is not one big link any more: the title, each environment and the
 * findings count each go somewhere different, and an anchor cannot contain an
 * anchor. Each environment link carries `?env=<id>`, which the project shell
 * honours, so "staging" on this screen opens staging on the next one.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, GitPullRequest, Plus, Search, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Meter } from "@/components/ui/meter";
import { Select } from "@/components/ui/select";
import { StatusDot } from "@/components/ui/status-dot";
import { TimeAgo } from "@/components/ui/time-ago";
import { EnvDot } from "@/components/screens/shared";
import { fmtUsd } from "@/lib/format";
import {
  filterProjects,
  needsAttention,
  sortProjects,
  SORTS,
  type EnvRow,
  type ProjectRow,
  type SortKey,
} from "./rows";

export function ProjectGrid({ projects }: { projects: ProjectRow[] }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("attention");
  const [onlyAttention, setOnlyAttention] = useState(false);

  const shown = useMemo(
    () => sortProjects(filterProjects(projects, query, onlyAttention), sort),
    [projects, query, onlyAttention, sort]
  );
  const waiting = projects.filter(needsAttention).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[20px] font-medium text-ink">Projects <span className="ml-1 text-[14px] text-ink-faint">{projects.length}</span></h2>
        <Link href="/onboarding?step=3" className="ui-button inline-flex h-9 items-center gap-2 rounded-ctl bg-signal px-3.5 text-[13px] font-medium text-on-signal transition-colors hover:bg-signal-strong">
          <Plus className="h-4 w-4" aria-hidden="true" /> New project
        </Link>
      </div>
      {projects.length > 1 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter projects"
            placeholder="Filter by project or environment"
            prefix={<Search className="h-3.5 w-3.5" aria-hidden="true" />}
            className="w-full sm:w-[280px]"
          />
          <Select
            aria-label="Sort projects"
            title="What decides the order of these projects."
            className="w-[190px]"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            options={SORTS.map((s) => ({ value: s.value, label: s.label }))}
          />
          <Checkbox
            checked={onlyAttention}
            onChange={setOnlyAttention}
            disabled={waiting === 0}
            disabledReason="Nothing in this workspace is waiting on you right now."
            label={`Needs attention (${waiting})`}
          />
          <span aria-live="polite" className="tnum ml-auto text-[12.5px] text-ink-faint">
            {shown.length} of {projects.length}
          </span>
        </div>
      )}

      <div className="divide-y divide-line border-y border-line">
        {shown.map((p) => (
          <ProjectLedger key={p.id} project={p} />
        ))}
        {shown.length === 0 && (
          <div className="space-y-3 px-5 py-8">
            <p className="text-[14px] text-ink-mute">No project matches those filters.</p>
            <Button onClick={() => { setQuery(""); setOnlyAttention(false); }}>Clear filters</Button>
          </div>
        )}
      </div>
    </div>
  );
}

function ProjectLedger({ project: p }: { project: ProjectRow }) {
  return (
    <article className="grid gap-5 py-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.8fr)] lg:gap-8" aria-label={p.name}>
      <div className="min-w-0">
        <div className="min-w-0">
          <h3 className="break-words text-[19px] font-semibold text-ink [overflow-wrap:anywhere]">
            <Link
              href={`/p/${p.slug}`}
              className="rounded-ctl transition-colors duration-[var(--dur-fast)] hover:text-signal"
            >
              {p.name}
            </Link>
          </h3>
          <p className="mt-1 break-all font-mono text-[12px] text-ink-faint">/p/{p.slug}</p>
        </div>
        {/* Two numbers, because they are two different claims. */}
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-left">
          <p
            className="tnum font-mono text-[14px] text-ink"
            title="Estimated monthly cost of the working system definition, at list prices. Nothing is running at this number until you deploy."
          >
            {fmtUsd(p.workingUsd)}
            <span className="mt-1 block font-sans text-[12px] text-ink-faint">working / month · estimate</span>
          </p>
          <p
            className="tnum font-mono text-[14px] text-ink"
            title="Estimated monthly cost of what these environments are actually running now."
          >
            {fmtUsd(p.deployedUsd)}
            <span className="mt-1 block font-sans text-[12px] text-ink-faint">deployed / month · estimate</span>
          </p>
        </div>
      {(p.pending > 0 || p.openFindings > 0) && (
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-[12px]">
          {p.pending > 0 && (
            <Link href={`/p/${p.slug}`} className="inline-flex items-center gap-1.5 text-signal hover:underline" title="Largest pending changeset across this project's environments. Review the environment rows for exact counts.">
              <GitPullRequest className="h-3.5 w-3.5" aria-hidden="true" />
              Up to <span className="tnum">{p.pending}</span> pending
            </Link>
          )}
          {p.openFindings > 0 && (
            <Link href={`/p/${p.slug}/security`} className="inline-flex items-center gap-1.5 text-warn hover:underline">
                <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="tnum">{p.openFindings}</span> open finding
                {p.openFindings === 1 ? "" : "s"}
            </Link>
          )}
        </div>
      )}
      {p.lastDeployedAt && (
        <p className="mt-4 text-[12px] text-ink-faint">
          Last deployed <TimeAgo iso={p.lastDeployedAt} />
        </p>
      )}
      </div>
      <div className="min-w-0 divide-y divide-line border-y border-line bg-bg2 px-4 lg:border-y-0 lg:border-l">
        {p.environments.length === 0 ? (
          <span className="text-[12.5px] text-ink-faint">No environments yet</span>
        ) : (
          p.environments.map((e) => <EnvironmentRow key={e.id} slug={p.slug} env={e} />)
        )}
      </div>

    </article>
  );
}

function EnvironmentRow({ slug, env: e }: { slug: string; env: EnvRow }) {
  return (
    <div className="py-3">
    <Link
      href={`/p/${slug}?env=${encodeURIComponent(e.id)}`}
      className="group grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 rounded-ctl py-1 transition-colors hover:text-signal"
    >
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2 text-[13px] font-medium"><EnvDot klass={e.klass} /><span className="break-all">{e.name}</span>{e.klass === "production" && <span className="rounded-[var(--r-pill)] bg-warn-dim px-1.5 py-0.5 text-[11px] text-prod">Production</span>}</span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-mute"><StatusDot status={e.dot} size={6} label={`${e.name}: ${e.word === "live" ? "deployed" : e.word}`} />{e.word === "live" ? "deployed" : e.word}{e.revision && <span className="font-mono">· {e.revision}</span>}<span className="font-mono text-ink-faint">· {e.region}</span></span>
        {e.providerLabel && <span className="mt-1 block text-[12px] text-ink-faint">{e.providerLabel}</span>}
      </span>
      <span className="flex items-center gap-3"><span className={e.pending > 0 ? "tnum text-right text-[12px] text-signal" : "text-right text-[12px] text-ink-faint"}>{e.pending > 0 ? `${e.pending} pending` : "No pending changes"}</span><ArrowUpRight className="h-4 w-4 shrink-0 text-ink-faint transition-colors group-hover:text-signal" aria-hidden="true" /></span>
    </Link>
    {e.budgetUsd !== undefined ? <div className="mt-2"><Meter value={e.projectedUsd} max={e.budgetUsd} label={`${e.name} monthly budget`} hint={`${fmtUsd(e.projectedUsd)} projected / ${fmtUsd(e.budgetUsd)}`} /></div> : <p className="mt-2 flex flex-wrap justify-between gap-2 text-[12px] text-ink-faint"><span><span className="tnum font-mono">{fmtUsd(e.projectedUsd)}</span> / month projected · estimate</span><span>No budget set</span></p>}
    </div>
  );
}
