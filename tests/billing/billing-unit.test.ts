/**
 * PROD-MAN-06 unit and contract tests that need no database: the provisional plan catalog, configuration (the
 * `billing: disabled` default), pure invoice pricing, the Stripe TEST-mode adapter's request shapes (injected fetch,
 * contract-level) and webhook signature verification with a run-time generated secret.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { STRIPE_API_BASE, billingConfigFromEnv, billingEnabled, isStripeTestKey } from "@/lib/billing/config";
import { priceInvoice } from "@/lib/billing/invoice";
import { periodBounds, periodEnded, periodOf, previousPeriod } from "@/lib/billing/period";
import { BILLABLE_METERS, DEFAULT_PLAN_ID, PLANS, PLAN_NOTICE, getPlan, isPlanId, listPlanViews, type PlanDefinition } from "@/lib/billing/plans";
import { BillingProviderError } from "@/lib/billing/provider";
import { SIGNATURE_TOLERANCE_SEC, StripeTestInvoiceProvider, signStripePayload, verifyStripeSignature, type FetchLike } from "@/lib/billing/stripe";
import { hex, liveLookingKey, testSecretKey, webhookSecret } from "./_support";

describe("provisional plan catalog", () => {
  it("marks every plan provisional, names it as such and ties it to the undecided business decision", () => {
    expect(Object.keys(PLANS).length).toBeGreaterThanOrEqual(3);
    for (const plan of Object.values(PLANS)) {
      expect(plan.provisional).toBe(true);
      expect(plan.decision).toBe("DEC-BUSINESS");
      expect(plan.id).toMatch(/_provisional$/);
      expect(plan.name).toMatch(/provisional/i);
      for (const meter of BILLABLE_METERS) expect(plan.meters[meter].included).toBeGreaterThanOrEqual(0);
    }
    expect(PLAN_NOTICE).toMatch(/not decided/i);
    for (const view of listPlanViews()) expect(view.notice).toBe(PLAN_NOTICE);
  });

  it("is frozen and rejects unknown plan ids, including prototype names", () => {
    expect(isPlanId(DEFAULT_PLAN_ID)).toBe(true);
    for (const bad of ["enterprise", "", "__proto__", "constructor", "toString", undefined, 7]) expect(isPlanId(bad)).toBe(false);
    expect(() => getPlan("enterprise")).toThrow(RangeError);
    expect(Object.isFrozen(PLANS)).toBe(true);
    expect(Object.isFrozen(PLANS.team_provisional)).toBe(true);
  });
});

describe("billing mode configuration", () => {
  it("defaults to disabled, so BYOC and self-hosted installs never run billing", () => {
    for (const env of [{}, { ZENITH_BILLING: "" }, { ZENITH_BILLING: "disabled" }]) {
      expect(billingConfigFromEnv(env).mode).toBe("disabled");
      expect(billingEnabled(env)).toBe(false);
    }
  });

  it("treats an unknown value as disabled and says so: a typo never switches suspension on", () => {
    const cfg = billingConfigFromEnv({ ZENITH_BILLING: "manged" });
    expect(cfg.mode).toBe("disabled");
    expect(cfg.issues.join(" ")).toMatch(/ZENITH_BILLING must be disabled or managed/);
    expect(billingConfigFromEnv({ ZENITH_BILLING: " Managed " }).mode).toBe("managed");
  });

  it("refuses a live-looking Stripe key and bounds the day settings", () => {
    const live = billingConfigFromEnv({ ZENITH_BILLING: "managed", ZENITH_BILLING_STRIPE_SECRET_KEY: liveLookingKey() });
    expect(live.stripe.secretKeyConfigured).toBe(false);
    expect(live.issues.join(" ")).toMatch(/not a Stripe test-mode key/);
    expect(JSON.stringify(live)).not.toContain("sk_live_");
    const ok = billingConfigFromEnv({ ZENITH_BILLING: "managed", ZENITH_BILLING_STRIPE_SECRET_KEY: testSecretKey(), ZENITH_BILLING_GRACE_DAYS: "7", ZENITH_BILLING_NET_DAYS: "30" });
    expect(ok.stripe.secretKeyConfigured).toBe(true);
    expect([ok.graceDays, ok.netDays]).toEqual([7, 30]);
    const bad = billingConfigFromEnv({ ZENITH_BILLING_GRACE_DAYS: "-1", ZENITH_BILLING_NET_DAYS: "0" });
    expect([bad.graceDays, bad.netDays]).toEqual([14, 14]);
    expect(bad.issues).toHaveLength(2);
  });

  it("honours the API base override only for loopback http", () => {
    expect(billingConfigFromEnv({}).stripe.apiBase).toBe(STRIPE_API_BASE);
    expect(billingConfigFromEnv({ ZENITH_BILLING_STRIPE_API_BASE: "http://127.0.0.1:4010/x" }).stripe.apiBase).toBe("http://127.0.0.1:4010");
    for (const base of ["https://evil.example", "http://evil.example", "http://127.0.0.1.evil.example", "not a url"]) {
      const cfg = billingConfigFromEnv({ ZENITH_BILLING_STRIPE_API_BASE: base });
      expect(cfg.stripe.apiBase).toBe(STRIPE_API_BASE);
      expect(cfg.issues.length).toBe(1);
    }
    expect(isStripeTestKey(testSecretKey())).toBe(true);
    expect(isStripeTestKey(`rk_test_${hex(12)}`)).toBe(true);
    expect(isStripeTestKey(liveLookingKey())).toBe(false);
  });
});

describe("periods", () => {
  it("keys calendar months in UTC and only lets an ended period be invoiced", () => {
    expect(periodOf(new Date("2026-03-31T23:59:59Z"))).toBe("2026-03");
    expect(periodOf(new Date("2026-04-01T00:00:00Z"))).toBe("2026-04");
    expect(periodBounds("2026-12").end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(previousPeriod("2026-01")).toBe("2025-12");
    expect(periodEnded("2026-03", new Date("2026-03-31T23:59:59Z"))).toBe(false);
    expect(periodEnded("2026-03", new Date("2026-04-01T00:00:00Z"))).toBe(true);
    expect(() => periodBounds("2026-13")).toThrow(RangeError);
  });
});

describe("invoice pricing", () => {
  const plan: PlanDefinition = {
    id: "test_provisional", name: "Test (provisional)", provisional: true, decision: "DEC-BUSINESS", baseCents: 1000, maxActiveOperations: 5,
    meters: {
      managed_resource_hours: { included: 100, rateCents: 0.5 },
      build_minutes: { included: 10, rateCents: 2 },
      storage_gb_month: { included: 1, rateCents: 10 },
    },
  };

  it("charges the base fee plus overage beyond the included allowance, rounded once per line", () => {
    const priced = priceInvoice(plan, [
      { meter: "managed_resource_hours", quantity: 250, estimated: false, sources: 3 },
      { meter: "build_minutes", quantity: 4, estimated: false, sources: 1 },
      { meter: "storage_gb_month", quantity: 3.5, estimated: false, sources: 1 },
    ], "2026-03");
    const by = Object.fromEntries(priced.lines.map((l) => [l.key, l.amountCents]));
    expect(by).toMatchObject({ base: 1000, managed_resource_hours: 75, build_minutes: 0, storage_gb_month: 25 });
    expect(priced.subtotalCents).toBe(1100);
    expect(priced.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("lists estimated and informational meters at zero: an estimate is never charged", () => {
    const priced = priceInvoice(plan, [
      { meter: "egress_gb_estimated", quantity: 80, estimated: true, sources: 1 },
      { meter: "operations_executed", quantity: 12, estimated: false, sources: 1 },
    ], "2026-03");
    expect(priced.lines.filter((l) => l.key !== "base").every((l) => l.amountCents === 0)).toBe(true);
    expect(priced.lines.find((l) => l.key === "egress_gb_estimated")?.description).toMatch(/estimate, not charged/);
    expect(priced.subtotalCents).toBe(1000);
  });

  it("is deterministic: the same inputs give the same digest, and a changed quantity changes it", () => {
    const totals = [{ meter: "build_minutes" as const, quantity: 50, estimated: false, sources: 1 }];
    expect(priceInvoice(plan, totals, "2026-03").digest).toBe(priceInvoice(plan, totals, "2026-03").digest);
    expect(priceInvoice(plan, [{ ...totals[0], quantity: 51 }], "2026-03").digest).not.toBe(priceInvoice(plan, totals, "2026-03").digest);
  });

  it("prices the free provisional plan at zero when usage is within its allowance", () => {
    const priced = priceInvoice(getPlan("free_provisional"), [{ meter: "managed_resource_hours", quantity: 100, estimated: false, sources: 1 }], "2026-03");
    expect(priced.subtotalCents).toBe(0);
  });
});

describe("Stripe test-mode adapter (contract level, injected fetch)", () => {
  interface Seen { url: string; method: string; headers: Record<string, string>; form: URLSearchParams }
  function recorder(answer: (seen: Seen) => { status: number; body: unknown }): { fetch: FetchLike; seen: Seen[] } {
    const seen: Seen[] = [];
    const fetch: FetchLike = async (url, init) => {
      const s: Seen = { url, method: init.method, headers: init.headers, form: new URLSearchParams(init.body) };
      seen.push(s);
      const a = answer(s);
      return { status: a.status, text: async () => (typeof a.body === "string" ? a.body : JSON.stringify(a.body)) };
    };
    return { fetch, seen };
  }

  it("refuses to be constructed with anything but a test-mode key", () => {
    expect(() => new StripeTestInvoiceProvider({ secretKey: liveLookingKey() })).toThrow(BillingProviderError);
    expect(() => new StripeTestInvoiceProvider({ secretKey: "" })).toThrow(/test-mode/);
    expect(() => new StripeTestInvoiceProvider({ secretKey: testSecretKey() })).not.toThrow();
  });

  it("creates a customer, an invoice, one item per charged line and finalizes, each with an idempotency key", async () => {
    const key = testSecretKey();
    const ids = { cus: `cus_${hex(6)}`, inv: `in_${hex(6)}` };
    const { fetch, seen } = recorder((s) => {
      if (s.url.endsWith("/v1/customers")) return { status: 200, body: { id: ids.cus } };
      if (s.url.endsWith("/v1/invoices")) return { status: 200, body: { id: ids.inv } };
      return { status: 200, body: { id: `ii_${hex(6)}` } };
    });
    const provider = new StripeTestInvoiceProvider({ secretKey: key, fetch });
    const { customerId } = await provider.ensureCustomer({ workspaceId: "ws_1", idempotencyKey: "cust-key" });
    expect(customerId).toBe(ids.cus);
    const out = await provider.createInvoice({
      invoiceId: "inv_1", workspaceId: "ws_1", customerId, period: "2026-03", currency: "usd", dueDays: 14, idempotencyKey: "inv-key",
      lines: [
        { key: "base", description: "Team base fee", quantity: 1, unit: "period", unitCents: 2900, amountCents: 2900 },
        { key: "egress_gb_estimated", description: "egress (estimate, not charged)", quantity: 80, unit: "GB (estimate)", unitCents: 0, amountCents: 0 },
      ],
    });
    expect(out.providerInvoiceId).toBe(ids.inv);
    expect(seen.map((s) => s.url.replace(STRIPE_API_BASE, ""))).toEqual(["/v1/customers", "/v1/invoices", "/v1/invoiceitems", `/v1/invoices/${ids.inv}/finalize`]);
    for (const s of seen) {
      expect(s.method).toBe("POST");
      expect(s.url.startsWith(STRIPE_API_BASE)).toBe(true);
      expect(s.headers.authorization).toBe(`Bearer ${key}`);
      expect(s.headers["content-type"]).toBe("application/x-www-form-urlencoded");
      expect(s.headers["idempotency-key"]).toBeTruthy();
    }
    expect(seen[1].form.get("collection_method")).toBe("send_invoice");
    expect(seen[1].form.get("auto_advance")).toBe("false");
    expect(seen[1].form.get("metadata[zenith_invoice_id]")).toBe("inv_1");
    expect(seen[2].form.get("amount")).toBe("2900");
    expect(seen[2].form.get("invoice")).toBe(ids.inv);
    expect(seen[2].form.get("description")).toMatch(/provisional pricing/);
    expect(new Set(seen.map((s) => s.headers["idempotency-key"])).size).toBe(seen.length);
    // no personal data and no payment method is ever sent
    expect(seen.map((s) => s.form.toString()).join("&")).not.toMatch(/email|name=|payment_method|card|source/i);
  });

  it("maps provider failures to typed errors that never carry the key", async () => {
    const key = testSecretKey();
    const make = (status: number, body: unknown) => new StripeTestInvoiceProvider({ secretKey: key, fetch: recorder(() => ({ status, body })).fetch });
    await expect(make(500, "boom").ensureCustomer({ workspaceId: "ws", idempotencyKey: "k" })).rejects.toMatchObject({ code: "provider_unavailable" });
    await expect(make(429, {}).ensureCustomer({ workspaceId: "ws", idempotencyKey: "k" })).rejects.toMatchObject({ code: "provider_unavailable" });
    await expect(make(200, "not json").ensureCustomer({ workspaceId: "ws", idempotencyKey: "k" })).rejects.toMatchObject({ code: "provider_bad_response" });
    await expect(make(200, { id: "pi_wrongprefix" }).ensureCustomer({ workspaceId: "ws", idempotencyKey: "k" })).rejects.toMatchObject({ code: "provider_bad_response" });
    const rejected = await make(400, { error: { message: `bad key ${key}` } }).ensureCustomer({ workspaceId: "ws", idempotencyKey: "k" }).catch((e: Error) => e);
    expect(rejected).toMatchObject({ code: "provider_rejected", status: 400 });
    expect((rejected as Error).message).not.toContain(key);
    const unreachable = new StripeTestInvoiceProvider({ secretKey: key, fetch: async () => { throw new Error(`connect failed ${key}`); } });
    const e = await unreachable.ensureCustomer({ workspaceId: "ws", idempotencyKey: "k" }).catch((x: Error) => x);
    expect(e).toMatchObject({ code: "provider_unavailable" });
    expect((e as Error).message).not.toContain(key);
  });
});

describe("webhook signature verification (run-time generated secret)", () => {
  const nowMs = Date.parse("2026-04-02T12:00:00Z");
  const nowSec = Math.floor(nowMs / 1000);
  const payload = JSON.stringify({ id: "evt_x", type: "invoice.paid", created: nowSec, data: { object: {} } });

  it("accepts the documented scheme and reports the timestamp", () => {
    const secret = webhookSecret();
    const header = signStripePayload(secret, payload, nowSec);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifyStripeSignature({ secret, header, payload, nowMs })).toEqual({ ok: true, timestamp: nowSec });
    // independent re-implementation of the documented HMAC, so the helper cannot agree with itself by accident
    const mac = createHmac("sha256", secret).update(`${nowSec}.${payload}`).digest("hex");
    expect(header).toBe(`t=${nowSec},v1=${mac}`);
    expect(verifyStripeSignature({ secret, header, payload: Buffer.from(payload), nowMs }).ok).toBe(true);
  });

  it("refuses a tampered body, a different secret and a different timestamp", () => {
    const secret = webhookSecret();
    const header = signStripePayload(secret, payload, nowSec);
    expect(verifyStripeSignature({ secret, header, payload: `${payload} `, nowMs })).toEqual({ ok: false, reason: "no_matching_signature" });
    expect(verifyStripeSignature({ secret: webhookSecret(), header, payload, nowMs })).toEqual({ ok: false, reason: "no_matching_signature" });
    const retimed = header.replace(`t=${nowSec}`, `t=${nowSec + 1}`);
    expect(verifyStripeSignature({ secret, header: retimed, payload, nowMs })).toEqual({ ok: false, reason: "no_matching_signature" });
  });

  it("bounds replay with a timestamp tolerance in both directions", () => {
    const secret = webhookSecret();
    const at = (t: number) => verifyStripeSignature({ secret, header: signStripePayload(secret, payload, t), payload, nowMs });
    expect(at(nowSec - SIGNATURE_TOLERANCE_SEC).ok).toBe(true);
    expect(at(nowSec - SIGNATURE_TOLERANCE_SEC - 1)).toEqual({ ok: false, reason: "timestamp_outside_tolerance" });
    expect(at(nowSec + SIGNATURE_TOLERANCE_SEC + 1)).toEqual({ ok: false, reason: "timestamp_outside_tolerance" });
  });

  it("accepts any matching v1 among several (secret rollover) and refuses malformed headers", () => {
    const secret = webhookSecret();
    const good = signStripePayload(secret, payload, nowSec);
    const other = signStripePayload(webhookSecret(), payload, nowSec).split(",")[1];
    expect(verifyStripeSignature({ secret, header: `${good},${other}`, payload, nowMs }).ok).toBe(true);
    expect(verifyStripeSignature({ secret, header: `${other},${good}`, payload, nowMs }).ok).toBe(true);
    for (const header of ["", "garbage", "t=abc,v1=" + "0".repeat(64), `t=${nowSec}`, `t=${nowSec},v1=zz`, `t=${nowSec},v1=${"0".repeat(63)}`, `v1=${"0".repeat(64)}`, `t=${nowSec},,v1=${"0".repeat(64)}`]) {
      const r = verifyStripeSignature({ secret, header, payload, nowMs });
      expect(r.ok, header).toBe(false);
    }
    expect(verifyStripeSignature({ secret, header: null, payload, nowMs })).toEqual({ ok: false, reason: "missing_header" });
  });

  it("is not verifiable at all when no secret is configured", () => {
    const header = signStripePayload("", payload, nowSec);
    expect(verifyStripeSignature({ secret: undefined, header, payload, nowMs })).toEqual({ ok: false, reason: "secret_not_configured" });
    expect(verifyStripeSignature({ secret: "", header, payload, nowMs })).toEqual({ ok: false, reason: "secret_not_configured" });
  });
});
