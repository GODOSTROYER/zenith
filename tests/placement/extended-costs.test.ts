/**
 * PROD-COST-02: cost dimensions beyond the base SKU roles, egress volume tiers,
 * and the refusal to price a dimension the catalog cannot price.
 *
 * Extended dimensions are priced only when the caller supplies the usage and
 * the catalog supplies the price; a supplied usage with no catalog price refuses
 * the estimate (a missing price is never a silent zero).
 */
import { describe, expect, it } from "vitest";
import {
  CostInputError,
  MissingPriceError,
  PlacementCatalogError,
  allExtendedSkus,
  costDimensionCoverage,
  estimateGraphCost,
  extendedSkuFor,
  loadDefaultCatalog,
  parseCatalog,
  solvePlacement,
} from "@/lib/placement";
import { tieredUsd } from "@/lib/placement/cost-model";
import type { PriceCatalog, PriceEntry } from "@/lib/placement";
import { STACK_PLACEMENT_EDGES, node, stackComponents, stackNodes } from "./fixtures";

const base = loadDefaultCatalog();

function withEntries(extra: PriceEntry[], tweak?: (e: PriceEntry) => void): PriceCatalog {
  const copy = JSON.parse(JSON.stringify(base)) as PriceCatalog;
  copy.entries.push(...extra);
  if (tweak) for (const e of copy.entries) tweak(e);
  return parseCatalog(copy);
}

const aws = (region: string): PriceEntry[] => [
  { provider: "aws", region, sku: extendedSkuFor("aws", "egress_inter_az_gb"), unit: "gb", usd: 0.01, verification: "official_api", note: "test price" },
  { provider: "aws", region, sku: extendedSkuFor("aws", "storage_io_million"), unit: "million_requests", usd: 0.2, verification: "official_api", note: "test price" },
  { provider: "aws", region, sku: extendedSkuFor("aws", "backup_cross_region_copy_gb"), unit: "gb", usd: 0.02, verification: "official_api", note: "test price" },
];
const priced = withEntries(aws("us-east-1"));
const graph = { nodes: stackNodes("aws", "us-east-1"), edges: [] };

