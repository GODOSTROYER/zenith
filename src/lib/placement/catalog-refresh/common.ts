/**
 * Helpers shared by the provider normalizers: tier building and ambiguity
 * resolution. The rule everywhere is the catalog's own: never guess. A target
 * that matches nothing, or matches several different prices with no stated
 * tie-break, is reported as skipped and the old catalog value stays.
 */
import type { PriceTier } from "@/lib/placement/types";

export interface Dimension {
  /** cumulative GB at which this price starts (provider tier begin, free allowance included) */
  from: number;
  usd: number;
}

export interface Priced {
  usd: number;
  tiers?: PriceTier[];
}

/**
 * Ordered provider dimensions -> the catalog's first-paid-tier price plus marginal volume tiers.
 * Free allowances are not encoded: the first PAID price starts at 0 GB (conservative, matching
 * the engine's "free tiers are not deducted" rule) and later tiers keep the provider's
 * cumulative boundaries. Returns undefined when prices rise with volume (not a discount
 * schedule) or no dimension has a positive price.
 */
export function buildTiered(dimensions: readonly Dimension[]): Priced | undefined {
  const sorted = [...dimensions].filter((d) => Number.isFinite(d.usd) && d.usd >= 0 && Number.isFinite(d.from) && d.from >= 0).sort((a, b) => a.from - b.from);
  const firstPaid = sorted.findIndex((d) => d.usd > 0);
  if (firstPaid < 0) return undefined;
  const paid = sorted.slice(firstPaid);
  const tiers: PriceTier[] = [{ fromGb: 0, usd: paid[0]!.usd }];
  for (const d of paid.slice(1)) {
    const last = tiers[tiers.length - 1]!;
    if (d.usd > last.usd) return undefined;
    if (d.usd < last.usd) tiers.push({ fromGb: d.from, usd: d.usd });
  }
  return tiers.length >= 2 ? { usd: tiers[0]!.usd, tiers } : { usd: tiers[0]!.usd };
}

export function samePriced(a: Priced, b: Priced): boolean {
  return a.usd === b.usd && JSON.stringify(a.tiers ?? null) === JSON.stringify(b.tiers ?? null);
}

export type Resolution = { ok: true; priced: Priced } | { ok: false; reason: string };

/**
 * One value from several candidate matches. `single`: all candidates must agree.
 * `mode`: the most frequent price wins and the higher price breaks ties (a
 * deliberately conservative choice for destination-dependent transfer rates).
 */
export function resolveCandidates(candidates: readonly Priced[], how: "single" | "mode"): Resolution {
  if (candidates.length === 0) return { ok: false, reason: "no matching price in the file" };
  const groups: { priced: Priced; n: number }[] = [];
  for (const c of candidates) {
    const g = groups.find((x) => samePriced(x.priced, c));
    if (g) g.n += 1;
    else groups.push({ priced: c, n: 1 });
  }
  if (groups.length === 1) return { ok: true, priced: groups[0]!.priced };
  if (how === "single") return { ok: false, reason: `ambiguous: ${candidates.length} matching products carry ${groups.length} different prices` };
  groups.sort((a, b) => b.n - a.n || b.priced.usd - a.priced.usd);
  return { ok: true, priced: groups[0]!.priced };
}

export function toNumber(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}
