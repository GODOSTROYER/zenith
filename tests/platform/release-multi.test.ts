/** Provider dispatch with native adapters over synthetic sessions; no live clouds. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReleasePorts } from "@/lib/platform/release";
import { world as gcpWorld, service as gcpService } from "../providers/gcp/release-fixtures";
import { world as azureWorld, service as azureService } from "../providers/azure/release-fixtures";
import { buildFullFixture, mkDriverContext } from "../providers/aws/drivers/compute/fixtures";
import { IMAGE, DIGEST } from "../providers/aws/drivers/compute/ecs-mocks";
import { releaseWorld } from "../providers/kubernetes/release-fixtures";

describe("release provider composition", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("dispatches Kubernetes rollout reads and explicitly refuses an unconfigured builder", async () => {
    vi.stubEnv("ZENITH_ISOLATED_BUILD_PROFILES", "");
    const w = await releaseWorld();
    try {
      const ports = createReleasePorts();
      expect(await ports.workloads.waitSteady(w.ctx, w.node, { timeoutMs: 1000 })).toMatchObject({ steady: true });
      const reads = w.fake.requests.length;
      await expect(ports.build.startBuild(w.ctx, { service: w.node, pipeline: w.node, source: { s3Key: "source", digest: "source-digest" }, idempotencyKey: "build" })).rejects.toThrow("ZENITH_ISOLATED_BUILD_PROFILES");
      await expect(ports.build.waitForBuild(w.ctx, { buildId: "invented" }, { timeoutMs: 1000 })).rejects.toThrow("ZENITH_ISOLATED_BUILD_PROFILES");
      await expect(ports.workloads.waitSteady({ ...w.ctx, session: { provider: "aws" } }, w.node, { timeoutMs: 1000 })).rejects.toThrow("broker session");
      expect(w.fake.requests).toHaveLength(reads);
    } finally { await w.fake.close(); }
  });
  it("dispatches GCP and Azure steady waits by environment provider", async () => {
    const ports = createReleasePorts(); const gcp = gcpWorld(); const azure = azureWorld();
    expect(await ports.workloads.waitSteady(gcp.ctx, gcpService, { timeoutMs: 1000 })).toMatchObject({ steady: true });
    expect(await ports.workloads.waitSteady(azure.ctx, azureService, { timeoutMs: 1000 })).toMatchObject({ steady: true });
    expect(gcp.fetcher).toHaveBeenCalled(); expect(azure.fetcher).toHaveBeenCalled();
  });
  it("keeps AWS manifest-pinned workload behavior", async () => {
    const service = buildFullFixture({ artifact: { type: "image", ref: IMAGE } }).service;
    expect(await createReleasePorts().workloads.deployImage(mkDriverContext(), service, { uri: IMAGE, digest: DIGEST }, { idempotencyKey: "op:deploy" })).toMatchObject({ detail: expect.stringContaining("OpenTofu") });
  });
  it("rejects mismatched broker session and unsupported providers before cloud calls", async () => {
    const w = gcpWorld(); const ports = createReleasePorts();
    await expect(ports.workloads.waitSteady({ ...w.ctx, provider: "azure" }, gcpService, { timeoutMs: 1000 })).rejects.toThrow("broker session");
    await expect(ports.workloads.waitSteady({ ...w.ctx, provider: "zenith" }, gcpService, { timeoutMs: 1000 })).rejects.toThrow("managed substrate");
    await expect(ports.workloads.waitSteady({ ...w.ctx, provider: "sandbox" }, gcpService, { timeoutMs: 1000 })).rejects.toThrow("unavailable"); expect(w.fetcher).not.toHaveBeenCalled();
  });
  it("forwards explicit Azure build/source dependencies and migration launch receipts", async () => {
    const w = azureWorld(); const ports = createReleasePorts({ azure: w.options });
    expect(await ports.migrations.runOneOffTask(w.ctx, azureService, ["node", "migrate.js"], { idempotencyKey: "composed:migrate", timeoutMs: 1000 })).toEqual({ exitCode: 0 });
    expect(w.state.starts).toBe(1); expect(w.receipts.claims.size).toBe(1);
  });
});
