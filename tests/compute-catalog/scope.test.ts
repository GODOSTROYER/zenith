import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectComputeSnapshots, type ComputeCollectionDeps, type ComputeCollectionRequest } from "@/lib/compute-catalog/collect";
import { runComputeCatalogCli } from "../../scripts/cost/compute-catalog";
import type { ScopeManifest } from "../../scripts/release/scope";
import { computeScopeFixture, COMPUTE_SCOPE_NOW, COMPUTE_SCOPE_PROJECT, COMPUTE_SCOPE_SUBSCRIPTION, writeComputeScopeFixture } from "./scope-fixture";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "zenith-compute-scope-")); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });
const now = () => COMPUTE_SCOPE_NOW;
const reply = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const index = (...regions: string[]) => ({ regions: Object.fromEntries(regions.map(region => [region, { currentVersionUrl: `/offers/v1.0/aws/AmazonEC2/current/${region}/index.json` }])) });

function fakeIo(manifest = computeScopeFixture()) {
  const fetcher = vi.fn<typeof fetch>();
  const inventory = vi.fn<NonNullable<ComputeCollectionDeps["awsInventoryPage"]>>();
  const env = writeComputeScopeFixture(directory, manifest);
  const deps: ComputeCollectionDeps = { env, fetch: fetcher, now, awsInventoryPage: inventory, gcpAccessToken: "synthetic-gcp-token", azureAccessToken: "synthetic-arm-token" };
  return { deps, fetcher, inventory };
}

