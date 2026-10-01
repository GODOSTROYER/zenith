/**
 * C3: bounded GitHub source archives and canonical customer-bucket uploads.
 * AWS uses deterministic ZIP for CodeBuild's native S3 source; GCP and standalone
 * reads keep tar.gz. Both preserve binary bytes, paths and executable intent.
 * Uses the product intake's codeload endpoint/header-only source access convention
 * (analysis/github.ts); its lossy analysis snapshot is deliberately not build input.
 * Files, binary assets and executable bits are preserved. Links/special entries and
 * malformed archives fail closed. No source is executed, materialized or logged.
 * Only identifiers leave prepare; sessions and optional GitHub tokens stay inside
 * callbacks. Anonymous GitHub access remains available; configured workspace source
 * bindings use the GitHub App connector. HTTP/SDK tests are not live evidence.
 * CodeBuild source consumption and bootstrap IAM are covered by contract tests;
 * no live customer build is claimed.
 */
import { createHash } from "node:crypto";
import { crc32, deflateRawSync, gunzipSync, gzipSync } from "node:zlib";
import { GetBucketTaggingCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { AwsSession, GcpSession } from "@/lib/credentials/types";
import { canonical, sha256Hex } from "@/lib/controlplane/digest";
import type { DriverContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { ResourcesPort, SourceBundlePort, StoredResource } from "@/lib/execution/ports";
import { StepFailedError } from "@/lib/execution/errors";
import { loadProject, sourceBucketOf } from "@/lib/providers/aws/drivers/compute/codebuild-project";
import { assertLabels, context as gcpContext, get, pipelineNames } from "@/lib/providers/gcp/release/support";
import { defaultGithubAccess } from "@/lib/sources/github/runtime";

export interface BundleSource { repo: string; ref: string; dockerfile?: string }
export interface SourceBundle { archive: Uint8Array; sha256: string; bytes: number }
export interface SourceBundleLimits { maxArchiveBytes: number; maxUnpackedBytes: number; maxFileBytes: number; maxEntries: number }
export const SOURCE_BUNDLE_LIMITS: Readonly<SourceBundleLimits> = Object.freeze({
  maxArchiveBytes: 32 * 1024 * 1024, maxUnpackedBytes: 128 * 1024 * 1024,
  maxFileBytes: 32 * 1024 * 1024, maxEntries: 20_000,
});
export interface SourceBundleDeps {
  resources?: Pick<ResourcesPort, "list">;
  fetchImpl?: typeof fetch;
  /** May lower the hard memory ceilings, never raise them. */
  limits?: Partial<SourceBundleLimits>;
  /** Whole download/prepare deadline; defaults to 60 seconds, maximum 5 minutes. */
  timeoutMs?: number;
  /** Standalone read requires a connector already bound to its workspace. */
  withGithubAccess?<T>(input: { owner: string; repo: string; workspaceId?: string; environmentId?: string }, fn: (token?: string) => Promise<T>): Promise<T>;
}
export interface PreparedSourceBundle { s3Key: string; digest: string; bucket: string; objectKey: string; uri: string }
export interface PreparedSourceBundlePort extends SourceBundlePort {
  prepare(ctx: DriverContext, input: { service: ResourceNode; source: BundleSource }): Promise<PreparedSourceBundle>;
}
class Refused extends StepFailedError {}
function refuse(message: string): never { throw new Refused(message); }
const interrupted = () => { const error = new Error("Source bundle operation was interrupted."); error.name = "AbortError"; return error; };
const checkSignal = (signal: AbortSignal) => { if (signal.aborted) throw interrupted(); };
const cancel = (res: Response) => { void res.body?.cancel().catch(() => undefined); };
const BLOCK = 512;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
interface Entry { path: string; directory: boolean; mode: number; data: Buffer }

function coordinates(source: BundleSource): { owner: string; repo: string } {
  if (!source || typeof source.repo !== "string" || typeof source.ref !== "string") refuse("Source repository and exact ref are required.");
  const match = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/?$/.exec(source.repo);
  const repo = match?.[2].replace(/\.git$/, "");
  if (!match || !repo || repo === "." || repo === "..") refuse("Source must identify a GitHub repository without credentials, query parameters or a fragment.");
  if (!source.ref || source.ref.length > 250 || source.ref.split("/").some((s) => !/^[A-Za-z0-9._+@~-]{1,100}$/.test(s) || s === "." || s === "..")) refuse("Source must name a valid exact git ref.");
  if (source.dockerfile !== undefined && (typeof source.dockerfile !== "string" || !/^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/.test(source.dockerfile) || source.dockerfile.split("/").some((s) => !s || s === "."))) refuse("Dockerfile must be a safe relative repository path.");
  return { owner: match[1], repo };
}

/** Race even injected transports against the deadline; never propagate abort reasons. */
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(interrupted()); };
    signal.addEventListener("abort", abort, { once: true });
    pending.then((value) => { signal.removeEventListener("abort", abort); resolve(value); }, (err: unknown) => { signal.removeEventListener("abort", abort); reject(err); });
    if (signal.aborted) abort();
  });
}

