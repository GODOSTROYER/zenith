/** Current human membership for the final launch check; no snapshot or auth fallback. */
import { membershipPolicy } from "@/lib/auth/policy";
import { db, isPostgres } from "@/lib/db/store";
import { pgClient } from "@/lib/db/postgres-store";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { productRoleResolver } from "./product-adapters";
import { currentIntegrationGrant } from "./current-integration-grants";
import { type ResolvedAccess, type RoleResolver, type WorkspaceRoleOrNone } from "./ports";

const DEADLINE_MS = 8_000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
export class CurrentProductRoleError extends Error {
  readonly code = "current_product_role_unconfirmed";
  constructor() { super("Current workspace membership could not be confirmed."); }
}
function refuse(): never { throw new CurrentProductRoleError(); }
function roleOf(value: unknown): WorkspaceRoleOrNone {
  if (value !== "viewer" && value !== "editor" && value !== "admin") refuse();
  return value;
}
function bounded<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new CurrentProductRoleError()); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    void Promise.resolve().then(read).then(value => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(new CurrentProductRoleError()); else resolve(value);
    }, () => { signal.removeEventListener("abort", abort); reject(new CurrentProductRoleError()); });
  });
}

async function humanRole(humanId: string, workspaceId: string, signal: AbortSignal): Promise<WorkspaceRoleOrNone> {
  if (!ID.test(humanId) || !ID.test(workspaceId) || signal.aborted) refuse();
  if (isPostgres()) {
    // The filter and returned IDs both bind the result to the exact tenant.
    const { data, error } = await pgClient().from("members").select("id,workspace_id,role")
      .eq("workspace_id", workspaceId).eq("id", humanId).abortSignal(signal).maybeSingle();
    if (signal.aborted || error) refuse();
    if (data === null) return "none";
    if (!data || data.id !== humanId || data.workspace_id !== workspaceId) refuse();
    return roleOf(data.role);
  }
  // In file mode this object is the current single-writer authority, read now.
  const current = db();
  if (!current.workspaces.some(workspace => workspace.id === workspaceId)) return "none";
  const members = current.members.filter(member => member.workspaceId === workspaceId);
  const matches = members.filter(member => member.id === humanId);
  if (matches.length > 1) refuse();
  if (matches[0]) return roleOf(matches[0].role);
  if (humanId === "local" && !isSupabaseConfigured()) return "admin";
  if (members.length === 0 && membershipPolicy().emptyWorkspaceGrantsAdmin) return "admin";
  return "none";
}

/** The optional signal cancels reads; it supplies no identity or authorization. */
export function currentProductRoleResolver(options: { signal?: AbortSignal } = {}): RoleResolver {
  const canonical = productRoleResolver();
  return {
    async resolve(principal, workspaceId): Promise<ResolvedAccess> {
      const signal = options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(DEADLINE_MS)])
        : AbortSignal.timeout(DEADLINE_MS);
      return bounded(signal, async () => {
        if (signal.aborted) refuse();
        const humanId = principal.kind === "user" ? principal.id : principal.onBehalfOf;
        if (!humanId) return canonical.resolve(principal, workspaceId);
        if (principal.kind === "user" || principal.kind === "navigator") {
          return { role: await humanRole(humanId, workspaceId, signal) };
        }
        // Integration credentials and project/environment grants still attenuate
        // the human. A current membership never restores a refused credential.
        if (principal.kind !== "integration") return canonical.resolve(principal, workspaceId);
        const role = await humanRole(humanId, workspaceId, signal);
        const grant = await currentIntegrationGrant(principal, workspaceId, signal);
        if (!grant) return { role: "none" };
        return { role, integrationScopes: grant.scopes,
          allowedProjectIds: grant.projectIds, ...(grant.environmentIds ? { allowedEnvironmentIds: grant.environmentIds } : {}) };
      });
    },
  };
}
