"use client";

import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Clock, Cog, Database, FileText, Globe, HardDrive, Inbox, Mail, Server, Zap } from "lucide-react";
import type { Manifest } from "@/lib/domain/types";
import type { Highlight } from "./landing-state";
import { useSystemFlow, type FlowStep } from "./landing-motion";
import { CAPABILITY_PHRASE, EXAMPLE_NODE_IDS, KIND_LABEL, NODE_META, type ExampleNodeId } from "./scenario";
import styles from "./system-diagram.module.css";

const GLYPH: Record<string, typeof Server> = {
  route: Globe, web: Server, worker: Cog, cron: Clock, static: FileText,
  postgres: Database, redis: Zap, object_store: HardDrive, queue: Inbox, email: Mail,
};

export interface SystemDiagramProps {
  manifest: Manifest;
  /** the accessible name of the whole diagram */
  label: string;
  /** ids that are proposed in this view: vermilion, tagged, dashed connections */
  proposedIds?: ExampleNodeId[];
  proposedBindingIds?: string[];
  selected?: ExampleNodeId | null;
  onSelect?: (id: ExampleNodeId) => void;
  /** when set, nodes are links there and `onSelect` runs first */
  href?: string;
  /** walkthrough emphasis; everything else softens */
  highlight?: Highlight | null;
  health?: Partial<Record<ExampleNodeId, "ok" | "watch">>;
  /** show size and replica counts under each name */
  showSizing?: boolean;
  /** run the assembling entrance once */
  reveal?: boolean;
  /** the story a light travels, as binding ids in order; loops while on screen */
  flow?: FlowStep[];
  className?: string;
}

const NO_FLOW: FlowStep[] = [];

interface Rect { left: number; top: number; right: number; bottom: number; cx: number; cy: number; width: number; height: number }
interface Edge { id: string; d: string; labelAt: [number, number] | null; from: ExampleNodeId; to: ExampleNodeId; capability: string }

function kindOf(manifest: Manifest, id: string): string {
  return manifest.services.find((s) => s.id === id)?.kind ?? manifest.resources.find((r) => r.id === id)?.kind ?? "route";
}

/** Orthogonal path with rounded corners through the points given. */
function orthogonal(points: [number, number][], radius = 8): string {
  if (points.length < 2) return "";
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1], [x, y] = points[i], [nx, ny] = points[i + 1];
    const inLen = Math.hypot(x - px, y - py), outLen = Math.hypot(nx - x, ny - y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const ax = x - Math.sign(x - px) * r, ay = y - Math.sign(y - py) * r;
    const bx = x + Math.sign(nx - x) * r, by = y + Math.sign(ny - y) * r;
    d += ` L ${ax} ${ay} Q ${x} ${y} ${bx} ${by}`;
  }
  const [lx, ly] = points[points.length - 1];
  return `${d} L ${lx} ${ly}`;
}

/**
 * Route every binding between measured node boxes. Grid mode keeps lines in
 * the gaps between rows with one lane per crossing edge; stack mode runs
 * long edges down a rail beside the column so nothing crosses a node.
 */
