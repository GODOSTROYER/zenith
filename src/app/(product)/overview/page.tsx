import type { Metadata } from "next";
import Link from "next/link";
import { Boxes } from "lucide-react";
import { db, readAudit } from "@/lib/db/store";
import { monthlyCostUsd } from "@/lib/cost/pricing";
import { diffManifests } from "@/lib/domain/graph";
import { emptyManifest, type Deployment, type Manifest } from "@/lib/domain/types";
import { fmtUsd } from "@/lib/format";
import { currentWorkspace } from "@/lib/server/context";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { TimeAgo } from "@/components/ui/time-ago";
import { ActorDot } from "@/components/screens/shared";
import { Greeting } from "./greeting";
import { LiveRefresh } from "./live-refresh";
import { ProjectGrid } from "./project-grid";
import { envStatus, type EnvRow, type ProjectRow } from "./rows";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Overview" };

/** Rows in the activity panel. Small, because the trail screen is one click away. */
const ACTIVITY_ROWS = 10;

/** A Link that has to look like the primary Button; the kit has no `asChild`. */
const PRIMARY_LINK =
  "inline-flex h-8 items-center rounded-ctl bg-signal px-3 text-[13px] font-medium text-on-signal hover:brightness-110";

export default async function OverviewPage() {
  // The workspace the browser is in — the same resolution /api uses, so this
  // screen and the shell above it can never be looking at different ones.
  const workspace = await currentWorkspace();
  const data = db();

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
              className={PRIMARY_LINK}
            >
              Set up Orrery
            </Link>
          }
        />
      </div>
    );

  const projects = data.projects.filter((p) => p.workspaceId === workspace.id);
  const revisions = new Map(data.revisions.map((r) => [r.id, r]));

  /** latest deployment per environment — drives the health dot on each chip */
  const latestDeploy = new Map<string, Deployment>();
  /** latest *finished* deployment per environment — "last deployed" is not "last attempted" */
  const lastSuccess = new Map<string, Deployment>();
  for (const dep of data.deployments) {
    const cur = latestDeploy.get(dep.environmentId);
    if (!cur || cur.createdAt < dep.createdAt) latestDeploy.set(dep.environmentId, dep);
    if (dep.status !== "succeeded") continue;
    const won = lastSuccess.get(dep.environmentId);
    if (!won || (won.endedAt ?? won.createdAt) < (dep.endedAt ?? dep.createdAt))
      lastSuccess.set(dep.environmentId, dep);
  }

  const rows: ProjectRow[] = projects.map((p) => {
    const envs = data.environments.filter((e) => e.projectId === p.id);
    const working = monthlyCostUsd(p.workingManifest);
    let deployedUsd = 0;
    let lastDeployedAt: string | undefined;

    const environments: EnvRow[] = envs.map((e) => {
      const deployed: Manifest | undefined = e.deployedRevisionId
        ? revisions.get(e.deployedRevisionId)?.manifest
        : undefined;
      if (deployed) deployedUsd += monthlyCostUsd(deployed);
      // The same diff the project screen shows, against what this env runs.
      const changeset = diffManifests(deployed ?? emptyManifest(), p.workingManifest);
      const done = lastSuccess.get(e.id);
      const at = done?.endedAt ?? done?.createdAt;
      if (at && (!lastDeployedAt || lastDeployedAt < at)) lastDeployedAt = at;
      const revision = e.deployedRevisionId
        ? `r${revisions.get(e.deployedRevisionId)?.number ?? "?"}`
        : null;
      return {
        id: e.id,
        name: e.name,
        klass: e.class,
        region: e.region,
        ...envStatus(e, latestDeploy.get(e.id)),
        revision,
        pending: changeset.items.length,
        lastDeployedAt: at,
        projectedUsd: changeset.projectedMonthlyUsd,
        budgetUsd: e.policies.budgetUsdMonthly,
      };
    });

    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      workingUsd: working,
      deployedUsd: Math.round(deployedUsd * 100) / 100,
      openFindings: data.findings.filter((f) => f.projectId === p.id && f.status === "open").length,
      pending: environments.reduce((n, e) => Math.max(n, e.pending), 0),
      environments,
      lastDeployedAt,
    };
  });

  const workspaceWorking = Math.round(rows.reduce((n, r) => n + r.workingUsd, 0) * 100) / 100;
  const workspaceDeployed = Math.round(rows.reduce((n, r) => n + r.deployedUsd, 0) * 100) / 100;

  /**
   * The workspace trail, not one project's — every row says which project it
   * belongs to, so "whichever project sorted first" is never implied.
   */
  const names = new Map(projects.map((p) => [p.id, p]));
  const activity = readAudit({ workspaceId: workspace.id, limit: ACTIVITY_ROWS });

  return (
    <div className="product-page mx-auto h-full w-full max-w-[1320px] overflow-y-auto">
      <LiveRefresh />
      <header className="mb-8 flex flex-wrap items-end justify-between gap-x-8 gap-y-4 border-b border-line pb-7">
        <div>
          {/* The workspace is what this screen is about; the greeting is context. */}
          <h1 className="text-[28px] leading-tight font-medium tracking-[-0.015em] text-ink">
            {workspace.name}
          </h1>
          <p className="mt-1 text-[14px] text-ink-mute">
            <Greeting /> — {projects.length} project{projects.length === 1 ? "" : "s"}
          </p>
        </div>
        {projects.length > 0 && (
          <div className="text-right">
            <p
              className="tnum text-[16px] text-ink"
              title="Estimated monthly cost of every project's working system definition, at list prices."
            >
              {fmtUsd(workspaceWorking)}
              <span className="text-[13px] text-ink-faint">/mo working</span>
            </p>
            <p
              className="tnum mt-0.5 text-[12.5px] text-ink-faint"
              title="Estimated monthly cost of what this workspace is actually running now."
            >
              {fmtUsd(workspaceDeployed)}/mo deployed
            </p>
          </div>
        )}
      </header>

      {projects.length === 0 ? (
        <EmptyState
          icon={<Boxes className="h-5 w-5" />}
          title="Nothing running yet"
          body="Start from a blueprint, import a docker-compose file, or begin with an empty system."
          action={
            <Link
              href="/onboarding?step=3"
              className={PRIMARY_LINK}
            >
              Create your first project
            </Link>
          }
        />
      ) : (
        /* No 320px column is reserved when there is no aside to put in it. */
        <div className={activity.length > 0 ? "grid items-start gap-8 xl:grid-cols-[minmax(0,1fr)_300px]" : ""}>
          <ProjectGrid projects={rows} />

          {activity.length > 0 && (
            <aside>
              <h2 className="mb-4 text-[18px] font-medium text-ink">
                Recent activity
              </h2>
              <Card padded={false}>
                <ul>
                  {activity.map((e) => {
                    const project = e.projectId ? names.get(e.projectId) : undefined;
                    return (
                      <li
                        key={e.id}
                        className="flex items-start gap-2.5 border-b border-line px-4 py-2.5 last:border-b-0"
                      >
                        <span className="mt-1.5">
                          <ActorDot actor={e.actor} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="line-clamp-2 text-[13px] leading-relaxed text-ink" title={e.summary}>
                            {e.summary}
                          </p>
                          <p className="mt-1 break-words text-[12px] text-ink-faint">
                            {project ? (
                              <Link
                                href={`/p/${project.slug}/activity`}
                                title={`Full activity trail for ${project.name}`}
                                className="text-signal hover:underline"
                              >
                                {project.name}
                              </Link>
                            ) : (
                              "workspace"
                            )}{" "}
                            · {e.actionId} · <TimeAgo iso={e.ts} />
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
