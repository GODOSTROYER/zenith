import { guardFor } from "@/lib/controlplane/db/repos/ownership-transfers";
import type { Sql } from "@/lib/controlplane/types";
import { evaluateWrite } from "@/lib/ownership/conflicts";
import type { FieldOwnershipCheck } from "@/lib/placement/optimizer";

/** service.scale is a native writer: a manifest-owned field needs a separately approved transfer. */
export function createOptimizerOwnership(db: Sql, scope: { workspaceId: string; environmentId: string }, now: () => Date): FieldOwnershipCheck {
  return { async check(ref) {
    if (ref.field !== "spec.replicas" && ref.field !== "spec.size") return { owner: "unknown", detail: "only typed service.scale fields are supported" };
    const rows = await db.query<{ id: string }>("select id from platform.resources where workspace_id = $1 and environment_id = $2 and address = $3 and kind = 'container_service' and ownership = 'managed' and status <> 'deleted' limit 2", [scope.workspaceId, scope.environmentId, ref.address]);
    if (rows.length !== 1) return { owner: "unknown", detail: "a unique current managed resource could not be established" };
    const counts = await db.query<{ count: number }>("select count(*)::int as count from platform.resources where workspace_id = $1 and environment_id = $2", [scope.workspaceId, scope.environmentId]);
    if (counts.length !== 1 || !Number.isInteger(counts[0]!.count) || counts[0]!.count > 2000) return { owner: "unknown", detail: "the ownership fact reader cannot establish a complete environment above its 2000-resource bound" };
    const guard = await guardFor(db, scope.workspaceId, scope.environmentId, rows[0]!.id);
    if (!guard || guard.node.address !== ref.address) return { owner: "unknown", detail: "current ownership facts could not be loaded" };
    const verdict = evaluateWrite({ address: ref.address, resourceType: guard.node.nativeType, path: ref.field.slice(5), writer: "native-op", via: "service.scale", facts: guard.facts }, { transfers: guard.transfers, now: now() });
    return verdict.verdict === "allowed" ? { owner: "zenith" } : { owner: "external", detail: verdict.message };
  } };
}
