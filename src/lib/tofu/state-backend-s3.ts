/**
 * Versioned-object adapter for AWS S3 OpenTofu state (PROD-DUR-06): live capability probe, version listing,
 * verified readback and a non-destructive restore. It never deletes an object, a version or a lock.
 *
 * Restore means: read an earlier version's bytes, prove their SHA-256 equals the digest the human approved,
 * write those exact bytes as a NEW current version (all prior versions remain recoverable), then read the
 * current object back and prove its digest. Writes are compare-and-set against the current ETag so a writer that
 * got in after the probe makes the restore fail closed instead of overwriting it.
 *
 * Only AWS S3 is supported: an S3-compatible endpoint (OCI) is refused because its versioning and conditional
 * write behaviour are not verified here. The client is injectable so the contract is testable without a network;
 * live behaviour against real S3 is unproved by this module.
 */
import { createHash } from "node:crypto";
import type { S3Client } from "@aws-sdk/client-s3";
import type { BackendConfig } from "@/lib/tofu/backend-config";
import { assessBackend, type BackendProbeVerdict } from "@/lib/tofu/backend-capabilities";

export const MAX_STATE_BYTES = 64 * 1024 * 1024;
const LOCK_SUFFIX = ".tflock";

export class StateBackendError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
function fail(code: string, message: string): never { throw new StateBackendError(code, message); }

