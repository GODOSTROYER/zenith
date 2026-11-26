import { mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchComputeArchive, importComputeArchive } from "@/lib/compute-catalog/archive";
import { loadComputeCatalog } from "@/lib/compute-catalog/store";
import type { RawComputeSnapshot } from "@/lib/compute-catalog/types";
import { runComputeCatalogCli } from "../../scripts/cost/compute-catalog";

// Deliberately synthetic rates; these fixtures are never shipped as live pricing.
const NOW = "2026-11-27T00:00:00.000Z";
const options = { version: "fixture.1", generatedAt: NOW };
const env = { ZENITH_LIVE_CATALOG_REFRESH: "1" };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function directory(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), "zenith-compute-archive-")); dirs.push(dir); return dir; }
const reply = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function awsPrices(region: string) {
  return {
    products: { synthetic: { sku: "synthetic", productFamily: "Compute Instance", attributes: {
      instanceType: "m6i.xlarge", regionCode: region, vcpu: "4", memory: "16 GiB", physicalProcessor: "Intel Xeon",
      operatingSystem: "Linux", tenancy: "Shared", preInstalledSw: "NA", capacitystatus: "Used", operation: "RunInstances",
    } } },
    terms: { OnDemand: { synthetic: { current: { effectiveDate: "2026-11-01T00:00:00Z", priceDimensions: {
      hourly: { unit: "Hrs", beginRange: "0", endRange: "Inf", pricePerUnit: { USD: "0.10" } },
    } } } } },
  };
}
const awsTypes = { InstanceTypes: [{ InstanceType: "m6i.xlarge", VCpuInfo: { DefaultVCpus: 4 }, MemoryInfo: { SizeInMiB: 16384 }, ProcessorInfo: { SupportedArchitectures: ["x86_64"] }, BurstablePerformanceSupported: false }] };
function awsFetch(regions = ["us-east-1", "us-west-2"]) {
  return vi.fn<typeof fetch>(async input => {
    const url = String(input);
    if (url.endsWith("region_index.json")) return reply({ regions: Object.fromEntries(regions.map(region => [region, { currentVersionUrl: `/offers/v1.0/aws/AmazonEC2/current/${region}/index.json` }])) });
    return reply(awsPrices(regions.find(region => url.includes(`/${region}/`))!));
  });
}
const inventory = async (region: string, kind: "types" | "offerings") => kind === "types" ? awsTypes : { InstanceTypeOfferings: [{ InstanceType: "m6i.xlarge", LocationType: "region", Location: region }] };