function routeEdges(manifest: Manifest, rects: Map<string, Rect>, mode: "grid" | "stack", width: number): Edge[] {
  const edges: Edge[] = [];
  const bindings = manifest.bindings.filter((b) => rects.has(b.from) && rects.has(b.to));
  const ports = { out: new Map<string, string[]>(), in: new Map<string, string[]>() };
  const stackOrder = (id: string) => NODE_META[id as ExampleNodeId]?.stack ?? 0;
  const sameRow = (a: Rect, b: Rect) => Math.abs(a.cy - b.cy) < a.height / 2;

  if (mode === "grid") {
    // Bottom-to-top edges leave and enter through spread ports so they never overlap at the node.
    for (const b of bindings) {
      const s = rects.get(b.from)!, t = rects.get(b.to)!;
      if (sameRow(s, t)) continue;
      ports.out.set(b.from, [...(ports.out.get(b.from) ?? []), b.id]);
      ports.in.set(b.to, [...(ports.in.get(b.to) ?? []), b.id]);
    }
    const port = (side: "out" | "in", node: string, edgeId: string, rect: Rect) => {
      const list = (ports[side].get(node) ?? []).slice().sort((a, c) => {
        const ra = rects.get(side === "out" ? bindings.find((x) => x.id === a)!.to : bindings.find((x) => x.id === a)!.from)!;
        const rc = rects.get(side === "out" ? bindings.find((x) => x.id === c)!.to : bindings.find((x) => x.id === c)!.from)!;
        return ra.cx - rc.cx;
      });
      const i = list.indexOf(edgeId);
      return rect.left + rect.width * (i + 1) / (list.length + 1);
    };
    const laneEdges = bindings.filter((b) => { const s = rects.get(b.from)!, t = rects.get(b.to)!; return !sameRow(s, t) && Math.abs(port("out", b.from, b.id, s) - port("in", b.to, b.id, t)) > 1; })
      .sort((a, c) => (rects.get(a.from)!.cx - rects.get(c.from)!.cx) || (rects.get(a.to)!.cx - rects.get(c.to)!.cx));
    for (const b of bindings) {
      const s = rects.get(b.from)!, t = rects.get(b.to)!;
      if (sameRow(s, t)) {
        const rightward = t.cx > s.cx;
        const x1 = rightward ? s.right : s.left, x2 = rightward ? t.left : t.right;
        edges.push({ id: b.id, from: b.from as ExampleNodeId, to: b.to as ExampleNodeId, capability: b.capability, d: `M ${x1} ${s.cy} L ${x2} ${t.cy}`, labelAt: Math.abs(x2 - x1) >= 100 ? [(x1 + x2) / 2, s.cy - 9] : null });
        continue;
      }
      const down = t.cy > s.cy;
      const sx = port("out", b.from, b.id, s), tx = port("in", b.to, b.id, t);
      const sy = down ? s.bottom : s.top, ty = down ? t.top : t.bottom;
      const lane = laneEdges.findIndex((e) => e.id === b.id);
      const gapTop = Math.min(sy, ty), gapBottom = Math.max(sy, ty);
      const my = lane < 0 ? (sy + ty) / 2 : gapTop + (gapBottom - gapTop) * (lane + 1) / (laneEdges.length + 1);
      const points: [number, number][] = Math.abs(sx - tx) <= 1 ? [[sx, sy], [tx, ty]] : [[sx, sy], [sx, my], [tx, my], [tx, ty]];
      edges.push({ id: b.id, from: b.from as ExampleNodeId, to: b.to as ExampleNodeId, capability: b.capability, d: orthogonal(points), labelAt: Math.abs(sx - tx) <= 1 ? [sx + 6, (sy + ty) / 2] : [(sx + tx) / 2, my - 7] });
    }
    return edges;
  }

  // Stack mode: adjacent downward edges run straight; everything else takes a rail on the right.
  const rail = bindings.filter((b) => { const s = rects.get(b.from)!, t = rects.get(b.to)!; return !(stackOrder(b.to) - stackOrder(b.from) === 1 && t.cy > s.cy); })
    .sort((a, c) => Math.abs(stackOrder(a.to) - stackOrder(a.from)) - Math.abs(stackOrder(c.to) - stackOrder(c.from)));
  const laneGap = 14, railStart = width - 10;
  for (const b of bindings) {
    const s = rects.get(b.from)!, t = rects.get(b.to)!;
    const lane = rail.findIndex((e) => e.id === b.id);
    if (lane < 0) {
      edges.push({ id: b.id, from: b.from as ExampleNodeId, to: b.to as ExampleNodeId, capability: b.capability, d: `M ${s.cx} ${s.bottom} L ${t.cx} ${t.top}`, labelAt: [s.cx + 6, (s.bottom + t.top) / 2] });
      continue;
    }
    const x = railStart - lane * laneGap;
    const sy = s.top + s.height * 0.62, ty = t.top + t.height * 0.38;
    edges.push({ id: b.id, from: b.from as ExampleNodeId, to: b.to as ExampleNodeId, capability: b.capability, d: orthogonal([[s.right, sy], [x, sy], [x, ty], [t.right, ty]]), labelAt: null });
  }
  return edges;
}

