/**
 * Mixed-cloud economics report (PROD-MIX-07): what a mixed placement costs INCLUDING the data that crosses
 * clouds, how far apart its partitions are, and whether every partition sits in an allowed jurisdiction.
 *
 * It composes the existing engines instead of pricing anything itself:
 *  - `estimateGraphCost` (COST-01/02 catalog and cost model) for the whole graph;
 *  - `listCrossBoundaryTransfers` for each cross-region / cross-cloud data-plane edge and its monthly USD;
 *  - `regionToRegionRttMs` / `estimateP95Ms` (static, approximate latency tables) per cross-partition edge;
 *  - `regionInfo` / `regionSatisfiesResidency` for residency.
 *
 * Honest limits, repeated in the report: every figure is a list-price ESTIMATE (never an invoice or a cap),
 * the latency numbers are approximate tables and not measurements, and residency tags are a matching
 * convenience, not legal advice. A graph the catalog cannot price returns `priced: false` with the reason;
 * it is never reported as zero.
 */
import { CostInputError, estimateGraphCost, listCrossBoundaryTransfers, type CostGraph, type CostOptions, type TransferCost } from "@/lib/placement/cost";
import { estimateP95Ms, regionInfo, regionSatisfiesResidency, regionToRegionRttMs } from "@/lib/placement/latency";
import { MissingPriceError } from "@/lib/placement/pricebook";
import type { CostUsage, PriceCatalog } from "@/lib/placement/types";

export interface MixedEconomicsInput {
  graph: CostGraph;
  catalog: PriceCatalog;
  usage?: CostUsage;
  /** residency tokens every partition must satisfy ("eu", "us", "india"); empty means unconstrained */
  residency?: readonly string[];
  /** a latency budget (ms, median RTT) a cross-partition edge is compared with; informational */
  latencyBudgetMs?: number;
  now?: string;
}

export interface EdgeLatency {
  from: string;
  to: string;
  fromPlacement: string;
  toPlacement: string;
  rttMs: number;
  p95Ms: number;
  withinBudget?: boolean;
}

export interface ResidencyViolation { address: string; provider: string; region: string; reason: "region_outside_residency" | "region_unknown" }

export type MixedEconomicsReport =
  | {
    kind: "mixed_economics";
    priced: true;
    /** this is an estimate and never a billing cap */
    notABillingCap: true;
    catalogVersion: string;
    computedAt: string;
    currency: "USD";
    monthlyUsd: number;
    byProvider: Record<string, number>;
    transfers: TransferCost[];
    /** the part of `monthlyUsd` that is cross-region or cross-cloud data movement */
    transferUsd: number;
    transferShare: number;
    latency: EdgeLatency[];
    residency: { required: string[]; violations: ResidencyViolation[]; satisfied: boolean };
    assumptions: Record<string, number | string>;
    excluded: string[];
    notes: string[];
  }
  | { kind: "mixed_economics"; priced: false; notABillingCap: true; reason: string; residency: { required: string[]; violations: ResidencyViolation[]; satisfied: boolean }; notes: string[] };

const NOTES: readonly string[] = [
  "Every dollar figure is a list-price estimate from a dated catalog; it is not an invoice and not a billing cap.",
  "Latency is an approximate table of broad geographies, not a measurement from your network; do not use it as an SLO.",
  "Residency tags match on country and grouping names; they are a convenience, not legal advice about where data may live.",
  "Transfer volume is an assumption (egress GB times the inter-component fraction), not metered traffic.",
];

function placementOf(provider: string, region: string): string { return `${provider}/${region}`; }

export function residencyReport(graph: CostGraph, residency: readonly string[] | undefined): { required: string[]; violations: ResidencyViolation[]; satisfied: boolean } {
  const required = [...(residency ?? [])];
  const violations: ResidencyViolation[] = [];
  if (required.length) {
    for (const node of graph.nodes) {
      if ((node.ownership ?? "managed") !== "managed") continue;
      const info = regionInfo(node.provider, node.region);
      if (!info) violations.push({ address: node.address, provider: node.provider, region: node.region, reason: "region_unknown" });
      else if (!regionSatisfiesResidency(info, required)) violations.push({ address: node.address, provider: node.provider, region: node.region, reason: "region_outside_residency" });
    }
  }
  return { required, violations: violations.sort((a, b) => (a.address < b.address ? -1 : 1)), satisfied: violations.length === 0 };
}

