/**
 * Who may touch an environment's managed serving settings (PROD-MAN-03 routes).
 *
 * The same two broker ports every platform route trusts: the SCOPE resolver (does this environment chain inside the workspace,
 * and which provider does it use) and the ROLE resolver (the caller's CURRENT role, re-read on every call). A foreign
 * environment, a missing one and a workspace the caller is not in are the SAME not-found.
 */
import type { Principal } from "@/lib/controlplane/types";
import { BrokerError, notFound } from "@/lib/capabilities/errors";
import { ROLE_RANK, type BrokerDeps } from "@/lib/capabilities/ports";

const ID = /^[A-Za-z0-9_-]{1,200}$/;

export interface ManagedEnvironmentAccess {
  environmentId: string;
  provider: string;
  role: "viewer" | "editor" | "admin";
}

export async function requireManagedEnvironment(
  deps: Pick<BrokerDeps, "scopes" | "roles">,
  principal: Principal,
  input: { workspaceId: string; environmentId: string },
  need: "member" | "admin",
): Promise<ManagedEnvironmentAccess> {
  if (!ID.test(input.workspaceId) || !ID.test(input.environmentId)) throw notFound();
  const access = await deps.roles.resolve(principal, input.workspaceId);
  if (access.role === "none") throw notFound();
  if (access.allowedEnvironmentIds && !access.allowedEnvironmentIds.includes(input.environmentId)) throw notFound();
  const resolved = await deps.scopes.resolve({ workspaceId: input.workspaceId, environmentId: input.environmentId });
  if (!resolved?.environment) throw notFound();
  if (access.allowedProjectIds && (!resolved.scope.projectId || !access.allowedProjectIds.includes(resolved.scope.projectId))) throw notFound();
  if (principal.kind === "integration" && !access.integrationScopes?.includes("read")) {
    throw new BrokerError("role_insufficient", "This credential cannot read custom domains.", "Use a credential with the read scope.");
  }
  if (need === "admin" && ROLE_RANK[access.role] < ROLE_RANK.admin) throw new BrokerError("role_insufficient", "Only a workspace admin can change custom domains.", "Ask a workspace admin.");
  return { environmentId: resolved.environment.id, provider: resolved.environment.provider, role: access.role };
}

/** Custom domains are a managed-platform feature: any other provider's environment is refused by name. */
export function assertManagedProvider(access: ManagedEnvironmentAccess): void {
  if (access.provider !== "zenith") {
    throw new BrokerError("invalid_state", `Custom domains are served by the Zenith-managed platform; this environment uses provider "${access.provider.slice(0, 40)}".`, "Use your own DNS and load balancer for this provider.");
  }
}
