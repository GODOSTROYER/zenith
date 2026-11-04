/**
 * Azure actual spend through the Cost Management Query API (`ActualCost`,
 * grouped by ServiceName) for one subscription. The scope is the ARM path
 * `/subscriptions/<guid>`.
 */
import { addDays } from "@/lib/cost/billing/dates";
import { newActualSpend } from "@/lib/cost/kinds";
import { BillingError, type BillingAdapter } from "@/lib/cost/billing/types";
import { requireUsd, usd } from "@/lib/cost/billing/reader";

const SCOPE = /^\/subscriptions\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const azureCostManagementAdapter: BillingAdapter = {
  provider: "azure",
  adapter: "azure-cost-management-query",
  validate(query) {
    if (!SCOPE.test(query.scope)) throw new BillingError("invalid_query", "An Azure billing scope is /subscriptions/<subscription-guid>.");
  },
  buildRequest(query) {
    return {
      method: "POST",
      url: `https://management.azure.com${query.scope}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "ActualCost",
        timeframe: "Custom",
        // The API treats `to` as inclusive; the period end here is exclusive.
        timePeriod: { from: `${query.periodStart}T00:00:00Z`, to: `${addDays(query.periodEnd, -1)}T23:59:59Z` },
        dataset: {
          granularity: "None",
          aggregation: { totalCost: { name: "Cost", function: "Sum" } },
          grouping: [{ type: "Dimension", name: "ServiceName" }],
        },
      }),
    };
  },
  parse(body, query, meta) {
    let json: { properties?: { nextLink?: unknown; columns?: { name?: string }[]; rows?: unknown[][] } };
    try {
      json = JSON.parse(body) as typeof json;
    } catch {
      throw new BillingError("malformed_response", "The Cost Management response is not JSON.");
    }
    const props = json.properties;
    if (!props || !Array.isArray(props.columns) || !Array.isArray(props.rows)) throw new BillingError("malformed_response", "The Cost Management response has no columns or rows.");
    if (props.nextLink) throw new BillingError("incomplete_response", "Cost Management returned a further page; the total would be incomplete.");
    const names = props.columns.map((c) => c.name);
    const iCost = names.indexOf("Cost");
    const iService = names.indexOf("ServiceName");
    const iCurrency = names.indexOf("Currency");
    if (iCost < 0 || iService < 0 || iCurrency < 0) throw new BillingError("malformed_response", "The Cost Management columns lack Cost, ServiceName or Currency.");
    const lines = props.rows.map((row) => {
      requireUsd(row[iCurrency]);
      const service = row[iService];
      return { service: typeof service === "string" ? service : "(no service)", usd: usd(row[iCost], "An Azure cost") };
    });
    return newActualSpend({
      provider: "azure",
      scope: query.scope,
      periodStart: query.periodStart,
      periodEnd: query.periodEnd,
      totalUsd: Math.round(lines.reduce((s, l) => s + l.usd, 0) * 1e6) / 1e6,
      lines,
      costBasis: "Azure ActualCost in the billing currency (USD only), not amortized",
      finalization: meta.closed ? "final" : "provisional",
      source: { adapter: meta.adapter, endpoint: meta.endpoint, retrievedAt: meta.retrievedAt, responseSha256: meta.responseSha256 },
    });
  },
};
