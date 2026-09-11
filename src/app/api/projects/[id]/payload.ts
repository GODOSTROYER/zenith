/**
 * The project payload — one shape, two transports.
 *
 * `GET /api/projects/:id` returns it with an ETag; `GET /api/projects/:id/stream`
 * pushes the same object whenever the store says the project changed. Both go
 * through here so the two can never drift apart, and both get the same
 * caching: changesets and validation are memoised on (working-copy hash,
 * deployed revision per environment), so a rebuild that changes nothing
 * recomputes nothing.
 *
 * Not a route file — colocated with the routes that use it.
 */
import { db, q } from "@/lib/db/store";
import {
  emptyManifest,
  hash32,
  type Changeset,
  type Environment,
  type Project,
} from "@/lib/domain/types";
import { diffManifests, validateManifest } from "@/lib/domain/graph";
import { manifestHash } from "@/lib/actions/defs/project-manifest";
import { log } from "@/lib/log";
import { securityModule } from "@/lib/server/boot";

type ValidationIssues = ReturnType<typeof validateManifest>;

interface ProjectCache {
  /** hash of the working manifest these entries were computed from */
  hash: string;
  issues: ValidationIssues;
  /** per environment: the deployed revision it was diffed against, and the result */
  changesets: Map<string, { against: string; changeset: Changeset }>;
}

type G = typeof globalThis & { __zenithProjectCache?: Map<string, ProjectCache> };

function cacheFor(project: Project): ProjectCache {
  const all = ((globalThis as G).__zenithProjectCache ??= new Map());
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
  // Cold storage: loads the deployed manifest on demand, cached by the store.
  const deployed = env.deployedRevisionId
    ? q.revisionManifest(env.deployedRevisionId)
    : undefined;
  const changeset = diffManifests(deployed ?? emptyManifest(), project.workingManifest);
  cache.changesets.set(env.id, { against, changeset });
  return changeset;
}

export interface ProjectPayload {
  /** ETag for the payload; also the "did anything change" test for the stream. */
  etag: string;
  body: Record<string, unknown>;
}

/**
 * Build the payload for one project. `only` is the `?env=<id>` narrowing —
 * the screens show one environment at a time, so only that changeset is
 * computed.
 */
export async function projectPayload(
  project: Project,
  only: string | null
): Promise<ProjectPayload> {
  const environments = q.environmentsOf(project.id);
  const cache = cacheFor(project);

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

  // The literal above fixes key order, so a plain stringify is a stable digest.
  return { etag: `W/"${hash32(JSON.stringify(body))}"`, body };
}
