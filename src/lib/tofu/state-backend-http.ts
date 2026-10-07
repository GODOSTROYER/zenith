/**
 * Versioned-object restore adapters for GCS (object generations), Azure Blob (blob versions) and OCI Object Storage
 * (object versions), PROD-DUR-06. Each implements the same `StateBackendStore` contract as the AWS S3 adapter:
 * live probe, exact-key version listing, digest-verified reads, a conditional write (GCS `ifGenerationMatch`, Azure and
 * OCI `If-Match`) that creates a NEW current version, and readback by the service. None of them can delete anything:
 * no DELETE request, no lifecycle call, no lock or lease removal exists in this file.
 *
 * Network and authentication, honestly:
 *  - Hosts are built only from validated identifiers (`storage.googleapis.com`; `<account>.blob.core.windows.net`;
 *    `objectstorage.<region>.oraclecloud.com`), never from a credential or request, redirects are refused, every call has a
 *    deadline and every body a size cap. The fetch function is injectable so the contract is testable without a network.
 *  - Credentials are one tenant vault secret, like the S3 adapter and portability storage. GCS: a service account key
 *    (`client_email`, `private_key`) exchanged for a short-lived token at the fixed Google token endpoint with an RS256 JWT
 *    signed by node crypto. Azure: a user-scoped container or blob SAS token (the tenant chooses its permissions). OCI: API
 *    signing key fields with HTTP-signature (rsa-sha256) request signing by node crypto. No new dependency.
 *  - The brokered workload-identity sessions (GcpSession, AzureSession) are not used: they exist only inside a granted operation
 *    and the default Azure broker authorizes only the bound source-storage account. A brokered restore path is a documented gap.
 * All of this is contract-tested against scripted servers; nothing here is proved against a live cloud account.
 */
import { createHash, createSign, createPrivateKey } from "node:crypto";
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
export interface GcsCredentials { readonly clientEmail: string; readonly privateKey: string }

export function parseGcsCredentials(raw: string): GcsCredentials {
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw) as Record<string, unknown>; } catch { return fail("invalid_credentials", "The state credentials secret is not valid JSON."); }
  const email = str(value.client_email), key = str(value.private_key);
  if (!email || !/^[A-Za-z0-9._-]{1,100}@[A-Za-z0-9.-]{1,100}\.iam\.gserviceaccount\.com$/.test(email) || !key || !/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key) || key.length > 8192)
    return fail("invalid_credentials", "The state credentials secret is not a usable service account key.");
  // Any token endpoint, project or extra field in the key file is ignored: the token host is fixed below.
  return { clientEmail: email, privateKey: key };
}
const b64url = (b: Buffer | string): string => Buffer.from(b).toString("base64url");
/** RS256 JWT for the fixed Google token endpoint. */
export function gcsAssertion(creds: GcsCredentials, now = Math.floor(Date.now() / 1000)): string {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: creds.clientEmail, scope: "https://www.googleapis.com/auth/devstorage.read_write", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3000 }));
  const sign = createSign("RSA-SHA256"); sign.update(`${head}.${claims}`);
  return `${head}.${claims}.${b64url(sign.sign(createPrivateKey(creds.privateKey)))}`;
}

export class GcsStateStore implements StateBackendStore {
  constructor(private readonly f: Fetch, private readonly token: () => Promise<string>, private readonly w: { bucket: string; object: string; lockObject: string }) {}
  private async req(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.token();
    return call(this.f, url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` } });
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

export async function openGcsStateStore(backend: BackendConfig, stateKey: string, rawSecret: string, f: Fetch = fetch): Promise<StateBackendStore> {
  if (backend.kind !== "gcs") fail("unsupported_backend", "This is not a GCS backend.");
  const gcs = backend as Extract<BackendConfig, { kind: "gcs" }>;
  const creds = parseGcsCredentials(rawSecret);
  let cached: { value: string; until: number } | undefined;
  const token = async (): Promise<string> => {
    if (cached && cached.until > Date.now() + 60_000) return cached.value;
    const res = await call(f, "https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${encodeURIComponent(gcsAssertion(creds))}` });
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); return fail("backend_unreachable", "The state credentials were not accepted by Google."); }
    const j = await jsonOf(res), value = str(j.access_token);
    if (!value) return fail("backend_unreachable", "The state credentials were not accepted by Google.");
    cached = { value, until: Date.now() + Math.min(Number(j.expires_in) || 300, 3000) * 1000 };
    return value;
  };
  const lockObject = `${stateKey.replace(/\.tfstate$/, "")}.tflock`;
  return new GcsStateStore(f, token, { bucket: gcs.bucket, object: stateKey, lockObject });
}