async function readCapped(res: Response, cap: number, signal: AbortSignal): Promise<Buffer> {
  if (Number(res.headers.get("content-length")) > cap) { cancel(res); refuse("Source archive exceeds its compressed size bound."); }
  if (!res.body) refuse("Source archive response has no body.");
  const reader = res.body.getReader(); const chunks: Buffer[] = []; let size = 0;
  try {
    for (;;) {
      checkSignal(signal);
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > cap) refuse("Source archive exceeds its compressed size bound.");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

async function download(source: BundleSource, token: string | undefined, deps: SourceBundleDeps, limits: SourceBundleLimits, signal: AbortSignal): Promise<Buffer> {
  const { owner, repo } = coordinates(source);
  let url = `https://codeload.github.com/${owner}/${repo}/tar.gz/${source.ref.split("/").map(encodeURIComponent).join("/")}`;
  for (let hop = 0; hop <= 3; hop++) {
    checkSignal(signal);
    const headers: Record<string, string> = { Accept: "application/gzip", "User-Agent": "zenith-source-bundle" };
    // Credentials belong only to the original request, never a redirect target.
    if (hop === 0 && token) headers.Authorization = `Bearer ${token}`;
    const pending = (deps.fetchImpl ?? fetch)(url, { headers, redirect: "manual", signal });
    void pending.then((res) => { if (signal.aborted) cancel(res); }, () => undefined);
    const res = await abortable(pending, signal);
    if (res.status >= 300 && res.status < 400) {
      cancel(res);
      const location = res.headers.get("location");
      if (!location || hop === 3) refuse("Source archive redirect limit was exceeded or its location is missing.");
      let next: URL;
      try { next = new URL(location, url); } catch { return refuse("Source archive redirect is invalid."); }
      if (next.protocol !== "https:" || next.username || next.password || next.port || next.search || next.hash || !["codeload.github.com", "github.com", "api.github.com"].includes(next.hostname)) refuse("Source archive redirect is outside the GitHub allowlist.");
      url = next.href;
      continue;
    }
    if (!res.ok) { cancel(res); refuse("GitHub could not provide the requested repository and exact ref."); }
    return readCapped(res, limits.maxArchiveBytes, signal);
  }
  return refuse("Source archive could not be downloaded.");
}

function textField(data: Buffer, offset = 0, length = data.length): string {
  const bytes = data.subarray(offset, offset + length); const end = bytes.indexOf(0);
  try { return utf8.decode(bytes.subarray(0, end < 0 ? bytes.length : end)); } catch { return refuse("Source archive has an invalid UTF-8 path."); }
}
function octal(data: Buffer, offset: number, length: number): number {
  const value = data.subarray(offset, offset + length).toString("latin1").replace(/\0/g, " ").trim();
  if ((data[offset] & 0x80) || !/^[0-7]+$/.test(value)) refuse("Source archive has an invalid numeric header.");
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) refuse("Source archive has an oversized numeric header.");
  return number;
}
function safePath(raw: string): string {
  if (!raw || Buffer.byteLength(raw) > 2048 || /[\x00-\x1f\x7f\\]/.test(raw) || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) refuse("Source archive has an unsafe path.");
  const parts = raw.split("/");
  if (parts.includes("..")) refuse("Source archive has a traversal path.");
  const path = parts.filter((p) => p && p !== ".").join("/");
  if (!path) refuse("Source archive has an empty path.");
  return path;
}
function pax(data: Buffer, global: boolean): { path?: string; size?: number } {
  const result: { path?: string; size?: number } = {}; const seen = new Set<string>();
  for (let offset = 0; offset < data.length;) {
    const space = data.indexOf(32, offset);
    const number = data.subarray(offset, space < 0 ? offset : space).toString("latin1");
    const length = Number(number);
    if (!/^[1-9]\d{0,8}$/.test(number) || !Number.isSafeInteger(length) || length <= space - offset + 2 || offset + length > data.length || data[offset + length - 1] !== 10) refuse("Source archive has malformed PAX metadata.");
    let record: string;
    try { record = utf8.decode(data.subarray(space + 1, offset + length - 1)); } catch { return refuse("Source archive has malformed PAX metadata."); }
    const equals = record.indexOf("="); const key = record.slice(0, equals); const value = record.slice(equals + 1);
    if (equals <= 0 || seen.has(key)) refuse("Source archive has ambiguous PAX metadata.");
    seen.add(key);
    if (key === "path" && !global) result.path = value;
    else if (key === "size" && !global && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) result.size = Number(value);
    else if (!["comment", "mtime", "atime", "ctime", "uid", "gid", "uname", "gname"].includes(key)) refuse("Source archive has unsupported PAX metadata.");
    offset += length;
  }
  return result;
}

function unpack(bytes: Buffer, limits: SourceBundleLimits, signal: AbortSignal): Entry[] {
  let tar: Buffer;
  try { tar = gunzipSync(bytes, { maxOutputLength: limits.maxUnpackedBytes }); } catch { return refuse("Source archive is unreadable or exceeds its decompression bound."); }
  const entries = new Map<string, Entry>(); let root: string | undefined; let offset = 0; let seen = 0;
  let pending: { path?: string; size?: number } | undefined; let terminated = false;
  while (offset + BLOCK <= tar.length) {
    checkSignal(signal);
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) {
      if (pending || offset + 2 * BLOCK > tar.length || tar.length % BLOCK || !tar.subarray(offset).every((b) => b === 0)) refuse("Source archive has an invalid end marker.");
      terminated = true; break;
    }
    if (++seen > limits.maxEntries) refuse("Source archive exceeds its entry count bound.");
    const sum = header.reduce((s, b, i) => s + (i >= 148 && i < 156 ? 32 : b), 0);
    if (sum !== octal(header, 148, 8)) refuse("Source archive header checksum is invalid.");
    const type = String.fromCharCode(header[156]);
    const metadata = ["x", "g", "L"].includes(type);
    const size = metadata ? octal(header, 124, 12) : pending?.size ?? octal(header, 124, 12);
    const end = offset + BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (size > limits.maxFileBytes || end > tar.length) refuse("Source archive has an oversized or truncated entry.");
    const data = tar.subarray(offset + BLOCK, offset + BLOCK + size); offset = end;
    if (metadata) {
      if (pending) refuse("Source archive has ambiguous extended headers.");
      if (type === "g") pax(data, true);
      else pending = type === "L" ? { path: textField(data) } : pax(data, false);
      continue;
    }
    if (!["0", "\0", "5"].includes(type)) refuse("Source archives cannot contain links, devices or special entries.");
    const prefix = header.subarray(257, 263).equals(Buffer.from("ustar\0")) ? textField(header, 345, 155) : "";
    const path = safePath(pending?.path ?? [prefix, textField(header, 0, 100)].filter(Boolean).join("/"));
    pending = undefined;
    const parts = path.split("/"); root ??= parts[0];
    if (parts[0] !== root) refuse("Source archive must have one GitHub repository root.");
    if (type === "5" && size !== 0) refuse("Source archive directory has a body.");
    const relative = parts.slice(1).join("/");
    if (!relative) { if (type !== "5") refuse("Source archive file is outside its repository root."); continue; }
    if (entries.has(relative)) refuse("Source archive has duplicate paths.");
    const mode = type === "5" || (octal(header, 100, 8) & 0o111) ? 0o755 : 0o644;
    entries.set(relative, { path: relative, directory: type === "5", mode, data });
  }
  if (!terminated || ![...entries.values()].some((e) => !e.directory)) refuse("Source archive is empty or truncated.");
  for (const entry of entries.values()) {
    const parts = entry.path.split("/");
    for (let i = 1; i < parts.length; i++) if (entries.get(parts.slice(0, i).join("/"))?.directory === false) refuse("Source archive has conflicting file and directory paths.");
  }
  return [...entries.values()].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}

