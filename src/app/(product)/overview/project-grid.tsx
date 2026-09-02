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
import { Plus, Search } from "lucide-react";
import {
  Card,
  Checkbox,
  Chip,
  Input,
  Meter,
  Select,
  StatusDot,
  TimeAgo,
} from "@/components/ui";
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
      {projects.length > 1 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter projects"
            placeholder="Filter by project or environment"
            prefix={<Search className="h-3.5 w-3.5" aria-hidden="true" />}
            className="w-[280px]"
          />
          <Select
            aria-label="Sort projects"
            title="What decides the order of these cards."
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
            label={`Only what needs me (${waiting})`}
          />
          <span aria-live="polite" className="tnum ml-auto text-[12.5px] text-ink-faint">
            {shown.length} of {projects.length}
          </span>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {shown.map((p) => (
          <ProjectCard key={p.id} project={p} />
        ))}
        {shown.length === 0 && (
          <p className="text-[13px] text-ink-mute sm:col-span-2">
            No project matches those filters. Clear the filter, or turn off “only what needs me”.
          </p>
        )}
        <Link
          href="/onboarding?step=3"
          className="flex min-h-[148px] flex-col items-center justify-center gap-2 rounded-card border border-dashed border-line-strong bg-bg1 text-ink-mute transition-colors duration-[var(--dur-fast)] hover:border-signal hover:text-signal"
        >
          <Plus className="h-4 w-4" />
          <span className="text-[13px]">New project</span>
        </Link>
      </div>
    </div>
  );
}

function ProjectCard({ project: p }: { project: ProjectRow }) {
  const hasProd = p.environments.some((e) => e.klass === "production");
  const budgeted = p.environments.filter((e) => e.budgetUsd !== undefined);

  return (
    <Card prod={hasProd} className="h-full">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-[16px] font-medium text-ink">
            <Link
              href={`/p/${p.slug}`}
              className="rounded-ctl transition-colors duration-[var(--dur-fast)] hover:text-signal"
            >
              {p.name}
            </Link>
          </h3>
          <p className="mt-0.5 font-mono text-[11.5px] text-ink-faint">/p/{p.slug}</p>
        </div>
        {/* Two numbers, because they are two different claims. */}
        <div className="shrink-0 text-right">
          <p
            className="tnum text-[13px] text-ink"
            title="Estimated monthly cost of the working system definition, at list prices. Nothing is running at this number until you deploy."
          >
            {fmtUsd(p.workingUsd)}
            <span className="text-ink-faint">/mo working</span>
          </p>
          <p
            className="tnum mt-0.5 text-[12px] text-ink-faint"
            title="Estimated monthly cost of what these environments are actually running now."
          >
            {fmtUsd(p.deployedUsd)}
            <span>/mo deployed</span>
          </p>
        </div>
      </div>

      {(p.pending > 0 || p.openFindings > 0) && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {p.pending > 0 && (
            <Link href={`/p/${p.slug}`}>
              <Chip
                tone="info"
                title={`${p.pending} change${p.pending === 1 ? "" : "s"} in the working copy that no environment is running yet. Opens the system map.`}
              >
                <span className="tnum">{p.pending}</span> to deploy
              </Chip>
            </Link>
          )}
          {p.openFindings > 0 && (
            <Link href={`/p/${p.slug}/security`}>
              <Chip
                tone="warn"
                title={`${p.openFindings} open security finding${p.openFindings === 1 ? "" : "s"}. Opens Security.`}
              >
                <span className="tnum">{p.openFindings}</span> open finding
                {p.openFindings === 1 ? "" : "s"}
              </Chip>
            </Link>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-1.5">
        {p.environments.length === 0 ? (
          <span className="text-[12.5px] text-ink-faint">No environments yet</span>
        ) : (
          p.environments.map((e) => <EnvChip key={e.id} slug={p.slug} env={e} />)
        )}
      </div>

      {budgeted.length > 0 && (
        <div className="mt-4 space-y-2.5">
          {budgeted.map((e) => (
            <Meter
              key={e.id}
              value={e.projectedUsd}
              max={e.budgetUsd}
              label={`${e.name} budget`}
              hint={`${fmtUsd(e.projectedUsd)} projected of ${fmtUsd(e.budgetUsd ?? 0)}`}
            />
          ))}
        </div>
      )}

      {p.lastDeployedAt && (
        <p className="mt-3 text-[11.5px] text-ink-faint">
          Last deployed <TimeAgo iso={p.lastDeployedAt} />
        </p>
      )}
    </Card>
  );
}

function EnvChip({ slug, env: e }: { slug: string; env: EnvRow }) {
  const state = e.revision ? `${e.revision} ${e.word}` : e.word;
  const pending = e.pending > 0 ? ` · ${e.pending} not deployed yet` : "";
  return (
    <Link
      href={`/p/${slug}?env=${encodeURIComponent(e.id)}`}
      className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-signal"
    >
      <Chip
        tone={e.klass === "production" ? "prod" : "neutral"}
        icon={<EnvDot klass={e.klass} />}
        title={`${e.name} — ${e.klass} in ${e.region} · ${state}${pending}. Opens this project on ${e.name}.`}
        className="transition-colors duration-[var(--dur-fast)] hover:border-line-strong"
      >
        {e.name} <span className="tnum text-ink-faint">{state}</span>
        {e.pending > 0 && (
          <span className="tnum text-info">
            <span aria-hidden="true">+{e.pending}</span>
            <span className="sr-only">
              , {e.pending} change{e.pending === 1 ? "" : "s"} not deployed here yet
            </span>
          </span>
        )}
        <StatusDot status={e.dot} size={6} label={`${e.name}: ${e.word}`} className="ml-0.5" />
      </Chip>
    </Link>
  );
}
