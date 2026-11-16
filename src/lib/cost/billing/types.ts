/**
 * Actual-spend reader contract (PROD-COST-01).
 *
 * `ActualSpendReader` is the interface callers depend on. Provider billing
 * adapters (AWS Cost Explorer, GCP BigQuery billing export, Azure Cost
 * Management, OCI Usage API) are small pure objects that BUILD a provider
 * request and PARSE a provider response; sending and signing are injected.
 * Nothing in this folder opens a network connection on its own: the only live
 * path is `live.ts`, which refuses unless `ZENITH_LIVE_<PROVIDER>=1` and a
 * credentials FILE reference are both present (see `gate.ts`).
 */
import type { ActualSpend, BillingProvider } from "@/lib/cost/kinds";

export interface ActualSpendQuery {
  provider: BillingProvider;
  /** account id, BigQuery export table, subscription path or tenancy OCID, per provider */
  scope: string;
  /** inclusive YYYY-MM-DD */
  periodStart: string;
  /** exclusive YYYY-MM-DD */
  periodEnd: string;
}

export interface ActualSpendReader {
  readonly provider: BillingProvider;
  readonly adapter: string;
  read(query: ActualSpendQuery): Promise<ActualSpend>;
}

export interface ProviderHttpRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ProviderHttpResponse {
  status: number;
  body: string;
  /** lowercase header names */
  headers?: Record<string, string>;
}

export interface BillingTransport {
  send(request: ProviderHttpRequest): Promise<ProviderHttpResponse>;
}

/** Adds provider authentication (signature or bearer token) to a request. Injected; never built from request data. */
export interface RequestAuthorizer {
  authorize(request: ProviderHttpRequest): Promise<ProviderHttpRequest>;
}

export interface ParseMeta {
  endpoint: string;
  retrievedAt: string;
  adapter: string;
  responseSha256: string;
  headers: Record<string, string>;
  /** true when the period closed long enough ago for the provider to have finalized it */
  closed: boolean;
}

export interface BillingAdapter {
  readonly provider: BillingProvider;
  readonly adapter: string;
  /** refuses a scope or period the provider API cannot answer faithfully */
  validate(query: ActualSpendQuery): void;
  buildRequest(query: ActualSpendQuery): ProviderHttpRequest;
  parse(responseBody: string, query: ActualSpendQuery, meta: ParseMeta): ActualSpend;
}

export type BillingErrorCode =
  | "invalid_query"
  | "gate_closed"
  | "credentials_unreadable"
  | "provider_error"
  | "incomplete_response"
  | "unsupported_currency"
  | "malformed_response";

export class BillingError extends Error {
  constructor(
    readonly code: BillingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BillingError";
  }
}
