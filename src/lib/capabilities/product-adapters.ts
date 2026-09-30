/**
 * Adapters from the PRODUCT store (workspaces, projects, environments, members,
 * connections, manifests, integration credentials) to the broker's
 * `ScopeResolver` and `RoleResolver` ports.
 *
 * The product store answers two questions the platform control store cannot:
 * "does this id chain workspace → project → environment → resource?" and "what
 * is this person's role in this workspace?". Both answers are re-read from the
 * store on every call — nothing is cached across decisions.
 *
 * Tenancy: every lookup filters by workspace. Ids are matched exactly (never by
 * slug), so an id cannot alias another tenant's object. A foreign id and a
 * missing id both resolve to `null`; the broker turns that into the one
 * `not_found` answer.
 *
 * Roles mirror `roleOf` in `actions/core.ts` with one deliberate difference:
 * a non-member is `"none"`, not `"viewer"`. The demo actor `local` is admin only
 * when Supabase is NOT configured (single-user demo mode); with real auth
 * configured, an unauthenticated caller can never be `local`.
 */
import { membershipPolicy } from "@/lib/auth/policy";
import { db, q, revisionManifestAsync } from "@/lib/db/store";
import type { Manifest, Service, Resource } from "@/lib/domain/types";
import type { Principal, Scope } from "@/lib/controlplane/types";
import { STATEFUL_KINDS } from "@/lib/resources/types";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { BrokerError } from "./errors";
import type { ResolvedAccess, ResolvedScope, RoleResolver, ScopeResolver, WorkspaceRoleOrNone } from "./ports";

/* --------------------------------- scopes ---------------------------------- */

const STATEFUL: ReadonlySet<string> = new Set(STATEFUL_KINDS);

function isPubliclyExposed(manifest: Manifest, nodeId: string): boolean {
  return manifest.bindings.some((b) => b.to === nodeId && manifest.routes.some((r) => r.id === b.from));
}

function resourceFacts(manifest: Manifest, id: string): ResolvedScope["resource"] | undefined {
  const service: Service | undefined = manifest.services.find((s) => s.id === id);
  if (service) {
    return { address: `service/${service.name}`, kind: "container_service", stateful: false, ownership: service.ownership, publiclyExposed: isPubliclyExposed(manifest, service.id) };
  }
  const resource: Resource | undefined = manifest.resources.find((r) => r.id === id);
  if (resource) {
    return { address: `resource/${resource.name}`, kind: resource.kind, stateful: STATEFUL.has(resource.kind), ownership: resource.ownership, publiclyExposed: false };
  }
  return undefined;
}

export function productScopeResolver(): ScopeResolver {
  return {
    async resolve(scope: Scope): Promise<ResolvedScope | null> {
      const d = db();
      if (!d.workspaces.some((w) => w.id === scope.workspaceId)) return null;

      const project = scope.projectId ? d.projects.find((p) => p.id === scope.projectId && p.workspaceId === scope.workspaceId) : undefined;
      if (scope.projectId && !project) return null;

      const env = scope.environmentId ? d.environments.find((e) => e.id === scope.environmentId) : undefined;
      if (scope.environmentId) {
        if (!env) return null;
        const owner = d.projects.find((p) => p.id === env.projectId && p.workspaceId === scope.workspaceId);
        if (!owner) return null;
        if (project && owner.id !== project.id) return null;
      }
      const projectId = project?.id ?? env?.projectId;
      const resolved: ResolvedScope = { scope: { workspaceId: scope.workspaceId, ...(projectId ? { projectId } : {}), ...(env ? { environmentId: env.id } : {}) } };

      if (env) {
        const connection = q.connection(env.connectionId);
        resolved.environment = { id: env.id, class: env.class, provider: connection?.provider ?? "unknown", region: env.region };
      }

      if (scope.resourceId) {
        if (!env || !projectId) return null;
        const owner = d.projects.find((p) => p.id === projectId);
        // The deployed revision is what exists in the environment; the working copy is what the project is editing.
        const manifest = (env.deployedRevisionId ? await revisionManifestAsync(env.deployedRevisionId) : undefined) ?? owner?.workingManifest;
        const facts = manifest ? resourceFacts(manifest, scope.resourceId) : undefined;
        if (!facts) return null;
        resolved.scope.resourceId = scope.resourceId;
        resolved.resource = facts;
      }
      return resolved;
    },
  };
}

