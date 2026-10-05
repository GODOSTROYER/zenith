/**
 * Bounded economic optimizer (PROD-COST-03).
 *
 * Pure and deterministic: no network, clock, environment or store. It reads a
 * resource graph, a MEASURED baseline (observed usage and utilization) and the
 * dated price catalog (COST-01) with the placement models (COST-02), and
 * returns optimization PROPOSALS. It never executes anything and never
 * approves anything: `optimizer-submit.ts` hands each proposal to the existing
 * capability broker, where policy and a human approval decide.
 *
 * What a proposal must carry (every one is checked here, not left to a UI):
 * - measured baseline: the numbers come from observed usage, not defaults. No
 *   measured usage means no proposals. When a billed figure is supplied, the
 *   modeled baseline must reconcile with it within `maxBaselineDriftPct`.
 * - savings that say they are estimates: `savings.label === "estimate"`, the
 *   catalog version, the weakest price class used, and what is excluded.
 * - minimum thresholds: absolute USD and percent of the baseline.
 * - hysteresis: a downscale is allowed only when the projected utilization
 *   after the change is at or below `downscaleCeiling`, which sits well below
 *   the `upscaleTrigger` that would undo it; per-address cooldown; and a
 *   reversal lockout that refuses to undo a recent change.
 * - bounded change size: one step per change (one size class or one replica,
 *   one region hop for one co-located site), at most `maxChangesPerWindow`
 *   changes and `maxWindowShiftPct` of baseline spend per window, counting
 *   what history says was already proposed in that window.
 * - transfer, latency and residency: relocation prices the cross-region
 *   egress change through the cost model, adds the one-time data-copy egress,
 *   checks the residency constraint on every destination and the p95 latency
 *   target and regression bound, and requires a payback period.
 * - field ownership: every field a change would write must be reported
 *   `zenith`-owned by a `FieldOwnershipCheck`. The default check reports
 *   everything unknown, and unknown ownership is refused.
 *
 * Honest limits: same-provider region moves and one-step right-sizing only;
 * cross-cloud relocation belongs to the placement solver. Downtime, dual
 * running during a migration and request-level data-copy costs are listed as
 * excluded, not guessed.
 */
import { digest } from "@/lib/controlplane/digest";
import { azCountOf, replicasOf, sizeOf, q6 } from "@/lib/placement/cost-model";
import { skuFor } from "@/lib/placement/capabilities";
import {
  diffCost,
  estimateGraphCost,
  listCrossBoundaryTransfers,
  resolveUsage,
  round2,
  toPriceBook,
  type CostEdge,
  type CostGraph,
  type CostNode,
} from "@/lib/placement/cost";
import { estimateP95Ms, normalizeUserRegion, regionInfo, regionSatisfiesResidency, regionToRegionRttMs, userToRegionRttMs, type UserRegion } from "@/lib/placement/latency";
import { PLACEMENT_SIZES, SIZE_SPECS } from "@/lib/placement/sizes";
import type { PriceBook } from "@/lib/placement/pricebook";
import type { CostEstimate, PlacementConstraints, PriceCatalog, PriceVerification, UsageAssumptions } from "@/lib/placement/types";

/* ----------------------------- field ownership ----------------------------- */

/** A field a change would write: the resource address and a dotted field path (`spec.size`, `region`). */
export interface FieldRef {
  address: string;
  field: string;
}

/**
 * Who owns a field. Only `zenith` allows an automated change. `unknown` means
 * the registry (PROD-LIFE-12) has no answer, and that is refused too.
 */
export type FieldOwnershipVerdict = { owner: "zenith" } | { owner: "external"; detail?: string } | { owner: "unknown"; detail?: string };

/**
 * The interface the field ownership registry satisfies. May be async because
 * the registry reads a store.
 */
export interface FieldOwnershipCheck {
  check(ref: FieldRef): FieldOwnershipVerdict | Promise<FieldOwnershipVerdict>;
}

/** Default: no registry wired, so every field is unknown and every change is refused. */
export const refuseUnknownFieldOwnership: FieldOwnershipCheck = {
  check: () => ({ owner: "unknown", detail: "no field ownership registry is configured" }),
};

/** A fixed table, for tests and local use. Fields not listed are unknown. */
export function staticFieldOwnership(owned: readonly FieldRef[], external: readonly FieldRef[] = []): FieldOwnershipCheck {
  const k = (r: FieldRef) => `${r.address}\u0000${r.field}`;
  const own = new Set(owned.map(k));
  const ext = new Set(external.map(k));
  return {
    check: (r) => (own.has(k(r)) ? { owner: "zenith" } : ext.has(k(r)) ? { owner: "external" } : { owner: "unknown" }),
  };
}