describe("compute snapshot archives and operator commands", () => {
  it("stages provider pages separately, checksums them, and joins all imported AWS regions", async () => {
    const dir = await directory(), archive = join(dir, "aws");
    const manifest = await fetchComputeArchive({ provider: "aws", awsInventory: true }, { env, fetch: awsFetch(), now: () => NOW, awsInventoryPage: inventory }, archive);
    expect(manifest.files).toHaveLength(6);
    expect((await readdir(dir)).sort()).toEqual(["aws"]);
    const catalog = await importComputeArchive(archive, options);
    expect(catalog.coverage[0]).toMatchObject({ regions: ["us-east-1", "us-west-2"], offerCount: 2, pricedOfferCount: 2 });
    expect(catalog.offers.every(offer => offer.offeringState === "offered" && offer.cpuMode === "sustained")).toBe(true);
    await expect(fetchComputeArchive({ provider: "aws" }, { env, fetch: awsFetch(), now: () => NOW }, archive)).rejects.toThrow("already exists");
  });

  it("cleans partial collection and does not publish an archive when a later request fails", async () => {
    const dir = await directory();
    const baseFetch = awsFetch();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => String(input).includes("/us-west-2/") ? new Response("private error", { status: 403 }) : baseFetch(input, init));
    await expect(fetchComputeArchive({ provider: "aws" }, { env, fetch: fetcher, now: () => NOW }, join(dir, "failed"))).rejects.toThrow("HTTP 403");
    expect(await readdir(dir)).toEqual([]);
  });

  it("refuses tampered snapshots and manifest paths outside the archive", async () => {
    const dir = await directory(), archive = join(dir, "aws");
    const manifest = await fetchComputeArchive({ provider: "aws", regions: ["us-east-1"] }, { env, fetch: awsFetch(), now: () => NOW }, archive);
    const snapshot = join(archive, manifest.files[0]!.file);
    await writeFile(snapshot, `${await readFile(snapshot, "utf8")} `);
    await expect(importComputeArchive(archive, options)).rejects.toThrow("checksum mismatch");
    manifest.files[0]!.file = "../outside.json";
    await writeFile(join(archive, "manifest.json"), JSON.stringify(manifest));
    await expect(importComputeArchive(archive, options)).rejects.toThrow();
  });

  it("keeps Local Zone price locations separate and never sends them to a regional SDK endpoint", async () => {
    const dir = await directory(), archive = join(dir, "aws");
    const inventoryPage = vi.fn(inventory);
    await fetchComputeArchive({ provider: "aws", awsInventory: true }, { env, fetch: awsFetch(["us-east-1", "us-east-1-lim-1"]), now: () => NOW, awsInventoryPage: inventoryPage }, archive);
    expect(inventoryPage.mock.calls.every(([region]) => region === "us-east-1")).toBe(true);
    const catalog = await importComputeArchive(archive, options);
    expect(catalog.offers.find(offer => offer.region === "us-east-1-lim-1")?.offeringState).toBe("catalog_only");
  });

  it("refuses an oversized join before reading or parsing its payloads", async () => {
    const dir = await directory(), archive = join(dir, "aws");
    const manifest = await fetchComputeArchive({ provider: "aws", regions: ["us-east-1"], awsInventory: true }, { env, fetch: awsFetch(), now: () => NOW, awsInventoryPage: inventory }, archive);
    // Sparse files exercise the aggregate bound without allocating hundreds of MiB.
    await truncate(join(archive, manifest.files[0]!.file), 300 * 1024 * 1024);
    await truncate(join(archive, manifest.files[1]!.file), 300 * 1024 * 1024);
    await expect(importComputeArchive(archive, options)).rejects.toThrow("join group exceeds");
  });

  it("restricts GCP output regions after joining global inputs and never archives the access token", async () => {
    const dir = await directory(), archive = join(dir, "gcp");
    const fetcher = vi.fn<typeof fetch>(async input => {
      if (String(input).includes("aggregated/machineTypes")) return reply({ items: Object.fromEntries(["us-central1-a", "europe-west1-b"].map(zone => [`zones/${zone}`, { machineTypes: [{ name: "e2-standard-4", guestCpus: 4, memoryMb: 16384, architecture: "X86_64", isSharedCpu: false }] }])) });
      return reply({ skus: ["Core", "Ram"].map(component => ({ skuId: component, description: `E2 Instance ${component} running in Americas`, category: { serviceDisplayName: "Compute Engine", resourceFamily: "Compute", usageType: "OnDemand" }, serviceRegions: ["us-central1", "europe-west1"], pricingInfo: [{ effectiveTime: NOW, pricingExpression: { usageUnit: component === "Core" ? "h" : "GiBy.h", tieredRates: [{ startUsageAmount: 0, unitPrice: { currencyCode: "USD", units: "0", nanos: 10_000_000 } }] } }] })) });
    });
    const manifest = await fetchComputeArchive({ provider: "gcp", gcpProject: "fixture-project", regions: ["us-central1"] }, { env, fetch: fetcher, now: () => NOW, gcpAccessToken: "never-archive-this-token" }, archive);
    const catalog = await importComputeArchive(archive, options);
    expect(catalog.coverage[0]!.regions).toEqual(["us-central1"]);
    expect(catalog.offers).toHaveLength(1);
    expect(catalog.offers[0]!.price?.hourlyUsd).toBe("0.2");
    for (const file of ["manifest.json", ...manifest.files.map(entry => entry.file)]) expect(await readFile(join(archive, file), "utf8")).not.toContain("never-archive-this-token");
  });

  it("runs an offline import-to-recommendation path and preserves the published file on a bad replacement", async () => {
    const dir = await directory(), raw = join(dir, "raw.json"), catalog = join(dir, "catalog.json"), request = join(dir, "request.json");
    const snapshots: RawComputeSnapshot[] = [
      { kind: "aws_ec2_prices", url: "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/us-east-1/index.json", region: "us-east-1", retrievedAt: NOW, data: awsPrices("us-east-1") },
      { kind: "aws_instance_types", url: "https://ec2.us-east-1.amazonaws.com/?Action=DescribeInstanceTypes", region: "us-east-1", retrievedAt: NOW, data: awsTypes },
    ];
    await writeFile(raw, JSON.stringify({ schemaVersion: 1, snapshots }));
    await writeFile(request, JSON.stringify({ minimumVcpus: 4, minimumMemoryMiB: 16384 }));
    const write = vi.fn<(text: string) => void>(), fetcher = vi.fn<typeof fetch>();
    const runtime = { env: {}, fetch: fetcher, now: () => NOW, write };
    await runComputeCatalogCli(["import", "--input", raw, "--version", "fixture.1", "--out", catalog], runtime);
    expect((await loadComputeCatalog(catalog)).offers).toHaveLength(1);
    await runComputeCatalogCli(["recommend", "--catalog", catalog, "--request", request], runtime);
    const result = JSON.parse(write.mock.calls.at(-1)![0]);
    expect(result.chosen).toMatchObject({ monthlyComputeUsd: "73", discoveryOnly: true, weightedRttP95Ms: null });
    expect(fetcher).not.toHaveBeenCalled();
    const previous = await readFile(catalog, "utf8");
    await writeFile(raw, "invalid snapshot");
    await expect(runComputeCatalogCli(["import", "--input", raw, "--version", "bad", "--out", catalog], runtime)).rejects.toThrow();
    expect(await readFile(catalog, "utf8")).toBe(previous);
  });

  it("requires the explicit network gate before reading credentials and rejects unsupported arguments", async () => {
    const runtime = { env: {}, fetch: vi.fn<typeof fetch>(), now: () => NOW, write: vi.fn() };
    await expect(runComputeCatalogCli(["fetch", "--provider", "gcp", "--all-regions", "--out", "/unused", "--gcp-project", "fixture-project", "--gcp-token-file", "/missing"], runtime)).rejects.toThrow("ZENITH_LIVE_CATALOG_REFRESH");
    await expect(runComputeCatalogCli(["fetch", "--token", "do-not-echo"], runtime)).rejects.toThrow("tokens must be provided through files");
    await expect(runComputeCatalogCli(["inspect", "--all-regions"], runtime)).rejects.toThrow("not supported");
    expect(runtime.fetch).not.toHaveBeenCalled();
  });

  it("cannot overwrite raw evidence through a symbolic-link input or output alias", async () => {
    const dir = await directory(), archive = join(dir, "aws"), alias = join(dir, "latest");
    const manifest = await fetchComputeArchive({ provider: "aws", regions: ["us-east-1"] }, { env, fetch: awsFetch(), now: () => NOW }, archive);
    const raw = join(archive, manifest.files[0]!.file), rawAlias = join(dir, "raw-alias.json");
    await symlink(archive, alias, "dir");
    await symlink(raw, rawAlias);
    const original = await readFile(raw, "utf8"), originalManifest = await readFile(join(archive, "manifest.json"), "utf8");
    const runtime = { env: {}, fetch: vi.fn<typeof fetch>(), now: () => NOW, write: vi.fn() };
    await expect(runComputeCatalogCli(["import", "--input", rawAlias, "--version", "bad", "--out", raw], runtime)).rejects.toThrow("must not overwrite");
    await expect(runComputeCatalogCli(["import", "--snapshots", alias, "--version", "bad", "--out", join(archive, "manifest.json")], runtime)).rejects.toThrow("outside its source archive");
    await expect(runComputeCatalogCli(["import", "--snapshots", archive, "--version", "bad", "--out", join(alias, "nested", "catalog.json")], runtime)).rejects.toThrow("outside its source archive");
    expect(await readFile(raw, "utf8")).toBe(original);
    expect(await readFile(join(archive, "manifest.json"), "utf8")).toBe(originalManifest);
  });
});