export interface StateObjectVersion { readonly versionId: string; readonly isLatest: boolean; readonly size: number; readonly lastModified?: string }
export interface StateObjectRead { readonly bytes: Buffer; readonly sha256: string; readonly versionId: string; readonly etag?: string }
export interface StateBackendStore {
  probe(): Promise<BackendProbeVerdict>;
  listVersions(limit: number): Promise<StateObjectVersion[]>;
  readVersion(versionId: string): Promise<StateObjectRead>;
  readCurrent(): Promise<StateObjectRead>;
  /** Write approved, digest-verified bytes as a new current version, compare-and-set on the observed current ETag. Returns the new version id. */
  writeRestored(bytes: Buffer, expect: { currentEtag: string }): Promise<{ versionId: string }>;
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
type Sdk = typeof import("@aws-sdk/client-s3");
interface Sender { send(command: unknown): Promise<unknown> }
const statusOf = (err: unknown): number | undefined => (err as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata?.httpStatusCode;
const nameOf = (err: unknown): string | undefined => (err as { name?: string } | undefined)?.name;

export class S3StateStore implements StateBackendStore {
  constructor(private readonly client: Sender, private readonly sdk: Sdk, private readonly where: { bucket: string; key: string }) {}

  private async head(versionId?: string) {
    try {
      return await this.client.send(new this.sdk.HeadObjectCommand({ Bucket: this.where.bucket, Key: this.where.key, ...(versionId ? { VersionId: versionId } : {}) })) as
        { VersionId?: string; ETag?: string; ServerSideEncryption?: string; ContentLength?: number };
    } catch (err) {
      if (statusOf(err) === 404 || nameOf(err) === "NotFound" || nameOf(err) === "NoSuchKey" || nameOf(err) === "NoSuchVersion") return undefined;
      throw new StateBackendError("backend_unreachable", "The state backend could not be reached with the supplied credentials.");
    }
  }

  async probe(): Promise<BackendProbeVerdict> {
    const refusals: string[] = [];
    let versioning: BackendProbeVerdict["versioning"] = "unknown";
    try {
      const out = await this.client.send(new this.sdk.GetBucketVersioningCommand({ Bucket: this.where.bucket })) as { Status?: string };
      versioning = out.Status === "Enabled" ? "enabled" : out.Status === "Suspended" ? "suspended" : "disabled";
    } catch { refusals.push("Bucket versioning could not be read; the credentials may lack s3:GetBucketVersioning."); }
    let encryption: BackendProbeVerdict["encryption"] = "unknown", currentVersionId: string | undefined;
    try {
      const head = await this.head();
      if (!head) refusals.push("The state object does not exist.");
      else {
        currentVersionId = head.VersionId && head.VersionId !== "null" ? head.VersionId : undefined;
        encryption = head.ServerSideEncryption === "aws:kms" || head.ServerSideEncryption === "aws:kms:dsse" ? "sse_kms" : head.ServerSideEncryption === "AES256" ? "sse_s3" : "none";
      }
    } catch { refusals.push("The state object could not be inspected."); }
    let lockObject: BackendProbeVerdict["lockObject"] = "unknown";
    try {
      const lock = await this.client.send(new this.sdk.HeadObjectCommand({ Bucket: this.where.bucket, Key: `${this.where.key}${LOCK_SUFFIX}` })).then(() => "present" as const)
        .catch((err: unknown) => (statusOf(err) === 404 || nameOf(err) === "NotFound" || nameOf(err) === "NoSuchKey" ? "absent" as const : "unknown" as const));
      lockObject = lock;
    } catch { lockObject = "unknown"; }
    if (versioning !== "enabled" && versioning !== "unknown") refusals.push(`Bucket versioning is ${versioning}.`);
    return Object.freeze({ backendKind: "s3", versioning, encryption, lockObject, ...(currentVersionId ? { currentVersionId } : {}),
      restoreReady: versioning === "enabled" && lockObject === "absent" && encryption !== "none" && encryption !== "unknown" && !!currentVersionId && refusals.length === 0,
      refusals: Object.freeze(refusals) });
  }

  async listVersions(limit: number): Promise<StateObjectVersion[]> {
    const out: StateObjectVersion[] = [];
    let keyMarker: string | undefined, versionMarker: string | undefined;
    do {
      const page = await this.client.send(new this.sdk.ListObjectVersionsCommand({ Bucket: this.where.bucket, Prefix: this.where.key, MaxKeys: 100, KeyMarker: keyMarker, VersionIdMarker: versionMarker })).catch(() =>
        fail("backend_unreachable", "The state backend versions could not be listed.")) as
        { Versions?: { Key?: string; VersionId?: string; IsLatest?: boolean; Size?: number; LastModified?: Date }[]; IsTruncated?: boolean; NextKeyMarker?: string; NextVersionIdMarker?: string };
      for (const v of page.Versions ?? []) {
        // Exact key only: a longer key sharing the prefix is a different object and never restorable here.
        if (v.Key !== this.where.key || !v.VersionId) continue;
        out.push({ versionId: v.VersionId, isLatest: v.IsLatest === true, size: v.Size ?? 0, ...(v.LastModified ? { lastModified: v.LastModified.toISOString() } : {}) });
        if (out.length >= limit) return out;
      }
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (keyMarker !== undefined || versionMarker !== undefined);
    return out;
  }

  private async read(versionId?: string): Promise<StateObjectRead> {
    const res = await this.client.send(new this.sdk.GetObjectCommand({ Bucket: this.where.bucket, Key: this.where.key, ...(versionId ? { VersionId: versionId } : {}) })).catch(() =>
      fail("version_unavailable", "The state object version could not be read.")) as
      { Body?: { transformToByteArray?: () => Promise<Uint8Array> }; VersionId?: string; ETag?: string; ContentLength?: number };
    if ((res.ContentLength ?? 0) > MAX_STATE_BYTES || !res.Body?.transformToByteArray) fail("version_unavailable", "The state object is empty or too large to restore.");
    const bytes = Buffer.from(await res.Body!.transformToByteArray!());
    if (bytes.length < 1 || bytes.length > MAX_STATE_BYTES) fail("version_unavailable", "The state object is empty or too large to restore.");
    return { bytes, sha256: sha256(bytes), versionId: res.VersionId ?? versionId ?? "", ...(res.ETag ? { etag: res.ETag } : {}) };
  }
  readVersion(versionId: string): Promise<StateObjectRead> { return this.read(versionId); }
  readCurrent(): Promise<StateObjectRead> { return this.read(); }

  async writeRestored(bytes: Buffer, expect: { currentEtag: string }): Promise<{ versionId: string }> {
    const current = await this.head();
    if (!current || current.ETag !== expect.currentEtag) fail("state_changed", "The state object changed after review; nothing was written.");
    const res = await this.client.send(new this.sdk.PutObjectCommand({
      Bucket: this.where.bucket, Key: this.where.key, Body: bytes, ContentType: "application/json", IfMatch: expect.currentEtag,
      // Keep the object encrypted exactly as the current version is; never downgrade.
      ...(current.ServerSideEncryption ? { ServerSideEncryption: current.ServerSideEncryption as "AES256" | "aws:kms" } : {}),
    })).catch((err: unknown) => {
      if (statusOf(err) === 412) return fail("state_changed", "The state object changed after review; nothing was written.");
      return fail("write_unconfirmed", "The restore write could not be confirmed; inspect the state object versions before another attempt.");
    }) as { VersionId?: string };
    if (!res.VersionId) fail("write_unconfirmed", "The backend returned no new version id; inspect the state object versions before another attempt.");
    return { versionId: res.VersionId! };
  }
}

export interface S3StateCredentials { readonly accessKeyId: string; readonly secretAccessKey: string; readonly sessionToken?: string }
/** Parse the tenant-owned credentials secret. Errors never echo a value. */
export function parseStateCredentials(raw: string): S3StateCredentials {
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw) as Record<string, unknown>; } catch { return fail("invalid_credentials", "The state credentials secret is not valid JSON."); }
  const text = (key: string, max: number): string => {
    const v = value[key];
    if (typeof v !== "string" || v.length === 0 || v.length > max) return fail("invalid_credentials", `The state credentials secret is missing a usable "${key}".`);
    return v;
  };
  if (Object.keys(value).some(k => !["accessKeyId", "secretAccessKey", "sessionToken"].includes(k))) fail("invalid_credentials", "The state credentials secret has unexpected fields; no endpoint or region can be supplied by it.");
  return { accessKeyId: text("accessKeyId", 256), secretAccessKey: text("secretAccessKey", 512), ...(value.sessionToken === undefined ? {} : { sessionToken: text("sessionToken", 4096) }) };
}

/** AWS S3 only. The endpoint is never taken from a credential or request: the SDK's own AWS endpoints are used. */
export async function openS3StateStore(backend: BackendConfig, region: string, stateKey: string, credentials: S3StateCredentials): Promise<StateBackendStore> {
  if (backend.kind !== "s3" || backend.endpoint !== undefined || !assessBackend(backend).restoreAdapter) fail("unsupported_backend", "Only AWS S3 state buckets have a restore adapter.");
  const s3 = backend as Extract<BackendConfig, { kind: "s3" }>;
  const sdk = await import("@aws-sdk/client-s3");
  const client = new sdk.S3Client({ region: s3.region ?? region, maxAttempts: 3, credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey,
    ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}) } }) as S3Client;
  return new S3StateStore(client, sdk, { bucket: s3.bucket, key: stateKey });
}
