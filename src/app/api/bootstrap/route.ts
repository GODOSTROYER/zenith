/** Single call the app shell hydrates from. */
import type { Role } from "@/lib/actions/core";
import { actionRegistry } from "@/lib/actions/core";
import { publicChannels, type PublicAlertChannel } from "@/lib/alerts/channels";
import { db } from "@/lib/db/store";
import type { AutonomyLevel, Workspace } from "@/lib/domain/types";
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

/**
 * The settings a browser is allowed to see — an allowlist, not a filter.
 *
 * `db().settings` is an untyped `Record<string, unknown>` bag that three
 * unrelated subsystems write into, and two of them keep things that must never
 * reach a client: `alertChannels[]` carries webhook HMAC signing secrets and
 * raw Slack incoming-webhook URLs (a URL-shaped bearer credential), and
 * `invites[]` carries the pending-invite email addresses of *every* workspace
 * on this server. Spreading the bag handed all of it to every signed-in member
 * of any workspace, in the very first call the shell makes.
 *
 * Naming each field instead means a key that is not listed here cannot reach
 * the wire, so the fourth subsystem to stash something in the bag is private by
 * default rather than published by default. Nothing may spread `db().settings`
 * into a response.
 */
interface BootstrapSettings {
  /**
   * Install-global, and said plainly rather than dressed up as workspace state:
   * `settings.autonomy` is a single bare enum with no workspace key, so moving
   * the dial moves it for every workspace on this server — which is what the
   * autonomy dial itself tells the operator ("changes the Navigator's autonomy
   * in every project, not just this one"). Keying it per workspace is a store
   * schema change, and the store is the integrator's file; until then, sitting
   * beside workspace-scoped fields is the only thing about it that is global.
   */
  autonomy: AutonomyLevel;
  /**
   * This workspace's channels only, scoped by `workspaceId` the same way
   * `channelsOf` scopes them for /api/projects/[id]/alerts — a member of one
   * workspace never learns another's endpoints. Every row goes through the
   * redacting `publicChannel` projection: `secret` becomes the boolean
   * `hasSecret`, and `target` is masked back to scheme + host.
   */
  alertChannels: PublicAlertChannel[];
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
  const environmentIds = new Set(environments.map((e) => e.id));
  const latest = new Map<string, (typeof d.deployments)[number]>();
  for (const deployment of d.deployments) {
    if (!environmentIds.has(deployment.environmentId)) continue;
    const previous = latest.get(deployment.environmentId);
    if (!previous || previous.createdAt < deployment.createdAt) latest.set(deployment.environmentId, deployment);
  }
  const deployments = environments.map((e) => latest.get(e.id)).filter((dep) => dep !== undefined);

  // Built as its own typed value so the compiler checks the allowlist rather
  // than an inline literal that a later `...` would quietly widen.
  const settings: BootstrapSettings = {
    autonomy: readAutonomy(),
    alertChannels: publicChannels(workspace.id),
  };

  return {
    workspace,
    // Boot already registered these handlers. Serialize display fields only;
    // page layouts never need to import the execution graph themselves.
    catalog: [...actionRegistry().values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, title, category, risk, requiredRole }) => ({ id, title, category, risk, requiredRole })),
    workspaces,
    projects,
    environments,
    deployments,
    // Preserve grantedPermissions as the last preflight snapshot. The UI also
    // needs today's provider declaration, but deriving it here is metadata-only
    // and must never be presented as if a live cloud check just ran.
    connections: d.connections
      .filter((c) => c.workspaceId === workspace.id)
      .map((c) => ({
        ...c,
        // Presentation alias only. Do not rename stored/user-defined connections.
        label: c.provider === "sandbox" && c.label === "Orrery Sandbox" ? "Zenith Sandbox" : c.label,
        declaredPermissions:
          providerRegistry().get(c.provider)?.accessExplanation().permissions ?? c.grantedPermissions,
      })),
    /** availability drives every label in the UI — never presented as available */
    providers: [...providerRegistry().values()].map((p) => ({
      id: p.id,
      displayName: p.displayName,
      availability: p.availability,
      tagline: p.tagline,
      regions: p.regions,
    })),
    settings,
    user,
    role,
    auth: { configured: isSupabaseConfigured() },
    members: d.members.filter((m) => m.workspaceId === workspace.id),
  };
});
