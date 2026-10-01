/**
 * The default `CostPort`: the placement cost engine (ADR-0013) over the default
 * price catalog. An ESTIMATE of monthly USD list price, never an invoice.
 *
 * A graph the catalog cannot price (an unknown provider or region, a missing
 * SKU, a spec value of the wrong type) yields `null`: "no estimate", which the
 * activities carry as an absent cost delta rather than a zero.
 */
import { CostInputError, estimateGraphCost } from "@/lib/placement/cost";
import { loadDefaultCatalog, MissingPriceError } from "@/lib/placement/pricebook";
import type { PriceCatalog } from "@/lib/placement/types";
import type { CostPort } from "./ports";

export function defaultCostPort(catalog?: PriceCatalog): CostPort {
  let loaded = catalog;
  return {
    async estimate(graph) {
      loaded ??= loadDefaultCatalog();
      try {
        const estimate = estimateGraphCost(graph, { catalog: loaded });
        return { monthlyUsd: estimate.monthlyUsd, catalogVersion: estimate.catalogVersion };
      } catch (err) {
        if (err instanceof MissingPriceError || err instanceof CostInputError) return null;
        throw err;
      }
    },
  };
}
