/**
 * Billing configuration (PROD-MAN-06). Leaf module: reads only the env object it is given.
 *
 *   ZENITH_BILLING                         disabled | managed          (default: disabled)
 *   ZENITH_BILLING_STRIPE_SECRET_KEY       Stripe TEST-mode secret or restricted key (sk_test_ / rk_test_). A live key is refused.
 *   ZENITH_BILLING_STRIPE_WEBHOOK_SECRET   signing secret of the webhook endpoint (whsec_...)
 *   ZENITH_BILLING_STRIPE_API_BASE         test seam only: honoured for http://127.0.0.1 or http://localhost, ignored otherwise
 *   ZENITH_BILLING_GRACE_DAYS              days after an invoice is due before nonpayment suspends NEW work (default 14, 0..90)
 *   ZENITH_BILLING_NET_DAYS                days from invoice creation until it is due (default 14, 1..90)
 *
 * `disabled` is the default and the mode every BYOC and self-hosted install runs in: no metering, no quota, no
 * invoice, no webhook, no suspension. An unknown value of ZENITH_BILLING is treated as `disabled` and reported in
 * `issues`: a typo must never switch suspension on. The keys are read from the environment at the one call site that
 * needs them and are never logged or stored.
 */
export type Env = Readonly<Record<string, string | undefined>>;

export type BillingMode = "disabled" | "managed";

export interface BillingConfig {
  mode: BillingMode;
  graceDays: number;
  netDays: number;
  stripe: { secretKeyConfigured: boolean; webhookSecretConfigured: boolean; apiBase: string };
  issues: string[];
}

export const STRIPE_API_BASE = "https://api.stripe.com";
const TEST_KEY = /^(?:sk|rk)_test_[A-Za-z0-9]{8,200}$/;

export const isStripeTestKey = (key: string): boolean => TEST_KEY.test(key);

function whole(env: Env, name: string, fallback: number, min: number, max: number, issues: string[]): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {
    issues.push(`${name} must be a whole number from ${min} to ${max}; using ${fallback}`);
    return fallback;
  }
  return n;
}

export function billingConfigFromEnv(env: Env = process.env): BillingConfig {
  const issues: string[] = [];
  const raw = env.ZENITH_BILLING?.trim().toLowerCase();
  let mode: BillingMode = "disabled";
  if (raw === "managed") mode = "managed";
  else if (raw !== undefined && raw !== "" && raw !== "disabled") issues.push("ZENITH_BILLING must be disabled or managed; using disabled");

  const key = env.ZENITH_BILLING_STRIPE_SECRET_KEY?.trim();
  let secretKeyConfigured = false;
  if (key) {
    if (isStripeTestKey(key)) secretKeyConfigured = true;
    else issues.push("ZENITH_BILLING_STRIPE_SECRET_KEY is not a Stripe test-mode key (sk_test_ or rk_test_); live keys are refused and invoicing stays off");
  }
  let apiBase = STRIPE_API_BASE;
  const base = env.ZENITH_BILLING_STRIPE_API_BASE?.trim();
  if (base) {
    try {
      const url = new URL(base);
      if (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) apiBase = url.origin;
      else issues.push("ZENITH_BILLING_STRIPE_API_BASE is only honoured for http://127.0.0.1 or http://localhost; ignoring it");
    } catch { issues.push("ZENITH_BILLING_STRIPE_API_BASE is not a URL; ignoring it"); }
  }
  return {
    mode,
    graceDays: whole(env, "ZENITH_BILLING_GRACE_DAYS", 14, 0, 90, issues),
    netDays: whole(env, "ZENITH_BILLING_NET_DAYS", 14, 1, 90, issues),
    stripe: { secretKeyConfigured, webhookSecretConfigured: Boolean(env.ZENITH_BILLING_STRIPE_WEBHOOK_SECRET?.trim()), apiBase },
    issues,
  };
}

/** True only in `managed` mode. Every billing entry point checks this FIRST and does no other work when it is false. */
export const billingEnabled = (env: Env = process.env): boolean => billingConfigFromEnv(env).mode === "managed";