/* ------------------------------- Azure Blob --------------------------------- */

const AZ_API = "2023-11-03";
export interface AzureCredentials { readonly sas: string }
export function parseAzureCredentials(raw: string): AzureCredentials {
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw) as Record<string, unknown>; } catch { return fail("invalid_credentials", "The state credentials secret is not valid JSON."); }
  const sas = str(value.sasToken)?.replace(/^\?/, "");
  if (Object.keys(value).some(k => k !== "sasToken") || !sas || sas.length > 2048 || !/^[A-Za-z0-9%&=._~:+/-]+$/.test(sas) || !/(?:^|&)sig=/.test(sas))
    return fail("invalid_credentials", "The state credentials secret must contain only a sasToken.");
  return { sas };
}
const unxml = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const tag = (xml: string, name: string): string | undefined => { const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml); return m ? unxml(m[1]) : undefined; };

export class AzureBlobStateStore implements StateBackendStore {
  constructor(private readonly f: Fetch, private readonly sas: string, private readonly w: { account: string; container: string; blob: string }) {}
  private url(path: string, params: Record<string, string> = {}): string {
    const u = new URL(`https://${this.w.account}.blob.core.windows.net/${this.w.container}${path}`);
    for (const [k, v] of new URLSearchParams(this.sas)) u.searchParams.set(k, v);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }
  private blobPath(): string { return `/${this.w.blob.split("/").map(encodeURIComponent).join("/")}`; }
  private req(url: string, init: RequestInit = {}): Promise<Response> {
    return call(this.f, url, { ...init, headers: { "x-ms-version": AZ_API, ...(init.headers as Record<string, string> | undefined) } });
  }
  private async head(versionId?: string): Promise<Response | undefined | null> {
    const res = await this.req(this.url(this.blobPath(), versionId ? { versionid: versionId } : {}), { method: "HEAD" });
    if (res.status === 404) return undefined;
    return res.ok ? res : null;
  }
  async probe(): Promise<BackendProbeVerdict> {
    const refusals: string[] = [];
    const head = await this.head();
    let versioning: BackendProbeVerdict["versioning"] = "unknown", encryption: BackendProbeVerdict["encryption"] = "unknown", lockObject: BackendProbeVerdict["lockObject"] = "unknown", currentVersionId: string | undefined;
    if (!head) refusals.push(head === undefined ? "The state blob does not exist." : "The state blob could not be inspected.");
    else {
      // A version id header is returned only when blob versioning is enabled on the account; it cannot tell disabled from suspended.
      currentVersionId = head.headers.get("x-ms-version-id") ?? undefined;
      versioning = currentVersionId ? "enabled" : "disabled";
      encryption = head.headers.get("x-ms-server-encrypted") === "true" ? "sse_s3" : "none";
      const lease = head.headers.get("x-ms-lease-state");
      lockObject = lease === "leased" ? "present" : lease === "available" || lease === "expired" || lease === "broken" ? "absent" : "unknown";
    }
    if (versioning === "disabled") refusals.push("Blob versioning is not enabled on the storage account.");
    return Object.freeze({ backendKind: "azurerm", versioning, encryption, lockObject, ...(currentVersionId ? { currentVersionId } : {}),
      restoreReady: versioning === "enabled" && lockObject === "absent" && encryption !== "none" && !!currentVersionId && refusals.length === 0, refusals: Object.freeze(refusals) });
  }
  async listVersions(limit: number): Promise<StateObjectVersion[]> {
    const out: StateObjectVersion[] = [];
    let marker: string | undefined;
    for (let i = 0; i < 5; i++) {
      const res = await this.req(this.url("", { restype: "container", comp: "list", prefix: this.w.blob, include: "versions", maxresults: "100", ...(marker ? { marker } : {}) }));
      if (!res.ok) { await res.body?.cancel().catch(() => undefined); return fail("backend_unreachable", "The state backend versions could not be listed."); }
      const xml = (await bytesOf(res, META_MAX)).toString("utf8");
      for (const m of xml.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)) {
        const body = m[1], name = tag(body, "Name"), version = tag(body, "VersionId");
        if (name !== this.w.blob || !version) continue;
        out.push({ versionId: version, isLatest: tag(body, "IsCurrentVersion") === "true", size: Number(tag(body, "Content-Length") ?? 0) || 0, ...(tag(body, "Last-Modified") ? { lastModified: tag(body, "Last-Modified")! } : {}) });
        if (out.length >= limit) return out;
      }
      marker = tag(xml, "NextMarker") || undefined;
      if (!marker) break;
    }
    return out;
  }
  private async read(versionId?: string): Promise<StateObjectRead> {
    const res = await this.req(this.url(this.blobPath(), versionId ? { versionid: versionId } : {}));
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); return fail("version_unavailable", "The state blob version could not be read."); }
    const bytes = await bytesOf(res, MAX_STATE_BYTES);
    if (bytes.length < 1) fail("version_unavailable", "The state blob is empty.");
    const etag = res.headers.get("etag") ?? undefined;
    return { bytes, sha256: sha256(bytes), versionId: res.headers.get("x-ms-version-id") ?? versionId ?? "", ...(etag ? { etag } : {}) };
  }
  readVersion(versionId: string): Promise<StateObjectRead> { return this.read(versionId); }
  readCurrent(): Promise<StateObjectRead> { return this.read(); }
  async writeRestored(bytes: Buffer, expect: { currentEtag: string }): Promise<{ versionId: string }> {
    const current = await this.head();
    if (!current || current.headers.get("etag") !== expect.currentEtag) fail("state_changed", "The state blob changed after review; nothing was written.");
    const res = await this.req(this.url(this.blobPath()), { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "content-type": "application/json", "if-match": expect.currentEtag }, body: toBody(bytes) })
      .catch(() => fail("write_unconfirmed", "The restore write could not be confirmed; inspect the state blob versions before another attempt."));
    // A leased (locked) blob refuses a write without its lease id with 412, which is correct: a held lock is never bypassed.
    if (res.status === 412) { await res.body?.cancel().catch(() => undefined); return fail("state_changed", "The state blob changed or is locked; nothing was written."); }
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); return fail("write_unconfirmed", "The restore write could not be confirmed; inspect the state blob versions before another attempt."); }
    await res.body?.cancel().catch(() => undefined);
    const id = res.headers.get("x-ms-version-id");
    return id ? { versionId: id } : fail("write_unconfirmed", "The backend returned no new version id; inspect the state blob versions before another attempt.");
  }
}
export async function openAzureStateStore(backend: BackendConfig, stateKey: string, rawSecret: string, f: Fetch = fetch): Promise<StateBackendStore> {
  if (backend.kind !== "azurerm") fail("unsupported_backend", "This is not an Azure backend.");
  const az = backend as Extract<BackendConfig, { kind: "azurerm" }>;
  if (!/^[a-z0-9]{3,24}$/.test(az.storageAccountName) || !/^[a-z0-9](?:[a-z0-9]|-(?!-)){1,61}[a-z0-9]$/.test(az.containerName)) fail("unsupported_backend", "The Azure storage account or container name is invalid.");
  return new AzureBlobStateStore(f, parseAzureCredentials(rawSecret).sas, { account: az.storageAccountName, container: az.containerName, blob: stateKey });
}

