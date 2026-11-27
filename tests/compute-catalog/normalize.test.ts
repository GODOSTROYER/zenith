import { describe, expect, it } from "vitest";
import { normalizeComputeSnapshots } from "../../src/lib/compute-catalog/normalize";
import type { ComputeSnapshotKind, RawComputeSnapshot } from "../../src/lib/compute-catalog/types";

// Synthetic native response shapes exercise pricing semantics; these are not live-price fixtures.
const RETRIEVED = "2026-11-25T12:00:00.000Z";
const EFFECTIVE = "2026-11-01T00:00:00.000Z";
const OPTIONS = { version: "fixture-native-v1", generatedAt: "2026-11-26T00:00:00.000Z" };

function snapshot(kind: ComputeSnapshotKind, data: unknown, region?: string, url?: string): RawComputeSnapshot {
  const urls: Record<ComputeSnapshotKind, string> = {
    aws_ec2_prices: "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/20261101/us-west-2/index.json",
    aws_instance_types: "https://ec2.us-west-2.amazonaws.com/?Action=DescribeInstanceTypes",
    aws_instance_offerings: "https://ec2.us-west-2.amazonaws.com/?Action=DescribeInstanceTypeOfferings",
    gcp_machine_types: "https://compute.googleapis.com/compute/v1/projects/fixture/aggregated/machineTypes",
    gcp_skus: "https://cloudbilling.googleapis.com/v1/services/6F81-5844-456A/skus",
    azure_resource_skus: "https://management.azure.com/subscriptions/fixture/providers/Microsoft.Compute/skus?api-version=2021-07-01",
    azure_retail_prices: "https://prices.azure.com/api/retail/prices?currencyCode=USD",
  };
  return { kind, url: url ?? urls[kind], retrievedAt: RETRIEVED, ...(region ? { region } : {}), data };
}

function awsProduct(sku: string, overrides: Record<string, unknown> = {}) {
  return {
    sku, productFamily: "Compute Instance",
    attributes: { instanceType: "m8g.xlarge", regionCode: "us-west-2", vcpu: "4", memory: "16 GiB", operatingSystem: "Linux", tenancy: "Shared", preInstalledSw: "NA", capacitystatus: "Used", physicalProcessor: "AWS Graviton4", operation: "RunInstances", ...overrides },
  };
}

function awsTerm(amount: string, effectiveDate = EFFECTIVE, unit = "Hrs") {
  return { effectiveDate, priceDimensions: { hourly: { unit, beginRange: "0", endRange: "Inf", pricePerUnit: { USD: amount } } } };
}

function awsPrices(entries = [{ product: awsProduct("AWS-A"), term: awsTerm("0.123456789123") }]) {
  return snapshot("aws_ec2_prices", {
    products: Object.fromEntries(entries.map(({ product }) => [product.sku, product])),
    terms: { OnDemand: Object.fromEntries(entries.map(({ product, term }) => [product.sku, { current: term }])) },
  }, "us-west-2");
}

function awsTypes(types = [{ InstanceType: "m8g.xlarge", VCpuInfo: { DefaultVCpus: 4 }, MemoryInfo: { SizeInMiB: 16384 }, ProcessorInfo: { SupportedArchitectures: ["arm64"] }, BurstablePerformanceSupported: false }]) {
  return snapshot("aws_instance_types", { InstanceTypes: types }, "us-west-2");
}

function gcpMachine(name = "e2-standard-4", overrides: Record<string, unknown> = {}) {
  return { name, guestCpus: 4, memoryMb: 16384, architecture: "X86_64", isSharedCpu: false, ...overrides };
}

function gcpMachines(machines = [gcpMachine()], zone = "us-central1-a") {
  return snapshot("gcp_machine_types", { items: { [`zones/${zone}`]: { machineTypes: machines } } });
}

function gcpPriceInfo(nanos: number, unit = "h", effectiveTime = EFFECTIVE) {
  return { effectiveTime, pricingExpression: { usageUnit: unit, tieredRates: [{ startUsageAmount: 0, unitPrice: { currencyCode: "USD", units: "0", nanos } }] } };
}

function gcpSku(skuId: string, component: "Core" | "Ram", nanos: number, overrides: Record<string, unknown> = {}) {
  return {
    skuId, description: `E2 Instance ${component} running in Americas`,
    category: { serviceDisplayName: "Compute Engine", resourceFamily: "Compute", usageType: "OnDemand" },
    serviceRegions: ["us-central1"], pricingInfo: [gcpPriceInfo(nanos, component === "Core" ? "h" : "GiBy.h")], ...overrides,
  };
}

