/**
 * C3 customer Blob Storage transport. A trusted workspace/environment binding
 * names the account/container; ARM ownership and private-container checks precede
 * data-plane calls. Bytes are bounded and SHA-256 checked, never logged or stored
 * in execution evidence. All authorization belongs to the current broker session.
 * Contract evidence only; no live Azure storage/build acceptance.
 */
import { createHash } from "node:crypto";
import type { AzureSession } from "@/lib/credentials/types";
import type { DriverContext } from "@/lib/drivers/types";
import { sha256Hex } from "@/lib/controlplane/digest";
import { StepFailedError } from "@/lib/execution/errors";
import { armClient, type ArmResource } from "@/lib/providers/azure/arm";
import { sourceStorageHost } from "../credentials";
import { awaitDataPlaneAccess, DataPlanePropagationTimeoutError } from "../data-plane-rbac";
import { API } from "@/lib/providers/azure/platform";
import { assertResource, context, rec, validId } from "./support";

export interface AzureSourceStorageBinding {
  accountResourceId: string;
  container: string;
  /** The managed object_store address whose ownership tags the account carries. */
  resourceAddress: string;
  cloud?: "public" | "usgov" | "china";
}
export type AzureSourceStorageResolver = (scope: {
  workspaceId: string; environmentId: string; subscriptionId: string; region: string;
}) => Promise<AzureSourceStorageBinding | null>;
export interface AzureSourceStorageOptions {
  resolveStorage?: AzureSourceStorageResolver;
  maxBytes?: number;
  timeoutMs?: number;
  /**
   * Retry an RBAC denial (403 AuthorizationPermissionMismatch) of the source container for up to this long, because a
   * data role assigned moments ago may not have propagated. 0 or omitted = fail at once. Firewall denials never retry.
   */
  propagationMs?: number;
  /** first backoff delay between propagation retries (default 2000 ms; tests shorten it) */
  propagationDelayMs?: number;
}
interface Location { bucket: string; origin: string; container: string }
interface Bundle { archive: Uint8Array; sha256: string; bytes: number }
interface Reference { s3Key: string; digest: string; bucket?: string }
const HARD_MAX_BYTES = 32 * 1024 * 1024;
const STORAGE_VERSION = "2023-11-03";
export class AzureSourceStorageRefusedError extends StepFailedError {}
function refuse(message: string): never { throw new AzureSourceStorageRefusedError(message); }
const interrupted = (): Error => { const error = new Error("Azure source storage operation was interrupted."); error.name = "AbortError"; return error; };
const check = (signal: AbortSignal) => { if (signal.aborted) throw interrupted(); };
const cancel = (res: Response) => { void res.body?.cancel().catch(() => undefined); };

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(interrupted()); };
    signal.addEventListener("abort", abort, { once: true });
    pending.then((value) => { signal.removeEventListener("abort", abort); resolve(value); }, (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}

function sourceKey(ctx: DriverContext<AzureSession>, reference: Reference): string {
  if (!reference || typeof reference.digest !== "string" || typeof reference.s3Key !== "string") refuse("Azure source object reference is malformed.");
  const hex = reference.digest.replace(/^sha256:/, "");
  const parts = reference.s3Key.split("/");
  if (!/^[a-f0-9]{64}$/.test(hex) || parts.length !== 4 || parts[0] !== "zenith" || parts[1] !== ctx.environmentId || !/^[A-Za-z0-9_.-]{1,128}$/.test(parts[2]) || [".", ".."].includes(parts[2]) || parts[3] !== `${hex}.tar.gz`) refuse("Azure source object is outside this environment or does not match its digest.");
  return hex;
}
const objectUrl = (location: Location, key: string) => `${location.origin}/${location.container}/${key.split("/").map(encodeURIComponent).join("/")}`;

export function createAzureSourceStorage(options: AzureSourceStorageOptions = {}) {
  const maxBytes = options.maxBytes ?? HARD_MAX_BYTES, timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > HARD_MAX_BYTES || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) refuse("Azure source storage bounds are invalid.");
  const bounded = (raw: DriverContext) => { check(raw.signal); return context({ ...raw, signal: AbortSignal.any([raw.signal, AbortSignal.timeout(timeoutMs)]) }); };
  const safe = async <T>(ctx: DriverContext<AzureSession>, fn: () => Promise<T>): Promise<T> => {
    try { check(ctx.signal); return await abortable(fn(), ctx.signal); }
    catch (error) { if (ctx.signal.aborted) throw interrupted(); if (error instanceof AzureSourceStorageRefusedError) throw error; throw new Error("Azure source storage operation could not be confirmed; no build source is available."); }
  };
  const resolve = async (ctx: DriverContext<AzureSession>): Promise<Location> => {
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(ctx.environmentId) || !ctx.workspaceId) refuse("Azure source storage scope is invalid.");
    if (!options.resolveStorage) refuse("Azure source preparation requires a trusted storage account/container binding for this environment.");
    const resolved = await abortable(options.resolveStorage({ workspaceId: ctx.workspaceId, environmentId: ctx.environmentId, subscriptionId: ctx.session.subscriptionId, region: ctx.region }), ctx.signal);
    if (!resolved) refuse("Azure source preparation requires a trusted storage account/container binding for this environment.");
    const binding = { ...resolved }; // Snapshot identifiers across asynchronous ARM reads.
    if (typeof binding.accountResourceId !== "string" || !validId(ctx, binding.accountResourceId, "Microsoft.Storage/storageAccounts") || typeof binding.resourceAddress !== "string" || !/^object_store\/[A-Za-z0-9_.-]{1,128}$/.test(binding.resourceAddress) || [".", ".."].includes(binding.resourceAddress.split("/")[1]) || typeof binding.container !== "string" || !/^[a-z0-9](?:[a-z0-9]|-(?!-)){1,61}[a-z0-9]$/.test(binding.container)) refuse("Azure source storage binding is outside this subscription or malformed.");
    const accountName = binding.accountResourceId.split("/").at(-1)!;
    if (!/^[a-z0-9]{3,24}$/.test(accountName)) refuse("Azure source storage account name is invalid.");
    const arm = armClient(ctx.session, ctx.signal);
    const account = (await abortable(arm.get<ArmResource>(binding.accountResourceId, { apiVersion: API.storage }), ctx.signal)).body;
    try { assertResource(ctx, { address: binding.resourceAddress } as Parameters<typeof assertResource>[1], account, "Microsoft.Storage/storageAccounts"); }
    catch { refuse("Azure source storage account is outside this workspace/environment/subscription."); }
    let host: string;
    try { host = sourceStorageHost(binding, ctx.session.subscriptionId, ctx.session.cloud); }
    catch { refuse("Azure source storage binding is outside this subscription or malformed."); }
    const origin = `https://${host}`;
    const properties = rec(account.properties);
    if (account.id.toLowerCase() !== binding.accountResourceId.toLowerCase() || account.name !== accountName || account.location?.toLowerCase() !== ctx.region || properties.provisioningState !== "Succeeded" || properties.allowSharedKeyAccess !== false || properties.allowBlobPublicAccess !== false || properties.supportsHttpsTrafficOnly !== true || rec(properties.primaryEndpoints).blob !== `${origin}/`) refuse("Azure source storage account identity or private Entra-only posture could not be verified.");
    const containerId = `${account.id}/blobServices/default/containers/${binding.container}`;
    const container = (await abortable(arm.get<ArmResource>(containerId, { apiVersion: API.storage }), ctx.signal)).body;
    if (typeof container.id !== "string" || container.id.toLowerCase() !== containerId.toLowerCase() || container.name !== binding.container || container.type?.toLowerCase() !== "microsoft.storage/storageaccounts/blobservices/containers" || ![undefined, "None"].includes(rec(container.properties).publicAccess as string | undefined)) refuse("Azure source container identity or private access could not be verified.");
    return { bucket: `${accountName}/${binding.container}`, origin, container: binding.container };
  };
  const propagationMs = options.propagationMs ?? 0;
  if (!Number.isSafeInteger(propagationMs) || propagationMs < 0 || propagationMs > 600_000) refuse("Azure source storage propagation bound is invalid.");
  class BlobRbacDenied extends Error {}
  const request = async (ctx: DriverContext<AzureSession>, url: string, init: RequestInit = {}): Promise<Response> => {
    if (propagationMs === 0) return requestOnce(ctx, url, init);
    try {
      const waited = await awaitDataPlaneAccess(async () => {
        const res = await requestOnce(ctx, url, init);
        const code = res.headers.get("x-ms-error-code");
        if (res.status === 403 && (code === null || code === "AuthorizationPermissionMismatch")) { cancel(res); throw new BlobRbacDenied(); }
        return res;
      }, (error) => error instanceof BlobRbacDenied, { timeoutMs: propagationMs, signal: ctx.signal, initialDelayMs: options.propagationDelayMs });
      return waited.result;
    } catch (error) {
      if (error instanceof BlobRbacDenied || error instanceof DataPlanePropagationTimeoutError) refuse("Azure source container denied the deploy identity; assign Storage Blob Data Contributor on the source container (data plane) and allow time for role propagation.");
      throw error;
    }
  };
  const requestOnce = async (ctx: DriverContext<AzureSession>, url: string, init: RequestInit = {}) => {
    check(ctx.signal);
    const pending = ctx.session.authorizedFetch(url, { ...init, headers: { "x-ms-version": STORAGE_VERSION, "x-ms-date": ctx.now().toUTCString(), ...init.headers }, redirect: "error", signal: ctx.signal });
    void pending.then((res) => { if (ctx.signal.aborted) cancel(res); }, () => undefined);
    const res = await abortable(pending, ctx.signal);
    if (res.redirected || (res.url && res.url !== url)) { cancel(res); refuse("Azure source transport returned a redirected or foreign object response."); }
    return res;
  };
  const read = async (ctx: DriverContext<AzureSession>, location: Location, reference: Reference): Promise<Uint8Array> => {
    const hex = sourceKey(ctx, reference);
    if (reference.bucket !== location.bucket) refuse("Azure source object names a foreign storage account or container.");
    const res = await request(ctx, objectUrl(location, reference.s3Key));
    if (res.status !== 200) { cancel(res); refuse("Azure source blob could not be read from the bound container."); }
    const length = res.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) <= 0 || Number(length) > maxBytes)) { cancel(res); refuse("Azure source blob exceeds its size bound or has an invalid length."); }
    if (!res.body) refuse("Azure source blob has no body.");
    const reader = res.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        check(ctx.signal);
        const { done, value } = await abortable(reader.read(), ctx.signal);
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) refuse("Azure source blob exceeds its size bound.");
        chunks.push(value);
      }
    } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const archive = Buffer.concat(chunks, size);
    if (size === 0 || (length !== null && size !== Number(length)) || sha256Hex(archive) !== hex) refuse("Azure source blob does not match the recorded digest or size.");
    return new Uint8Array(archive.buffer, archive.byteOffset, archive.byteLength);
  };
  return {
    async resolve(raw: DriverContext): Promise<Location> { const ctx = bounded(raw); return safe(ctx, () => resolve(ctx)); },
    async upload(raw: DriverContext, location: Location, key: string, bundle: Bundle): Promise<void> {
      const ctx = bounded(raw);
      return safe(ctx, async () => {
        const reference = { s3Key: key, digest: bundle.sha256, bucket: location.bucket };
        sourceKey(ctx, reference);
        if (!(bundle.archive instanceof Uint8Array) || bundle.bytes !== bundle.archive.byteLength || bundle.bytes === 0 || bundle.bytes > maxBytes || sha256Hex(bundle.archive) !== bundle.sha256) refuse("Azure source upload bytes do not match the recorded digest/size bounds.");
        // Revalidate the binding rather than trusting a caller-supplied URL.
        const verified = await resolve(ctx);
        if (verified.bucket !== location.bucket || verified.origin !== location.origin || verified.container !== location.container) refuse("Azure source storage binding changed before upload.");
        const md5 = createHash("md5").update(bundle.archive).digest("base64"); // REST transport integrity, not the source identity
        const res = await request(ctx, objectUrl(verified, key), { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": "application/gzip", "Content-Length": String(bundle.bytes), "Content-MD5": md5, "If-None-Match": "*" }, body: new Uint8Array(bundle.archive) });
        cancel(res);
        if (res.status !== 201 && res.status !== 412) refuse("Azure source upload was not confirmed.");
        if (res.status === 201 && res.headers.get("content-md5") !== md5) refuse("Azure source upload integrity was not confirmed.");
        // Verify bytes even on create-only conflicts; never replace an existing key.
        const stored = await read(ctx, verified, reference);
        if (stored.byteLength !== bundle.bytes) refuse("Azure source blob does not match the prepared size.");
      });
    },
    async readSource(raw: DriverContext<AzureSession>, reference: Reference): Promise<Uint8Array> {
      const ctx = bounded(raw);
      return safe(ctx, async () => { sourceKey(ctx, reference); return read(ctx, await resolve(ctx), reference); });
    },
  };
}
