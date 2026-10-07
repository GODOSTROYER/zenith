/**
 * GCP actual spend from the customer's Cloud Billing export table in BigQuery
 * (`gcp_billing_export_v1_*`), read with `jobs.query`. Google has no
 * direct "spend so far" API; the export table is the supported source, so the
 * scope is the table: `<project>.<dataset>.<table>`.
 *
 * The total is `cost` BEFORE credits. Dates are bound as query parameters; the
 * table name cannot be, so it is validated against a strict pattern.
 */
import { newActualSpend } from "@/lib/cost/kinds";
import { BillingError, type BillingAdapter } from "@/lib/cost/billing/types";
import { requireUsd, usd } from "@/lib/cost/billing/reader";

const SCOPE = /^([a-z][a-z0-9-]{4,28}[a-z0-9])\.([A-Za-z0-9_]{1,128})\.([A-Za-z0-9_]{1,256})$/;

export function parseGcpScope(scope: string): { project: string; dataset: string; table: string } {
  const m = SCOPE.exec(scope);
  if (!m) throw new BillingError("invalid_query", "A GCP billing scope is <project>.<dataset>.<table> of the Cloud Billing export.");
  return { project: m[1]!, dataset: m[2]!, table: m[3]! };
}

export const gcpBigQueryAdapter: BillingAdapter = {
  provider: "gcp",
  adapter: "gcp-bigquery-billing-export",
  validate(query) {
    parseGcpScope(query.scope);
  },
  buildRequest(query) {
    const { project, dataset, table } = parseGcpScope(query.scope);
    const sql =
      `SELECT service.description AS service, SUM(cost) AS cost, currency FROM \`${project}.${dataset}.${table}\` ` +
      "WHERE usage_start_time >= TIMESTAMP(@start) AND usage_start_time < TIMESTAMP(@end) GROUP BY service, currency ORDER BY service";
    const date = (name: string, value: string) => ({ name, parameterType: { type: "DATE" }, parameterValue: { value } });
    return {
      method: "POST",
      url: `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(project)}/queries`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: sql,
        useLegacySql: false,
        parameterMode: "NAMED",
        queryParameters: [date("start", query.periodStart), date("end", query.periodEnd)],
        maxResults: 10000,
        timeoutMs: 30000,
      }),
    };
  },
  parse(body, query, meta) {
    let json: { jobComplete?: unknown; pageToken?: unknown; schema?: { fields?: { name?: string }[] }; rows?: { f?: { v?: unknown }[] }[] };
    try {
      json = JSON.parse(body) as typeof json;
    } catch {
      throw new BillingError("malformed_response", "The BigQuery response is not JSON.");
    }
    if (json.jobComplete !== true) throw new BillingError("incomplete_response", "The BigQuery job had not completed; no total can be reported.");
    if (json.pageToken) throw new BillingError("incomplete_response", "BigQuery returned a further page; the total would be incomplete.");
    const names = (json.schema?.fields ?? []).map((f) => f.name);
    const iService = names.indexOf("service");
    const iCost = names.indexOf("cost");
    const iCurrency = names.indexOf("currency");
    if (iService < 0 || iCost < 0 || iCurrency < 0) throw new BillingError("malformed_response", "The BigQuery schema lacks service, cost or currency.");
    const rows = json.rows ?? [];
    const lines = rows.map((r) => {
      const f = r.f ?? [];
      requireUsd(f[iCurrency]?.v);
      const service = f[iService]?.v;
      return { service: typeof service === "string" ? service : "(no service)", usd: usd(f[iCost]?.v, "A BigQuery cost") };
    });
    return newActualSpend({
      provider: "gcp",
      scope: query.scope,
      periodStart: query.periodStart,
      periodEnd: query.periodEnd,
      totalUsd: Math.round(lines.reduce((s, l) => s + l.usd, 0) * 1e6) / 1e6,
      lines,
      costBasis: "Cloud Billing export cost before credits (usage_start_time within the period, UTC)",
      finalization: meta.closed ? "final" : "provisional",
      source: { adapter: meta.adapter, endpoint: meta.endpoint, retrievedAt: meta.retrievedAt, responseSha256: meta.responseSha256 },
    });
  },
};
