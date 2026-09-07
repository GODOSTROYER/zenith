/**
 * The `ZBK1` container: a manifest and a list of files, in one buffer.
 *
 * Why not tar or zip. A backup has to be readable by a restore that may be the
 * only thing standing between an install and losing everything, on a host that
 * has just been rebuilt. A format with 20 lines of parser and no dependency
 * can be re-implemented from this comment in an afternoon; a format that needs
 * a library needs that library to still exist and still be installable. The
 * bytes are compressed by nothing and encrypted by `crypto.ts`, which is where
 * the interesting properties live.
 *
 * Layout, little-endian throughout:
 *
 *     magic          4 bytes    "ZBK1"
 *     version        1 byte     0x01
 *     manifestLen    4 bytes    uint32
 *     manifest       manifestLen bytes, UTF-8 JSON (a `BackupManifest`)
 *     then, for each file, in manifest order:
 *       nameLen      2 bytes    uint16
 *       name         nameLen bytes, UTF-8, forward slashes, relative
 *       contentLen   8 bytes    BigUint64
 *       content      contentLen bytes
 *
 * The manifest lists every file with its own SHA-256 and byte length, so a
 * reader can check each one independently of the container and of the outer
 * authentication tag. Both checks run on restore: the tag proves the bundle is
 * the one that was sealed, the per-file hashes prove the reader assembled it
 * back correctly.
 *
 * Workstream W8 (hosted R3).
 */
import crypto from "node:crypto";
import { HostedError, type BackupManifest } from "@/lib/hosted/contracts";

const MAGIC = Buffer.from("ZBK1", "ascii");
const VERSION = 1;

/** One file inside a bundle. `name` is relative with forward slashes. */
export interface BundleFile {
  name: string;
  bytes: Buffer;
}

/** A manifest before the outer digest and size are known. */
export type DraftManifest = Omit<BackupManifest, "digest" | "byteSize">;

/** SHA-256 hex of a buffer — the per-file checksum and the payload digest. */
export const sha256 = (bytes: Buffer): string => crypto.createHash("sha256").update(bytes).digest("hex");

/** Names are relative, slash separated and free of traversal. Enforced on both sides. */
const NAME_RE = /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;

function assertName(name: string): string {
  if (!NAME_RE.test(name))
    throw new HostedError("invalid_input", `"${name}" is not a usable name inside a backup bundle.`, {
      fix: "Bundle entries are relative paths of letters, digits, dot, dash, underscore and slash — for example control.sqlite or apps/<id>/data.sqlite.",
    });
  return name;
}

/**
 * Pack a manifest and its files.
 *
 * The manifest's `files` table is written from the files themselves, so the
 * two can never disagree: a caller supplies the bytes and the container hashes
 * them.
 */
export function packBundle(draft: Omit<DraftManifest, "files">, files: BundleFile[]): {
  bytes: Buffer;
  files: BackupManifest["files"];
} {
  const table: BackupManifest["files"] = files.map((file) => ({
    name: assertName(file.name),
    sha256: sha256(file.bytes),
    bytes: file.bytes.length,
  }));
  const manifest = JSON.stringify({ ...draft, files: table });
  const manifestBytes = Buffer.from(manifest, "utf8");

  const header = Buffer.alloc(MAGIC.length + 1 + 4);
  MAGIC.copy(header, 0);
  header.writeUInt8(VERSION, MAGIC.length);
  header.writeUInt32LE(manifestBytes.length, MAGIC.length + 1);

  const parts: Buffer[] = [header, manifestBytes];
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const prefix = Buffer.alloc(2 + 8);
    prefix.writeUInt16LE(name.length, 0);
    prefix.writeBigUInt64LE(BigInt(file.bytes.length), 2);
    parts.push(prefix, name, file.bytes);
  }
  return { bytes: Buffer.concat(parts), files: table };
}

/** What a reader gets back: the manifest as written, and the files it names. */
export interface UnpackedBundle {
  manifest: BackupManifest;
  files: BundleFile[];
}

/**
 * Unpack a bundle and check every checksum it carries.
 *
 * Refuses rather than returns partial content: a bundle whose file table does
 * not match its bytes is not a backup that can be restored, and handing back
 * "most of it" is how a restore ends up with an authority missing an app.
 */
export function unpackBundle(bytes: Buffer): UnpackedBundle {
  if (bytes.length < MAGIC.length + 5 || !bytes.subarray(0, MAGIC.length).equals(MAGIC))
    throw malformed("it does not start with the ZBK1 header");
  const version = bytes.readUInt8(MAGIC.length);
  if (version !== VERSION) throw malformed(`it is container version ${version} and this build reads version ${VERSION}`);

  const manifestLength = bytes.readUInt32LE(MAGIC.length + 1);
  let offset = MAGIC.length + 5;
  if (offset + manifestLength > bytes.length) throw malformed("its manifest runs past the end of the file");
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(bytes.subarray(offset, offset + manifestLength).toString("utf8")) as BackupManifest;
  } catch {
    throw malformed("its manifest is not readable JSON");
  }
  offset += manifestLength;

  const files: BundleFile[] = [];
  while (offset < bytes.length) {
    if (offset + 10 > bytes.length) throw malformed("a file entry is truncated");
    const nameLength = bytes.readUInt16LE(offset);
    const contentLength = Number(bytes.readBigUInt64LE(offset + 2));
    offset += 10;
    if (offset + nameLength + contentLength > bytes.length) throw malformed("a file entry runs past the end of the file");
    const name = bytes.subarray(offset, offset + nameLength).toString("utf8");
    offset += nameLength;
    const content = bytes.subarray(offset, offset + contentLength);
    offset += contentLength;
    files.push({ name: assertName(name), bytes: Buffer.from(content) });
  }

  const listed = new Map((manifest.files ?? []).map((file) => [file.name, file]));
  if (listed.size !== files.length)
    throw malformed(`its manifest lists ${listed.size} files and it carries ${files.length}`);
  for (const file of files) {
    const entry = listed.get(file.name);
    if (!entry) throw malformed(`it carries ${file.name}, which its manifest does not list`);
    if (entry.bytes !== file.bytes.length)
      throw malformed(`${file.name} is ${file.bytes.length} bytes and its manifest records ${entry.bytes}`);
    const actual = sha256(file.bytes);
    if (actual !== entry.sha256)
      throw malformed(`${file.name} hashes to ${actual} and its manifest records ${entry.sha256}`);
  }
  return { manifest, files };
}

function malformed(why: string): HostedError {
  return new HostedError("invalid_input", `That backup bundle cannot be read: ${why}.`, {
    fix: "Restore a different backup. A bundle that fails its own checksums is not repairable — its contents are not what was written.",
  });
}
