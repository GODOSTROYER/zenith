import type { Binding, ChangeOp, Changeset, Manifest } from "@/lib/domain/types";

export interface RehearsalNode {
  id: string;
  name: string;
  kind: string;
  currentName?: string;
  proposedName?: string;
  current: boolean;
  proposed: boolean;
  change?: ChangeOp;
  affected: boolean;
  x: number;
  z: number;
}
export interface RehearsalBinding {
  id: string;
  current?: Binding;
  proposed?: Binding;
  change?: ChangeOp;
}
export interface RehearsalModel {
  nodes: RehearsalNode[];
  allNodes: RehearsalNode[];
  bindings: RehearsalBinding[];
  selectedNodes: string[];
  selectedId: string | null;
  omitted: number;
}

const entries = (manifest: Manifest | null) => manifest ? [
  ...manifest.services.map((node) => ({ id: node.id, name: node.name, kind: node.kind })),
  ...manifest.resources.map((node) => ({ id: node.id, name: node.name, kind: node.kind })),
  ...manifest.routes.map((node) => ({ id: node.id, name: `${node.host}${node.pathPrefix === "/" ? "" : node.pathPrefix}`, kind: "route" })),
] : [];

/** A bounded projection, never an editable or separately persisted graph. */
export function buildRehearsalModel(current: Manifest | null, proposed: Manifest, changeset: Changeset, selectedId: string | null, limit = 12): RehearsalModel {
  const before = new Map(entries(current).map((node) => [node.id, node]));
  const after = new Map(entries(proposed).map((node) => [node.id, node]));
  const changes = new Map(changeset.items.map((change) => [change.nodeId, change.op]));
  const beforeBindings = new Map((current?.bindings ?? []).map((binding) => [binding.id, binding]));
  const afterBindings = new Map(proposed.bindings.map((binding) => [binding.id, binding]));
  const bindings = [...new Set([...beforeBindings.keys(), ...afterBindings.keys()])].sort().map((id) => ({ id, current: beforeBindings.get(id), proposed: afterBindings.get(id), change: changes.get(id) }));
  const affected = new Set(changeset.items.filter((change) => change.nodeType !== "binding").map((change) => change.nodeId));
  for (const binding of bindings) if (binding.change) {
    for (const value of [binding.current, binding.proposed]) if (value) { affected.add(value.from); affected.add(value.to); }
  }
  const selectedBinding = bindings.find((binding) => binding.id === selectedId);
  const selectedNodes = selectedBinding
    ? [...new Set([selectedBinding.current, selectedBinding.proposed].flatMap((binding) => binding ? [binding.from, binding.to] : []))]
    : selectedId && (before.has(selectedId) || after.has(selectedId)) ? [selectedId] : [];
  const allNodes: RehearsalNode[] = [...new Set([...before.keys(), ...after.keys()])].sort().map((id) => ({
    ...after.get(id) ?? before.get(id)!,
    currentName: before.get(id)?.name, proposedName: after.get(id)?.name,
    current: before.has(id), proposed: after.has(id), change: changes.get(id), affected: affected.has(id), x: 0, z: 0,
  })).sort((a, b) => Number(b.affected) - Number(a.affected) || a.id.localeCompare(b.id));
  const nodes = allNodes.slice(0, Math.max(1, limit)).map((node) => ({ ...node }));
  // Selecting a resource outside the bounded model only replaces its last slots.
  // Every other node retains its presentation position across selection changes.
  const missing = selectedNodes.filter((id) => !nodes.some((node) => node.id === id));
  for (const id of missing) {
    const node = allNodes.find((value) => value.id === id);
    const replace = nodes.findLastIndex((value) => !selectedNodes.includes(value.id));
    if (node && replace >= 0) nodes[replace] = { ...node };
  }
  const columns = Math.min(4, Math.max(1, nodes.length));
  const rows = Math.ceil(nodes.length / columns);
  nodes.forEach((node, index) => { node.x = ((index % columns) - (columns - 1) / 2) * 1.65; node.z = (Math.floor(index / columns) - (rows - 1) / 2) * 1.5; });
  return { nodes, allNodes, bindings, selectedNodes, selectedId, omitted: Math.max(0, allNodes.length - nodes.length) };
}
