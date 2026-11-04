/**
 * Cost estimation shared by `zenith_estimate_cost` and the propose tools.
 *
 * Pure: the price catalog is a static snapshot (`placement/catalog`) and
 * `estimateGraphCost` does no I/O. What comes back is always an ESTIMATE of
 * list prices — the catalog version, inclusions, exclusions and assumptions
 * travel with the number, and a graph that cannot be priced (a region the
 * catalog does not cover) is reported as such rather than priced at zero.
 */
import { CostInputError, estimateGraphCost, MissingPriceError, loadDefaultCatalog, type CostEstimate } from "@/lib/placement";
import type { ResourceGraph } from "@/lib/resources/types";

export type EstimateResult = { ok: true; estimate: CostEstimate } | { ok: false; reason: string };

export function tryEstimate(graph: ResourceGraph): EstimateResult {
  try {
    return { ok: true, estimate: estimateGraphCost(graph, { catalog: loadDefaultCatalog() }) };
  } catch (error) {
    if (error instanceof MissingPriceError) return { ok: false, reason: `The price catalog has no price for ${error.sku.slice(0, 80)} in ${error.provider.slice(0, 32)}/${error.region.slice(0, 32)}.` };
    if (error instanceof CostInputError) return { ok: false, reason: "The graph could not be priced: an input to the cost model was invalid." };
    throw error;
  }
}

/** The small, stable summary that goes into a proposal's input (digest-bound). */
export function estimateSummary(result: EstimateResult): Record<string, unknown> {
  return result.ok
    ? { isEstimate: true, monthlyUsd: result.estimate.monthlyUsd, currency: result.estimate.currency, catalogVersion: result.estimate.catalogVersion }
    : { isEstimate: true, unavailable: result.reason };
}
