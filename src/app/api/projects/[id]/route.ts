/**
 * Everything a project screen needs, by id or slug.
 *
 * This is the endpoint the whole product polls, so it does as little as it can
 * get away with:
 *  - changesets and validation are cached on (working-copy hash, deployed
 *    revision per environment) — a poll that changes nothing recomputes nothing;
 *  - `?env=<id>` computes only that environment's changeset;
 *  - an unchanged payload answers `304 Not Modified` to `If-None-Match`.
 */
import { db, inWorkspace, q } from "@/lib/db/store";
import {
  emptyManifest,
  hash32,
  type Changeset,
  type Environment,
  type Project,
} from "@/lib/domain/types";
import { diffManifests, validateManifest } from "@/lib/domain/graph";
import { manifestHash } from "@/lib/actions/defs/manifest";
import { log } from "@/lib/log";
import { securityModule } from "@/lib/server/boot";
import { json, notFound, requireWorkspace, route } from "@/lib/server/context";

export const dynamic = "force-dynamic";

type ValidationIssues = ReturnType<typeof validateManifest>;

interface ProjectCache {
  /** hash of the working manifest these entries were computed from */
  hash: string;
  issues: ValidationIssues;
  /** per environment: the deployed revision it was diffed against, and the result */
  changesets: Map<string, { against: string; changeset: Changeset }>;
}

type G = typeof globalThis & { __orreryProjectCache?: Map<string, ProjectCache> };

function cacheFor(project: Project): ProjectCache {
  const all = ((globalThis as G).__orreryProjectCache ??= new Map());
  const hash = manifestHash(project.workingManifest);
  const hit = all.get(project.id);
  if (hit && hit.hash === hash) return hit;
  // The working copy moved: every derived value from the old one is stale.
  const fresh: ProjectCache = {
    hash,
    issues: validateManifest(project.workingManifest),
    changesets: new Map(),
  };
  all.set(project.id, fresh);
  return fresh;
}

function changesetFor(cache: ProjectCache, env: Environment, project: Project): Changeset {
  const against = env.deployedRevisionId ?? "";
  const hit = cache.changesets.get(env.id);
  if (hit && hit.against === against) return hit.changeset;
  const deployed = env.deployedRevisionId ? q.revision(env.deployedRevisionId) : undefined;
  const changeset = diffManifests(deployed?.manifest ?? emptyManifest(), project.workingManifest);
  cache.changesets.set(env.id, { against, changeset });
  return changeset;
}

export const GET = route<{ id: string }>(async (req, { id }) => {
  const project = q.project(id);
  if (!project)
    throw notFound(
      `Project "${id}"`,
      "Check the URL, or pick a project from the workspace overview."
    );
  // Knowing an id is not permission to read it.
  if (!inWorkspace(requireWorkspace().id, project.id))
    throw notFound(
      `Project "${id}"`,
      "Check the URL, or pick a project from the workspace overview."
    );

  const environments = q.environmentsOf(project.id);
  const cache = cacheFor(project);

  /** ?env=<id> — the screens show one environment at a time. */
  const only = req.nextUrl.searchParams.get("env");
  const wanted = only ? environments.filter((e) => e.id === only) : environments;
  const changesets: Record<string, Changeset> = {};
  for (const env of wanted) changesets[env.id] = changesetFor(cache, env, project);

  // Refresh findings if the security scanner has shipped; otherwise show stored ones.
  const security = await securityModule();
  try {
    security?.syncFindings?.(project.id);
  } catch (err) {
    log.warn("syncFindings failed", { projectId: project.id, err });
  }

  const body = {
    project,
    /**
     * Optimistic-concurrency token for the working copy. Send it back as
     * `expectedHash` on project.updateManifest and a stale save is refused
     * instead of silently overwriting someone else's edit.
     */
    manifestHash: cache.hash,
    environments,
    /** meta only — full manifests come from /api/revisions/:id */
    revisions: q.revisionsOf(project.id).map((r) => ({
      id: r.id,
      number: r.number,
      message: r.message,
      author: r.author,
      createdAt: r.createdAt,
      /** environments this revision was actually deployed to */
      deployedTo: r.deployedTo ?? [],
    })),
    findings: db().findings.filter((f) => f.projectId === project.id),
    workingIssues: cache.issues,
    changesets,
    /** absent unless ?env= narrowed the response, so a client can tell */
    changesetsScopedTo: only ?? undefined,
  };

  // 304 on an unchanged payload: this is polled every 5s per open tab.
  // The literal above fixes key order, so a plain stringify is a stable digest.
  const etag = `W/"${hash32(JSON.stringify(body))}"`;
  if (req.headers.get("if-none-match") === etag)
    return new Response(null, {
      status: 304,
      headers: { etag, "cache-control": "no-store" },
    });

  const res = json(body);
  res.headers.set("etag", etag);
  return res;
});
