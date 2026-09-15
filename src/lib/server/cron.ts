/**
 * Background work on a host that has no background.
 *
 * Everything Zenith does between requests — the engine's 250 ms ticker, the
 * alert evaluator's 15 s pass, the alert outbox drainer, the hosted job runner
 * — assumes one long-lived process. On Vercel there is no such process: an
 * instance exists for a request and is frozen after it (see
 * `src/lib/serverless.ts`), so `ensureEngine()` starts no ticker there and
 * `startAlertEvaluator()` runs one pass and stops. What a server gets from a
 * timer, a serverless deployment has to get from a *request*.
 *
 * This module is the one place that turns "a request arrived" into "one bounded
 * pass of the background work", and `src/app/api/internal/tick/*` are the four
 * routes that call it.
 *
 * ## Who is allowed to call them
 *
 * The Vercel convention, and nothing invented here: `Authorization: Bearer
 * <CRON_SECRET>`. Vercel attaches that header itself to every request its own
 * cron scheduler makes once `CRON_SECRET` is set on the project, and the same
 * header is what the GitHub Actions schedule sends. The comparison is
 * constant-time over SHA-256 digests of both sides, so neither the value nor
 * its length is recoverable from timing. With `CRON_SECRET` unset the routes
 * answer **503** rather than running unauthenticated: an internal route that
 * silently becomes public because an environment variable was forgotten is a
 * worse failure than a tick that does not happen.
 *
 * ## Why the cadence is five minutes
 *
 * The Hobby plan runs Vercel Cron **at most once per day**, so per-minute
 * scheduling is not available there at all. `.github/workflows/tick.yml` drives
 * the four routes instead, on GitHub's own floor of five minutes; the daily
 * Vercel cron in `vercel.json` is pointed at `/api/internal/keepalive`, whose
 * only job is to touch the database often enough that a free Supabase project
 * is not paused for inactivity. `nudge()` below covers the gap between ticks on
 * the request path, where it matters most: a deployment a person is watching.
 *
 * ## The snapshot contract for out-of-request work
 *
 * On `ZENITH_STORE=postgres`, `db()` reads a snapshot that was loaded *before*
 * the caller ran. A cron pass has no session, and a pass that saw one
 * workspace would advance one workspace, so every pass runs inside an
 * **unfiltered** snapshot — `primeProcessSnapshot(null)`, which is what
 * `loadSnapshot(client, null)` means: every workspace, every row. The pass then
 * runs inside `runWithSnapshot()` so a nested `route()`-shaped read finds the
 * same object, and the write-back is awaited before the response leaves, the
 * same "commit before ACK" every mutating route obeys.
 *
 * ## The one timer, and why it exists
 *
 * A *long-lived* host on `ZENITH_STORE=postgres` is the topology that falls
 * between the two stools above: the engine's 250 ms ticker is off there (a
 * timer callback has no snapshot, so `db()` would rightly refuse — see
 * `ensureEngine()`), boot does no durable catch-up for the same reason, and
 * nothing outside the process is obliged to call these routes. So
 * `startCronScheduler()` below runs the same passes on an unref'd interval,
 * inside the same `inCronScope()`, single-flight and never inside a request
 * scope. It refuses to start on serverless, where the premise is false, and on
 * the file store, which has its own timers. See ADR 1 in docs/ARCHITECTURE.md
 * and §3 of docs/RUNNING.md for which topology gets which.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { ApiError, errorResponse, json } from "@/lib/server/errors";
import { db, flushPendingAsync, isPostgres } from "@/lib/db/store";
import { outsideSnapshot } from "@/lib/db/request-snapshot";
import { engine, engineTick } from "@/lib/engine/engine";
import { evaluateAll, replayOutbox } from "@/lib/alerts";
import { log, withRequestId } from "@/lib/log";
import { isServerless } from "@/lib/serverless";

/* ------------------------------ authorisation ----------------------------- */

/** The environment variable Vercel itself names, and sends as a bearer token. */
export const CRON_SECRET_ENV = "CRON_SECRET";

/** Read live: a route module is evaluated once and the value can be rotated. */
export const cronSecret = (): string => process.env[CRON_SECRET_ENV]?.trim() ?? "";

