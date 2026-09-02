/** Single call the app shell hydrates from. */
import type { Role } from "@/lib/actions/core";
import { db } from "@/lib/db/store";
import type { Workspace } from "@/lib/domain/types";
import { providerRegistry } from "@/lib/providers/types";
import {
  currentRequest,
  demoActor,
  readAutonomy,
  requireWorkspace,
  route,
  workspaceRole,
  workspacesFor,
} from "@/lib/server/context";
import { isSupabaseConfigured } from "@/lib/supabase/env";

export const dynamic = "force-dynamic";

/** One row of the shell's workspace switcher: what it is, and what you are in it. */
interface WorkspaceRow extends Pick<Workspace, "id" | "name" | "slug"> {
  role: Role;
}

export const GET = route(async () => {
  const state = currentRequest();
  const user = state?.user ?? null;
  // A signed-in stranger is refused by name here (requireWorkspace throws the
  // denial) rather than silently becoming an editor of whichever workspace
  // sorted first.
  const workspace = requireWorkspace();
  const d = db();

  /** the caller's own role *here* — every role-gated control in the UI reads this */
  const role: Role | null =
    isSupabaseConfigured() && !user
      ? null
      : (state?.member?.role ?? workspaceRole(demoActor()));

  /** every workspace the caller can switch to, with their role in each */
  const workspaces: WorkspaceRow[] = workspacesFor(user).map((w) => ({
    id: w.id,
    name: w.name,
    slug: w.slug,
    // Demo mode is one local user who is admin of the one workspace there is.
    role: user ? (d.members.find((m) => m.workspaceId === w.id && m.id === user.id)?.role ?? "viewer") : "admin",
  }));

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
    workspaces,
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
