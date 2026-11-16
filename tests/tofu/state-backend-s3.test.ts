/**
 * PROD-DUR-06: the S3 state adapter contract against a scripted in-memory versioned bucket. The bucket is a fake: this proves
 * the adapter's request/response handling, the compare-and-set and readback logic and the absence of any delete command.
 * It does not prove behaviour against real S3 (unproved without a live account).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as sdk from "@aws-sdk/client-s3";
import { S3StateStore, s3StoreFromSession } from "@/lib/tofu/state-backend-s3";
import { openStateStoreFromSession } from "@/lib/tofu/state-backend-open";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const KEY = "zenith/ws_1/env_1/terraform.tfstate";

/** A minimal versioned bucket honoring the commands the adapter uses. */
function bucket(opts: { versioning?: "Enabled" | "Suspended" | undefined; lock?: boolean; sse?: string | undefined } = {}) {
  const versions: { id: string; bytes: Buffer; etag: string }[] = [
    { id: "v1", bytes: Buffer.from('{"serial":1}'), etag: '"e1"' },
    { id: "v2", bytes: Buffer.from('{"serial":2}'), etag: '"e2"' },
  ];
  const commands: string[] = [];
  let counter = 2;
  const notFound = (status = 404) => Object.assign(new Error("nf"), { name: "NotFound", $metadata: { httpStatusCode: status } });
  const latest = () => versions[versions.length - 1];
  const client = {
    async send(command: unknown): Promise<unknown> {
      const name = (command as { constructor: { name: string } }).constructor.name;
      commands.push(name);
      const input = (command as { input: Record<string, unknown> }).input;
      switch (name) {
        case "GetBucketVersioningCommand": return opts.versioning ? { Status: opts.versioning } : {};
        case "HeadObjectCommand": {
          if (typeof input.Key === "string" && input.Key.endsWith(".tflock")) { if (opts.lock) return {}; throw notFound(); }
          const v = input.VersionId ? versions.find(x => x.id === input.VersionId) : latest();
          if (!v) throw notFound();
          return { VersionId: v.id, ETag: v.etag, ContentLength: v.bytes.length, ...(opts.sse === undefined ? { ServerSideEncryption: "AES256" } : opts.sse ? { ServerSideEncryption: opts.sse } : {}) };
        }
        case "GetObjectCommand": {
          const v = input.VersionId ? versions.find(x => x.id === input.VersionId) : latest();
          if (!v) throw Object.assign(new Error("nope"), { name: "NoSuchVersion", $metadata: { httpStatusCode: 404 } });
          return { VersionId: v.id, ETag: v.etag, ContentLength: v.bytes.length, Body: { transformToByteArray: async () => new Uint8Array(v.bytes) } };
        }
        case "ListObjectVersionsCommand":
          return { Versions: [...versions].reverse().map((v, i) => ({ Key: KEY, VersionId: v.id, IsLatest: i === 0, Size: v.bytes.length })).concat([{ Key: `${KEY}.other`, VersionId: "x", IsLatest: true, Size: 1 }]), IsTruncated: false };
        case "PutObjectCommand": {
          if (input.IfMatch !== latest().etag) throw Object.assign(new Error("pre"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
          counter += 1;
          versions.push({ id: `v${counter}`, bytes: Buffer.from(input.Body as Buffer), etag: `"e${counter}"` });
          return { VersionId: `v${counter}` };
        }
        default: throw new Error(`unexpected command ${name}`);
      }
    },
  };
  return { client, commands, versions };
}
const store = (b: ReturnType<typeof bucket>) => new S3StateStore(b.client, sdk, { bucket: "state-bucket", key: KEY });

describe("probe", () => {
  it("proves versioning, encryption, an absent lock and the current version", async () => {
    const b = bucket({ versioning: "Enabled" });
    expect(await store(b).probe()).toMatchObject({ versioning: "enabled", encryption: "sse_s3", lockObject: "absent", currentVersionId: "v2", restoreReady: true, refusals: [] });
  });
  it("is not ready when versioning is off, a lock is held or encryption is absent", async () => {
    expect((await store(bucket({ versioning: undefined })).probe())).toMatchObject({ versioning: "disabled", restoreReady: false });
    expect((await store(bucket({ versioning: "Suspended" })).probe())).toMatchObject({ versioning: "suspended", restoreReady: false });
    expect((await store(bucket({ versioning: "Enabled", lock: true })).probe())).toMatchObject({ lockObject: "present", restoreReady: false });
    expect((await store(bucket({ versioning: "Enabled", sse: "" })).probe())).toMatchObject({ encryption: "none", restoreReady: false });
  });
  it("treats an unreadable setting as unknown, never as ready", async () => {
    const b = bucket({ versioning: "Enabled" });
    const failing = { send: async (c: unknown) => { if ((c as { constructor: { name: string } }).constructor.name === "GetBucketVersioningCommand") throw new Error("denied"); return b.client.send(c); } };
    const verdict = await new S3StateStore(failing, sdk, { bucket: "state-bucket", key: KEY }).probe();
    expect(verdict.versioning).toBe("unknown");
    expect(verdict.restoreReady).toBe(false);
    expect(verdict.refusals.join(" ")).toMatch(/versioning could not be read/);
  });
});

describe("versions and reads", () => {
  it("lists only the exact state key", async () => {
    const versions = await store(bucket({ versioning: "Enabled" })).listVersions(10);
    expect(versions.map(v => v.versionId)).toEqual(["v2", "v1"]);
    expect(versions[0].isLatest).toBe(true);
  });
  it("reads a version with its digest and refuses an absent one", async () => {
    const s = store(bucket({ versioning: "Enabled" }));
    const read = await s.readVersion("v1");
    expect(read.sha256).toBe(sha(Buffer.from('{"serial":1}')));
    await expect(s.readVersion("missing")).rejects.toMatchObject({ code: "version_unavailable" });
  });
});

describe("restore writes a new version, compares and swaps, and never deletes", () => {
  it("restores an earlier version as the new current version with readback", async () => {
    const b = bucket({ versioning: "Enabled" }), s = store(b);
    const earlier = await s.readVersion("v1"), current = await s.readCurrent();
    const written = await s.writeRestored(earlier.bytes, { currentEtag: current.etag! });
    const readback = await s.readCurrent();
    expect(readback.versionId).toBe(written.versionId);
    expect(readback.sha256).toBe(earlier.sha256);
    expect(b.versions.map(v => v.id)).toEqual(["v1", "v2", written.versionId]);
    expect(b.commands.filter(c => /^Delete/.test(c))).toEqual([]);
  });
  it("refuses when the state changed after review and writes nothing", async () => {
    const b = bucket({ versioning: "Enabled" }), s = store(b);
    await expect(s.writeRestored(Buffer.from("{}"), { currentEtag: '"stale"' })).rejects.toMatchObject({ code: "state_changed" });
    expect(b.versions).toHaveLength(2);
  });
  it("maps a failed precondition at write time to state_changed and an unconfirmed write to write_unconfirmed", async () => {
    const b = bucket({ versioning: "Enabled" });
    const racing = { send: async (c: unknown) => {
      if ((c as { constructor: { name: string } }).constructor.name === "PutObjectCommand") { b.versions.push({ id: "v9", bytes: Buffer.from("x"), etag: '"e9"' }); }
      return b.client.send(c);
    } };
    await expect(new S3StateStore(racing, sdk, { bucket: "state-bucket", key: KEY }).writeRestored(Buffer.from("{}"), { currentEtag: '"e2"' })).rejects.toMatchObject({ code: "state_changed" });
    const broken = { send: async (c: unknown) => { if ((c as { constructor: { name: string } }).constructor.name === "PutObjectCommand") throw new Error("socket"); return b.client.send(c); } };
    const fresh = bucket({ versioning: "Enabled" });
    const brokenStore = new S3StateStore({ send: async (c: unknown) => (c as { constructor: { name: string } }).constructor.name === "PutObjectCommand" ? broken.send(c) : fresh.client.send(c) }, sdk, { bucket: "state-bucket", key: KEY });
    await expect(brokenStore.writeRestored(Buffer.from("{}"), { currentEtag: '"e2"' })).rejects.toMatchObject({ code: "write_unconfirmed" });
  });
});

describe("opening a store from a brokered session", () => {
  const backend = { kind: "s3" as const, bucket: "state-bucket" };
  it("builds the client from the session, in the backend's region, and uses no other credential source", async () => {
    const seen: { region?: string }[] = [];
    const b = bucket({ versioning: "Enabled" });
    const session = { client: <C,>(_ctor: new (config: Record<string, unknown>) => C, overrides?: { region?: string }): C => { seen.push(overrides ?? {}); return b.client as unknown as C; } };
    const store = await s3StoreFromSession(session, { ...backend, region: "eu-west-1" }, "us-east-1", KEY);
    expect((await store.probe()).versioning).toBe("enabled");
    expect(seen).toEqual([{ region: "eu-west-1" }]);
  });
  it("refuses backends it has no S3 adapter for, and sessions of the wrong provider", async () => {
    const session = { client: () => { throw new Error("must not be called"); } };
    await expect(s3StoreFromSession(session as never, { kind: "gcs", bucket: "state-bucket" }, "us-east-1", KEY)).rejects.toMatchObject({ code: "unsupported_backend" });
    await expect(s3StoreFromSession(session as never, { kind: "azurerm", storageAccountName: "acct", containerName: "state" }, "us-east-1", KEY)).rejects.toMatchObject({ code: "unsupported_backend" });
    await expect(s3StoreFromSession(session as never, { kind: "s3", bucket: "b", endpoint: "https://ns.compat.objectstorage.us-ashburn-1.oraclecloud.com" }, "us-ashburn-1", KEY)).rejects.toMatchObject({ code: "unsupported_backend" });
    await expect(openStateStoreFromSession({ provider: "gcp" } as never, backend, "us-east-1", KEY)).rejects.toMatchObject({ code: "unsupported_backend" });
    await expect(openStateStoreFromSession({ provider: "azure" } as never, { kind: "azurerm", storageAccountName: "acct", containerName: "state" }, "eastus", KEY)).rejects.toMatchObject({ code: "unsupported_backend" });
    await expect(openStateStoreFromSession({ provider: "aws" } as never, { kind: "gcs", bucket: "state-bucket" }, "us-east-1", KEY)).rejects.toMatchObject({ code: "unsupported_backend" });
  });
});

describe("no destructive backend operation exists in the recovery source", () => {  it("never imports or constructs a delete, lifecycle or lock-removal command", () => {
    for (const file of ["src/lib/tofu/state-backend-s3.ts", "src/lib/tofu/state-backend-gcs.ts", "src/lib/tofu/state-backend-open.ts", "src/lib/platform/state-recovery.ts", "src/lib/platform/state-session.ts", "src/lib/controlplane/db/repos/state-backend-recovery.ts"]) {
      const source = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(source, file).not.toMatch(/Delete(?:Object|Objects|Bucket|ObjectVersion)Command|PutBucketLifecycle|DeleteBucketLifecycle|force-unlock|forceUnlock/);
      expect(source, file).not.toMatch(/\bdelete from\b/i);
      expect(source, file).not.toContain('method: "DELETE"');
    }
  });
  it("takes provider credentials only from the brokered session path: no vault secret, key, token or SAS handling", () => {
    for (const file of ["src/lib/tofu/state-backend-s3.ts", "src/lib/tofu/state-backend-gcs.ts", "src/lib/tofu/state-backend-open.ts", "src/lib/platform/state-recovery.ts", "src/lib/platform/state-session.ts", "src/app/api/platform/v1/_lib/state-recovery.ts"]) {
      const source = readFileSync(path.join(process.cwd(), file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(source, file).not.toMatch(/readSecretValue|@\/lib\/secrets|isVaultRef|vault:|accessKeyId|secretAccessKey|privateKey|private_key|createSign|sasToken|oauth2\.googleapis|client_email/);
    }
    expect(readFileSync(path.join(process.cwd(), "src/app/api/platform/v1/_lib/state-recovery.ts"), "utf8")).toContain("platformCredentialBroker(db)");
  });
});
