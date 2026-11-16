/**
 * LIVE ACCEPTANCE HARNESS (PROD-COST-01). Skipped, and reported as skipped with
 * the reason in the test title, unless the operator opts in. A skipped test is
 * NEVER evidence: live cloud acceptance is deferred by the user and these cases
 * have not been run against a real account.
 *
 * Billing reads (per provider P in AWS, GCP, AZURE, OCI):
 *   ZENITH_LIVE_P=1
 *   ZENITH_LIVE_P_BILLING_CREDENTIALS_FILE=<absolute path to a JSON credentials file>
 *   ZENITH_LIVE_P_BILLING_SCOPE=<account id | project.dataset.table | /subscriptions/<id> | tenancy OCID>
 *   ZENITH_LIVE_BILLING_PERIOD_START=YYYY-MM-DD   (inclusive; default: first of last month)
 *   ZENITH_LIVE_BILLING_PERIOD_END=YYYY-MM-DD     (exclusive; default: first of this month)
 * (OCI additionally needs `region` inside its credentials file.)
 *
 * Catalog download (public endpoints, no cloud account):
 *   ZENITH_LIVE_CATALOG_REFRESH=1
 *
 * Each case only READS: one billing query, or public price files saved to a temp
 * directory. Nothing is created, changed or deleted in any account.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { billingGate, createLiveBillingReader } from "@/lib/cost/billing";
import { BILLING_PROVIDERS, assertActualSpend, type BillingProvider } from "@/lib/cost/kinds";
import { fetchOfficialSnapshots, refreshGateOpen } from "@/lib/cost/catalog-fetch";
import { loadSnapshotDirectory, normalizeOci } from "@/lib/placement/catalog-refresh";
import { scopeSkipReason } from "../../scripts/release/scope";

const env = process.env;

function defaultPeriod(): { start: string; end: string } {
  const now = new Date();
  const first = (y: number, m: number) => new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  return { start: env.ZENITH_LIVE_BILLING_PERIOD_START ?? first(now.getUTCFullYear(), now.getUTCMonth() - 1), end: env.ZENITH_LIVE_BILLING_PERIOD_END ?? first(now.getUTCFullYear(), now.getUTCMonth()) };
}

describe("live provider billing reads", () => {
  for (const provider of BILLING_PROVIDERS as readonly BillingProvider[]) {
    const gate = billingGate(provider, env);
    const scope = env[`ZENITH_LIVE_${provider.toUpperCase()}_BILLING_SCOPE`];
    // PROD-REL-04: an approved scope manifest that grants billing-live is required before any live read; a refusal is an explicit skip.
    const scopeRefusal = gate.open && scope ? scopeSkipReason("billing-live", provider) : "";
    const reason = !gate.open ? gate.reason : !scope ? `ZENITH_LIVE_${provider.toUpperCase()}_BILLING_SCOPE is not set` : scopeRefusal || undefined;
    it.skipIf(reason !== undefined)(`${provider}: reads actual spend for the period${reason ? ` (SKIPPED: ${reason})` : ""}`, async () => {
      const period = defaultPeriod();
      const reader = await createLiveBillingReader(provider, { env });
      const spend = await reader.read({ provider, scope: scope!, periodStart: period.start, periodEnd: period.end });
      assertActualSpend(spend);
      expect(spend.provider).toBe(provider);
      expect(spend.currency).toBe("USD");
      expect(spend.source.responseSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(spend.lines.reduce((s, l) => s + l.usd, 0)).toBeCloseTo(spend.totalUsd, 4);
    }, 120_000);
  }
});

describe("live catalog download", () => {
  const gate = refreshGateOpen(env);
  const reason = gate.open ? undefined : gate.reason;
  it.skipIf(reason !== undefined)(`downloads the OCI public price list, verifies its checksum and normalizes it${reason ? ` (SKIPPED: ${reason})` : ""}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "zenith-live-catalog-"));
    try {
      const manifest = await fetchOfficialSnapshots({ providers: ["oci"], regions: {}, outDir: dir }, { env, fetch, today: new Date().toISOString().slice(0, 10) });
      expect(manifest.snapshots).toHaveLength(1);
      const [loaded] = loadSnapshotDirectory(dir);
      const out = normalizeOci(loaded!.text, loaded!.entry, { regions: ["us-ashburn-1"] });
      expect(out.observations.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
