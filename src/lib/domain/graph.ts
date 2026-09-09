/**
 * Manifest graph operations: validation, diffing, and derived facts.
 *
 * Pure functions over `./types` and nothing else — no store, no provider, no
 * environment. Two manifests in, a Changeset out; that is what lets the same
 * diff drive an action plan, the Changes drawer and the API.
 * SPINE FILE — owned by the integrator.
 */
import {
  type Binding,
  type ChangeItem,
  type Changeset,
  type Manifest,
  type Resource,
  type Service,
} from "./types";
import { monthlyCostUsd, nodeMonthlyCostUsd } from "@/lib/cost/pricing";

export type NodeRef =
  | { type: "service"; node: Service }
  | { type: "resource"; node: Resource };

export function findNode(m: Manifest, nodeId: string): NodeRef | undefined {
  const s = m.services.find((s) => s.id === nodeId);
  if (s) return { type: "service", node: s };
  const r = m.resources.find((r) => r.id === nodeId);
  if (r) return { type: "resource", node: r };
  return undefined;
}

export function nodeName(m: Manifest, nodeId: string): string {
  return (
    findNode(m, nodeId)?.node.name ??
    m.routes.find((r) => r.id === nodeId)?.host ??
    nodeId
  );
}

/** Env vars a binding injects into its `from` service. Deterministic. */
export function bindingEnv(m: Manifest, b: Binding): { key: string; from: string }[] {
  const target = findNode(m, b.to);
  if (!target) return [];
  const P = target.node.name.replace(/-/g, "_").toUpperCase();
  switch (b.capability) {
    case "sql":
      return ["URL", "HOST", "PORT", "USER", "PASSWORD", "DATABASE"].map((k) => ({
        key: `${P}_${k}`,
        from: target.node.name,
      }));
    case "cache":
      return [{ key: `${P}_URL`, from: target.node.name }];
    case "blob":
      return ["BUCKET", "ENDPOINT", "ACCESS_KEY", "SECRET_KEY"].map((k) => ({
        key: `${P}_${k}`,
        from: target.node.name,
      }));
    case "queue_publish":
    case "queue_consume":
      return [{ key: `${P}_URL`, from: target.node.name }];
    case "smtp":
      return ["HOST", "PORT", "USER", "PASSWORD"].map((k) => ({
        key: `${P}_${k}`,
        from: target.node.name,
      }));
    case "http":
      return [{ key: `${P}_URL`, from: target.node.name }];
  }
}

export interface ValidationIssue {
  level: "error" | "warning";
  nodeId?: string;
  message: string;
  /** what to do about it — every error names its fix */
  fix?: string;
}