/**
 * Constant-time string equality.
 *
 * `timingSafeEqual` throws on a length mismatch, and refusing early on length
 * would itself be a timing signal, so both sides are hashed first: the digests
 * are always 32 bytes, and the comparison is over those.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}

/** The bearer token on a request, or "" — never the raw header. */
function bearer(req: NextRequest): string {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : "";
}

/**
 * Refuse anything that is not the scheduler.
 *
 * Throws rather than returning a flag so a handler cannot forget to check it,
 * and so the refusal wears the same `{ error: { message, fix } }` body every
 * other route answers with.
 */
export function authorizeCron(req: NextRequest): void {
  const secret = cronSecret();
  if (!secret)
    throw new ApiError(
      "This deployment has no CRON_SECRET, so background ticks are refused.",
      503,
      {
        fix:
          `Set ${CRON_SECRET_ENV} on the Vercel project (production and preview) and as a GitHub ` +
          `Actions secret, then redeploy. Until it is set these routes run nothing rather than ` +
          `running unauthenticated.`,
      }
    );
  // Constant-time, and the empty token takes exactly the same path as a wrong
  // one: an early return on "no header" would answer faster for a probe.
  if (!constantTimeEqual(bearer(req), secret))
    throw new ApiError("This route is for the scheduler.", 401, {
      fix:
        `Send \`Authorization: Bearer $${CRON_SECRET_ENV}\`. Vercel Cron attaches it for you; ` +
        `the GitHub schedule reads it from the repository secret of the same name.`,
    });
}

/* -------------------------------- the scope ------------------------------- */

/**
 * Run one pass inside an unfiltered store snapshot.
 *
 * On the file store this is a pass-through — `db()` is already the whole graph.
 * On Postgres it primes the process-global snapshot with `user: null` (every
 * workspace), runs the pass inside `runWithSnapshot` so anything that looks for
 * a request scope finds the same object, and awaits the write-back.
 *
 * Only the store's public API is used: `primeProcessSnapshot`, `runWithSnapshot`
 * and `flushPendingAsync`. Nothing in `postgres-store.ts` needed changing.
 */
export async function inCronScope<T>(pass: () => Promise<T>): Promise<T> {
  if (!isPostgres()) {
    const out = await pass();
    await flushPendingAsync();
    return out;
  }
  const { primeProcessSnapshot } = await import("@/lib/db/postgres-store");
  const { runWithSnapshot } = await import("@/lib/db/request-snapshot");
  const snapshot = await primeProcessSnapshot(null);
  return runWithSnapshot(snapshot, async () => {
    const out = await pass();
    await flushPendingAsync();
    return out;
  });
}

/* --------------------------------- passes --------------------------------- */

/** One tick's wall-clock budget. Kept under the route's `maxDuration`. */
export const ENGINE_BUDGET_MS = 20_000;

/** How long one `engineTick()` is given to make progress before the next. */
const ENGINE_STEP_MS = 250;

/**
 * A row this instance may not reclaim: on serverless another instance can hold
 * a delivery right now, so the boot-time "reclaim everything" lease is wrong
 * here. A minute is far longer than any single delivery attempt.
 */
const OUTBOX_LEASE_MS = 60_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface EngineTickResult {
  /** deployments that were applying or verifying when the pass began */
  deployments: number;
  /** how many `engineTick()` calls the budget bought */
  ticks: number;
  /** still in flight when the pass ended — the next tick picks them up */
  remaining: number;
  /** true when the budget ran out with work left */
  timedOut: boolean;
  ms: number;
}

/**
 * Advance every in-flight deployment for up to `budgetMs`.
 *
 * `engineTick()` starts one step per deployment and returns; the steps
 * themselves are async. So a single tick per invocation would advance a
 * ten-step deploy by one step every five minutes. This loops instead — tick,
 * give the steps a moment, tick again — and stops the instant nothing is in
 * flight, so an idle deployment costs one round trip and no wall clock.
 *
 * `resumeInFlight()` runs first because `engineTick()` only advances
 * deployments the engine's in-memory active set knows about, and a fresh
 * instance's set is empty (or was populated from a *filtered* snapshot during
 * an earlier request on this instance).
 */