describe("extended dimensions", () => {
  it("add nothing and change nothing when usage is not supplied, even if the catalog could price them", () => {
    const a = estimateGraphCost(graph, { catalog: base });
    const b = estimateGraphCost(graph, { catalog: priced });
    expect(b.monthlyUsd).toBe(a.monthlyUsd);
    expect(b.lines).toEqual(a.lines);
    expect(b.excluded).toEqual(a.excluded);
    expect(a.excluded.join(" ")).toMatch(/Data transfer between availability zones/);
  });

  it("prices inter-AZ transfer from supplied GB and drops the exclusion note", () => {
    const e = estimateGraphCost(graph, { catalog: priced, usage: { interAzGb: 300 } });
    const line = e.lines.find((l) => l.description === "Inter-availability-zone transfer")!;
    expect(line).toMatchObject({ sku: "aws.data_transfer.inter_az_gb", quantity: 300, monthlyUsd: 3 });
    expect(line.basis).toMatch(/supplied by the caller/);
    expect(e.included.join(" ")).toMatch(/Inter-availability-zone transfer \(usage supplied by the caller\)/);
    expect(e.excluded.join(" ")).not.toMatch(/Data transfer between availability zones/);
  });

  it("splits inter-AZ transfer across compute sites", () => {
    const two = withEntries([...aws("us-east-1"), ...aws("eu-west-1")]);
    const g = { nodes: [...stackNodes("aws", "us-east-1"), node("service/api", "container_service", "aws", "eu-west-1", { size: "small" })], edges: [] };
    const e = estimateGraphCost(g, { catalog: two, usage: { interAzGb: 100 } });
    const lines = e.lines.filter((l) => l.description === "Inter-availability-zone transfer");
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.quantity)).toEqual([50, 50]);
  });

  it("prices storage I/O requests per database, and cross-region backup copy per database", () => {
    const e = estimateGraphCost(graph, { catalog: priced, usage: { storageIoMillions: 10, crossRegionBackupCopyGb: 50 } });
    expect(e.lines.find((l) => l.description === "Storage I/O requests")).toMatchObject({ address: "resource/db", quantity: 10, monthlyUsd: 2 });
    expect(e.lines.find((l) => l.description === "Cross-region backup copy")).toMatchObject({ address: "resource/db", quantity: 50, monthlyUsd: 1 });
    expect(e.included.join(" ")).toMatch(/Storage I\/O request charges/);
    expect(e.included.join(" ")).toMatch(/Cross-region backup copy/);
  });

  it("refuses to estimate a supplied dimension the catalog has no price for", () => {
    expect(() => estimateGraphCost(graph, { catalog: base, usage: { interAzGb: 10 } })).toThrow(MissingPriceError);
    expect(() => estimateGraphCost(graph, { catalog: priced, usage: { interAzGb: 10 } })).not.toThrow();
    // a priced region does not cover another region
    expect(() => estimateGraphCost({ nodes: stackNodes("aws", "eu-west-1") }, { catalog: priced, usage: { interAzGb: 10 } })).toThrow(MissingPriceError);
  });

  it("rejects negative or non-finite extended usage", () => {
    for (const usage of [{ interAzGb: -1 }, { storageIoMillions: Number.NaN }, { crossRegionBackupCopyGb: Infinity }]) {
      expect(() => estimateGraphCost(graph, { catalog: priced, usage })).toThrow(CostInputError);
    }
  });

  it("flows through the solver: an unpriceable dimension rejects every candidate with a price reason and a typed blocker", () => {
    const r = solvePlacement({ components: stackComponents(), edges: STACK_PLACEMENT_EDGES, catalog: base, constraints: { userRegions: ["india"], usage: { interAzGb: 100 } } });
    expect(r.chosen).toBeUndefined();
    expect(r.rejected.some((x) => x.reasons.some((y) => y.startsWith("price:")))).toBe(true);
  });

  it("changes the solver seed only when extended usage is supplied", () => {
    const run = (usage?: { interAzGb?: number }) => solvePlacement({ components: stackComponents(), edges: STACK_PLACEMENT_EDGES, catalog: priced, constraints: { userRegions: ["india"], ...(usage ? { usage } : {}) } }).deterministicSeed;
    expect(run()).toBe(run({}));
    expect(run({ interAzGb: 10 })).not.toBe(run());
  });

  it("every extended SKU follows the documented pattern", () => {
    expect(allExtendedSkus(["aws"])).toEqual(["aws.data_transfer.inter_az_gb", "aws.storage.io_million", "aws.backup.cross_region_copy_gb"]);
  });
});

