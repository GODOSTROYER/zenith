/**
 * Stripe TEST-mode adapter and webhook signature verification (PROD-MAN-06).
 *
 * TEST MODE ONLY. The constructor refuses any key that is not `sk_test_` / `rk_test_`, so a live key can never be wired
 * to this adapter by configuration. The key is held in a closure, sent only as the Authorization header to the
 * configured API base, and appears in no error, log line or stored row.
 *
 * Requests are form-encoded `application/x-www-form-urlencoded` to the documented v1 endpoints:
 *   POST /v1/customers                      (metadata only; no email or name is sent)
 *   POST /v1/invoices                       (collection_method=send_invoice, auto_advance=false)
 *   POST /v1/invoiceitems                   (one per invoice line, attached to the invoice)
 *   POST /v1/invoices/{id}/finalize
 * each with an `Idempotency-Key` header. Nothing here collects a payment method or charges a card.
 *
 * Webhook verification follows Stripe's documented scheme: header `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>]`,
 * signed payload `<t>.<raw body>`, HMAC-SHA256 with the endpoint secret, constant-time comparison, and a timestamp
 * tolerance (default 300 s) in both directions to bound replay.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { STRIPE_API_BASE, isStripeTestKey } from "./config";
import { BillingProviderError, type CreateInvoiceInput, type EnsureCustomerInput, type InvoiceProvider } from "./provider";

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export interface StripeTestOptions {
  secretKey: string;
  apiBase?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

const MAX_RESPONSE_CHARS = 262_144;
const ID = /^[A-Za-z0-9_]{1,100}$/;

export class StripeTestInvoiceProvider implements InvoiceProvider {
  readonly kind = "stripe_test";
  private readonly call: (path: string, body: URLSearchParams, idempotencyKey: string) => Promise<Record<string, unknown>>;

  constructor(options: StripeTestOptions) {
    if (!isStripeTestKey(options.secretKey)) {
      throw new BillingProviderError("provider_misconfigured", "Only a Stripe test-mode key (sk_test_ or rk_test_) is accepted; live keys are refused.");
    }
    const key = options.secretKey;
    const base = (options.apiBase ?? STRIPE_API_BASE).replace(/\/$/, "");
    const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
    const timeoutMs = options.timeoutMs ?? 15_000;
    this.call = async (path, body, idempotencyKey) => {
      let res: { status: number; text(): Promise<string> };
      try {
        res = await doFetch(`${base}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded", "idempotency-key": idempotencyKey.slice(0, 255), "stripe-version": "2024-06-20" },
          body: body.toString(),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new BillingProviderError("provider_unavailable", "The payment provider could not be reached; nothing was recorded as sent.");
      }
      const text = (await res.text()).slice(0, MAX_RESPONSE_CHARS);
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { parsed = undefined; }
      if (res.status >= 500 || res.status === 429) throw new BillingProviderError("provider_unavailable", `The payment provider answered ${res.status}.`, res.status);
      if (res.status < 200 || res.status >= 300) {
        const message = typeof (parsed as { error?: { message?: unknown } } | undefined)?.error?.message === "string" ? String((parsed as { error: { message: string } }).error.message).slice(0, 160) : "rejected";
        throw new BillingProviderError("provider_rejected", `The payment provider rejected the request (${res.status}): ${message.replaceAll(key, "[redacted]")}`, res.status);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BillingProviderError("provider_bad_response", "The payment provider answered with an unexpected body.");
      return parsed as Record<string, unknown>;
    };
  }

  private static id(obj: Record<string, unknown>, prefix: string): string {
    const id = obj.id;
    if (typeof id !== "string" || !ID.test(id) || !id.startsWith(prefix)) throw new BillingProviderError("provider_bad_response", `The payment provider answered without a valid ${prefix} id.`);
    return id;
  }

  async ensureCustomer(input: EnsureCustomerInput): Promise<{ customerId: string }> {
    const body = new URLSearchParams({ "metadata[zenith_workspace_id]": input.workspaceId });
    return { customerId: StripeTestInvoiceProvider.id(await this.call("/v1/customers", body, input.idempotencyKey), "cus_") };
  }

  async createInvoice(input: CreateInvoiceInput): Promise<{ providerInvoiceId: string }> {
    const meta = { "metadata[zenith_invoice_id]": input.invoiceId, "metadata[zenith_workspace_id]": input.workspaceId, "metadata[zenith_period]": input.period };
    const invoice = await this.call("/v1/invoices", new URLSearchParams({
      customer: input.customerId, collection_method: "send_invoice", days_until_due: String(input.dueDays), auto_advance: "false", currency: input.currency, ...meta,
    }), `${input.idempotencyKey}:invoice`);
    const id = StripeTestInvoiceProvider.id(invoice, "in_");
    let i = 0;
    for (const line of input.lines) {
      if (line.amountCents <= 0) continue;
      await this.call("/v1/invoiceitems", new URLSearchParams({
        customer: input.customerId, invoice: id, currency: input.currency, amount: String(line.amountCents), description: `${line.description} (provisional pricing)`.slice(0, 500), ...meta,
      }), `${input.idempotencyKey}:item:${i}`);
      i += 1;
    }
    await this.call(`/v1/invoices/${id}/finalize`, new URLSearchParams({ auto_advance: "false" }), `${input.idempotencyKey}:finalize`);
    return { providerInvoiceId: id };
  }
}

/* ------------------------------ webhook signature ------------------------------ */

export const SIGNATURE_TOLERANCE_SEC = 300;

export type SignatureFailure = "missing_header" | "malformed_header" | "timestamp_outside_tolerance" | "no_matching_signature" | "secret_not_configured";
export type SignatureResult = { ok: true; timestamp: number } | { ok: false; reason: SignatureFailure };

/** `t=<unix>,v1=<hex>` header for `payload`; the signing side of the scheme (used to build fixtures and by an operator's own tooling). */
export function signStripePayload(secret: string, payload: string | Buffer, timestampSec: number): string {
  const mac = createHmac("sha256", secret).update(`${timestampSec}.`).update(payload).digest("hex");
  return `t=${timestampSec},v1=${mac}`;
}

export function verifyStripeSignature(input: { secret: string | undefined; header: string | null; payload: string | Buffer; nowMs: number; toleranceSec?: number }): SignatureResult {
  if (!input.secret) return { ok: false, reason: "secret_not_configured" };
  if (!input.header) return { ok: false, reason: "missing_header" };
  let timestamp: number | undefined;
  const candidates: Buffer[] = [];
  for (const part of input.header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 1) return { ok: false, reason: "malformed_header" };
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") {
      if (!/^\d{1,12}$/.test(v)) return { ok: false, reason: "malformed_header" };
      timestamp = Number(v);
    } else if (k === "v1") {
      if (!/^[0-9a-f]{64}$/i.test(v)) return { ok: false, reason: "malformed_header" };
      candidates.push(Buffer.from(v, "hex"));
    }
  }
  if (timestamp === undefined || candidates.length === 0) return { ok: false, reason: "malformed_header" };
  const tolerance = input.toleranceSec ?? SIGNATURE_TOLERANCE_SEC;
  if (Math.abs(Math.floor(input.nowMs / 1000) - timestamp) > tolerance) return { ok: false, reason: "timestamp_outside_tolerance" };
  const expected = createHmac("sha256", input.secret).update(`${timestamp}.`).update(input.payload).digest();
  const matched = candidates.reduce((acc, c) => (c.length === expected.length && timingSafeEqual(c, expected) ? true : acc), false);
  return matched ? { ok: true, timestamp } : { ok: false, reason: "no_matching_signature" };
}
