/**
 * The price catalog is a product promise: every number names where it came
 * from, none is negative, and every region the solver may choose has a price
 * for every cost role it uses. These tests pin the structure, and pin a few
 * figures that were verified against provider price feeds on 2026-09-30.
 */
import { describe, expect, it } from "vitest";
import { SIZE_SPECS as LEGACY_SIZE_SPECS } from "@/lib/cost/pricing";
import {
  MissingPriceError,
  NATIVE_TYPES,
  PlacementCatalogError,
  SIZE_SPECS,
  SKU_ROLES,
  SKU_ROLE_MAP,
  buildPriceBook,
  catalogSnapshotAt,
  knownRegions,
  loadDefaultCatalog,
  nativeTypeFor,
  parseCatalog,
  regionInfo,
  skuFor,
  verificationSummary,
} from "@/lib/placement";
import type { PriceCatalog } from "@/lib/placement";
import rawJson from "@/lib/placement/catalog/2026-10.json";
import historicalJson from "@/lib/placement/catalog/2026-09.json";

const catalog = loadDefaultCatalog();
const book = buildPriceBook(catalog);

const REQUIRED_REGIONS: Record<string, string[]> = {
  aws: ["ap-south-1", "ap-southeast-1", "us-east-1", "eu-west-1"],
  gcp: ["asia-south1", "asia-southeast1", "us-central1", "europe-west1"],
  azure: ["centralindia", "southeastasia", "eastus", "westeurope"],
  oci: ["ap-mumbai-1", "ap-singapore-1", "us-ashburn-1"],
};

function clone(): PriceCatalog {
  return JSON.parse(JSON.stringify(rawJson)) as PriceCatalog;
}

