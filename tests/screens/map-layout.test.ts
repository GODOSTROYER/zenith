/**
 * The map's layout contract (ARCHITECTURE ADR 5): a node's column always means
 * the same thing, so dagre only decides vertical order. The interesting case is
 * a binding between two nodes in the SAME column — the edge then runs right to
 * left, which is why edges.tsx routes those as a step path instead of a bezier.
 */
import { describe, expect, it } from "vitest";
import { NODE_SIZE, layoutGraph } from "@/components/map/layout";

describe("layoutGraph", () => {
  it("puts every node in its stratum's column", () => {
    const out = layoutGraph(
      [
        { id: "r1", stratum: "route" },
        { id: "s1", stratum: "service" },
        { id: "d1", stratum: "resource" },
      ],
      [
        { source: "r1", target: "s1" },
        { source: "s1", target: "d1" },
      ]
    );
    expect(out.r1.x).toBeLessThan(out.s1.x);
    expect(out.s1.x).toBeLessThan(out.d1.x);
  });

  it("keeps two bound services in one column, so the edge runs backwards", () => {
    const out = layoutGraph(
      [
        { id: "a", stratum: "service" },
        { id: "b", stratum: "service" },
      ],
      [{ source: "a", target: "b" }]
    );
    expect(out.a.x).toBe(out.b.x);
    // The source's right handle sits a whole node width past the target's left
    // handle: any bezier drawn between them doubles back over both nodes.
    const sourceHandleX = out.a.x + NODE_SIZE.service.width;
    expect(sourceHandleX).toBeGreaterThan(out.b.x);
  });

  it("never overlaps two nodes in the same column", () => {
    const nodes = Array.from({ length: 6 }, (_, i) => ({
      id: `d${i}`,
      stratum: "resource" as const,
    }));
    const out = layoutGraph(nodes, []);
    const ys = nodes.map((n) => out[n.id].y).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(NODE_SIZE.resource.height);
    }
  });

  it("ignores edges pointing at nodes that are not drawn", () => {
    const out = layoutGraph([{ id: "s1", stratum: "service" }], [
      { source: "s1", target: "ghost" },
    ]);
    expect(Object.keys(out)).toEqual(["s1"]);
  });
});