/* ------------------------------- OCI native --------------------------------- */

const OCID = /^ocid1\.[a-z0-9_.-]{1,60}\.oc[0-9]\.[a-z0-9-]{0,40}\.[a-z0-9]{10,100}$/i;
const OCI_ENDPOINT = /^https:\/\/([a-z0-9]{1,63})\.compat\.objectstorage\.([a-z0-9-]{3,40})\.oraclecloud\.com\/?$/;
export interface OciCredentials { readonly tenancy: string; readonly user: string; readonly fingerprint: string; readonly privateKey: string }
export function parseOciCredentials(raw: string): OciCredentials {
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw) as Record<string, unknown>; } catch { return fail("invalid_credentials", "The state credentials secret is not valid JSON."); }
  const tenancy = str(value.tenancyOcid), user = str(value.userOcid), fingerprint = str(value.fingerprint), key = str(value.privateKeyPem);
  if (Object.keys(value).some(k => !["tenancyOcid", "userOcid", "fingerprint", "privateKeyPem"].includes(k)) || !tenancy || !OCID.test(tenancy) || !user || !OCID.test(user)
    || !fingerprint || !/^(?:[0-9a-f]{2}:){15}[0-9a-f]{2}$/i.test(fingerprint) || !key || !/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key) || key.length > 8192)
    return fail("invalid_credentials", "The state credentials secret is not a usable OCI API signing key.");
  return { tenancy, user, fingerprint, privateKey: key };
}
/** HTTP Signature (draft-cavage, rsa-sha256) headers for one OCI request. Exported for contract tests. */
export function ociSignedHeaders(creds: OciCredentials, method: "GET" | "HEAD" | "PUT", url: URL, body?: Buffer, now: Date = new Date()): Record<string, string> {
  const date = now.toUTCString();
  const write = method === "PUT";
  const headers: Record<string, string> = { date };
  const lines = [`(request-target): ${method.toLowerCase()} ${url.pathname}${url.search}`, `host: ${url.host}`, `date: ${date}`];
  let names = "(request-target) host date";
  if (write) {
    const b = body ?? Buffer.alloc(0);
    headers["x-content-sha256"] = createHash("sha256").update(b).digest("base64");
    headers["content-type"] = "application/json";
    lines.push(`x-content-sha256: ${headers["x-content-sha256"]}`, `content-type: application/json`, `content-length: ${b.length}`);
    names += " x-content-sha256 content-type content-length";
  }
  const sign = createSign("RSA-SHA256"); sign.update(lines.join("\n"));
  const signature = sign.sign(createPrivateKey(creds.privateKey)).toString("base64");
  headers.authorization = `Signature version="1",keyId="${creds.tenancy}/${creds.user}/${creds.fingerprint}",algorithm="rsa-sha256",headers="${names}",signature="${signature}"`;
  return headers;
}

