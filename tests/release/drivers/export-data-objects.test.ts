import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import { objectStoreLeg } from "../../../scripts/release/drivers/export-data-objects";
import { knownData, objectWitness } from "../../../scripts/release/drivers/export-data-plan";
import type { LegContext } from "../../../scripts/release/drivers/export-data-leg";

const state = vi.hoisted(() => ({ configs: [] as Record<string, unknown>[] }));
vi.mock("@aws-sdk/client-s3", async importOriginal => {
  const sdk = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return { ...sdk, S3Client: class extends sdk.S3Client {
    constructor(config: import("@aws-sdk/client-s3").S3ClientConfig) { super(config); state.configs.push(config as Record<string, unknown>); }
  } };
});
type Stored = { bytes: Buffer; contentType: string };
type Bucket = { owner?: string; objects: Map<string, Stored> };
let buckets: Map<string, Bucket>, ctx: LegContext, calls: string[];
let brokenPagination = false;
beforeEach(() => {
  state.configs.length = 0;
  brokenPagination = false;
  buckets = new Map(); calls = [];
  const credentials = { user: randomBytes(16).toString("hex"), password: randomBytes(32).toString("hex") };
  ctx = { runId: "objects-test", tenant: "a", ownerLabel: "owned-test", source: { url: "http://localhost:9000", bucket: "source-test", ...credentials }, target: { url: "https://localhost:9001", bucket: "target-test", ...credentials } };
  vi.spyOn(S3Client.prototype, "send").mockImplementation((async (command: { input: Record<string, unknown>; constructor: { name: string } }) => {
    const name = command.constructor.name, input = command.input, bucketName = String(input.Bucket);
    calls.push(`${name}:${bucketName}`);
    if (name === "CreateBucketCommand") { buckets.set(bucketName, { objects: new Map() }); return {}; }
    const bucket = buckets.get(bucketName);
    if (!bucket) throw Object.assign(new Error("Missing bucket"), { name: "NoSuchBucket" });
    switch (name) {
      case "GetBucketTaggingCommand": return { TagSet: bucket.owner ? [{ Key: "zenith-owner", Value: bucket.owner }] : [] };
      case "PutBucketTaggingCommand": bucket.owner = (input.Tagging as { TagSet: { Value: string }[] }).TagSet[0].Value; return {};
      case "PutObjectCommand": bucket.objects.set(String(input.Key), { bytes: Buffer.from(input.Body as Buffer), contentType: String(input.ContentType) }); return {};
      case "ListObjectsV2Command": {
        const keys = [...bucket.objects.keys()].sort();
        const index = Number(input.ContinuationToken ?? 0);
        return { Contents: keys.slice(index, index + 1).map(Key => ({ Key })), IsTruncated: brokenPagination || index + 1 < keys.length, NextContinuationToken: brokenPagination ? undefined : String(index + 1) };
      }
      case "GetObjectCommand": {
        const object = bucket.objects.get(String(input.Key))!;
        return { Body: { transformToByteArray: async () => object.bytes }, ContentType: object.contentType };
      }
      case "DeleteObjectCommand": bucket.objects.delete(String(input.Key)); return {};
      case "DeleteBucketCommand": expect(bucket.objects.size).toBe(0); buckets.delete(bucketName); return {};
      default: throw new Error(`Unexpected command ${name}`);
    }
  }) as never);
});
afterEach(() => vi.restoreAllMocks());
function target(tenant: "a" | "b" = ctx.tenant): Bucket {
  const bucket = { owner: ctx.ownerLabel, objects: new Map(knownData(ctx.runId, tenant).objects.map(object => [`${ctx.runId}/${tenant}/${object.key}`, { bytes: object.bytes, contentType: object.contentType }])) };
  buckets.set(ctx.target.bucket!, bucket);
  return bucket;
}
describe("object-store leg (offline SDK fakes, no engine acceptance)", () => {
  it.each(["a", "b"] as const)("seeds both tenants and independently reads tenant %s across pages", async tenant => {
    ctx.tenant = tenant;
    const witness = await objectStoreLeg.seedSource(ctx);
    expect(witness).toEqual(objectWitness(knownData(ctx.runId, tenant).objects));
    expect(buckets.get(ctx.source.bucket!)?.objects.size).toBe(6);
    expect(calls.every(call => call.endsWith(ctx.source.bucket!))).toBe(true);
    target();
    expect(await objectStoreLeg.readTarget(ctx)).toEqual(witness);
    await objectStoreLeg.assertNoForeignTenant(ctx);
    expect(state.configs.every(config => config.forcePathStyle === true)).toBe(true);
    const handler = state.configs.at(-1)!.requestHandler as { httpsAgent: { options: { rejectUnauthorized: boolean } } };
    expect(handler.httpsAgent.options.rejectUnauthorized).toBe(true);
    expect(state.configs.at(-1)!.credentials).toEqual({ accessKeyId: ctx.target.user, secretAccessKey: ctx.target.password });
  });
  it("detects bytes and content-type corruption", async () => {
    const bucket = target();
    const expected = objectWitness(knownData(ctx.runId, ctx.tenant).objects);
    bucket.objects.get(`${ctx.runId}/a/empty.dat`)!.bytes = Buffer.from([1]);
    expect(await objectStoreLeg.readTarget(ctx)).not.toEqual(expected);
    target().objects.get(`${ctx.runId}/a/empty.dat`)!.contentType = "text/plain";
    expect(await objectStoreLeg.readTarget(ctx)).not.toEqual(expected);
  });
  it("rejects foreign tenants and keys outside the exported prefix", async () => {
    target("b");
    await expect(objectStoreLeg.assertNoForeignTenant(ctx)).rejects.toThrow("Foreign");
    await expect(objectStoreLeg.readTarget(ctx)).rejects.toThrow("Foreign");
    target().objects.set("unexpected", { bytes: Buffer.alloc(0), contentType: "text/plain" });
    await expect(objectStoreLeg.assertNoForeignTenant(ctx)).rejects.toThrow("Foreign");
  });
  it("refuses unowned buckets without mutating them", async () => {
    buckets.set(ctx.source.bucket!, { owner: "someone-else", objects: new Map() });
    target().owner = undefined;
    await expect(objectStoreLeg.seedSource(ctx)).rejects.toThrow("ownership");
    await expect(objectStoreLeg.readTarget(ctx)).rejects.toThrow("ownership");
    await expect(objectStoreLeg.cleanup(ctx)).rejects.toThrow("ownership");
    expect(calls.every(call => call.startsWith("GetBucketTaggingCommand"))).toBe(true);
    expect(buckets.size).toBe(2);
  });
  it("cleans owned buckets across pages and is idempotent", async () => {
    await objectStoreLeg.seedSource(ctx); target();
    await objectStoreLeg.cleanup(ctx); await objectStoreLeg.cleanup(ctx);
    expect(buckets.size).toBe(0);
    expect(calls.filter(call => call.startsWith("DeleteObjectCommand"))).toHaveLength(9);
  });
  it("fails closed on incomplete pagination and missing readback metadata", async () => {
    target(); brokenPagination = true;
    await expect(objectStoreLeg.readTarget(ctx)).rejects.toThrow("pagination");
    brokenPagination = false;
    target().objects.get(`${ctx.runId}/a/empty.dat`)!.contentType = "";
    await expect(objectStoreLeg.readTarget(ctx)).rejects.toThrow("Incomplete");
  });
  it("requires explicit credentials and digest-pinned images", async () => {
    ctx.source.user = undefined;
    await expect(objectStoreLeg.seedSource(ctx)).rejects.toThrow("endpoint");
    expect(calls).toHaveLength(0);
    expect(() => objectStoreLeg.image({})).toThrow("digest");
    const image = `minio/minio@sha256:${"a".repeat(64)}`;
    expect(objectStoreLeg.image({ ZENITH_LOCAL_EXPORT_POSTGRES_IMAGE: image, ZENITH_LOCAL_EXPORT_MYSQL_IMAGE: image, ZENITH_LOCAL_EXPORT_MINIO_IMAGE: image })).toBe(image);
  });
});
