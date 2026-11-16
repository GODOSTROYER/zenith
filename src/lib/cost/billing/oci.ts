/**
 * OCI actual spend through the Usage API (`RequestSummarizedUsages`,
 * `queryType: COST`, grouped by service) for one tenancy. The scope is the
 * tenancy OCID. The Usage API aggregates MONTHLY only on month boundaries, so
 * the period must be whole months (first day to first day).
 *
 * `ociAuthorizer` signs requests with the draft-cavage HTTP signature scheme
 * OCI requires, using an RSA private key from the gated credentials file.
 */
import { createHash, createSign } from "node:crypto";
import { newActualSpend } from "@/lib/cost/kinds";
import { BillingError, type BillingAdapter, type ProviderHttpRequest, type RequestAuthorizer } from "@/lib/cost/billing/types";
import { requireUsd, usd } from "@/lib/cost/billing/reader";

const TENANCY = /^ocid1\.tenancy\.[a-z0-9]+\.[a-z0-9-]*\.[a-z0-9]{10,100}$/;
const REGION = /^[a-z]{2}-[a-z]+-\d$/;

export interface OciAdapterConfig {
  /** region whose Usage API endpoint is called, for example `us-ashburn-1` */
  region: string;
}

export function ociUsageAdapter(config: OciAdapterConfig): BillingAdapter {
  if (!REGION.test(config.region)) throw new BillingError("invalid_query", "The OCI region is invalid.");
  return {
    provider: "oci",
    adapter: "oci-usage-api",
    validate(query) {
      if (!TENANCY.test(query.scope)) throw new BillingError("invalid_query", "An OCI billing scope is a tenancy OCID.");
      if (!query.periodStart.endsWith("-01") || !query.periodEnd.endsWith("-01")) {
        throw new BillingError("invalid_query", "The OCI Usage API monthly query needs a period that starts and ends on the first of a month.");
      }
    },
    buildRequest(query) {
      return {
        method: "POST",
        url: `https://usageapi.${config.region}.oci.oraclecloud.com/20200107/usage`,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenantId: query.scope,
          timeUsageStarted: `${query.periodStart}T00:00:00.000Z`,
          timeUsageEnded: `${query.periodEnd}T00:00:00.000Z`,
          granularity: "MONTHLY",
          queryType: "COST",
          groupBy: ["service"],
        }),
      };
    },
    parse(body, query, meta) {
      if (meta.headers["opc-next-page"]) throw new BillingError("incomplete_response", "The Usage API returned a further page; the total would be incomplete.");
      let json: { items?: { service?: unknown; computedAmount?: unknown; currency?: unknown }[] };
      try {
        json = JSON.parse(body) as typeof json;
      } catch {
        throw new BillingError("malformed_response", "The Usage API response is not JSON.");
      }
      if (!Array.isArray(json.items)) throw new BillingError("malformed_response", "The Usage API response has no items.");
      const byService = new Map<string, number>();
      for (const item of json.items) {
        requireUsd(item.currency);
        const service = typeof item.service === "string" ? item.service : "(no service)";
        byService.set(service, (byService.get(service) ?? 0) + usd(item.computedAmount, "An OCI computed amount"));
      }
      const lines = [...byService.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([service, amount]) => ({ service, usd: Math.round(amount * 1e6) / 1e6 }));
      return newActualSpend({
        provider: "oci",
        scope: query.scope,
        periodStart: query.periodStart,
        periodEnd: query.periodEnd,
        totalUsd: Math.round(lines.reduce((s, l) => s + l.usd, 0) * 1e6) / 1e6,
        lines,
        costBasis: "OCI computed cost amount in USD, monthly aggregation",
        finalization: meta.closed ? "final" : "provisional",
        source: { adapter: meta.adapter, endpoint: meta.endpoint, retrievedAt: meta.retrievedAt, responseSha256: meta.responseSha256 },
      });
    },
  };
}

export interface OciCredentials {
  tenancyOcid: string;
  userOcid: string;
  fingerprint: string;
  privateKeyPem: string;
}

/** Signs a request per OCI's HTTP signature scheme (rsa-sha256 over the request target and selected headers). */
export function signOciRequest(request: ProviderHttpRequest, creds: OciCredentials, now: Date): ProviderHttpRequest {
  const url = new URL(request.url);
  const body = request.body ?? "";
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(request.headers)) headers[k.toLowerCase()] = v;
  headers.host = url.host;
  headers.date = now.toUTCString();
  headers["x-content-sha256"] = createHash("sha256").update(body).digest("base64");
  headers["content-length"] = String(Buffer.byteLength(body));
  const names = ["date", "(request-target)", "host", "x-content-sha256", "content-type", "content-length"];
  const lines = names.map((n) => (n === "(request-target)" ? `(request-target): ${request.method.toLowerCase()} ${url.pathname}${url.search}` : `${n}: ${headers[n]}`));
  const signature = createSign("RSA-SHA256").update(lines.join("\n")).sign(creds.privateKeyPem, "base64");
  headers.authorization =
    `Signature version="1",keyId="${creds.tenancyOcid}/${creds.userOcid}/${creds.fingerprint}",algorithm="rsa-sha256",` +
    `headers="${names.join(" ")}",signature="${signature}"`;
  return { ...request, headers };
}

export function ociAuthorizer(creds: OciCredentials, now: () => Date): RequestAuthorizer {
  return {
    async authorize(request) {
      return signOciRequest(request, creds, now());
    },
  };
}