/* --------------------------------- types ---------------------------------- */

export interface OptimizerPolicy {
  /** a proposal must save at least this much per month */
  minMonthlySavingsUsd: number;
  /** ... and at least this fraction of the baseline (0.05 = 5%) */
  minSavingsPct: number;
  /** minimum days of utilization samples before a downscale is considered */
  minSampleDays: number;
  /** a downscale is allowed only if projected utilization after it is <= this */
  downscaleCeiling: number;
  /** utilization at which an upscale would trigger; must exceed `downscaleCeiling` (the hysteresis band) */
  upscaleTrigger: number;
  /** no new change to an address within this long after a recorded one */
  cooldownMs: number;
  /** refuse a change that would undo one recorded within this long */
  reversalLockoutMs: number;
  /** the rolling window the change bounds apply to */
  windowMs: number;
  maxChangesPerWindow: number;
  /** total absolute monthly cost shift allowed per window, as a fraction of the baseline */
  maxWindowShiftPct: number;
  /** relocation: allowed p95 latency regression versus now, ms */
  maxLatencyRegressionMs: number;
  /** relocation: one-time cost must be recovered within this many months */
  maxPaybackMonths: number;
  /** modeled baseline must be within this fraction of the billed figure when one is given */
  maxBaselineDriftPct: number;
}

export const DEFAULT_OPTIMIZER_POLICY: Readonly<OptimizerPolicy> = {
  minMonthlySavingsUsd: 10,
  minSavingsPct: 0.05,
  minSampleDays: 7,
  downscaleCeiling: 0.6,
  upscaleTrigger: 0.8,
  cooldownMs: 7 * 86_400_000,
  reversalLockoutMs: 30 * 86_400_000,
  windowMs: 7 * 86_400_000,
  maxChangesPerWindow: 3,
  maxWindowShiftPct: 0.2,
  maxLatencyRegressionMs: 20,
  maxPaybackMonths: 6,
  maxBaselineDriftPct: 0.25,
};

export interface MeasuredUsage {
  /** observed monthly-equivalent usage; replaces the cost model's defaults */
  usage: UsageAssumptions;
  windowDays: number;
  /** ISO time the measurement ended */
  observedAt: string;
  /** where it was measured, e.g. `usage_meter`, `billing_export` */
  source: string;
  /** the provider-billed monthly total for the same scope, to reconcile the model against */
  billedMonthlyUsd?: number;
}

/** Observed p95 utilization of the ALLOCATED resources, 0..1. */
export interface MeasuredUtilization {
  cpuP95: number;
  memoryP95: number;
  sampleDays: number;
}

export type OptimizationField = "spec.size" | "spec.replicas" | "provider" | "region";

export interface OptimizationHistoryEntry {
  address: string;
  field: OptimizationField;
  kind: OptimizationKind;
  from: string | number;
  to: string | number;
  /** ISO time it was proposed or applied */
  at: string;
  status: "proposed" | "applied" | "rejected";
  /** absolute monthly cost movement it caused, for the window bound */
  monthlyUsdShift?: number;
}

export type OptimizationKind = "rightsize_size" | "rightsize_replicas" | "relocate_site";

export interface OptimizerInput {
  graph: CostGraph;
  catalog: PriceCatalog | PriceBook;
  constraints: PlacementConstraints;
  measured?: MeasuredUsage;
  /** per-address observed utilization (right-sizing needs it) */
  utilization?: Readonly<Record<string, MeasuredUtilization>>;
  /** what has already been proposed or applied (the optimizer's memory) */
  history?: readonly OptimizationHistoryEntry[];
  policy?: Partial<OptimizerPolicy>;
  ownership?: FieldOwnershipCheck;
  /**
   * Only propose what the existing typed `service.scale` operation can carry
   * (container-service size and replicas). Everything else is skipped with
   * `unsupported_path` instead of producing a proposal nothing can execute.
   * The scheduled pass always sets this.
   */
  routableOnly?: boolean;
  /** ISO time of this run; the optimizer never reads a clock */
  now: string;
}

export interface ChangeSet {
  address: string;
  field: OptimizationField;
  from: string | number;
  to: string | number;
}

export interface SavingsEstimate {
  /** always "estimate": never an invoice */
  label: "estimate";
  monthlyUsd: number;
  pct: number;
  baselineMonthlyUsd: number;
  afterMonthlyUsd: number;
  catalogVersion: string;
  /** "verified": every changed price line is official or derived; "weak": a remembered or internal price is involved */
  priceConfidence: "verified" | "weak";
  weakestVerification?: PriceVerification;
  /** monthly egress/transfer cost change (after minus before); positive is more cost */
  transferDeltaUsd: number;
  oneTimeCostUsd: number;
  /** months to recover the one-time cost, undefined when there is none */
  paybackMonths?: number;
  basis: string;
  excluded: string[];
}

