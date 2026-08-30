"use client";
import { useState } from "react";
import {
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { cx } from "@/lib/format";

export interface BindingEdgeData extends Record<string, unknown> {
  capability: string;
  note?: string;
  /** a deployment is releasing this edge's target right now */
  live?: boolean;
  diff?: "create" | "delete";
}

export type BindingEdge = Edge<BindingEdgeData, "binding">;

/**
 * A binding, drawn. The capability rides on hover so the map stays quiet at
 * rest; the full explanation lives in the Inspector, where there is room for it.
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
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const stroke =
    data?.diff === "delete"
      ? "var(--err)"
      : data?.diff === "create"
        ? "var(--signal)"
        : hover || selected
          ? "var(--ink-faint)"
          : "var(--line-strong)";

  return (
    <>
      <path
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth={hover || selected ? 2 : 1.25}
        strokeDasharray={data?.diff ? "5 5" : undefined}
        strokeOpacity={data?.diff === "delete" ? 0.5 : 1}
        className={cx(data?.live && "edge-live")}
        style={{ transition: "stroke 200ms var(--ease-swift)" }}
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
      {hover && data?.capability && (
        <EdgeLabelRenderer>
          <div
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            className="pointer-events-none absolute z-10 rounded-full border border-line bg-bg3 px-2 py-0.5 font-mono text-[11px] text-ink-mute shadow-card"
          >
            {data.capability}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const edgeTypes = { binding: BindingEdgeView };
