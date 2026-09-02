/**
 * What the map draws, derived from the working manifest, the pending changeset
 * and the health payload. Pure: no hooks, no React — the component memoises a
 * call to `buildGraph` on the three keys below, so the graph is rebuilt when
 * the system changes and not when a node is selected, focused or hovered.
 */
import type { ChangeItem, Manifest } from "@/lib/domain/types";
import { nodeMonthlyCostUsd } from "@/lib/cost/pricing";
import type { BindingEdge } from "./edges";
import type { Stratum } from "./layout";
import type { MapNodeData } from "./nodes";

/** GET /api/health/:environmentId, as much of it as the map reads. */
export interface HealthPayload {
  simulated: boolean;
  services: Record<
    string,
    { status: "ok" | "degraded"; replicasReady: number; replicasDesired: number; latencyMs: number }
  >;
}

/** Bindings are edges, not nodes — they ghost as edges further down. */
const STRATUM_OF: Record<ChangeItem["nodeType"], Stratum | null> = {
  route: "route",
  service: "service",
  resource: "resource",
  binding: null,
};

export interface RawNode {
  id: string;
  stratum: Stratum;
  data: MapNodeData;
}

export interface GraphModel {
  allRaw: RawNode[];
  allEdges: BindingEdge[];
  empty: boolean;
}

export interface BuildGraphInput {
  manifest: Manifest;
  changeset: { items: ChangeItem[] } | undefined;
  health: HealthPayload | undefined;
  deployed: boolean;
  liveTargets: string[];
}

/* --------------------------------- keys ---------------------------------- */

/**
 * Only what the map actually draws. Stringifying the whole manifest on every
 * render also hashed env vars, secret refs and resource config — none of which
 * the map reads — and the poll hands us a fresh object every 5s.
 */
export function manifestKey(m: Manifest): string {
  return [
    ...m.routes.map((r) => `R${r.id}:${r.host}:${r.pathPrefix}:${r.tls}`),
    ...m.services.map((s) => `S${s.id}:${s.name}:${s.kind}:${s.size}:${s.replicas}:${s.schedule ?? ""}:${s.ownership}`),
    ...m.resources.map((r) => `D${r.id}:${r.name}:${r.kind}:${r.size}:${r.ownership}`),
    ...m.bindings.map((b) => `B${b.id}:${b.from}>${b.to}:${b.capability}:${b.note ?? ""}`),
  ].join("|");
}

export function diffKey(changeset: { items: ChangeItem[] } | undefined): string {
  return JSON.stringify(
    changeset?.items.map((i) => [i.nodeId, i.op, i.nodeType, i.nodeName, i.costDeltaUsd]) ?? []
  );
}

/**
 * Status and replica counts only. latencyMs is reseeded every 10 seconds by
 * the log simulator, and folding it in here re-laid-out the whole graph on
 * that timer — visible jitter for a number that belongs on Observe.
 */
export function healthKey(health: HealthPayload | undefined): string {
  return Object.entries(health?.services ?? {})
    .map(([id, h]) => `${id}:${h.status}:${h.replicasReady}/${h.replicasDesired}`)
    .join("|");
}

/* -------------------------------- the graph -------------------------------- */

export function buildGraph({
  manifest: m,
  changeset,
  health,
  deployed,
  liveTargets,
}: BuildGraphInput): GraphModel {
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

  const raw: RawNode[] = [];

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
}