export async function engineTickPass(budgetMs = ENGINE_BUDGET_MS): Promise<EngineTickResult> {
  const started = Date.now();
  const inFlight = (): number =>
    db().deployments.filter((d) => d.status === "applying" || d.status === "verifying").length;

  engine.resumeInFlight();
  const deployments = inFlight();
  let ticks = 0;
  let remaining = deployments;
  const deadline = started + Math.max(0, budgetMs);
  while (remaining > 0 && Date.now() < deadline) {
    engineTick();
    ticks++;
    remaining = inFlight();
    if (remaining === 0) break;
    await sleep(ENGINE_STEP_MS);
  }
  return {
    deployments,
    ticks,
    remaining,
    timedOut: remaining > 0,
    ms: Date.now() - started,
  };
}

export interface AlertTickResult {
  /** rules whose open/closed state actually moved */
  changed: number;
}

/** One full alert evaluation pass — exactly what the 15 s timer would have run. */
export async function alertTickPass(): Promise<AlertTickResult> {
  return { changed: evaluateAll() };
}

export interface OutboxTickResult {
  /** deliveries that were pending when the drain began */
  pending: number;
}

/**
 * Drain the alert outbox once.
 *
 * The lease is deliberate: `replayOutbox()`'s default of 0 reclaims *every* row
 * marked `sending`, which is right at boot on a server that has just proved it
 * is the only writer, and wrong here — another instance may be mid-send.
 */
export async function outboxTickPass(): Promise<OutboxTickResult> {
  return { pending: await replayOutbox(OUTBOX_LEASE_MS) };
}

export interface JobTickResult {
  /** false when hosted mode is off or the control authority is not open */
  ran: boolean;
  /** jobs queued when the tick began */
  queued: number;
  /** still queued after it — a job that no build slot would admit */
  remaining: number;
}

/**
 * One pass of the hosted job runner.
 *
 * `tickJobs()` claims what it can and starts it; the runs themselves are async
 * and outlive the call, so this reports the queue either side rather than
 * pretending to have finished anything.
 */
export async function jobTickPass(): Promise<JobTickResult> {
  const { authorityOpen } = await import("@/lib/hosted/authority");
  if (!authorityOpen()) return { ran: false, queued: 0, remaining: 0 };
  const { queuedJobs, tickJobs } = await import("@/lib/hosted/release");
  const queued = (await queuedJobs()).length;
  await tickJobs();
  return { ran: true, queued, remaining: (await queuedJobs()).length };
}

/* ------------------------------ the scheduler ------------------------------ */

/**
 * How often one scheduled pass starts on a long-lived Postgres host.
 *
 * Every pass primes an unfiltered snapshot, which is one round trip per table,
 * so this is not the engine's 250 ms — but `engineTickPass()` loops internally
 * at `ENGINE_STEP_MS` until nothing is in flight, so a deployment is advanced
 * step after step *within* one pass rather than one step per interval. Two
 * seconds is the worst-case wait before a fresh deployment is picked up, and
 * an idle install costs one prefetch per two seconds and no writes.
 */
export const SCHEDULER_INTERVAL_MS = 2_000;

/**
 * Alerts and the outbox run every Nth pass — ~16 s, which is the 15 s cadence
 * `startAlertEvaluator()` uses on a file-store host. Evaluating alert rules
 * eight times more often than that buys nothing and costs a full pass.
 */
export const SCHEDULER_SLOW_EVERY = 8;

/**
 * The engine budget one scheduled pass may spend. Shorter than the route's
 * `ENGINE_BUDGET_MS`: a route answers when its pass ends, while this one holds
 * the only scheduler slot, and a 20 s pass would delay the alert evaluation
 * behind it by 20 s.
 */
export const SCHEDULER_ENGINE_BUDGET_MS = 5_000;

/**
 * The passes one scheduled tick runs, indirected so a test can observe them.
 *
 * Not a plugin point: production reads exactly these three, in this order, and
 * `/api/internal/tick/*` calls the same functions directly. `jobTickPass()` is
 * deliberately absent — the hosted job runner reads the hosted authority, not
 * the product snapshot, so it never lost its own 250 ms ticker
 * (`startHostedJobRunner()`, called by `ensureHosted()` before boot's Postgres
 * return). Adding it here would tick it twice.
 */
