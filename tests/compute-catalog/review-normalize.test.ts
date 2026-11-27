import { describe, expect, it } from "vitest";
import { normalizeComputeSnapshots } from "../../src/lib/compute-catalog/normalize";
import type { RawComputeSnapshot } from "../../src/lib/compute-catalog/types";

const RETRIEVED = "2026-11-25T12:00:00.000Z";
const OPTIONS = { version: "review-native-v1", generatedAt: "2026-11-26T00:00:00.000Z" };

function awsInventoryAndPrice(): RawComputeSnapshot[] {
  return [
    {
      kind: "aws_instance_types", region: "us-west-2", retrievedAt: RETRIEVED,
      url: "https://ec2.us-west-2.amazonaws.com/?Action=DescribeInstanceTypes",
      data: { InstanceTypes: [{ InstanceType: "m5.xlarge", VCpuInfo: { DefaultVCpus: 4 }, MemoryInfo: { SizeInMiB: 16384 }, ProcessorInfo: { SupportedArchitectures: ["x86_64"] }, BurstablePerformanceSupported: false }] },
    },
    {
      kind: "aws_ec2_prices", region: "us-west-2", retrievedAt: RETRIEVED,
      url: "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/us-west-2/index.json",
      data: {
        products: { REGIONAL: { sku: "REGIONAL", productFamily: "Compute Instance", attributes: { instanceType: "m5.xlarge", regionCode: "us-west-2", vcpu: "4", memory: "16 GiB", operatingSystem: "Linux", tenancy: "Shared", preInstalledSw: "NA", capacitystatus: "Used", operation: "RunInstances" } } },
        terms: { OnDemand: { REGIONAL: { current: { effectiveDate: "2026-11-01T00:00:00.000Z", priceDimensions: { hourly: { unit: "Hrs", beginRange: "0", endRange: "Inf", pricePerUnit: { USD: "0.192" } } } } } } },
      },
    },
  ];
}

function gcpInventory(warning?: string, zonal = false): RawComputeSnapshot {
  const machine = { name: "e2-standard-4", guestCpus: 4, memoryMb: 16384, isSharedCpu: false, architecture: "X86_64" };
  return {
    kind: "gcp_machine_types", retrievedAt: RETRIEVED,
    url: `https://compute.googleapis.com/compute/v1/projects/review/${zonal ? "zones/us-central1-a" : "aggregated"}/machineTypes`,
    data: {
      kind: zonal ? "compute#machineTypeList" : "compute#machineTypeAggregatedList",
      items: zonal ? [machine] : { "zones/us-central1-a": { machineTypes: [machine] } },
      ...(warning ? { warning: { code: warning } } : {}),
    },
  };
}

describe("provider normalization review regressions", () => {
  it("retains Local, Wavelength, and unknown AWS zones without applying parent-region prices", () => {
    // AWS documents both ordinary and Local Zones under a parent region, but their prices differ:
    // https://docs.aws.amazon.com/local-zones/latest/ug/available-local-zones.html
    // https://docs.aws.amazon.com/local-zones/latest/ug/what-is-aws-local-zones.html
    const locations = [
      ["availability-zone-id", "usw2-az1", true],
      ["availability-zone", "us-west-2a", true],
      ["availability-zone-id", "usw2-lax1-az1", false],
      ["availability-zone", "us-west-2-lax-1a", false],
      ["availability-zone-id", "usw2-wl1-las1-wlz1", false],
      ["availability-zone", "us-west-2-wl1-las-wlz-1", false],
      ["availability-zone-id", "unknown-zone", false],
      ["availability-zone", "future-zone", false],
    ] as const;
    const catalog = normalizeComputeSnapshots([
      ...awsInventoryAndPrice(),
      {
        kind: "aws_instance_offerings", region: "us-west-2", retrievedAt: RETRIEVED,
        url: "https://ec2.us-west-2.amazonaws.com/?Action=DescribeInstanceTypeOfferings",
        data: { InstanceTypeOfferings: locations.map(([LocationType, Location]) => ({ InstanceType: "m5.xlarge", LocationType, Location })) },
      },
    ], OPTIONS);
    expect(catalog.offers).toHaveLength(locations.length);
    for (const [, zone, regionalPrice] of locations) {
      const offer = catalog.offers.find(candidate => candidate.zone === zone)!;
      expect(offer.offeringState).toBe("offered");
      if (regionalPrice) expect(offer.price?.hourlyUsd).toBe("0.192");
      else {
        expect(offer.price).toBeNull();
        expect(offer.warnings.join(" ")).toContain("parent-region prices");
      }
    }
    expect(catalog.coverage[0]!.pricedOfferCount).toBe(2);
  });

  it("continues to price an AWS regional offering from its exact regional meter", () => {
    const catalog = normalizeComputeSnapshots([
      ...awsInventoryAndPrice(),
      {
        kind: "aws_instance_offerings", region: "us-west-2", retrievedAt: RETRIEVED,
        url: "https://ec2.us-west-2.amazonaws.com/?Action=DescribeInstanceTypeOfferings",
        data: { InstanceTypeOfferings: [{ InstanceType: "m5.xlarge", LocationType: "region", Location: "us-west-2" }] },
      },
    ], OPTIONS);
    expect(catalog.offers[0]).toMatchObject({ offeringState: "offered", price: { hourlyUsd: "0.192" } });
    expect(catalog.offers[0]!.zone).toBeUndefined();
  });

  it.each(["PARTIAL_SUCCESS", "UNREACHABLE"])("rejects a top-level GCP %s warning during offline import", warning => {
    // The native list response has a top-level warning as well as scoped warnings.
    // https://docs.cloud.google.com/compute/docs/reference/rest/v1/machineTypes/aggregatedList
    for (const zonal of [false, true]) {
      expect(() => normalizeComputeSnapshots([gcpInventory(warning, zonal)], OPTIONS)).toThrow(/Incomplete GCP machine inventory/);
    }
  });

  it("accepts native GCP empty pages with NO_RESULTS_ON_PAGE", () => {
    for (const zonal of [false, true]) {
      const snapshot = gcpInventory("NO_RESULTS_ON_PAGE", zonal);
      const data = snapshot.data as Record<string, unknown>;
      delete data.items;
      expect(normalizeComputeSnapshots([snapshot], OPTIONS).offers).toEqual([]);
    }
  });

  it.each([
    ["Standard_D2", "standardDFamily", "sustained"],
    ["Standard_B2s", "standardBSFamily", "burstable"],
    ["Standard_Z2", "standardZFutureFamily", "unknown"],
  ] as const)("classifies native Azure CPU behavior for %s", (name, family, expectedMode) => {
    // Bare family names are native values; they need no version/suffix before Family.
    // https://learn.microsoft.com/en-us/rest/api/batchmanagement/location/list-supported-virtual-machine-skus
    const snapshot: RawComputeSnapshot = {
      kind: "azure_resource_skus", retrievedAt: RETRIEVED,
      url: "https://management.azure.com/subscriptions/review/providers/Microsoft.Compute/skus?api-version=2021-07-01",
      data: { value: [{
        resourceType: "virtualMachines", name, family, locations: ["eastus"], restrictions: [],
        capabilities: [{ name: "vCPUs", value: "2" }, { name: "MemoryGB", value: "7" }, { name: "CpuArchitectureType", value: "x64" }],
      }] },
    };
    expect(normalizeComputeSnapshots([snapshot], OPTIONS).offers[0]!.cpuMode).toBe(expectedMode);
  });
});
