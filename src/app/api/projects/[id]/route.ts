/** Everything a project screen needs, by id or slug. */
import { db, q } from "@/lib/db/store";
import { emptyManifest, type Changeset } from "@/lib/domain/types";
import { diffManifests, validateManifest } from "@/lib/domain/graph";
import { securityModule } from "@/lib/server/boot";
import { notFound, route } from "@/lib/server/context";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (_req, { id }) => {
  const project = q.project(id);
  if (!project)
    throw notFound(
      `Project "${id}"`,
      "Check the URL, or pick a project from the workspace overview."
    );

  const environments = q.environmentsOf(project.id);

  const changesets: Record<string, Changeset> = {};
  for (const env of environments) {
    const deployed = env.deployedRevisionId ? q.revision(env.deployedRevisionId) : undefined;
    changesets[env.id] = diffManifests(
      deployed?.manifest ?? emptyManifest(),
      project.workingManifest
    );
  }

  // Refresh findings if the security scanner has shipped; otherwise show stored ones.
  const security = await securityModule();
  try {
    security?.syncFindings?.(project.id);
  } catch (err) {
    console.warn("[orrery/api] syncFindings failed", err);
  }

  return {
    project,
    environments,
    /** meta only — full manifests come from /api/revisions/:id */
    revisions: q.revisionsOf(project.id).map((r) => ({
      id: r.id,
      number: r.number,
      message: r.message,
      author: r.author,
      createdAt: r.createdAt,
    })),
    findings: db().findings.filter((f) => f.projectId === project.id),
    workingIssues: validateManifest(project.workingManifest),
    changesets,
  };
});
