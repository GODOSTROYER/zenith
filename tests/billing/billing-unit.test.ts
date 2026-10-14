/**
 * PROD-MAN-06 unit and contract tests that need no database: the launch plan catalog and entitlements, configuration (the
 * `billing: disabled` default), pure invoice pricing, the Stripe TEST-mode adapter's request shapes (injected fetch,
 * contract-level) and webhook signature verification with a run-time generated secret.
 */
import { recordAccountEvent, recordInvoiceError } from "@/lib/billing/store";
import type { Sql } from "@/lib/controlplane/types";
import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { STRIPE_API_BASE, billingConfigFromEnv, billingEnabled, isStripeTestKey } from "@/lib/billing/config";
import { priceInvoice, usageMinimumTotalCents, zcuUsageCents } from "@/lib/billing/invoice";
import { periodBounds, periodEnded, periodOf, previousPeriod } from "@/lib/billing/period";
import { BILLABLE_METERS, DEFAULT_PLAN_ID, LEGACY_PLAN_ALIASES, PACKAGE_ROWS, PLANS, PLAN_NOTICE, PRICING_DECISION, getPlan, isKnownPlanId, isPlanId, listPlanViews } from "@/lib/billing/plans";
import { BillingProviderError } from "@/lib/billing/provider";
import { SIGNATURE_TOLERANCE_SEC, StripeTestInvoiceProvider, signStripePayload, verifyStripeSignature, type FetchLike } from "@/lib/billing/stripe";
import { BrokerError, BROKER_HTTP_STATUS } from "@/lib/capabilities/errors";
import { BACKPRESSURE_STATUS, BackpressureError, backpressureBody, backpressureResponse } from "@/lib/ops/errors";
import { errorBody } from "@/app/api/platform/v1/_lib/http";
import { hex, liveLookingKey, testSecretKey, webhookSecret } from "./_support";

