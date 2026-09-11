/**
 * Draining the transactional outbox: performing the effects that were
 * committed as intentions.
 *
 * The shape mirrors `src/lib/alerts/deliver.ts`, which has been carrying this
 * pattern in production paths already: claim the row and make the claim
 * durable *before* the first byte leaves, perform the effect, then settle.
 * A crash anywhere in between leaves a `sending` row — evidence that something
 * may or may not have happened — and the next boot reclaims and repeats it
 * under the same `idempotencyKey`, which is the handle the receiver dedupes on.
 *
 * Two deliberate rules:
 *
 *  - **A kind with no registered handler is never claimed.** It stays
 *    `pending` and visible in `listPending()`. Failing rows because the module
 *    that handles them has not booted yet would destroy real intentions to
 *    make a counter look tidy.
 *  - **`failed` is terminal.** TODO(ceiling): no dead-letter queue and no
 *    per-kind circuit breaker — five attempts inside one claim, then the row
 *    keeps its error and stops. The upgrade path is a dead-letter view an
 *    operator can re-drive from, which is worth building when someone is
 *    watching these rows; today the failure is recorded with its reason rather
 *    than retried forever.
 */
import type { HostedOutboxEntry } from "@/lib/hosted/contracts";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { authority } from "./lifecycle";
import type { OutboxKind } from "./repos/outbox";

/** What performs one effect. Rejecting means "not done"; the row is retried, then failed. */
export type OutboxHandler = (entry: HostedOutboxEntry) => Promise<void>;

/** Attempts inside one claim, including the first. */
export const OUTBOX_MAX_ATTEMPTS = 5;

/** Waits between those attempts, in milliseconds. Collapsed to nothing by `ORRERY_FAST`. */
export const OUTBOX_BACKOFF_MS = [200, 800, 2_000, 5_000] as const;

/**
 * How long a claim is trusted before another drain may take the row back.
 * Comfortably longer than the worst case one row can legitimately take.
 */
export const OUTBOX_LEASE_MS = 120_000;

/** How many rows a single drain claims. */
const OUTBOX_BATCH = 50;

/** What one drain did. */
export interface DrainResult {
  /** Rows whose effect completed and were settled `done`. */
  done: number;
  /** Rows that exhausted their attempts and were settled `failed`. */
  failed: number;
}

/** What a boot-time replay did. */
export interface ReplayResult extends DrainResult {
  /** Rows a previous process left `sending` that this call handed back to `pending`. */
  reclaimed: number;
}

type OutboxGlobal = typeof globalThis & {
  __zenithOutboxHandlers?: Map<OutboxKind, OutboxHandler>;
  __zenithOutboxInFlight?: Promise<DrainResult>;
};

function handlers(): Map<OutboxKind, OutboxHandler> {
  const g = globalThis as OutboxGlobal;
  g.__zenithOutboxHandlers ??= new Map();
  return g.__zenithOutboxHandlers;
}

/**
 * Register the effect for one kind, replacing any previous registration, and
 * answer with a function that removes it again.
 *
 * Held on `globalThis` so a hot reload does not quietly leave the outbox with
 * no handlers and every row stuck `pending`.
 */
export function registerOutboxHandler(kind: OutboxKind, handler: OutboxHandler): () => void {
  handlers().set(kind, handler);
  return () => {
    if (handlers().get(kind) === handler) handlers().delete(kind);
  };
}

/** The kinds this process can currently perform. Only these are ever claimed. */
export const registeredOutboxKinds = (): OutboxKind[] => [...handlers().keys()];

/** Backoff that a fast test run does not have to sit through. Never keeps the process alive. */
const wait = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || env().ORRERY_FAST) return resolve();
    (setTimeout(resolve, ms) as unknown as { unref?: () => void }).unref?.();
  });

/** How the drain is bounded. */
export interface DrainOptions {
  /** Claims older than this are treated as abandoned and reclaimed first. */
  leaseMs?: number;
  /** Restrict to these kinds; defaults to every kind with a handler. */
  kinds?: readonly OutboxKind[];
}

/**
 * Claim what is pending and perform it.
 *
 * Serialised per process: two overlapping calls do not interleave claims, so
 * the counts a caller gets back describe rows it actually owned. Never throws
 * for a handler failure — that outcome is a settled row, which is the point.
 */
