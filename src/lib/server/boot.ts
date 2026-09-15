/**
 * Per-process boot. Every API route calls `ensureBoot()` first.
 *
 * Registers actions + providers, resumes any deployment that was in flight when
 * the server restarted, and replays the alert outbox (durable operations: a
 * restart never strands a deployment, and never silently drops a notification
 * for an alert that is already open). Every module it wires is present, so
 * imports are literal and verified at build time.
 */
import type { SecurityFinding } from "@/lib/domain/types";
import { providerRegistry } from "@/lib/providers/types";
import { engine, engineTick, ensureEngine } from "@/lib/engine/engine";
import { registerAllActions } from "@/lib/actions/defs";
import { replayOutbox, startAlertEvaluator } from "@/lib/alerts";
import * as security from "@/lib/security/rules";
import * as logsim from "@/lib/logsim";
import { claimDataDir } from "@/lib/data-lock";
import { isPostgres } from "@/lib/db/store";
import { ensureHosted } from "@/lib/hosted";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { isServerless } from "@/lib/serverless";

type G = typeof globalThis & { __zenithBoot?: Promise<void> };

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
  //
  // Except on a serverless instance, where the premise is false: every instance
  // has its own `/tmp`, so the lock it finds is one a *previous* instance of
  // itself left behind, and honouring it would refuse to boot for a writer that
  // no longer exists. Nothing is shared, so nothing needs claiming.
  if (!isServerless()) claimDataDir(env().ZENITH_DATA);
  // The hosted control authority (SQLite) opens right after the data-dir
  // claim, before anything can read hosted state, and refuses to boot in
  // hosted mode without the inputs it needs. See src/lib/hosted/index.ts.
  ensureHosted();
  ensureEngine(); // also registers every provider adapter
  registerAllActions();

  // Everything below reads the product store, and on `ZENITH_STORE=postgres`
  // a read needs a snapshot that was loaded before the caller ran. Boot has no
  // caller: it runs before `route()` prefetches anything, and it runs for a
  // request that has not been authenticated yet — so priming one here would
  // both be the wrong scope and let an unauthenticated probe make the server
  // read the whole database, which is exactly what `cronRoute` refuses to do.
  //
  // On Postgres the durable catch-up is therefore the scheduler's, not boot's:
  // `/api/internal/tick/{engine,alerts,outbox,jobs}` check their bearer first
  // and run inside `inCronScope()`, which holds a real unfiltered snapshot.
  // Skipping here loses nothing that was working — before the store refused an
  // unprimed read, these three read the *file store's* graph in Postgres mode,
  // which is a different authority and holds none of these rows.
  if (isPostgres()) {
    log.info("durable catch-up deferred to the scheduler", {
      scope: "boot",
      reason: "ZENITH_STORE=postgres; boot holds no store snapshot",
      passes: ["/api/internal/tick/engine", "/api/internal/tick/alerts", "/api/internal/tick/outbox"],
    });
    if (providerRegistry().size === 0)
      log.warn("no providers registered; provider pickers will be empty", { scope: "boot" });
    return;
  }

  // Alert deliveries the last process had queued — or was mid-send when it
  // died — are reclaimed and drained. Safe to reclaim every claimed row here
  // because the data-dir claim above just proved no other process owns this
  // directory. Scheduled rather than awaited, and `unref`'d like the evaluator
  // timer: a webhook that never answers must not hold up boot, keep the process
  // alive, or make the first request wait 30s for a retry ladder to finish.
  const replay = setTimeout(() => {
    void replayOutbox().catch((err) =>
      log.error("alert outbox replay failed", { scope: "alerts", error: err })
    );
  }, 0);
  (replay as { unref?: () => void }).unref?.();
  engine.resumeInFlight();
  // Alert rules are re-derived from durable records, so this both catches up
  // on anything that broke while the server was down and keeps watching after.
  // Unref'd 15s timer; it returns immediately when no rules exist.
  startAlertEvaluator();
  // On a serverless instance neither timer above exists — `ensureEngine` skips
  // its 250ms ticker and `startAlertEvaluator` runs its pass and stops. The
  // evaluator's pass has already happened; the engine has not ticked, so it
  // does so here. Boot runs on every fresh instance, so what a long-lived
  // process gets from its first timer fire, an instance gets from this.
  if (isServerless()) engineTick();
  if (providerRegistry().size === 0)
    log.warn("no providers registered; provider pickers will be empty", { scope: "boot" });
}

/** Idempotent per process (and across Next HMR reloads). */
export function ensureBoot(): Promise<void> {
  const g = globalThis as G;
  g.__zenithBoot ??= boot().catch((err) => {
    log.error("boot failed", { scope: "boot", error: err });
    // A failed boot must not be swallowed into a half-working app: every
    // request that awaits boot sees the same error, with its fix attached.
    throw err;
  });
  return g.__zenithBoot;
}
