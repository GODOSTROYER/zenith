/**
 * Builds an `ActualSpendReader` from a provider adapter plus an injected
 * authorizer and transport. The reader itself performs no I/O: tests pass a
 * recorded transport; production passes `live.ts` output, which is gated.
 */
import { sha256Hex } from "@/lib/controlplane/digest";
import { BILLING_PROVIDERS, daysBetween, type ActualSpend } from "@/lib/cost/kinds";
import {
  BillingError,
  type ActualSpendQuery,
  type ActualSpendReader,
  type BillingAdapter,
  type BillingTransport,
  type RequestAuthorizer,
} from "@/lib/cost/billing/types";

/** Days after a period ends before it is treated as final: provider billing data lags and is revised. */
export const FINALIZATION_LAG_DAYS = 5;
export const MAX_PERIOD_DAYS = 366;

export function validateQueryShape(query: ActualSpendQuery): void {
  if (!BILLING_PROVIDERS.includes(query.provider)) throw new BillingError("invalid_query", "Unknown billing provider.");
  if (typeof query.scope !== "string" || query.scope.length === 0 || query.scope.length > 300 || /[\u0000-\u001f\u007f]/.test(query.scope)) {
    throw new BillingError("invalid_query", "The billing scope is invalid.");
  }
  let days: number;
  try {
    days = daysBetween(query.periodStart, query.periodEnd);
  } catch {
    throw new BillingError("invalid_query", "The billing period must be real YYYY-MM-DD dates.");
  }
  if (days < 1 || days > MAX_PERIOD_DAYS) throw new BillingError("invalid_query", `The billing period must span 1 to ${MAX_PERIOD_DAYS} days.`);
}

export interface ReaderDeps {
  authorizer: RequestAuthorizer;
  transport: BillingTransport;
  /** ISO timestamp provider; injected so nothing reads the wall clock implicitly */
  now: () => string;
}

export function createActualSpendReader(adapter: BillingAdapter, deps: ReaderDeps): ActualSpendReader {
  return {
    provider: adapter.provider,
    adapter: adapter.adapter,
    async read(query: ActualSpendQuery): Promise<ActualSpend> {
      if (query.provider !== adapter.provider) throw new BillingError("invalid_query", "The query is for a different provider.");
      validateQueryShape(query);
      adapter.validate(query);
      const request = await deps.authorizer.authorize(adapter.buildRequest(query));
      const response = await deps.transport.send(request);
      if (response.status < 200 || response.status > 299) {
        // The body can echo account details; only the status is surfaced.
        throw new BillingError("provider_error", `${adapter.provider.toUpperCase()} billing API answered HTTP ${response.status}.`);
      }
      const retrievedAt = deps.now();
      const closed = daysBetween(query.periodEnd, retrievedAt.slice(0, 10)) >= FINALIZATION_LAG_DAYS;
      return adapter.parse(response.body, query, {
        endpoint: new URL(request.url).origin + new URL(request.url).pathname,
        retrievedAt,
        adapter: adapter.adapter,
        responseSha256: sha256Hex(response.body),
        headers: response.headers ?? {},
        closed,
      });
    },
  };
}

/** Shared by adapters: a USD decimal that must be finite. */
export function usd(value: unknown, what: string): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new BillingError("malformed_response", `${what} is not a finite number.`);
  return n;
}

export function requireUsd(currency: unknown): void {
  if (currency !== "USD") throw new BillingError("unsupported_currency", "Only USD billing data is supported; amounts are never converted.");
}
