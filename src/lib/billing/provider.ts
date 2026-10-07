/**
 * The invoicing adapter boundary (PROD-MAN-06). Zenith's billing logic never speaks to a payment provider directly: it
 * calls an `InvoiceProvider`. The shipped adapter is `StripeTestInvoiceProvider` (Stripe TEST mode only). Calls carry an
 * idempotency key derived from the invoice id, so repeating a call after a crash or timeout cannot create a second
 * provider invoice.
 */
import type { InvoiceLine } from "./store";

export class BillingProviderError extends Error {
  readonly name = "BillingProviderError";
  constructor(readonly code: "provider_unavailable" | "provider_rejected" | "provider_misconfigured" | "provider_bad_response", message: string, readonly status?: number) {
    super(message);
  }
}

export interface EnsureCustomerInput { workspaceId: string; idempotencyKey: string }
export interface CreateInvoiceInput {
  invoiceId: string;
  workspaceId: string;
  customerId: string;
  period: string;
  lines: readonly InvoiceLine[];
  currency: "usd";
  dueDays: number;
  idempotencyKey: string;
}

export interface InvoiceProvider {
  /** `stripe_test` for the real adapter against Stripe's test mode; anything else is a contract-level stand-in */
  readonly kind: string;
  ensureCustomer(input: EnsureCustomerInput): Promise<{ customerId: string }>;
  /** Creates and finalizes the provider invoice. It never charges a card on its own: collection is by the provider's own flow. */
  createInvoice(input: CreateInvoiceInput): Promise<{ providerInvoiceId: string }>;
}
