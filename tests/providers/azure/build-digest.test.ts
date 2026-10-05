/** Digest build/release contracts over synthetic ARM/blob/C3 transports; no live cloud evidence. */
import { describe, expect, it, vi } from "vitest";
import { createAzureBuildPort, createAzureSourceBundlePort, createAzureWorkloadsPort, type AzureSourceReader } from "@/lib/platform/release-azure";
import { createReleasePorts } from "@/lib/platform/release";
import { BOOTSTRAP_IMAGE } from "@/lib/providers/azure/drivers/compute/workload";
import { sha256Hex } from "@/lib/controlplane/digest";
import { source, bundle, world, node, tagged, pipeline, service, registry, registryId, appId, ROOT, IMAGE, DIGEST } from "./release-fixtures";

const expectedBuild = {
  status: "succeeded", imageUri: IMAGE, digest: DIGEST,
  attestation: {
    builderId: registryId,
    invocationId: "run1",
    isolation: {
      profileId: "azure.acr-tasks.v1",
      identity: { principal: "acr-tasks-run", dedicated: true, deployCredentials: "absent" },
      metadata: { exposes: "build_identity_only", mechanism: "the run exposes no user-assigned identity; the task agent has no access to deploy credentials" },
      network: { egress: "unrestricted", mechanism: "ACR Tasks shared agents have public egress; configure spec.isolation.workerPool" },
      dependencies: { downloads: "direct" },
      filesystem: { sourceMount: "read_only" },
      resources: { timeoutSec: 1800, computeClass: "cpu-2" },
    },
  },
};

const input = () => ({ pipeline, service, registry, source: bundle, idempotencyKey: "digest-build" });
const reader = (): AzureSourceReader => ({ read: vi.fn(async () => ({ archive: source, sha256: sha256Hex(source), bytes: source.byteLength })) });

