/** Hand-built API-shape contracts, not downloaded prices or live acceptance. */
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/controlplane/digest";
import { normalizeGcp, normalizeAzure, normalizeOci, type SnapshotEntry } from "@/lib/placement/catalog-refresh";
import { refreshFromSnapshots } from "@/lib/placement/catalog-refresh/refresh";
import { dryRunCatalogRefresh } from "@/lib/cost/catalog-dry-run";
import { loadDefaultCatalog } from "@/lib/placement/pricebook";
import { join } from "node:path";
import { readFileSync } from "node:fs";

function snapshot(provider: SnapshotEntry["provider"], service: string, region?: string): SnapshotEntry {
  return { provider, service, ...(region ? { region } : {}), format: provider === "gcp" ? "gcp_billing_catalog" : provider === "azure" ? "azure_retail_prices" : "oci_price_list", url: "https://example.invalid/prices", retrievedAt: "2026-10-08", sha256: sha256Hex("fixture"), bytes: 7, file: "fixture.json" };
}
const gcp = (description: string, price: number, usageUnit: string, extra = {}) => ({ description, category: { usageType: "OnDemand" }, serviceRegions: ["us-central1"], pricingInfo: [{ pricingExpression: { usageUnit, tieredRates: [{ startUsageAmount: 0, unitPrice: { currencyCode: "USD", units: "0", nanos: Math.round(price * 1e9) } }] } }], ...extra });
const oci = (displayName: string, metricName: string, value: number) => ({ displayName, metricName, currencyCodeLocalizations: [{ currencyCode: "USD", prices: [{ model: "PAY_AS_YOU_GO", value, rangeMin: 0 }] }] });

