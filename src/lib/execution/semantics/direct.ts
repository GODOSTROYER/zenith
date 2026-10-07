/**
 * The semantics inputs of a provider-direct environment (PROD-MAN-01), the managed Zenith provider.
 *
 * OpenTofu environments bind their reviewed semantics to a rendered, pinned workspace. A provider-direct
 * environment has none: it renders objects and applies them server-side. Its stand-in is the same one teardown
 * uses (destroy.ts `directWorkspace`): the graph digest for the configuration, a fixed contract id for the
 * provider "locks", no backend. Everything else the digest binds (revision, approved sources, release
 * script, migration class, ownership transfers, adoption facts, runbook, the connection descriptor and the saved
 * plan digest) comes from the same trusted authorities as for any other provider.
 */
import { digest } from "@/lib/controlplane/digest";
import type { ProviderConnection } from "@/lib/credentials/types";
import type { ResourceGraph } from "@/lib/resources/types";
import type { CollectArgs } from "./collect";

export const MANAGED_APPLY_CONTRACT = "zenith-managed-apply/Z1";
export const KUBERNETES_APPLY_CONTRACT = "kubernetes-apply/K1";

export function directSemanticsArgs(graph: ResourceGraph, connection: Pick<ProviderConnection, "id" | "config">, planDigest: string, contract: string = MANAGED_APPLY_CONTRACT): CollectArgs & { planDigest: string } {
  return {
    graph,
    connection: { id: connection.id, config: connection.config },
    ws: { files: [], configDigest: graph.graphDigest, lockDigest: digest({ contract }), backend: "local" },
    planDigest,
  };
}