export const scheduledPasses = {
  engine: engineTickPass,
  alerts: alertTickPass,
  outbox: outboxTickPass,
};

export interface SchedulerPassResult {
  engine: EngineTickResult;
  /** absent on a fast pass — alerts and the outbox run every `SCHEDULER_SLOW_EVERY` */
  alerts?: AlertTickResult;
  outbox?: OutboxTickResult;
  ms: number;
}

type GScheduler = typeof globalThis & {
  __zenithCronScheduler?: ReturnType<typeof setInterval>;
  __zenithCronPassRunning?: boolean;
  __zenithCronPassCount?: number;
};

/**
 * Run one scheduled pass now, unless one is already running.
 *
 * Single-flight by a process-global flag rather than by the interval: a pass
 * that overruns its period must not have a second one started on top of it,
 * because two passes would each prime a snapshot, each advance the same
 * deployments, and each flush a baseline the other invalidated. `null` means
 * "skipped, one was in flight" — the next tick tries again.
 *
 * `outsideSnapshot()` is load-bearing. The interval is created during `boot()`,
 * which the first request awaits, so the callback inherits that request's async
 * context for the life of the process; without it every pass would read one
 * arbitrary caller's tenant slice instead of priming its own unfiltered one.
 */
export async function runScheduledPass(): Promise<SchedulerPassResult | null> {
  const g = globalThis as GScheduler;
  if (g.__zenithCronPassRunning) return null;
  g.__zenithCronPassRunning = true;
  const started = Date.now();
  const count = (g.__zenithCronPassCount = (g.__zenithCronPassCount ?? 0) + 1);
  const slow = count % SCHEDULER_SLOW_EVERY === 1;
  try {
    return await outsideSnapshot(() =>
      inCronScope(async () => {
        const engineResult = await scheduledPasses.engine(SCHEDULER_ENGINE_BUDGET_MS);
        const result: SchedulerPassResult = { engine: engineResult, ms: 0 };
        if (slow) {
          result.alerts = await scheduledPasses.alerts();
          result.outbox = await scheduledPasses.outbox();
        }
        result.ms = Date.now() - started;
        return result;
      })
    );
  } finally {
    g.__zenithCronPassRunning = false;
  }
}

/**
 * Start the in-process scheduler, and say whether it started.
 *
 * Called by `boot()`. Three refusals, each because something else already does
 * the work:
 *
 *  - **serverless** — an instance is frozen between requests, so an interval
 *    either never fires or fires against an instance nobody will ask again;
 *    `.github/workflows/tick.yml` (or any external scheduler) drives the tick
 *    routes there, and `nudge()` covers the gap on the request path;
 *  - **the file store** — `ensureEngine()`'s 250 ms ticker and
 *    `startAlertEvaluator()`'s 15 s timer are live on that host and read the
 *    one graph directly;
 *  - **already running** — boot is idempotent, and so is this.
 *
 * The interval is `unref`'d: a scheduler must never be the reason a script or
 * a test process refuses to exit.
 */
