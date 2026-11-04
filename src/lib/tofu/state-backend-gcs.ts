/**
 * GCS restore adapter over object generations (PROD-DUR-06). Same contract as the AWS S3 adapter: live probe, exact-key
 * version listing, digest-verified reads, a conditional write (`ifGenerationMatch`) that creates a NEW current generation,
 * readback by the service. It cannot delete anything: no DELETE request, lifecycle call or lock removal exists here.
 *
 * Authentication is ONLY the brokered GcpSession (`authorizedFetch`): keyless workload identity federation through the
 * credential broker, which already honours the connection's mode, custody and revocation. This module never reads a key,
 * mints a token or contacts a token endpoint. Hosts are fixed to storage.googleapis.com, redirects are refused, every call has
 * a deadline and every body a size cap. The fetch function is injectable so the contract is testable without a network;
 * nothing here is proved against a live Google project.
 *
 * Azure Blob and OCI Object Storage have no adapter: the brokered Azure session authorizes Blob hosts only for a bound
 * source-storage account, and the OCI session is a runner transport that carries JSON for allowlisted bucket paths only, so
 * object bytes cannot flow through it. Both are refused explicitly (see `sessionRefusal` in platform/state-recovery.ts).
 */
import { createHash } from "node:crypto";
import type { BackendConfig } from "@/lib/tofu/backend-config";
import type { BackendProbeVerdict } from "@/lib/tofu/backend-capabilities";
import { MAX_STATE_BYTES, StateBackendError, type StateBackendStore, type StateObjectRead, type StateObjectVersion } from "@/lib/tofu/state-backend-s3";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
function fail(code: string, message: string): never { throw new StateBackendError(code, message); }
const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const TIMEOUT_MS = 30_000;
const META_MAX = 1024 * 1024;

