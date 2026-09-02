"use client";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Node,
} from "@xyflow/react";
import {
  Boxes,
  Database,
  FileUp,
  Globe,
  Layers,
  Link2,
  Plus,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Button, Chip, Dialog, EmptyState, Input, Kbd } from "@/components/ui";
import { useProjectData } from "@/components/shell/project-context";
import { Inspector, type InspectorTarget } from "@/components/inspector/inspector";
import { PlanFirst } from "@/components/inspector/plan-first";
import { DeployDock } from "@/components/deploy/deploy-dock";
import { useJson } from "@/lib/client/api";
import { nodeMonthlyCostUsd } from "@/lib/cost/pricing";
import type { ChangeItem } from "@/lib/domain/types";
import { BlueprintDialog, ImportDialog, type BlueprintCard } from "./dialogs";
import { edgeTypes, type BindingEdge } from "./edges";
import { NODE_SIZE, layoutGraph, type Stratum } from "./layout";
import { nodeTypes, type MapNodeData } from "./nodes";

interface HealthPayload {
  simulated: boolean;
  services: Record<
    string,
    { status: "ok" | "degraded"; replicasReady: number; replicasDesired: number; latencyMs: number }
  >;
}

/** Half the visual size of an edge anchor, in graph units. */
const HANDLE_R = 3;

/** Bindings are edges, not nodes — they ghost as edges further down. */
const STRATUM_OF: Record<ChangeItem["nodeType"], Stratum | null> = {
  route: "route",
  service: "service",
  resource: "resource",
  binding: null,
};

/** Keyboard order across the map: left column to right, top to bottom. */
const STRATA_ORDER: Stratum[] = ["route", "service", "resource"];

const STRATUM_LABEL: Record<Stratum, string> = {
  route: "Routes",
  service: "Services",
  resource: "Resources",
};

export interface SystemMapProps {
  /** blueprint catalog metadata, read on the server */
  blueprints: BlueprintCard[];
}

export function SystemMap(props: SystemMapProps) {
  return (
    <ReactFlowProvider>
      <SystemMapInner {...props} />
    </ReactFlowProvider>
  );
}

interface MenuState {
  nodeId: string;
  x: number;
  y: number;
}

