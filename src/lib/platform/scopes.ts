/** Product scope chain plus platform resource ids created by graph expansion. */
import { productScopeResolver } from "@/lib/capabilities/product-adapters";
import type { ScopeResolver } from "@/lib/capabilities/ports";
import { repos } from "@/lib/controlplane/db";
import type { Sql } from "@/lib/controlplane/types";
import { STATEFUL_KINDS } from "@/lib/resources/types";

export function platformScopeResolver(db: Sql): ScopeResolver {
  const product = productScopeResolver();
  return { async resolve(scope) {
    const original = await product.resolve(scope);
    if (original || !scope.resourceId || !scope.environmentId) return original;
    const base = await product.resolve({ ...scope, resourceId: undefined });
    if (!base) return null;
    const resource = await repos.resources.get(db, scope.workspaceId, scope.resourceId);
    if (!resource || resource.environmentId !== scope.environmentId || (resource.projectId && resource.projectId !== base.scope.projectId) || resource.status === "deleted") return null;
    return { ...base, scope: { ...base.scope, resourceId: resource.id }, resource: { address: resource.address, kind: resource.kind, stateful: (STATEFUL_KINDS as readonly string[]).includes(resource.kind), ownership: resource.ownership, publiclyExposed: resource.kind === "load_balancer" || resource.kind === "dns_record" } };
  } };
}