describe("compute and PostgreSQL catalog rules", () => {
  it("derives all E2 shapes only from on-demand region-matching CPU and memory", () => {
    const cpu = gcp("E2 Instance Core running in Americas", 0.02, "h");
    const ram = gcp("E2 Instance Ram running in Americas", 0.003, "GiBy.h");
    const result = normalizeGcp(JSON.stringify({ skus: [cpu, ram, gcp(cpu.description, 0.001, "h", { category: { usageType: "Commit1Yr" } })] }), snapshot("gcp", "Compute Engine", "us-central1"), { regions: [] });
    expect(result.observations.find(o => o.sku === "gcp.compute_engine.small_hour")?.usd).toBeCloseTo(0.016);
    expect(result.observations.find(o => o.sku === "gcp.compute_engine.large_hour")?.usd).toBeCloseTo(0.064);
    const missing = normalizeGcp(JSON.stringify({ skus: [cpu] }), snapshot("gcp", "Compute Engine", "us-central1"), { regions: [] });
    expect(missing.observations.filter(o => o.sku.includes("compute_engine"))).toHaveLength(0);
    expect(missing.skipped.some(s => s.sku === "gcp.compute_engine.small_hour" && s.reason.includes("component"))).toBe(true);
  });
  it("derives zonal PostgreSQL shapes and excludes HA, other engines and editions", () => {
    const cpu = gcp("Cloud SQL for PostgreSQL: Zonal - vCPU in Americas", 0.04, "h");
    const ram = gcp("Cloud SQL for PostgreSQL: Zonal - RAM in Americas", 0.007, "GiBy.h");
    const result = normalizeGcp(JSON.stringify({ skus: [cpu, ram, gcp("Cloud SQL for PostgreSQL: Regional - vCPU in Americas", 0.08, "h"), gcp("Cloud SQL for MySQL: Zonal - vCPU in Americas", 0.01, "h")] }), snapshot("gcp", "Cloud SQL", "us-central1"), { regions: [] });
    expect(result.observations.find(o => o.sku === "gcp.cloud_sql_postgres.standard_hour")?.usd).toBeCloseTo(0.1325);
    const ambiguous = normalizeGcp(JSON.stringify({ skus: [cpu, ram, gcp(cpu.description, 0.05, "h")] }), snapshot("gcp", "Cloud SQL", "us-central1"), { regions: [] });
    expect(ambiguous.observations.filter(o => o.sku.includes("_hour"))).toHaveLength(0);
  });
  it("selects exact Azure Linux and flexible PostgreSQL shapes, refusing ambiguous meters", () => {
    const vm = { serviceName: "Virtual Machines", productName: "Virtual Machines BS Series", armSkuName: "Standard_B1ms", skuName: "B1ms", meterName: "B1ms", currencyCode: "USD", armRegionName: "eastus", type: "Consumption", unitOfMeasure: "1 Hour", retailPrice: 0.02 };
    const pg = { ...vm, serviceName: "Azure Database for PostgreSQL", productName: "Azure Database for PostgreSQL Flexible Server Burstable BS Series" };
    const s = snapshot("azure", "Virtual Machines", "eastus");
    const result = normalizeAzure(JSON.stringify({ Items: [vm, pg, { ...vm, productName: `${vm.productName} Windows`, retailPrice: 0.03 }, { ...vm, type: "Reservation", retailPrice: 0.001 }] }), s, { regions: [] });
    expect(result.observations.find(o => o.sku === "azure.vm.small_hour")?.usd).toBe(0.02);
    expect(result.observations.find(o => o.sku === "azure.postgres_flexible.nano_hour")?.usd).toBe(0.02);
    const bad = normalizeAzure(JSON.stringify({ Items: [vm, { ...vm, retailPrice: 0.04, skuName: "conflict" }] }), s, { regions: [] });
    expect(bad.skipped.find(x => x.sku === "azure.vm.small_hour")?.reason).toMatch(/ambiguous/);
  });
  it("converts OCI OCPU plus memory shapes and PostgreSQL minimum capacity in every requested region", () => {
    const cpu = oci("Compute - Standard - E4", "OCPU Per Hour", 0.025);
    const ram = oci("Compute - Standard - E4 - Memory", "GB Per Hour", 0.0015);
    const pg = oci("Database with PostgreSQL", "OCPU Per Hour", 0.098);
    const result = normalizeOci(JSON.stringify({ items: [cpu, ram, pg] }), snapshot("oci", "OCI public price list"), { regions: ["us-ashburn-1", "ap-mumbai-1"] });
    for (const region of ["us-ashburn-1", "ap-mumbai-1"]) {
      expect(result.observations.find(o => o.sku === "oci.compute.large_hour" && o.region === region)?.usd).toBeCloseTo(0.037);
      expect(result.observations.find(o => o.sku === "oci.postgres.performance_hour" && o.region === region)?.usd).toBeCloseTo(0.392);
    }
    const missing = normalizeOci(JSON.stringify({ items: [{ ...cpu, metricName: "ECPU Per Hour" }, ram] }), snapshot("oci", "OCI public price list"), { regions: ["us-ashburn-1"] });
    expect(missing.observations.some(o => o.sku.startsWith("oci.compute."))).toBe(false);
  });
  it("dry-runs saved checksummed files without changing them or the base catalog", () => {
    const directory = join(process.cwd(), "tests/cost/fixtures/price-snapshots");
    const manifest = readFileSync(join(directory, "manifest.json"), "utf8");
    const base = loadDefaultCatalog();
    const before = JSON.stringify(base);
    const result = dryRunCatalogRefresh(base, directory, "2026-10-08.1");
    expect(result).toMatchObject({ dryRun: true, adoptionRequired: true });
    expect(result.catalog.version).toBe("2026-10-08.1");
    expect(JSON.stringify(base)).toBe(before);
    expect(readFileSync(join(directory, "manifest.json"), "utf8")).toBe(manifest);
  });
  it("normalizes CPU and memory on separate checked pages and keeps both original checksums", () => {
    const pages = [gcp("E2 Instance Core running in Americas", 0.02, "h"), gcp("E2 Instance Ram running in Americas", 0.003, "GiBy.h")].map((sku, i) => {
      const text = JSON.stringify({ skus: [sku] });
      return { text, entry: { ...snapshot("gcp", "Compute Engine", "us-central1"), file: `page-${i}.json`, sha256: sha256Hex(text), bytes: Buffer.byteLength(text) } };
    });
    const result = refreshFromSnapshots({ base: loadDefaultCatalog(), snapshots: pages, version: "2026-10-08.2" });
    const entry = result.catalog.entries.find(e => e.provider === "gcp" && e.region === "us-central1" && e.sku === "gcp.compute_engine.small_hour")!;
    expect(entry.usd).toBeCloseTo(0.016);
    for (const page of pages) expect(entry.note).toContain(page.entry.sha256);
    expect(result.catalog.snapshots).toHaveLength(2);
    expect(() => refreshFromSnapshots({ base: loadDefaultCatalog(), snapshots: [{ ...pages[1]!, text: pages[0]!.text }, pages[0]!], version: "2026-10-08.3" })).toThrow(/SHA-256|bytes/);
  });
});
