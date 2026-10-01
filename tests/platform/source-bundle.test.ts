/** Synthetic GitHub archives and cloud sessions: contract evidence only. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { BatchGetProjectsCommand, CodeBuildClient } from "@aws-sdk/client-codebuild";
import { GetBucketTaggingCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import type { AwsSession, GcpSession } from "@/lib/credentials/types";
import type { DriverContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { StoredResource } from "@/lib/execution/ports";
import { sha256Hex } from "@/lib/controlplane/digest";
import { createSourceBundles, SOURCE_BUNDLE_LIMITS, type SourceBundleDeps } from "@/lib/platform/source-bundle";
import { pipelineNames, labels } from "@/lib/providers/gcp/release/support";
import { writeTar, paxRecord, type TarEntry } from "../_support/tar";

const source = { repo: "https://github.com/acme/app.git", ref: "feature/exact-ref", dockerfile: "Dockerfile" };
const binary = Buffer.from([0, 255, 1, 254, 128]);
const entries: TarEntry[] = [
  { path: "app-ref/z.png", bytes: binary },
  { path: "app-ref/Dockerfile", bytes: Buffer.from("FROM scratch\nCOPY . /app\n") },
  { path: "app-ref/package-lock.json", bytes: Buffer.from('{"lockfileVersion":3}') },
  { path: "app-ref/scripts/", type: "dir" },
  { path: "app-ref/scripts/start.sh", bytes: Buffer.from("#!/bin/sh\necho hello\n") },
];
const response = (tar: Buffer) => new Response(new Uint8Array(gzipSync(tar)));
const transport = (tar = writeTar(entries)) => vi.fn<typeof fetch>(async () => response(tar));
function checksum(header: Buffer) {
  header.fill(32, 148, 156);
  header.write(header.reduce((sum, b) => sum + b, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8);
}
function changeHeader(tar: Buffer, modify: (header: Buffer) => void): Buffer {
  const copy = Buffer.from(tar); const head = copy.subarray(0, 512); modify(head); checksum(head); return copy;
}
function inspect(archive: Uint8Array) {
  const tar = gunzipSync(archive); const records: { name: string; header: Buffer; bytes: Buffer }[] = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const head = tar.subarray(offset, offset + 512); if (head.every((b) => b === 0)) break;
    const field = (at: number, length: number) => head.subarray(at, at + length).toString("utf8").split("\0")[0];
    const size = Number.parseInt(field(124, 12), 8); const prefix = field(345, 155);
    records.push({ name: [prefix, field(0, 100)].filter(Boolean).join("/"), header: head, bytes: tar.subarray(offset + 512, offset + 512 + size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return records;
}

describe("source acquisition and canonical archives", () => {
  it("fetches precisely the requested ref, preserves binary/lockfile bytes and sorts entries", async () => {
    const fetchImpl = transport(); const bundle = await createSourceBundles({ fetchImpl }).read(source);
    expect(fetchImpl).toHaveBeenCalledWith("https://codeload.github.com/acme/app/tar.gz/feature/exact-ref", expect.objectContaining({ redirect: "manual", signal: expect.any(AbortSignal) }));
    const files = inspect(bundle.archive);
    expect(files.map((f) => f.name)).toEqual(["Dockerfile", "package-lock.json", "scripts", "scripts/start.sh", "z.png"]);
    expect(files.find((f) => f.name === "z.png")?.bytes).toEqual(binary);
    expect(files.find((f) => f.name === "package-lock.json")?.bytes).toEqual(entries[2].bytes);
    expect(bundle.bytes).toBe(bundle.archive.byteLength); expect(bundle.sha256).toBe(sha256Hex(bundle.archive));
    expect(Buffer.from(bundle.archive).subarray(4, 8)).toEqual(Buffer.alloc(4)); expect(bundle.archive[9]).toBe(255);
    for (const file of files) {
      expect(file.header.subarray(108, 124).toString()).toBe("0000000\0" + "0000000\0");
      expect(file.header.subarray(136, 148).toString()).toBe("00000000000\0");
    }
  });
  it("normalizes archive order, root names, timestamps, uid/gid and non-executable modes", async () => {
    const first = writeTar(entries);
    const second = changeHeader(writeTar([...entries].reverse().map((e) => ({ ...e, path: e.path.replace("app-ref", "different-wrapper") }))), (h) => {
      h.write("0000666\0", 100); h.write("0000123\0", 108); h.write("0000456\0", 116); h.write("01234567012\0", 136);
    });
    const a = await createSourceBundles({ fetchImpl: transport(first) }).read(source);
    const b = await createSourceBundles({ fetchImpl: transport(second) }).read(source);
    expect(a).toEqual(b);
    const changed = await createSourceBundles({ fetchImpl: transport(writeTar(entries.map((e, i) => i === 0 ? { ...e, bytes: Buffer.from("other") } : e))) }).read(source);
    expect(changed.sha256).not.toBe(a.sha256);
  });
  it("preserves executable intent while removing setuid and other permission bits", async () => {
    const executable = changeHeader(writeTar([{ path: "root/run", bytes: Buffer.from("run") }]), (h) => h.write("0004751\0", 100));
    const bundle = await createSourceBundles({ fetchImpl: transport(executable) }).read({ ...source, dockerfile: undefined });
    expect(inspect(bundle.archive)[0].header.subarray(100, 108).toString()).toBe("0000755\0");
  });
  it("supports GitHub global commit metadata, PAX paths, GNU long names and UTF-8", async () => {
    const long = `root/${"a".repeat(120)}/file`; const unicode = "root/日本語.txt";
    const utf8Record = Buffer.from(` path=${unicode}\n`); let length = utf8Record.length + 1;
    while (String(length).length + utf8Record.length !== length) length = String(length).length + utf8Record.length;
    const tar = writeTar([
      { path: "pax", type: "paxGlobal", bytes: paxRecord("comment", "a".repeat(40)) },
      { path: "pax", type: "pax", bytes: Buffer.from(`${length}${utf8Record.toString()}`) },
      { path: "stub", bytes: Buffer.from("日本語") },
      { path: "long", type: "gnuLongName", bytes: Buffer.from(`${long}\0`) },
      { path: "stub", bytes: Buffer.from("long") },
    ]);
    const bundle = await createSourceBundles({ fetchImpl: transport(tar) }).read({ repo: "acme/app", ref: "a".repeat(40) });
    expect(inspect(bundle.archive).map((f) => f.name)).toEqual([long.slice(5), unicode.slice(5)]);
  });
  it("emits deterministic PAX records for paths that cannot fit a ustar header", async () => {
    const path = `root/${"x".repeat(150)}`;
    const tar = writeTar([{ path: "long", type: "gnuLongName", bytes: Buffer.from(`${path}\0`) }, { path: "stub", bytes: Buffer.from("data") }]);
    const bundle = await createSourceBundles({ fetchImpl: transport(tar) }).read({ repo: "acme/app", ref: "v1" });
    const files = inspect(bundle.archive);
    expect(files[0].header[156]).toBe("x".charCodeAt(0)); expect(files[0].bytes.toString()).toContain(`path=${path.slice(5)}\n`);
    expect(files[1].bytes.toString()).toBe("data");
  });
  it.each([
    "https://token-canary@github.com/acme/app", "https://github.com/acme/app?token=canary", "https://github.com/acme/app#canary",
    "https://github.com:443/acme/app", "https://evil.test/acme/app", "file:///repo", "git@github.com:acme/app", "acme/..", "acme/app/extra",
  ])("rejects unsupported or credential-bearing repo coordinates: %s", async (repo) => {
    const fetchImpl = transport(); await expect(createSourceBundles({ fetchImpl }).read({ ...source, repo })).rejects.toThrow("GitHub repository"); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(["", "../main", "main?token=canary", "branch//x", "$(command)", "a\ncanary"])("rejects invalid refs: %s", async (ref) => {
    const fetchImpl = transport(); await expect(createSourceBundles({ fetchImpl }).read({ ...source, ref })).rejects.toThrow("git ref"); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(["../Dockerfile", "/Dockerfile", "a\\Dockerfile", "a;command", "a//Dockerfile"])("rejects unsafe Dockerfile paths: %s", async (dockerfile) => {
    const fetchImpl = transport(); await expect(createSourceBundles({ fetchImpl }).read({ ...source, dockerfile })).rejects.toThrow("Dockerfile"); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("refuses missing Dockerfiles and does not fall back after a missing ref", async () => {
    await expect(createSourceBundles({ fetchImpl: transport() }).read({ ...source, dockerfile: "other.Dockerfile" })).rejects.toThrow("absent");
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("PRIVATE-CANARY", { status: 404 }));
    await expect(createSourceBundles({ fetchImpl }).read(source)).rejects.toThrow("exact ref"); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("uses connector tokens only in the initial Authorization header and scrubs failures", async () => {
    const token = "PRIVATE-SOURCE-CANARY";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://codeload.github.com/acme/app/tar.gz/exact" } })).mockResolvedValueOnce(response(writeTar(entries)));
    const connector = vi.fn(async (_input, fn: (token?: string) => Promise<unknown>) => fn(token));
    const deps: SourceBundleDeps = { fetchImpl, withGithubAccess: async (input, fn) => connector(input, fn) as ReturnType<typeof fn> };
    const bundle = await createSourceBundles(deps).read(source);
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
    expect(fetchImpl.mock.calls[1][1]?.headers).not.toHaveProperty("Authorization");
    expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes(token))).toBe(true); expect(JSON.stringify(bundle)).not.toContain(token);
    const broken = createSourceBundles({ fetchImpl: vi.fn(async () => { throw new Error(token); }) });
    await expect(broken.read(source)).rejects.toThrow("acquisition failed");
    await expect(broken.read(source)).rejects.not.toThrow(token);
  });
  it.each(["http://codeload.github.com/file", "https://evil.test/file", "https://token-canary@github.com/file", "https://api.github.com/file?token=canary", "https://github.com:444/file"])("refuses unsafe redirect: %s", async (location) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location } }));
    await expect(createSourceBundles({ fetchImpl }).read(source)).rejects.toThrow("allowlist"); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("bounds redirect loops", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location: "https://github.com/acme/app/archive/exact" } }));
    await expect(createSourceBundles({ fetchImpl }).read(source)).rejects.toThrow("redirect limit"); expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
  it.each(["symlink", "hardlink", "chardev", "blockdev", "fifo", "contiguous"] as const)("refuses %s entries", async (type) => {
    const tar = writeTar([{ path: "root/entry", type, linkname: "../../outside" }]);
    await expect(createSourceBundles({ fetchImpl: transport(tar) }).read(source)).rejects.toThrow("special entries");
  });
  it.each(["root/../outside", "/absolute", "C:/absolute", "root/a\\b", "root/line\ncanary"])("refuses unsafe tar paths: %s", async (path) => {
    await expect(createSourceBundles({ fetchImpl: transport(writeTar([{ path }])) }).read(source)).rejects.toThrow(/unsafe path|traversal/);
  });
  it.each(([
    [{ path: "root/a" }, { path: "root/./a" }],
    [{ path: "root/a" }, { path: "other/b" }],
    [{ path: "root/a" }, { path: "root/a/b" }],
    [{ path: "root/file", corruptChecksum: true }],
    [{ path: "root/file", declaredSize: 100_000 }],
    [{ path: "pax", type: "pax", bytes: paxRecord("GNU.sparse.map", "0,1") }, { path: "root/file" }],
    [{ path: "pax", type: "pax", bytes: Buffer.from("99 path=root/file\n") }, { path: "root/file" }],
  ] satisfies TarEntry[][]).map((files) => ({ files })))("fails closed on damaged/ambiguous archive %#", async ({ files }) => {
    await expect(createSourceBundles({ fetchImpl: transport(writeTar(files)) }).read(source)).rejects.toThrow();
  });
  it("rejects empty archives, incomplete terminators and data hidden after the terminator", async () => {
    for (const tar of [writeTar([]), writeTar(entries, { terminate: false }), writeTar(entries).subarray(0, -512), Buffer.concat([writeTar(entries), Buffer.from("hidden")])]) {
      await expect(createSourceBundles({ fetchImpl: transport(tar) }).read(source)).rejects.toThrow();
    }
  });
  it("bounds declared/compressed/unpacked/file sizes and entry counts", async () => {
    const canceled = vi.fn();
    const stream = () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(201)); }, cancel: canceled });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(stream()));
    await expect(createSourceBundles({ fetchImpl, limits: { maxArchiveBytes: 200 } }).read(source)).rejects.toThrow("compressed size bound"); expect(canceled).toHaveBeenCalledTimes(1);
    const declared = vi.fn<typeof fetch>(async () => new Response(stream(), { headers: { "content-length": "201" } }));
    await expect(createSourceBundles({ fetchImpl: declared, limits: { maxArchiveBytes: 200 } }).read(source)).rejects.toThrow("compressed size bound");
    await expect(createSourceBundles({ fetchImpl: transport(), limits: { maxUnpackedBytes: 512 } }).read(source)).rejects.toThrow("decompression bound");
    await expect(createSourceBundles({ fetchImpl: transport(), limits: { maxFileBytes: 1 } }).read(source)).rejects.toThrow("oversized");
    await expect(createSourceBundles({ fetchImpl: transport(), limits: { maxEntries: 1 } }).read(source)).rejects.toThrow("entry count");
  });
  it("also bounds the normalized tar and compressed output", async () => {
    const long = `root/${"a".repeat(503)}`;
    const tar = writeTar([{ path: "long", type: "gnuLongName", bytes: Buffer.from(`${long}\0`) }, { path: "stub" }]);
    const input = { repo: "acme/app", ref: "v1" };
    await expect(createSourceBundles({ fetchImpl: transport(tar), limits: { maxUnpackedBytes: tar.length } }).read(input)).rejects.toThrow("unpacked size bound");
    const compressed = gzipSync(tar);
    const bundle = await createSourceBundles({ fetchImpl: transport(tar) }).read(input);
    expect(bundle.bytes).toBeGreaterThan(compressed.length);
    await expect(createSourceBundles({ fetchImpl: transport(tar), limits: { maxArchiveBytes: compressed.length } }).read(input)).rejects.toThrow("compressed size bound");
  });
  it("validates limit settings", () => {
    for (const limits of [{ maxEntries: 0 }, { maxArchiveBytes: NaN }, { maxUnpackedBytes: SOURCE_BUNDLE_LIMITS.maxUnpackedBytes + 1 }]) expect(() => createSourceBundles({ limits })).toThrow("hard ceilings");
    for (const timeoutMs of [0, -1, 300_001, 1.5]) expect(() => createSourceBundles({ timeoutMs })).toThrow("deadline");
  });
  it("cancels before acquisition and interrupts stalled downloads without echoing abort reasons", async () => {
    const abort = new AbortController(); abort.abort(new Error("ABORT-SECRET-CANARY")); const fetchImpl = transport();
    await expect(createSourceBundles({ fetchImpl }).read(source, abort.signal)).rejects.toThrow("interrupted"); expect(fetchImpl).not.toHaveBeenCalled();
    const stalledFetch = vi.fn<typeof fetch>(() => new Promise(() => undefined));
    await expect(createSourceBundles({ fetchImpl: stalledFetch, timeoutMs: 10 }).read(source)).rejects.toThrow("interrupted");
    const canceled = vi.fn(); const stalledBody = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel: canceled })));
    await expect(createSourceBundles({ fetchImpl: stalledBody, timeoutMs: 10 }).read(source)).rejects.toThrow("interrupted"); expect(canceled).toHaveBeenCalledTimes(1);
  });
});

const s3 = mockClient(S3Client); const cb = mockClient(CodeBuildClient);
beforeEach(() => { s3.reset(); cb.reset(); }); afterAll(() => { s3.restore(); cb.restore(); });
const accountId = "123456789012"; const bucket = "zenith-env-1-web-src";
function fixture(provider: "aws" | "gcp" = "aws") {
  const region = provider === "aws" ? "us-east-1" : "asia-south1";
  const node = (address: string, kind: ResourceNode["kind"], spec: Record<string, unknown>): ResourceNode => ({ address, kind, provider, region, spec, specDigest: sha256Hex(JSON.stringify(spec)), ownership: "managed", nativeType: `${provider}:fixture`, origin: [], dependsOn: [], labels: {} });
  const service = node("container_service/web", "container_service", { artifact: { type: "built", pipeline: "build_pipeline/web" } });
  const pipeline = node("build_pipeline/web", "build_pipeline", { source, location: "customer_account" });
  if (provider === "aws") pipeline.externalRef = `arn:aws:codebuild:${region}:${accountId}:project/zenith-env-1-web`;
  const rows: StoredResource[] = [service, pipeline].map((n) => ({ ...n, id: n.address, workspaceId: "ws-1", environmentId: "env-1", status: "active", externalId: n.externalRef }));
  const resources = { list: vi.fn(async () => rows) }; const fetchImpl = transport();
  const session: AwsSession = { provider: "aws", accountId, region, transport: "direct", expiresAt: "2099-01-01T00:00:00Z", client: (ctor) => new ctor({ region }), childProcessEnv: () => { throw new Error("Unused credential accessor."); } };
  const ctx: DriverContext = { provider, region, workspaceId: "ws-1", environmentId: "env-1", session, signal: new AbortController().signal, log: vi.fn(), tags: {}, now: () => new Date() };
  const tags = { "zenith:workspace": ctx.workspaceId, "zenith:environment": ctx.environmentId, "zenith:managed": "true", "zenith:resource": pipeline.address };
  cb.on(BatchGetProjectsCommand).resolves({ projects: [{ name: "zenith-env-1-web", arn: pipeline.externalRef, source: { type: "S3", location: `${bucket}/source/initial.zip` }, tags: Object.entries(tags).map(([key, value]) => ({ key, value })) }] });
  s3.on(GetBucketTaggingCommand).resolves({ TagSet: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) }); s3.on(PutObjectCommand).resolves({});
  return { ctx, service, pipeline, rows, resources, fetchImpl, tags, port: createSourceBundles({ resources, fetchImpl }).port };
}

describe("customer source bucket uploads", () => {
  it("uploads through the brokered AWS session with a verified owner, checksum and pinned C3 fields", async () => {
    const w = fixture(); const result = await w.port.prepare(w.ctx, { service: w.service, source });
    const key = `zenith/env-1/web/${result.digest}.tar.gz`;
    expect(result).toEqual({ s3Key: key, objectKey: key, digest: expect.stringMatching(/^[a-f0-9]{64}$/), bucket, uri: `s3://${bucket}/${key}` });
    expect(w.resources.list).toHaveBeenCalledWith("ws-1", "env-1");
    expect(s3.commandCalls(GetBucketTaggingCommand)[0].args[0].input.ExpectedBucketOwner).toBe(accountId);
    const put = s3.commandCalls(PutObjectCommand)[0].args[0].input;
    expect(put).toMatchObject({ Bucket: bucket, Key: key, ExpectedBucketOwner: accountId, IfNoneMatch: "*", ContentType: "application/gzip", ChecksumSHA256: Buffer.from(result.digest, "hex").toString("base64") });
    expect(sha256Hex(put.Body as Uint8Array)).toBe(result.digest); expect(w.ctx.log).not.toHaveBeenCalled();
  });
  it("handles duplicate/concurrent AWS prepares only when the existing object checksum and size match", async () => {
    const w = fixture(); const bundle = await createSourceBundles({ fetchImpl: transport() }).read(source);
    s3.on(PutObjectCommand).rejects({ $metadata: { httpStatusCode: 412 } });
    s3.on(HeadObjectCommand).resolves({ ContentLength: bundle.bytes, ChecksumSHA256: Buffer.from(bundle.sha256, "hex").toString("base64") });
    const [a, b] = await Promise.all([w.port.prepare(w.ctx, { service: w.service, source }), w.port.prepare(w.ctx, { service: w.service, source })]);
    expect(a).toEqual(b); expect(s3.commandCalls(HeadObjectCommand)).toHaveLength(2);
    s3.on(HeadObjectCommand).resolves({ ContentLength: bundle.bytes, ChecksumSHA256: "wrong" });
    await expect(w.port.prepare(w.ctx, { service: w.service, source })).rejects.toThrow("refusing to replace");
  });
  it.each(["workspace", "environment", "source", "ownership", "deleted", "digest", "duplicate"])("refuses a mismatched stored %s before cloud writes", async (mismatch) => {
    const w = fixture();
    if (mismatch === "workspace") w.rows[1].workspaceId = "foreign";
    if (mismatch === "environment") w.rows[1].environmentId = "foreign";
    if (mismatch === "source") w.rows[1].spec = { ...w.rows[1].spec, source: { ...source, ref: "wrong" } };
    if (mismatch === "ownership") w.rows[1].ownership = "referenced";
    if (mismatch === "deleted") w.rows[1].status = "deleted";
    if (mismatch === "digest") w.rows[0].specDigest = "f".repeat(64);
    if (mismatch === "duplicate") w.rows.push({ ...w.rows[1], id: "another" });
    await expect(w.port.prepare(w.ctx, { service: w.service, source })).rejects.toThrow(); expect(w.fetchImpl).not.toHaveBeenCalled(); expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
  });
  it("refuses foreign AWS project ARNs, bucket tags and broker provider/region mismatches", async () => {
    const w = fixture(); w.rows[1].externalId = w.pipeline.externalRef!.replace(accountId, "999999999999");
    await expect(w.port.prepare(w.ctx, { service: w.service, source })).rejects.toThrow("AWS account"); expect(cb.calls()).toHaveLength(0);
    w.rows[1].externalId = w.pipeline.externalRef;
    s3.on(GetBucketTaggingCommand).resolves({ TagSet: Object.entries({ ...w.tags, "zenith:workspace": "foreign" }).map(([Key, Value]) => ({ Key, Value })) });
    await expect(w.port.prepare(w.ctx, { service: w.service, source })).rejects.toThrow("outside this workspace");
    for (const ctx of [{ ...w.ctx, provider: "azure" as const }, { ...w.ctx, region: "other" }]) await expect(w.port.prepare(ctx, { service: w.service, source })).rejects.toThrow("matching AWS or GCP");
    expect(w.fetchImpl).not.toHaveBeenCalled(); expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
  });
  it("does not leak SDK/connector errors or claim success after an uncertain upload", async () => {
    const w = fixture(); s3.on(PutObjectCommand).rejects(new Error("CLOUD-SECRET-CANARY"));
    const result = w.port.prepare(w.ctx, { service: w.service, source });
    await expect(result).rejects.toThrow("outcome is unknown"); await expect(result).rejects.not.toThrow("CLOUD-SECRET-CANARY"); expect(w.ctx.log).not.toHaveBeenCalled();
  });
  it("requires configured source access/resource scope and rejects stale sessions safely", async () => {
    const w = fixture();
    await expect(createSourceBundles().port.prepare(w.ctx, { service: w.service, source })).rejects.toThrow("stored build pipeline");
    await expect(w.port.prepare({ ...w.ctx, environmentId: "../other" }, { service: w.service, source })).rejects.toThrow("identifier");
    const expired = { ...w.ctx, session: { ...w.ctx.session as AwsSession, client: () => { throw new Error("EXPIRED-SECRET-CANARY"); } } };
    const result = w.port.prepare(expired, { service: w.service, source });
    await expect(result).rejects.toThrow("outcome is unknown"); await expect(result).rejects.not.toThrow("EXPIRED-SECRET-CANARY");
    expect(w.fetchImpl).not.toHaveBeenCalled(); expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
  });
  it("honors cancellation before preparation and a deadline during a stalled store read", async () => {
    const w = fixture(); const abort = new AbortController(); abort.abort("SECRET-ABORT-REASON");
    await expect(w.port.prepare({ ...w.ctx, signal: abort.signal }, { service: w.service, source })).rejects.toThrow("interrupted"); expect(w.resources.list).not.toHaveBeenCalled();
    const port = createSourceBundles({ resources: { list: () => new Promise(() => undefined) }, timeoutMs: 10 }).port;
    await expect(port.prepare(w.ctx, { service: w.service, source })).rejects.toThrow("interrupted"); expect(cb.calls()).toHaveLength(0);
  });
});

function googleFixture() {
  const w = fixture("gcp"); let stored: Uint8Array | undefined; const state = { uploadStatus: 200, foreign: false, corrupt: false, badReceipt: false };
  const session: GcpSession = { provider: "gcp", projectId: "acme-prod-123456", region: w.ctx.region, expiresAt: "2099-01-01T00:00:00Z", childProcessEnv: () => { throw new Error("Unused."); }, authorizedFetch: vi.fn(async (raw, init) => {
    const url = new URL(raw); const name = url.searchParams.get("name") ?? decodeURIComponent(url.pathname.split("/o/")[1] ?? "");
    const names = pipelineNames({ ...w.ctx, session }, w.pipeline);
    if (init?.method === "POST") {
      if (state.uploadStatus !== 200) return new Response("CLOUD-SECRET-CANARY", { status: state.uploadStatus });
      stored = new Uint8Array(init.body as Uint8Array);
      return Response.json({ bucket: names.bucket, name: state.badReceipt ? "foreign" : name, size: String(stored.length), md5Hash: createHash("md5").update(stored).digest("base64"), generation: "7" });
    }
    if (!url.pathname.includes("/o/")) return Response.json({ name: names.bucket, labels: { ...labels({ ...w.ctx, session }, w.pipeline), ...(state.foreign ? { zenith_workspace: "foreign" } : {}) } });
    if (url.searchParams.get("alt") === "media") return new Response(new Uint8Array(state.corrupt ? Buffer.from("corrupt") : stored!));
    return Response.json({ bucket: names.bucket, name, size: String(stored?.length), generation: "7" });
  }) };
  w.ctx.session = session;
  return { ...w, session, state };
}
describe("GCS source upload through authorizedFetch", () => {
  it("uses GCS media upload, generation preconditions and additive URI fields", async () => {
    const w = googleFixture(); const result = await w.port.prepare(w.ctx, { service: w.service, source });
    expect(result.uri).toBe(`gs://${result.bucket}/${result.s3Key}`); expect(result.objectKey).toBe(result.s3Key);
    const calls = vi.mocked(w.session.authorizedFetch).mock.calls; const upload = calls.find(([, init]) => init?.method === "POST")!;
    const url = new URL(upload[0]); expect(url.origin).toBe("https://storage.googleapis.com"); expect(url.pathname).toBe(`/upload/storage/v1/b/${result.bucket}/o`);
    expect(url.searchParams.get("name")).toBe(result.s3Key); expect(url.searchParams.get("ifGenerationMatch")).toBe("0"); expect(url.searchParams.get("uploadType")).toBe("media");
    expect(upload[1]?.headers).not.toHaveProperty("Authorization"); expect(upload[1]?.redirect).toBe("error"); expect(sha256Hex(upload[1]?.body as Uint8Array)).toBe(result.digest);
  });
  it("pins and hashes an existing generation before reusing it, and rejects conflicting bytes", async () => {
    const w = googleFixture(); const a = await w.port.prepare(w.ctx, { service: w.service, source }); w.state.uploadStatus = 412;
    expect(await w.port.prepare(w.ctx, { service: w.service, source })).toEqual(a);
    expect(vi.mocked(w.session.authorizedFetch).mock.calls.some(([url]) => url.endsWith("?alt=media&generation=7"))).toBe(true);
    w.state.corrupt = true; await expect(w.port.prepare(w.ctx, { service: w.service, source })).rejects.toThrow("different SHA-256");
  });
  it("refuses foreign bucket labels before source acquisition or upload", async () => {
    const w = googleFixture(); w.state.foreign = true;
    await expect(w.port.prepare(w.ctx, { service: w.service, source })).rejects.toThrow(); expect(w.fetchImpl).not.toHaveBeenCalled();
    expect(vi.mocked(w.session.authorizedFetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
  it("rejects failed uploads and mismatched successful receipts without echoing response text", async () => {
    const w = googleFixture(); w.state.uploadStatus = 503;
    const failed = w.port.prepare(w.ctx, { service: w.service, source }); await expect(failed).rejects.toThrow("outcome is unknown"); await expect(failed).rejects.not.toThrow("CLOUD-SECRET-CANARY");
    w.state.uploadStatus = 200; w.state.badReceipt = true; await expect(w.port.prepare(w.ctx, { service: w.service, source })).rejects.toThrow("integrity");
  });
  it("passes workspace/environment identity into private source access", async () => {
    const w = googleFixture(); const scopes: unknown[] = [];
    const port = createSourceBundles({ resources: w.resources, fetchImpl: w.fetchImpl, withGithubAccess: async (scope, fn) => { scopes.push(scope); return fn("PRIVATE-CANARY"); } }).port;
    await port.prepare(w.ctx, { service: w.service, source }); expect(scopes).toEqual([{ owner: "acme", repo: "app", workspaceId: "ws-1", environmentId: "env-1" }]);
  });
});

describe.skipIf(process.env.ZENITH_TEST_SOURCE_GITHUB !== "1")("live public GitHub source (opt-in network)", () => {
  it("downloads a pinned public commit into a source bundle", async () => {
    const repo = process.env.ZENITH_TEST_SOURCE_REPO; const ref = process.env.ZENITH_TEST_SOURCE_REF;
    if (!repo || !ref || !/^[a-f0-9]{40}$/.test(ref)) throw new Error("The live source check requires ZENITH_TEST_SOURCE_REPO and a 40-hex ZENITH_TEST_SOURCE_REF.");
    const bundle = await createSourceBundles().read({ repo, ref }); expect(bundle.sha256).toBe(sha256Hex(bundle.archive)); expect(bundle.bytes).toBeGreaterThan(0);
  }, 65_000);
});