function header(path: string, mode: number, size: number, type: string): Buffer {
  const out = Buffer.alloc(BLOCK); let name = path; let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1)) {
      if (Buffer.byteLength(path.slice(0, at)) <= 155 && Buffer.byteLength(path.slice(at + 1)) <= 100) { prefix = path.slice(0, at); name = path.slice(at + 1); break; }
    }
  }
  if (Buffer.byteLength(name) > 100) throw new RangeError("pax");
  out.write(name, 0, 100, "utf8"); out.write(prefix, 345, 155, "utf8");
  for (const [at, width, value] of [[100, 8, mode], [108, 8, 0], [116, 8, 0], [124, 12, size], [136, 12, 0]]) out.write(value.toString(8).padStart(width - 1, "0") + "\0", at, width, "ascii");
  out.fill(32, 148, 156); out.write(type, 156, 1, "ascii"); out.write("ustar\0", 257, "ascii"); out.write("00", 263, "ascii");
  out.write(out.reduce((sum, b) => sum + b, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return out;
}
function pack(entries: Entry[], limits: SourceBundleLimits, signal: AbortSignal): Buffer {
  const chunks: Buffer[] = []; let total = 2 * BLOCK;
  const append = (head: Buffer, data: Buffer) => {
    total += BLOCK + Math.ceil(data.length / BLOCK) * BLOCK;
    if (total > limits.maxUnpackedBytes) refuse("Canonical source tar exceeds its unpacked size bound.");
    chunks.push(head, data, Buffer.alloc((BLOCK - data.length % BLOCK) % BLOCK));
  };
  entries.forEach((entry, index) => {
    checkSignal(signal);
    const type = entry.directory ? "5" : "0"; let head: Buffer;
    try { head = header(entry.path, entry.mode, entry.data.length, type); } catch {
      const record = ` path=${entry.path}\n`; let length = Buffer.byteLength(record) + 1;
      while (String(length).length + Buffer.byteLength(record) !== length) length = String(length).length + Buffer.byteLength(record);
      const extended = Buffer.from(`${length}${record}`);
      append(header(`PaxHeaders/${index}`, 0o644, extended.length, "x"), extended);
      head = header(`entry/${index}`, entry.mode, entry.data.length, type);
    }
    append(head, entry.data);
  });
  chunks.push(Buffer.alloc(2 * BLOCK));
  const archive = gzipSync(Buffer.concat(chunks, total), { level: 9 });
  archive.fill(0, 4, 8); archive[9] = 255; // fixed gzip mtime and platform-independent OS byte
  if (archive.length > limits.maxArchiveBytes) refuse("Canonical source archive exceeds its compressed size bound.");
  checkSignal(signal); return archive;
}

/** Classic ZIP: the hard ceilings fit its 16-bit entry count and 32-bit sizes.
 * Fixed DOS epoch, UTF-8 names, Unix file types/modes, no host-specific extras.
 * CodeBuild extracts it directly; no source or unpack command is executed here.
 */
function packZip(entries: Entry[], limits: SourceBundleLimits, signal: AbortSignal): Buffer {
  const local: Buffer[] = []; const central: Buffer[] = [];
  let offset = 0; let centralBytes = 0;
  for (const entry of entries) {
    checkSignal(signal);
    const name = Buffer.from(entry.path + (entry.directory ? "/" : ""));
    const data = entry.directory ? entry.data : deflateRawSync(entry.data, { level: 9 });
    const method = entry.directory ? 0 : 8; const checksum = crc32(entry.data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x800, 6); head.writeUInt16LE(method, 8);
    head.writeUInt16LE(0x21, 12); // 1980-01-01, 00:00:00
    head.writeUInt32LE(checksum, 14); head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(entry.data.length, 22); head.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(0x314, 4);
    head.copy(record, 6, 4, 30);
    record.writeUInt32LE(((entry.directory ? 0o040000 : 0o100000) | entry.mode) * 0x10000 + (entry.directory ? 0x10 : 0), 38);
    record.writeUInt32LE(offset, 42);
    offset += head.length + name.length + data.length; centralBytes += record.length + name.length;
    if (offset + centralBytes + 22 > limits.maxArchiveBytes) refuse("Canonical source ZIP exceeds its compressed size bound.");
    local.push(head, name, data); central.push(record, name);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes, 12); end.writeUInt32LE(offset, 16);
  checkSignal(signal); return Buffer.concat([...local, ...central, end], offset + centralBytes + end.length);
}

function managed(ctx: DriverContext, node: ResourceNode | StoredResource): void {
  if (node.provider !== ctx.provider || node.region !== ctx.region || node.ownership !== "managed") refuse("Source target is outside this managed provider and region.");
}
function asNode(row: StoredResource, ctx: DriverContext): ResourceNode {
  return { ...row, kind: "build_pipeline", provider: ctx.provider, region: row.region ?? ctx.region, ...(row.externalId ? { externalRef: row.externalId } : {}) };
}
async function pipelineFor(deps: SourceBundleDeps, ctx: DriverContext, service: ResourceNode, source: BundleSource): Promise<ResourceNode> {
  managed(ctx, service);
  const artifact = service.spec.artifact as { type?: string; pipeline?: string } | undefined;
  if (artifact?.type !== "built" || !/^build_pipeline\/[A-Za-z0-9_.-]{1,128}$/.test(artifact.pipeline ?? "") || !deps.resources) refuse("Source preparation requires the workload's stored build pipeline.");
  const rows = await deps.resources.list(ctx.workspaceId, ctx.environmentId);
  if (rows.some((r) => r.workspaceId !== ctx.workspaceId || r.environmentId !== ctx.environmentId)) refuse("Source resource lookup crossed its workspace or environment boundary.");
  const workloads = rows.filter((r) => r.address === service.address && r.status !== "deleted");
  if (workloads.length !== 1 || workloads[0].specDigest !== service.specDigest || canonical(workloads[0].spec) !== canonical(service.spec)) refuse("Source workload does not match the stored desired resource.");
  managed(ctx, workloads[0]);
  const pipelines = rows.filter((r) => r.address === artifact.pipeline && r.kind === "build_pipeline" && r.status !== "deleted");
  if (pipelines.length !== 1) refuse("Source build pipeline could not be uniquely located.");
  managed(ctx, pipelines[0]);
  const spec = pipelines[0].spec as { location?: string; source?: BundleSource };
  if (spec.location !== "customer_account" || !spec.source || canonical({ ...coordinates(spec.source), ref: spec.source.ref, dockerfile: spec.source.dockerfile }) !== canonical({ ...coordinates(source), ref: source.ref, dockerfile: source.dockerfile })) refuse("Source does not match the customer-account pipeline's repository and ref.");
  return asNode(pipelines[0], ctx);
}
function assertAwsTags(ctx: DriverContext, pipeline: ResourceNode, tags: Record<string, string>): void {
  const expected = { "zenith:workspace": ctx.workspaceId, "zenith:environment": ctx.environmentId, "zenith:resource": pipeline.address, "zenith:managed": "true" };
  if (Object.entries(expected).some(([k, v]) => tags[k] !== v)) refuse("Source bucket or project is outside this workspace and environment.");
}
async function awsBucket(ctx: DriverContext<AwsSession>, pipeline: ResourceNode): Promise<string> {
  const arnPrefix = `arn:aws:codebuild:${ctx.region}:${ctx.session.accountId}:project/`;
  if (pipeline.externalRef?.startsWith("arn:") && !pipeline.externalRef.startsWith(arnPrefix)) refuse("Source project is outside the brokered AWS account and region.");
  const { project } = await loadProject(ctx, pipeline, pipeline.externalRef);
  if (!project || !project.arn?.startsWith(arnPrefix) || project.source?.type !== "S3") refuse("Source project identity or S3 source could not be verified.");
  assertAwsTags(ctx, pipeline, Object.fromEntries((project.tags ?? []).map((t) => [t.key ?? "", t.value ?? ""])));
  const bucket = sourceBucketOf(project);
  if (!bucket) refuse("Source project does not name a valid customer bucket.");
  const tagging = await ctx.session.client(S3Client).send(new GetBucketTaggingCommand({ Bucket: bucket, ExpectedBucketOwner: ctx.session.accountId }), { abortSignal: ctx.signal });
  assertAwsTags(ctx, pipeline, Object.fromEntries((tagging.TagSet ?? []).map((t) => [t.Key ?? "", t.Value ?? ""])));
  return bucket;
}
async function uploadAws(ctx: DriverContext<AwsSession>, bucket: string, key: string, bundle: SourceBundle): Promise<void> {
  const s3 = ctx.session.client(S3Client); const checksum = Buffer.from(bundle.sha256, "hex").toString("base64");
  try {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bundle.archive, ContentType: "application/zip", ContentLength: bundle.bytes, ChecksumSHA256: checksum, ExpectedBucketOwner: ctx.session.accountId, IfNoneMatch: "*" }), { abortSignal: ctx.signal });
  } catch (err) {
    if ((err as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata?.httpStatusCode !== 412) throw err;
    const existing = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, ExpectedBucketOwner: ctx.session.accountId, ChecksumMode: "ENABLED" }), { abortSignal: ctx.signal });
    if (existing.ChecksumSHA256 !== checksum || existing.ContentLength !== bundle.bytes) refuse("Existing source object does not have the expected SHA-256 and size; refusing to replace it.");
  }
}
async function uploadGcp(ctx: DriverContext<GcpSession>, bucket: string, key: string, bundle: SourceBundle, limits: SourceBundleLimits): Promise<void> {
  const base = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(key)}`;
  const query = new URLSearchParams({ uploadType: "media", name: key, ifGenerationMatch: "0" });
  const res = await abortable(ctx.session.authorizedFetch(`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?${query}`, { method: "POST", headers: { "Content-Type": "application/gzip", "Content-Length": String(bundle.bytes) }, body: new Uint8Array(bundle.archive), signal: ctx.signal, redirect: "error" }), ctx.signal);
  if (res.status === 412) {
    cancel(res);
    const metadata = await get(ctx, base);
    if (metadata.bucket !== bucket || metadata.name !== key || typeof metadata.generation !== "string" || !/^\d{1,20}$/.test(metadata.generation) || metadata.size !== String(bundle.bytes)) refuse("Existing source object identity or size could not be verified.");
    const previous = await abortable(ctx.session.authorizedFetch(`${base}?alt=media&generation=${metadata.generation}`, { signal: ctx.signal, redirect: "error" }), ctx.signal);
    if (!previous.ok) { cancel(previous); refuse("Existing source object bytes could not be verified."); }
    if (sha256Hex(await readCapped(previous, limits.maxArchiveBytes, ctx.signal)) !== bundle.sha256) refuse("Existing source object has a different SHA-256; refusing to replace it.");
    return;
  }
  if (!res.ok) { cancel(res); throw new Error("Source upload outcome is unknown."); }
  const metadata = JSON.parse((await readCapped(res, 64 * 1024, ctx.signal)).toString("utf8")) as Record<string, unknown>;
  const md5 = createHash("md5").update(bundle.archive).digest("base64"); // GCS's upload integrity field, never the bundle identity
  if (metadata.bucket !== bucket || metadata.name !== key || metadata.size !== String(bundle.bytes) || metadata.md5Hash !== md5) refuse("GCS did not confirm the source object's identity, size and integrity.");
}

export function createSourceBundles(deps: SourceBundleDeps = {}): {
  read(source: BundleSource, signal?: AbortSignal): Promise<SourceBundle>;
  port: PreparedSourceBundlePort;
} {
  const limits = { ...SOURCE_BUNDLE_LIMITS, ...deps.limits }; const timeoutMs = deps.timeoutMs ?? 60_000;
  for (const key of Object.keys(SOURCE_BUNDLE_LIMITS) as (keyof SourceBundleLimits)[]) if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > SOURCE_BUNDLE_LIMITS[key]) refuse("Source limits must be positive integers within the hard ceilings.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) refuse("Source deadline must be 1–300000 milliseconds.");
  const boundedSignal = (signal?: AbortSignal) => AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
  const acquire = async (source: BundleSource, signal: AbortSignal, scope: { workspaceId?: string; environmentId?: string } = {}, format: "tar.gz" | "zip" = "tar.gz"): Promise<SourceBundle> => {
    checkSignal(signal); const location = coordinates(source);
    const read = async (token?: string) => {
      const entries = unpack(await download(source, token, deps, limits, signal), limits, signal);
      if (source.dockerfile && !entries.some((e) => e.path === source.dockerfile && !e.directory)) refuse("The requested Dockerfile is absent from the source ref.");
      const archive = format === "zip" ? packZip(entries, limits, signal) : pack(entries, limits, signal);
      return { archive, sha256: sha256Hex(archive), bytes: archive.length };
    };
    try { return await abortable(deps.withGithubAccess ? deps.withGithubAccess({ ...location, ...scope }, read) : defaultGithubAccess({ ...location, ...scope, signal }, read), signal); }
    catch (err) { if (signal.aborted) throw interrupted(); if (err instanceof Refused) throw err; throw new Error("Source archive acquisition failed; no source bundle was prepared."); }
  };
  return {
    read: (source, signal) => acquire(source, boundedSignal(signal)),
    port: {
      async prepare(raw, input): Promise<PreparedSourceBundle> {
        const ctx = { ...raw, signal: boundedSignal(raw.signal) };
        checkSignal(ctx.signal); coordinates(input.source);
        if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(ctx.environmentId) || !ctx.workspaceId || !/^[a-z_]+\/[A-Za-z0-9_.-]{1,128}$/.test(input.service.address) || [".", ".."].includes(input.service.address.split("/")[1])) refuse("Source scope or service identifier is invalid.");
        const provider = (ctx.session as { provider?: string } | undefined)?.provider;
        if (!["aws", "gcp"].includes(ctx.provider) || provider !== ctx.provider || (ctx.session as { region?: string } | undefined)?.region !== ctx.region) refuse("Source preparation requires a matching AWS or GCP brokered session.");
        try {
          const pipeline = await abortable(pipelineFor(deps, ctx, input.service, input.source), ctx.signal);
          let bucket: string;
          if (ctx.provider === "aws") {
            const aws = ctx as DriverContext<AwsSession>;
            if (!/^\d{12}$/.test(aws.session.accountId)) refuse("Source AWS session account is invalid.");
            bucket = await abortable(awsBucket(aws, pipeline), ctx.signal);
          } else {
            const gcp = gcpContext(ctx); bucket = pipelineNames(gcp, pipeline).bucket;
            if (pipeline.externalRef && ![bucket, `projects/_/buckets/${bucket}`].includes(pipeline.externalRef)) refuse("Source bucket is outside this build pipeline.");
            const metadata = await abortable(get(gcp, `https://storage.googleapis.com/storage/v1/b/${bucket}`), ctx.signal);
            if (metadata.name !== bucket) refuse("Source bucket identity does not match the pipeline.");
            assertLabels(gcp, pipeline, metadata);
          }
          const format = ctx.provider === "aws" ? "zip" : "tar.gz";
          const bundle = await acquire(input.source, ctx.signal, { workspaceId: ctx.workspaceId, environmentId: ctx.environmentId }, format);
          const key = `zenith/${ctx.environmentId}/${input.service.address.split("/")[1]}/${bundle.sha256}.${format}`;
          checkSignal(ctx.signal);
          if (ctx.provider === "aws") await abortable(uploadAws(ctx as DriverContext<AwsSession>, bucket, key, bundle), ctx.signal);
          else await abortable(uploadGcp(ctx as DriverContext<GcpSession>, bucket, key, bundle, limits), ctx.signal);
          checkSignal(ctx.signal);
          return { s3Key: key, digest: bundle.sha256, bucket, objectKey: key, uri: `${ctx.provider === "aws" ? "s3" : "gs"}://${bucket}/${key}` };
        } catch (err) {
          if (ctx.signal.aborted) throw interrupted();
          if (err instanceof Refused) throw err;
          throw new Error("Source bundle preparation could not be confirmed; outcome is unknown.");
        }
      },
    },
  };
}
