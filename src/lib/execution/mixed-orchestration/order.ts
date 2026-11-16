/**
 * Dependency order with explicit cycle refusal. Edges are consumer -> producer.
 * Pure and deterministic (lexical tie-break). A cycle is never "broken" or ignored:
 * the error names the children that participate so a person can fix the plan.
 */
import { cmp, refuse, sortedUnique } from "./errors";
import type { ChildPlanView } from "./child-view";

type Node = Pick<ChildPlanView, "id" | "dependsOn">;

export interface ChildOrder {
  /** Producers first: the only order in which children may start. */
  readonly execution: readonly string[];
  /** Consumers first: the only order in which children may be torn down. */
  readonly teardown: readonly string[];
}

/** Members of one cycle, or an empty list when the graph is acyclic. Unknown dependencies are ignored here. */
export function findCycle(children: readonly Node[]): string[] {
  const deps = new Map(children.map((child) => [child.id, [...child.dependsOn].sort(cmp)]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    stack.push(id);
    for (const next of deps.get(id) ?? []) {
      if (!deps.has(next)) continue;
      if (state.get(next) === 1) return stack.slice(stack.indexOf(next));
      if (!state.has(next)) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, 2);
    return undefined;
  };
  for (const id of [...deps.keys()].sort(cmp)) {
    if (!state.has(id)) {
      const found = visit(id);
      if (found) return sortedUnique(found);
    }
  }
  return [];
}

export function orderChildren(children: readonly Node[]): ChildOrder {
  const ids = new Set(children.map((child) => child.id));
  if (ids.size !== children.length) refuse("invalid_input");
  for (const child of children) for (const dependency of child.dependsOn) if (!ids.has(dependency)) refuse("unknown_child", dependency);
  const cycle = findCycle(children);
  if (cycle.length) refuse("dependency_cycle", ...cycle);
  const remaining = new Map(children.map((child) => [child.id, new Set(child.dependsOn)]));
  const execution: string[] = [];
  while (remaining.size) {
    const ready = [...remaining].filter(([, deps]) => deps.size === 0).map(([id]) => id).sort(cmp);
    if (!ready.length) return refuse("dependency_cycle", ...remaining.keys());
    for (const id of ready) {
      execution.push(id);
      remaining.delete(id);
    }
    for (const deps of remaining.values()) for (const id of ready) deps.delete(id);
  }
  return Object.freeze({ execution: Object.freeze(execution), teardown: Object.freeze([...execution].reverse()) });
}

/** Transitive dependencies of `id` (producers it needs, directly or not). */
export function upstreamOf(children: readonly Node[], id: string): Set<string> {
  const byId = new Map(children.map((child) => [child.id, child]));
  const seen = new Set<string>();
  const walk = (current: string): void => {
    for (const dependency of byId.get(current)?.dependsOn ?? []) {
      if (!seen.has(dependency)) {
        seen.add(dependency);
        walk(dependency);
      }
    }
  };
  walk(id);
  return seen;
}

/** Transitive dependents of `id` (children that need it, directly or not). */
export function downstreamOf(children: readonly Node[], id: string): Set<string> {
  return new Set(children.filter((child) => child.id !== id && upstreamOf(children, child.id).has(id)).map((child) => child.id));
}
