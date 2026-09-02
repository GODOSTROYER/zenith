"use client";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Node,
} from "@xyflow/react";
import { Boxes, Database, FileUp, Globe, Link2, Plus } from "lucide-react";
import { Button, Chip, Dialog, EmptyState, Kbd } from "@/components/ui";
import { useProjectData } from "@/components/shell/project-context";
import { Inspector, type InspectorTarget } from "@/components/inspector/inspector";
import { PlanFirst } from "@/components/inspector/plan-first";
import { DeployDock } from "@/components/deploy/deploy-dock";
import { useJson } from "@/lib/client/api";
import { nodeMonthlyCostUsd } from "@/lib/cost/pricing";
import type { ChangeItem } from "@/lib/domain/types";
import { BlueprintDialog, ImportComposeDialog, type BlueprintCard } from "./dialogs";
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

function SystemMapInner({ blueprints }: SystemMapProps) {
  const { project, changesets, selectedEnvId, selectedEnv } = useProjectData();
  const [target, setTarget] = useState<InspectorTarget | null>(null);
  const [binding, setBinding] = useState(false);
  const [bindFrom, setBindFrom] = useState<string | null>(null);
  const [bindPair, setBindPair] = useState<{ from: string; to: string } | null>(null);
  /** which node holds the graph's single tab stop */
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [liveTargets, setLiveTargets] = useState<string[]>([]);
  const [dialog, setDialog] = useState<"blueprint" | "compose" | null>(null);

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

  // Deep link: /p/<slug>?select=<nodeId> (Security findings link here).
  // Read once from location.search to avoid the useSearchParams Suspense
  // requirement; strip the param afterwards so refresh doesn't re-force it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
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
      if (e.key !== "Escape") return;
      if (binding) exitBind();
      else if (target) setTarget(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [binding, target, exitBind]);

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
  const { raw, edgeDefs, empty } = useMemo(() => {
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
    // disagreement ARCHITECTURE §5 forbids. The changeset carries a binding's
    // endpoints only as its display name, "<from> → <to>", so resolve them
    // against the nodes above (ghosts included).
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

    return {
      raw,
      edgeDefs,
      empty: m.services.length === 0 && m.resources.length === 0 && m.routes.length === 0,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifestKey, diffKey, healthKey, liveKey, deployed]);

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

  const { nodes, edges, nodeCount } = useMemo(() => {
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
      if (next) setFocusedId(next);
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
          posLabel: `${(rank.get(n.id) ?? 0) + 1} of ${order.length}`,
          onActivate: () => onNodeActivate(n.id),
          onFocus: () => setFocusedId(n.id),
          onNav: (delta: -1 | 1) => nav(n.id, delta),
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

    return { nodes, edges: edgeDefs, nodeCount: order.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, edgeDefs, positions, selectedNodeId, focusedId, binding, bindFrom, manifestKey, onNodeActivate]);

  const nameOf = (id: string) =>
    m.services.find((s) => s.id === id)?.name ??
    m.resources.find((r) => r.id === id)?.name ??
    m.routes.find((r) => r.id === id)?.host ??
    id;

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
            aria-label={`System map for ${project.name}: ${nodeCount} node${nodeCount === 1 ? "" : "s"}. Arrow keys move between nodes; Enter opens one in the inspector.`}
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
            elementsSelectable={false}
            panOnScroll
            minZoom={0.3}
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

        {/* Toolbar — top-left, never under the toasts or the zoom controls. */}
        <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex flex-wrap items-start gap-2">
          <div className="pointer-events-auto flex items-center gap-1 rounded-card border border-line bg-bg2 p-1 shadow-card">
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
          </div>

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

          {deployed && health?.simulated && (
            <Chip className="pointer-events-auto ml-auto" title="Health here is computed by the sandbox provider, not measured against real infrastructure.">
              simulated health
            </Chip>
          )}
        </div>
      </div>

      <Inspector
        target={target}
        onClose={() => setTarget(null)}
        onSelectNode={(nodeId) => setTarget({ kind: "node", nodeId })}
      />

      <DeployDock
        onLiveTargets={setLiveTargets}
        onAddRoute={() => setTarget({ kind: "add-route" })}
        inspectorOpen={target !== null}
      />

      <BlueprintDialog
        open={dialog === "blueprint"}
        onClose={() => setDialog(null)}
        blueprints={blueprints}
      />
      <ImportComposeDialog open={dialog === "compose"} onClose={() => setDialog(null)} />

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
    </div>
  );
}
