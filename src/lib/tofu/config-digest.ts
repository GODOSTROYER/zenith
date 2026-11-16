/**
 * `configDigest` and `lockDigest` — the workspace identity rule shared with the
 * Go runner (docs/platform/RUNNER-PROTOCOL.md, `tofu.run`):
 *
 *   configDigest = hex( sha256( concat over files sorted by path of
 *                               path ‖ 0x00 ‖ hex(sha256(content)) ‖ 0x0A ) )
 *
 * `path` is the relative, forward-slash path exactly as sent; `content` is the
 * file's bytes (the strings in `TofuFile` are UTF-8); the hex digests are
 * lowercase. Files are sorted by byte order of the path — paths are restricted
 * to ASCII (`isSafeRelativePath`) so UTF-16 code-unit order (JS) and byte order
 * (Go's `sort.Strings`) are the same order. The lockfile is NOT part of it;
 * `lockDigest` is `hex(sha256(lockfile bytes))`.
 *
 * `tests/tofu/fixtures/config-digest-vector.json` pins this rule with a golden
 * vector the Go runner tests against too.
 */
import { createHash } from "node:crypto";
import { sha256Hex } from "@/lib/controlplane/digest";
import type { TofuFile } from "@/lib/tofu/types";

export const LOCKFILE_NAME = ".terraform.lock.hcl";
export const MAX_WORKSPACE_FILE_BYTES = 8 * 1024 * 1024;

const SAFE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** Relative, ASCII, forward-slash, no `.`/`..` segments, not the lockfile. */
export function isSafeRelativePath(p: string): boolean {
  if (p.length === 0 || p.length > 200 || !SAFE_PATH.test(p)) return false;
  if (p.split("/").some((seg) => seg === "." || seg === "..")) return false;
  if (p === LOCKFILE_NAME || p.split("/").includes(".terraform")) return false;
  return true;
}

export function configDigestOf(files: readonly TofuFile[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const h = createHash("sha256");
  for (const f of sorted) {
    h.update(f.path, "utf8");
    h.update(Buffer.from([0]));
    h.update(sha256Hex(f.content), "utf8");
    h.update(Buffer.from([0x0a]));
  }
  return h.digest("hex");
}

export function lockDigestOf(lockfile: string): string {
  return sha256Hex(lockfile);
}
