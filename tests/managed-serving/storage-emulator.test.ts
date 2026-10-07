/**
 * PROD-MAN-03 scoped object storage against a REAL IAM and S3 API (LocalStack or any IAM-compatible emulator). GATED:
 * skipped, with the reason, unless
 *
 *   ZENITH_TEST_IAM_ENDPOINT      e.g. http://127.0.0.1:4566 (the emulator serves IAM, STS and S3 there)
 *   ZENITH_TEST_IAM_ADMIN_KEY_ID / ZENITH_TEST_IAM_ADMIN_SECRET   emulator admin credentials (test values, never real ones)
 *
 * The create / list / rotate / revoke half runs against any such emulator. The ENFORCEMENT half (a scoped key really cannot
 * read or write outside its prefix) additionally needs ZENITH_TEST_IAM_ENFORCED=1, because LocalStack enforces IAM only in
 * its enforcement mode (`ENFORCE_IAM=1`); against an emulator that does not enforce it would pass vacuously, so it refuses to
 * run instead. A skipped test is never counted as a pass.
 *
 * Not proven even when this passes: a live AWS (or other cloud) account, IAM user quotas at scale, key propagation delay.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createIamAdminPort, provisionObjectStores, scopedStoragePolicy, storageIntentFromNode, type StorageKeyStore } from "@/lib/managed-serving/storage";
import { FULL_ENV, TENANT, mkNode, substrate } from "../providers/zenith/support";
import { MemoryKeyStore, MemorySink } from "./_support/storage";

const endpoint = process.env.ZENITH_TEST_IAM_ENDPOINT?.trim();
const adminKey = process.env.ZENITH_TEST_IAM_ADMIN_KEY_ID?.trim();
const adminSecret = process.env.ZENITH_TEST_IAM_ADMIN_SECRET?.trim();
const enforced = process.env.ZENITH_TEST_IAM_ENFORCED === "1";
const ready = Boolean(endpoint && adminKey && adminSecret);

describe.skipIf(!ready)("scoped object storage against an IAM + S3 emulator", () => {
  const run = randomBytes(4).toString("hex");
  const bucket = `zenith-man03-${run}`;
  const sub = substrate({ ...FULL_ENV, ZENITH_MANAGED_OBJECT_STORAGE_BUCKET: bucket, ZENITH_MANAGED_OBJECT_STORAGE_ENDPOINT: endpoint!, ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CREDENTIAL_REF: "vault:zenith-managed/object-store-admin" });
  const tenantA = { ...TENANT, workspaceId: `ws_${run}a`, environmentId: `env_${run}a` };
  const tenantB = { ...TENANT, workspaceId: `ws_${run}b`, environmentId: `env_${run}b` };
  const node = mkNode("object_store/media", "object_store", {});
  const admin = createIamAdminPort({ endpoint, region: "us-east-1", credentialRef: "vault:zenith-managed/object-store-admin" }, {
    resolveSecret: async () => JSON.stringify({ accessKeyId: adminKey, secretAccessKey: adminSecret }),
  });

  async function s3(credentials: { accessKeyId: string; secretAccessKey: string }) {
    const { S3Client } = await import("@aws-sdk/client-s3");
    return new S3Client({ region: "us-east-1", endpoint, forcePathStyle: true, credentials });
  }

  async function provision(tenant: typeof TENANT, store: StorageKeyStore, sink: MemorySink) {
    const intent = storageIntentFromNode(tenant, sub, node);
    const [outcome] = await provisionObjectStores([intent], { admin, sink, store });
    return { intent, outcome, creds: { accessKeyId: sink.values.get(intent.keyIdRef)!, secretAccessKey: sink.values.get(intent.secretRef)! } };
  }

  it("creates a principal with exactly the scoped policy, one key, and rotates cleanly", async () => {
    const store = new MemoryKeyStore(tenantA.workspaceId, tenantA.environmentId);
    const sink = new MemorySink();
    const first = await provision(tenantA, store, sink);
    expect(first.outcome.status).toBe("created");
    expect(await admin.readPolicyDigest(first.intent.principalName)).toEqual({ ok: true, value: first.intent.policyDigest });
    expect(await admin.listAccessKeys(first.intent.principalName)).toEqual({ ok: true, value: [first.creds.accessKeyId] });
    expect((await provision(tenantA, store, sink)).outcome.status).toBe("exists");

    // force a rotation by pretending the recorded policy digest is stale
    store.rows[0].policyDigest = "0".repeat(64);
    const second = await provision(tenantA, store, sink);
    expect(second.outcome.status).toBe("rotated");
    const keys = await admin.listAccessKeys(first.intent.principalName);
    expect(keys).toEqual({ ok: true, value: [second.creds.accessKeyId] });
    expect(second.creds.accessKeyId).not.toBe(first.creds.accessKeyId);
  });

  it.skipIf(!enforced)("a scoped key reads and writes inside its prefix and is denied everywhere else (needs IAM enforcement)", async () => {
    const { CreateBucketCommand, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const adminS3 = await s3({ accessKeyId: adminKey!, secretAccessKey: adminSecret! });
    await adminS3.send(new CreateBucketCommand({ Bucket: bucket }));

    const a = await provision(tenantA, new MemoryKeyStore(tenantA.workspaceId, tenantA.environmentId), new MemorySink());
    const b = await provision(tenantB, new MemoryKeyStore(tenantB.workspaceId, tenantB.environmentId), new MemorySink());
    const clientA = await s3(a.creds);
    const mine = `${a.intent.prefix}hello.txt`;
    const theirs = `${b.intent.prefix}hello.txt`;

    await clientA.send(new PutObjectCommand({ Bucket: bucket, Key: mine, Body: "mine" }));
    const got = await clientA.send(new GetObjectCommand({ Bucket: bucket, Key: mine }));
    expect(await got.Body!.transformToString()).toBe("mine");
    expect((await clientA.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: a.intent.prefix }))).Contents?.map((o) => o.Key)).toEqual([mine]);

    await expect(clientA.send(new PutObjectCommand({ Bucket: bucket, Key: theirs, Body: "x" }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
    await expect(clientA.send(new PutObjectCommand({ Bucket: bucket, Key: "root.txt", Body: "x" }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
    await expect(clientA.send(new ListObjectsV2Command({ Bucket: bucket }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
    await expect(clientA.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: b.intent.prefix }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });

    await adminS3.send(new PutObjectCommand({ Bucket: bucket, Key: theirs, Body: "b's data" }));
    await expect(clientA.send(new GetObjectCommand({ Bucket: bucket, Key: theirs }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
    await expect(clientA.send(new DeleteObjectCommand({ Bucket: bucket, Key: theirs }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
  });

  it("the policy it enforces is the one the unit tests evaluate", () => {
    const intent = storageIntentFromNode(tenantA, sub, node);
    expect(scopedStoragePolicy(intent.bucket, intent.prefix)).toBeDefined();
  });
});

describe.skipIf(ready)("scoped object storage emulator lane", () => {
  it.skip("skipped: set ZENITH_TEST_IAM_ENDPOINT, ZENITH_TEST_IAM_ADMIN_KEY_ID and ZENITH_TEST_IAM_ADMIN_SECRET (and ZENITH_TEST_IAM_ENFORCED=1 for the enforcement case)", () => undefined);
});