export interface OptimizationProposal {
  /** deterministic id of the exact change */
  id: string;
  kind: OptimizationKind;
  title: string;
  changes: ChangeSet[];
  /** the addresses the change touches (right-sizing: one; relocation: a whole site) */
  addresses: string[];
  baseline: {
    monthlyUsd: number;
    source: string;
    windowDays: number;
    observedAt: string;
    billedMonthlyUsd?: number;
    modelVsBilledPct?: number;
  };
  savings: SavingsEstimate;
  evidence: {
    utilization?: { cpuP95: number; memoryP95: number; sampleDays: number; projectedCpu: number; projectedMemory: number; ceiling: number; upscaleTrigger: number };
    latency?: { beforeP95Ms: number; afterP95Ms: number; targetMs?: number; regressionMs: number };
    residency?: { required: string[]; destination: string };
    ownership: { field: string; owner: "zenith" }[];
  };
  /** why a person should read it twice */
  risks: string[];
}

export type SkipCode =
  | "no_measured_baseline"
  | "baseline_unreconciled"
  | "price_unavailable"
  | "not_managed"
  | "ownership_refused"
  | "no_utilization"
  | "insufficient_samples"
  | "hysteresis_ceiling"
  | "floor_reached"
  | "cooldown"
  | "reversal_lockout"
  | "below_threshold"
  | "weak_price"
  | "residency"
  | "latency_unverifiable"
  | "latency_target"
  | "latency_regression"
  | "capacity"
  | "payback"
  | "window_change_limit"
  | "window_shift_limit"
  | "conflict"
  | "unsupported_path";

export interface SkippedOptimization {
  address: string;
  kind: OptimizationKind | "all";
  code: SkipCode;
  message: string;
}

export interface OptimizerResult {
  proposals: OptimizationProposal[];
  skipped: SkippedOptimization[];
  baselineMonthlyUsd?: number;
  catalogVersion?: string;
  policy: OptimizerPolicy;
  generatedAt: string;
}

/* --------------------------------- helpers -------------------------------- */

const WEAK_CLASSES: ReadonlySet<PriceVerification> = new Set<PriceVerification>(["model_knowledge", "internal_assumption"]);
const RIGHTSIZE_KINDS: ReadonlySet<string> = new Set(["container_service", "compute_instance", "postgres", "redis"]);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const ms = (iso: string): number => Date.parse(iso);

export class OptimizerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OptimizerInputError";
  }
}

function resolvePolicy(p: Partial<OptimizerPolicy> | undefined): OptimizerPolicy {
  const out = { ...DEFAULT_OPTIMIZER_POLICY, ...(p ?? {}) };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new OptimizerInputError(`policy.${k} must be a finite number >= 0.`);
  }
  if (out.downscaleCeiling >= out.upscaleTrigger) {
    throw new OptimizerInputError("policy.downscaleCeiling must be below policy.upscaleTrigger: without that gap a downscale would immediately qualify for an upscale (flapping).");
  }
  if (out.upscaleTrigger > 1 || out.minSavingsPct > 1 || out.maxWindowShiftPct > 1) throw new OptimizerInputError("policy fractions must be at most 1.");
  return out;
}

function withNode(graph: CostGraph, address: string, patch: (n: CostNode) => CostNode): CostGraph {
  return { ...graph, nodes: graph.nodes.map((n) => (n.address === address ? patch(n) : n)) };
}

function weakestIn(before: CostEstimate, after: CostEstimate, diffKeys: Set<string>): PriceVerification | undefined {
  let weak: PriceVerification | undefined;
  for (const e of [before, after]) {
    for (const l of e.lines) {
      if (!diffKeys.has(`${l.address ?? ""}\u0000${l.sku}`)) continue;
      if (l.priceVerification && WEAK_CLASSES.has(l.priceVerification)) weak = l.priceVerification;
    }
  }
  return weak;
}

function transferTotal(graph: CostGraph, opts: { catalog: PriceCatalog | PriceBook; usage: UsageAssumptions }): number {
  return round2(listCrossBoundaryTransfers(graph, opts).reduce((s, t) => s + t.usd, 0));
}

