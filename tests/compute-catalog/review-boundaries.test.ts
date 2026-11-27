import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchComputeArchive } from "@/lib/compute-catalog/archive";
import { parseComputeCatalog, parseRawComputeSnapshots, saveComputeCatalog } from "@/lib/compute-catalog/store";
import type { ComputeCatalog, ComputeProvider, ComputeSnapshotKind, SourceEvidence } from "@/lib/compute-catalog/types";
import { runComputeCatalogCli } from "../../scripts/cost/compute-catalog";
import { COMPUTE_SCOPE_SUBSCRIPTION, writeComputeScopeFixture } from "./scope-fixture";

const NOW = "2026-11-27T00:00:00.000Z";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zenith-compute-boundaries-"));
  dirs.push(dir);
  return dir;
}
function evidence(url = "https://pricing.us-east-1.amazonaws.com/example.json"): SourceEvidence {
  return { kind: "aws_ec2_prices", url, retrievedAt: NOW };
}
function catalog(source = evidence()): ComputeCatalog {
  return {
    schemaVersion: 1, version: "boundary-fixture", generatedAt: NOW, sources: [source], warnings: [],
    coverage: [{ provider: "aws", regions: ["us-east-1"], offerCount: 1, pricedOfferCount: 1, scope: "imported_snapshots", warnings: [] }],
    offers: [{ id: "aws-fixture", provider: "aws", region: "us-east-1", instanceType: "m6i.xlarge", vcpus: 4, memoryMiB: 16384,
      architecture: "x86_64", cpuMode: "sustained", operatingSystem: "linux", tenancy: "shared", purchaseModel: "on_demand",
      price: { hourlyUsd: "0.1", source }, specSource: source, offeringState: "catalog_only", warnings: [] }],
  };
}
const rawEnvelope = (source: SourceEvidence) => ({ schemaVersion: 1, snapshots: [{
  ...source, region: "us-east-1", data: { products: {}, terms: { OnDemand: {} } },
}] });
function providerCatalog(provider: ComputeProvider): ComputeCatalog {
  const specKinds: Record<ComputeProvider, ComputeSnapshotKind> = { aws: "aws_instance_types", gcp: "gcp_machine_types", azure: "azure_resource_skus" };
  const priceKinds: Record<ComputeProvider, ComputeSnapshotKind> = { aws: "aws_ec2_prices", gcp: "gcp_skus", azure: "azure_retail_prices" };
  const region = { aws: "us-east-1", gcp: "us-central1", azure: "eastus" }[provider];
  const instanceType = { aws: "m6i.xlarge", gcp: "n2-standard-4", azure: "Standard_D4s_v5" }[provider];
  const spec: SourceEvidence = { kind: specKinds[provider], url: `https://example.test/${provider}/specifications`, retrievedAt: NOW };
  const price: SourceEvidence = { kind: priceKinds[provider], url: `https://example.test/${provider}/prices`, retrievedAt: NOW };
  const result = catalog();
  result.sources = [spec, price];
  result.coverage[0]!.provider = provider;
  result.coverage[0]!.regions = [region];
  result.offers[0] = { ...result.offers[0]!, provider, region, instanceType, specSource: spec, price: { hourlyUsd: "0.1", source: price } };
  return result;
}

describe("reviewed compute evidence boundaries", () => {
  it.each(["aws", "gcp", "azure"] as const)("requires %s prices to cite pricing evidence rather than inventory", (provider) => {
    const input = providerCatalog(provider);
    expect(parseComputeCatalog(input).offers).toHaveLength(1);
    input.offers[0]!.price!.source = input.offers[0]!.specSource;
    expect(() => parseComputeCatalog(input)).toThrow("price requires");
  });

  it.each(["gcp", "azure"] as const)("requires native hardware evidence for %s instead of a billing-only source", (provider) => {
    const input = providerCatalog(provider);
    input.offers[0]!.specSource = input.offers[0]!.price!.source;
    expect(() => parseComputeCatalog(input)).toThrow("hardware requires");
  });

  it("keeps AWS price-list hardware fallback but refuses offering-only hardware evidence", () => {
    expect(parseComputeCatalog(catalog()).offers).toHaveLength(1);
    const input = providerCatalog("aws");
    input.offers[0]!.specSource.kind = "aws_instance_offerings";
    expect(() => parseComputeCatalog(input)).toThrow("hardware requires");
  });

  it.each([
    "refresh_token", "id_token", "authToken", "session-token", "clientAssertion", "auth", "X-Amz-Credential", "API_KEY", "%72efresh%5Ftoken",
  ])("refuses credential query alias %s in raw and published evidence", (key) => {
    const source = evidence(`https://pricing.us-east-1.amazonaws.com/example.json?${key}=synthetic-private-value`);
    expect(() => parseRawComputeSnapshots(rawEnvelope(source))).toThrow("Source must be HTTPS");
    expect(() => parseComputeCatalog(catalog(source))).toThrow("Source must be HTTPS");
  });

  it.each([
    ["aws_instance_types", "https://ec2.us-east-1.amazonaws.com/?Action=DescribeInstanceTypes&NextToken=opaque%2Bcursor"],
    ["gcp_machine_types", "https://compute.googleapis.com/compute/v1/projects/test-project/aggregated/machineTypes?pageToken=opaque%2Bcursor"],
    ["azure_resource_skus", "https://management.azure.com/subscriptions/1234/providers/Microsoft.Compute/skus?api-version=2021-07-01&%24skiptoken=opaque%2Bcursor"],
  ])("retains the native continuation evidence for %s", (kind, url) => {
    expect(parseRawComputeSnapshots({ schemaVersion: 1, snapshots: [{ kind, url, retrievedAt: NOW, data: {} }] })[0]!.url).toBe(url);
  });

  it("preserves the published catalog when an operator import contains an OAuth refresh token", async () => {
    const dir = await directory(), input = join(dir, "raw.json"), output = join(dir, "catalog.json");
    await saveComputeCatalog(catalog(), output);
    const previous = await readFile(output, "utf8");
    await writeFile(input, JSON.stringify(rawEnvelope(evidence("https://pricing.us-east-1.amazonaws.com/example.json?refresh_token=synthetic-private-value"))));
    const runtime = { env: {}, fetch: vi.fn<typeof fetch>(), now: () => NOW, write: vi.fn() };
    await expect(runComputeCatalogCli(["import", "--input", input, "--version", "rejected", "--out", output], runtime)).rejects.toThrow("Source must be HTTPS");
    expect(await readFile(output, "utf8")).toBe(previous);
    expect(runtime.fetch).not.toHaveBeenCalled();
    expect(runtime.write).not.toHaveBeenCalled();
  });

  it("refuses an Azure credential continuation before forwarding authorization and removes staged evidence", async () => {
    const dir = await directory();
    const env = writeComputeScopeFixture(await directory());
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      value: [], nextLink: `https://management.azure.com/subscriptions/${COMPUTE_SCOPE_SUBSCRIPTION}/providers/Microsoft.Compute/skus?authToken=synthetic-private-value`,
    }), { status: 200 }));
    await expect(fetchComputeArchive({ provider: "azure", azureSubscription: COMPUTE_SCOPE_SUBSCRIPTION, regions: ["eastus"] }, {
      env, fetch: fetcher, now: () => NOW, azureAccessToken: "synthetic-arm-token",
    }, join(dir, "archive"))).rejects.toThrow("Credential-bearing URLs");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await readdir(dir)).toEqual([]);
  });
});
