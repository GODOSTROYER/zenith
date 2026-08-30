import type { Metadata } from "next";
import Link from "next/link";
import { Boxes, Plus } from "lucide-react";
import { db, readAudit } from "@/lib/db/store";
import { monthlyCostUsd } from "@/lib/cost/pricing";
import type { AuditEvent, Environment, Project } from "@/lib/domain/types";
import { fmtUsd } from "@/lib/format";
import { Card, Chip, EmptyState, TimeAgo } from "@/components/ui";
import { ActorDot, EnvDot } from "@/components/screens/shared";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Overview" };

function daypart(): string {
  const h = new Date().getHours();
  return h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function revisionNumber(env: Environment, numbers: Map<string, number>): string {
  if (!env.deployedRevisionId) return "not deployed";
  const n = numbers.get(env.deployedRevisionId);
  return n ? `r${n}` : "deployed";
}

export default function OverviewPage() {
  const data = db();
  const workspace = data.workspaces[0];

  if (!workspace)
    return (
      <div className="mx-auto max-w-[560px] py-24">
        <EmptyState
          icon={<Boxes className="h-5 w-5" />}
          title="No workspace yet"
          body="Orrery needs a workspace before it can hold projects, connections and history."
          action={
            <Link
              href="/onboarding"
              className="inline-flex h-8 items-center rounded-ctl bg-signal px-3 text-[13px] font-medium text-on-signal hover:brightness-110"
            >
              Set up Orrery
            </Link>
          }
        />
      </div>
    );

  const projects = data.projects.filter((p) => p.workspaceId === workspace.id);
  const numbers = new Map(data.revisions.map((r) => [r.id, r.number]));
  const audit: AuditEvent[] = projects[0]
    ? readAudit({ projectId: projects[0].id, limit: 8 })
    : [];

  return (
    <div className="mx-auto h-full w-full overflow-y-auto max-w-[1160px] px-8 py-10">
      <header className="mb-9">
        <h1 className="text-[28px] leading-tight font-medium tracking-[-0.015em] text-ink">
          {daypart()}
        </h1>
        <p className="mt-1 text-[14px] text-ink-mute">
          {workspace.name} — {projects.length} project{projects.length === 1 ? "" : "s"}
        </p>
      </header>

      {projects.length === 0 ? (
        <EmptyState
          icon={<Boxes className="h-5 w-5" />}
          title="Nothing running yet"
          body="Start from a blueprint, import a docker-compose file, or begin with an empty system."
          action={
            <Link
              href="/onboarding?step=3"
              className="inline-flex h-8 items-center rounded-ctl bg-signal px-3 text-[13px] font-medium text-on-signal hover:brightness-110"
            >
              Create your first project
            </Link>
          }
        />
      ) : (
        <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
          <div className="grid gap-4 sm:grid-cols-2">
            {projects.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                environments={data.environments.filter((e) => e.projectId === p.id)}
                numbers={numbers}
              />
            ))}
            <Link
              href="/onboarding?step=3"
              className="flex min-h-[148px] flex-col items-center justify-center gap-2 rounded-card border border-dashed border-line-strong bg-bg1 text-ink-mute transition-colors duration-[var(--dur-fast)] hover:border-signal hover:text-signal"
            >
              <Plus className="h-4 w-4" />
              <span className="text-[13px]">New project</span>
            </Link>
          </div>

          {audit.length > 0 && (
            <aside>
              <h2 className="mb-3 text-[12px] tracking-[0.02em] text-ink-mute uppercase">
                Recent activity
              </h2>
              <Card padded={false}>
                <ul>
                  {audit.map((e) => (
                    <li
                      key={e.id}
                      className="flex items-start gap-2.5 border-b border-line px-4 py-2.5 last:border-b-0"
                    >
                      <span className="mt-1.5">
                        <ActorDot actor={e.actor} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12.5px] text-ink" title={e.summary}>
                          {e.summary}
                        </p>
                        <p className="mt-0.5 font-mono text-[11px] text-ink-faint">
                          {e.actionId} · <TimeAgo iso={e.ts} />
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
              {projects[0] && (
                <Link
                  href={`/p/${projects[0].slug}/activity`}
                  className="mt-3 inline-block text-[12.5px] text-signal hover:underline"
                >
                  Full activity trail →
                </Link>
              )}
            </aside>
          )}
        </div>
      )}
    </div>
  );
}

function ProjectCard({
  project,
  environments,
  numbers,
}: {
  project: Project;
  environments: Environment[];
  numbers: Map<string, number>;
}) {
  const hasProd = environments.some((e) => e.class === "production");
  return (
    <Link href={`/p/${project.slug}`} className="group block">
      <Card
        prod={hasProd}
        className="h-full transition-colors duration-[var(--dur-fast)] group-hover:border-line-strong"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-[16px] font-medium text-ink">{project.name}</h3>
            <p className="mt-0.5 font-mono text-[11.5px] text-ink-faint">/p/{project.slug}</p>
          </div>
          <span className="tnum shrink-0 text-[13px] text-ink">
            {fmtUsd(monthlyCostUsd(project.workingManifest))}
            <span className="text-ink-faint">/mo est.</span>
          </span>
        </div>

        <div className="mt-4 flex flex-wrap gap-1.5">
          {environments.length === 0 ? (
            <span className="text-[12.5px] text-ink-faint">No environments yet</span>
          ) : (
            environments.map((e) => (
              <Chip
                key={e.id}
                tone={e.class === "production" ? "prod" : "neutral"}
                icon={<EnvDot klass={e.class} />}
                title={`${e.name} — ${e.class} in ${e.region}`}
              >
                {e.name} <span className="tnum text-ink-faint">{revisionNumber(e, numbers)}</span>
              </Chip>
            ))
          )}
        </div>
      </Card>
    </Link>
  );
}
