/**
 * Drift — what the provider found, against what the deployed revision says.
 *
 * Pure: it takes a manifest and a `LiveState` and returns differences. It does
 * not call a provider, does not read the store, and never writes. Whether the
 * numbers came from a real inspection or a simulation is `LiveState.simulated`,
 * and it is carried through to the UI untouched.
 *
 * The comparison rule that keeps this honest: only attribute keys the provider
 * ACTUALLY reported are compared. An adapter that cannot see `replicas` reports
 * no `replicas` key, and therefore never produces drift on it. Silence means
 * "not looked at" — never "matches".
 */
import type { Manifest, Resource, Service } from "@/lib/domain/types";
import type { LiveState } from "@/lib/providers/types";

export type DriftKind = "missing" | "extra" | "changed";
export type DriftSeverity = "low" | "medium" | "high";

export interface DriftField {
  field: string;
  expected: string;
  observed: string;
}

export interface DriftItem {
  kind: DriftKind;
  /** manifest node id — "" for `extra`, which by definition has none */
  nodeId: string;
  nodeName: string;
  /** ServiceKind or ResourceKind */
  nodeKind: string;
  severity: DriftSeverity;
  /** plain language: what differs, and what it means */
  detail: string;
  fields?: DriftField[];
  /** provider-side identifier, for `extra` */
  externalRef?: string;
}

/**
 * Wire shape of `GET /api/environments/:id/drift`, shared by the route, the
 * Observe screen and the System Map so all three cannot disagree about it.
 */
export interface DriftResponse {
  simulated: boolean;
  observedAt: string;
  items: DriftItem[];
  provider: { id: string; displayName: string; availability: string };
  /** the deployed revision the comparison was made against */
  revision: { id: string; number: number };
}

/**
 * Drift moves at the speed of someone editing a console by hand, not at the
 * speed of a deployment. One minute, and `useJson` backs off further while the
 * answer keeps coming back the same.
 */
export const DRIFT_POLL_MS = 60_000;

/** Kinds that hold data, so losing one is not the same as losing a container. */
const STATEFUL = new Set(["postgres", "redis", "object_store", "queue"]);

/**
 * What the manifest says a node should look like, in the same key vocabulary
 * adapters report. Secret-backed env vars are deliberately absent: Zenith does
 * not hold those values, so it cannot claim they match or differ.
 */
export function expectedAttributes(
  node: Service | Resource
): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = { size: node.size };
  if ("replicas" in node) {
    attrs.replicas = node.replicas;
    for (const e of node.env) if (e.value !== undefined) attrs[`env:${e.key}`] = e.value;
  } else {
    for (const [k, v] of Object.entries(node.config)) attrs[`config:${k}`] = v;
  }
  return attrs;
}

const RANK: Record<DriftSeverity, number> = { high: 0, medium: 1, low: 2 };

export function computeDrift(deployed: Manifest, live: LiveState): DriftItem[] {
  const items: DriftItem[] = [];
  const observedByNode = new Map(
    live.resources.filter((r) => r.nodeId).map((r) => [r.nodeId, r])
  );
  const inManifest = new Set([
    ...deployed.services.map((s) => s.id),
    ...deployed.resources.map((r) => r.id),
  ]);

  const nodes: { node: Service | Resource; kind: string; stateful: boolean }[] = [
    ...deployed.services.map((s) => ({ node: s as Service | Resource, kind: s.kind, stateful: false })),
    ...deployed.resources.map((r) => ({
      node: r as Service | Resource,
      kind: r.kind,
      stateful: STATEFUL.has(r.kind),
    })),
  ];

  for (const { node, kind, stateful } of nodes) {
    // Referenced and external nodes are not Zenith's to reconcile: it reads
    // them and never provisions them, so "it changed" is not a defect.
    if (node.ownership !== "managed") continue;

    const seen = observedByNode.get(node.id);
    if (!seen) continue; // the provider did not inspect this node — not evidence of anything

    if (!seen.exists) {
      items.push({
        kind: "missing",
        nodeId: node.id,
        nodeName: node.name,
        nodeKind: kind,
        severity: stateful ? "high" : "medium",
        detail: stateful
          ? `${node.name} is in the deployed revision, but the provider cannot find it. If it was deleted outside Zenith, its data is gone — deploying again creates an empty one.`
          : `${node.name} is in the deployed revision, but the provider cannot find it. Deploy this environment again to put it back.`,
      });
      continue;
    }

    const want = expectedAttributes(node);
    const fields = Object.keys(seen.attributes)
      .filter((k) => k in want && String(seen.attributes[k]) !== String(want[k]))
      .sort()
      .map((k) => ({
        field: k,
        expected: String(want[k]),
        observed: String(seen.attributes[k]),
      }));

    if (fields.length)
      items.push({
        kind: "changed",
        nodeId: node.id,
        nodeName: node.name,
        nodeKind: kind,
        severity: "medium",
        detail: `${node.name} does not match the deployed revision: ${fields
          .map((f) => `${f.field} is ${f.observed}, the revision says ${f.expected}`)
          .join("; ")}. Deploying again resets it to the revision.`,
        fields,
      });
  }

  for (const r of live.resources) {
    if (!r.exists || inManifest.has(r.nodeId)) continue;
    const externalRef =
      typeof r.attributes.externalRef === "string" ? r.attributes.externalRef : undefined;
    const name = typeof r.attributes.name === "string" ? r.attributes.name : externalRef ?? r.kind;
    items.push({
      kind: "extra",
      nodeId: "",
      nodeName: name,
      nodeKind: r.kind,
      severity: "low",
      detail: `${name} exists where this environment deploys, and no node in the deployed revision owns it. Zenith will not touch it. Import it as a referenced resource if your system depends on it.`,
      externalRef,
    });
  }

  return items.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}
