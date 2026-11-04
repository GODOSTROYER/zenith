/**
 * Ownership-aware drift classification.
 *
 * `computeDriftV2` says WHAT differs. Ownership says whether that matters and
 * who may fix it:
 *
 *   iac               unauthorized_change: someone else wrote an IaC field; re-apply reverts it.
 *   native-op         native_divergence: the sanctioned native writer moved it; IaC must not
 *                     revert it, and it is never auto-repaired by re-apply.
 *   autoscaler        expected_variance: the controller is doing its job; not drift.
 *   provider-managed  expected_variance: the provider decides; not drift.
 */
import type { DriftFinding, DriftReport, ResourceGraph } from "@/lib/resources/types";
import { factsByAddress } from "./facts";
import { defaultFieldOwnershipRegistry, type FieldOwnershipRegistry } from "./registry";
import type { FieldOwner, FieldOwnerResolution, OwnershipTransfer } from "./types";

export type OwnedDriftClass = "unauthorized_change" | "native_divergence" | "expected_variance";

export interface OwnedDriftField {
  attribute: string;
  owner: FieldOwner;
  resolution: FieldOwnerResolution;
  classification: OwnedDriftClass;
}

export interface OwnedDriftFinding {
  finding: DriftFinding;
  /** only for `changed` findings with fields; index-aligned with `finding.fields` */
  fields: OwnedDriftField[];
  /** true when every differing field is expected variance (nothing to act on) */
  expectedOnly: boolean;
}

const CLASSIFY: Record<FieldOwner, OwnedDriftClass> = {
  iac: "unauthorized_change",
  "native-op": "native_divergence",
  autoscaler: "expected_variance",
  "provider-managed": "expected_variance",
};

export interface OwnershipDriftOptions {
  registry?: FieldOwnershipRegistry;
  transfers?: readonly OwnershipTransfer[];
  now?: Date;
}

export function classifyDrift(graph: ResourceGraph, report: Pick<DriftReport, "findings">, opts: OwnershipDriftOptions = {}): OwnedDriftFinding[] {
  const registry = opts.registry ?? defaultFieldOwnershipRegistry;
  const nodes = new Map(graph.nodes.map((n) => [n.address, n]));
  const facts = factsByAddress(graph);
  const resolveOpts = { ...(opts.transfers ? { transfers: opts.transfers } : {}), ...(opts.now ? { now: opts.now } : {}) };
  return report.findings.map((finding) => {
    const node = nodes.get(finding.address);
    if (finding.class !== "changed" || !finding.fields || !node) return { finding, fields: [], expectedOnly: false };
    const nodeFacts = facts.get(node.address);
    const fields = finding.fields.map((f): OwnedDriftField => {
      const resolution = registry.resolve({ resourceType: node.nativeType, path: f.attribute, address: node.address, ...(nodeFacts ? { facts: nodeFacts } : {}) }, resolveOpts);
      return { attribute: f.attribute, owner: resolution.owner, resolution, classification: CLASSIFY[resolution.owner] };
    });
    return { finding, fields, expectedOnly: fields.length > 0 && fields.every((f) => f.classification === "expected_variance") };
  });
}

/**
 * The report with ownership applied: expected variance is dropped from
 * findings (a finding with nothing left is removed), and a finding touching a
 * native-op-owned field is no longer repairable by re-applying IaC.
 */
export function applyFieldOwnership(graph: ResourceGraph, report: DriftReport, opts: OwnershipDriftOptions = {}): DriftReport {
  const owned = classifyDrift(graph, report, opts);
  const findings: DriftFinding[] = [];
  for (const { finding, fields } of owned) {
    if (finding.class !== "changed" || !finding.fields || fields.length === 0) {
      findings.push(finding);
      continue;
    }
    const keepIdx = fields.map((f, i) => (f.classification === "expected_variance" ? -1 : i)).filter((i) => i >= 0);
    if (keepIdx.length === 0) continue;
    const nativeOwned = keepIdx.filter((i) => fields[i]!.classification === "native_divergence").map((i) => fields[i]!.attribute);
    const unchanged = keepIdx.length === finding.fields.length && nativeOwned.length === 0;
    findings.push({
      ...finding,
      fields: keepIdx.map((i) => finding.fields![i]!),
      repairable: finding.repairable && nativeOwned.length === 0,
      autoRepairEligible: finding.autoRepairEligible && nativeOwned.length === 0,
      explanation: unchanged
        ? finding.explanation
        : `${finding.explanation}${nativeOwned.length ? ` ${nativeOwned.join(", ")} is owned by a native operation; re-applying infrastructure would revert it, so it is not repaired automatically.` : ""}`,
    });
  }
  return { ...report, findings };
}
