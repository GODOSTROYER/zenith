/**
 * Object-store export, import and readback (`s3-objects-v1`) over the small
 * `ObjectStorePort`. Every object body is copied byte for byte and hashed; the
 * artifact is one file per object (`objects/<sha256 of the key>`) plus an index
 * (`objects.json`) mapping keys to digests, so it is readable without Zenith.
 *
 * Not carried, and said so in the matrix: user metadata, tags, versions, ACLs
 * and lifecycle rules. Content type is.
 *
 * The logical digest is the sorted list of (key, sha256, bytes, contentType),
 * recomputed by `readbackObjects` from the live store: that is the independent
 * verification of a restore.
 */
import { createHash } from "node:crypto";
import { digest } from "@/lib/controlplane/digest";
import { DEFAULT_LIMITS, PortabilityError, type EmitFile, type EngineExport, type EngineLimits, type EngineReadback, type ObjectStorePort } from "../types";

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

export interface ObjectEntry { key: string; sha256: string; bytes: number; contentType: string | null; file: string }

const RESTORE_TEXT = [
  "# Restoring this export",
  "",
  "This is a Zenith object-store export. Everything in it is readable without Zenith.",
  "",
  "- `objects.json` lists every object: its key, size, SHA-256, content type and the file that holds its bytes.",
  "- `objects/<file>` is the object body, exactly as it was stored.",
  "- To restore, upload each file to its key in an EMPTY bucket (any S3-compatible store) with the listed content type, then compare sizes and SHA-256 digests.",
  "- `manifest.json` lists every file of this export with its SHA-256; verify them before restoring.",
  "",
].join("\n");

async function readAll(store: ObjectStorePort, limits: EngineLimits): Promise<ObjectEntry[]> {
  const listing = await store.list("");
  if (listing.length > limits.maxObjects) {
    throw new PortabilityError("limit_exceeded", `The bucket holds more than the export limit (${limits.maxObjects} objects); it was not exported.`);
  }
  return listing.map((o) => ({ key: o.key, sha256: "", bytes: o.size, contentType: null, file: `objects/${sha(o.key)}` }));
}

/** Digest of the logical content: independent of file names and listing order. */
export function objectsDigest(entries: readonly Pick<ObjectEntry, "key" | "sha256" | "bytes" | "contentType">[]): string {
  const rows = entries.map((e) => ({ key: e.key, sha256: e.sha256, bytes: e.bytes, contentType: e.contentType })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return digest({ v: 1, objects: rows });
}

async function fingerprint(store: ObjectStorePort, limits: EngineLimits, keepBodies: (entry: ObjectEntry, bytes: Buffer) => Promise<void>): Promise<ObjectEntry[]> {
  const entries = await readAll(store, limits);
  let total = 0;
  for (const entry of entries) {
    const got = await store.get(entry.key);
    if (!got) throw new PortabilityError("verification_failed", "An object listed in the store could not be read back; the store changed while it was read.");
    if (got.bytes.length > limits.maxObjectBytes) throw new PortabilityError("limit_exceeded", `An object is larger than the export limit (${Math.floor(limits.maxObjectBytes / 1048576)} MiB); the bucket was not exported.`);
    total += got.bytes.length;
    if (total > limits.maxBytes) throw new PortabilityError("limit_exceeded", `The bucket holds more than the export limit (${Math.floor(limits.maxBytes / 1048576)} MiB); it was not exported.`);
    entry.sha256 = sha(got.bytes);
    entry.bytes = got.bytes.length;
    entry.contentType = got.contentType ?? null;
    await keepBodies(entry, got.bytes);
  }
  return entries;
}

export async function exportObjects(store: ObjectStorePort, emit: EmitFile, opts: { limits?: EngineLimits } = {}): Promise<EngineExport> {
  const entries = await fingerprint(store, opts.limits ?? DEFAULT_LIMITS, (entry, bytes) => emit(entry.file, bytes));
  await emit("objects.json", Buffer.from(JSON.stringify({ v: 1, objects: entries }, null, 2), "utf8"));
  await emit("RESTORE.md", Buffer.from(RESTORE_TEXT, "utf8"));
  return { contentDigest: objectsDigest(entries), coverage: { objects: entries.length, bytes: entries.reduce((n, e) => n + e.bytes, 0) }, restore: RESTORE_TEXT };
}

export async function readbackObjects(store: ObjectStorePort, opts: { limits?: EngineLimits } = {}): Promise<EngineReadback> {
  const entries = await fingerprint(store, opts.limits ?? DEFAULT_LIMITS, async () => undefined);
  return { contentDigest: objectsDigest(entries), coverage: { objects: entries.length, bytes: entries.reduce((n, e) => n + e.bytes, 0) } };
}

export async function isObjectStoreEmpty(store: ObjectStorePort): Promise<boolean> {
  return (await store.list("")).length === 0;
}

export async function importObjects(target: ObjectStorePort, read: (name: string) => Promise<Buffer>, opts: { limits?: EngineLimits } = {}): Promise<{ objects: number; bytes: number }> {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  let index: { v?: unknown; objects?: unknown };
  try {
    index = JSON.parse((await read("objects.json")).toString("utf8")) as typeof index;
  } catch {
    throw new PortabilityError("artifact_invalid", "The export's objects.json is not readable.");
  }
  if (index.v !== 1 || !Array.isArray(index.objects) || index.objects.length > limits.maxObjects) throw new PortabilityError("artifact_invalid", "The export's objects.json has an unknown shape.");
  const entries = (index.objects as Record<string, unknown>[]).map((o): ObjectEntry => {
    if (typeof o.key !== "string" || o.key.length === 0 || o.key.length > 1024 || typeof o.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(o.sha256) || typeof o.bytes !== "number" || !Number.isInteger(o.bytes) || o.bytes < 0 ||
        typeof o.file !== "string" || !/^objects\/[0-9a-f]{64}$/.test(o.file) || (o.contentType !== null && typeof o.contentType !== "string")) {
      throw new PortabilityError("artifact_invalid", "The export's objects.json lists a malformed object.");
    }
    return { key: o.key, sha256: o.sha256, bytes: o.bytes, file: o.file, contentType: o.contentType as string | null };
  });
  if (new Set(entries.map((e) => e.key)).size !== entries.length) throw new PortabilityError("artifact_invalid", "The export's objects.json lists a key twice.");
  if (!(await isObjectStoreEmpty(target))) throw new PortabilityError("target_not_empty", "The target bucket already holds objects. Restores go into a new, empty bucket and never merge into existing data.");
  let bytes = 0;
  for (const e of entries) {
    const body = await read(e.file);
    if (body.length !== e.bytes || sha(body) !== e.sha256) throw new PortabilityError("digest_mismatch", "An object in the export does not match its recorded digest; nothing further was restored.");
    await target.put(e.key, body, e.contentType ?? undefined);
    bytes += body.length;
  }
  return { objects: entries.length, bytes };
}
