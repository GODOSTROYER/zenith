/**
 * One isolated `ORRERY_DATA` directory per test file.
 *
 * Call `tempDataDir()` at module top level, BEFORE any `await import` of
 * application code: `@/lib/env` reads `ORRERY_DATA` on first use and the store
 * pins it on first import, so a directory set after that import is ignored and
 * the suite quietly shares the default data directory with every other suite.
 *
 *     const DATA = tempDataDir("orrery-roles-", { fast: true });
 *     const { db, resetDb } = await import("@/lib/db/store");
 *
 * `fs.realpathSync` on the tmpdir is deliberate and not cosmetic. On macOS
 * `os.tmpdir()` is a symlink (`/var` -> `/private/var`) and on Windows it can
 * be an 8.3 short path; code under test that compares a resolved path against
 * `ORRERY_DATA` sees two different strings for the same directory unless the
 * root is resolved first.
 *
 * Nothing here may import application code — this module is imported
 * statically, so it runs before the caller's `process.env` assignments would.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const created: string[] = [];
let cleanupRegistered = false;

/** Best-effort removal; Windows holds SQLite/file handles briefly, so retry. */
function removeQuietly(dir: string): void {
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      const until = Date.now() + 50;
      while (Date.now() < until) {
        /* spin — `exit` handlers must be synchronous */
      }
    }
  }
}

function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.on("exit", () => {
    for (const dir of created) {
      try {
        removeQuietly(dir);
      } catch {
        /* never let cleanup change the exit code */
      }
    }
  });
}

export interface TempDataOptions {
  /** Also set `ORRERY_FAST=1`, which collapses step budgets and backoff. */
  fast?: boolean;
}

/**
 * Create a fresh temp directory, point `ORRERY_DATA` at it, and return it.
 * The directory is removed when the process exits.
 */
export function tempDataDir(prefix: string, opts: TempDataOptions = {}): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  process.env.ORRERY_DATA = dir;
  if (opts.fast) process.env.ORRERY_FAST = "1";
  created.push(dir);
  registerCleanup();
  return dir;
}
