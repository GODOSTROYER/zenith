/**
 * The ONLY path that can reach a real provider billing API, and it is gated:
 * `createLiveBillingReader` refuses (`BillingError("gate_closed")`) unless
 * `ZENITH_LIVE_<PROVIDER>=1` and `ZENITH_LIVE_<PROVIDER>_BILLING_CREDENTIALS_FILE`
 * name a readable JSON file (see `gate.ts`). Credentials come from that file
 * only; they are parsed into an authorizer and are never returned, logged or
 * placed in an error message.
 *
 * Credentials file shapes (JSON):
 *   aws:   { accessKeyId, secretAccessKey, sessionToken? }
 *   gcp:   { accessToken }                 (OAuth bearer with BigQuery read access)
 *   azure: { accessToken }                 (OAuth bearer with Cost Management Reader)
 *   oci:   { tenancyOcid, userOcid, fingerprint, privateKeyPem, region }
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { BillingProvider } from "@/lib/cost/kinds";
import { awsAuthorizer, awsCostExplorerAdapter } from "@/lib/cost/billing/aws";
import { azureCostManagementAdapter } from "@/lib/cost/billing/azure";
import { billingGate, type EnvLike } from "@/lib/cost/billing/gate";
import { gcpBigQueryAdapter } from "@/lib/cost/billing/gcp";
import { ociAuthorizer, ociUsageAdapter } from "@/lib/cost/billing/oci";
import { createActualSpendReader } from "@/lib/cost/billing/reader";
import { BillingError, type ActualSpendReader, type BillingAdapter, type BillingTransport, type ProviderHttpRequest, type RequestAuthorizer } from "@/lib/cost/billing/types";

const HOSTS: Record<BillingProvider, RegExp> = {
  aws: /^ce\.[a-z0-9-]+\.amazonaws\.com$/,
  gcp: /^bigquery\.googleapis\.com$/,
  azure: /^management\.azure\.com$/,
  oci: /^usageapi\.[a-z0-9-]+\.oci\.oraclecloud\.com$/,
};

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

const AwsFile = z.object({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1), sessionToken: z.string().min(1).optional() }).strict();
const BearerFile = z.object({ accessToken: z.string().min(1) }).strict();
const OciFile = z
  .object({ tenancyOcid: z.string().min(1), userOcid: z.string().min(1), fingerprint: z.string().min(1), privateKeyPem: z.string().min(1), region: z.string().min(1) })
  .strict();

export interface LiveDeps {
  env: EnvLike;
  readFile?: (path: string) => Promise<string>;
  fetch?: typeof fetch;
  now?: () => Date;
}

function bearer(token: string): RequestAuthorizer {
  return { async authorize(request: ProviderHttpRequest) { return { ...request, headers: { ...request.headers, authorization: `Bearer ${token}` } }; } };
}

function fetchTransport(provider: BillingProvider, fetchImpl: typeof fetch): BillingTransport {
  return {
    async send(request) {
      const url = new URL(request.url);
      if (url.protocol !== "https:" || !HOSTS[provider].test(url.hostname)) throw new BillingError("invalid_query", "The billing request host is not an allowed provider endpoint.");
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body !== undefined ? { body: request.body } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new BillingError("incomplete_response", "The billing response was too large to read safely.");
      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      return { status: response.status, body: text, headers };
    },
  };
}

/** Throws `BillingError("gate_closed")` when the operator has not opted in; never calls the network in that case. */
export async function createLiveBillingReader(provider: BillingProvider, deps: LiveDeps): Promise<ActualSpendReader> {
  const gate = billingGate(provider, deps.env);
  if (!gate.open) throw new BillingError("gate_closed", gate.reason);
  const read = deps.readFile ?? ((p: string) => readFile(p, "utf8"));
  let raw: unknown;
  try {
    raw = JSON.parse(await read(gate.credentialsFile));
  } catch {
    // The path and contents stay out of the message.
    throw new BillingError("credentials_unreadable", "The billing credentials file could not be read as JSON.");
  }
  const now = deps.now ?? (() => new Date());
  let adapter: BillingAdapter;
  let authorizer: RequestAuthorizer;
  try {
    if (provider === "aws") {
      authorizer = awsAuthorizer(AwsFile.parse(raw), now);
      adapter = awsCostExplorerAdapter;
    } else if (provider === "gcp") {
      authorizer = bearer(BearerFile.parse(raw).accessToken);
      adapter = gcpBigQueryAdapter;
    } else if (provider === "azure") {
      authorizer = bearer(BearerFile.parse(raw).accessToken);
      adapter = azureCostManagementAdapter;
    } else {
      const f = OciFile.parse(raw);
      authorizer = ociAuthorizer(f, now);
      adapter = ociUsageAdapter({ region: f.region });
    }
  } catch (error) {
    if (error instanceof BillingError) throw error;
    throw new BillingError("credentials_unreadable", "The billing credentials file does not have the expected shape.");
  }
  return createActualSpendReader(adapter, {
    authorizer,
    transport: fetchTransport(provider, deps.fetch ?? fetch),
    now: () => now().toISOString(),
  });
}
