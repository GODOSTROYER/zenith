/** Canonical source + storage/ACR contract fixture, never live evidence. */
import { vi } from "vitest";
import { gzipSync } from "node:zlib";
import type { StoredResource } from "@/lib/execution/ports";
import { createSourceBundles } from "@/lib/platform/source-bundle";
import { storageWorld } from "../providers/azure/source-storage-fixtures";
import { pipeline, service, registry } from "../providers/azure/release-fixtures";
import { writeTar } from "../_support/tar";

export function azureSourceWorld() {
  const w = storageWorld(); w.storage.blobs.clear();
  const source = { repo: "acme/app", ref: "exact-ref", dockerfile: "Dockerfile" };
  const buildPipeline = { ...pipeline, spec: { ...pipeline.spec, source } };
  const rows: StoredResource[] = [service, buildPipeline].map((n) => ({ ...n, id: n.address, workspaceId: w.ctx.workspaceId, environmentId: w.ctx.environmentId, status: "active", externalId: n.externalRef }));
  const resources = { list: vi.fn(async () => rows) };
  const tar = writeTar([{ path: "root/Dockerfile", bytes: Buffer.from("FROM scratch\nCOPY . /app\n") }, { path: "root/binary.bin", bytes: Buffer.from([0, 255, 128]) }]);
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(gzipSync(tar))));
  const deps = { resources, fetchImpl, azureStorage: w.resolveStorage };
  return { ...w, source, pipeline: buildPipeline, service, registry, rows, resources, fetchImpl, deps, bundles: createSourceBundles(deps) };
}
