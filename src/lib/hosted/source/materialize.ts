/**
 * Put a validated source on disk so the recipe has a `root` to build.
 *
 * The materialized tree is the only thing a build runner ever mounts, so the
 * paths are checked a second time here, against the same rules the intake
 * used. Validation and writing are separated in time and possibly in process,
 * and a check that is cheap to repeat is worth repeating on the side that
 * actually creates files.
 *
 * The tree is written into a fresh `mkdtemp` directory under the OS temp
 * directory, never inside `ORRERY_DATA` and never inside the repository: it is
 * scratch space for one build and the caller removes it when the build ends.
 *
 * Workstream W2 (hosted R3).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostedError, type ValidatedSource } from "@/lib/hosted/contracts";
import { SOURCE_FIX, safeEntryPath } from "./tar";

/** Prefix of every materialized source directory, so strays are recognisable. */
export const MATERIALIZE_PREFIX = "zenith-src-";

/**
 * Write `source.files` into a fresh directory and return its absolute path.
 *
 * `into` is for callers that already own a directory (a runner staging a
 * container mount); it is created if missing and must be empty of anything the
 * caller cares about, because the files are written straight into it.
 *
 * Throws `unsupported_source` if any path fails re-validation, and leaves no
 * partial directory behind when it does.
 */
export function materializeSource(source: ValidatedSource, into?: string): string {
  const dir = into ?? fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), MATERIALIZE_PREFIX));
  if (into) fs.mkdirSync(into, { recursive: true });
  try {
    for (const file of source.files) {
      const safe = safeEntryPath(file.path, "file");
      if (!safe.ok)
        throw new HostedError("unsupported_source", "This source cannot be written to disk.", {
          fix: SOURCE_FIX,
          details: { reasons: [safe.reason] },
        });
      const target = path.join(dir, ...safe.path.split("/"));
      // Belt and braces: a path that escaped the checks above must not escape
      // the directory either. `path.relative` answers with the real resolution.
      const relative = path.relative(dir, target);
      if (relative.startsWith("..") || path.isAbsolute(relative))
        throw new HostedError("unsupported_source", "This source cannot be written to disk.", {
          fix: SOURCE_FIX,
          details: { reasons: [`${file.path}: the path resolves outside the source root. Remove the entry.`] },
        });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.bytes);
    }
  } catch (err) {
    if (!into) removeMaterialized(dir);
    throw err;
  }
  return dir;
}

/**
 * Remove a directory `materializeSource` created. Best effort and idempotent:
 * a build runner calls it in a `finally`, where throwing would hide the real
 * failure. Windows can hold a handle for a moment after a child exits, so the
 * removal is retried.
 */
export function removeMaterialized(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      const until = Date.now() + 50;
      while (Date.now() < until) {
        /* spin: this runs on the way out of a build, not in a request */
      }
    }
  }
}