export function startCronScheduler(): boolean {
  const g = globalThis as GScheduler;
  if (g.__zenithCronScheduler) return false;
  if (isServerless() || !isPostgres()) return false;
  const timer = setInterval(() => {
    void runScheduledPass().catch((err) => {
      // A background pass must not take the process down: an unhandled
      // rejection from a timer callback is an exit, and the next pass would
      // have retried anyway. Logged at error because a pass that keeps failing
      // means deployments are not advancing.
      log.error("scheduled pass failed", { scope: "cron", error: err });
    });
  }, SCHEDULER_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  g.__zenithCronScheduler = timer;
  log.info("in-process scheduler started", {
    scope: "cron",
    reason: "ZENITH_STORE=postgres on a long-lived host: no engine ticker, no boot catch-up",
    everyMs: SCHEDULER_INTERVAL_MS,
    passes: ["engine", `alerts+outbox every ${SCHEDULER_SLOW_EVERY}`],
  });
  return true;
}

/** Stop it. Tests, and any caller that starts one deliberately. */
export function stopCronScheduler(): void {
  const g = globalThis as GScheduler;
  if (g.__zenithCronScheduler) clearInterval(g.__zenithCronScheduler);
  g.__zenithCronScheduler = undefined;
  g.__zenithCronPassRunning = false;
}

/** True while the interval exists. */
export const cronSchedulerRunning = (): boolean =>
  (globalThis as GScheduler).__zenithCronScheduler !== undefined;

/* --------------------------------- routing -------------------------------- */

/**
 * The wrapper every internal route uses.
 *
 * Deliberately *not* `route()`: that prefetches the caller's store slice before
 * the handler runs, which would mean loading the whole database for a request
 * that is about to be refused with a 401. Here the bearer is checked first, and
 * only then is anything read.
 */
export function cronRoute(
  name: string,
  pass: (req: NextRequest) => Promise<Record<string, unknown>>
): (req: NextRequest) => Promise<Response> {
  return async (req: NextRequest): Promise<Response> => {
    const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID().slice(0, 8);
    return withRequestId(requestId, async () => {
      try {
        authorizeCron(req);
        const { ensureBoot } = await import("@/lib/server/boot");
        await ensureBoot();
        const started = Date.now();
        const counts = await inCronScope(() => pass(req));
        const body = { pass: name, ok: true, ms: Date.now() - started, ...counts };
        log.info("internal tick", { scope: "cron", ...body });
        const res = json(body);
        res.headers.set("x-request-id", requestId);
        return res;
      } catch (err) {
        const res = errorResponse(err);
        res.headers.set("x-request-id", requestId);
        return res;
      }
    });
  };
}

/* --------------------------------- nudge ---------------------------------- */

/** Once per instance per this window, whatever the traffic. */
export const NUDGE_INTERVAL_MS = 5_000;

type G = typeof globalThis & { __zenithNudgeAt?: number };

/**
 * Opportunistic progression on the request path.
 *
 * A five-minute schedule is fine for an alert rule and much too slow for a
 * person watching a deploy. So when a project payload is read and that
 * project's workspace has something in flight, one synchronous `engineTick()`
 * runs first — it starts the next step of every active deployment and returns
 * immediately, because the steps are async. The response is not delayed by the
 * step, only by the tick that starts it.
 *
 * Bounded three ways: only on a host with no 250 ms ticker, at most once per
 * `NUDGE_INTERVAL_MS` per instance, and never when nothing is in flight. It
 * swallows its own errors — a background nudge must not be able to fail a read.
 *
 * "No ticker" is two hosts, not one. Serverless is the obvious one. The other
 * is a long-lived host on `ZENITH_STORE=postgres`, where `ensureEngine()` also
 * starts no ticker (a timer callback has no snapshot to read): the in-process
 * scheduler above advances deployments there every
 * `SCHEDULER_INTERVAL_MS`, and this closes the gap between two of its passes
 * for the person watching the deploy. It is safe on that host in a way it is
 * not outside a request: `db()` here is the caller's own request snapshot, and
 * `PostgresStore.save()` schedules its own flush, which a long-lived process
 * finishes even when `flushMutation` returns early because the request was a
 * GET. A file-store host keeps its ticker and is left alone.
 */
export function nudge(workspaceId?: string): void {
  if (!isServerless() && !isPostgres()) return;
  const g = globalThis as G;
  const now = Date.now();
  if (g.__zenithNudgeAt !== undefined && now - g.__zenithNudgeAt < NUDGE_INTERVAL_MS) return;
  try {
    const data = db();
    const workspaceOf = (projectId: string): string | undefined =>
      data.projects.find((p) => p.id === projectId)?.workspaceId;
    const inFlight = data.deployments.some(
      (d) =>
        (d.status === "applying" || d.status === "verifying") &&
        (!workspaceId || workspaceOf(d.projectId) === workspaceId)
    );
    if (!inFlight) return;
    g.__zenithNudgeAt = now;
    engineTick();
  } catch (err) {
    log.warn("nudge failed", { scope: "cron", error: err });
  }
}