async function call(f: Fetch, url: string, init: RequestInit = {}): Promise<Response> {
  try { return await f(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch { return fail("backend_unreachable", "The state backend could not be reached."); }
}
async function bytesOf(res: Response, max: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => undefined); return fail("version_unavailable", "The state object is too large to restore."); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  try { const v: unknown = JSON.parse((await bytesOf(res, META_MAX)).toString("utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}; }
  catch { return {}; }
}
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const toBody = (b: Buffer): BodyInit => new Uint8Array(b);

/* ----------------------------------- GCS ------------------------------------ */

const GCS = "https://storage.googleapis.com";
const GENERATION = /^\d{1,24}$/;
export class GcsStateStore implements StateBackendStore {
  constructor(private readonly f: Fetch, private readonly w: { bucket: string; object: string; lockObject: string }) {}
  private async req(url: string, init: RequestInit = {}): Promise<Response> {
    return call(this.f, url, init);
  }
  private obj(name: string): string { return `${GCS}/storage/v1/b/${encodeURIComponent(this.w.bucket)}/o/${encodeURIComponent(name)}`; }
  private async meta(name: string): Promise<Record<string, unknown> | undefined | null> {
    const res = await this.req(`${this.obj(name)}?fields=generation,kmsKeyName,size`);
    if (res.status === 404) { await res.body?.cancel().catch(() => undefined); return undefined; }
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); return null; }
    return jsonOf(res);
  }
  async probe(): Promise<BackendProbeVerdict> {
    const refusals: string[] = [];
    let versioning: BackendProbeVerdict["versioning"] = "unknown";
    const bucket = await this.req(`${GCS}/storage/v1/b/${encodeURIComponent(this.w.bucket)}?fields=versioning`);
    if (bucket.ok) { const j = await jsonOf(bucket); versioning = (j.versioning as { enabled?: unknown } | undefined)?.enabled === true ? "enabled" : "disabled"; }
    else { await bucket.body?.cancel().catch(() => undefined); refusals.push("Bucket versioning could not be read; the credentials may lack storage.buckets.get."); }
    const current = await this.meta(this.w.object);
    let currentVersionId: string | undefined, encryption: BackendProbeVerdict["encryption"] = "unknown";
    if (!current) refusals.push(current === undefined ? "The state object does not exist." : "The state object could not be inspected.");
    else { currentVersionId = str(current.generation); encryption = str(current.kmsKeyName) ? "sse_kms" : "sse_s3"; }
    const lock = await this.meta(this.w.lockObject);
    const lockObject: BackendProbeVerdict["lockObject"] = lock === undefined ? "absent" : lock === null ? "unknown" : "present";
    if (versioning === "disabled") refusals.push("Bucket versioning is disabled.");
    return Object.freeze({ backendKind: "gcs", versioning, encryption, lockObject, ...(currentVersionId ? { currentVersionId } : {}),
      restoreReady: versioning === "enabled" && lockObject === "absent" && !!currentVersionId && refusals.length === 0, refusals: Object.freeze(refusals) });
  }
  async listVersions(limit: number): Promise<StateObjectVersion[]> {
    const out: StateObjectVersion[] = [];
    let page: string | undefined;
    for (let i = 0; i < 5; i++) {
      const res = await this.req(`${GCS}/storage/v1/b/${encodeURIComponent(this.w.bucket)}/o?versions=true&prefix=${encodeURIComponent(this.w.object)}&maxResults=100&fields=items(name,generation,size,timeDeleted,updated),nextPageToken${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`);
      if (!res.ok) { await res.body?.cancel().catch(() => undefined); return fail("backend_unreachable", "The state backend versions could not be listed."); }
      const j = await jsonOf(res);
      for (const item of Array.isArray(j.items) ? j.items as Record<string, unknown>[] : []) {
        if (item.name !== this.w.object || !str(item.generation)) continue;
        out.push({ versionId: String(item.generation), isLatest: item.timeDeleted === undefined, size: Number(item.size ?? 0) || 0, ...(str(item.updated) ? { lastModified: String(item.updated) } : {}) });
        if (out.length >= limit) return out;
      }
      page = str(j.nextPageToken);
      if (!page) break;
    }
    return out;
  }
  private async read(generation?: string): Promise<StateObjectRead> {
    if (generation !== undefined && !GENERATION.test(generation)) fail("version_unavailable", "The state object version could not be read.");
    const res = await this.req(`${this.obj(this.w.object)}?alt=media${generation ? `&generation=${generation}` : ""}`);
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); return fail("version_unavailable", "The state object version could not be read."); }
    const bytes = await bytesOf(res, MAX_STATE_BYTES);
    if (bytes.length < 1) fail("version_unavailable", "The state object is empty.");
    const id = res.headers.get("x-goog-generation") ?? generation ?? "";
    return { bytes, sha256: sha256(bytes), versionId: id, ...(id ? { etag: id } : {}) };
  }
  readVersion(versionId: string): Promise<StateObjectRead> { return this.read(versionId); }
  readCurrent(): Promise<StateObjectRead> { return this.read(); }
  async writeRestored(bytes: Buffer, expect: { currentEtag: string }): Promise<{ versionId: string }> {
    if (!GENERATION.test(expect.currentEtag)) fail("state_changed", "The state object changed after review; nothing was written.");
    const current = await this.meta(this.w.object);
    if (!current || str(current.generation) !== expect.currentEtag) fail("state_changed", "The state object changed after review; nothing was written.");
    const kms = str(current!.kmsKeyName);
    const url = `${GCS}/upload/storage/v1/b/${encodeURIComponent(this.w.bucket)}/o?uploadType=media&name=${encodeURIComponent(this.w.object)}&ifGenerationMatch=${expect.currentEtag}${kms ? `&kmsKeyName=${encodeURIComponent(kms)}` : ""}&fields=generation`;
    const res = await this.req(url, { method: "POST", headers: { "content-type": "application/json" }, body: toBody(bytes) }).catch(() => fail("write_unconfirmed", "The restore write could not be confirmed; inspect the state object versions before another attempt."));
    if (res.status === 412) { await res.body?.cancel().catch(() => undefined); return fail("state_changed", "The state object changed after review; nothing was written."); }
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); return fail("write_unconfirmed", "The restore write could not be confirmed; inspect the state object versions before another attempt."); }
    const generation = str((await jsonOf(res)).generation);
    return generation ? { versionId: generation } : fail("write_unconfirmed", "The backend returned no new generation; inspect the state object versions before another attempt.");
  }
}

/** The brokered session's own authorized fetch is the only transport. */
export function gcsStoreFromSession(session: { authorizedFetch(url: string, init?: RequestInit): Promise<Response> }, backend: BackendConfig, stateKey: string): StateBackendStore {
  if (backend.kind !== "gcs") fail("unsupported_backend", "This is not a GCS backend.");
  const gcs = backend as Extract<BackendConfig, { kind: "gcs" }>;
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(gcs.bucket)) fail("unsupported_backend", "The GCS bucket name is invalid.");
  return new GcsStateStore((url, init) => session.authorizedFetch(url, init), { bucket: gcs.bucket, object: stateKey, lockObject: `${stateKey.replace(/\.tfstate$/, "")}.tflock` });
}
