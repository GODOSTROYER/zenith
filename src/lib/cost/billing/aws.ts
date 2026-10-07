/**
 * AWS actual spend through Cost Explorer `GetCostAndUsage` (UnblendedCost,
 * grouped by SERVICE, filtered to one linked account). Cost Explorer is a
 * global API served from us-east-1.
 *
 * `signAwsV4` is a standalone Signature Version 4 signer used by the gated live
 * path; the adapter itself only builds and parses.
 */
import { createHmac } from "node:crypto";
import { sha256Hex } from "@/lib/controlplane/digest";
import { newActualSpend } from "@/lib/cost/kinds";
import { BillingError, type BillingAdapter, type ProviderHttpRequest, type RequestAuthorizer } from "@/lib/cost/billing/types";
import { requireUsd, usd } from "@/lib/cost/billing/reader";

export const AWS_COST_EXPLORER_ENDPOINT = "https://ce.us-east-1.amazonaws.com/";
const ACCOUNT_ID = /^\d{12}$/;

export const awsCostExplorerAdapter: BillingAdapter = {
  provider: "aws",
  adapter: "aws-cost-explorer",
  validate(query) {
    if (!ACCOUNT_ID.test(query.scope)) throw new BillingError("invalid_query", "An AWS billing scope is a 12-digit account id.");
  },
  buildRequest(query) {
    return {
      method: "POST",
      url: AWS_COST_EXPLORER_ENDPOINT,
      headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AWSInsightsIndexService.GetCostAndUsage" },
      body: JSON.stringify({
        TimePeriod: { Start: query.periodStart, End: query.periodEnd },
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost"],
        GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
        Filter: { Dimensions: { Key: "LINKED_ACCOUNT", Values: [query.scope] } },
      }),
    };
  },
  parse(body, query, meta) {
    let json: { ResultsByTime?: unknown; NextPageToken?: unknown };
    try {
      json = JSON.parse(body) as typeof json;
    } catch {
      throw new BillingError("malformed_response", "The Cost Explorer response is not JSON.");
    }
    if (json.NextPageToken) throw new BillingError("incomplete_response", "Cost Explorer returned a further page; paginated results are not supported, so the total would be incomplete.");
    if (!Array.isArray(json.ResultsByTime)) throw new BillingError("malformed_response", "The Cost Explorer response has no ResultsByTime.");
    const byService = new Map<string, number>();
    let estimated = false;
    for (const period of json.ResultsByTime as { Estimated?: boolean; Groups?: unknown }[]) {
      if (period.Estimated !== false) estimated = true;
      if (!Array.isArray(period.Groups)) throw new BillingError("malformed_response", "A Cost Explorer period has no Groups.");
      for (const g of period.Groups as { Keys?: unknown; Metrics?: { UnblendedCost?: { Amount?: unknown; Unit?: unknown } } }[]) {
        const key = Array.isArray(g.Keys) && typeof g.Keys[0] === "string" ? g.Keys[0] : undefined;
        const metric = g.Metrics?.UnblendedCost;
        if (!key || !metric) throw new BillingError("malformed_response", "A Cost Explorer group is missing its service or cost.");
        requireUsd(metric.Unit);
        byService.set(key, (byService.get(key) ?? 0) + usd(metric.Amount, "A Cost Explorer amount"));
      }
    }
    const lines = [...byService.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([service, amount]) => ({ service, usd: round6(amount) }));
    return newActualSpend({
      provider: "aws",
      scope: query.scope,
      periodStart: query.periodStart,
      periodEnd: query.periodEnd,
      totalUsd: round6(lines.reduce((s, l) => s + l.usd, 0)),
      lines,
      costBasis: "AWS unblended cost (before credits and refunds are netted out, not amortized)",
      finalization: meta.closed && !estimated ? "final" : "provisional",
      source: { adapter: meta.adapter, endpoint: meta.endpoint, retrievedAt: meta.retrievedAt, responseSha256: meta.responseSha256 },
    });
  },
};

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6 || 0;
}

/* --------------------------------- SigV4 ---------------------------------- */

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

/** Returns a copy of `request` with `host`, `x-amz-date` and `authorization` (and the session token) added. */
export function signAwsV4(request: ProviderHttpRequest, creds: AwsCredentials, opts: { region: string; service: string; now: Date }): ProviderHttpRequest {
  const url = new URL(request.url);
  const amzDate = opts.now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(request.headers)) headers[k.toLowerCase()] = v;
  headers.host = url.host;
  headers["x-amz-date"] = amzDate;
  if (creds.sessionToken) headers["x-amz-security-token"] = creds.sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim().replace(/\s+/g, " ")}\n`).join("");
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = [request.method, url.pathname || "/", query, canonicalHeaders, names.join(";"), sha256Hex(request.body ?? "")].join("\n");
  const scope = `${day}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, day), opts.region), opts.service), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  return { ...request, headers };
}

export function awsAuthorizer(creds: AwsCredentials, now: () => Date): RequestAuthorizer {
  return {
    async authorize(request) {
      return signAwsV4(request, creds, { region: "us-east-1", service: "ce", now: now() });
    },
  };
}
