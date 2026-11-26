import { describe, expect, it, vi } from "vitest";
import { collectComputeSnapshots, type ComputeCollectionDeps } from "@/lib/compute-catalog/collect";

const now = () => "2026-11-27T00:00:00.000Z";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function deps(fetcher: typeof fetch): ComputeCollectionDeps {
  return { env: { ZENITH_LIVE_CATALOG_REFRESH: "1" }, fetch: fetcher, now, sleep: async () => {} };
}

describe("read-only official compute collection", () => {
  it("requires the existing opt-in before any network or AWS call", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(collectComputeSnapshots({ provider: "aws" }, { ...deps(fetcher), env: {} })).rejects.toThrow("ZENITH_LIVE_CATALOG_REFRESH=1");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("discovers AWS regions from the provider index rather than a static region table", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ regions: { "ap-south-1": { currentVersionUrl: "/offers/v1.0/aws/AmazonEC2/20261127/ap-south-1/index.json" }, "new-region-1": { currentVersionUrl: "/offers/v1.0/aws/AmazonEC2/20261127/new-region-1/index.json" } } }))
      .mockResolvedValueOnce(json({ products: {}, terms: {} }))
      .mockResolvedValueOnce(json({ products: {}, terms: {} }));
    const output = await collectComputeSnapshots({ provider: "aws" }, deps(fetcher));
    expect(output.map((s) => s.region)).toEqual(["ap-south-1", "new-region-1"]);
    expect(output.every((s) => /^[a-f0-9]{64}$/.test(s.sha256!))).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("fully paginates optional AWS inventory and records page tokens", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ regions: { "ap-south-1": { currentVersionUrl: "/offers/v1.0/aws/AmazonEC2/current/ap-south-1/index.json" } } }))
      .mockResolvedValueOnce(json({ products: {}, terms: {} }));
    const inventory = vi.fn<NonNullable<ComputeCollectionDeps["awsInventoryPage"]>>()
      .mockResolvedValueOnce({ InstanceTypes: [{ InstanceType: "test" }], NextToken: "next" })
      .mockResolvedValueOnce({ InstanceTypes: [], $metadata: { requestId: "transport" } })
      .mockResolvedValueOnce({ InstanceTypeOfferings: [] });
    const output = await collectComputeSnapshots({ provider: "aws", regions: ["ap-south-1"], awsInventory: true }, { ...deps(fetcher), awsInventoryPage: inventory });
    expect(inventory).toHaveBeenNthCalledWith(2, "ap-south-1", "types", "next");
    expect(output[2].url).toContain("NextToken=next");
    expect(output[2].data).not.toHaveProperty("$metadata");
    expect(output).toHaveLength(4);
  });

  it("rejects AWS index URLs that leave the provider endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ regions: { "ap-south-1": { currentVersionUrl: "https://example.com/prices" } } }));
    await expect(collectComputeSnapshots({ provider: "aws" }, deps(fetcher))).rejects.toThrow("allowed endpoint");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("collects every GCP inventory and billing page without putting tokens in URLs", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ items: {}, nextPageToken: "page2" }))
      .mockResolvedValueOnce(json({ items: {} }))
      .mockResolvedValueOnce(json({ skus: [], nextPageToken: "sku2" }))
      .mockResolvedValueOnce(json({ skus: [] }));
    const output = await collectComputeSnapshots({ provider: "gcp", gcpProject: "zenith-test" }, { ...deps(fetcher), gcpAccessToken: "test-token" });
    expect(output).toHaveLength(4);
    expect(output[1].url).toContain("pageToken=page2");
    expect(output[3].url).toContain("pageToken=sku2");
    expect(JSON.stringify(output)).not.toContain("test-token");
    expect(fetcher.mock.calls.every(([, init]) => (init?.headers as Record<string, string>).Authorization === "Bearer test-token")).toBe(true);
  });

  it("fails closed for GCP partial inventory and repeated pagination", async () => {
    const partial = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ items: {}, unreachables: ["zones/x"] }));
    await expect(collectComputeSnapshots({ provider: "gcp", gcpProject: "test-project" }, { ...deps(partial), gcpAccessToken: "token" })).rejects.toThrow("incomplete inventory");
    const cycle = vi.fn<typeof fetch>().mockImplementation(async () => json({ items: {}, nextPageToken: "same" }));
    await expect(collectComputeSnapshots({ provider: "gcp", gcpProject: "test-project" }, { ...deps(cycle), gcpAccessToken: "token" })).rejects.toThrow("pagination did not complete");
    expect(cycle).toHaveBeenCalledTimes(2);
  });

  it("follows Azure continuation pages and keeps the ARM token off public retail requests", async () => {
    const next = "https://prices.azure.com/api/retail/prices?$skip=1000";
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ value: [] }))
      .mockResolvedValueOnce(json({ Items: [], NextPageLink: next }))
      .mockResolvedValueOnce(json({ Items: [] }));
    const output = await collectComputeSnapshots({ provider: "azure", azureSubscription: "1234-abcd", regions: ["centralindia"] }, { ...deps(fetcher), azureAccessToken: "arm-token" });
    expect(output).toHaveLength(3);
    expect(output[2].url).toBe(next);
    expect(fetcher.mock.calls[0][1]?.headers).toEqual({ Authorization: "Bearer arm-token" });
    expect(fetcher.mock.calls[1][1]?.headers).toEqual({});
    expect(JSON.stringify(output)).not.toContain("arm-token");
  });

  it("rejects foreign Azure continuation links before forwarding authorization", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ value: [], nextLink: "https://example.com/steal" }));
    await expect(collectComputeSnapshots({ provider: "azure", azureSubscription: "1234-abcd" }, { ...deps(fetcher), azureAccessToken: "secret" })).rejects.toThrow("allowed endpoint");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries throttling with a bound and does not expose provider error bodies", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ error: "sensitive-body" }, 503));
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue();
    await expect(collectComputeSnapshots({ provider: "aws" }, { ...deps(fetcher), sleep })).rejects.toThrow("HTTP 503");
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("rejects injected region and project identifiers before any request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(collectComputeSnapshots({ provider: "azure", regions: ["x' or true"], azureSubscription: "1234" }, deps(fetcher))).rejects.toThrow("native region identifiers");
    await expect(collectComputeSnapshots({ provider: "gcp", gcpProject: "../../secrets" }, deps(fetcher))).rejects.toThrow("project identifier");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