describe("Azure C3 source bridge and digest release", () => {
  it("prepares with C3 read, uploads the verified archive to ACR, recovers its digest and rolls an app from bootstrap", async () => {
    const w = world(); const sourceBundles = reader();
    const prepared = await createAzureSourceBundlePort(sourceBundles).prepare(w.ctx, { service, source: pipeline.spec.source as Parameters<AzureSourceReader["read"]>[0] });
    expect(prepared).toEqual({ s3Key: `bundles/${sha256Hex(source)}.tar.gz`, digest: bundle.digest });
    const ports = createReleasePorts({ azure: { sourceBundles, launches: w.receipts.port, uploadFetch: w.uploadFetch } });
    const handle = await ports.build.startBuild(w.ctx, { ...input(), source: prepared });
    expect(sourceBundles.read).toHaveBeenCalledWith(pipeline.spec.source, w.ctx.signal);
    expect(w.readSource).not.toHaveBeenCalled();
    expect(w.uploadFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: source, signal: w.ctx.signal, redirect: "error" }));
    const built = await createAzureBuildPort().waitForBuild(w.ctx, handle, { timeoutMs: 1000 });
    expect(built).toEqual(expectedBuild);
    const props = w.state.app.properties as { template: { containers: Record<string, unknown>[]; revisionSuffix: string }; latestRevisionName: string; latestReadyRevisionName: string };
    props.template.containers[0].image = BOOTSTRAP_IMAGE;
    props.template.containers[0].args = ["-listen", ":8080", "-text", "Zenith awaiting built release"];
    await ports.workloads.deployImage(w.ctx, service, { uri: built.imageUri!, digest: built.digest! }, { idempotencyKey: "digest-deploy" });
    const revisionName = `web--${props.template.revisionSuffix}`;
    props.latestRevisionName = props.latestReadyRevisionName = revisionName;
    w.state.revision.id = `${appId}/revisions/${revisionName}`; w.state.revision.name = revisionName;
    expect(await ports.workloads.waitSteady(w.ctx, service, { timeoutMs: 1000 })).toMatchObject({ steady: true });
    expect(props.template.containers[0].image).toBe(IMAGE);
    expect(props.template.containers[0].args).toEqual([]);
    expect(JSON.stringify([...w.receipts.references.values()])).not.toMatch(/secret-sas|archive|latest/);
  });

  it("persists a queued run before polling and resumes waiting on a replacement worker", async () => {
    const w = world(); w.state.runStatus = "Queued";
    const handle = await createAzureBuildPort(w.options).startBuild(w.ctx, input());
    expect(w.receipts.port.record).toHaveBeenCalledOnce();
    expect(w.fetcher.mock.calls.filter(([u]) => u.includes("/runs/"))).toHaveLength(0);
    expect(await createAzureBuildPort(w.options).startBuild(w.ctx, input())).toEqual(handle);
    expect(await createAzureBuildPort().waitForBuild(w.ctx, handle, { timeoutMs: 10 })).toEqual({ status: "timed_out" });
    (w.state.run!.properties as Record<string, unknown>).status = "Succeeded";
    expect(await createAzureBuildPort().waitForBuild(w.ctx, handle, { timeoutMs: 1000 })).toEqual(expectedBuild);
    expect(w.state.schedules).toBe(1);
  });

  it("never schedules twice when concurrent workers share one launch key", async () => {
    const w = world();
    const result = await Promise.allSettled(Array.from({ length: 8 }, () => createAzureBuildPort(w.options).startBuild(w.ctx, input())));
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(w.state.schedules).toBe(1);
    expect(w.uploadFetch).toHaveBeenCalledOnce();
  });

  it("fails closed if source changes between prepare and build", async () => {
    const w = world(); const sourceBundles = reader();
    const prepared = await createAzureSourceBundlePort(sourceBundles).prepare(w.ctx, { service, source: pipeline.spec.source as Parameters<AzureSourceReader["read"]>[0] });
    const changed = new Uint8Array([9, 8, 7]); sourceBundles.read = vi.fn(async () => ({ archive: changed, sha256: sha256Hex(changed), bytes: changed.byteLength }));
    await expect(createAzureBuildPort({ ...w.options, sourceBundles }).startBuild(w.ctx, { ...input(), source: prepared })).rejects.toThrow("bytes");
    expect(w.uploadFetch).not.toHaveBeenCalled(); expect(w.state.schedules).toBe(0);
  });

  it.each(["wrong-size", "wrong-hash", "empty", "missing-ref"])("rejects C3 %s metadata before uploading", async (bad) => {
    const w = world(); const sourceBundles = reader();
    if (bad === "wrong-size") sourceBundles.read = vi.fn(async () => ({ archive: source, sha256: bundle.digest, bytes: source.byteLength + 1 }));
    if (bad === "wrong-hash") sourceBundles.read = vi.fn(async () => ({ archive: source, sha256: "b".repeat(64), bytes: source.byteLength }));
    if (bad === "empty") sourceBundles.read = vi.fn(async () => ({ archive: new Uint8Array(), sha256: sha256Hex(new Uint8Array()), bytes: 0 }));
    const buildInput = input(); if (bad === "missing-ref") buildInput.pipeline = { ...pipeline, spec: { ...pipeline.spec, source: { repo: "https://example.com/web" } } };
    await expect(createAzureBuildPort({ ...w.options, sourceBundles }).startBuild(w.ctx, buildInput)).rejects.toThrow();
    expect(w.uploadFetch).not.toHaveBeenCalled(); expect(w.state.schedules).toBe(0);
  });

  it("propagates cancellation and hides reader transport errors", async () => {
    const w = world(); const sourceBundles = reader(); const controller = new AbortController();
    sourceBundles.read = vi.fn(async () => { controller.abort(new Error("cancelled")); throw new Error("secret-source-token"); });
    await expect(createAzureBuildPort({ ...w.options, sourceBundles }).startBuild({ ...w.ctx, signal: controller.signal }, input())).rejects.toThrow("cancelled");
    const w2 = world(); sourceBundles.read = vi.fn(async () => { throw new Error("secret-source-token"); });
    await expect(createAzureSourceBundlePort(sourceBundles).prepare(w2.ctx, { service, source: pipeline.spec.source as Parameters<AzureSourceReader["read"]>[0] })).rejects.toThrow("could not be read; no build was launched");
    expect(w.uploadFetch).not.toHaveBeenCalled(); expect(w.ctx.log).not.toHaveBeenCalled();
  });

  it("refuses foreign source preparation without reading repo bytes", async () => {
    const w = world(); const sourceBundles = reader();
    await expect(createAzureSourceBundlePort(sourceBundles).prepare(w.ctx, { service: { ...service, provider: "gcp" }, source: pipeline.spec.source as Parameters<AzureSourceReader["read"]>[0] })).rejects.toThrow("managed Azure");
    expect(sourceBundles.read).not.toHaveBeenCalled();
  });

  it.each([
    "https://attacker.example/source?sig=secret", "http://acrsource.blob.core.windows.net/source?sig=secret",
    "https://user:secret@acrsource.blob.core.windows.net/source?sig=secret", "https://acrsource.blob.core.windows.net/source?sig=",
    "https://acrsource.blob.core.windows.net/source?sig=secret#fragment",
  ])("rejects untrusted SAS upload data %s", async (uploadUrl) => {
    const w = world(); w.state.before = (url) => url.pathname.endsWith("/listBuildSourceUploadUrl") ? w.json({ uploadUrl, relativePath: "source/archive.tar.gz" }) : undefined;
    await expect(createAzureBuildPort(w.options).startBuild(w.ctx, input())).rejects.toThrow("consumed launch key");
    expect(w.uploadFetch).not.toHaveBeenCalled(); expect(w.state.schedules).toBe(0);
    expect(w.ctx.log).not.toHaveBeenCalled();
  });

  it("refuses unsafe source and Dockerfile paths before scheduling", async () => {
    const w = world(); w.state.before = (url) => url.pathname.endsWith("/listBuildSourceUploadUrl") ? w.json({ uploadUrl: "https://acrsource.blob.core.windows.net/source?sig=secret", relativePath: "source/../escape.tar.gz" }) : undefined;
    await expect(createAzureBuildPort(w.options).startBuild(w.ctx, input())).rejects.toThrow("consumed launch key");
    expect(w.uploadFetch).not.toHaveBeenCalled();
    const w2 = world(); const invalid = { ...pipeline, spec: { ...pipeline.spec, source: { repo: "https://example.com/web", ref: "main", dockerfile: "$(secret-command)" } } };
    await expect(createAzureBuildPort(w2.options).startBuild(w2.ctx, { ...input(), pipeline: invalid })).rejects.toThrow("consumed launch key");
    expect(w2.uploadFetch).not.toHaveBeenCalled(); expect(w2.state.schedules).toBe(0);
  });

  it("does not relaunch a scheduled build if journal persistence fails", async () => {
    const w = world(); w.receipts.port.record = vi.fn(async () => { throw new Error("secret-journal-error"); });
    await expect(createAzureBuildPort(w.options).startBuild(w.ctx, input())).rejects.toThrow("receipt was not persisted");
    await expect(createAzureBuildPort(w.options).startBuild(w.ctx, input())).rejects.toThrow("will not launch again");
    expect(w.state.schedules).toBe(1); expect(w.ctx.log).not.toHaveBeenCalled();
  });

  it("supports documented UUID-shaped ACR run ids in both handles and durable receipts", async () => {
    const w = world(); const runId = "0accec26-d6de-4757-8e74-d080f38eaaab";
    w.state.before = (url) => {
      if (url.pathname.endsWith("/scheduleRun") || url.pathname.endsWith(`/runs/${runId}`)) return w.json({ id: `${registryId}/runs/${runId}`, name: runId, properties: { runId, status: "Succeeded", outputImages: [{ registry: "zenithregistry.azurecr.io", repository: "web", tag: JSON.parse([...w.receipts.references.values()][0] ?? "{}").tag, digest: DIGEST }] } });
    };
    const handle = await createAzureBuildPort(w.options).startBuild(w.ctx, input());
    expect(await createAzureBuildPort().waitForBuild(w.ctx, handle, { timeoutMs: 1000 })).toMatchObject({ status: "succeeded", digest: DIGEST });
  });

  it("refuses run identity mismatch and duplicate matching output digests", async () => {
    const w = world(); const handle = await createAzureBuildPort(w.options).startBuild(w.ctx, input());
    const props = w.state.run!.properties as { runId: string; outputImages: Record<string, unknown>[] };
    props.outputImages.push({ ...props.outputImages[0] });
    expect(await createAzureBuildPort().waitForBuild(w.ctx, handle, { timeoutMs: 1000 })).toMatchObject({ status: "failed" });
    props.runId = "foreign";
    await expect(createAzureBuildPort().waitForBuild(w.ctx, handle, { timeoutMs: 1000 })).rejects.toThrow("identity");
    await expect(createAzureBuildPort().waitForBuild(w.ctx, { buildId: "null" }, { timeoutMs: 1000 })).rejects.toThrow("handle");
  });
});