function gcpPrices(skus = [gcpSku("CPU-A", "Core", 20_000_000), gcpSku("RAM-A", "Ram", 3_000_000)]) {
  return snapshot("gcp_skus", { skus });
}

function azureSku(overrides: Record<string, unknown> = {}) {
  return {
    resourceType: "virtualMachines", name: "Standard_D4s_v5", family: "standardDSv5Family", locations: ["eastus"],
    capabilities: [{ name: "vCPUs", value: "4" }, { name: "MemoryGB", value: "16" }, { name: "CpuArchitectureType", value: "x64" }],
    restrictions: [], ...overrides,
  };
}

function azureMeter(overrides: Record<string, unknown> = {}) {
  return {
    serviceName: "Virtual Machines", type: "Consumption", isPrimaryMeterRegion: true, currencyCode: "USD",
    productName: "Virtual Machines Dsv5 Series", skuName: "D4s v5", meterName: "D4s v5", meterId: "AZURE-A",
    armRegionName: "eastus", armSkuName: "Standard_D4s_v5", unitOfMeasure: "1 Hour", tierMinimumUnits: 0,
    retailPrice: 0.192, effectiveStartDate: EFFECTIVE, ...overrides,
  };
}

describe("native compute snapshot normalization", () => {
  it("preserves native AWS names and exact decimal prices without asserting offering inventory", () => {
    const catalog = normalizeComputeSnapshots([awsPrices()], OPTIONS);
    expect(catalog.offers).toHaveLength(1);
    expect(catalog.offers[0]).toMatchObject({ instanceType: "m8g.xlarge", vcpus: 4, memoryMiB: 16384, architecture: "arm64", cpuMode: "unknown", offeringState: "catalog_only", price: { hourlyUsd: "0.123456789123" } });
    expect(catalog.coverage[0]).toMatchObject({ provider: "aws", regions: ["us-west-2"], offerCount: 1, pricedOfferCount: 1, scope: "imported_snapshots" });
    expect(catalog.sources[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("joins AWS authoritative capabilities and zonal offerings while retaining unpriced hardware", () => {
    const catalog = normalizeComputeSnapshots([
      awsPrices(), awsTypes([
        { InstanceType: "m8g.xlarge", VCpuInfo: { DefaultVCpus: 4 }, MemoryInfo: { SizeInMiB: 16384 }, ProcessorInfo: { SupportedArchitectures: ["arm64"] }, BurstablePerformanceSupported: false },
        { InstanceType: "t4g.xlarge", VCpuInfo: { DefaultVCpus: 4 }, MemoryInfo: { SizeInMiB: 16384 }, ProcessorInfo: { SupportedArchitectures: ["arm64"] }, BurstablePerformanceSupported: true },
      ]),
      snapshot("aws_instance_offerings", { InstanceTypeOfferings: [
        { InstanceType: "m8g.xlarge", LocationType: "availability-zone-id", Location: "usw2-az1" },
        { InstanceType: "t4g.xlarge", LocationType: "region", Location: "us-west-2" },
      ] }, "us-west-2"),
    ], OPTIONS);
    expect(catalog.offers.find(o => o.instanceType === "m8g.xlarge")).toMatchObject({ zone: "usw2-az1", cpuMode: "sustained", offeringState: "offered" });
    expect(catalog.offers.find(o => o.instanceType === "t4g.xlarge")).toMatchObject({ cpuMode: "burstable", price: null, offeringState: "offered" });
    expect(catalog.coverage[0]!.pricedOfferCount).toBe(1);
  });

  it("rejects alternate AWS licenses, tenancy, and future prices instead of picking the cheapest row", () => {
    const catalog = normalizeComputeSnapshots([awsPrices([
      { product: awsProduct("BASE"), term: awsTerm("0.2") },
      { product: awsProduct("WINDOWS", { operatingSystem: "Windows" }), term: awsTerm("0.01") },
      { product: awsProduct("DEDICATED", { tenancy: "Dedicated" }), term: awsTerm("0.02") },
      { product: awsProduct("SQL", { preInstalledSw: "SQL Std" }), term: awsTerm("0.03") },
      { product: awsProduct("LICENSE", { operation: "RunInstances:0g00" }), term: awsTerm("0.001") },
      { product: awsProduct("FUTURE"), term: awsTerm("0.001", "2026-12-01T00:00:00.000Z") },
    ])], OPTIONS);
    expect(catalog.offers[0]!.price?.hourlyUsd).toBe("0.2");
  });

  it("leaves conflicting AWS price meters unpriced", () => {
    const catalog = normalizeComputeSnapshots([awsPrices([
      { product: awsProduct("A"), term: awsTerm("0.2") },
      { product: awsProduct("B"), term: awsTerm("0.1") },
    ])], OPTIONS);
    expect(catalog.offers[0]!.price).toBeNull();
    expect(catalog.offers[0]!.warnings.join(" ")).toContain("Conflicting eligible price meters");
  });

  it("compares evidence freshness as instants even when source timestamps have different offsets", () => {
    const older = awsPrices();
    older.retrievedAt = "2026-11-25T12:00:00+02:00";
    const newer = awsPrices();
    newer.retrievedAt = "2026-11-25T11:00:00Z";
    newer.url = newer.url.replace("20261101", "20261102");
    const catalog = normalizeComputeSnapshots([older, newer], OPTIONS);
    expect(catalog.offers[0]!.price?.source.retrievedAt).toBe(newer.retrievedAt);
  });

  it("does not replace a current unsupported AWS tier with an older flat price", () => {
    const catalog = normalizeComputeSnapshots([snapshot("aws_ec2_prices", {
      products: { A: awsProduct("A", { memory: "1,024 GiB" }) },
      terms: { OnDemand: { A: { old: awsTerm("0.1", "2026-10-01T00:00:00.000Z"), current: awsTerm("0.2", EFFECTIVE, "Requests") } } },
    }, "us-west-2")], OPTIONS);
    expect(catalog.offers[0]!.memoryMiB).toBe(1_048_576);
    expect(catalog.offers[0]!.price).toBeNull();
  });

  it("composes GCP CPU and RAM rates using native CPU/memory quantities and exact arithmetic", () => {
    const catalog = normalizeComputeSnapshots([gcpMachines(), gcpPrices()], OPTIONS);
    expect(catalog.offers[0]).toMatchObject({ instanceType: "e2-standard-4", region: "us-central1", zone: "us-central1-a", vcpus: 4, memoryMiB: 16384, offeringState: "offered", cpuMode: "sustained", price: { hourlyUsd: "0.128", nativeSku: "CPU-A+RAM-A" } });
  });

  it("retains unsupported, shared-core, and custom GCP shapes without applying standard CPU rates", () => {
    const catalog = normalizeComputeSnapshots([gcpMachines([
      gcpMachine("e2-standard-4"), gcpMachine("e2-medium", { guestCpus: 2, memoryMb: 4096, isSharedCpu: true }),
      gcpMachine("e2-custom-4-16384"), gcpMachine("a3-highgpu-8g", { guestCpus: 208, memoryMb: 1_916_928 }),
    ]), gcpPrices()], OPTIONS);
    expect(catalog.offers).toHaveLength(4);
    expect(catalog.offers.filter(o => o.price !== null)).toHaveLength(1);
    expect(catalog.offers.find(o => o.instanceType === "e2-medium")!.cpuMode).toBe("shared");
    expect(catalog.coverage[0]!.warnings.join(" ")).toContain("3 native GCP offers");
  });

  it("chooses the latest effective GCP component version and excludes future/committed meters", () => {
    const cpu = gcpSku("CPU-A", "Core", 1, { pricingInfo: [
      gcpPriceInfo(10_000_000, "h", "2026-10-01T00:00:00.000Z"), gcpPriceInfo(20_000_000),
      gcpPriceInfo(1, "h", "2026-12-01T00:00:00.000Z"),
    ] });
    const committed = gcpSku("CPU-CUD", "Core", 1, { category: { serviceDisplayName: "Compute Engine", resourceFamily: "Compute", usageType: "Commit1Yr" } });
    const catalog = normalizeComputeSnapshots([gcpMachines(), gcpPrices([cpu, gcpSku("RAM-A", "Ram", 3_000_000), committed])], OPTIONS);
    expect(catalog.offers[0]!.price?.hourlyUsd).toBe("0.128");
    expect(catalog.offers[0]!.price?.effectiveAt).toBe(EFFECTIVE);
  });

  it("never treats absent GCP RAM or ambiguous CPU components as zero", () => {
    for (const skus of [
      [gcpSku("CPU-A", "Core", 20_000_000)],
      [gcpSku("CPU-A", "Core", 20_000_000), gcpSku("CPU-B", "Core", 10_000_000), gcpSku("RAM-A", "Ram", 3_000_000)],
    ]) {
      const catalog = normalizeComputeSnapshots([gcpMachines(), gcpPrices(skus)], OPTIONS);
      expect(catalog.offers[0]!.price).toBeNull();
      expect(catalog.coverage[0]!.pricedOfferCount).toBe(0);
    }
  });

  it("does not fall back to historical GCP components when the current unit is unsupported", () => {
    const cpu = gcpSku("CPU-A", "Core", 1, { pricingInfo: [
      gcpPriceInfo(10_000_000, "h", "2026-10-01T00:00:00.000Z"), gcpPriceInfo(20_000_000, "s"),
    ] });
    const catalog = normalizeComputeSnapshots([gcpMachines(), gcpPrices([cpu, gcpSku("RAM-A", "Ram", 3_000_000)])], OPTIONS);
    expect(catalog.offers[0]!.price).toBeNull();
    expect(catalog.offers[0]!.warnings.join(" ")).toContain("no historical price was substituted");
  });

  it("uses the older retrieval time when GCP components came from separate snapshots", () => {
    const ram = gcpPrices([gcpSku("RAM-A", "Ram", 3_000_000)]);
    ram.url += "?pageToken=ram";
    ram.retrievedAt = "2026-11-20T00:00:00.000Z";
    const cpu = gcpPrices([gcpSku("CPU-A", "Core", 20_000_000)]);
    cpu.data = { ...(cpu.data as Record<string, unknown>), nextPageToken: "ram" };
    const catalog = normalizeComputeSnapshots([gcpMachines(), cpu, ram], OPTIONS);
    expect(catalog.offers[0]!.price?.source.retrievedAt).toBe(ram.retrievedAt);
    expect(catalog.sources).toHaveLength(3);
  });

  it("does not infer GCP architecture from a family name", () => {
    const catalog = normalizeComputeSnapshots([gcpMachines([gcpMachine("t2a-standard-4", { architecture: undefined })])], OPTIONS);
    expect(catalog.offers[0]!.architecture).toBe("unknown");
  });

  it("does not advertise obsolete GCP machine types as deployable offerings", () => {
    const catalog = normalizeComputeSnapshots([gcpMachines([
      gcpMachine("e2-standard-4", { deprecated: { state: "OBSOLETE" } }),
      gcpMachine("n2-standard-4", { deprecated: { state: "DEPRECATED" } }),
    ])], OPTIONS);
    expect(catalog.offers.find(o => o.instanceType === "e2-standard-4")!.offeringState).toBe("catalog_only");
    expect(catalog.offers.find(o => o.instanceType === "n2-standard-4")!.offeringState).toBe("offered");
    expect(catalog.offers[0]!.warnings.join(" ")).toContain("OBSOLETE");
  });

  it("joins Azure capabilities and excludes Windows, Spot, reservations, and nonprimary meters", () => {
    const catalog = normalizeComputeSnapshots([
      snapshot("azure_resource_skus", { value: [azureSku()] }),
      snapshot("azure_retail_prices", { Items: [
        azureMeter(), azureMeter({ meterId: "WINDOWS", productName: "Virtual Machines Dsv5 Series Windows", retailPrice: 0.01 }),
        azureMeter({ meterId: "SPOT", skuName: "D4s v5 Spot", retailPrice: 0.001 }),
        azureMeter({ meterId: "RESERVED", type: "Reservation", retailPrice: 0.02 }),
        azureMeter({ meterId: "SECONDARY", isPrimaryMeterRegion: false, retailPrice: 0.01 }),
      ] }),
    ], OPTIONS);
    expect(catalog.offers[0]).toMatchObject({ instanceType: "Standard_D4s_v5", vcpus: 4, memoryMiB: 16384, architecture: "x86_64", cpuMode: "sustained", offeringState: "offered", price: { hourlyUsd: "0.192" } });
  });

  it("retains constrained CPUs, native ARM architecture, and location-specific Azure restrictions", () => {
    const catalog = normalizeComputeSnapshots([
      snapshot("azure_resource_skus", { value: [azureSku({
        capabilities: [{ name: "vCPUs", value: "8" }, { name: "vCPUsAvailable", value: "4" }, { name: "MemoryGB", value: "16" }, { name: "CpuArchitectureType", value: "Arm64" }],
        locationInfo: [{ location: "eastus", zones: ["1", "2"] }],
        restrictions: [{ type: "Zone", restrictionInfo: { locations: ["eastus"], zones: ["1"] } }],
      })] }), snapshot("azure_retail_prices", { Items: [azureMeter()] }),
    ], OPTIONS);
    expect(catalog.offers).toHaveLength(2);
    expect(catalog.offers.find(o => o.zone === "1")).toMatchObject({ vcpus: 4, architecture: "arm64", offeringState: "catalog_only" });
    expect(catalog.offers.find(o => o.zone === "2")).toMatchObject({ offeringState: "offered", price: { hourlyUsd: "0.192" } });
  });

  it("leaves an Azure shape unpriced when current meters conflict or use an unsupported unit", () => {
    for (const meters of [
      [azureMeter(), azureMeter({ meterId: "B", retailPrice: 0.1 })],
      [azureMeter({ effectiveStartDate: "2026-10-01T00:00:00.000Z" }), azureMeter({ unitOfMeasure: "100 Hours" })],
    ]) {
      const catalog = normalizeComputeSnapshots([snapshot("azure_resource_skus", { value: [azureSku()] }), snapshot("azure_retail_prices", { Items: meters })], OPTIONS);
      expect(catalog.offers[0]!.price).toBeNull();
    }
  });

  it("does not guess Azure hardware from retail SKU names", () => {
    const catalog = normalizeComputeSnapshots([snapshot("azure_retail_prices", { Items: [azureMeter()] })], OPTIONS);
    expect(catalog.offers).toEqual([]);
    expect(catalog.coverage[0]).toMatchObject({ regions: ["eastus"], offerCount: 0, pricedOfferCount: 0 });
    expect(catalog.coverage[0]!.warnings.join(" ")).toContain("lacked ARM capability inventory");
  });

  it("allows complete native pagination and rejects missing first pages, tails, or cycles", () => {
    const first = snapshot("gcp_skus", { skus: [], nextPageToken: "two" });
    const second = snapshot("gcp_skus", { skus: [] }, undefined, first.url + "?pageToken=two");
    expect(normalizeComputeSnapshots([first, second], OPTIONS).sources).toHaveLength(2);
    expect(() => normalizeComputeSnapshots([first], OPTIONS)).toThrow(/Incomplete pagination/);
    expect(() => normalizeComputeSnapshots([second], OPTIONS)).toThrow(/after the first page/);
    second.data = { skus: [], nextPageToken: "two" };
    expect(() => normalizeComputeSnapshots([first, second], OPTIONS)).toThrow(/cycle/);
  });

  it("rejects partial-success GCP responses and malformed native envelopes", () => {
    expect(() => normalizeComputeSnapshots([snapshot("gcp_machine_types", { items: { "zones/us-central1-a": { warning: { code: "UNREACHABLE" } } } })], OPTIONS)).toThrow(/Incomplete GCP/);
    expect(() => normalizeComputeSnapshots([snapshot("azure_resource_skus", { wrong: [] })], OPTIONS)).toThrow(/value array/);
    expect(() => normalizeComputeSnapshots([snapshot("aws_ec2_prices", { error: { message: "Unauthorized" } })], OPTIONS)).toThrow(/API error/);
  });

  it("refuses inconsistent native hardware instead of choosing the first snapshot", () => {
    const inconsistent = awsPrices([{ product: awsProduct("A", { vcpu: "8" }), term: awsTerm("0.1") }]);
    expect(() => normalizeComputeSnapshots([awsTypes(), inconsistent], OPTIONS)).toThrow(/hardware records disagree/);
  });

  it("rejects credential-bearing source URLs and retrieval timestamps after generation", () => {
    const data = awsPrices();
    data.url += "?api_key=never-store-this";
    expect(() => normalizeComputeSnapshots([data], OPTIONS)).toThrow(/credentials/);
    const future = awsPrices();
    future.retrievedAt = "2026-12-01T00:00:00.000Z";
    expect(() => normalizeComputeSnapshots([future], OPTIONS)).toThrow(/retrieval/);
  });

  it("produces stable coverage, source provenance, and offer ordering across input order", () => {
    const snapshots = [awsPrices(), awsTypes(), gcpMachines(), gcpPrices(), snapshot("azure_resource_skus", { value: [azureSku()] }), snapshot("azure_retail_prices", { Items: [azureMeter()] })];
    const first = normalizeComputeSnapshots(snapshots, OPTIONS);
    const second = normalizeComputeSnapshots([...snapshots].reverse(), OPTIONS);
    expect(first).toEqual(second);
    expect(first.coverage.map(c => [c.provider, c.offerCount, c.pricedOfferCount])).toEqual([["aws", 1, 1], ["gcp", 1, 1], ["azure", 1, 1]]);
    for (const offer of first.offers) {
      expect(first.sources).toContainEqual(offer.specSource);
      if (offer.price) expect(first.sources).toContainEqual(offer.price.source);
    }
  });
});
