import https from "node:https";
import { S3Client, CreateBucketCommand, GetBucketTaggingCommand, PutBucketTaggingCommand, PutObjectCommand, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand, DeleteBucketCommand } from "@aws-sdk/client-s3";
import type { DataLeg, LegContext, LegEndpoint } from "./export-data-leg";
import { knownData, objectWitness, pinnedFixtureImages } from "./export-data-plan";

const ownerTag = "zenith-owner";
const prefix = (ctx: LegContext, tenant: "a" | "b") => `${ctx.runId}/${tenant}/`;
function clientFor(endpoint: LegEndpoint, ctx: LegContext): S3Client {
  knownData(ctx.runId, ctx.tenant);
  const url = new URL(endpoint.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || !endpoint.bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(endpoint.bucket)
    || !endpoint.user || !endpoint.password || !ctx.ownerLabel) throw new Error("Invalid owned object-store endpoint");
  return new S3Client({ endpoint: url.origin, region: "us-east-1", forcePathStyle: true,
    credentials: { accessKeyId: endpoint.user, secretAccessKey: endpoint.password },
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 60_000, httpsAgent: new https.Agent({ rejectUnauthorized: true }) },
  });
}
function missing(error: unknown): boolean {
  return (error as { name?: string })?.name === "NoSuchBucket";
}
async function owned(client: S3Client, endpoint: LegEndpoint, ctx: LegContext): Promise<void> {
  const result = await client.send(new GetBucketTaggingCommand({ Bucket: endpoint.bucket }));
  if (!result.TagSet?.some(tag => tag.Key === ownerTag && tag.Value === ctx.ownerLabel)) throw new Error("Object-store bucket ownership mismatch");
}
async function keys(client: S3Client, endpoint: LegEndpoint): Promise<string[]> {
  const result: string[] = [];
  const seen = new Set<string>();
  let token: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: endpoint.bucket, ContinuationToken: token }));
    for (const object of page.Contents ?? []) {
      if (object.Key === undefined || result.includes(object.Key)) throw new Error("Invalid object-store listing");
      result.push(object.Key);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && (!token || seen.has(token))) throw new Error("Invalid object-store pagination");
    if (token) seen.add(token);
  } while (token);
  return result;
}
async function withClient<T>(endpoint: LegEndpoint, ctx: LegContext, action: (client: S3Client) => Promise<T>): Promise<T> {
  const client = clientFor(endpoint, ctx);
  try { return await action(client); } finally { client.destroy(); }
}

/** Source seeding and independent target readback only; product export/import runs elsewhere.
 * The orchestrator provisions the target bucket with the zenith-owner tag before import.
 */
export const objectStoreLeg: DataLeg = {
  kind: "object_store",
  image: env => pinnedFixtureImages(env).object_store,
  seedSource: ctx => withClient(ctx.source, ctx, async client => {
    try { await owned(client, ctx.source, ctx); }
    catch (error) {
      if (!missing(error)) throw error;
      await client.send(new CreateBucketCommand({ Bucket: ctx.source.bucket }));
      await client.send(new PutBucketTaggingCommand({ Bucket: ctx.source.bucket, Tagging: { TagSet: [{ Key: ownerTag, Value: ctx.ownerLabel }] } }));
    }
    await owned(client, ctx.source, ctx);
    for (const tenant of ["a", "b"] as const) for (const object of knownData(ctx.runId, tenant).objects) {
      await client.send(new PutObjectCommand({ Bucket: ctx.source.bucket, Key: prefix(ctx, tenant) + object.key, Body: object.bytes, ContentType: object.contentType }));
    }
    return objectWitness(knownData(ctx.runId, ctx.tenant).objects);
  }),
  readTarget: ctx => withClient(ctx.target, ctx, async client => {
    await owned(client, ctx.target, ctx);
    const root = prefix(ctx, ctx.tenant);
    const objects = [];
    for (const key of await keys(client, ctx.target)) {
      if (!key.startsWith(root)) throw new Error("Foreign object in target bucket");
      const object = await client.send(new GetObjectCommand({ Bucket: ctx.target.bucket, Key: key }));
      if (!object.Body || !object.ContentType) throw new Error("Incomplete object-store readback");
      objects.push({ key: key.slice(root.length), bytes: Buffer.from(await object.Body.transformToByteArray()), contentType: object.ContentType });
    }
    return objectWitness(objects);
  }),
  assertNoForeignTenant: ctx => withClient(ctx.target, ctx, async client => {
    await owned(client, ctx.target, ctx);
    if ((await keys(client, ctx.target)).some(key => !key.startsWith(prefix(ctx, ctx.tenant)))) throw new Error("Foreign object in target bucket");
  }),
  cleanup: async ctx => {
    for (const endpoint of [ctx.source, ctx.target]) await withClient(endpoint, ctx, async client => {
      try { await owned(client, endpoint, ctx); } catch (error) { if (missing(error)) return; throw error; }
      for (const key of await keys(client, endpoint)) await client.send(new DeleteObjectCommand({ Bucket: endpoint.bucket, Key: key }));
      await client.send(new DeleteBucketCommand({ Bucket: endpoint.bucket }));
    });
  },
};