describe("Azure scheduled job digest confirmation", () => {
  it.each(["image", "built"])("preserves literal argv and clears only built bootstrap argv (%s artifact)", async (type) => {
    const w = world(); const current = (w.state.app.properties as { template: { containers: Record<string, unknown>[] } }).template.containers[0];
    current.image = BOOTSTRAP_IMAGE; current.args = ["-text", "custom"];
    const target = { ...service, spec: { ...service.spec, artifact: { type, ref: BOOTSTRAP_IMAGE } } };
    await createAzureWorkloadsPort().deployImage(w.ctx, target, { uri: IMAGE, digest: DIGEST }, { idempotencyKey: "argv-deploy" });
    expect((w.state.app.properties as { template: { containers: Record<string, unknown>[] } }).template.containers[0].args).toEqual(type === "built" ? [] : ["-text", "custom"]);
  });

  it.each(["Failed", "Canceled"])("does not report a replay successful while the target job update is %s", async (provisioningState) => {
    const w = world(); const id = `${ROOT}/Microsoft.App/jobs/report`;
    const job = { ...node("scheduled_job/report", "scheduled_job"), externalRef: id };
    w.state.jobs.set(id, { id, name: "report", type: "Microsoft.App/jobs", tags: tagged(job), properties: { provisioningState, template: { containers: [{ name: "report", image: IMAGE }] } } });
    await expect(createAzureWorkloadsPort().deployImage(w.ctx, job, { uri: IMAGE, digest: DIGEST }, { idempotencyKey: "job-deploy" })).rejects.toThrow("job image update failed");
    expect(w.fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false); expect(w.state.starts).toBe(0);
  });
});
