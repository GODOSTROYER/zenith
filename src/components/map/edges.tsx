"use client";
import { useState } from "react";
import {
  EdgeLabelRenderer,
  getBezierPath,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { Chip } from "@/components/ui/chip";
import { cx } from "@/lib/format";

export interface BindingEdgeData extends Record<string, unknown> {
  capability: string;
  note?: string;
  /** a deployment is releasing this edge's target right now */
  live?: boolean;
  diff?: "create" | "delete";
  /** a filter is running and neither end of this edge matches */
  dimmed?: boolean;
}

export type BindingEdge = Edge<BindingEdgeData, "binding">;

/** Same words the node chips use, so create/delete never reads as colour alone. */
const DIFF_CHIP = {
  create: { tone: "signal" as const, text: "new" },
  delete: { tone: "err" as const, text: "removing" },
};

/**
 * A binding, drawn. The full explanation lives in the Inspector, which is now
 * reachable: clicking the edge opens it.
 */
export function BindingEdgeView({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<BindingEdge>) {
  const [hover, setHover] = useState(false);

  // Columns are fixed by stratum, so a binding between two nodes in the same
  // column has its target to the LEFT of its source. A bezier drawn that way
  // loops back across both nodes and reads as an arrow pointing the wrong way;
  // a step path goes out, along, and back in — which is what it does.
  const backwards = targetX <= sourceX + 24;
  const geom = {
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  };
  const [path, labelX, labelY] = backwards
    ? getSmoothStepPath({ ...geom, borderRadius: 12, offset: 30 })
    : getBezierPath(geom);

  const stroke =
    data?.diff === "delete"
      ? "var(--err)"
      : data?.diff === "create"
        ? "var(--signal)"
        : hover || selected
          ? "var(--ink-faint)"
          : "var(--line-strong)";

  const chip = data?.diff ? DIFF_CHIP[data.diff] : undefined;
  // Dense graphs can put unrelated edge midpoints at precisely the same
  // coordinate. Reveal one inspected binding, leaving all topology visible.
  const showCapability = Boolean(data?.capability) && (hover || selected);

  return (
    <>
      <path
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth={hover || selected ? 2 : 1.25}
        strokeDasharray={data?.diff ? "5 5" : undefined}
        strokeOpacity={data?.dimmed ? 0.2 : data?.diff === "delete" ? 0.5 : 1}
        className={cx(data?.live && "edge-live")}
        style={{ transition: "stroke var(--dur-fast) var(--ease-swift)" }}
      />
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={18}
        style={{ cursor: "pointer" }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      />
      {showCapability && (
        <EdgeLabelRenderer>
          <div
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              opacity: data?.dimmed ? 0.3 : undefined,
            }}
            className="pointer-events-none absolute z-10 flex items-center gap-1"
          >
            {/* Pending state stays explicit when inspecting a binding. */}
            {chip && <Chip tone={chip.tone}>{chip.text}</Chip>}
            {showCapability && (
              <span className="rounded-ctl border border-line bg-bg3 px-2 py-1 font-mono text-[12px] text-ink shadow-card">
                {data?.capability}
              </span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const edgeTypes = { binding: BindingEdgeView };