async function ownershipFor(check: FieldOwnershipCheck, refs: FieldRef[]): Promise<{ ok: true; fields: { field: string; owner: "zenith" }[] } | { ok: false; message: string }> {
  const fields: { field: string; owner: "zenith" }[] = [];
  for (const r of refs) {
    const v = await check.check(r);
    if (v.owner !== "zenith") {
      const detail = "detail" in v && v.detail ? ` (${v.detail})` : "";
      return { ok: false, message: `${r.address} ${r.field} is ${v.owner === "unknown" ? "of unknown ownership" : "externally owned"}${detail}; automated changes to it are refused.` };
    }
    fields.push({ field: `${r.address} ${r.field}`, owner: "zenith" });
  }
  return { ok: true, fields };
}

/* ------------------------------- the optimizer ----------------------------- */

interface Candidate {
  proposal: OptimizationProposal;
  /** absolute monthly shift counted against the window */
  shiftUsd: number;
}

export async function optimizeEconomics(input: OptimizerInput): Promise<OptimizerResult> {
  const policy = resolvePolicy(input.policy);
  const nowMs = ms(input.now);
  if (!Number.isFinite(nowMs)) throw new OptimizerInputError("now must be an ISO timestamp.");
  const result: OptimizerResult = { proposals: [], skipped: [], policy, generatedAt: input.now };
  const skip = (address: string, kind: SkippedOptimization["kind"], code: SkipCode, message: string) => result.skipped.push({ address, kind, code, message });

  const measured = input.measured;
  if (!measured || !(measured.windowDays > 0)) {
    skip("*", "all", "no_measured_baseline", "No measured usage was supplied, so there is no baseline to measure savings against. Default usage assumptions are not a baseline.");
    return result;
  }
  const ownership = input.ownership ?? refuseUnknownFieldOwnership;
  const book = toPriceBook(input.catalog);
  const usageOpts = { catalog: book, usage: measured.usage, now: input.now };
  const usage = resolveUsage(measured.usage);

  let baseline: CostEstimate;
  try {
    baseline = estimateGraphCost(input.graph, usageOpts);
  } catch (e) {
    skip("*", "all", "price_unavailable", `The current graph cannot be priced from the catalog: ${(e as Error).message}`);
    return result;
  }
  result.baselineMonthlyUsd = baseline.monthlyUsd;
  result.catalogVersion = baseline.catalogVersion;

  let modelVsBilledPct: number | undefined;
  if (measured.billedMonthlyUsd !== undefined) {
    if (!(measured.billedMonthlyUsd > 0)) {
      skip("*", "all", "baseline_unreconciled", "billedMonthlyUsd must be greater than zero when supplied.");
      return result;
    }
    modelVsBilledPct = q6((baseline.monthlyUsd - measured.billedMonthlyUsd) / measured.billedMonthlyUsd);
    if (Math.abs(modelVsBilledPct) > policy.maxBaselineDriftPct) {
      skip(
        "*",
        "all",
        "baseline_unreconciled",
        `The modeled baseline ($${baseline.monthlyUsd.toFixed(2)}) differs from the billed figure ($${measured.billedMonthlyUsd.toFixed(2)}) by ${(Math.abs(modelVsBilledPct) * 100).toFixed(1)}%, above the ${(policy.maxBaselineDriftPct * 100).toFixed(0)}% bound. Savings computed from this model would not be trustworthy.`,
      );
      return result;
    }
  }

  const history = input.history ?? [];
  const baselineInfo = {
    monthlyUsd: baseline.monthlyUsd,
    source: measured.source,
    windowDays: measured.windowDays,
    observedAt: measured.observedAt,
    ...(measured.billedMonthlyUsd !== undefined ? { billedMonthlyUsd: measured.billedMonthlyUsd } : {}),
    ...(modelVsBilledPct !== undefined ? { modelVsBilledPct } : {}),
  };

  const cooldownBlock = (address: string): string | undefined => {
    const recent = history.filter((h) => h.address === address && nowMs - ms(h.at) < policy.cooldownMs);
    if (recent.length === 0) return undefined;
    const last = recent.map((h) => ms(h.at)).sort((a, b) => b - a)[0]!;
    return `${address} changed ${((nowMs - last) / 86_400_000).toFixed(1)} days ago; cooldown is ${(policy.cooldownMs / 86_400_000).toFixed(1)} days.`;
  };
  const reversalBlock = (c: ChangeSet): string | undefined => {
    const undo = history.find((h) => h.address === c.address && h.field === c.field && h.from === c.to && nowMs - ms(h.at) < policy.reversalLockoutMs);
    return undo ? `This would undo the ${undo.status} change of ${c.field} on ${c.address} from ${String(undo.from)} to ${String(undo.to)} made at ${undo.at}; reversals are locked out for ${(policy.reversalLockoutMs / 86_400_000).toFixed(0)} days.` : undefined;
  };

  /** Savings object and threshold checks shared by every kind. Returns undefined after recording the skip. */
  const evaluate = (
    kind: OptimizationKind,
    address: string,
    after: CostGraph,
    extra: { oneTimeCostUsd?: number; excluded: string[]; basis: string },
  ): { savings: SavingsEstimate; shiftUsd: number } | undefined => {
    let afterEst: CostEstimate;
    let transferAfter: number;
    let transferBefore: number;
    try {
      afterEst = estimateGraphCost(after, usageOpts);
      transferAfter = transferTotal(after, { catalog: book, usage: measured.usage });
      transferBefore = transferTotal(input.graph, { catalog: book, usage: measured.usage });
    } catch (e) {
      skip(address, kind, "price_unavailable", `The changed graph cannot be priced from the catalog: ${(e as Error).message}`);
      return undefined;
    }
    const diff = diffCost(baseline, afterEst);
    const saved = round2(baseline.monthlyUsd - afterEst.monthlyUsd);
    const pct = baseline.monthlyUsd > 0 ? q6(saved / baseline.monthlyUsd) : 0;
    if (saved < policy.minMonthlySavingsUsd || pct < policy.minSavingsPct) {
      skip(address, kind, "below_threshold", `Estimated saving $${saved.toFixed(2)}/month (${(pct * 100).toFixed(1)}%) is below the minimum of $${policy.minMonthlySavingsUsd.toFixed(2)} and ${(policy.minSavingsPct * 100).toFixed(1)}% of the baseline.`);
      return undefined;
    }
    const weak = weakestIn(baseline, afterEst, new Set(diff.lines.map((l) => `${l.address ?? ""}\u0000${l.sku}`)));
    if (weak) {
      skip(address, kind, "weak_price", `The saving depends on a ${weak} price, not one read from a provider feed; refresh the catalog before relying on it.`);
      return undefined;
    }
    const oneTime = extra.oneTimeCostUsd ?? 0;
    const payback = oneTime > 0 ? q6(oneTime / saved) : undefined;
    if (payback !== undefined && payback > policy.maxPaybackMonths) {
      skip(address, kind, "payback", `One-time cost $${oneTime.toFixed(2)} takes ${payback.toFixed(1)} months to recover at $${saved.toFixed(2)}/month; the limit is ${policy.maxPaybackMonths} months.`);
      return undefined;
    }
    return {
      shiftUsd: Math.abs(saved),
      savings: {
        label: "estimate",
        monthlyUsd: saved,
        pct,
        baselineMonthlyUsd: baseline.monthlyUsd,
        afterMonthlyUsd: afterEst.monthlyUsd,
        catalogVersion: afterEst.catalogVersion,
        priceConfidence: "verified",
        transferDeltaUsd: round2(transferAfter - transferBefore),
        oneTimeCostUsd: round2(oneTime),
        ...(payback !== undefined ? { paybackMonths: payback } : {}),
        basis: extra.basis,
        excluded: [...extra.excluded, ...afterEst.excluded],
      },
    };
  };

  const candidates: Candidate[] = [];
  const minReplicas = input.constraints.tolerateSingleFailure || (input.constraints.availabilityTarget ?? 0) >= 99.9 ? 2 : 1;
  const nodes = [...input.graph.nodes].sort((a, b) => cmp(a.address, b.address));

  /* ------------------------------ right-sizing ----------------------------- */

  for (const n of nodes) {
    if (!RIGHTSIZE_KINDS.has(n.kind)) continue;
    if (input.routableOnly && n.kind !== "container_service") {
      skip(n.address, "rightsize_size", "unsupported_path", `${n.address} (${n.kind}) has no typed operation that carries a size change; it is not proposed.`);
      continue;
    }
    if ((n.ownership ?? "managed") !== "managed") {
      skip(n.address, "rightsize_size", "not_managed", `${n.address} is ${n.ownership}; Zenith does not change referenced or external resources.`);
      continue;
    }
    const util = input.utilization?.[n.address];
    if (!util) {
      skip(n.address, "rightsize_size", "no_utilization", `No measured utilization for ${n.address}; right-sizing without measurements is refused.`);
      continue;
    }
    if (!(util.sampleDays >= policy.minSampleDays)) {
      skip(n.address, "rightsize_size", "insufficient_samples", `${util.sampleDays} days of samples for ${n.address}; at least ${policy.minSampleDays} are required.`);
      continue;
    }
    const wait = cooldownBlock(n.address);
    if (wait) {
      skip(n.address, "rightsize_size", "cooldown", wait);
      continue;
    }

    const options: { kind: OptimizationKind; change: ChangeSet; patch: (x: CostNode) => CostNode; projCpu: number; projMem: number; label: string }[] = [];
    let size;
    try {
      size = sizeOf(n);
    } catch (e) {
      skip(n.address, "rightsize_size", "price_unavailable", (e as Error).message);
      continue;
    }
    const idx = PLACEMENT_SIZES.indexOf(size);
    if (idx > 0) {
      const next = PLACEMENT_SIZES[idx - 1]!;
      options.push({
        kind: "rightsize_size",
        change: { address: n.address, field: "spec.size", from: size, to: next },
        patch: (x) => ({ ...x, spec: { ...(x.spec ?? {}), size: next } }),
        projCpu: util.cpuP95 * (SIZE_SPECS[size].vcpu / SIZE_SPECS[next].vcpu),
        projMem: util.memoryP95 * (SIZE_SPECS[size].memoryMb / SIZE_SPECS[next].memoryMb),
        label: `Reduce ${n.address} from ${size} to ${next}`,
      });
    } else {
      skip(n.address, "rightsize_size", "floor_reached", `${n.address} is already at the smallest size (nano).`);
    }
    if (n.kind === "container_service") {
      const r = replicasOf(n);
      if (r > minReplicas) {
        const f = r / (r - 1);
        options.push({
          kind: "rightsize_replicas",
          change: { address: n.address, field: "spec.replicas", from: r, to: r - 1 },
          patch: (x) => ({ ...x, spec: { ...(x.spec ?? {}), replicas: r - 1 } }),
          projCpu: util.cpuP95 * f,
          projMem: util.memoryP95 * f,
          label: `Reduce ${n.address} from ${r} to ${r - 1} replicas`,
        });
      } else {
        skip(n.address, "rightsize_replicas", "floor_reached", `${n.address} has ${r} replica${r === 1 ? "" : "s"}; the floor is ${minReplicas}${minReplicas === 2 ? " (availability target needs two)" : ""}.`);
      }
    }

    for (const o of options) {
      if (o.projCpu > policy.downscaleCeiling || o.projMem > policy.downscaleCeiling) {
        skip(
          n.address,
          o.kind,
          "hysteresis_ceiling",
          `${o.label}: projected p95 utilization would be cpu ${(o.projCpu * 100).toFixed(0)}% / memory ${(o.projMem * 100).toFixed(0)}%, above the ${(policy.downscaleCeiling * 100).toFixed(0)}% ceiling that keeps it clear of the ${(policy.upscaleTrigger * 100).toFixed(0)}% upscale trigger.`,
        );
        continue;
      }
      const rev = reversalBlock(o.change);
      if (rev) {
        skip(n.address, o.kind, "reversal_lockout", rev);
        continue;
      }
      const own = await ownershipFor(ownership, [{ address: n.address, field: o.change.field }]);
      if (!own.ok) {
        skip(n.address, o.kind, "ownership_refused", own.message);
        continue;
      }
      const ev = evaluate(o.kind, n.address, withNode(input.graph, n.address, o.patch), {
        excluded: ["Brief capacity reduction and a restart while the new size rolls out", "Request-level effects of a smaller instance on latency under load (utilization was projected, not load-tested)"],
        basis: `${o.label}; catalog price difference at measured usage (${measured.source}, ${measured.windowDays} days). Utilization projected from p95 cpu ${(util.cpuP95 * 100).toFixed(0)}% / memory ${(util.memoryP95 * 100).toFixed(0)}%.`,
      });
      if (!ev) continue;
      const body = {
        kind: o.kind,
        title: o.label,
        changes: [o.change],
        addresses: [n.address],
        baseline: baselineInfo,
        savings: ev.savings,
        evidence: {
          utilization: {
            cpuP95: util.cpuP95,
            memoryP95: util.memoryP95,
            sampleDays: util.sampleDays,
            projectedCpu: q6(o.projCpu),
            projectedMemory: q6(o.projMem),
            ceiling: policy.downscaleCeiling,
            upscaleTrigger: policy.upscaleTrigger,
          },
          ownership: own.fields,
        },
        risks: [o.kind === "rightsize_replicas" ? "Fewer replicas lower failure tolerance and burst headroom." : "A smaller size lowers burst headroom; p95 was measured, peaks were not."],
      };
      candidates.push({ proposal: { id: proposalId(body, ev.savings.catalogVersion), ...body }, shiftUsd: ev.shiftUsd });
    }
  }

  /* ------------------------------- relocation ------------------------------ */

  const userRegions: UserRegion[] = [];
  for (const raw of input.constraints.userRegions ?? []) {
    const u = normalizeUserRegion(raw);
    if (u && !userRegions.includes(u)) userRegions.push(u);
  }
  const sites = new Map<string, CostNode[]>();
  for (const n of nodes) {
    const k = `${n.provider}|${n.region}`;
    sites.set(k, [...(sites.get(k) ?? []), n]);
  }
  const residency = input.constraints.residency && input.constraints.residency.length > 0 ? input.constraints.residency : undefined;
  const siteLatency = (graph: CostGraph, site: CostNode[], provider: string, region: string): number | undefined => {
    if (userRegions.length === 0) return undefined;
    const users = Math.max(...userRegions.map((u) => estimateP95Ms(userToRegionRttMs(u, provider, region))));
    const addrs = new Set(site.map((s) => s.address));
    const byAddr = new Map(graph.nodes.map((x) => [x.address, x]));
    let edgeMs = 0;
    for (const e of graph.edges ?? ([] as readonly CostEdge[])) {
      const a = byAddr.get(e.from);
      const b = byAddr.get(e.to);
      if (!a || !b || addrs.has(e.from) === addrs.has(e.to)) continue;
      if (a.provider === b.provider && a.region === b.region) continue;
      if (!regionInfo(a.provider, a.region) || !regionInfo(b.provider, b.region)) return undefined;
      edgeMs += regionToRegionRttMs(a, b);
    }
    return users + Math.round(edgeMs * 2);
  };

  if (input.routableOnly) skip("*", "relocate_site", "unsupported_path", "No typed operation moves a site between regions; relocation is not proposed.");
  for (const [siteKey, site] of input.routableOnly ? [] : [...sites.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    const [provider, region] = siteKey.split("|") as [string, string];
    const label = `${provider}/${region}`;
    const first = site[0]!.address;
    const kind: OptimizationKind = "relocate_site";
    if (site.some((n) => (n.ownership ?? "managed") !== "managed" || n.kind === "provider_native")) {
      skip(first, kind, "not_managed", `Site ${label} holds referenced, external or provider-native resources; it is not moved as a unit.`);
      continue;
    }
    const waits = site.map((n) => cooldownBlock(n.address)).filter((x): x is string => !!x);
    if (waits.length > 0) {
      skip(first, kind, "cooldown", waits[0]!);
      continue;
    }
    const here = regionInfo(provider, region);
    const beforeLatency = siteLatency(input.graph, site, provider, region);
    if (!here || beforeLatency === undefined) {
      skip(first, kind, "latency_unverifiable", `Latency for ${label} cannot be established (no user regions in the constraints, or a region missing from the latency table); relocation without a latency check is refused.`);
      continue;
    }
    for (const dest of book.regions(provider)) {
      if (dest === region) continue;
      const info = regionInfo(provider, dest);
      if (!info) continue;
      if (!regionSatisfiesResidency(info, residency)) {
        skip(first, kind, "residency", `${provider}/${dest} (${info.country}) does not satisfy the residency constraint [${(residency ?? []).join(", ")}].`);
        continue;
      }
      const needZones = Math.max(1, ...site.map((n) => (n.kind === "network" ? azCountOf(n) : 1)));
      if (info.zones < needZones) {
        skip(first, kind, "capacity", `${provider}/${dest} has ${info.zones} zone${info.zones === 1 ? "" : "s"}; the site needs ${needZones}.`);
        continue;
      }
      const moved: CostGraph = { ...input.graph, nodes: input.graph.nodes.map((n) => (n.provider === provider && n.region === region ? { ...n, region: dest } : n)) };
      const afterLatency = siteLatency(moved, site, provider, dest);
      if (afterLatency === undefined) {
        skip(first, kind, "latency_unverifiable", `Latency for ${provider}/${dest} cannot be established.`);
        continue;
      }
      if (input.constraints.latencyTargetMs !== undefined && afterLatency > input.constraints.latencyTargetMs) {
        skip(first, kind, "latency_target", `${provider}/${dest} gives p95 about ${afterLatency} ms, above the ${input.constraints.latencyTargetMs} ms target.`);
        continue;
      }
      if (afterLatency - beforeLatency > policy.maxLatencyRegressionMs) {
        skip(first, kind, "latency_regression", `${provider}/${dest} raises p95 from about ${beforeLatency} ms to ${afterLatency} ms; the regression limit is ${policy.maxLatencyRegressionMs} ms.`);
        continue;
      }
      const changes: ChangeSet[] = site.map((n) => ({ address: n.address, field: "region", from: region, to: dest }));
      const rev = changes.map(reversalBlock).find((x): x is string => !!x);
      if (rev) {
        skip(first, kind, "reversal_lockout", rev);
        continue;
      }
      const refs: FieldRef[] = site.flatMap((n) => [
        { address: n.address, field: "region" },
        { address: n.address, field: "provider" },
      ]);
      const own = await ownershipFor(ownership, refs);
      if (!own.ok) {
        skip(first, kind, "ownership_refused", own.message);
        continue;
      }
      // One-time data copy: stateful GB at the source's inter-region egress price.
      let dataGb = 0;
      for (const n of site) {
        const s = n.spec ?? {};
        const gb = typeof s.storageGb === "number" ? s.storageGb : n.kind === "postgres" || n.kind === "mysql" ? usage.dbStorageGb : n.kind === "object_store" ? usage.storageGb : 0;
        dataGb += gb;
      }
      const sku = skuFor(provider, "egress_inter_region_gb");
      const egress = sku ? book.find(provider, region, sku) : undefined;
      if (dataGb > 0 && !egress) {
        skip(first, kind, "price_unavailable", `No inter-region egress price for ${label}; the one-time data copy cannot be costed.`);
        continue;
      }
      const oneTime = egress ? dataGb * egress.usd : 0;
      const ev = evaluate(kind, first, moved, {
        oneTimeCostUsd: oneTime,
        excluded: ["Downtime or read-only window during the data copy", "Dual running of both sites while migrating", "Per-request charges of the copy and any tooling cost"],
        basis: `Move the ${site.length}-resource site ${label} to ${provider}/${dest}; catalog price difference at measured usage, with the changed cross-region egress included. One-time copy of ${dataGb} GB at the source inter-region egress price.`,
      });
      if (!ev) continue;
      const body = {
        kind,
        title: `Move ${label} to ${provider}/${dest}`,
        changes,
        addresses: site.map((n) => n.address),
        baseline: baselineInfo,
        savings: ev.savings,
        evidence: {
          latency: { beforeP95Ms: beforeLatency, afterP95Ms: afterLatency, ...(input.constraints.latencyTargetMs !== undefined ? { targetMs: input.constraints.latencyTargetMs } : {}), regressionMs: afterLatency - beforeLatency },
          ...(residency ? { residency: { required: residency, destination: `${provider}/${dest} (${info.country})` } } : {}),
          ownership: own.fields,
        },
        risks: ["Stateful data is copied between regions; verify restore points first.", "Latency estimates come from a coarse geography table, not measurements."],
      };
      candidates.push({ proposal: { id: proposalId(body, ev.savings.catalogVersion), ...body }, shiftUsd: ev.shiftUsd });
    }
  }

  /* ----------------------- window bounds and conflict pruning ---------------------- */

  const windowHistory = history.filter((h) => nowMs - ms(h.at) < policy.windowMs);
  let changesLeft = policy.maxChangesPerWindow - windowHistory.length;
  let shiftLeft = policy.maxWindowShiftPct * baseline.monthlyUsd - windowHistory.reduce((s, h) => s + (h.monthlyUsdShift ?? 0), 0);
  const taken = new Set<string>();
  const ordered = candidates.sort((a, b) => b.proposal.savings.monthlyUsd - a.proposal.savings.monthlyUsd || cmp(a.proposal.id, b.proposal.id));
  for (const c of ordered) {
    const p = c.proposal;
    const first = p.addresses[0]!;
    if (p.addresses.some((a) => taken.has(a))) {
      skip(first, p.kind, "conflict", `${p.title} touches a resource already changed by a better proposal in this run.`);
      continue;
    }
    if (changesLeft <= 0) {
      skip(first, p.kind, "window_change_limit", `${p.title}: this window already holds ${policy.maxChangesPerWindow} changes (limit per ${(policy.windowMs / 86_400_000).toFixed(1)} days).`);
      continue;
    }
    if (c.shiftUsd > shiftLeft) {
      skip(first, p.kind, "window_shift_limit", `${p.title}: a $${c.shiftUsd.toFixed(2)}/month shift exceeds the $${Math.max(0, shiftLeft).toFixed(2)} left of the ${(policy.maxWindowShiftPct * 100).toFixed(0)}% per-window bound.`);
      continue;
    }
    changesLeft -= 1;
    shiftLeft -= c.shiftUsd;
    for (const a of p.addresses) taken.add(a);
    result.proposals.push(p);
  }
  return result;
}

function proposalId(body: Omit<OptimizationProposal, "id">, catalogVersion: string): string {
  return `opt_${digest({ kind: body.kind, changes: body.changes, catalogVersion }).slice(0, 32)}`;
}