describe("catalog contents", () => {
  it("has the pinned version and validates", () => {
    expect(catalog.version).toBe("2026-10-05.2");
    expect(loadDefaultCatalog()).toBe(catalog); // cached
    expect(parseCatalog(rawJson)).toEqual(catalog);
  });

  it("covers every required provider and region, plus the zenith managed tier", () => {
    for (const [provider, regions] of Object.entries(REQUIRED_REGIONS)) {
      for (const r of regions) expect(book.regions(provider), provider + " regions").toContain(r);
    }
    expect(book.providers()).toContain("zenith");
    expect(book.regions("zenith").length).toBeGreaterThan(0);
  });

  it("gives every entry a verification class and a matching source with an official URL, date and transcription note", () => {
    const covered = new Set(catalog.sources.map((s) => s.provider + "|" + s.verification));
    for (const e of catalog.entries) {
      expect(e.verification, e.sku + " verification").toBeDefined();
      expect(covered.has(e.provider + "|" + e.verification), e.provider + "/" + e.region + "/" + e.sku + " has a source").toBe(true);
    }
    for (const s of catalog.sources) {
      expect(s.url).toMatch(/^https:\/\//);
      expect(["2026-09-30", "2026-10-05"]).toContain(s.retrievedAt);
      expect(s.source.length).toBeGreaterThan(80);
      if (s.verification !== "internal_assumption") expect(s.source).toMatch(/transcribed/i);
      if (s.verification === "model_knowledge") {
        expect(s.source).toMatch(/model knowledge/i);
        expect(s.source).toMatch(/refreshed/i);
      }
      if (s.verification === "internal_assumption") expect(s.source).toMatch(/assumption/i);
    }
  });

  it("has no negative, NaN or infinite prices and no duplicate entries", () => {
    const seen = new Set<string>();
    for (const e of catalog.entries) {
      expect(Number.isFinite(e.usd)).toBe(true);
      expect(e.usd).toBeGreaterThanOrEqual(0);
      const id = e.provider + "|" + e.region + "|" + e.sku;
      expect(seen.has(id)).toBe(false);
      seen.add(id);
      if (e.unit === "ratio") expect(e.usd).toBeGreaterThanOrEqual(1);
    }
  });

  it("has every provider/region in the latency table, and every latency-table region priced", () => {
    for (const p of book.providers()) {
      for (const r of book.regions(p)) expect(regionInfo(p, r), p + "/" + r + " in latency table").toBeDefined();
    }
    for (const ri of knownRegions()) expect(book.regions(ri.provider), ri.provider + "/" + ri.region + " in catalog").toContain(ri.region);
  });

  it("prices every cost role each provider defines, in every region, with no orphan SKUs", () => {
    const used = new Set<string>();
    for (const provider of book.providers()) {
      expect(Object.keys(SKU_ROLE_MAP[provider] ?? {}).length).toBeGreaterThan(20);
      for (const region of book.regions(provider)) {
        for (const role of SKU_ROLES) {
          const sku = skuFor(provider, role);
          if (!sku) continue;
          used.add(sku);
          expect(book.has(provider, region, sku), provider + "/" + region + " " + role + " -> " + sku).toBe(true);
        }
      }
    }
    for (const e of catalog.entries) expect(used.has(e.sku), "catalog sku " + e.sku + " is mapped to a role").toBe(true);
  });

  it("has the cost roles the brief lists for each hyperscaler", () => {
    const required = [
      "container_vcpu_hour", "container_gb_hour", "vm_small_hour", "vm_medium_hour", "vm_large_hour",
      "pg_small_hour", "pg_standard_hour", "pg_ha_multiplier", "pg_storage_gb_month", "pg_backup_gb_month",
      "cache_small_hour", "object_storage_gb_month", "object_get_million", "object_put_million", "queue_requests_million",
      "lb_hour", "nat_hour", "nat_gb", "ipv4_hour", "egress_internet_gb", "egress_inter_region_gb",
      "block_gb_month", "block_iops_month", "dns_zone_month", "dns_queries_million", "cert_month", "logs_ingest_gb",
    ] as const;
    for (const p of ["aws", "gcp", "azure", "oci"]) for (const role of required) expect(skuFor(p, role), p + " " + role).toBeDefined();
    // load balancers meter capacity units (AWS, Azure, OCI) or processed GB (GCP)
    for (const p of ["aws", "azure", "oci"]) expect(skuFor(p, "lb_capacity_unit_hour")).toBeDefined();
    expect(skuFor("gcp", "lb_processed_gb")).toBeDefined();
  });

  it("pins figures verified against provider price feeds on 2026-09-30", () => {
    expect(book.price("aws", "us-east-1", "aws.fargate.vcpu_hour")).toBe(0.04048);
    expect(book.price("aws", "us-east-1", "aws.fargate.gb_hour")).toBe(0.004445);
    expect(book.price("aws", "us-east-1", "aws.nat_gateway.hour")).toBe(0.045);
    expect(book.price("aws", "ap-south-1", "aws.nat_gateway.hour")).toBe(0.056);
    expect(book.price("aws", "us-east-1", "aws.alb.hour")).toBe(0.0225);
    expect(book.price("aws", "us-east-1", "aws.ipv4.hour")).toBe(0.005);
    expect(book.price("aws", "us-east-1", "aws.rds_postgres.small_hour")).toBe(0.032);
    expect(book.price("aws", "ap-southeast-1", "aws.data_transfer.internet_gb")).toBe(0.12);
    expect(book.find("aws", "us-east-1", "aws.fargate.vcpu_hour")?.verification).toBe("official_api");
    expect(book.price("azure", "eastus", "azure.public_ip.hour")).toBe(0.005);
    expect(book.price("oci", "us-ashburn-1", "oci.object_storage.storage_gb_month")).toBe(0.0255);
  });

  it("labels weaker evidence honestly: remembered, derived and internal numbers are not counted as verified", () => {
    const v = verificationSummary(catalog);
    expect(v.official_api).toBeGreaterThan(200);
    expect(v.model_knowledge).toBeGreaterThan(0);
    expect(v.internal_assumption).toBeGreaterThan(0);
    expect(v.derived).toBeGreaterThan(0);
    expect(book.find("gcp", "asia-south1", "gcp.cloud_sql_postgres.small_hour")?.verification).toBe("derived");
    expect(book.find("azure", "eastus", "azure.nat_gateway.hour")?.verification).toBe("model_knowledge");
    expect(book.find("zenith", "us-east", "zenith.container.vcpu_hour")?.verification).toBe("internal_assumption");
    // the snapshot time is the retrieval date, never the wall clock
    expect(catalogSnapshotAt(catalog)).toBe("2026-10-05T00:00:00.000Z");
  });
});

describe("bounded October catalog refresh", () => {
  it("preserves every untouched September entry and source without relabeling evidence", () => {
    const historical = parseCatalog(historicalJson);
    expect(historical.version).toBe("2026-09-30.1");
    expect(catalog.sources.slice(0, historical.sources.length)).toEqual(historical.sources);
    expect(catalog.entries).toHaveLength(historical.entries.length + 36);
    const touched = catalog.entries.slice(0, historical.entries.length).filter((entry, index) => JSON.stringify(entry) !== JSON.stringify(historical.entries[index]));
    expect(touched).toHaveLength(8);
    expect([...new Set(touched.map((entry) => entry.sku))].sort()).toEqual(["aws.acm.public_cert_month", "azure.public_ip.hour"]);
    expect(catalog.sources.filter((source) => source.retrievedAt === "2026-10-05")).toHaveLength(8);
  });

  it("pins the exact regional Standard IPv4 meter and separates effective date from retrieval", () => {
    for (const region of REQUIRED_REGIONS.azure!) {
      const entry = book.find("azure", region, "azure.public_ip.hour")!;
      expect(entry.usd).toBe(0.005);
      expect(entry.unit).toBe("hour");
      expect(entry.verification).toBe("official_api");
      expect(entry.note).toContain("2026-10-05");
      expect(entry.note).toContain("effectiveStartDate 2018-06-01T00:00:00Z");
      expect(entry.note).toContain("Standard IPv4 Static Public IP");
    }
    const source = catalog.sources.find((entry) => entry.provider === "azure" && entry.retrievedAt === "2026-10-05")!;
    expect(source.url).toBe("https://prices.azure.com/api/retail/prices");
    expect(source.source).toContain("priceType Consumption");
  });

  it("records verified certificate zero only for non-exportable integrated ACM usage", () => {
    for (const region of REQUIRED_REGIONS.aws!) {
      const entry = book.find("aws", region, "aws.acm.public_cert_month")!;
      expect(entry.usd).toBe(0);
      expect(entry.verification).toBe("official_page");
      expect(entry.note).toContain("Non-exportable");
      expect(entry.note).toContain("Exportable, ACME and Private CA not covered");
    }
    expect(book.find("azure", "eastus", "azure.nat_gateway.hour")?.verification).toBe("model_knowledge");
  });
});

describe("native auxiliary price cohort", () => {
  it("pins only the 36 new regional secret, build, registry and log-storage entries", () => {
    const added = catalog.entries.slice(historicalJson.entries.length);
    expect(added).toHaveLength(36);
    expect([...new Set(added.map((entry) => entry.sku))].sort()).toEqual([
      "aws.cloudwatch.logs_storage_gb_month", "aws.codebuild.medium_hour", "aws.ecr.storage_gb_month",
      "aws.secretsmanager.requests_million", "aws.secretsmanager.secret_month", "azure.key_vault.secret_requests_million",
      "gcp.secret_manager.access_requests_million", "gcp.secret_manager.active_version_month", "gcp.secret_manager.rotation_notification",
    ]);
    for (const entry of added) {
      expect(entry.verification).toMatch(/^official_(api|page)$/);
      expect(entry.note).toContain("2026-10-05");
    }
    for (const region of REQUIRED_REGIONS.aws!) {
      expect(book.price("aws", region, "aws.secretsmanager.secret_month")).toBe(0.4);
      expect(book.price("aws", region, "aws.secretsmanager.requests_million")).toBe(5);
      expect(book.price("aws", region, "aws.codebuild.medium_hour")).toBe(0.6);
      expect(book.price("aws", region, "aws.ecr.storage_gb_month")).toBe(0.1);
      expect(book.price("aws", region, "aws.cloudwatch.logs_storage_gb_month")).toBe(0.03);
      expect(book.find("aws", region, "aws.codebuild.medium_hour")?.note).toContain("Build-Min:Linux:g1.medium");
    }
  });

  it("preserves per-location GCP version units and exact Standard Azure operation meters", () => {
    for (const region of REQUIRED_REGIONS.gcp!) {
      expect(book.price("gcp", region, "gcp.secret_manager.active_version_month")).toBe(0.06);
      expect(book.price("gcp", region, "gcp.secret_manager.access_requests_million")).toBe(3);
      expect(book.price("gcp", region, "gcp.secret_manager.rotation_notification")).toBe(0.05);
      expect(book.find("gcp", region, "gcp.secret_manager.active_version_month")?.note).toContain("effective date not published");
    }
    for (const region of REQUIRED_REGIONS.azure!) {
      const entry = book.find("azure", region, "azure.key_vault.secret_requests_million")!;
      expect(entry.usd).toBe(3); expect(entry.unit).toBe("million_requests");
      expect(entry.note).toContain("Standard Operations 10K");
      expect(entry.note).toContain("effectiveStartDate 2015-08-01");
    }
    expect(skuFor("oci", "secret_requests_million")).toBeUndefined();
    expect(skuFor("zenith", "secret_requests_million")).toBeUndefined();
  });
});

describe("catalog validation rejects bad catalogs", () => {
  it("rejects a negative price", () => {
    const c = clone();
    c.entries[0]!.usd = -1;
    expect(() => parseCatalog(c)).toThrow(PlacementCatalogError);
  });

  it("rejects an entry whose verification class has no source", () => {
    const c = clone();
    c.sources = c.sources.filter((s) => !(s.provider === "aws" && s.verification === "official_api"));
    expect(() => parseCatalog(c)).toThrow(/no matching source/);
  });

  it("rejects a source without a transcription note, a non-https URL, or a bad date", () => {
    const a = clone();
    a.sources[0]!.source = "AWS Price List Bulk API values, verified live with high confidence across every region we could reach.";
    expect(() => parseCatalog(a)).toThrow(/transcribed/);
    const b = clone();
    b.sources[0]!.url = "http://aws.amazon.com/pricing/";
    expect(() => parseCatalog(b)).toThrow(PlacementCatalogError);
    const d = clone();
    d.sources[0]!.retrievedAt = "30/09/2026";
    expect(() => parseCatalog(d)).toThrow(PlacementCatalogError);
  });

  it.each(["2026-02-30", "2026-13-01", "0000-01-01"])("rejects impossible retrieval and version date %s", (date) => {
    const source = clone();
    source.sources[0]!.retrievedAt = date;
    expect(() => parseCatalog(source)).toThrow(PlacementCatalogError);
    const version = clone();
    version.version = `${date}.1`;
    expect(() => parseCatalog(version)).toThrow(PlacementCatalogError);
  });

  it("refuses retrieval dates after the snapshot identity but accepts a real leap day", () => {
    const future = clone();
    future.sources[0]!.retrievedAt = "2026-10-06";
    expect(() => parseCatalog(future)).toThrow(/after the catalog version date/);
    const leap = clone();
    leap.sources[0]!.retrievedAt = "2024-02-29";
    expect(parseCatalog(leap).sources[0]!.retrievedAt).toBe("2024-02-29");
  });

  it("rejects duplicates, sku/provider mismatch, misused ratios, unknown fields and a bad version", () => {
    const dup = clone();
    dup.entries.push({ ...dup.entries[0]! });
    expect(() => parseCatalog(dup)).toThrow(/duplicate entry/);
    const mismatch = clone();
    mismatch.entries[0]!.sku = "gcp.fargate.vcpu_hour";
    expect(() => parseCatalog(mismatch)).toThrow(/must start with its provider/);
    const ratio = clone();
    const r = ratio.entries.find((e) => e.unit === "ratio")!;
    r.usd = 0.5;
    expect(() => parseCatalog(ratio)).toThrow(/multiplier/);
    const extra = clone() as PriceCatalog & { entries: Record<string, unknown>[] };
    extra.entries[0]!.surprise = 1;
    expect(() => parseCatalog(extra)).toThrow(PlacementCatalogError);
    const ver = clone();
    ver.version = "latest";
    expect(() => parseCatalog(ver)).toThrow(/version/);
  });

  it("reports every problem, and a missing price is an error, never a silent zero", () => {
    const c = clone();
    c.entries[0]!.usd = -1;
    c.entries[1]!.usd = Number.NaN;
    try {
      parseCatalog(c);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PlacementCatalogError);
      expect((e as PlacementCatalogError).issues.length).toBeGreaterThanOrEqual(2);
    }
    expect(() => book.price("aws", "us-east-1", "aws.nope.hour")).toThrow(MissingPriceError);
    expect(book.find("aws", "mars-1", "aws.fargate.vcpu_hour")).toBeUndefined();
  });
});

describe("capability table and sizes", () => {
  it("shares Level-2 native type names with the resource model", () => {
    expect(nativeTypeFor("aws", "container_service")).toBe("aws:ecs_service");
    expect(nativeTypeFor("gcp", "container_service")).toBe("gcp:cloud_run_service");
    expect(nativeTypeFor("azure", "container_service")).toBe("azure:container_app");
    expect(nativeTypeFor("oci", "container_service")).toBe("oci:container_instance");
    expect(nativeTypeFor("aws", "postgres")).toBe("aws:rds_postgres");
    expect(nativeTypeFor("zenith", "compute_instance")).toBeUndefined();
    for (const [provider, map] of Object.entries(NATIVE_TYPES)) {
      for (const native of Object.values(map)) expect(native, provider).toMatch(/^[a-z0-9]+:[A-Za-z0-9_]+$/);
    }
  });

  it("uses exactly the legacy nano/small/standard/performance vCPU and memory table", () => {
    expect(SIZE_SPECS).toEqual(LEGACY_SIZE_SPECS);
  });
});
