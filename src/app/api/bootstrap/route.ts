/** Single call the app shell hydrates from. */
import { roleOf, type Role } from "@/lib/actions/core";
import { db } from "@/lib/db/store";
import { providerRegistry } from "@/lib/providers/types";
import {
  ApiError,
  demoActor,
  ensureMember,
  readAutonomy,
  requireWorkspace,
  route,
} from "@/lib/server/context";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { sessionUserFromRequest } from "@/lib/supabase/route";

export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  const workspace = requireWorkspace();
  const d = db();
  /** null = signed out (or auth not configured — see `auth.configured`) */
  const user = await sessionUserFromRequest(req);
  /** the caller's own role — every role-gated control in the UI reads this */
  let role: Role | null = isSupabaseConfigured() ? null : roleOf(demoActor());
  if (user) {
    const outcome = ensureMember(user);
    // A signed-in stranger is refused by name here rather than silently
    // becoming an editor of the only workspace.
    if ("denied" in outcome)
      throw new ApiError(outcome.denied.message, 403, { fix: outcome.denied.fix });
    role = outcome.member.role;
  }
  const projects = d.projects.filter((p) => p.workspaceId === workspace.id);
  const projectIds = new Set(projects.map((p) => p.id));
  const environments = d.environments.filter((e) => projectIds.has(e.projectId));

  /** latest deployment per environment — the map/overview health source */
  const deployments = environments
    .map((env) =>
      d.deployments
        .filter((dep) => dep.environmentId === env.id)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]
    )
    .filter((dep) => dep !== undefined);

  return {
    workspace,
    projects,
    environments,
    deployments,
    connections: d.connections.filter((c) => c.workspaceId === workspace.id),
    /** availability drives every label in the UI — never presented as available */
    providers: [...providerRegistry().values()].map((p) => ({
      id: p.id,
      displayName: p.displayName,
      availability: p.availability,
      tagline: p.tagline,
      regions: p.regions,
    })),
    settings: { ...d.settings, autonomy: readAutonomy() },
    user,
    role,
    auth: { configured: isSupabaseConfigured() },
    members: d.members.filter((m) => m.workspaceId === workspace.id),
  };
});
