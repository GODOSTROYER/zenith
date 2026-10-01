/** C3 -> customer Blob -> ACR contract path; all HTTP/cloud responses are mocked. */
import { describe, expect, it, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import { createSourceBundles } from "@/lib/platform/source-bundle";
import { createReleasePorts } from "@/lib/platform/release";
import { azureSourceWorld } from "./source-bundle-azure-fixtures";
import { CONTAINER } from "../providers/azure/source-storage-fixtures";
import { IMAGE, DIGEST } from "../providers/azure/release-fixtures";

describe("provider-dispatched Azure source preparation", () => {
  it("prepares canonical tar.gz in the bound container and passes exact bytes to ACR", async () => {
    const w = azureSourceWorld();
    const prepared = await w.bundles.port.prepare(w.ctx, { service: w.service, source: w.source });
    expect(prepared).toMatchObject({ s3Key: `zenith/env-1/web/${prepared.digest}.tar.gz`, bucket: "zenithsource/source-bundles", objectKey: prepared.s3Key, uri: `https://zenithsource.blob.core.windows.net/source-bundles/${prepared.s3Key}` });
    const stored = w.storage.blobs.get(`/${CONTAINER}/${prepared.s3Key}`)!;
    expect(gunzipSync(stored)).toEqual(gunzipSync((await w.bundles.read(w.source)).archive));
    const ports = createReleasePorts({ azure: { readSource: w.bundles.readAzureSource, launches: w.receipts.port, uploadFetch: w.uploadFetch } });
    const handle = await ports.build.startBuild(w.ctx, { pipeline: w.pipeline, service: w.service, registry: w.registry, source: prepared, idempotencyKey: "c3-build" });
    expect(w.state.schedules).toBe(1);
    expect(w.uploadFetch).toHaveBeenCalledWith(expect.stringContaining("sig="), expect.objectContaining({ body: stored }));
    expect(await ports.build.waitForBuild(w.ctx, handle, { timeoutMs: 1000 })).toEqual({ status: "succeeded", digest: DIGEST, imageUri: IMAGE });
    expect(handle.buildId).not.toContain("sig="); expect(w.ctx.log).not.toHaveBeenCalled();
  });
  it("rereads the stored bundle on another instance without downloading a moving GitHub ref", async () => {
    const w = azureSourceWorld(); const prepared = await w.bundles.port.prepare(w.ctx, { service: w.service, source: w.source });
    const reader = createSourceBundles({ ...w.deps, fetchImpl: vi.fn(async () => { throw new Error("Moving ref must not be downloaded at build start."); }) });
    expect(await reader.readAzureSource(w.ctx, prepared)).toEqual(w.storage.blobs.get(`/${CONTAINER}/${prepared.s3Key}`));
    expect(w.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, vi.fn(async () => null)])("clearly refuses missing storage bindings before downloading source", async (azureStorage) => {
    const w = azureSourceWorld();
    await expect(createSourceBundles({ ...w.deps, azureStorage }).port.prepare(w.ctx, { service: w.service, source: w.source })).rejects.toThrow("storage account/container binding");
    expect(w.fetchImpl).not.toHaveBeenCalled(); expect(w.fetcher).not.toHaveBeenCalled();
  });
  it.each(["workspaceId", "environmentId"] as const)("refuses a cross-tenant %s resource lookup", async (field) => {
    const w = azureSourceWorld(); w.rows[0][field] = "foreign";
    await expect(w.bundles.port.prepare(w.ctx, { service: w.service, source: w.source })).rejects.toThrow("boundary");
    expect(w.resolveStorage).not.toHaveBeenCalled(); expect(w.fetchImpl).not.toHaveBeenCalled();
  });
  it("refuses a different pipeline source and a mismatched provider/session before acquisition", async () => {
    const w = azureSourceWorld();
    await expect(w.bundles.port.prepare(w.ctx, { service: w.service, source: { ...w.source, ref: "foreign-ref" } })).rejects.toThrow("repository and ref");
    await expect(w.bundles.port.prepare({ ...w.ctx, provider: "gcp" }, { service: w.service, source: w.source })).rejects.toThrow("matching");
    expect(w.fetchImpl).not.toHaveBeenCalled();
  });
  it("refuses changed stored bytes before an ACR upload or schedule", async () => {
    const w = azureSourceWorld(); const prepared = await w.bundles.port.prepare(w.ctx, { service: w.service, source: w.source });
    const blob = w.storage.blobs.get(`/${CONTAINER}/${prepared.s3Key}`)!; blob[0] ^= 255;
    const ports = createReleasePorts({ azure: { readSource: w.bundles.readAzureSource, launches: w.receipts.port, uploadFetch: w.uploadFetch } });
    await expect(ports.build.startBuild(w.ctx, { service: w.service, pipeline: w.pipeline, registry: w.registry, source: prepared, idempotencyKey: "bad-source" })).rejects.toThrow("could not be read");
    expect(w.uploadFetch).not.toHaveBeenCalled(); expect(w.state.schedules).toBe(0);
  });
  it("propagates C3's lowered compressed-size ceiling to the stored source reader", async () => {
    const w = azureSourceWorld(); const prepared = await w.bundles.port.prepare(w.ctx, { service: w.service, source: w.source });
    await expect(createSourceBundles({ ...w.deps, limits: { maxArchiveBytes: 4 } }).readAzureSource(w.ctx, prepared)).rejects.toThrow("size bound");
  });
  it("binds the private GitHub connector to the activity's tenant and environment", async () => {
    const w = azureSourceWorld(); const connector = vi.fn();
    const bundles = createSourceBundles({ ...w.deps, withGithubAccess: async (scope, fn) => { connector(scope); return fn("synthetic-token"); } });
    await bundles.port.prepare(w.ctx, { service: w.service, source: w.source });
    expect(connector).toHaveBeenCalledWith({ owner: "acme", repo: "app", workspaceId: w.ctx.workspaceId, environmentId: w.ctx.environmentId });
    expect(w.fetcher.mock.calls.every(([, init]) => !JSON.stringify(init).includes("synthetic-token"))).toBe(true);
  });
});
