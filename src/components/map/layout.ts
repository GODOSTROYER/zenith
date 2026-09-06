import dagre from "@dagrejs/dagre";

export type Stratum = "route" | "service" | "resource";

/** Node footprints, shared by the layout engine and the node components. */
export const NODE_SIZE: Record<Stratum, { width: number; height: number }> = {
  route: { width: 280, height: 88 },
  service: { width: 280, height: 120 },
  resource: { width: 280, height: 120 },
};

/**
 * Fixed columns: edge (routes) → compute (services) → data (resources).
 * The map is a semantic diagram, not a canvas — a node's horizontal position
 * always means the same thing, so dagre only decides vertical order.
 */
const COLUMN_X: Record<Stratum, number> = { route: 0, service: 420, resource: 840 };

export interface LayoutInput {
  id: string;
  stratum: Stratum;
}

export function layoutGraph(
  nodes: LayoutInput[],
  edges: { source: string; target: string }[]
): Record<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 140, marginx: 32, marginy: 32 });
  g.setDefaultEdgeLabel(() => ({}));

  const known = new Set(nodes.map((n) => n.id));
  for (const n of nodes) g.setNode(n.id, { ...NODE_SIZE[n.stratum] });
  for (const e of edges) {
    if (known.has(e.source) && known.has(e.target)) g.setEdge(e.source, e.target);
  }
  dagre.layout(g);

  const out: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) {
    const laid = g.node(n.id) as { y?: number } | undefined;
    const { height } = NODE_SIZE[n.stratum];
    out[n.id] = {
      x: COLUMN_X[n.stratum],
      y: Math.round((laid?.y ?? 0) - height / 2),
    };
  }

  // Snapping every node to its stratum's column can collide nodes dagre had
  // put in different ranks — an unconnected resource, most often. Keep dagre's
  // vertical order and push the overlaps apart.
  const GAP = 40;
  for (const stratum of ["route", "service", "resource"] as Stratum[]) {
    const column = nodes
      .filter((n) => n.stratum === stratum)
      .sort((a, b) => out[a.id].y - out[b.id].y);
    let floor = -Infinity;
    for (const n of column) {
      out[n.id].y = Math.max(out[n.id].y, floor);
      floor = out[n.id].y + NODE_SIZE[stratum].height + GAP;
    }
  }
  return out;
}
