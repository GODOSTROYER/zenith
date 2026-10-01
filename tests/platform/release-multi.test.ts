/** Provider dispatch with native adapters over synthetic sessions; no live clouds. */
import { describe, expect, it } from "vitest";
import { createReleasePorts } from "@/lib/platform/release";
import { world as gcpWorld, service as gcpService } from "../providers/gcp/release-fixtures";
import { world as azureWorld, service as azureService } from "../providers/azure/release-fixtures";
import { buildFullFixture, mkDriverContext } from "../providers/aws/drivers/compute/fixtures";
import { IMAGE, DIGEST } from "../providers/aws/drivers/compute/ecs-mocks";

describe("release provider composition", () => {
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
    await expect(ports.workloads.waitSteady({ ...w.ctx, provider: "oci" }, gcpService, { timeoutMs: 1000 })).rejects.toThrow("unavailable"); expect(w.fetcher).not.toHaveBeenCalled();
  });
  it("forwards explicit Azure build/source dependencies and migration launch receipts", async () => {
    const w = azureWorld(); const ports = createReleasePorts({ azure: w.options });
    expect(await ports.migrations.runOneOffTask(w.ctx, azureService, ["node", "migrate.js"], { idempotencyKey: "composed:migrate", timeoutMs: 1000 })).toEqual({ exitCode: 0 });
    expect(w.state.starts).toBe(1); expect(w.receipts.claims.size).toBe(1);
  });
});
