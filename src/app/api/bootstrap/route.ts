/** Single call the app shell hydrates from. */
import { db } from "@/lib/db/store";
import { providerRegistry } from "@/lib/providers/types";
import { ensureMember, readAutonomy, requireWorkspace, route } from "@/lib/server/context";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { sessionUserFromRequest } from "@/lib/supabase/route";

export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  const workspace = requireWorkspace();
  const d = db();
  /** null = signed out (or auth not configured — see `auth.configured`) */
  const user = await sessionUserFromRequest(req);
  if (user) ensureMember(user);
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
    auth: { configured: isSupabaseConfigured() },
    members: d.members.filter((m) => m.workspaceId === workspace.id),
  };
});
