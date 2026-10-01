/** Synthetic REST evidence only; no live Azure acceptance. */
import { describe, expect, it, vi } from "vitest";
import { StepFailedError } from "@/lib/execution/errors";
import { createAzureSourceStorage } from "@/lib/providers/azure/release/source-storage";
import { checkAuthorizedUrl } from "@/lib/providers/azure/credentials";
import { storageWorld, ACCOUNT, CONTAINER, binding, accountId } from "./source-storage-fixtures";
import { SUB, WS, ENV, REGION } from "./release-fixtures";
const SENTINEL = "private-secret-sentinel";

describe("Azure stored C3 source reader", () => {
  it("reads exact bytes through the current session after ARM ownership checks", async () => {
    const w = storageWorld(); const reader = createAzureSourceStorage({ resolveStorage: w.resolveStorage });
    expect(await reader.readSource(w.ctx, w.reference)).toEqual(w.archive);
    expect(w.resolveStorage).toHaveBeenCalledWith({ workspaceId: WS, environmentId: ENV, subscriptionId: SUB, region: REGION });
    expect(w.fetcher).toHaveBeenLastCalledWith(`https://${ACCOUNT}.blob.core.windows.net/${CONTAINER}/${w.reference.s3Key}`, expect.objectContaining({ redirect: "error", headers: { "x-ms-version": "2023-11-03", "x-ms-date": w.ctx.now().toUTCString() }, signal: expect.any(AbortSignal) }));
    expect(w.ctx.log).not.toHaveBeenCalled();
  });
  it.each([
    ["usgov", "blob.core.usgovcloudapi.net"], ["china", "blob.core.chinacloudapi.cn"],
  ] as const)("reads the exact trusted %s Blob endpoint without claiming sovereign ARM readiness", async (cloud, suffix) => {
    const w = storageWorld(); w.storage.account.properties.primaryEndpoints.blob = `https://${ACCOUNT}.${suffix}/`;
    const reader = createAzureSourceStorage({ resolveStorage: async () => ({ ...binding, cloud }) });
    expect(await reader.readSource(w.ctx, w.reference)).toEqual(w.archive);
    expect(w.fetcher).toHaveBeenLastCalledWith(`https://${ACCOUNT}.${suffix}/${CONTAINER}/${w.reference.s3Key}`, expect.objectContaining({ redirect: "error" }));
  });
  it.each([undefined, vi.fn(async () => null)])("refuses missing environment bindings before any HTTP call", async (resolveStorage) => {
    const w = storageWorld();
    await expect(createAzureSourceStorage({ resolveStorage }).readSource(w.ctx, w.reference)).rejects.toThrow("storage account/container binding");
    expect(w.fetcher).not.toHaveBeenCalled();
  });
  it("refuses a foreign container or account before a blob read", async () => {
    const w = storageWorld(); const reader = createAzureSourceStorage({ resolveStorage: w.resolveStorage });
    for (const bucket of [`${ACCOUNT}/foreign`, `foreign/${CONTAINER}`, `${ACCOUNT}/${CONTAINER}?sig=${SENTINEL}`, undefined]) {
      await expect(reader.readSource(w.ctx, { ...w.reference, bucket })).rejects.toThrow("foreign storage account or container");
    }
    expect(w.fetcher.mock.calls.every(([url]) => !url.includes("blob.core"))).toBe(true);
  });
  it.each(["workspace", "environment", "managed", "resource"])("refuses foreign %s tags", async (tag) => {
    const w = storageWorld(); w.storage.account.tags[`zenith:${tag}` as keyof typeof w.storage.account.tags] = "foreign";
    await expect(createAzureSourceStorage({ resolveStorage: w.resolveStorage }).readSource(w.ctx, w.reference)).rejects.toThrow("outside");
    expect(w.fetcher.mock.calls.every(([url]) => !url.includes("blob.core"))).toBe(true);
  });
  it.each([
    { accountResourceId: accountId.replace(SUB, "99999999-2222-3333-4444-555555555555") },
    { accountResourceId: `${accountId}?sig=${SENTINEL}` },
    { container: "../escape" }, { container: "bad--container" }, { resourceAddress: "object_store/.." },
  ])("refuses malformed or cross-subscription bindings %j", async (change) => {
    const w = storageWorld();
    await expect(createAzureSourceStorage({ resolveStorage: async () => ({ ...binding, ...change }) }).readSource(w.ctx, w.reference)).rejects.toThrow("binding");
    expect(w.fetcher).not.toHaveBeenCalled();
  });
  it("refuses mismatched ARM account/container identities and public or shared-key posture", async () => {
    for (const mutate of [
      (w: ReturnType<typeof storageWorld>) => { w.storage.account.id += "foreign"; },
      (w: ReturnType<typeof storageWorld>) => { w.storage.account.properties.allowSharedKeyAccess = true; },
      (w: ReturnType<typeof storageWorld>) => { w.storage.account.properties.primaryEndpoints.blob = "https://foreign.blob.core.windows.net/"; },
      (w: ReturnType<typeof storageWorld>) => { w.storage.container.id += "foreign"; },
      (w: ReturnType<typeof storageWorld>) => { w.storage.container.properties.publicAccess = "Blob"; },
    ]) {
      const w = storageWorld(); mutate(w);
      await expect(createAzureSourceStorage({ resolveStorage: w.resolveStorage }).readSource(w.ctx, w.reference)).rejects.toThrow();
      expect(w.fetcher.mock.calls.every(([url]) => !url.includes("blob.core"))).toBe(true);
    }
  });
  it.each(["../escape", "zenith/foreign/web/a.tar.gz", `https://example.com/?sig=${SENTINEL}`, "zenith/env-1/../a.tar.gz"])("refuses unsafe or out-of-scope object key %s before any HTTP", async (s3Key) => {
    const w = storageWorld();
    await expect(createAzureSourceStorage({ resolveStorage: w.resolveStorage }).readSource(w.ctx, { ...w.reference, s3Key })).rejects.toThrow("object");
    expect(w.fetcher).not.toHaveBeenCalled();
  });
  it("refuses changed bytes even when the size is unchanged", async () => {
    const w = storageWorld(); w.storage.blobs.set(`/${CONTAINER}/${w.reference.s3Key}`, new Uint8Array([0, 1, 2, 3]));
    await expect(createAzureSourceStorage({ resolveStorage: w.resolveStorage }).readSource(w.ctx, w.reference)).rejects.toThrow("recorded digest");
  });
  it.each(["redirected", "foreign-url", "redirect-status"] as const)("refuses %s source responses", async (mode) => {
    const w = storageWorld();
    w.storage.before = (url) => {
      if (!url.hostname.includes("blob.core")) return undefined;
      const res = new Response(w.archive, { status: mode === "redirect-status" ? 302 : 200 });
      if (mode === "redirected") Object.defineProperty(res, "redirected", { value: true });
      if (mode === "foreign-url") Object.defineProperty(res, "url", { value: "https://foreign.blob.core.windows.net/foreign/source" });
      return res;
    };
    await expect(createAzureSourceStorage({ resolveStorage: w.resolveStorage }).readSource(w.ctx, w.reference)).rejects.toThrow(/redirected|bound container/);
  });
  it("snapshots a binding while an ARM read is pending", async () => {
    const w = storageWorld(); const mutableBinding = { ...binding };
    w.storage.before = (url) => { if (url.pathname === accountId) mutableBinding.container = "foreign-container"; return undefined; };
    expect(await createAzureSourceStorage({ resolveStorage: async () => mutableBinding }).readSource(w.ctx, w.reference)).toEqual(w.archive);
    expect(mutableBinding.container).toBe("foreign-container");
  });
  it.each([true, false])("caps oversized bodies with content-length present=%s and cancels them", async (header) => {
    const w = storageWorld(); const cancel = vi.fn();
    w.storage.before = (url) => url.hostname.includes("blob.core") ? new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(5)); }, cancel }), { headers: header ? { "content-length": "5" } : {} }) : undefined;
    await expect(createAzureSourceStorage({ resolveStorage: w.resolveStorage, maxBytes: 4 }).readSource(w.ctx, w.reference)).rejects.toThrow("size bound");
    expect(cancel).toHaveBeenCalled();
  });
  it.each([0, 3, 5])("refuses empty or truncated size %s", async (length) => {
    const w = storageWorld();
    w.storage.before = (url) => url.hostname.includes("blob.core") ? new Response(length === 0 ? new Uint8Array() : w.archive, { headers: { "content-length": String(length) } }) : undefined;
    await expect(createAzureSourceStorage({ resolveStorage: w.resolveStorage }).readSource(w.ctx, w.reference)).rejects.toThrow(/length|size/);
  });
  it("sanitizes transport/resolver errors, cloud bodies and abort reasons", async () => {
    const w = storageWorld();
    for (const error of [new Error(SENTINEL), new StepFailedError(SENTINEL)]) {
      await expect(createAzureSourceStorage({ resolveStorage: async () => { throw error; } }).readSource(w.ctx, w.reference)).rejects.toThrow("could not be confirmed");
    }
    w.storage.before = (url) => url.hostname.includes("blob.core") ? new Response(SENTINEL, { status: 403 }) : undefined;
    await expect(createAzureSourceStorage({ resolveStorage: w.resolveStorage }).readSource(w.ctx, w.reference)).rejects.toThrow("bound container");
    const abort = new AbortController(); abort.abort(new Error(SENTINEL));
    await expect(createAzureSourceStorage({ resolveStorage: w.resolveStorage }).readSource({ ...w.ctx, signal: abort.signal }, w.reference)).rejects.toThrow("interrupted");
    expect(w.ctx.log).not.toHaveBeenCalled();
  });
  it("bounds a transport and body reader that ignore cancellation", async () => {
    const w = storageWorld();
    for (const mode of ["fetch", "body"] as const) {
      w.storage.before = async (url) => {
        if (!url.hostname.includes("blob.core")) return undefined;
        if (mode === "fetch") return new Promise<Response>(() => undefined);
        return new Response(new ReadableStream({ pull: () => new Promise<void>(() => undefined) }));
      };
      await expect(createAzureSourceStorage({ resolveStorage: w.resolveStorage, timeoutMs: 25 }).readSource(w.ctx, w.reference)).rejects.toThrow("interrupted");
    }
  });
  it("refuses Blob access without an exact trusted account host", () => {
    expect(() => checkAuthorizedUrl(`https://${ACCOUNT}.blob.core.windows.net/${CONTAINER}/source.tar.gz`)).toThrow("not an Azure endpoint");
    expect(checkAuthorizedUrl(`https://${ACCOUNT}.blob.core.windows.net/${CONTAINER}/source.tar.gz`, `${ACCOUNT}.blob.core.windows.net`).audience).toBe("storage");
  });
});