describe("approved compute catalog collection scope", () => {
  it("refuses a missing scope file before any HTTP or SDK request", async () => {
    const { deps, fetcher, inventory } = fakeIo();
    deps.env = { ...deps.env, ZENITH_LIVE_SCOPE_FILE: join(directory, "missing-scope.json") };
    await expect(collectComputeSnapshots({ provider: "aws", awsInventory: true }, deps)).rejects.toMatchObject({ code: "manifest_unreadable" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(inventory).not.toHaveBeenCalled();
  });

  it.each([
    ["unapproved", "not_approved", (manifest: ScopeManifest) => { manifest.approval.status = "not_approved"; }],
    ["modified after approval", "approval_stale", (manifest: ScopeManifest) => { manifest.harnesses["compute-catalog"]!.description = "Changed scope content"; }],
    ["expired", "approval_expired", (manifest: ScopeManifest) => { manifest.approval.expiresAt = COMPUTE_SCOPE_NOW; }],
  ] as const)("refuses %s approval before any provider request", async (_label, code, edit) => {
    const manifest = computeScopeFixture();
    edit(manifest);
    const { deps, fetcher, inventory } = fakeIo(manifest);
    await expect(collectComputeSnapshots({ provider: "aws", awsInventory: true }, deps)).rejects.toMatchObject({ code });
    expect(fetcher).not.toHaveBeenCalled();
    expect(inventory).not.toHaveBeenCalled();
  });

  it.each([
    ["missing harness", "harness_unknown", (manifest: ScopeManifest) => { delete manifest.harnesses["compute-catalog"]; }],
    ["wrong provider", "provider_not_granted", (manifest: ScopeManifest) => { manifest.harnesses["compute-catalog"]!.providers = ["gcp"]; }],
    ["no read action", "action_not_granted", (manifest: ScopeManifest) => { manifest.harnesses["compute-catalog"]!.actions = ["mutate_run_tagged"]; }],
  ] as const)("enforces the dedicated grant: %s", async (_label, code, edit) => {
    const { deps, fetcher, inventory } = fakeIo(computeScopeFixture(edit));
    await expect(collectComputeSnapshots({ provider: "aws" }, deps)).rejects.toMatchObject({ code });
    expect(fetcher).not.toHaveBeenCalled();
    expect(inventory).not.toHaveBeenCalled();
  });

  it("does not let an invalid clock bypass approval expiry", async () => {
    const { deps, fetcher } = fakeIo();
    await expect(collectComputeSnapshots({ provider: "aws" }, { ...deps, now: () => "not-a-date" })).rejects.toMatchObject({ code: "manifest_invalid" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("permits AWS all-region public prices with only the public grant and no AWS account", async () => {
    const { deps, fetcher, inventory } = fakeIo(computeScopeFixture(manifest => {
      manifest.harnesses["compute-catalog"]!.providers = ["public"];
      manifest.sandboxes.aws.accountId = null;
    }));
    fetcher.mockResolvedValueOnce(reply(index("af-south-1", "us-east-1", "us-east-1-wl1-bos-wlz-1")))
      .mockResolvedValueOnce(reply({ products: {}, terms: {} }))
      .mockResolvedValueOnce(reply({ products: {}, terms: {} }))
      .mockResolvedValueOnce(reply({ products: {}, terms: {} }));
    const snapshots = await collectComputeSnapshots({ provider: "aws" }, deps);
    expect(snapshots.map(snapshot => snapshot.region)).toEqual(["af-south-1", "us-east-1", "us-east-1-wl1-bos-wlz-1"]);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(inventory).not.toHaveBeenCalled();
  });

  it.each([true, "true" as unknown as boolean])("requires native AWS permission when inventory is truthy (%s)", async awsInventory => {
    const { deps, fetcher, inventory } = fakeIo(computeScopeFixture(manifest => { manifest.harnesses["compute-catalog"]!.providers = ["public"]; }));
    await expect(collectComputeSnapshots({ provider: "aws", regions: ["us-east-1"], awsInventory }, deps)).rejects.toMatchObject({ code: "provider_not_granted" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(inventory).not.toHaveBeenCalled();
  });

  it("allows approved AWS inventory with its native grant and fake SDK", async () => {
    const { deps, fetcher, inventory } = fakeIo(computeScopeFixture(manifest => { manifest.harnesses["compute-catalog"]!.providers = ["aws"]; }));
    fetcher.mockResolvedValueOnce(reply(index("us-east-1"))).mockResolvedValueOnce(reply({ products: {}, terms: {} }));
    inventory.mockResolvedValueOnce({ InstanceTypes: [] }).mockResolvedValueOnce({ InstanceTypeOfferings: [] });
    const snapshots = await collectComputeSnapshots({ provider: "aws", awsInventory: true }, deps);
    expect(snapshots.map(snapshot => snapshot.kind)).toEqual(["aws_ec2_prices", "aws_instance_types", "aws_instance_offerings"]);
    expect(inventory.mock.calls).toEqual([["us-east-1", "types", undefined], ["us-east-1", "offerings", undefined]]);
  });

  it("preflights every discovered AWS inventory region before any regional or SDK read", async () => {
    const { deps, fetcher, inventory } = fakeIo();
    fetcher.mockResolvedValueOnce(reply(index("us-east-1", "us-west-1")));
    await expect(collectComputeSnapshots({ provider: "aws", awsInventory: true }, deps)).rejects.toMatchObject({ code: "sandbox_unconfirmed" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(inventory).not.toHaveBeenCalled();
  });

  it.each([
    ["aws", { provider: "aws", awsInventory: true, regions: ["us-east-1"] }, (manifest: ScopeManifest) => { manifest.sandboxes.aws.accountId = null; }],
    ["gcp", { provider: "gcp", gcpProject: COMPUTE_SCOPE_PROJECT, regions: ["us-central1"] }, (manifest: ScopeManifest) => { manifest.sandboxes.gcp.projectId = null; }],
    ["azure", { provider: "azure", azureSubscription: COMPUTE_SCOPE_SUBSCRIPTION, regions: ["eastus"] }, (manifest: ScopeManifest) => { manifest.sandboxes.azure.tenantId = null; }],
  ] satisfies [string, ComputeCollectionRequest, (manifest: ScopeManifest) => void][])("requires a confirmed native %s sandbox", async (_label, request, edit) => {
    const { deps, fetcher, inventory } = fakeIo(computeScopeFixture(edit));
    await expect(collectComputeSnapshots(request, deps)).rejects.toMatchObject({ code: "sandbox_unconfirmed" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(inventory).not.toHaveBeenCalled();
  });

  it.each([
    ["AWS region", { provider: "aws", awsInventory: true, regions: ["eu-west-1"] }],
    ["GCP project", { provider: "gcp", gcpProject: "another-project", regions: ["us-central1"] }],
    ["Azure subscription", { provider: "azure", azureSubscription: "11111111-2222-4333-8444-555555555555", regions: ["eastus"] }],
    ["GCP region", { provider: "gcp", gcpProject: COMPUTE_SCOPE_PROJECT, regions: ["europe-west1"] }],
    ["Azure region", { provider: "azure", azureSubscription: COMPUTE_SCOPE_SUBSCRIPTION, regions: ["westus"] }],
    ["GCP all regions", { provider: "gcp", gcpProject: COMPUTE_SCOPE_PROJECT }],
    ["Azure all regions", { provider: "azure", azureSubscription: COMPUTE_SCOPE_SUBSCRIPTION }],
  ] satisfies [string, ComputeCollectionRequest][])("refuses an unmatched or implicit %s before provider I/O", async (_label, request) => {
    const { deps, fetcher, inventory } = fakeIo();
    await expect(collectComputeSnapshots(request, deps)).rejects.toMatchObject({ code: "sandbox_unconfirmed" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(inventory).not.toHaveBeenCalled();
  });

  it("matches the approved Azure subscription GUID case insensitively", async () => {
    const { deps, fetcher } = fakeIo();
    fetcher.mockResolvedValueOnce(reply({ value: [] })).mockResolvedValueOnce(reply({ Items: [] }));
    const snapshots = await collectComputeSnapshots({ provider: "azure", azureSubscription: COMPUTE_SCOPE_SUBSCRIPTION.toUpperCase(), regions: ["eastus"] }, deps);
    expect(snapshots).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["gcp", "azure"] as const)("refuses an unapproved CLI %s fetch before opening its token file", async provider => {
    const manifest = computeScopeFixture();
    manifest.approval.status = "not_approved";
    const { deps, fetcher } = fakeIo(manifest);
    const output = join(directory, "archive");
    const tokenFile = join(directory, "missing-token-file");
    const args = provider === "gcp"
      ? ["--gcp-project", COMPUTE_SCOPE_PROJECT, "--gcp-token-file", tokenFile, "--regions", "us-central1"]
      : ["--azure-subscription", COMPUTE_SCOPE_SUBSCRIPTION, "--azure-token-file", tokenFile, "--regions", "eastus"];
    const write = vi.fn();
    // Opening this missing file would throw the CLI's distinct access-token error.
    // Reaching ScopeError proves approval is checked first, even with the live opt-in.
    await expect(runComputeCatalogCli(["fetch", "--provider", provider, "--out", output, ...args], { env: deps.env, fetch: fetcher, now, write })).rejects.toMatchObject({ code: "not_approved" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(existsSync(output)).toBe(false);
  });
});
