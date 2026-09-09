/** Filesystem helpers shared across the hosted subsystem. */
import fs from "node:fs";

/**
 * Best-effort recursive removal; used for scratch directories only.
 *
 * Retries a handful of times because a just-closed handle on Windows can hold
 * a directory briefly, and a scratch directory that outlives one attempt is
 * never a reason to fail the operation that produced it.
 */
export function removeQuietly(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      const until = Date.now() + 50;
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
}