/** Structural validation. Every error message names the fix. */
export function validateManifest(m: Manifest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();

  for (const n of [...m.services, ...m.resources]) {
    if (ids.has(n.id)) issues.push({ level: "error", nodeId: n.id, message: `Duplicate node id "${n.id}".` });
    ids.add(n.id);
    if (names.has(n.name))
      issues.push({
        level: "error",
        nodeId: n.id,
        message: `Two nodes share the name "${n.name}".`,
        fix: "Rename one of them; names must be unique within a project.",
      });
    names.add(n.name);
  }

  for (const b of m.bindings) {
    const from =
      findNode(m, b.from) ?? (m.routes.find((r) => r.id === b.from) ? "route" : undefined);
    const to = findNode(m, b.to);
    if (!from)
      issues.push({ level: "error", message: `Binding ${b.id} points from a node that no longer exists.`, fix: "Delete the binding." });
    if (!to)
      issues.push({ level: "error", message: `Binding ${b.id} points to a node that no longer exists.`, fix: "Delete the binding." });
  }

  for (const r of m.routes) {
    const served = m.bindings.some((b) => b.from === r.id && b.capability === "http");
    if (!served)
      issues.push({
        level: "warning",
        nodeId: r.id,
        message: `Route ${r.host} is not connected to any service.`,
        fix: "Bind the route to a web service, or remove it.",
      });
  }

  for (const s of m.services) {
    if (s.kind === "web" && !s.port)
      issues.push({
        level: "error",
        nodeId: s.id,
        message: `Web service "${s.name}" has no port.`,
        fix: "Set the port your app listens on (e.g. 3000).",
      });
    if (s.kind === "cron" && !s.schedule)
      issues.push({
        level: "error",
        nodeId: s.id,
        message: `Scheduled job "${s.name}" has no schedule.`,
        fix: "Set a cron expression, e.g. */15 * * * *.",
      });
  }

  /* Two routes claiming the same host + path. The second never gets traffic. */
  const seenHosts = new Map<string, string>();
  for (const r of m.routes) {
    const key = `${r.host.toLowerCase()}${r.pathPrefix}`;
    const first = seenHosts.get(key);
    if (first)
      issues.push({
        level: "error",
        nodeId: r.id,
        message: `Two routes serve ${r.host}${r.pathPrefix === "/" ? "" : r.pathPrefix}.`,
        fix: `Give this route a different host or path prefix, or delete it — ${first} already claims that address.`,
      });
    else seenHosts.set(key, r.id);
  }

  /* A web service nothing routes to is unreachable from outside. */
  const routed = new Set(m.bindings.filter((b) => b.capability === "http").map((b) => b.to));
  for (const s of m.services) {
    if (s.kind !== "web" || routed.has(s.id)) continue;
    issues.push({
      level: "warning",
      nodeId: s.id,
      message: `Web service "${s.name}" has no route.`,
      fix: "Add a route bound to it, or change its kind to worker — nothing outside the system can reach it as it stands.",
    });
  }

  /* A hand-written env var whose key a binding also injects: which wins is undefined. */
  for (const s of m.services) {
    const injected = new Map<string, string>();
    for (const b of m.bindings.filter((b) => b.from === s.id))
      for (const e of bindingEnv(m, b)) injected.set(e.key, e.from);
    for (const e of s.env) {
      const from = injected.get(e.key);
      if (!from) continue;
      issues.push({
        level: "error",
        nodeId: s.id,
        message: `"${s.name}" sets ${e.key} by hand, and its binding to ${from} injects the same key.`,
        fix: `Rename or remove ${s.name}'s own ${e.key} — which value wins at deploy time is not defined.`,
      });
    }
  }

  /* Env vars with nothing behind them. */
  for (const s of m.services)
    for (const e of s.env) {
      // `vault:` references are Zenith's own store, which this function cannot
      // read: validation is pure and runs in the browser, and the store is a
      // server file. Whether a value is actually there is answered where it
      // can be — the Variables panel, the action's plan, and the deploy log.
      // Anything else is somebody else's secret manager, and Zenith resolving
      // it is exactly what does NOT happen.
      if (e.secretRef) {
        if (!e.secretRef.startsWith("vault:"))
          issues.push({
            level: "warning",
            nodeId: s.id,
            message: `"${s.name}" reads ${e.key} from ${e.secretRef}, which is not Zenith's secret store.`,
            fix: `Zenith records the name and nothing else — the provider has to resolve ${e.secretRef} at deploy time. Set the value on the provider side, or store it in Zenith with system.setSecret, which leaves a reference scoped to this service.`,
          });
      } else if (e.value === undefined)
        issues.push({
          level: "error",
          nodeId: s.id,
          message: `"${s.name}" declares ${e.key} with neither a value nor a secret reference.`,
          fix: `Give ${e.key} a value, point it at a secret, or remove it.`,
        });
    }

  return issues;
}

/* ---------------------------------- diff ---------------------------------- */

function fieldDiffs(before: object, after: object): { field: string; before: unknown; after: unknown }[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: { field: string; before: unknown; after: unknown }[] = [];
  for (const k of keys) {
    const b = JSON.stringify((before as Record<string, unknown>)[k]);
    const a = JSON.stringify((after as Record<string, unknown>)[k]);
    if (b !== a)
      out.push({
        field: k,
        before: (before as Record<string, unknown>)[k],
        after: (after as Record<string, unknown>)[k],
      });
  }
  return out;
}

function riskFor(op: "create" | "update" | "delete", nodeType: string, stateful: boolean): "low" | "medium" | "high" {
  if (op === "delete" && stateful) return "high";
  if (op === "delete") return "medium";
  if (op === "update" && stateful) return "medium";
  return "low";
}

const STATEFUL: string[] = ["postgres", "redis", "object_store", "queue"];

/**
 * Does destroying this resource destroy data? Exported so the deploy gate and
 * the diff agree on one list — an environment's `allowStatefulDeletion` policy
 * is meaningless if the gate and the risk label disagree about what counts.
 */
export const isStatefulKind = (kind: string | undefined): boolean => STATEFUL.includes(kind ?? "");

/**
 * Compute the changeset between the deployed manifest and the working copy.
 * This is what the Plan drawer renders — every item carries an explanation
 * and a cost delta, so nothing changes silently.
 */
