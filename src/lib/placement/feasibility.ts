/**
 * Feasibility refusal (PROD-COST-02): when no placement satisfies the budget,
 * residency or availability constraints, say so as a typed report with the
 * binding blockers and the nearest miss, instead of a bare empty result.
 *
 * This reads a `PlacementResult` (and the constraints it was solved for). It
 * never relaxes a constraint and never recommends something the solver
 * rejected. The budget is reported as a planning limit on an ESTIMATE, never as
 * a billing cap.
 */
import { BUDGET_NOTICE } from "@/lib/cost/wording";
import { knownRegions, regionSatisfiesResidency } from "@/lib/placement/latency";
import { parseBudgetReason, reasonCategory, type RejectionCategory } from "@/lib/placement/reasons";
import type { PlacementConstraints, PlacementResult } from "@/lib/placement/types";

export type BlockerKind = RejectionCategory | "other";

export interface FeasibilityBlocker {
  kind: BlockerKind;
  /** rejected candidates whose reasons include this kind */
  candidatesAffected: number;
  /** true when every rejected candidate failed on this kind (relaxing anything else will not help) */
  bindingOnAll: boolean;
  message: string;
  /** one verbatim solver reason, as an example (treat as data) */
  example?: string;
}

export interface FeasibilityBudget {
  limitUsdMonthly: number;
  /** the lowest estimate among candidates that failed ONLY on budget */
  cheapestOtherwiseFeasibleUsdMonthly?: number;
  shortfallUsdMonthly?: number;
  isEstimate: true;
  notABillingCap: true;
  notice: string;
}

export interface FeasibilityReport {
  kind: "feasibility";
  feasible: boolean;
  blockers: FeasibilityBlocker[];
  budget?: FeasibilityBudget;
  remedies: string[];
}

const MESSAGE: Record<BlockerKind, string> = {
  budget: "Every placement that meets the other constraints has an estimated cost above the budget.",
  residency: "No allowed region satisfies the residency requirement for these components.",
  availability: "No placement offers enough availability zones or regions for the availability target.",
  capability: "A required component kind has no native type on the candidate providers.",
  pin: "A component pin conflicts with every candidate placement.",
  price: "The price catalog has no price for a resource in the candidate placements, so they cannot be costed.",
  region: "The candidate regions are not in the latency and residency table.",
  denylist: "The provider denylist removes every candidate provider.",
  "cross-cloud margin": "Cross-cloud candidates do not save enough over the best single-provider placement.",
  connection: "The candidate providers have no verified workspace connection.",
  input: "The constraints or components are invalid.",
  other: "Candidates were rejected for other reasons.",
};

const REMEDY: Partial<Record<BlockerKind, string>> = {
  budget: "Raise the budget, choose smaller sizes or fewer replicas, or accept a lower availability target.",
  residency: "Allow another jurisdiction, or check the residency names against the regions Zenith knows.",
  availability: "Lower the availability target, or allow a region with more availability zones.",
  capability: "Pick a provider that hosts every component kind, or change the component.",
  pin: "Remove or change the component pin.",
  price: "Refresh the price catalog for that provider and region, or pick a covered region.",
  denylist: "Remove a provider from the denylist.",
  connection: "Connect and verify a cloud account for a candidate provider in Settings, Connections.",
  input: "Fix the reported input problem and solve again.",
};

/** Residency tokens that no known region satisfies (so no placement can meet them). */
export function unsatisfiableResidency(residency: readonly string[] | undefined): string[] {
  if (!residency || residency.length === 0) return [];
  const regions = knownRegions();
  return regions.some((r) => regionSatisfiesResidency(r, residency)) ? [] : [...residency];
}

export function assessFeasibility(
  result: Pick<PlacementResult, "chosen" | "rejected">,
  constraints: Pick<PlacementConstraints, "budgetUsdMonthly" | "residency">,
): FeasibilityReport {
  const unsatisfiable = unsatisfiableResidency(constraints.residency);
  const budgetLimit = constraints.budgetUsdMonthly;
  const budgetBlock = (): FeasibilityBudget | undefined => {
    if (budgetLimit === undefined) return undefined;
    let cheapest: number | undefined;
    for (const r of result.rejected) {
      if (r.reasons.length === 0 || !r.reasons.every((x) => reasonCategory(x) === "budget")) continue;
      for (const reason of r.reasons) {
        const parsed = parseBudgetReason(reason);
        if (parsed && (cheapest === undefined || parsed.estimatedUsd < cheapest)) cheapest = parsed.estimatedUsd;
      }
    }
    return {
      limitUsdMonthly: budgetLimit,
      ...(cheapest !== undefined ? { cheapestOtherwiseFeasibleUsdMonthly: cheapest, shortfallUsdMonthly: Math.round((cheapest - budgetLimit) * 100) / 100 } : {}),
      isEstimate: true,
      notABillingCap: true,
      notice: BUDGET_NOTICE,
    };
  };

  if (result.chosen) {
    return {
      kind: "feasibility",
      feasible: true,
      blockers: [],
      ...(budgetLimit !== undefined ? { budget: { limitUsdMonthly: budgetLimit, isEstimate: true as const, notABillingCap: true as const, notice: BUDGET_NOTICE } } : {}),
      remedies: [],
    };
  }

  // "provider:<name>" entries are providers removed before any placement was tried (denylist, no connection).
  // They are candidates only when nothing else was tried.
  const tried = result.rejected.filter((r) => !r.id.startsWith("provider:"));
  const rejected = tried.length > 0 ? tried : result.rejected;
  const counts = new Map<BlockerKind, { n: number; example: string }>();
  for (const r of rejected) {
    for (const kind of new Set(r.reasons.map(reasonCategory))) {
      const cur = counts.get(kind);
      if (cur) cur.n += 1;
      else counts.set(kind, { n: 1, example: r.reasons.find((x) => reasonCategory(x) === kind)! });
    }
  }
  const blockers: FeasibilityBlocker[] = [];
  if (unsatisfiable.length > 0) {
    blockers.push({
      kind: "residency",
      candidatesAffected: rejected.length,
      bindingOnAll: true,
      message: `No region Zenith knows satisfies the residency requirement [${unsatisfiable.join(", ")}].`,
    });
  }
  for (const [kind, v] of [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (kind === "residency" && unsatisfiable.length > 0) continue;
    blockers.push({ kind, candidatesAffected: v.n, bindingOnAll: v.n === rejected.length, message: MESSAGE[kind], example: v.example });
  }
  blockers.sort((a, b) => Number(b.bindingOnAll) - Number(a.bindingOnAll) || b.candidatesAffected - a.candidatesAffected || (a.kind < b.kind ? -1 : 1));
  const remedies = [...new Set(blockers.map((b) => REMEDY[b.kind]).filter((x): x is string => x !== undefined))];
  const budget = budgetBlock();
  return { kind: "feasibility", feasible: false, blockers, ...(budget ? { budget } : {}), remedies };
}
