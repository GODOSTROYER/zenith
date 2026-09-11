/**
 * Single call the app shell hydrates from.
 *
 * Polled every 10s per open tab, so two things about it are deliberate:
 *  - the action catalog and the provider list are projections of registries
 *    that boot fills and nothing writes to afterwards, so they are built once;
 *  - an unchanged payload answers `304 Not Modified` to `If-None-Match`, which
 *    is most polls — a workspace's shape rarely moves between two of them.
 */
import type { Role } from "@/lib/actions/core";
import { actionRegistry } from "@/lib/actions/core";
import { publicChannels, type PublicAlertChannel } from "@/lib/alerts/channels";
import { db } from "@/lib/db/store";
import type { AutonomyLevel, ProviderId, Workspace } from "@/lib/domain/types";
import { hash32 } from "@/lib/domain/hash";
import { providerRegistry } from "@/lib/providers/types";
import {
  currentRequest,
  demoActor,
  json,
  readAutonomy,
  requireWorkspace,
  route,
  workspaceRole,
  workspacesFor,
} from "@/lib/server/context";
import { isSupabaseConfigured } from "@/lib/supabase/env";

/**
 * A projection of a registry, computed on first use and kept.
 *
 * Both registries are filled by boot and read forever after, so rebuilding
 * their display projections per poll is work with a constant answer. The
 * registry's identity *and* its size are the cache key rather than a "booted"
 * flag: a test that installs its own registry, or registers one more entry
 * into this one, is seen on the next call instead of being served a stale list.
 */
function projection<K, V, T>(registry: () => Map<K, V>, build: (m: Map<K, V>) => T): () => T {
  let memo: { from: Map<K, V>; size: number; value: T } | undefined;
  return () => {
    const m = registry();
    if (memo && memo.from === m && memo.size === m.size) return memo.value;
    const value = build(m);
    memo = { from: m, size: m.size, value };
    return value;
  };
}

/** Display fields only; page layouts never need the execution graph itself. */
const catalog = projection(actionRegistry, (m) =>
  [...m.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ id, title, category, risk, requiredRole }) => ({
      id,
      title,
      category,
      risk,
      requiredRole,
    }))
);

/** availability drives every label in the UI — never presented as available */
const providers = projection(providerRegistry, (m) =>
  [...m.values()].map((p) => ({
    id: p.id,
    displayName: p.displayName,
    availability: p.availability,
    tagline: p.tagline,
    regions: p.regions,
  }))
);

/** Today's declared permissions per provider — metadata, not a live check. */
const declaredPermissions = projection(
  providerRegistry,
  (m) => new Map<ProviderId, string[]>([...m].map(([id, p]) => [id, p.accessExplanation().permissions]))
);

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

export const GET = route(async (req) => {
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

  const permissions = declaredPermissions();

  const body = {
    workspace,
    // Boot already registered these handlers; see `catalog` above.
    catalog: catalog(),
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
        label: c.provider === "sandbox" && c.label === "Zenith Sandbox" ? "Zenith Sandbox" : c.label,
        declaredPermissions: permissions.get(c.provider) ?? c.grantedPermissions,
      })),
    providers: providers(),
    settings,
    user,
    role,
    auth: { configured: isSupabaseConfigured() },
    members: d.members.filter((m) => m.workspaceId === workspace.id),
  };

  // The literal above fixes key order, so a plain stringify is a stable digest.
  const etag = `W/"${hash32(JSON.stringify(body))}"`;
  if (req.headers.get("if-none-match") === etag)
    return new Response(null, { status: 304, headers: { etag, "cache-control": "no-store" } });

  const res = json(body);
  res.headers.set("etag", etag);
  return res;
});
