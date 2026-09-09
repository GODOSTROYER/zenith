/**
 * The one hashing rule the hosted subsystem uses.
 *
 * Every content identity in hosted — a source tree, an artifact, a backup
 * bundle, a publish intent, a stored token — is a SHA-256 taken here, so the
 * formula lives in one file and cannot drift between the places that compare
 * digests to each other.
 */
import crypto from "node:crypto";

/** SHA-256 hex of a buffer — the per-file checksum and the payload digest. */
export const sha256 = (bytes: Buffer): string => crypto.createHash("sha256").update(bytes).digest("hex");

/** SHA-256 hex of a string, hashed as UTF-8. */
export const sha256Hex = (text: string): string => crypto.createHash("sha256").update(text, "utf8").digest("hex");

/** Byte-wise path order, so a digest never depends on a locale collation. */
export const byPath = (a: { path: string }, b: { path: string }): number =>
  Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8"));

/** The NUL separator between a path and its hash inside a tree digest. */
const SEPARATOR = String.fromCharCode(0);

/**
 * The tree identity shared by the source digest and the artifact digest.
 *
 * `treeDigest(entries)` = SHA-256, hex, of the concatenation, over every entry
 * sorted byte-wise by path, of:
 *
 *     <path> + NUL + <sha256-hex of that file's bytes> + "\n"
 *
 * Only paths and content decide it: entry order, timestamps, permissions and
 * any archive framing do not.
 */
export function treeDigest(entries: { path: string; sha256: string }[]): string {
  const outer = crypto.createHash("sha256");
  for (const entry of [...entries].sort(byPath)) outer.update(`${entry.path}${SEPARATOR}${entry.sha256}\n`, "utf8");
  return outer.digest("hex");
}