describe("egress volume tiers", () => {
  const tiers = [{ fromGb: 0, usd: 0.09 }, { fromGb: 1000, usd: 0.08 }, { fromGb: 5000, usd: 0.05 }];
  const tiered = withEntries([], (e) => {
    if (e.provider === "aws" && e.region === "us-east-1" && e.sku === "aws.data_transfer.internet_gb") e.tiers = tiers;
  });
  const g = { nodes: [node("service/web", "container_service", "aws", "us-east-1", { size: "small", publicIp: true })] };

  it("tieredUsd is marginal across boundaries", () => {
    expect(tieredUsd(tiers, 500)).toBeCloseTo(45, 6);
    expect(tieredUsd(tiers, 1000)).toBeCloseTo(90, 6);
    expect(tieredUsd(tiers, 6000)).toBeCloseTo(90 + 4000 * 0.08 + 1000 * 0.05, 6);
    expect(tieredUsd(tiers, 0)).toBe(0);
  });

  it("charges each GB at its tier and reports the blended price", () => {
    const line = estimateGraphCost(g, { catalog: tiered, usage: { egressGb: 6000 } }).lines.find((l) => l.description === "Internet egress")!;
    expect(line.monthlyUsd).toBeCloseTo(90 + 320 + 50, 2);
    expect(line.unitUsd).toBeCloseTo(460 / 6000, 5);
    expect(line.basis).toMatch(/from 1000 GB at USD 0\.08\/GB/);
  });

  it("is identical to the flat price below the first boundary", () => {
    const flat = estimateGraphCost(g, { catalog: base, usage: { egressGb: 500 } });
    const t = estimateGraphCost(g, { catalog: tiered, usage: { egressGb: 500 } });
    expect(t.monthlyUsd).toBe(flat.monthlyUsd);
  });

  it("cross-cloud transfer uses the sender's tiers too", () => {
    const nodes = [node("service/web", "container_service", "aws", "us-east-1", { size: "small" }), node("resource/db", "postgres", "gcp", "us-central1", { size: "small" })];
    const e = estimateGraphCost({ nodes, edges: [{ from: "service/web", to: "resource/db", relation: "publishes_to" }] }, { catalog: tiered, usage: { egressGb: 50000, interComponentFraction: 0.2 } });
    const line = e.lines.find((l) => l.description.startsWith("Cross-cloud transfer"))!;
    expect(line.quantity).toBe(10000);
    expect(line.monthlyUsd).toBeCloseTo(90 + 4000 * 0.08 + 5000 * 0.05, 2);
    expect(line.unitUsd).toBeLessThan(0.09);
  });

  it("catalog validation refuses malformed tier schedules", () => {
    const bad = (tweak: (e: PriceEntry) => void) => {
      const copy = JSON.parse(JSON.stringify(base)) as PriceCatalog;
      tweak(copy.entries.find((e) => e.sku === "aws.data_transfer.internet_gb" && e.region === "us-east-1")!);
      return () => parseCatalog(copy);
    };
    expect(bad((e) => { e.tiers = [{ fromGb: 0, usd: 0.5 }, { fromGb: 10, usd: 0.4 }]; })).toThrow(PlacementCatalogError); // does not start at the entry price
    expect(bad((e) => { e.tiers = [{ fromGb: 0, usd: e.usd }, { fromGb: 10, usd: e.usd + 1 }]; })).toThrow(/must not increase in price/);
    expect(bad((e) => { e.tiers = [{ fromGb: 0, usd: e.usd }, { fromGb: 0, usd: e.usd / 2 }]; })).toThrow(/strictly increasing/);
    expect(bad((e) => { e.unit = "month"; e.tiers = [{ fromGb: 0, usd: e.usd }, { fromGb: 10, usd: e.usd / 2 }]; })).toThrow(/require unit "gb"/);
    expect(bad((e) => { e.tiers = [{ fromGb: 0, usd: e.usd }, { fromGb: 10, usd: e.usd / 2 }]; })).not.toThrow();
  });
});

describe("dimension coverage report", () => {
  const coverage = costDimensionCoverage(base);
  const find = (provider: string, dimension: string) => coverage.find((c) => c.provider === provider && c.dimension === dimension)!;

  it("shows the base dimensions priced for every hyperscaler region", () => {
    for (const provider of ["aws", "gcp", "azure", "oci"]) {
      for (const dimension of ["internet_egress", "nat_hours", "nat_data_processed", "public_ipv4_hours", "object_requests", "backups_and_snapshots", "cross_region_transfer"]) {
        expect(find(provider, dimension).status, `${provider} ${dimension}`).toBe("priced");
      }
    }
  });

  it("states honestly what the bundled catalog does not yet price", () => {
    for (const provider of ["aws", "gcp", "azure", "oci"]) {
      expect(find(provider, "internet_egress_volume_tiers").status).toBe("not_priced");
      expect(find(provider, "inter_az_transfer").status).toBe("not_priced");
      expect(find(provider, "storage_io_requests").status).toBe("not_priced");
      expect(find(provider, "cross_region_backup_copy").status).toBe("not_priced");
    }
  });

  it("marks a dimension partial when only some regions carry it", () => {
    const partial = costDimensionCoverage(priced).find((c) => c.provider === "aws" && c.dimension === "inter_az_transfer")!;
    expect(partial.status).toBe("partial");
    expect(partial.pricedRegions).toEqual(["us-east-1"]);
    expect(partial.missingRegions).toContain("eu-west-1");
  });
});