/* ---------------------------------- roles ---------------------------------- */

/** What the credential authority knows about an integration's grant. */
export interface IntegrationGrant {
  scopes: string[];
  projectIds: string[];
  environmentIds?: string[];
}

/** Resolves an integration principal's CURRENT grant, or `null` when it is revoked, expired or unknown. */
export type IntegrationDirectory = (principal: Principal, workspaceId: string) => Promise<IntegrationGrant | null>;

/**
 * The default directory: Zenith's own `za_` credentials, asked live on every
 * call so revocation takes effect on the next request. OAuth journal grants are
 * not covered; the orchestrator can supply a directory that also asks the
 * journal.
 */
export const credentialDirectory: IntegrationDirectory = async (principal, workspaceId) => {
  if (!principal.onBehalfOf || !principal.integrationId) return null;
  try {
    const { credentialAuthority } = await import("@/lib/agent-access/authority");
    const rows = await credentialAuthority().listCredentials(principal.onBehalfOf, workspaceId);
    const now = Date.now();
    const found = rows.find((c) => c.id === principal.integrationId && !c.revokedAt && Date.parse(c.expiresAt) > now && c.workspaceId === workspaceId);
    return found ? { scopes: [...found.scopes], projectIds: [...found.projectIds], ...(found.environmentIds ? { environmentIds: [...found.environmentIds] } : {}) } : null;
  } catch {
    throw new BrokerError("platform_store_unavailable", "Integration credentials could not be checked, so the request was refused.");
  }
};

function humanRole(humanId: string | undefined, workspaceId: string): WorkspaceRoleOrNone {
  if (!humanId) return "none";
  const d = db();
  if (!d.workspaces.some((w) => w.id === workspaceId)) return "none";
  const members = d.members.filter((m) => m.workspaceId === workspaceId);
  const member = members.find((m) => m.id === humanId);
  if (member) return member.role;
  // Demo mode only: one local user, admin, in every workspace. With auth
  // configured `local` is an unauthenticated caller and gets nothing.
  if (humanId === "local" && !isSupabaseConfigured()) return "admin";
  if (members.length === 0 && membershipPolicy().emptyWorkspaceGrantsAdmin) return "admin";
  return "none";
}

export function productRoleResolver(options: { integrations?: IntegrationDirectory } = {}): RoleResolver {
  const directory = options.integrations ?? credentialDirectory;
  return {
    async resolve(principal: Principal, workspaceId: string): Promise<ResolvedAccess> {
      switch (principal.kind) {
        case "user":
          return { role: humanRole(principal.id, workspaceId) };
        case "navigator": {
          // The Navigator has no identity of its own: it is bounded by the human it works for,
          // or, acting for nobody in particular, by the editor role (it is never an approver).
          const exists = db().workspaces.some((w) => w.id === workspaceId);
          if (principal.onBehalfOf) return { role: humanRole(principal.onBehalfOf, workspaceId) };
          return { role: exists ? "editor" : "none" };
        }
        case "integration": {
          const grant = await directory(principal, workspaceId);
          if (!grant) return { role: "none" };
          // An integration can never exceed the human who granted it.
          const role = humanRole(principal.onBehalfOf, workspaceId);
          if (role === "none") return { role: "none" };
          return {
            role,
            integrationScopes: grant.scopes,
            allowedProjectIds: grant.projectIds,
            ...(grant.environmentIds ? { allowedEnvironmentIds: grant.environmentIds } : {}),
          };
        }
        default:
          // system, runner and machine principals are not workspace members.
          return { role: "none" };
      }
    },
  };
}
