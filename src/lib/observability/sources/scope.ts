/**
 * Scope helpers shared by every source: which environment a source is bound
 * to, and which graph nodes a query's scope selects.
 *
 * Sources are constructed per environment (and per credential-broker session),
 * so `covers` first refuses any scope for another environment/workspace — the
 * same isolation the credential session already enforces, checked again where
 * queries are built.
 */
import type { PortableKind, ResourceGraph, ResourceNode } from "@/lib/resources/types";
import type { SignalScope } from "../types";

export interface EnvironmentBinding {
  environmentId: string;
  /** when known, scopes for another workspace are refused */
  workspaceId?: string;
}

export function bindingOf(graph: ResourceGraph, workspaceId?: string): EnvironmentBinding {
  return workspaceId === undefined ? { environmentId: graph.environmentId } : { environmentId: graph.environmentId, workspaceId };
}

export function sameEnvironment(binding: EnvironmentBinding, scope: SignalScope): boolean {
  return scope.environmentId === binding.environmentId && (binding.workspaceId === undefined || scope.workspaceId === binding.workspaceId);
}

export type NodeKind = PortableKind | "provider_native";

/**
 * Nodes a scope selects: the named addresses, or the whole environment when
 * none are named, filtered by `keep`. An address that names no node selects
 * nothing (it is not an error — the graph may have moved on).
 */
export function nodesInScope(graph: ResourceGraph, scope: SignalScope, keep: (node: ResourceNode) => boolean = () => true): ResourceNode[] {
  const wanted = scope.addresses?.length ? new Set(scope.addresses) : undefined;
  return graph.nodes.filter((n) => (!wanted || wanted.has(n.address)) && keep(n));
}

/** Does at least one node this source could serve fall inside the scope? */
export function coversScope(binding: EnvironmentBinding, graph: ResourceGraph, scope: SignalScope, keep: (node: ResourceNode) => boolean): boolean {
  return sameEnvironment(binding, scope) && nodesInScope(graph, scope, keep).length > 0;
}

export const hasKind = (...kinds: NodeKind[]) => (node: ResourceNode) => kinds.includes(node.kind);