describe("Azure create-only C3 upload", () => {
  it("uploads gzip with integrity and verifies stored bytes without replacing an existing key", async () => {
    const w = storageWorld(); w.storage.blobs.clear();
    const transport = createAzureSourceStorage({ resolveStorage: w.resolveStorage }); const location = await transport.resolve(w.ctx);
    const bundle = { archive: w.archive, sha256: w.reference.digest, bytes: w.archive.byteLength };
    await Promise.all([transport.upload(w.ctx, location, w.reference.s3Key, bundle), transport.upload(w.ctx, location, w.reference.s3Key, bundle)]);
    const puts = w.fetcher.mock.calls.filter(([, init]) => init?.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(puts[0][1]).toMatchObject({ redirect: "error", headers: { "If-None-Match": "*", "x-ms-blob-type": "BlockBlob", "Content-Type": "application/gzip", "Content-Length": "4" } });
    expect(puts[0][1]?.headers).not.toHaveProperty("Authorization");
    expect(w.storage.blobs.size).toBe(1);
  });
  it("refuses corrupt existing objects, failed uploads and unconfirmed upload checksums", async () => {
    for (const mode of ["existing", "status", "checksum"] as const) {
      const w = storageWorld(); const transport = createAzureSourceStorage({ resolveStorage: w.resolveStorage }); const location = await transport.resolve(w.ctx);
      if (mode === "existing") w.storage.blobs.set(`/${CONTAINER}/${w.reference.s3Key}`, new Uint8Array([0, 1, 2, 3]));
      else { w.storage.blobs.clear(); if (mode === "status") w.storage.putStatus = 403; else w.storage.md5 = "foreign-checksum"; }
      await expect(transport.upload(w.ctx, location, w.reference.s3Key, { archive: w.archive, sha256: w.reference.digest, bytes: 4 })).rejects.toThrow();
    }
  });
  it("refuses caller-supplied foreign upload origins", async () => {
    const w = storageWorld(); const transport = createAzureSourceStorage({ resolveStorage: w.resolveStorage }); const location = await transport.resolve(w.ctx);
    await expect(transport.upload(w.ctx, { ...location, origin: "https://attacker.example" }, w.reference.s3Key, { archive: w.archive, sha256: w.reference.digest, bytes: 4 })).rejects.toThrow("binding changed");
    expect(w.fetcher.mock.calls.every(([, init]) => init?.method !== "PUT")).toBe(true);
  });
});
