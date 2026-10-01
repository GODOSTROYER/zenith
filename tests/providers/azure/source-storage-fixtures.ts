/** Mocked ARM/Blob REST contracts, extending the existing ACR fixture. */
import { vi } from "vitest";
import { sha256Hex } from "@/lib/controlplane/digest";
import { world, ROOT, ENV, REGION, tagged } from "./release-fixtures";
import type { AzureSourceStorageBinding } from "@/lib/providers/azure/release/source-storage";

export const ACCOUNT = "zenithsource", CONTAINER = "source-bundles";
export const accountId = `${ROOT}/Microsoft.Storage/storageAccounts/${ACCOUNT}`;
export const containerId = `${accountId}/blobServices/default/containers/${CONTAINER}`;
export const binding: AzureSourceStorageBinding = { accountResourceId: accountId, container: CONTAINER, resourceAddress: "object_store/build-source" };
export function storageWorld() {
  const w = world();
  const resolveStorage = vi.fn(async () => ({ ...binding }));
  const storage = {
    account: { id: accountId, name: ACCOUNT, type: "Microsoft.Storage/storageAccounts", location: REGION, tags: tagged({ address: binding.resourceAddress } as Parameters<typeof tagged>[0]), properties: { provisioningState: "Succeeded", allowSharedKeyAccess: false, allowBlobPublicAccess: false, supportsHttpsTrafficOnly: true, primaryEndpoints: { blob: `https://${ACCOUNT}.blob.core.windows.net/` } } },
    container: { id: containerId, name: CONTAINER, type: "Microsoft.Storage/storageAccounts/blobServices/containers", properties: { publicAccess: "None" } },
    blobs: new Map<string, Uint8Array>(),
    putStatus: undefined as number | undefined,
    md5: undefined as string | undefined,
    before: undefined as ((url: URL, init?: RequestInit) => Response | undefined | Promise<Response | undefined>) | undefined,
  };
  w.state.before = async (url, init) => {
    const override = await storage.before?.(url, init); if (override) return override;
    if (url.pathname === accountId) return w.json(storage.account);
    if (url.pathname === containerId) return w.json(storage.container);
    if (url.hostname !== new URL(storage.account.properties.primaryEndpoints.blob).hostname) return undefined;
    const key = decodeURIComponent(url.pathname);
    if (init?.method === "PUT") {
      if (storage.putStatus && storage.putStatus !== 201 && storage.putStatus !== 412) return new Response("secret-cloud-body", { status: storage.putStatus });
      if (storage.blobs.has(key) || storage.putStatus === 412) return new Response(null, { status: 412 });
      storage.blobs.set(key, new Uint8Array(init.body as Uint8Array));
      return new Response(null, { status: 201, headers: { "content-md5": storage.md5 ?? new Headers(init.headers).get("Content-MD5")! } });
    }
    const blob = storage.blobs.get(key);
    return blob ? new Response(new Uint8Array(blob), { headers: { "content-length": String(blob.byteLength) } }) : new Response("secret-cloud-body", { status: 404 });
  };
  const archive = new Uint8Array([31, 139, 8, 0]);
  const reference = { s3Key: `zenith/${ENV}/web/${sha256Hex(archive)}.tar.gz`, digest: sha256Hex(archive), bucket: `${ACCOUNT}/${CONTAINER}` };
  storage.blobs.set(`/${CONTAINER}/${reference.s3Key}`, archive);
  return { ...w, storage, resolveStorage, archive, reference };
}
