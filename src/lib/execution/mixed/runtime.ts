/**
 * Composition of the mixed services over the real platform store, product store and
 * platform connections, for the REST routes. The worker composes the same pieces in
 * `workflows/mixed-activities.ts`.
 */
import { platformDb, repos } from "@/lib/controlplane/db";
import { createPlatformSemanticsStore } from "@/lib/controlplane/db/repos/executable-semantics";
import { createConnectionsPort } from "@/lib/execution/platform";
import { createProductPort } from "@/lib/execution/product-port";
import type { MixedDeps } from "./service";
import { createMixedWorld } from "./world";

export async function mixedDeps(): Promise<MixedDeps> {
  const sql = await platformDb();
  return {
    sql,
    world: createMixedWorld({ product: createProductPort(), connections: createConnectionsPort(sql), platformConnection: (workspaceId, id) => repos.connections.get(sql, workspaceId, id) }),
    semantics: createPlatformSemanticsStore(sql),
  };
}
