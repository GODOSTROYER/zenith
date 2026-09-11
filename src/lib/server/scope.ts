/**
 * Workspace-bound id resolvers, and the action context a route hands down.
 *
 * An object id is a bearer token, and knowing one must not be enough to read it
 * from another tenant. Each resolver below goes through the owning project's
 * workspace and answers a foreign id **exactly** as it answers a missing one:
 * the same 404, the same sentence, so the id space is not enumerable across
 * workspaces. Every check lives here rather than being retyped per route,
 * because the one route that forgets to retype it is the whole hole.
 *
 * Split out of `server/context.ts`, which re-exports everything here.
 */
import type { ActionContext } from "@/lib/actions/core";
import { db, inWorkspace, q } from "@/lib/db/store";
import {
  AutonomyLevel,
  type Actor,
  type Deployment,
  type Environment,
  type Project,
} from "@/lib/domain/types";
import { notFound } from "@/lib/server/errors";
import { demoActor } from "@/lib/server/actor";
import { requireWorkspace } from "@/lib/server/workspace";

export function scopedProject(id: string): Project {
  // Search *within* the workspace rather than resolving globally and then
  // checking. `id` may be a slug, and slugs are only unique per workspace, so a
  // global match would hand back whichever workspace sorted first — and answer
  // 404 to the other workspace's member asking for their own project.
  const ws = requireWorkspace().id;
  const project = db().projects.find((p) => (p.id === id || p.slug === id) && p.workspaceId === ws);
  if (!project)
    throw notFound(
      `Project "${id}"`,
      "Check the URL, or pick a project from the workspace overview."
    );
  return project;
}

export function scopedEnvironment(id: string): Environment {
  const env = q.environment(id);
  if (!env || !inWorkspace(requireWorkspace().id, env.projectId))
    throw notFound(
      `Environment "${id}"`,
      "Pick an environment from the project's Observe tab."
    );
  return env;
}

export function scopedDeployment(id: string): Deployment {
  const deployment = q.deployment(id);
  if (!deployment || !inWorkspace(requireWorkspace().id, deployment.projectId))
    throw notFound(
      `Deployment "${id}"`,
      "Open the project's Deploys tab to see deployments that exist."
    );
  return deployment;
}

/** Effective autonomy for the Navigator. Defaults to the safe level: approve. */
export function readAutonomy(): AutonomyLevel {
  const parsed = AutonomyLevel.safeParse(db().settings.autonomy);
  return parsed.success ? parsed.data : "approve";
}

export interface Scope {
  projectId?: string;
  environmentId?: string;
}

export function buildCtx(scope: Scope = {}, actor: Actor = demoActor()): ActionContext {
  return {
    workspaceId: requireWorkspace().id,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    actor,
    autonomy: actor.type === "navigator" ? readAutonomy() : undefined,
  };
}
