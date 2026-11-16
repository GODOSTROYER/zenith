/**
 * The latency and geography tables are approximate by design; these tests pin
 * their structure (complete, symmetric, sane ordering) so an edit cannot
 * silently break the solver's latency and residency logic.
 */
import { describe, expect, it } from "vitest";
import {
  CROSS_CLOUD_SAME_METRO_MS,
  GEOS,
  LATENCY_TABLE_SOURCE,
  P95_FACTOR,
  USER_REGIONS,
  estimateP95Ms,
  geoRttMs,
  knownRegions,
  normalizeResidencyToken,
  normalizeUserRegion,
  regionInfo,
  regionSatisfiesResidency,
  regionToRegionRttMs,
  userToRegionRttMs,
} from "@/lib/placement";

describe("latency table", () => {
  it("has an entry for every pair of geographies, symmetric, with same-geo faster than any other", () => {
    for (const a of GEOS) {
      for (const b of GEOS) {
        const ab = geoRttMs(a, b);
        expect(ab).toBeGreaterThan(0);
        expect(geoRttMs(b, a)).toBe(ab);
        if (a !== b) expect(ab).toBeGreaterThan(geoRttMs(a, a));
      }
    }
  });

  it("orders regions sensibly for the spec's user regions", () => {
    expect(userToRegionRttMs("india", "aws", "ap-south-1")).toBeLessThan(userToRegionRttMs("india", "aws", "ap-southeast-1"));
    expect(userToRegionRttMs("india", "aws", "ap-southeast-1")).toBeLessThan(userToRegionRttMs("india", "aws", "eu-west-1"));
    expect(userToRegionRttMs("singapore", "gcp", "asia-southeast1")).toBeLessThan(userToRegionRttMs("singapore", "gcp", "asia-south1"));
    expect(userToRegionRttMs("europe", "azure", "westeurope")).toBeLessThan(userToRegionRttMs("europe", "azure", "eastus"));
    expect(userToRegionRttMs("us-east", "oci", "us-ashburn-1")).toBeLessThan(userToRegionRttMs("us-east", "oci", "ap-mumbai-1"));
  });

  it("is labelled approximate, with a p95 factor", () => {
    expect(LATENCY_TABLE_SOURCE).toMatch(/Approximate/);
    expect(LATENCY_TABLE_SOURCE).toMatch(/not measured/);
    expect(estimateP95Ms(60)).toBe(Math.round(60 * P95_FACTOR));
  });

  it("charges at least 10 ms for a cross-cloud hop in the same metro and the table figure otherwise", () => {
    expect(regionToRegionRttMs({ provider: "aws", region: "ap-south-1" }, { provider: "azure", region: "centralindia" })).toBeGreaterThanOrEqual(CROSS_CLOUD_SAME_METRO_MS);
    expect(regionToRegionRttMs({ provider: "aws", region: "ap-south-1" }, { provider: "gcp", region: "asia-southeast1" })).toBe(geoRttMs("india", "singapore"));
    expect(regionToRegionRttMs({ provider: "aws", region: "us-east-1" }, { provider: "aws", region: "us-east-1" })).toBe(1);
    expect(regionToRegionRttMs({ provider: "aws", region: "ap-south-1" }, { provider: "aws", region: "eu-west-1" })).toBe(geoRttMs("india", "europe-west"));
  });

  it("rejects unknown regions instead of inventing a number", () => {
    expect(() => userToRegionRttMs("india", "aws", "mars-1")).toThrow(/Unknown region/);
    expect(() => regionToRegionRttMs({ provider: "aws", region: "mars-1" }, { provider: "aws", region: "us-east-1" })).toThrow(/Unknown region/);
  });

  it("normalizes user region names and aliases", () => {
    expect(normalizeUserRegion(" India ")).toBe("india");
    expect(normalizeUserRegion("EU")).toBe("europe");
    expect(normalizeUserRegion("us_east")).toBe("us-east");
    expect(normalizeUserRegion("atlantis")).toBeUndefined();
    for (const u of USER_REGIONS) expect(normalizeUserRegion(u)).toBe(u);
  });
});

describe("region geography and residency", () => {
  it("maps every known region to a geography, a country and at least one zone", () => {
    for (const r of knownRegions()) {
      expect(GEOS).toContain(r.geo);
      expect(r.country).toMatch(/^[A-Z]{2}$/);
      expect(r.zones).toBeGreaterThanOrEqual(1);
      expect(r.residencyTags.length).toBeGreaterThan(0);
    }
  });

  it("records the single-availability-domain OCI regions honestly", () => {
    expect(regionInfo("oci", "ap-mumbai-1")?.zones).toBe(1);
    expect(regionInfo("oci", "us-ashburn-1")?.zones).toBe(3);
    expect(regionInfo("aws", "us-east-1")?.zones).toBeGreaterThanOrEqual(3);
  });

  it("matches residency by country, name and grouping, ignoring case and separators", () => {
    const mumbai = regionInfo("aws", "ap-south-1")!;
    const ireland = regionInfo("aws", "eu-west-1")!;
    const belgium = regionInfo("gcp", "europe-west1")!;
    const virginia = regionInfo("aws", "us-east-1")!;
    expect(regionSatisfiesResidency(mumbai, ["India"])).toBe(true);
    expect(regionSatisfiesResidency(mumbai, ["IN"])).toBe(true);
    expect(regionSatisfiesResidency(mumbai, ["EU"])).toBe(false);
    expect(regionSatisfiesResidency(ireland, ["EU"])).toBe(true);
    expect(regionSatisfiesResidency(ireland, ["European_Union"])).toBe(true);
    expect(regionSatisfiesResidency(belgium, ["eea"])).toBe(true);
    expect(regionSatisfiesResidency(belgium, ["ireland"])).toBe(false);
    expect(regionSatisfiesResidency(virginia, ["United States"])).toBe(true);
    expect(regionSatisfiesResidency(virginia, ["india", "eu"])).toBe(false);
    expect(regionSatisfiesResidency(virginia, undefined)).toBe(true);
    expect(regionSatisfiesResidency(virginia, [])).toBe(true);
    expect(normalizeResidencyToken("  European_Union ")).toBe("european union");
  });
});
