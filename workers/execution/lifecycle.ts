/**
 * Process lifecycle for the execution worker: graceful shutdown on SIGTERM /
 * SIGINT. Kept out of worker.ts so it can be unit-tested with a fake process.
 *
 * First signal: stop polling and drain (`worker.shutdown()`): running activities
 * get ZENITH_WORKER_SHUTDOWN_GRACE_MS to finish, then are cancelled. A second
 * signal gives up on draining and exits 1 at once, so an operator's second
 * Ctrl+C (or an orchestrator's SIGKILL escalation) is never blocked by a stuck
 * activity.
 *
 * Platform note: Windows cannot deliver SIGTERM to a Node process (the OS
 * terminates it outright), so on Windows only Ctrl+C reaches these handlers.
 * The container image runs on Linux, where both do.
 */

import type { EventEmitter } from "node:events";

export interface ShutdownTarget {
  shutdown(): void;
}

export interface ShutdownOptions {
  worker: ShutdownTarget;
  graceMs: number;
  log: (level: "info" | "error", msg: string, fields?: Record<string, unknown>) => void;
  /** `process` in production; a fake in tests */
  signals: Pick<EventEmitter, "on">;
  exit: (code: number) => void;
}

/** Register the handlers; returns a function that reports whether a shutdown has begun. */
export function installShutdownHandlers({ worker, graceMs, log, signals, exit }: ShutdownOptions): () => boolean {
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) {
      log("error", "second signal: exiting immediately", { signal });
      exit(1);
      return;
    }
    stopping = true;
    log("info", "shutdown requested: draining", { signal, graceMs });
    worker.shutdown();
  };
  signals.on("SIGTERM", () => stop("SIGTERM"));
  signals.on("SIGINT", () => stop("SIGINT"));
  return () => stopping;
}
