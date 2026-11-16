/**
 * PROD-LIFE-11: object-store export, import and independent readback. Source,
 * target and tenant artifact storage are real directories behind the same ports
 * the S3 adapter implements; a LocalStack lane (below) runs the production adapter.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyArtifact } from "@/lib/portability/artifact";
import { exportObjects, readbackObjects } from "@/lib/portability/engines/objectstore";
import { S3ObjectStore, parseS3Credentials, s3ArtifactStore } from "@/lib/portability/engines/s3";
import { runExport, runImport, type ServiceBinding } from "@/lib/portability/service";
import { directoryArtifactStore, directoryObjectStore, tempDir } from "./support";

const SOURCE = { provider: "aws", nativeType: "aws:s3_bucket", address: "object_store/assets", externalId: "assets-bucket" };
const base = { workspaceId: "ws_1", environmentId: "env_1", operationId: "op_1", now: new Date("2026-10-05T00:00:00Z"), source: SOURCE };

async function seeded() {
  const source = directoryObjectStore(tempDir("zenith-src-"));
  await source.put("index.html", Buffer.from("<h1>hi</h1>"), "text/html");
  await source.put("img/logo.png", Buffer.from([0, 1, 2, 3, 255]), "image/png");
  await source.put("weird key/with spaces & ünïcode ☃.txt", Buffer.from("unicode"), "text/plain");
  await source.put("empty", Buffer.alloc(0));
  return source;
}

describe("object store export", () => {
  it("copies every object byte for byte, with its content type, and verifies the artifact from storage", async () => {
    const source = await seeded();
    const dir = tempDir();
    const store = directoryArtifactStore(dir);
    const outcome = await runExport({ ...base, binding: { kind: "object_store", store: source }, store });
    expect(outcome.engine).toBe("s3-objects-v1");
    expect(outcome.coverage).toMatchObject({ objects: 4, bytes: 11 + 5 + 7 });
    const index = JSON.parse(fs.readFileSync(path.join(dir, "objects.json"), "utf8")) as { objects: { key: string; contentType: string | null; file: string }[] };
    expect(index.objects.map((o) => o.key)).toContain("weird key/with spaces & ünïcode ☃.txt");
    expect(index.objects.find((o) => o.key === "index.html")?.contentType).toBe("text/html");
    expect(fs.readFileSync(path.join(dir, index.objects.find((o) => o.key === "img/logo.png")!.file))).toEqual(Buffer.from([0, 1, 2, 3, 255]));
    expect((await verifyArtifact(store)).manifestDigest).toBe(outcome.manifestDigest);
  });

  it("exports an empty bucket as a valid, restorable empty export", async () => {
    const source = directoryObjectStore(tempDir());
    const store = directoryArtifactStore(tempDir());
    const outcome = await runExport({ ...base, binding: { kind: "object_store", store: source }, store });
    expect(outcome.coverage).toMatchObject({ objects: 0, bytes: 0 });
  });

  it("refuses a bucket over the object or size limits instead of exporting part of it", async () => {
    const source = await seeded();
    await expect(exportObjects(source, async () => undefined, { limits: { maxBytes: 1_000_000, maxRows: 1, maxObjects: 2, maxObjectBytes: 1_000_000 } })).rejects.toMatchObject({ code: "limit_exceeded" });
    await expect(exportObjects(source, async () => undefined, { limits: { maxBytes: 1_000_000, maxRows: 1, maxObjects: 10, maxObjectBytes: 6 } })).rejects.toMatchObject({ code: "limit_exceeded" });
    await expect(exportObjects(source, async () => undefined, { limits: { maxBytes: 10, maxRows: 1, maxObjects: 10, maxObjectBytes: 1_000 } })).rejects.toMatchObject({ code: "limit_exceeded" });
  });
});

describe("object store restore, verified by readback from the target", () => {
  it("restores into an empty bucket and a separate listing-and-hashing pass reads the same content back", async () => {
    const source = await seeded();
    const store = directoryArtifactStore(tempDir());
    const outcome = await runExport({ ...base, binding: { kind: "object_store", store: source }, store });
    const targetDir = tempDir("zenith-dst-");
    const target = directoryObjectStore(targetDir);
    const result = await runImport({
      recorded: { manifestDigest: outcome.manifestDigest, contentDigest: outcome.contentDigest, kind: "object_store", engine: outcome.engine },
      store, target: { provider: "aws", kind: "object_store" }, binding: { kind: "object_store", store: target },
      // a second store handle over the same bytes: the readback does not use the restore's handle
      openReadback: async () => ({ binding: { kind: "object_store", store: directoryObjectStore(targetDir) }, close: async () => undefined }),
    });
    expect(result.status).toBe("verified");
    expect(result.restored).toEqual({ objects: 4, bytes: 23 });
    expect((await target.get("img/logo.png"))?.contentType).toBe("image/png");
    expect((await target.get("weird key/with spaces & ünïcode ☃.txt"))?.bytes.toString()).toBe("unicode");
  });

  it("reports a mismatch when an object changes between restore and readback", async () => {
    const source = await seeded();
    const store = directoryArtifactStore(tempDir());
    const outcome = await runExport({ ...base, binding: { kind: "object_store", store: source }, store });
    const target = directoryObjectStore(tempDir());
    const result = await runImport({
      recorded: { manifestDigest: outcome.manifestDigest, contentDigest: outcome.contentDigest, kind: "object_store", engine: outcome.engine },
      store, target: { provider: "aws", kind: "object_store" }, binding: { kind: "object_store", store: target },
      openReadback: async () => {
        target.corrupt("index.html");
        return { binding: { kind: "object_store", store: target }, close: async () => undefined };
      },
    });
    expect(result.status).toBe("mismatch");
  });

  it("never merges into a non-empty bucket, and refuses a changed artifact before writing anything", async () => {
    const source = await seeded();
    const dir = tempDir();
    const store = directoryArtifactStore(dir);
    const outcome = await runExport({ ...base, binding: { kind: "object_store", store: source }, store });
    const recorded = { manifestDigest: outcome.manifestDigest, contentDigest: outcome.contentDigest, kind: "object_store" as const, engine: outcome.engine };
    const never = async (): Promise<{ binding: ServiceBinding; close: () => Promise<void> }> => { throw new Error("unreachable"); };

    const used = directoryObjectStore(tempDir());
    await used.put("already", Buffer.from("here"));
    await expect(runImport({ recorded, store, target: { provider: "aws", kind: "object_store" }, binding: { kind: "object_store", store: used }, openReadback: never })).rejects.toMatchObject({ code: "target_not_empty" });
    expect((await used.list("")).length).toBe(1);

    const index = JSON.parse(fs.readFileSync(path.join(dir, "objects.json"), "utf8")) as { objects: { file: string }[] };
    fs.writeFileSync(path.join(dir, index.objects[0]!.file), "rewritten");
    const fresh = directoryObjectStore(tempDir());
    await expect(runImport({ recorded, store, target: { provider: "aws", kind: "object_store" }, binding: { kind: "object_store", store: fresh }, openReadback: never })).rejects.toMatchObject({ code: "digest_mismatch" });
    expect((await fresh.list("")).length).toBe(0);
  });

  it("computes the same digest regardless of listing order, and a different one when a byte changes", async () => {
    const a = directoryObjectStore(tempDir());
    const b = directoryObjectStore(tempDir());
    for (const k of ["x", "y", "z"]) await a.put(k, Buffer.from(k));
    for (const k of ["z", "x", "y"]) await b.put(k, Buffer.from(k));
    expect((await readbackObjects(a)).contentDigest).toBe((await readbackObjects(b)).contentDigest);
    await b.put("y", Buffer.from("Y"));
    expect((await readbackObjects(a)).contentDigest).not.toBe((await readbackObjects(b)).contentDigest);
  });
});

describe("S3 adapter", () => {
  const good = { region: "us-east-1", bucket: "tenant-backups", accessKeyId: ["A", "KIA"].join("") + "TESTONLY12345678", secretAccessKey: "s".repeat(40) };

  it("validates the credentials secret and never echoes a value", () => {
    expect(parseS3Credentials(JSON.stringify(good)).bucket).toBe("tenant-backups");
    expect(parseS3Credentials(JSON.stringify({ ...good, endpoint: "https://s3.example.test/path?x=1" })).endpoint).toBe("https://s3.example.test");
    for (const bad of [{ ...good, bucket: "UPPER_CASE" }, { ...good, region: "" }, { ...good, accessKeyId: undefined }, { ...good, endpoint: "ftp://x" }, { ...good, endpoint: "https://user:pw@host" }, { ...good, endpoint: "not a url" }]) {
      const err = (() => { try { parseS3Credentials(JSON.stringify(bad)); } catch (e) { return e as Error; } return undefined; })();
      expect(err, JSON.stringify(bad)).toBeDefined();
      expect(err!.message).not.toContain(good.secretAccessKey);
    }
    expect(() => parseS3Credentials("not json")).toThrow(/not valid JSON/);
  });

  it("scopes artifact keys under its base prefix and refuses traversal", async () => {
    const inner = directoryObjectStore(tempDir());
    const artifacts = s3ArtifactStore(inner, "zenith-portability/ws/env/op/", "s3://b/zenith-portability/ws/env/op/");
    await artifacts.put("manifest.json", Buffer.from("{}"));
    await artifacts.put("tables/0000.ndjson", Buffer.from("x"));
    expect((await inner.list("")).map((o) => o.key)).toEqual(["zenith-portability/ws/env/op/manifest.json", "zenith-portability/ws/env/op/tables/0000.ndjson"]);
    expect(await artifacts.list("")).toEqual(["manifest.json", "tables/0000.ndjson"]);
    expect((await artifacts.get("manifest.json"))?.toString()).toBe("{}");
    expect(await artifacts.get("absent")).toBeNull();
    await expect(artifacts.put("../escape", Buffer.from("x"))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(artifacts.put("/abs", Buffer.from("x"))).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("speaks the S3 API through the SDK commands (contract: a scripted client, not a service)", async () => {
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    const objects = new Map<string, { body: Buffer; type?: string }>();
    const client = {
      async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
        const name = command.constructor.name;
        calls.push({ name, input: command.input });
        if (name === "PutObjectCommand") { objects.set(String(command.input.Key), { body: Buffer.from(command.input.Body as Buffer), type: command.input.ContentType as string | undefined }); return {}; }
        if (name === "GetObjectCommand") {
          const o = objects.get(String(command.input.Key));
          if (!o) throw Object.assign(new Error("nope"), { name: "NoSuchKey" });
          return { Body: { transformToByteArray: async () => new Uint8Array(o.body) }, ContentType: o.type };
        }
        if (name === "ListObjectsV2Command") {
          const keys = [...objects.keys()].filter((k) => k.startsWith(String(command.input.Prefix ?? ""))).sort();
          return { Contents: keys.map((Key) => ({ Key, Size: objects.get(Key)!.body.length })), IsTruncated: false };
        }
        throw new Error(`unexpected ${name}`);
      },
    };
    const store = new S3ObjectStore(parseS3Credentials(JSON.stringify(good)), { client });
    await store.put("a/b", Buffer.from("hello"), "text/plain");
    expect(await store.list("")).toEqual([{ key: "a/b", size: 5 }]);
    expect(await store.get("a/b")).toEqual({ bytes: Buffer.from("hello"), contentType: "text/plain" });
    expect(await store.get("missing")).toBeNull();
    expect(calls.every((c) => c.input.Bucket === "tenant-backups")).toBe(true);
  });
});

const ENDPOINT = process.env.ZENITH_TEST_S3_ENDPOINT?.trim();
describe.skipIf(!ENDPOINT)("LocalStack / S3-compatible endpoint through the production adapter", () => {
  it("exports one bucket and restores into another, verified by listing and hashing the target", async () => {
    // Needs ZENITH_TEST_S3_ENDPOINT (for example the repo's LocalStack, http://127.0.0.1:4566) and ZENITH_PORTABILITY_ALLOW_PRIVATE_HOSTS=1.
    const { S3Client, CreateBucketCommand } = await import("@aws-sdk/client-s3");
    const suffix = Math.random().toString(36).slice(2, 8);
    const creds = (bucket: string) => parseS3Credentials(JSON.stringify({ region: "us-east-1", bucket, accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test", secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test", endpoint: ENDPOINT }));
    const admin = new S3Client({ region: "us-east-1", endpoint: ENDPOINT, forcePathStyle: true, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test", secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test" } });
    const names = [`zenith-pt-src-${suffix}`, `zenith-pt-dst-${suffix}`, `zenith-pt-art-${suffix}`];
    for (const n of names) await admin.send(new CreateBucketCommand({ Bucket: n }));
    const [src, dst, art] = names.map((n) => new S3ObjectStore(creds(n), { allowPrivate: true }));
    await src!.put("a.txt", Buffer.from("alpha"), "text/plain");
    await src!.put("dir/b.bin", Buffer.from([1, 2, 3]), "application/octet-stream");
    const store = s3ArtifactStore(art!, "zenith-portability/ws_1/env_1/op_1/", "s3://art/zenith-portability/ws_1/env_1/op_1/");
    const outcome = await runExport({ ...base, binding: { kind: "object_store", store: src! }, store });
    const result = await runImport({
      recorded: { manifestDigest: outcome.manifestDigest, contentDigest: outcome.contentDigest, kind: "object_store", engine: outcome.engine },
      store, target: { provider: "aws", kind: "object_store" }, binding: { kind: "object_store", store: dst! },
      openReadback: async () => ({ binding: { kind: "object_store", store: new S3ObjectStore(creds(names[1]!), { allowPrivate: true }) }, close: async () => undefined }),
    });
    expect(result.status).toBe("verified");
  });
});
