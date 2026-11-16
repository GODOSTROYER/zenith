import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import { objectStoreLeg } from "../../../scripts/release/drivers/export-data-objects";
import { knownData, objectWitness } from "../../../scripts/release/drivers/export-data-plan";
import type { LegContext, LegEndpoint } from "../../../scripts/release/drivers/export-data-leg";

const state = vi.hoisted(() => ({ configs: [] as Record<string, unknown>[], endpoints: new WeakMap<object, string>() }));
vi.mock("@aws-sdk/client-s3", async importOriginal => {
  const sdk = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return { ...sdk, S3Client: class extends sdk.S3Client {
    constructor(config: import("@aws-sdk/client-s3").S3ClientConfig) {
      super(config); state.configs.push(config as Record<string, unknown>);
      state.endpoints.set(this, String(config.endpoint));
    }
  } };
});
type Stored = { bytes: Buffer; contentType: string };
type Bucket = { owner?: string; objects: Map<string, Stored> };
let buckets: Map<string, Bucket>, ctx: LegContext, calls: string[];
let brokenPagination = false, corruptSeed = false, failedDelete: string | undefined;
const bucketName = (tenant: "a" | "b") => `drv4-${ctx.runId}-data-${tenant}`;
const bucketId = (endpoint: LegEndpoint, tenant: "a" | "b") => `${new URL(endpoint.url).origin}/${bucketName(tenant)}`;
function emptyBucket(endpoint: LegEndpoint, tenant: "a" | "b"): Bucket {
  const bucket = { owner: ctx.ownerLabel, objects: new Map<string, Stored>() };
  buckets.set(bucketId(endpoint, tenant), bucket);
  return bucket;
}
beforeEach(() => {
  state.configs.length = 0;
  brokenPagination = false; corruptSeed = false; failedDelete = undefined;
  buckets = new Map(); calls = [];
  const credentials = { user: randomBytes(16).toString("hex"), password: randomBytes(32).toString("hex") };
  ctx = { runId: "objects-test", tenant: "a", ownerLabel: "DRV4-DATA:objects-test", source: { url: "http://localhost:9000", bucket: "drv4-objects-test-data-a", ...credentials }, target: { url: "https://localhost:9001", bucket: "drv4-objects-test-data-a", ...credentials } };
  for (const tenant of ["a", "b"] as const) emptyBucket(ctx.target, tenant);
  vi.spyOn(S3Client.prototype, "send").mockImplementation((async function(this: S3Client, command: { input: Record<string, unknown>; constructor: { name: string } }) {
    const name = command.constructor.name, input = command.input, id = `${state.endpoints.get(this)}/${String(input.Bucket)}`;
    calls.push(`${name}:${id}`);
    if (name === "CreateBucketCommand") {
      if (buckets.has(id)) throw new Error("Bucket already exists");
      buckets.set(id, { objects: new Map() }); return {};
    }
    const bucket = buckets.get(id);
    if (!bucket) throw Object.assign(new Error("Missing bucket"), { name: "NoSuchBucket" });
    switch (name) {
      case "GetBucketTaggingCommand": return { TagSet: bucket.owner ? [{ Key: "zenith-owner", Value: bucket.owner }] : [] };
      case "PutBucketTaggingCommand": bucket.owner = (input.Tagging as { TagSet: { Value: string }[] }).TagSet[0].Value; return {};
      case "PutObjectCommand": bucket.objects.set(String(input.Key), { bytes: corruptSeed ? Buffer.from([1]) : Buffer.from(input.Body as Buffer), contentType: String(input.ContentType) }); return {};
      case "ListObjectsV2Command": {
        const keys = [...bucket.objects.keys()].sort();
        const index = Number(input.ContinuationToken ?? 0);
        return { Contents: keys.slice(index, index + 1).map(Key => ({ Key })), IsTruncated: brokenPagination || index + 1 < keys.length, NextContinuationToken: brokenPagination ? undefined : String(index + 1) };
      }
      case "GetObjectCommand": {
        const object = bucket.objects.get(String(input.Key))!;
        return { Body: { transformToByteArray: async () => object.bytes }, ContentType: object.contentType };
      }
      case "DeleteObjectCommand": if (id === failedDelete) throw new Error("Injected owned delete failure"); bucket.objects.delete(String(input.Key)); return {};
      case "DeleteBucketCommand": expect(bucket.objects.size).toBe(0); buckets.delete(id); return {};
      default: throw new Error(`Unexpected command ${name}`);
    }
  }) as never);
});
afterEach(() => vi.restoreAllMocks());
function target(dataTenant: "a" | "b" = ctx.tenant, bucketTenant: "a" | "b" = ctx.tenant): Bucket {
  const bucket = emptyBucket(ctx.target, bucketTenant);
  for (const object of knownData(ctx.runId, dataTenant).objects) bucket.objects.set(object.key, { bytes: object.bytes, contentType: object.contentType });
  return bucket;
}
describe("object-store leg (offline SDK fakes, no engine acceptance)", () => {
  it.each(["a", "b"] as const)("seeds separate export buckets and independently reads tenant %s across pages", async tenant => {
    ctx.tenant = tenant; ctx.source.bucket = bucketName(tenant); ctx.target.bucket = bucketName(tenant);
    const witness = await objectStoreLeg.seedSource(ctx);
    expect(witness).toEqual(objectWitness(knownData(ctx.runId, tenant).objects));
    for (const letter of ["a", "b"] as const) {
      const bucket = buckets.get(bucketId(ctx.source, letter))!;
      expect([...bucket.objects.keys()].sort()).toEqual(knownData(ctx.runId, letter).objects.map(object => object.key).sort());
      expect(bucket.owner).toBe(ctx.ownerLabel);
      expect(buckets.get(bucketId(ctx.target, letter))?.objects.size).toBe(0);
      expect(await objectStoreLeg.readTarget({ ...ctx, tenant: letter, target: { ...ctx.source, bucket: bucketName(letter) } })).toEqual(objectWitness(knownData(ctx.runId, letter).objects));
    }
    expect(calls.filter(call => call.startsWith("GetObjectCommand"))).toHaveLength(15);
    expect(await objectStoreLeg.readTarget(ctx)).toEqual(objectWitness([]));
    target();
    expect(await objectStoreLeg.readTarget(ctx)).toEqual(witness);
    await objectStoreLeg.assertNoForeignTenant(ctx);
    expect(state.configs.every(config => config.forcePathStyle === true)).toBe(true);
    const handler = state.configs.at(-1)!.requestHandler as { httpsAgent: { options: { rejectUnauthorized: boolean } } };
    expect(handler.httpsAgent.options.rejectUnauthorized).toBe(true);
    expect(state.configs.at(-1)!.credentials).toEqual({ accessKeyId: ctx.target.user, secretAccessKey: ctx.target.password });
  });
  it("uses actual source reads rather than expected fixtures as evidence", async () => {
    corruptSeed = true;
    await expect(objectStoreLeg.seedSource(ctx)).rejects.toThrow("readback mismatch");
    expect(calls.some(call => call.startsWith("GetObjectCommand"))).toBe(true);
  });
  it("detects bytes and content-type corruption", async () => {
    const bucket = target();
    const expected = objectWitness(knownData(ctx.runId, ctx.tenant).objects);
    bucket.objects.get("empty.dat")!.bytes = Buffer.from([1]);
    expect(await objectStoreLeg.readTarget(ctx)).not.toEqual(expected);
    await expect(objectStoreLeg.assertNoForeignTenant(ctx)).rejects.toThrow("readback mismatch");
    target().objects.get("empty.dat")!.contentType = "text/plain";
    expect(await objectStoreLeg.readTarget(ctx)).not.toEqual(expected);
    await expect(objectStoreLeg.assertNoForeignTenant(ctx)).rejects.toThrow("readback mismatch");
  });
  it("rejects foreign tenant content, extra keys and writes to the foreign target bucket", async () => {
    target("b");
    await expect(objectStoreLeg.assertNoForeignTenant(ctx)).rejects.toThrow("readback mismatch");
    expect(await objectStoreLeg.readTarget(ctx)).not.toEqual(objectWitness(knownData(ctx.runId, "a").objects));
    target().objects.set("unexpected", { bytes: Buffer.alloc(0), contentType: "text/plain" });
    await expect(objectStoreLeg.assertNoForeignTenant(ctx)).rejects.toThrow("readback mismatch");
    target(); target("b", "b");
    await expect(objectStoreLeg.assertNoForeignTenant(ctx)).rejects.toThrow("Foreign tenant target");
  });
  it.each(["source", "target"] as const)("refuses prepopulated %s buckets before writing tenant data", async role => {
    emptyBucket(ctx[role], "b").objects.set("existing", { bytes: Buffer.from([1]), contentType: "text/plain" });
    await expect(objectStoreLeg.seedSource(ctx)).rejects.toThrow(`${role} bucket is not empty`);
    expect(calls.some(call => call.startsWith("PutObjectCommand"))).toBe(false);
    expect(buckets.get(bucketId(ctx[role], "b"))!.objects.has("existing")).toBe(true);
  });
  it("requires both target buckets to be preprovisioned and owned", async () => {
    buckets.delete(bucketId(ctx.target, "b"));
    await expect(objectStoreLeg.seedSource(ctx)).rejects.toThrow("Missing bucket");
    emptyBucket(ctx.target, "b").owner = "someone-else";
    await expect(objectStoreLeg.seedSource(ctx)).rejects.toThrow("ownership");
    expect(calls.some(call => call.startsWith("CreateBucketCommand") || call.startsWith("PutObjectCommand"))).toBe(false);
  });
  it("refuses unowned buckets without mutating them and still cleans other owned buckets", async () => {
    emptyBucket(ctx.source, "a").owner = "someone-else";
    target().owner = undefined;
    await expect(objectStoreLeg.seedSource(ctx)).rejects.toThrow("ownership");
    await expect(objectStoreLeg.readTarget(ctx)).rejects.toThrow("ownership");
    await expect(objectStoreLeg.cleanup(ctx)).rejects.toThrow("cleanup failed");
    for (const id of [bucketId(ctx.source, "a"), bucketId(ctx.target, "a")]) {
      expect(calls.filter(call => call.endsWith(id)).every(call => call.startsWith("GetBucketTaggingCommand"))).toBe(true);
      expect(buckets.has(id)).toBe(true);
    }
    expect(buckets.has(bucketId(ctx.target, "b"))).toBe(false);
    expect(buckets.size).toBe(2);
  });
  it("checks ownership of the foreign target bucket too", async () => {
    target(); buckets.get(bucketId(ctx.target, "b"))!.owner = undefined;
    await expect(objectStoreLeg.assertNoForeignTenant(ctx)).rejects.toThrow("ownership");
  });
  it("cleans both tenants on both engines across pages and is idempotent", async () => {
    await objectStoreLeg.seedSource(ctx); target();
    await objectStoreLeg.cleanup(ctx); await objectStoreLeg.cleanup(ctx);
    expect(buckets.size).toBe(0);
    expect(calls.filter(call => call.startsWith("DeleteObjectCommand"))).toHaveLength(9);
    expect(calls.filter(call => call.startsWith("DeleteBucketCommand"))).toHaveLength(4);
  });
  it("attempts all other buckets after a cleanup failure and retries the remaining owned bucket", async () => {
    await objectStoreLeg.seedSource(ctx); target();
    failedDelete = bucketId(ctx.target, "a");
    await expect(objectStoreLeg.cleanup(ctx)).rejects.toThrow("cleanup failed");
    expect([...buckets.keys()]).toEqual([failedDelete]);
    failedDelete = undefined;
    await objectStoreLeg.cleanup(ctx);
    expect(buckets.size).toBe(0);
  });
  it("fails closed on incomplete pagination and missing readback metadata", async () => {
    target(); brokenPagination = true;
    await expect(objectStoreLeg.readTarget(ctx)).rejects.toThrow("pagination");
    brokenPagination = false;
    target().objects.get("empty.dat")!.contentType = "";
    await expect(objectStoreLeg.readTarget(ctx)).rejects.toThrow("Incomplete");
  });
  it.each(["credentials", "bucket", "owner", "remote"] as const)("rejects invalid %s before any SDK request", async invalid => {
    if (invalid === "credentials") ctx.source.user = undefined;
    if (invalid === "bucket") ctx.source.bucket = bucketName("b");
    if (invalid === "owner") ctx.ownerLabel = "different-run";
    if (invalid === "remote") ctx.source.url = "https://example.com:9000";
    await expect(objectStoreLeg.seedSource(ctx)).rejects.toThrow("endpoint");
    expect(calls).toHaveLength(0);
  });
  it("requires digest-pinned images", () => {
    expect(() => objectStoreLeg.image({})).toThrow("digest");
    const image = `minio/minio@sha256:${"a".repeat(64)}`;
    expect(objectStoreLeg.image({ ZENITH_LOCAL_EXPORT_POSTGRES_IMAGE: image, ZENITH_LOCAL_EXPORT_MYSQL_IMAGE: image, ZENITH_LOCAL_EXPORT_MINIO_IMAGE: image })).toBe(image);
  });
});