export function diffManifests(deployed: Manifest, working: Manifest): Changeset {
  const items: ChangeItem[] = [];

  type Collection = "services" | "resources" | "routes" | "bindings";
  const collections: { key: Collection; nodeType: ChangeItem["nodeType"] }[] = [
    { key: "services", nodeType: "service" },
    { key: "resources", nodeType: "resource" },
    { key: "routes", nodeType: "route" },
    { key: "bindings", nodeType: "binding" },
  ];

  for (const { key, nodeType } of collections) {
    const before = deployed[key] as { id: string }[];
    const after = working[key] as { id: string }[];
    const beforeById = new Map(before.map((n) => [n.id, n]));
    const afterById = new Map(after.map((n) => [n.id, n]));

    for (const node of after) {
      const prev = beforeById.get(node.id);
      const name = displayName(working, nodeType, node.id);
      if (!prev) {
        const stateful = nodeType === "resource" && STATEFUL.includes((node as { kind?: string }).kind ?? "");
        items.push({
          op: "create",
          nodeType,
          nodeId: node.id,
          nodeName: name,
          explanation: explainCreate(working, nodeType, node.id),
          costDeltaUsd: nodeMonthlyCostUsd(working, node.id),
          risk: riskFor("create", nodeType, stateful),
        });
      } else if (JSON.stringify(prev) !== JSON.stringify(node)) {
        const stateful = nodeType === "resource" && STATEFUL.includes((node as { kind?: string }).kind ?? "");
        items.push({
          op: "update",
          nodeType,
          nodeId: node.id,
          nodeName: name,
          fields: fieldDiffs(prev, node),
          explanation: explainUpdate(nodeType, name, fieldDiffs(prev, node)),
          costDeltaUsd:
            nodeMonthlyCostUsd(working, node.id) - nodeMonthlyCostUsd(deployed, node.id),
          risk: riskFor("update", nodeType, stateful),
        });
      }
    }
    for (const node of before) {
      if (!afterById.has(node.id)) {
        const stateful = nodeType === "resource" && STATEFUL.includes((node as { kind?: string }).kind ?? "");
        items.push({
          op: "delete",
          nodeType,
          nodeId: node.id,
          nodeName: displayName(deployed, nodeType, node.id),
          explanation:
            nodeType === "resource" && stateful
              ? `Removes ${displayName(deployed, nodeType, node.id)} and its data. This is destructive and cannot be undone by rollback alone.`
              : `Removes ${displayName(deployed, nodeType, node.id)} from the system.`,
          costDeltaUsd: -nodeMonthlyCostUsd(deployed, node.id),
          risk: riskFor("delete", nodeType, stateful),
        });
      }
    }
  }

  const totalCostDeltaUsd = round2(items.reduce((a, i) => a + i.costDeltaUsd, 0));
  const warnings: string[] = [];
  if (items.some((i) => i.op === "delete" && i.risk === "high"))
    warnings.push("This plan deletes stateful resources. Their data will be destroyed.");
  const projectedMonthlyUsd = round2(monthlyCostUsd(working));

  return { items, totalCostDeltaUsd, projectedMonthlyUsd, warnings };
}

function displayName(m: Manifest, nodeType: ChangeItem["nodeType"], nid: string): string {
  if (nodeType === "route") return m.routes.find((r) => r.id === nid)?.host ?? nid;
  if (nodeType === "binding") {
    const b = m.bindings.find((b) => b.id === nid);
    if (!b) return nid;
    return `${nodeName(m, b.from)} → ${nodeName(m, b.to)}`;
  }
  return nodeName(m, nid);
}

function explainCreate(m: Manifest, nodeType: ChangeItem["nodeType"], nid: string): string {
  if (nodeType === "service") {
    const s = m.services.find((s) => s.id === nid)!;
    const what =
      s.kind === "web" ? "a web service" : s.kind === "worker" ? "a background worker" : s.kind === "cron" ? "a scheduled job" : "a static site";
    return `Creates ${what} "${s.name}" (${s.size}, ${s.replicas} replica${s.replicas === 1 ? "" : "s"}).`;
  }
  if (nodeType === "resource") {
    const r = m.resources.find((r) => r.id === nid)!;
    const labels: Record<string, string> = {
      postgres: "a PostgreSQL database",
      redis: "a Redis cache",
      object_store: "an object storage bucket",
      queue: "a message queue",
      email: "an email sender",
    };
    return `Provisions ${labels[r.kind]} "${r.name}" (${r.size}).`;
  }
  if (nodeType === "route") {
    const r = m.routes.find((r) => r.id === nid)!;
    return `Publishes ${r.host} with ${r.tls ? "TLS" : "no TLS"}.`;
  }
  const b = m.bindings.find((b) => b.id === nid)!;
  const env = bindingEnv(m, b);
  return env.length
    ? `Connects ${nodeName(m, b.from)} to ${nodeName(m, b.to)} and injects ${env.map((e) => e.key).join(", ")}.`
    : `Connects ${nodeName(m, b.from)} to ${nodeName(m, b.to)}.`;
}

function explainUpdate(
  nodeType: string,
  name: string,
  fields: { field: string; before: unknown; after: unknown }[]
): string {
  const parts = fields.slice(0, 3).map((f) => `${f.field}: ${fmt(f.before)} → ${fmt(f.after)}`);
  const more = fields.length > 3 ? ` (+${fields.length - 3} more)` : "";
  return `Updates ${name} — ${parts.join(", ")}${more}.`;
}

const fmt = (v: unknown) =>
  v === undefined ? "unset" : typeof v === "object" ? "…" : String(v);

export const round2 = (n: number) => Math.round(n * 100) / 100;