describe("launch plan catalog", () => {
  it("has exactly the four decided packages, none provisional, tied to the recorded decision", () => {
    expect(Object.keys(PLANS)).toEqual(["explore", "builder", "team", "enterprise"]);
    expect(PRICING_DECISION).toEqual({ decision: "DEC-BUSINESS", approvedBy: "Arnav Bule", approvedAt: "2026-10-13" });
    expect(Object.isFrozen(PRICING_DECISION)).toBe(true);
    for (const plan of Object.values(PLANS)) {
      expect(plan.provisional).toBe(false);
      expect(plan.decision).toBe("DEC-BUSINESS");
      expect(plan.id).not.toMatch(/_provisional$/);
      expect(plan.name).not.toMatch(/provisional/i);
      for (const meter of BILLABLE_METERS) expect(plan.meters[meter].included).toBeGreaterThanOrEqual(0);
    }
    expect(PLAN_NOTICE).toMatch(/2026-10-13/);
    expect(PLAN_NOTICE).toMatch(/not live/i);
    for (const view of listPlanViews()) expect(view.notice).toBe(PLAN_NOTICE);
    expect(DEFAULT_PLAN_ID).toBe("explore");
  });

  it("models prices explicitly and maps each plan to its managed tier", () => {
    expect(PLANS.explore.pricing).toEqual({ kind: "free" });
    expect(PLANS.builder.pricing).toEqual({ kind: "usage_minimum", minimumCents: 2900, zcuRateMillicents: 1500 });
    expect(PLANS.team.pricing).toEqual({ kind: "usage_minimum", minimumCents: 19900, zcuRateMillicents: 1500 });
    expect(PLANS.enterprise.pricing).toEqual({ kind: "contract" });
    expect(Object.values(PLANS).map((p) => [p.id, p.managedTier])).toEqual([["explore", "free"], ["builder", "starter"], ["team", "pro"], ["enterprise", "pro"]]);
    expect(Object.values(PLANS).map((p) => p.maxActiveOperations)).toEqual([3, 15, 60, null]);
  });

  it("carries build minutes and storage as fair-use hard caps with no rate", () => {
    for (const plan of Object.values(PLANS)) {
      expect(plan.meters.build_minutes.rateCents).toBe(0);
      expect(plan.meters.storage_gb_month.rateCents).toBe(0);
    }
    expect([PLANS.explore, PLANS.builder, PLANS.team].map((p) => [p.meters.build_minutes.hardCap, p.meters.storage_gb_month.hardCap])).toEqual([[300, 20], [2000, 100], [10000, 500]]);
    expect(PLANS.enterprise.meters.build_minutes.hardCap).toBeUndefined();
    expect(PLANS.enterprise.meters.storage_gb_month.hardCap).toBeUndefined();
    for (const plan of Object.values(PLANS)) expect(plan.meters.managed_resource_hours.hardCap).toBeUndefined();
  });

  it("has entitlements exactly as the decision table states", () => {
    expect(PLANS.explore.entitlements).toEqual({ deploy: false, approvals: "preview", orgPolicies: false, deploymentOptions: ["planning"], support: "docs" });
    expect(PLANS.builder.entitlements).toEqual({ deploy: true, approvals: "full", orgPolicies: false, deploymentOptions: ["customer_cloud", "zenith_hosted"], support: "email" });
    expect(PLANS.team.entitlements).toEqual({ deploy: true, approvals: "full", orgPolicies: true, deploymentOptions: ["customer_cloud", "zenith_hosted"], support: "priority_email" });
    expect(PLANS.enterprise.entitlements).toEqual({ deploy: true, approvals: "full", orgPolicies: true, deploymentOptions: ["contract"], support: "contract" });
    for (const plan of Object.values(PLANS)) {
      expect(Object.isFrozen(plan.entitlements)).toBe(true);
      expect(Object.isFrozen(plan.entitlements.deploymentOptions)).toBe(true);
    }
  });

  it("renders the decision table verbatim, one string per row and package", () => {
    expect(PACKAGE_ROWS.map((r) => r.label)).toEqual([
      "Best for", "Monthly price", "Included management usage", "Additional management usage", "Architecture planning and cost estimates",
      "Application deployment and ongoing management", "Deployment approvals and audit records", "Organizational policies and team approval workflows",
      "Deployment options", "Support",
    ]);
    const column = (id: string) => PACKAGE_ROWS.map((r) => PLANS[id].display[r.key]);
    expect(column("explore")).toEqual(["Exploring Zenith", "Free", "Limited evaluation", "None", "Limited", "Not available", "Preview only", "Not available", "Planning and previews", "Documentation"]);
    expect(column("builder")).toEqual(["Individuals and small teams", "$29/month minimum", "$29/month", "$0.015 per ZCU-hour", "Included", "Included", "Included", "Not available", "Your cloud or Zenith-hosted", "Email support"]);
    expect(column("team")).toEqual(["Teams managing multiple environments", "$199/month minimum", "$199/month", "$0.015 per ZCU-hour", "Included", "Included", "Included", "Included", "Your cloud or Zenith-hosted", "Priority email support"]);
    expect(column("enterprise")).toEqual(["Organizations with custom requirements", "Custom pricing", "Custom commitment", "Negotiated rate", "Included", "Included", "Included", "Custom configuration", "Agreed deployment model", "Contracted support"]);
    for (const view of listPlanViews()) expect(view.zcu).toMatchObject({ meter: "managed_resource_hours", unit: "ZCU-hour" });
  });

  it("is frozen and rejects unknown plan ids, including prototype names", () => {
    expect(isPlanId(DEFAULT_PLAN_ID)).toBe(true);
    for (const bad of ["pro", "", "__proto__", "constructor", "toString", undefined, 7]) expect(isPlanId(bad)).toBe(false);
    expect(() => getPlan("pro")).toThrow(RangeError);
    expect(() => getPlan("__proto__")).toThrow(RangeError);
    expect(Object.isFrozen(PLANS)).toBe(true);
    expect(Object.isFrozen(PLANS.team)).toBe(true);
    expect(Object.isFrozen(PLANS.team.meters)).toBe(true);
    expect(Object.isFrozen(PLANS.team.pricing)).toBe(true);
    expect(Object.isFrozen(LEGACY_PLAN_ALIASES)).toBe(true);
  });

  it("resolves legacy ids to the current plans on read but never accepts them as current ids", () => {
    expect(LEGACY_PLAN_ALIASES).toEqual({ free_provisional: "explore", team_provisional: "builder", scale_provisional: "team" });
    for (const [legacy, current] of Object.entries(LEGACY_PLAN_ALIASES)) {
      expect(isPlanId(legacy)).toBe(false);
      expect(isKnownPlanId(legacy)).toBe(true);
      expect(getPlan(legacy)).toBe(PLANS[current]);
    }
    expect(isKnownPlanId("enterprise")).toBe(true);
    expect(isKnownPlanId("__proto__")).toBe(false);
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

const hours = (quantity: number) => [{ meter: "managed_resource_hours" as const, quantity, estimated: false, sources: 1 }];

describe("invoice pricing", () => {
  it("rounds the usage charge half-up once, exactly, at 1.5 cents per ZCU-hour", () => {
    expect(zcuUsageCents(0, 1500)).toBe(0);
    expect(zcuUsageCents(-3, 1500)).toBe(0);
    expect(zcuUsageCents(1, 1500)).toBe(2); // 1.5 rounds half up
    expect(zcuUsageCents(2, 1500)).toBe(3);
    expect(zcuUsageCents(3, 1500)).toBe(5); // 4.5 rounds half up
    expect(zcuUsageCents(0.333333, 1500)).toBe(0); // 0.4999995 cents rounds down
    expect(zcuUsageCents(0.333334, 1500)).toBe(1); // 0.500001 cents rounds up
    expect(zcuUsageCents(0.000001, 1500)).toBe(0);
    expect(zcuUsageCents(1_000_000_000, 1500)).toBe(1_500_000_000);
    expect(usageMinimumTotalCents(2900, 100)).toBe(2900);
    expect(usageMinimumTotalCents(2900, 2900)).toBe(2900);
    expect(usageMinimumTotalCents(2900, 2901)).toBe(2901);
  });

  it("Builder: zero usage costs the $29 minimum, never less", () => {
    const priced = priceInvoice(PLANS.builder, [], "2026-03");
    expect(priced.subtotalCents).toBe(2900);
    expect(priced.lines.map((l) => [l.key, l.amountCents])).toEqual([["zcu_hours", 0], ["minimum", 2900]]);
    expect(priceInvoice(PLANS.builder, hours(0), "2026-03").subtotalCents).toBe(2900);
  });

  it("Builder: stays at the minimum up to exactly the included amount and charges usage only above it", () => {
    // $29.00 / $0.015 = 1933.33 ZCU-hours. 1933 -> 2899.5 -> 2900 (half-up) = minimum; 1934 -> 2901.
    expect(priceInvoice(PLANS.builder, hours(1000), "2026-03").subtotalCents).toBe(2900);
    expect(priceInvoice(PLANS.builder, hours(1932), "2026-03").subtotalCents).toBe(2900); // 2898
    expect(priceInvoice(PLANS.builder, hours(1933), "2026-03").subtotalCents).toBe(2900); // 2899.5 -> 2900, equal to the minimum
    const above = priceInvoice(PLANS.builder, hours(1934), "2026-03");
    expect(above.subtotalCents).toBe(2901); // one ZCU-hour above the included amount
    expect(above.lines.map((l) => [l.key, l.amountCents])).toEqual([["zcu_hours", 0], ["minimum", 2900], ["usage_above_minimum", 1]]);
    expect(above.lines.reduce((n, l) => n + l.amountCents, 0)).toBe(above.subtotalCents);
  });

  it("Team: $199 minimum, boundary at 13266.67 ZCU-hours, large usage billed in full", () => {
    expect(priceInvoice(PLANS.team, hours(0), "2026-03").subtotalCents).toBe(19900);
    expect(priceInvoice(PLANS.team, hours(13266), "2026-03").subtotalCents).toBe(19900); // 198.99 -> 19899 < minimum
    expect(priceInvoice(PLANS.team, hours(13267), "2026-03").subtotalCents).toBe(19901); // 199.005 -> 19900.5 -> 19901
    expect(priceInvoice(PLANS.team, hours(100_000), "2026-03").subtotalCents).toBe(150_000);
    expect(priceInvoice(PLANS.team, hours(2_000_000), "2026-03").subtotalCents).toBe(3_000_000);
  });

  it("shows ZCU-hours, the rate, the usage charge, the minimum and the amount due on the invoice", () => {
    const priced = priceInvoice(PLANS.builder, hours(4000), "2026-03");
    expect(priced.subtotalCents).toBe(6000);
    const info = priced.lines.find((l) => l.key === "zcu_hours")!;
    expect(info).toMatchObject({ quantity: 4000, unit: "ZCU-hour", unitCents: 1.5, amountCents: 0 });
    expect(info.description).toContain("4000 ZCU-hours");
    expect(info.description).toContain("$0.015 per ZCU-hour");
    expect(info.description).toContain("$60.00 usage charge");
    expect(info.description).toContain("minimum $29.00");
    expect(info.description).toContain("Amount due $60.00");
  });

  it("never charges build minutes or storage: they are listed at zero with their fair-use cap", () => {
    const priced = priceInvoice(PLANS.builder, [
      { meter: "managed_resource_hours", quantity: 10, estimated: false, sources: 1 },
      { meter: "build_minutes", quantity: 9999, estimated: false, sources: 1 },
      { meter: "storage_gb_month", quantity: 9999, estimated: false, sources: 1 },
    ], "2026-03");
    expect(priced.subtotalCents).toBe(2900);
    expect(priced.lines.find((l) => l.key === "build_minutes")).toMatchObject({ amountCents: 0 });
    expect(priced.lines.find((l) => l.key === "build_minutes")!.description).toMatch(/included in the plan.*fair-use cap 2000/);
  });

  it("prices Explore at zero whatever the usage, and refuses to price a contract plan", () => {
    const priced = priceInvoice(PLANS.explore, hours(5000), "2026-03");
    expect(priced.subtotalCents).toBe(0);
    expect(priced.lines.every((l) => l.amountCents === 0)).toBe(true);
    expect(() => priceInvoice(PLANS.enterprise, hours(5000), "2026-03")).toThrow(/billed by contract/);
  });

  it("lists estimated and informational meters at zero: an estimate is never charged", () => {
    const priced = priceInvoice(PLANS.builder, [
      { meter: "egress_gb_estimated", quantity: 80, estimated: true, sources: 1 },
      { meter: "operations_executed", quantity: 12, estimated: false, sources: 1 },
    ], "2026-03");
    expect(priced.lines.filter((l) => l.key !== "minimum").every((l) => l.amountCents === 0)).toBe(true);
    expect(priced.lines.find((l) => l.key === "egress_gb_estimated")?.description).toMatch(/estimate, not charged/);
    expect(priced.subtotalCents).toBe(2900);
  });

  it("is deterministic: the same inputs give the same digest, and a changed quantity changes it", () => {
    const totals = hours(5000);
    const d = priceInvoice(PLANS.builder, totals, "2026-03").digest;
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(priceInvoice(PLANS.builder, totals, "2026-03").digest).toBe(d);
    expect(priceInvoice(PLANS.builder, hours(5001), "2026-03").digest).not.toBe(d);
  });

  it("resolves a legacy plan id to the current plan's price", () => {
    expect(priceInvoice(getPlan("team_provisional"), hours(0), "2026-03").subtotalCents).toBe(2900);
    expect(priceInvoice(getPlan("scale_provisional"), hours(0), "2026-03").subtotalCents).toBe(19900);
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
        { key: "minimum", description: "Builder monthly minimum", quantity: 1, unit: "period", unitCents: 2900, amountCents: 2900 },
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
    expect(seen[2].form.get("description")).toBe("Builder monthly minimum");
    expect(seen[2].form.get("description")).not.toMatch(/provisional/i);
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


describe("billing diagnostic persistence", () => {
  it("refuses recognizable secret material before an account event can reach SQL", async () => {
    let calls = 0;
    const sql = {query: async () => { calls++; return []; }} as unknown as Sql;
    const token = `Bearer ${randomBytes(24).toString("base64url")}`;
    await expect(recordAccountEvent(sql,{workspaceId:"ws-guard",kind:"plan_assigned",actor:"operator",detail:{diagnostic:token}})).rejects.toMatchObject({code:"secret_material"});
    expect(calls).toBe(0);
  });
  it("refuses recognizable secret material before an invoice error can reach SQL", () => {
    let calls = 0;
    const sql = {query: async () => { calls++; return []; }} as unknown as Sql;
    const token = `Bearer ${randomBytes(24).toString("base64url")}`;
    expect(() => recordInvoiceError(sql,"ws-guard","invoice-guard",token)).toThrow();
    expect(calls).toBe(0);
  });
});

describe("plan_feature_unavailable mapping", () => {
  it("is a 402 on both error systems, with a machine-readable feature and a fix that does not say to retry", async () => {
    expect(BACKPRESSURE_STATUS.plan_feature_unavailable).toBe(402);
    expect(BROKER_HTTP_STATUS.plan_feature_unavailable).toBe(402);
    const refusal = new BackpressureError("plan_feature_unavailable", "billing", "Explore does not include deployment.", 3600, "ws_1", { feature: "deploy", fix: "Move this workspace to Builder or a higher plan to deploy." });
    expect(refusal.status).toBe(402);
    expect(backpressureBody(refusal).error).toMatchObject({ code: "plan_feature_unavailable", feature: "deploy", fix: "Move this workspace to Builder or a higher plan to deploy." });
    const res = backpressureResponse(refusal);
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: { code: "plan_feature_unavailable", feature: "deploy" } });
    // the other billing refusals keep their statuses and their generic retry hint
    expect(BACKPRESSURE_STATUS).toMatchObject({ billing_suspended: 402, plan_quota_exceeded: 429, billing_unavailable: 503 });
    expect(backpressureBody(new BackpressureError("plan_quota_exceeded", "billing", "x", 30)).error.fix).toMatch(/retry/);
    const broker = new BrokerError("plan_feature_unavailable", "No org policies.", "Move to Team.", { feature: "org_policies" });
    expect(broker.status).toBe(402);
    expect(errorBody(broker).error).toMatchObject({ code: "plan_feature_unavailable", details: { feature: "org_policies" } });
  });
});
