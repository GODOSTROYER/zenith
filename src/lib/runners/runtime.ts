/**
 * Process wiring of the runner plane: which store, signer, result sealer,
 * event sink and clock the routes and `dispatch.ts` use.
 *
 * Nothing is guessed in production:
 *  - store   — the platform control-store adapter must be registered with
 *              `configureRunnerRuntime({ store })` at boot. Outside production
 *              a process-wide in-memory store is the default; in production it
 *              is used only when `ZENITH_RUNNER_STORE=memory` says so (a single
 *              long-lived host, never serverless).
 *  - signer  — `ZENITH_CONTROL_SIGNING_JWK` (or an injected KMS-backed signer).
 *  - sealer  — `ZENITH_RUNNER_RESULT_KEY`, else derived from the signing JWK.
 * A missing piece is a `RunnerConfigError` (HTTP 503 `runner_plane_unconfigured`).
 */
import { createMemoryRunnerStore } from "@/lib/runners/memory-store";
import type { RunnerEventSink, RunnerStore } from "@/lib/runners/ports";
import { createResultSealerFromEnv, type ResultSealer } from "@/lib/runners/seal";
import { createControlSignerFromEnv, type ControlSigner } from "@/lib/runners/signing";
import { POLL_STEP_MS, RunnerConfigError } from "@/lib/runners/types";

export interface RunnerRuntime {
  store: RunnerStore;
  signer: ControlSigner;
  sealer: ResultSealer;
  events: RunnerEventSink;
  /** epoch milliseconds (must be the same clock the store uses when tests fake it) */
  now(): number;
  /** wait `ms`, rejecting with an AbortError when `signal` aborts */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** long-poll / await polling step */
  pollStepMs: number;
}

export function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function abortError(): Error {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
}

const noopEvents: RunnerEventSink = { emit: () => undefined };

type G = typeof globalThis & { __zenithRunnerMemoryStore?: RunnerStore; __zenithRunnerEnvCache?: { key: string; signer: ControlSigner; sealer: ResultSealer } };

let override: Partial<RunnerRuntime> = {};

/** Register the production adapters at boot, or fakes in tests. Replaces any earlier override. */
export function configureRunnerRuntime(next: Partial<RunnerRuntime>): void {
  override = { ...next };
}

export function resetRunnerRuntime(): void {
  override = {};
  const g = globalThis as G;
  delete g.__zenithRunnerEnvCache;
}

function defaultStore(): RunnerStore {
  const g = globalThis as G;
  if (process.env.NODE_ENV === "production" && process.env.ZENITH_RUNNER_STORE !== "memory")
    throw new RunnerConfigError("The runner plane has no platform-store adapter registered (configureRunnerRuntime({ store })); refusing to fall back to memory in production.");
  return (g.__zenithRunnerMemoryStore ??= createMemoryRunnerStore());
}

function envCrypto(): { signer: ControlSigner; sealer: ResultSealer } {
  const g = globalThis as G;
  const key = `${process.env.ZENITH_CONTROL_SIGNING_JWK ?? ""}|${process.env.ZENITH_CONTROL_SIGNING_KID ?? ""}|${process.env.ZENITH_CONTROL_NEXT_KEYS ?? ""}|${process.env.ZENITH_RUNNER_RESULT_KEY ?? ""}`;
  if (g.__zenithRunnerEnvCache?.key === key) return g.__zenithRunnerEnvCache;
  const fresh = { key, signer: createControlSignerFromEnv(), sealer: createResultSealerFromEnv() };
  g.__zenithRunnerEnvCache = fresh;
  return fresh;
}

export function getRunnerRuntime(): RunnerRuntime {
  const o = override;
  // resolve env crypto only for the pieces not injected, so a test that injects both needs no env
  const needsEnv = !o.signer || !o.sealer;
  const env = needsEnv ? envCrypto() : undefined;
  return {
    store: o.store ?? defaultStore(),
    signer: o.signer ?? env!.signer,
    sealer: o.sealer ?? env!.sealer,
    events: o.events ?? noopEvents,
    now: o.now ?? Date.now,
    sleep: o.sleep ?? realSleep,
    pollStepMs: o.pollStepMs ?? POLL_STEP_MS,
  };
}