export function drainOutbox(opts: DrainOptions = {}): Promise<DrainResult> {
  const g = globalThis as OutboxGlobal;
  const next = (g.__zenithOutboxInFlight ?? Promise.resolve({ done: 0, failed: 0 })).then(
    () => drainOnce(opts),
    () => drainOnce(opts)
  );
  g.__zenithOutboxInFlight = next;
  return next;
}

async function drainOnce(opts: DrainOptions): Promise<DrainResult> {
  const kinds = opts.kinds ?? registeredOutboxKinds();
  const result: DrainResult = { done: 0, failed: 0 };
  if (kinds.length === 0) return result;

  const a = authority();
  const claimed = a.tx((): HostedOutboxEntry[] =>
    a.repos.outbox.claimPending(opts.leaseMs ?? OUTBOX_LEASE_MS, { kinds, limit: OUTBOX_BATCH })
  );

  for (const entry of claimed) {
    const handler = handlers().get(entry.kind);
    if (!handler) {
      // The handler was removed between the claim and now. Put this one row
      // back rather than record a failure for an effect nobody attempted.
      a.tx(() => a.repos.outbox.release(entry.id));
      continue;
    }
    const outcome = await attempt(handler, entry);
    if (outcome.ok) {
      a.tx(() => a.repos.outbox.settle(entry.id, "done", { extraAttempts: outcome.attempts - 1 }));
      result.done++;
    } else {
      a.tx(() =>
        a.repos.outbox.settle(entry.id, "failed", {
          extraAttempts: outcome.attempts - 1,
          error: outcome.error,
        })
      );
      result.failed++;
      log.warn("hosted outbox entry failed", {
        scope: "hosted.outbox",
        kind: entry.kind,
        idempotencyKey: entry.idempotencyKey,
        attempts: outcome.attempts,
        error: outcome.error,
      });
    }
  }
  return result;
}

interface Attempted {
  ok: boolean;
  attempts: number;
  error?: string;
}

/** Run one handler up to `OUTBOX_MAX_ATTEMPTS` times. Never throws. */
async function attempt(handler: OutboxHandler, entry: HostedOutboxEntry): Promise<Attempted> {
  let error = "";
  for (let n = 1; n <= OUTBOX_MAX_ATTEMPTS; n++) {
    try {
      await handler(entry);
      return { ok: true, attempts: n };
    } catch (err) {
      error = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
      if (n < OUTBOX_MAX_ATTEMPTS) await wait(OUTBOX_BACKOFF_MS[n - 1] ?? 0);
    }
  }
  return { ok: false, attempts: OUTBOX_MAX_ATTEMPTS, error };
}

/**
 * Boot: take back every row a previous process left `sending`, then drain.
 *
 * Reclaiming *every* such row — lease 0 — is correct precisely here.
 * `claimDataDir()` has already proved this process is the only writer of this
 * data directory, so no live drain can be holding one. The effect is repeated
 * under its original idempotency key rather than dropped.
 */
export async function replayOutbox(): Promise<ReplayResult> {
  const a = authority();
  const reclaimed = a.tx(() => a.repos.outbox.reclaimStale(0));
  if (reclaimed > 0)
    log.info("reclaimed hosted outbox rows left by a previous process", {
      scope: "hosted.outbox",
      reclaimed,
    });
  const drained = await flushOutbox();
  return { ...drained, reclaimed };
}

/**
 * Tests and scripts: drain until nothing claimable is left, and answer with
 * the totals. Bounded, so a handler that re-enqueues its own kind cannot spin
 * forever.
 */
export async function flushOutbox(opts: DrainOptions = {}): Promise<DrainResult> {
  const total: DrainResult = { done: 0, failed: 0 };
  const kinds = opts.kinds ?? registeredOutboxKinds();
  if (kinds.length === 0) return total;
  for (let pass = 0; pass < 10; pass++) {
    const pending = authority().repos.outbox.listPending({ kinds });
    if (pending.length === 0) return total;
    const round = await drainOutbox(opts);
    total.done += round.done;
    total.failed += round.failed;
    if (round.done === 0 && round.failed === 0) return total;
  }
  return total;
}
