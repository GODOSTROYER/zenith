/**
 * Per-process boot. Every API route calls `ensureBoot()` first.
 *
 * Registers actions + providers, resumes any deployment that was in flight when
 * the server restarted, and replays the alert outbox (durable operations: a
 * restart never strands a deployment, and never silently drops a notification
 * for an alert that is already open). All workstream modules have landed, so
 * imports are literal and verified at build time.
 */
import type { SecurityFinding } from "@/lib/domain/types";
import { providerRegistry } from "@/lib/providers/types";
import { engine, ensureEngine } from "@/lib/engine/engine";
import { registerAllActions } from "@/lib/actions/defs";
import { replayOutbox, startAlertEvaluator } from "@/lib/alerts";
import * as security from "@/lib/security/rules";
import * as logsim from "@/lib/logsim";
import { claimDataDir } from "@/lib/data-lock";
import { ensureHosted } from "@/lib/hosted";
import { env } from "@/lib/env";
import { log } from "@/lib/log";

type G = typeof globalThis & { __orreryBoot?: Promise<void> };

/* ------------------------- module accessors (typed) ------------------------ */

export interface SecurityModule {
  syncFindings?: (projectId: string) => SecurityFinding[] | void;
}

export const securityModule = async (): Promise<SecurityModule> => security;

export interface LogLine {
  seq: number;
  ts: string;
  line: string;
  stream?: string;
}

export interface LogsimModule {
  getServiceLogs?: (environmentId: string, serviceId: string, afterSeq: number) => LogLine[];
  /** health for every managed service in an environment, keyed by service id */
  environmentHealth?: (environmentId: string) => Record<string, unknown>;
}

export const logsimModule = async (): Promise<LogsimModule> =>
  logsim as unknown as LogsimModule;

/* ---------------------------------- boot ---------------------------------- */

async function boot(): Promise<void> {
  // Refuse to share a data directory with another live process: the store
  // rewrites state.json wholesale, so two writers silently lose each other's
  // work. The thrown error names the pid, the directory and the way out.
  claimDataDir(env().ORRERY_DATA);
  // The hosted control authority (SQLite) opens right after the data-dir
  // claim, before anything can read hosted state, and refuses to boot in
  // hosted mode without the inputs it needs. See src/lib/hosted/index.ts.
  ensureHosted();
  // Alert deliveries the last process had queued — or was mid-send when it
  // died — are reclaimed and drained. Safe to reclaim every claimed row here
  // because the line above just proved no other process owns this data
  // directory. Scheduled rather than awaited, and `unref`'d like the evaluator
  // timer: a webhook that never answers must not hold up boot, keep the process
  // alive, or make the first request wait 30s for a retry ladder to finish.
  const replay = setTimeout(() => {
    void replayOutbox().catch((err) =>
      log.error("alert outbox replay failed", { scope: "alerts", error: err })
    );
  }, 0);
  (replay as { unref?: () => void }).unref?.();
  ensureEngine(); // also registers every provider adapter
  engine.resumeInFlight();
  registerAllActions();
  // Alert rules are re-derived from durable records, so this both catches up
  // on anything that broke while the server was down and keeps watching after.
  // Unref'd 15s timer; it returns immediately when no rules exist.
  startAlertEvaluator();
  if (providerRegistry().size === 0)
    log.warn("no providers registered; provider pickers will be empty", { scope: "boot" });
}

/** Idempotent per process (and across Next HMR reloads). */
export function ensureBoot(): Promise<void> {
  const g = globalThis as G;
  g.__orreryBoot ??= boot().catch((err) => {
    log.error("boot failed", { scope: "boot", error: err });
    // A failed boot must not be swallowed into a half-working app: every
    // request that awaits boot sees the same error, with its fix attached.
    throw err;
  });
  return g.__orreryBoot;
}