function SystemMapInner({ blueprints }: SystemMapProps) {
  const { project, changesets, selectedEnvId, selectedEnv } = useProjectData();
  const rf = useReactFlow();
  const [target, setTarget] = useState<InspectorTarget | null>(null);
  const [binding, setBinding] = useState(false);
  const [bindFrom, setBindFrom] = useState<string | null>(null);
  const [bindPair, setBindPair] = useState<{ from: string; to: string } | null>(null);
  /** which node holds the graph's single tab stop */
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [liveTargets, setLiveTargets] = useState<string[]>([]);
  const [dialog, setDialog] = useState<"blueprint" | "compose" | null>(null);
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState<Stratum[]>([]);
  const [menu, setMenu] = useState<MenuState | null>(null);
  /** node the context menu offered to remove; the plan is shown in a dialog */
  const [removing, setRemoving] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);

  const m = project.workingManifest;
  const changeset = changesets[selectedEnvId];
  const deployed = Boolean(selectedEnv?.deployedRevisionId);

  const { data: health } = useJson<HealthPayload>(
    deployed ? `/api/health/${selectedEnvId}` : null,
    5000
  );

  const exitBind = useCallback(() => {
    setBinding(false);
    setBindFrom(null);
  }, []);

  useEffect(() => exitBind(), [selectedEnvId, exitBind]);

  /** Bring a node into view without changing the zoom the user chose. */
  const centerOn = useCallback(
    (id: string) => {
      const n = rf.getNode(id);
      if (!n) return;
      const w = n.width ?? n.measured?.width ?? 200;
      const h = n.height ?? n.measured?.height ?? 80;
      rf.setCenter(n.position.x + w / 2, n.position.y + h / 2, {
        zoom: rf.getZoom(),
        duration: 200,
      });
    },
    [rf]
  );

  /** Escape out of the inspector puts the caret back where it came from. */
  const focusNode = useCallback((id: string) => {
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-map-node][data-node-id="${CSS.escape(id)}"]`)
        ?.focus();
    });
  }, []);

  // Deep link: /p/<slug>?select=<nodeId> (Security findings link here).
  // Read once from location.search to avoid the useSearchParams Suspense
  // requirement; strip the param afterwards so refresh doesn't re-force it.
  // /p/<slug>?review=1 (Security's "review the pending changes") opens the
  // deploy dock on the changes review; read once alongside ?select.
  const [openReview, setOpenReview] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("review")) {
      setOpenReview(true);
      params.delete("review");
      const qs = params.toString();
      window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
    }
    const wanted = params.get("select");
    if (!wanted) return;
    const exists =
      m.services.some((s) => s.id === wanted) ||
      m.resources.some((r) => r.id === wanted) ||
      m.routes.some((r) => r.id === wanted);
    if (exists) setTarget({ kind: "node", nodeId: wanted });
    params.delete("select");
    const qs = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        el instanceof HTMLElement &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

      // "/" is the find shortcut everywhere else; it is here too.
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
        return;
      }
      if (e.key !== "Escape") return;
      if (menu) {
        const id = menu.nodeId;
        setMenu(null);
        focusNode(id);
      } else if (binding) exitBind();
      else if (target) {
        // Focus came from a node, so it goes back to that node — not to the
        // top of the document, which is where it landed before.
        const back =
          target.kind === "node"
            ? target.nodeId
            : target.kind === "binding"
              ? m.bindings.find((b) => b.id === target.bindingId)?.from
              : undefined;
        setTarget(null);
        if (back) {
          setFocusedId(back);
          focusNode(back);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [binding, target, menu, exitBind, focusNode, m.bindings]);

  const onNodeActivate = useCallback(
    (nodeId: string) => {
      setBindFrom((from) => {
        if (!binding) {
          setTarget({ kind: "node", nodeId });
          return null;
        }
        if (!from) return nodeId;
        if (from === nodeId) return null;
        setBindPair({ from, to: nodeId });
        return null;
      });
    },
    [binding]
  );

  const selectedNodeId = target?.kind === "node" ? target.nodeId : null;
  const selectedBindingId = target?.kind === "binding" ? target.bindingId : null;
  const liveKey = liveTargets.join(",");
  // Only what the map actually draws. Stringifying the whole manifest on every
  // render also hashed env vars, secret refs and resource config — none of
  // which the map reads — and the poll hands us a fresh object every 5s.
  const manifestKey = [
    ...m.routes.map((r) => `R${r.id}:${r.host}:${r.pathPrefix}:${r.tls}`),
    ...m.services.map((s) => `S${s.id}:${s.name}:${s.kind}:${s.size}:${s.replicas}:${s.schedule ?? ""}:${s.ownership}`),
    ...m.resources.map((r) => `D${r.id}:${r.name}:${r.kind}:${r.size}:${r.ownership}`),
    ...m.bindings.map((b) => `B${b.id}:${b.from}>${b.to}:${b.capability}:${b.note ?? ""}`),
  ].join("|");
  const diffKey = JSON.stringify(changeset?.items.map((i) => [i.nodeId, i.op, i.nodeType, i.nodeName, i.costDeltaUsd]) ?? []);
  // Status and replica counts only. latencyMs is reseeded every 10 seconds by
  // the log simulator, and folding it in here re-laid-out the whole graph on
  // that timer — visible jitter for a number that belongs on Observe.
  const healthKey = Object.entries(health?.services ?? {})
    .map(([id, h]) => `${id}:${h.status}:${h.replicasReady}/${h.replicasDesired}`)
    .join("|");

  /* Structure and content of the graph: rebuilt only when the system, the
     changeset or health actually changes — never on selection or focus. */
  const { allRaw, allEdges, empty } = useMemo(() => {
    const diffOp = new Map<string, ChangeItem["op"]>();
    for (const i of changeset?.items ?? []) diffOp.set(i.nodeId, i.op);

    const healthFor = (serviceId: string): Pick<MapNodeData, "health" | "healthLabel"> => {
      if (!deployed)
        return { health: "idle", healthLabel: "Not deployed to this environment yet" };
      const h = health?.services?.[serviceId];
      if (!h) return { health: "idle", healthLabel: "Not running in this environment yet" };
      return {
        health: h.status === "ok" ? "ok" : "warn",
        healthLabel: `${h.replicasReady}/${h.replicasDesired} ready — simulated health`,
      };
    };

    const raw: { id: string; stratum: Stratum; data: MapNodeData }[] = [];

    for (const r of m.routes) {
      raw.push({
        id: r.id,
        stratum: "route",
        data: {
          name: r.host,
          stratum: "route",
          kind: "route",
          costUsd: nodeMonthlyCostUsd(m, r.id),
          tls: r.tls,
          diff: diffOp.get(r.id),
          live: liveTargets.includes(r.id),
        },
      });
    }

    for (const s of m.services) {
      const sub =
        s.kind === "cron"
          ? (s.schedule ?? "no schedule")
          : s.kind === "static"
            ? "prebuilt files"
            : `${s.size} × ${s.replicas}`;
      raw.push({
        id: s.id,
        stratum: "service",
        data: {
          name: s.name,
          stratum: "service",
          kind: s.kind,
          sub,
          costUsd: nodeMonthlyCostUsd(m, s.id),
          ownership: s.ownership,
          diff: diffOp.get(s.id),
          live: liveTargets.includes(s.id),
          ...healthFor(s.id),
        },
      });
    }

    for (const r of m.resources) {
      raw.push({
        id: r.id,
        stratum: "resource",
        data: {
          name: r.name,
          stratum: "resource",
          kind: r.kind,
          sub: r.ownership === "managed" ? r.size : `${r.size} · ${r.ownership}`,
          costUsd: nodeMonthlyCostUsd(m, r.id),
          ownership: r.ownership,
          diff: diffOp.get(r.id),
          live: liveTargets.includes(r.id),
        },
      });
    }

    // Things this environment still runs that the working copy no longer has.
    for (const item of changeset?.items ?? []) {
      if (item.op !== "delete") continue;
      const stratum = STRATUM_OF[item.nodeType];
      if (!stratum) continue;
      raw.push({
        id: item.nodeId,
        stratum,
        data: {
          name: item.nodeName,
          stratum,
          kind: item.nodeType,
          sub: "removed on next deploy",
          costUsd: -item.costDeltaUsd,
          diff: "delete",
        },
      });
    }

    const known = new Set(raw.map((n) => n.id));
    const edgeDefs: BindingEdge[] = m.bindings
      .filter((b) => known.has(b.from) && known.has(b.to))
      .map((b) => ({
        id: b.id,
        source: b.from,
        target: b.to,
        type: "binding" as const,
        data: {
          capability: b.capability,
          note: b.note,
          live: liveTargets.includes(b.to),
          diff: diffOp.get(b.id) === "create" ? ("create" as const) : undefined,
        },
      }));

    // A removed binding has to ghost too, or the map claims a connection is
    // already gone while the Changes panel still lists it — the exact
    // disagreement ARCHITECTURE ADR 5 forbids. The changeset carries a
    // binding's endpoints only as its display name, "<from> → <to>", so resolve
    // them against the nodes above (ghosts included).
    const byName = new Map(raw.map((n) => [n.data.name, n.id]));
    for (const item of changeset?.items ?? []) {
      if (item.op !== "delete" || item.nodeType !== "binding") continue;
      const [from, to] = item.nodeName.split(" → ");
      const source = byName.get(from);
      const target = byName.get(to);
      if (!source || !target) continue;
      edgeDefs.push({
        id: item.nodeId,
        source,
        target,
        type: "binding",
        data: { capability: "removing", note: item.explanation, diff: "delete" },
      });
    }

    // What each node is wired to, by name — the only way a screen reader can
    // hear the bindings at all.
    const nameOfNode = new Map(raw.map((n) => [n.id, n.data.name]));
    for (const n of raw) {
      const peers = edgeDefs
        .filter((e) => e.source === n.id || e.target === n.id)
        .map((e) => nameOfNode.get(e.source === n.id ? e.target : e.source))
        .filter((x): x is string => Boolean(x));
      n.data.connections = [...new Set(peers)];
    }

    return {
      allRaw: raw,
      allEdges: edgeDefs,
      empty: m.services.length === 0 && m.resources.length === 0 && m.routes.length === 0,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifestKey, diffKey, healthKey, liveKey, deployed]);

  /* Hiding a column is a view, not an edit — the nodes leave the drawing, the
     working system is untouched, and the toolbar says so out loud. */
  const hiddenKey = hidden.join(",");
  const { raw, edgeDefs } = useMemo(() => {
    if (hidden.length === 0) return { raw: allRaw, edgeDefs: allEdges };
    const kept = allRaw.filter((n) => !hidden.includes(n.stratum));
    const ids = new Set(kept.map((n) => n.id));
    return {
      raw: kept,
      edgeDefs: allEdges.filter((e) => ids.has(e.source) && ids.has(e.target)),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRaw, allEdges, hiddenKey]);

  /* Dagre runs only when the shape of the graph changes — not when a node is
     renamed, resized, selected, focused or reports different health. */
  const structureKey =
    raw.map((n) => `${n.id}:${n.stratum}`).join("|") +
    "//" +
    edgeDefs.map((e) => `${e.source}>${e.target}`).join("|");

  const positions = useMemo(
    () =>
      layoutGraph(
        raw.map((n) => ({ id: n.id, stratum: n.stratum })),
        edgeDefs.map((e) => ({ source: e.source, target: e.target }))
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [structureKey]
  );

  /** Names that match the find box, or null when nothing is being searched. */
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return new Set(raw.filter((n) => n.data.name.toLowerCase().includes(q)).map((n) => n.id));
  }, [query, raw]);

  const { nodes, edges, nodeCount, order } = useMemo(() => {
    // Keyboard order follows the drawing: column by column, top to bottom.
    const order = [...raw]
      .sort(
        (a, b) =>
          STRATA_ORDER.indexOf(a.stratum) - STRATA_ORDER.indexOf(b.stratum) ||
          (positions[a.id]?.y ?? 0) - (positions[b.id]?.y ?? 0)
      )
      .map((n) => n.id);
    const rank = new Map(order.map((id, i) => [id, i]));
    const roving = focusedId && rank.has(focusedId) ? focusedId : order[0];
    const nav = (id: string, delta: -1 | 1) => {
      const at = rank.get(id) ?? 0;
      const next = order[(at + delta + order.length) % order.length];
      if (next) {
        setFocusedId(next);
        // Walking off the edge of the viewport used to move focus to a node
        // nobody could see. The pan follows the keyboard.
        centerOn(next);
      }
    };

    // Only offer what system.bind will actually accept: nothing may target a
    // route, a route may only point at a service, and a ghost is not in the
    // working manifest at all, so it cannot be bound to anything.
    const routeIds = new Set(m.routes.map((r) => r.id));
    const serviceIds = new Set(m.services.map((s) => s.id));
    const liveIds = new Set([...m.services.map((s) => s.id), ...m.resources.map((r) => r.id), ...routeIds]);

    const bindState = (id: string): MapNodeData["bindState"] => {
      if (!binding || !liveIds.has(id)) return undefined;
      if (bindFrom === id) return "source";
      if (!bindFrom) return "candidate";
      if (routeIds.has(id)) return undefined;
      if (routeIds.has(bindFrom) && !serviceIds.has(id)) return undefined;
      return "candidate";
    };

    // Sizes and anchor points are known up front, so edges have real geometry
    // on the first paint rather than after a measurement pass.
    const nodes: Node<MapNodeData>[] = raw.map((n) => {
      const { width, height } = NODE_SIZE[n.stratum];
      return {
        id: n.id,
        type: n.stratum,
        position: positions[n.id] ?? { x: 0, y: 0 },
        data: {
          ...n.data,
          selected: selectedNodeId === n.id,
          bindState: bindState(n.id),
          focused: n.id === roving,
          dimmed: matches ? !matches.has(n.id) : false,
          posLabel: `${(rank.get(n.id) ?? 0) + 1} of ${order.length}`,
          onActivate: () => onNodeActivate(n.id),
          onFocus: () => setFocusedId(n.id),
          onNav: (delta: -1 | 1) => nav(n.id, delta),
          onMenu: (x: number, y: number) => setMenu({ nodeId: n.id, x, y }),
        },
        width,
        height,
        handles: [
          {
            type: "target" as const,
            position: Position.Left,
            x: -HANDLE_R,
            y: height / 2 - HANDLE_R,
            width: HANDLE_R * 2,
            height: HANDLE_R * 2,
          },
          {
            type: "source" as const,
            position: Position.Right,
            x: width - HANDLE_R,
            y: height / 2 - HANDLE_R,
            width: HANDLE_R * 2,
            height: HANDLE_R * 2,
          },
        ],
        draggable: false,
        selectable: false,
        focusable: false,
        connectable: false,
      };
    });

    const edges: BindingEdge[] = edgeDefs.map((e) => ({
      ...e,
      selected: e.id === selectedBindingId,
      data: {
        ...e.data!,
        dimmed: matches ? !matches.has(e.source) && !matches.has(e.target) : false,
      },
    }));

    return { nodes, edges, nodeCount: order.length, order };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    raw,
    edgeDefs,
    positions,
    selectedNodeId,
    selectedBindingId,
    focusedId,
    binding,
    bindFrom,
    matches,
    manifestKey,
    onNodeActivate,
    centerOn,
  ]);

  const nameOf = (id: string) =>
    m.services.find((s) => s.id === id)?.name ??
    m.resources.find((r) => r.id === id)?.name ??
    m.routes.find((r) => r.id === id)?.host ??
    // A ghost is not in the working copy, but it is on the map, so it still
    // has a name to show — an id in a menu title is not one.
    allRaw.find((n) => n.id === id)?.data.name ??
    id;

  /** Which remove action a node needs, or null when it is not editable. */
  const removeSpec = (id: string) => {
    if (m.services.some((s) => s.id === id))
      return { actionId: "system.removeService", input: { serviceId: id }, verb: "Remove" };
    if (m.resources.some((r) => r.id === id))
      return { actionId: "system.removeResource", input: { resourceId: id }, verb: "Remove" };
    if (m.routes.some((r) => r.id === id))
      return { actionId: "system.removeRoute", input: { routeId: id }, verb: "Unpublish" };
    return null;
  };

  const pick = (nodeId: string) => {
    setTarget({ kind: "node", nodeId });
    setFocusedId(nodeId);
    centerOn(nodeId);
  };

  const bindingCount = m.bindings.length;
  const menuNode = menu ? menu.nodeId : null;
  const menuSpec = menuNode ? removeSpec(menuNode) : null;

  return (
    <div className="flex h-full min-h-0">
      <div className="relative min-w-0 flex-1">
        {empty ? (
          <div className="grid h-full place-items-center">
            <EmptyState
              icon={<Boxes className="h-5 w-5" aria-hidden="true" />}
              title={`${project.name} has nothing in it yet`}
              body="The map draws what your system actually is. Start from a shape that already works, bring one you have, or add the first piece by hand."
              action={
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button variant="primary" onClick={() => setDialog("blueprint")}>
                    Start from a blueprint
                  </Button>
                  <Button
                    variant="quiet"
                    icon={<FileUp className="h-3.5 w-3.5" aria-hidden="true" />}
                    onClick={() => setDialog("compose")}
                  >
                    Import a file
                  </Button>
                  <Button variant="quiet" onClick={() => setTarget({ kind: "add-service" })}>
                    Add your first service
                  </Button>
                </div>
              }
            />
          </div>
        ) : (
          // One tab stop for the whole graph: the nodes rove the tabIndex
          // between themselves and arrow keys walk the drawn order.
          <div
            role="application"
            aria-label={`System map for ${project.name}: ${nodeCount} node${nodeCount === 1 ? "" : "s"} and ${bindingCount} connection${bindingCount === 1 ? "" : "s"}. Arrow keys move between nodes; Enter opens one in the inspector; each node names what it is connected to. Press slash to find a node by name.`}
            className="h-full w-full"
          >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable={false}
            // Still false: React Flow's own selection state would fight the
            // controlled `edges` array. An edge is clickable because
            // onEdgeClick is set — the wrapper only goes pointer-events:none
            // when it is both unselectable and unclickable — and `selected`
            // below stays derived from the inspector target, so the map and
            // the panel can never disagree about what is open.
            elementsSelectable={false}
            edgesFocusable={false}
            onEdgeClick={(_, edge) => setTarget({ kind: "binding", bindingId: edge.id })}
            onPaneClick={() => setMenu(null)}
            panOnScroll
            minZoom={0.1}
            maxZoom={1.6}
            fitView
            fitViewOptions={{ padding: 0.22, maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={22} size={1} color="var(--line)" />
            <Controls position="bottom-right" showInteractive={false} />
          </ReactFlow>
          </div>
        )}

        {/* Toolbar — top-left, never under the toasts or the zoom controls.
            Every group wraps on its own so a 375px screen stacks them instead
            of pushing Connect off the edge. */}
        <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex flex-wrap items-start gap-2">
          <div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-1 rounded-card border border-line bg-bg2 p-1 shadow-card">
            {!binding && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
                  onClick={() => setTarget({ kind: "add-service" })}
                >
                  Service
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Database className="h-3.5 w-3.5" aria-hidden="true" />}
                  onClick={() => setTarget({ kind: "add-resource" })}
                >
                  Resource
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Globe className="h-3.5 w-3.5" aria-hidden="true" />}
                  onClick={() => setTarget({ kind: "add-route" })}
                >
                  Route
                </Button>
                <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-line" />
              </>
            )}
            <Button
              size="sm"
              variant={binding ? "primary" : "ghost"}
              aria-pressed={binding}
              icon={<Link2 className="h-3.5 w-3.5" aria-hidden="true" />}
              disabled={!binding && m.services.length + m.resources.length + m.routes.length < 2}
              disabledReason="Connecting needs two nodes — add another one first."
              onClick={() => (binding ? exitBind() : setBinding(true))}
            >
              {binding ? "Cancel" : "Connect"}
            </Button>
            {/* Importing and blueprints used to exist only in the empty state,
                so a project with one service had no way back to either. */}
            {!binding && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<FileUp className="h-3.5 w-3.5" aria-hidden="true" />}
                  onClick={() => setDialog("compose")}
                >
                  Import
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Sparkles className="h-3.5 w-3.5" aria-hidden="true" />}
                  onClick={() => setDialog("blueprint")}
                >
                  Blueprint
                </Button>
              </>
            )}
          </div>

          {!empty && !binding && (
            <>
              <div className="pointer-events-auto w-44 max-w-[45vw]">
                <Input
                  ref={search}
                  value={query}
                  aria-label="Find a node by name"
                  placeholder="Find a node"
                  className="bg-bg2 shadow-card"
                  prefix={<Search className="h-3.5 w-3.5" aria-hidden="true" />}
                  suffix={query ? undefined : <Kbd>/</Kbd>}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setQuery("");
                      search.current?.blur();
                      return;
                    }
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    const first = order.find((id) => matches?.has(id));
                    if (first) pick(first);
                  }}
                />
              </div>

              <div
                role="group"
                aria-label="Show or hide columns"
                className="pointer-events-auto flex flex-wrap items-center gap-1 rounded-card border border-line bg-bg2 p-1 shadow-card"
              >
                <Layers className="mx-1 h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden="true" />
                {STRATA_ORDER.map((s) => {
                  const on = !hidden.includes(s);
                  return (
                    <Button
                      key={s}
                      size="sm"
                      variant={on ? "ghost" : "quiet"}
                      aria-pressed={on}
                      title={on ? `Hide the ${STRATUM_LABEL[s]} column` : `Show the ${STRATUM_LABEL[s]} column`}
                      onClick={() =>
                        setHidden((h) => (h.includes(s) ? h.filter((x) => x !== s) : [...h, s]))
                      }
                      className={on ? undefined : "line-through opacity-70"}
                    >
                      {STRATUM_LABEL[s]}
                    </Button>
                  );
                })}
              </div>
            </>
          )}

          {binding && (
            <div
              role="status"
              className="animate-enter pointer-events-auto mx-auto flex items-center gap-3 rounded-full border border-signal/40 bg-bg3 px-4 py-1.5 shadow-overlay"
            >
              <span className="text-[12.5px] text-ink">
                {bindFrom
                  ? `From ${nameOf(bindFrom)} — now pick what it uses.`
                  : "Pick a source, then a target."}
              </span>
              <span className="text-[12px] text-ink-faint">
                <Kbd>Esc</Kbd> cancels
              </span>
            </div>
          )}

          <div className="ml-auto flex flex-wrap items-center gap-2">
            {matches && (
              <Chip
                className="pointer-events-auto"
                tone={matches.size === 0 ? "warn" : "signal"}
              >
                {matches.size === 0
                  ? `nothing matches "${query.trim()}"`
                  : `${matches.size} of ${nodeCount} match`}
              </Chip>
            )}
            {hidden.length > 0 && (
              <Chip
                className="pointer-events-auto"
                tone="warn"
                title="Hidden columns are a view only — the working system still contains them, and the Changes panel still lists them."
              >
                {hidden.map((s) => STRATUM_LABEL[s].toLowerCase()).join(" and ")} hidden
              </Chip>
            )}
            {deployed && health?.simulated && (
              <Chip className="pointer-events-auto" title="Health here is computed by the sandbox provider, not measured against real infrastructure.">
                simulated health
              </Chip>
            )}
          </div>
        </div>

        {menu && (
          <NodeMenu
            x={menu.x}
            y={menu.y}
            name={nameOf(menu.nodeId)}
            canRemove={Boolean(menuSpec)}
            onInspect={() => {
              setMenu(null);
              pick(menu.nodeId);
            }}
            onConnect={() => {
              setMenu(null);
              setBinding(true);
              setBindFrom(menu.nodeId);
            }}
            onRemove={() => {
              setMenu(null);
              setRemoving(menu.nodeId);
            }}
            onClose={() => {
              const id = menu.nodeId;
              setMenu(null);
              focusNode(id);
            }}
          />
        )}
      </div>

      <Inspector
        target={target}
        onClose={() => setTarget(null)}
        onSelect={setTarget}
      />

      <DeployDock
        onLiveTargets={setLiveTargets}
        onAddRoute={() => setTarget({ kind: "add-route" })}
        inspectorOpen={target !== null}
        openReview={openReview}
      />

      <BlueprintDialog
        open={dialog === "blueprint"}
        onClose={() => setDialog(null)}
        blueprints={blueprints}
      />
      <ImportDialog open={dialog === "compose"} onClose={() => setDialog(null)} />

      <Dialog
        open={Boolean(bindPair)}
        onClose={() => setBindPair(null)}
        width={520}
        title="Connect these two"
        description={
          bindPair ? `${nameOf(bindPair.from)} → ${nameOf(bindPair.to)}` : undefined
        }
      >
        {bindPair && (
          <PlanFirst
            actionId="system.bind"
            input={{ from: bindPair.from, to: bindPair.to }}
            label="Preview the connection"
            onDone={() => {
              setBindPair(null);
              exitBind();
            }}
            onCancel={() => setBindPair(null)}
          />
        )}
      </Dialog>

      <Dialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        width={520}
        title={removing ? `Remove ${nameOf(removing)}?` : undefined}
        description="Removing takes it out of the working system. Nothing changes in a running environment until you deploy."
      >
        {removing && removeSpec(removing) && (
          <PlanFirst
            actionId={removeSpec(removing)!.actionId}
            input={removeSpec(removing)!.input}
            label={`${removeSpec(removing)!.verb} ${nameOf(removing)}`}
            variant="danger"
            confirmName={nameOf(removing)}
            confirmWhen="high-risk"
            onDone={() => {
              setRemoving(null);
              setTarget(null);
            }}
            onCancel={() => setRemoving(null)}
          />
        )}
      </Dialog>
    </div>
  );
}

/**
 * The node's own menu. A positioned list, not a modal: it must not lock the
 * page or trap focus behind a three-item shortcut.
 */
function NodeMenu({
  x,
  y,
  name,
  canRemove,
  onInspect,
  onConnect,
  onRemove,
  onClose,
}: {
  x: number;
  y: number;
  name: string;
  canRemove: boolean;
  onInspect: () => void;
  onConnect: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  // Focus lands on the first item once, on open — not on every re-render, which
  // would drag it back off whichever item the user had arrowed to.
  useEffect(() => {
    ref.current?.querySelector("button")?.focus();
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as globalThis.Node)) close.current();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, []);

  /** role="menu" promises arrow keys, so it has them. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  // Keep it on screen: a right-click near the bottom edge would otherwise open
  // a menu nobody can reach.
  const left = Math.min(x, (typeof window === "undefined" ? 1200 : window.innerWidth) - 210);
  const top = Math.min(y, (typeof window === "undefined" ? 800 : window.innerHeight) - 140);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`Actions for ${name}`}
      onKeyDown={onKeyDown}
      style={{ position: "fixed", left, top }}
      className="animate-enter z-50 w-[200px] overflow-hidden rounded-card border border-line bg-bg3 py-1 shadow-overlay"
    >
      <MenuItem onClick={onInspect}>Inspect</MenuItem>
      <MenuItem onClick={onConnect}>Connect from here</MenuItem>
      <MenuItem
        onClick={onRemove}
        danger
        disabled={!canRemove}
        title={
          canRemove
            ? undefined
            : `${name} is already staged for removal — it is in the Changes panel, waiting for a deploy.`
        }
        icon={<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
      >
        Remove
      </MenuItem>
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  danger,
  disabled,
  title,
  icon,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      aria-disabled={disabled || undefined}
      title={title}
      onClick={onClick}
      className={[
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px]",
        "transition-colors duration-[120ms] [transition-timing-function:var(--ease-swift)]",
        "disabled:cursor-not-allowed disabled:opacity-55",
        danger ? "text-err hover:bg-err-dim" : "text-ink hover:bg-bg2",
      ].join(" ")}
    >
      {icon}
      {children}
    </button>
  );
}