export function SystemDiagram({ manifest, label, proposedIds = [], proposedBindingIds = [], selected = null, onSelect, href, highlight = null, health, showSizing = false, reveal = false, flow = NO_FLOW, className }: SystemDiagramProps) {
  const id = useId().replace(/:/g, "");
  const container = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const [mode, setMode] = useState<"grid" | "stack">("grid");
  const [edges, setEdges] = useState<Edge[]>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useSystemFlow(container, flow, edges);
  const present = EXAMPLE_NODE_IDS.filter((nodeId) => manifest.services.some((s) => s.id === nodeId) || manifest.resources.some((r) => r.id === nodeId) || manifest.routes.some((r) => r.id === nodeId));

  const measure = useCallback(() => {
    const host = container.current;
    if (!host) return;
    const base = host.getBoundingClientRect();
    if (base.width === 0) return;
    const nextMode = base.width < 600 ? "stack" : "grid";
    const rects = new Map<string, Rect>();
    nodes.current.forEach((element, nodeId) => {
      const r = element.getBoundingClientRect();
      rects.set(nodeId, { left: r.left - base.left, top: r.top - base.top, right: r.right - base.left, bottom: r.bottom - base.top, cx: r.left - base.left + r.width / 2, cy: r.top - base.top + r.height / 2, width: r.width, height: r.height });
    });
    setMode(nextMode);
    setSize({ width: base.width, height: base.height });
    setEdges(routeEdges(manifest, rects, nextMode, base.width));
  }, [manifest]);

  useLayoutEffect(() => {
    measure();
    const host = container.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(host);
    document.fonts?.ready.then(measure).catch(() => {});
    return () => observer.disconnect();
  }, [measure, mode]);

  const hotNodes = new Set(highlight?.nodes ?? []);
  const hotBindings = new Set(highlight?.bindings ?? []);
  const softening = hotNodes.size > 0 || hotBindings.size > 0;
  const touches = (edge: Edge) => selected !== null && (edge.from === selected || edge.to === selected);

  const register = (nodeId: string) => (element: HTMLElement | null) => {
    if (element) nodes.current.set(nodeId, element); else nodes.current.delete(nodeId);
  };

  return (
    <div ref={container} className={[styles.diagram, className].filter(Boolean).join(" ")} data-mode={mode} data-reveal={reveal || undefined} role="group" aria-label={label}>
      <div className={styles.grid}>
        {present.map((nodeId, index) => {
          const meta = NODE_META[nodeId];
          const kind = kindOf(manifest, nodeId);
          const Glyph = GLYPH[kind] ?? Server;
          const service = manifest.services.find((s) => s.id === nodeId);
          const resource = manifest.resources.find((r) => r.id === nodeId);
          const proposed = proposedIds.includes(nodeId);
          const hot = hotNodes.has(nodeId) || (hotBindings.size > 0 && manifest.bindings.some((b) => hotBindings.has(b.id) && (b.from === nodeId || b.to === nodeId)));
          const soft = softening && !hot;
          const sizing = showSizing ? service ? `${service.size} · ${service.replicas} replica${service.replicas === 1 ? "" : "s"}` : resource ? resource.size : "managed TLS" : null;
          const body: ReactNode = <>
            <Glyph className={styles.glyph} size={18} strokeWidth={1.6} aria-hidden="true" />
            <span className={styles.label}>{meta.label}</span>
            <span className={styles.sub}><span>{KIND_LABEL[kind] ?? kind}</span>{sizing && <span>{sizing}</span>}{proposed && <span className={styles.tag}>Proposed</span>}</span>
            {health?.[nodeId] && <span className={styles.health} data-health={health[nodeId]}><span className={styles.sr}>{health[nodeId] === "ok" ? "Healthy" : "Watch"}</span></span>}
          </>;
          const style = { "--col": meta.grid.col + 1, "--row": meta.grid.row + 1, "--stack": meta.stack, "--i": index } as React.CSSProperties;
          const shared = { ref: register(nodeId), className: styles.node, style, "data-node": nodeId, "data-proposed": proposed || undefined, "data-hot": hot || undefined, "data-soft": soft || undefined };
          if (href) return <a key={nodeId} {...shared} href={href} data-selected={selected === nodeId || undefined} onClick={() => onSelect?.(nodeId)} aria-label={`${meta.label}: ${meta.role} Open the inspector.`}>{body}</a>;
          if (onSelect) return <button key={nodeId} {...shared} type="button" aria-pressed={selected === nodeId} onClick={() => onSelect(nodeId)}>{body}</button>;
          return <div key={nodeId} {...shared} data-selected={selected === nodeId || undefined}>{body}</div>;
        })}
      </div>
      <svg className={styles.edges} width={size.width || undefined} height={size.height || undefined} viewBox={size.width ? `0 0 ${size.width} ${size.height}` : undefined} aria-hidden="true" focusable="false">
        <defs>
          {[["muted", styles.arrow], ["ink", styles.arrowInk], ["accent", styles.arrowAccent]].map(([name, cls]) => (
            <marker key={name} id={`${id}-${name}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M 1 1 L 9 5 L 1 9 z" className={cls} /></marker>
          ))}
        </defs>
        {edges.map((edge, index) => {
          const proposed = proposedBindingIds.includes(edge.id);
          const hot = hotBindings.has(edge.id) || (hotBindings.size === 0 && hotNodes.size > 0 && (hotNodes.has(edge.from) && hotNodes.has(edge.to)));
          const soft = softening && !hot && !(hotNodes.has(edge.from) || hotNodes.has(edge.to)) ;
          const active = touches(edge);
          const marker = hot || proposed ? "accent" : active ? "ink" : "muted";
          return <g key={edge.id}>
            <path className={styles.edge} d={edge.d} markerEnd={`url(#${id}-${marker})`} data-edge={edge.id} data-from={edge.from} data-to={edge.to} data-proposed={proposed || undefined} data-selected={active || undefined} data-hot={hot || undefined} data-soft={soft || undefined} style={{ "--i": index } as React.CSSProperties} />
            {(active || hot) && edge.labelAt && <text className={styles.edgeLabel} x={edge.labelAt[0]} y={edge.labelAt[1]}>{CAPABILITY_PHRASE[edge.capability as keyof typeof CAPABILITY_PHRASE]}</text>}
          </g>;
        })}
        {flow.length > 0 && <g className={styles.light} data-flow-light><circle r="11" /><circle r="4.5" /></g>}
      </svg>
      <ul className={styles.sr}>
        {manifest.bindings.map((b) => <li key={b.id}>{NODE_META[b.from as ExampleNodeId]?.label ?? b.from} {CAPABILITY_PHRASE[b.capability]} {NODE_META[b.to as ExampleNodeId]?.label ?? b.to}.</li>)}
      </ul>
    </div>
  );
}