export class OciStateStore implements StateBackendStore {
  constructor(private readonly f: Fetch, private readonly creds: OciCredentials, private readonly w: { region: string; namespace: string; bucket: string; object: string; lockObject: string }) {}
  private base(): string { return `https://objectstorage.${this.w.region}.oraclecloud.com/n/${this.w.namespace}/b/${this.w.bucket}`; }
  private objPath(name: string): string { return `${this.base()}/o/${encodeURIComponent(name)}`; }
  private req(method: "GET" | "HEAD" | "PUT", url: string, body?: Buffer, extra: Record<string, string> = {}): Promise<Response> {
    const u = new URL(url);
    return call(this.f, url, { method, headers: { ...ociSignedHeaders(this.creds, method, u, body), ...extra }, ...(body ? { body: toBody(body) } : {}) });
  }
  private async head(name: string, versionId?: string): Promise<Response | undefined | null> {
    const res = await this.req("HEAD", `${this.objPath(name)}${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ""}`);
    if (res.status === 404) return undefined;
    return res.ok ? res : null;
  }
  async probe(): Promise<BackendProbeVerdict> {
    const refusals: string[] = [];
    let versioning: BackendProbeVerdict["versioning"] = "unknown", encryption: BackendProbeVerdict["encryption"] = "unknown", currentVersionId: string | undefined;
    const bucket = await this.req("GET", `${this.base()}?fields=versioning,kmsKeyId`);
    if (bucket.ok) {
      const j = await jsonOf(bucket), v = str(j.versioning);
      versioning = v === "Enabled" ? "enabled" : v === "Suspended" ? "suspended" : "disabled";
      encryption = str(j.kmsKeyId) ? "sse_kms" : "sse_s3"; // OCI always encrypts at rest; no kms key means Oracle-managed keys
    } else { await bucket.body?.cancel().catch(() => undefined); refusals.push("Bucket versioning could not be read; the key may lack bucket inspect permission."); }
    const head = await this.head(this.w.object);
    if (!head) refusals.push(head === undefined ? "The state object does not exist." : "The state object could not be inspected.");
    else currentVersionId = head.headers.get("version-id") ?? undefined;
    const lock = await this.head(this.w.lockObject);
    const lockObject: BackendProbeVerdict["lockObject"] = lock === undefined ? "absent" : lock === null ? "unknown" : "present";
    if (versioning === "disabled" || versioning === "suspended") refusals.push(`Bucket versioning is ${versioning}.`);
    return Object.freeze({ backendKind: "s3", versioning, encryption, lockObject, ...(currentVersionId ? { currentVersionId } : {}),
      restoreReady: versioning === "enabled" && lockObject === "absent" && !!currentVersionId && refusals.length === 0, refusals: Object.freeze(refusals) });
  }
  async listVersions(limit: number): Promise<StateObjectVersion[]> {
    const found: { versionId: string; size: number; at: string }[] = [];
    let start: string | undefined;
    for (let i = 0; i < 5; i++) {
      const res = await this.req("GET", `${this.base()}/objectversions?prefix=${encodeURIComponent(this.w.object)}&limit=100&fields=name,size,timeCreated${start ? `&start=${encodeURIComponent(start)}` : ""}`);
      if (!res.ok) { await res.body?.cancel().catch(() => undefined); return fail("backend_unreachable", "The state backend versions could not be listed."); }
      const j = await jsonOf(res);
      for (const item of Array.isArray(j.items) ? j.items as Record<string, unknown>[] : []) {
        if (item.name !== this.w.object || !str(item.versionId) || item.isDeleteMarker === true) continue;
        found.push({ versionId: String(item.versionId), size: Number(item.size ?? 0) || 0, at: str(item.timeCreated) ?? "" });
      }
      start = str(j.nextStartWith);
      if (!start) break;
    }
    found.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return found.slice(0, limit).map((v, i) => ({ versionId: v.versionId, isLatest: i === 0, size: v.size, ...(v.at ? { lastModified: v.at } : {}) }));
  }
  private async read(versionId?: string): Promise<StateObjectRead> {
    const res = await this.req("GET", `${this.objPath(this.w.object)}${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ""}`);
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); return fail("version_unavailable", "The state object version could not be read."); }
    const bytes = await bytesOf(res, MAX_STATE_BYTES);
    if (bytes.length < 1) fail("version_unavailable", "The state object is empty.");
    const etag = res.headers.get("etag") ?? undefined;
    return { bytes, sha256: sha256(bytes), versionId: res.headers.get("version-id") ?? versionId ?? "", ...(etag ? { etag } : {}) };
  }
  readVersion(versionId: string): Promise<StateObjectRead> { return this.read(versionId); }
  readCurrent(): Promise<StateObjectRead> { return this.read(); }
  async writeRestored(bytes: Buffer, expect: { currentEtag: string }): Promise<{ versionId: string }> {
    const current = await this.head(this.w.object);
    if (!current || current.headers.get("etag") !== expect.currentEtag) fail("state_changed", "The state object changed after review; nothing was written.");
    if (/[\r\n]/.test(expect.currentEtag)) fail("state_changed", "The state object changed after review; nothing was written.");
    const res = await this.req("PUT", this.objPath(this.w.object), bytes, { "if-match": expect.currentEtag })
      .catch(() => fail("write_unconfirmed", "The restore write could not be confirmed; inspect the state object versions before another attempt."));
    if (res.status === 412) { await res.body?.cancel().catch(() => undefined); return fail("state_changed", "The state object changed after review; nothing was written."); }
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); return fail("write_unconfirmed", "The restore write could not be confirmed; inspect the state object versions before another attempt."); }
    await res.body?.cancel().catch(() => undefined);
    const id = res.headers.get("version-id");
    return id ? { versionId: id } : fail("write_unconfirmed", "The backend returned no new version id; inspect the state object versions before another attempt.");
  }
}
export async function openOciStateStore(backend: BackendConfig, stateKey: string, rawSecret: string, f: Fetch = fetch): Promise<StateBackendStore> {
  if (backend.kind !== "s3" || typeof backend.endpoint !== "string") fail("unsupported_backend", "This is not an OCI Object Storage backend.");
  const s3 = backend as Extract<BackendConfig, { kind: "s3" }>;
  const match = OCI_ENDPOINT.exec(s3.endpoint ?? "");
  if (!match || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(s3.bucket)) return fail("unsupported_backend", "The OCI endpoint or bucket name is invalid.");
  return new OciStateStore(f, parseOciCredentials(rawSecret), { region: match[2], namespace: match[1], bucket: s3.bucket, object: stateKey, lockObject: `${stateKey}.tflock` });
}
