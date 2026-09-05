"use client";
/**
 * The system map. This file wires the pieces together and owns the selection:
 * the graph itself is built in graph-model.ts, focus and Escape live in
 * keyboard.ts, the chrome is toolbar.tsx and the right-click menu is
 * node-menu.tsx.
 */
import "./react-flow.css";
import dynamic from "next/dynamic";
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
import { Boxes, FileUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useProjectData } from "@/components/shell/project-context";
import type { InspectorTarget } from "@/components/inspector/inspector";
import { PlanFirst } from "@/components/inspector/plan-first";
import { DeployDock } from "@/components/deploy/deploy-dock";
import { useJson } from "@/lib/client/api";
import { DRIFT_POLL_MS, type DriftResponse } from "@/lib/drift";
import type { BlueprintCard } from "./dialogs";
import { type BindingEdge, edgeTypes } from "./edges";
import {
  buildGraph,
  diffKey,
  healthKey,
  manifestKey,
  type HealthPayload,
} from "./graph-model";
import { useMapKeyboard, useNodeFocus } from "./keyboard";
import { NODE_SIZE, layoutGraph, type Stratum } from "./layout";
import { NodeMenu } from "./node-menu";
import { nodeTypes, type MapNodeData } from "./nodes";
import { MapToolbar, STRATA_ORDER } from "./toolbar";

/** Half the visual size of an edge anchor, in graph units. */
const HANDLE_R = 3;
function LoadingTool({ label }: { label: string }) {
  return <div role="status" className="fixed right-4 bottom-4 z-50 w-60 space-y-3 rounded-card border border-line bg-bg2 p-4 shadow-card">
    <p className="text-[13px] text-ink">{label}</p>
    <Skeleton height={12} width="75%" />
  </div>;
}
const Inspector = dynamic(() => import("@/components/inspector/inspector").then((m) => m.Inspector), {
  ssr: false, loading: () => <LoadingTool label="Opening editor…" />,
});
const BlueprintDialog = dynamic(() => import("./dialogs").then((m) => m.BlueprintDialog), {
  ssr: false, loading: () => <LoadingTool label="Opening blueprints…" />,
});
const ImportDialog = dynamic(() => import("./dialogs").then((m) => m.ImportDialog), {
  ssr: false, loading: () => <LoadingTool label="Opening import…" />,
});

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

  /* Drift, from the same route the Observe screen reads. Only asked for once
     something is deployed — there is nothing to compare against otherwise —
     and on a slow cadence, because drift is someone editing a console by hand.
     A provider that cannot observe answers with an error here; the map simply
     shows no chips, and Observe is where the refusal is explained in full. */
  const { data: drift } = useJson<DriftResponse>(
    deployed ? `/api/environments/${selectedEnvId}/drift` : null,
    DRIFT_POLL_MS
  );

  /** Worst drift per node. `extra` rows have no node to sit on and are skipped. */
  const driftByNode = useMemo(() => {
    const byNode = new Map<string, MapNodeData["drift"]>();
    // computeDrift returns highest severity first, so the first hit per node wins.
    for (const it of drift?.items ?? [])
      if (it.nodeId && !byNode.has(it.nodeId))
        byNode.set(it.nodeId, { kind: it.kind, severity: it.severity, detail: it.detail });
    return byNode;
  }, [drift]);

  const exitBind = useCallback(() => {
    setBinding(false);
    setBindFrom(null);
  }, []);

  useEffect(() => exitBind(), [selectedEnvId, exitBind]);

  const { centerOn, focusNode } = useNodeFocus(rf);

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

  const closeMenu = useCallback(() => setMenu(null), []);
  const closeTarget = useCallback(
    (back: string | undefined) => {
      setTarget(null);
      if (back) {
        setFocusedId(back);
        focusNode(back);
      }
    },
    [focusNode]
  );

  useMapKeyboard({
    searchRef: search,
    menuNodeId: menu?.nodeId ?? null,
    binding,
    target,
    bindings: m.bindings,
    focusNode,
    closeMenu,
    exitBind,
    closeTarget,
  });

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
  const mKey = manifestKey(m);
  const dKey = diffKey(changeset);
  const hKey = healthKey(health);

  /* Structure and content of the graph: rebuilt only when the system, the
     changeset or health actually changes — never on selection or focus. */
  const { allRaw, allEdges, empty } = useMemo(
    () => buildGraph({ manifest: m, changeset, health, deployed, liveTargets }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mKey, dKey, hKey, liveKey, deployed]
  );

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
          // Presentational, and merged here rather than in the structural memo
          // above on purpose: drift arrives on its own poll, and folding it in
          // there would re-lay-out the whole graph every time it ticked.
          drift: driftByNode.get(n.id),
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
    mKey,
    driftByNode,
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
            // M10. Culling is safe here for a reason worth writing down: every
            // node carries explicit `width`/`height` from NODE_SIZE before the
            // first paint, so React Flow knows each rect without a measurement
            // pass — the condition its own docs warn about. Ghost nodes and
            // ghost edges go into the same `raw`/`edgeDefs` arrays with the
            // same geometry and real endpoint ids, so they are culled by
            // position exactly like anything else and never selectively.
            //
            // Guarded rather than always on: under ~60 nodes `fitView` already
            // shows the whole graph, so the per-node viewport test on every pan
            // frame would cost something and save nothing.
            onlyRenderVisibleElements={nodeCount > 60}
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

        <MapToolbar
          empty={empty}
          binding={binding}
          bindFromName={bindFrom ? nameOf(bindFrom) : null}
          nodeCount={nodeCount}
          nodeTotal={m.services.length + m.resources.length + m.routes.length}
          hidden={hidden}
          query={query}
          searchRef={search}
          matchCount={matches ? matches.size : null}
          simulatedHealth={Boolean(deployed && health?.simulated)}
          onAdd={(kind) => setTarget({ kind })}
          onOpenDialog={setDialog}
          onToggleBinding={() => (binding ? exitBind() : setBinding(true))}
          onQueryChange={setQuery}
          onSearchSubmit={() => {
            const first = order.find((id) => matches?.has(id));
            if (first) pick(first);
          }}
          onToggleStratum={(s) =>
            setHidden((h) => (h.includes(s) ? h.filter((x) => x !== s) : [...h, s]))
          }
        />

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

      {target && <Inspector
        target={target}
        onClose={() => setTarget(null)}
        onSelect={setTarget}
      />}

      <DeployDock
        onLiveTargets={setLiveTargets}
        onAddRoute={() => setTarget({ kind: "add-route" })}
        inspectorOpen={target !== null}
        openReview={openReview}
      />

      {dialog === "blueprint" && <BlueprintDialog
        open={dialog === "blueprint"}
        onClose={() => setDialog(null)}
        blueprints={blueprints}
      />}
      {dialog === "compose" && <ImportDialog open onClose={() => setDialog(null)} />}

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
