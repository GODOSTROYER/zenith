import type { Metadata } from "next";
import Link from "next/link";
import { Boxes, Plus } from "lucide-react";
import { db, readAudit } from "@/lib/db/store";
import { monthlyCostUsd } from "@/lib/cost/pricing";
import type { AuditEvent, Deployment, Environment, Project } from "@/lib/domain/types";
import { fmtUsd } from "@/lib/format";
import { Card, Chip, EmptyState, StatusDot, TimeAgo, type DotStatus } from "@/components/ui";
import { ActorDot, EnvDot } from "@/components/screens/shared";
import { Greeting } from "./greeting";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Overview" };

function revisionNumber(env: Environment, numbers: Map<string, number>): string | null {
  if (!env.deployedRevisionId) return null;
  const n = numbers.get(env.deployedRevisionId);
  return n ? `r${n}` : "deployed";
}

/**
 * What the environment chip says out loud. Colour is never the only carrier:
 * every state also has a word, and the dot carries an accessible label.
 */
function envStatus(
  env: Environment,
  latest: Deployment | undefined
): { dot: DotStatus; word: string } {
  switch (latest?.status) {
    case "applying":
    case "verifying":
      return { dot: "running", word: "deploying" };
    case "rolling_back":
      return { dot: "running", word: "rolling back" };
    case "failed":
      return { dot: "err", word: "deploy failed" };
    case "awaiting_approval":
      return { dot: "warn", word: "awaiting approval" };
    default:
      return env.deployedRevisionId
        ? { dot: "ok", word: "live" }
        : { dot: "idle", word: "not deployed" };
  }
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

  /** latest deployment per environment — drives the health dot on each chip */
  const latestDeploy = new Map<string, Deployment>();
  for (const dep of data.deployments) {
    const cur = latestDeploy.get(dep.environmentId);
    if (!cur || cur.createdAt < dep.createdAt) latestDeploy.set(dep.environmentId, dep);
  }

  /**
   * The panel shows one project's history, so it shows the one that moved
   * last — and says whose history it is. Never "whichever project sorted
   * first", which silently lies once there are two.
   */
  const workspaceAudit: AuditEvent[] = readAudit({ workspaceId: workspace.id });
  const activeProject =
    projects.find((p) => p.id === workspaceAudit.find((e) => e.projectId)?.projectId) ??
    projects[0];
  const audit = activeProject
    ? workspaceAudit.filter((e) => e.projectId === activeProject.id).slice(0, 8)
    : [];

  return (
    <div className="mx-auto h-full w-full overflow-y-auto max-w-[1160px] px-8 py-10">
      <header className="mb-9">
        <h1 className="text-[28px] leading-tight font-medium tracking-[-0.015em] text-ink">
          <Greeting />
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
                latestDeploy={latestDeploy}
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

          {activeProject && audit.length > 0 && (
            <aside>
              <h2 className="mb-3 text-[12px] tracking-[0.02em] text-ink-mute uppercase">
                Recent activity — {activeProject.name}
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
              <Link
                href={`/p/${activeProject.slug}/activity`}
                className="mt-3 inline-block text-[12.5px] text-signal hover:underline"
              >
                Full activity trail for {activeProject.name} →
              </Link>
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
  latestDeploy,
}: {
  project: Project;
  environments: Environment[];
  numbers: Map<string, number>;
  /** latest deployment per environment id */
  latestDeploy: Map<string, Deployment>;
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
            environments.map((e) => {
              const { dot, word } = envStatus(e, latestDeploy.get(e.id));
              const rev = revisionNumber(e, numbers);
              return (
                <Chip
                  key={e.id}
                  tone={e.class === "production" ? "prod" : "neutral"}
                  icon={<EnvDot klass={e.class} />}
                  title={`${e.name} — ${e.class} in ${e.region} · ${rev ? `${rev} ${word}` : word}`}
                >
                  {e.name}{" "}
                  <span className="tnum text-ink-faint">
                    {rev ? `${rev} ${word}` : word}
                  </span>
                  <StatusDot
                    status={dot}
                    size={6}
                    label={`${e.name}: ${word}`}
                    className="ml-0.5"
                  />
                </Chip>
              );
            })
          )}
        </div>
      </Card>
    </Link>
  );
}