/** Cross-partition edges are the graph edges whose ends differ in provider or region. */
export function edgeLatencies(graph: CostGraph, latencyBudgetMs?: number): EdgeLatency[] {
  const byAddress = new Map(graph.nodes.map((n) => [n.address, n]));
  const out: EdgeLatency[] = [];
  const seen = new Set<string>();
  for (const edge of graph.edges ?? []) {
    const a = byAddress.get(edge.from);
    const b = byAddress.get(edge.to);
    if (!a || !b || (a.provider === b.provider && a.region === b.region)) continue;
    const key = `${edge.from}\u0000${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!regionInfo(a.provider, a.region) || !regionInfo(b.provider, b.region)) continue;
    const rttMs = regionToRegionRttMs({ provider: a.provider, region: a.region }, { provider: b.provider, region: b.region });
    out.push({
      from: edge.from, to: edge.to, fromPlacement: placementOf(a.provider, a.region), toPlacement: placementOf(b.provider, b.region), rttMs, p95Ms: estimateP95Ms(rttMs),
      ...(latencyBudgetMs !== undefined ? { withinBudget: rttMs <= latencyBudgetMs } : {}),
    });
  }
  return out.sort((x, y) => (x.from + x.to < y.from + y.to ? -1 : 1));
}

export function mixedEconomics(input: MixedEconomicsInput): MixedEconomicsReport {
  const residency = residencyReport(input.graph, input.residency);
  const options: CostOptions = { catalog: input.catalog, ...(input.usage ? { usage: input.usage } : {}), ...(input.now ? { now: input.now } : {}) };
  let estimate;
  try {
    estimate = estimateGraphCost(input.graph, options);
  } catch (error) {
    if (error instanceof MissingPriceError || error instanceof CostInputError) {
      return { kind: "mixed_economics", priced: false, notABillingCap: true, reason: error.message.slice(0, 300), residency, notes: [...NOTES, "The graph could not be priced, so no total is shown; an unpriced graph is never presented as free."] };
    }
    throw error;
  }
  const transfers = listCrossBoundaryTransfers(input.graph, options);
  const providerOf = new Map(input.graph.nodes.map((n) => [n.address, n.provider]));
  const byProvider: Record<string, number> = {};
  for (const line of estimate.lines) {
    const provider = (line.address && providerOf.get(line.address)) || "shared";
    byProvider[provider] = Math.round(((byProvider[provider] ?? 0) + line.monthlyUsd) * 100) / 100;
  }
  const transferUsd = Math.round(transfers.reduce((sum, t) => sum + t.usd, 0) * 100) / 100;
  return {
    kind: "mixed_economics", priced: true, notABillingCap: true, catalogVersion: estimate.catalogVersion, computedAt: estimate.computedAt, currency: "USD", monthlyUsd: estimate.monthlyUsd,
    byProvider, transfers, transferUsd, transferShare: estimate.monthlyUsd > 0 ? Math.round((transferUsd / estimate.monthlyUsd) * 1000) / 1000 : 0,
    latency: edgeLatencies(input.graph, input.latencyBudgetMs), residency, assumptions: estimate.assumptions, excluded: estimate.excluded, notes: [...NOTES],
  };
}

/** Plain-text rendering for the cost report script and the runbook. Never calls an estimate a cap. */
export function renderEconomics(report: MixedEconomicsReport): string {
  const lines: string[] = ["Mixed-cloud cost report (ESTIMATE, not an invoice and not a billing cap)"];
  if (!report.priced) {
    lines.push(`Not priced: ${report.reason}`);
  } else {
    lines.push(`Catalog ${report.catalogVersion}, computed ${report.computedAt}`, `Monthly total: $${report.monthlyUsd.toFixed(2)} (cross-cloud/cross-region transfer: $${report.transferUsd.toFixed(2)}, ${(report.transferShare * 100).toFixed(1)}%)`);
    for (const [provider, usd] of Object.entries(report.byProvider).sort()) lines.push(`  ${provider}: $${usd.toFixed(2)}`);
    for (const t of report.transfers) lines.push(`  transfer ${t.from} -> ${t.to} (${t.kind}): ${t.gb} GB, $${t.usd.toFixed(2)}`);
    for (const l of report.latency) lines.push(`  latency ${l.from} <-> ${l.to} (${l.fromPlacement} / ${l.toPlacement}): ~${l.rttMs} ms median, ~${l.p95Ms} ms p95 (approximate table)${l.withinBudget === undefined ? "" : l.withinBudget ? ", within budget" : ", OVER budget"}`);
  }
  lines.push(report.residency.required.length ? `Residency [${report.residency.required.join(", ")}]: ${report.residency.satisfied ? "satisfied" : `VIOLATED by ${report.residency.violations.map((v) => `${v.address} (${v.provider}/${v.region})`).join(", ")}`}` : "Residency: no constraint given");
  for (const note of report.notes) lines.push(`Note: ${note}`);
  return lines.join("\n");
}
