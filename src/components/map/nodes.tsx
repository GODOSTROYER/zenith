"use client";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  Archive,
  CalendarClock,
  Cog,
  Database,
  FileCode2,
  Globe,
  ListOrdered,
  Lock,
  Mail,
  Server,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Chip, StatusDot, type DotStatus } from "@/components/ui";
import { cx, fmtUsd } from "@/lib/format";
import type { Ownership } from "@/lib/domain/types";
import { NODE_SIZE, type Stratum } from "./layout";

export interface MapNodeData extends Record<string, unknown> {
  name: string;
  stratum: Stratum;
  /** service kind, resource kind, or "route" */
  kind: string;
  /** the one line of detail under the name */
  sub?: string;
  costUsd: number;
  /** undefined when there is no health source (nothing deployed here yet) */
  health?: DotStatus;
  healthLabel?: string;
  /** how this node differs from what the selected environment runs */
  diff?: "create" | "update" | "delete";
  ownership?: Ownership;
  /** a deployment is touching this node right now */
  live?: boolean;
  tls?: boolean;
  bindState?: "source" | "candidate";
  selected?: boolean;
  onActivate?: () => void;
}

export type MapNode = Node<MapNodeData, "route" | "service" | "resource">;

const SERVICE_ICON: Record<string, LucideIcon> = {
  web: Server,
  worker: Cog,
  cron: CalendarClock,
  static: FileCode2,
};

const RESOURCE_ICON: Record<string, LucideIcon> = {
  postgres: Database,
  redis: Zap,
  object_store: Archive,
  queue: ListOrdered,
  email: Mail,
};

const KIND_LABEL: Record<string, string> = {
  web: "web service",
  worker: "worker",
  cron: "scheduled job",
  static: "static site",
  postgres: "postgres",
  redis: "redis",
  object_store: "object store",
  queue: "queue",
  email: "email",
};

function iconFor(data: MapNodeData): LucideIcon {
  if (data.stratum === "route") return Globe;
  if (data.stratum === "service") return SERVICE_ICON[data.kind] ?? Server;
  return RESOURCE_ICON[data.kind] ?? Database;
}

/** Edge anchors: visible enough to read the direction, never a drag target. */
const HANDLE: React.CSSProperties = {
  width: 6,
  height: 6,
  border: "none",
  background: "var(--line-strong)",
  minWidth: 0,
  minHeight: 0,
};

const DIFF_TITLE: Record<NonNullable<MapNodeData["diff"]>, string> = {
  create: "Not deployed yet — the next deploy to this environment creates it.",
  update: "Changed since the last deploy to this environment.",
  delete: "Still running — the next deploy to this environment removes it.",
};

/** Shared chrome: diff treatment, ownership, focus, bind-mode affordances. */
function NodeShell({
  data,
  children,
  className,
}: {
  data: MapNodeData;
  children: React.ReactNode;
  className?: string;
}) {
  const selected = Boolean(data.selected);
  const size = NODE_SIZE[data.stratum];
  const ghost = data.diff === "delete";
  const referenced = data.ownership && data.ownership !== "managed";

  return (
    <div className="relative" style={{ width: size.width, height: size.height }}>
      {data.live && (
        <span
          aria-hidden="true"
          className="status-pulse pointer-events-none absolute -inset-1 rounded-[15px] ring-2 ring-signal/55"
        />
      )}
      <Handle type="target" position={Position.Left} isConnectable={false} style={HANDLE} />
      <div
        role="button"
        tabIndex={0}
        title={data.diff ? DIFF_TITLE[data.diff] : undefined}
        onClick={() => data.onActivate?.()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            data.onActivate?.();
          }
        }}
        className={cx(
          "relative flex h-full w-full flex-col justify-center overflow-hidden bg-bg2 px-3 text-left",
          "transition-[border-color,box-shadow,opacity] duration-[200ms] [transition-timing-function:var(--ease-swift)]",
          data.stratum === "route" ? "rounded-full" : "rounded-card",
          "border shadow-card",
          ghost
            ? "border-dashed border-err opacity-45"
            : data.diff === "create"
              ? "border-dashed border-signal"
              : referenced
                ? "border-dashed border-line-strong"
                : "border-line",
          selected && "border-signal ring-1 ring-signal",
          data.bindState === "source" && "ring-2 ring-signal",
          data.bindState === "candidate" && "cursor-crosshair hover:border-signal",
          !data.bindState && "hover:border-line-strong",
          className
        )}
      >
        {children}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} style={HANDLE} />
    </div>
  );
}

function DiffMark({ diff }: { diff?: MapNodeData["diff"] }) {
  if (diff === "create") return <Chip tone="signal">new</Chip>;
  if (diff === "delete") return <Chip tone="err">removing</Chip>;
  if (diff === "update")
    return (
      <span
        title="Changed since the last deploy to this environment."
        aria-label="changed"
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-signal"
      />
    );
  return null;
}

function Cost({ usd }: { usd: number }) {
  return (
    <span className="tnum shrink-0 font-mono text-[11.5px] text-ink-faint" title="Estimated monthly cost at list prices.">
      {fmtUsd(usd)}
      <span className="opacity-70">/mo</span>
    </span>
  );
}

export function RouteNode({ data }: NodeProps<MapNode>) {
  return (
    <NodeShell data={data}>
      <div className="flex items-center gap-2">
        <Globe className="h-3.5 w-3.5 shrink-0 text-ink-mute" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink" title={data.name}>
          {data.name}
        </span>
        {data.tls && (
          <Lock className="h-3 w-3 shrink-0 text-ok" aria-label="TLS" />
        )}
        <DiffMark diff={data.diff} />
      </div>
    </NodeShell>
  );
}

export function ServiceNode({ data }: NodeProps<MapNode>) {
  const Icon = iconFor(data);
  return (
    <NodeShell data={data}>
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-ink-mute" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">
          {data.name}
        </span>
        <DiffMark diff={data.diff} />
        {data.health && <StatusDot status={data.health} label={data.healthLabel} />}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-mute">
          {KIND_LABEL[data.kind] ?? data.kind}
          {data.sub ? ` · ${data.sub}` : ""}
        </span>
        <Cost usd={data.costUsd} />
      </div>
      {data.ownership && data.ownership !== "managed" && (
        <span className="mt-1 text-[10.5px] tracking-[0.04em] text-ink-faint uppercase">
          {data.ownership}
        </span>
      )}
    </NodeShell>
  );
}

export function ResourceNode({ data }: NodeProps<MapNode>) {
  const Icon = iconFor(data);
  return (
    <NodeShell data={data}>
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-ink-mute" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
          {data.name}
        </span>
        <DiffMark diff={data.diff} />
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-mute">
          {KIND_LABEL[data.kind] ?? data.kind}
          {data.sub ? ` · ${data.sub}` : ""}
        </span>
        <Cost usd={data.costUsd} />
      </div>
      {data.ownership && data.ownership !== "managed" && (
        <span className="mt-0.5 text-[10.5px] tracking-[0.04em] text-ink-faint uppercase">
          {data.ownership}
        </span>
      )}
    </NodeShell>
  );
}

export const nodeTypes = {
  route: RouteNode,
  service: ServiceNode,
  resource: ResourceNode,
};
