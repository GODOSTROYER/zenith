/**
 * The transaction helper the whole hosted subsystem acknowledges through.
 *
 * **Commit-before-ACK.** `transact()` returns only after `COMMIT` succeeded.
 * A route that answers 200 after `tx()` returned is therefore answering about
 * bytes that are on disk under `synchronous=FULL`; a crash between the commit
 * and the response costs the caller a retry, never a lost write. Anything that
 * must happen *outside* the transaction — an email, a provider call — is an
 * outbox row written inside it (see `outbox.ts`).
 *
 * **Two forms, one rule.** `transact()` takes a synchronous `fn` and is what
 * the migration runner and the restore tooling use on a connection of their
 * own. `transactAsync()` takes an `fn` that is awaited, which is what the
 * authority's `tx()` is built from now that every repository call returns a
 * Promise.
 *
 * **An awaited transaction must be serialised by its caller.** `DatabaseSync`
 * is one connection, so an `await` inside a transaction holds the write lock
 * across the event loop; a second transaction that issued `BEGIN` in the gap
 * would interleave its statements with this one and a `BEGIN` and a `COMMIT`
 * would end up belonging to different logical operations. `transactAsync()`
 * does not police that — `sqlite-authority.ts` runs every top-level
 * transaction through a process-wide mutex so the gap cannot be used. Keep
 * `fn` to database work regardless: a network call inside a transaction holds
 * the lock for as long as the network takes, which is the reason the outbox
 * exists.
 *
 * **`fn` may run more than once.** When SQLite reports the database busy the
 * whole attempt is rolled back and retried (bounded, with backoff), so `fn`
 * must be pure database work: no counters in module scope, no file writes, no
 * sends. Everything it did was rolled back before it is called again.
 *
 * **Nesting uses savepoints.** A `transact()` inside a `transact()` — a
 * repository helper called from a larger operation — opens a `SAVEPOINT`
 * instead of a second `BEGIN`, so an inner failure rolls back only the inner
 * work and the outer transaction stays intact. Retry is disabled while a
 * savepoint is active: only the outermost frame owns the decision to replay.
 */
import type { DatabaseSync } from "node:sqlite";
import { HostedError } from "@/lib/hosted/contracts";
import { env } from "@/lib/env";
import { isBusyError } from "./sql";

/** How many times the outermost frame replays a transaction SQLite reported busy. */
export const TX_MAX_ATTEMPTS = 5;

/**
 * Waits between replays, in milliseconds. Short on purpose: `busy_timeout` has
 * already blocked for seconds by the time an attempt fails, so this is jitter
 * against a live contender, not the wait itself.
 */
export const TX_BACKOFF_MS = [25, 50, 100, 200] as const;

/** Options for one transaction. Defaults are the durable ones; narrow them only in tests and scripts. */
export interface TransactOptions {
  /**
   * Total attempts at the outermost frame, including the first. Default
   * `TX_MAX_ATTEMPTS`. A test that wants a busy database to fail promptly
   * rather than after five five-second waits passes `1`.
   */
  attempts?: number;
}

/** Savepoint counter per connection: names must be unique down one nesting chain. */
const depth = new WeakMap<DatabaseSync, number>();

/**
 * Block this thread for `ms` without spinning.
 *
 * `Atomics.wait` on a private SharedArrayBuffer parks the thread the way a
 * real sleep does; a `while (Date.now() < end)` loop would burn a core for the
 * whole backoff. Node permits this on the main thread — unlike a browser —
 * and everything in this module is synchronous by contract anyway.
 */
function sleep(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The same wait for the awaited form, which must not block the thread: the
 * contender it is backing off from is usually another request on this event
 * loop. Never keeps the process alive.
 */
const sleepAsync = (ms: number): Promise<void> =>
  ms <= 0
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        (setTimeout(resolve, ms) as unknown as { unref?: () => void }).unref?.();
      });

const backoffFor = (attempt: number): number => {
  if (env().ZENITH_FAST) return 0;
  return TX_BACKOFF_MS[Math.min(attempt, TX_BACKOFF_MS.length) - 1] ?? 0;
};

const busy = (err: unknown, attempts: number): HostedError =>
  new HostedError(
    "policy_unavailable",
    `The hosted control database stayed locked by another writer through ${attempts} attempt${attempts === 1 ? "" : "s"}, so this change was not made and nothing was half-written.`,
    {
      fix: "Retry the request. If it keeps happening, a second process is holding the same ZENITH_DATA directory — stop it, or give this one its own directory with ZENITH_DATA=<path> (see src/lib/data-lock.ts).",
      details: { attempts, reason: "sqlite_busy" },
    }
  );

/**
 * Run `fn` inside one durable transaction and return its value.
 *
 * Outermost frame: `BEGIN IMMEDIATE` (the write lock is taken up front, so two
 * writers collide at the start rather than half way through) … `COMMIT`, with
 * `ROLLBACK` and a rethrow on any throw. Nested frame: `SAVEPOINT` …
 * `RELEASE`, with `ROLLBACK TO` on a throw.
 *
 * Prefer `authority().tx(fn)`, which binds this to the process-wide
 * connection. This form exists for the migration runner, which must transact
 * on a connection before an `Authority` exists.
 */
export function transact<T>(db: DatabaseSync, fn: (db: DatabaseSync) => T, opts: TransactOptions = {}): T {
  // `isTransaction` is SQLite's own answer, so a transaction someone else
  // opened on this connection is honoured too — this never issues a second
  // BEGIN, which SQLite would refuse.
  if (db.isTransaction) return withSavepoint(db, fn);

  const attempts = Math.max(1, Math.trunc(opts.attempts ?? TX_MAX_ATTEMPTS));
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (err) {
      if (!isBusyError(err)) throw err;
      last = err;
      sleep(backoffFor(attempt));
      continue;
    }
    try {
      const value = fn(db);
      db.exec("COMMIT");
      return value;
    } catch (err) {
      // The rollback is best effort: SQLite has already rolled the transaction
      // back itself for some errors, and a throw here would replace the real
      // cause with a confusing "cannot rollback - no transaction is active".
      try {
        if (db.isTransaction) db.exec("ROLLBACK");
      } catch {
        /* the original error is the one worth reporting */
      }
      if (!isBusyError(err)) throw err;
      last = err;
      sleep(backoffFor(attempt));
    }
  }
  throw busy(last, attempts);
}

/**
 * Run an awaited `fn` inside one durable transaction and resolve with its
 * value.
 *
 * The same frames and the same retry as `transact()`: `BEGIN IMMEDIATE` …
 * `COMMIT` at the outermost level, `SAVEPOINT` … `RELEASE` inside one, bounded
 * replay on busy, and a resolution that happens only after the commit
 * succeeded. The backoff waits on a timer rather than blocking the thread.
 *
 * **The caller owns serialisation.** Two overlapping calls on one connection
 * would interleave; `createSqliteAuthority` is what makes sure they cannot.
 */
export async function transactAsync<T>(
  db: DatabaseSync,
  fn: (db: DatabaseSync) => T | Promise<T>,
  opts: TransactOptions = {}
): Promise<T> {
  if (db.isTransaction) return withSavepointAsync(db, fn);

  const attempts = Math.max(1, Math.trunc(opts.attempts ?? TX_MAX_ATTEMPTS));
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (err) {
      if (!isBusyError(err)) throw err;
      last = err;
      await sleepAsync(backoffFor(attempt));
      continue;
    }
    try {
      const value = await fn(db);
      db.exec("COMMIT");
      return value;
    } catch (err) {
      try {
        if (db.isTransaction) db.exec("ROLLBACK");
      } catch {
        /* the original error is the one worth reporting */
      }
      if (!isBusyError(err)) throw err;
      last = err;
      await sleepAsync(backoffFor(attempt));
    }
  }
  throw busy(last, attempts);
}

/** `SAVEPOINT` … `RELEASE` around an awaited `fn`, with `ROLLBACK TO` on a throw. */
async function withSavepointAsync<T>(
  db: DatabaseSync,
  fn: (db: DatabaseSync) => T | Promise<T>
): Promise<T> {
  const level = (depth.get(db) ?? 0) + 1;
  depth.set(db, level);
  const name = `zenith_sp_${level}`;
  try {
    db.exec(`SAVEPOINT ${name}`);
    try {
      const value = await fn(db);
      db.exec(`RELEASE ${name}`);
      return value;
    } catch (err) {
      // ROLLBACK TO leaves the savepoint on the stack; RELEASE pops it. Both,
      // in that order, or the next sibling savepoint nests inside a dead one.
      try {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
      } catch {
        /* the outer frame's ROLLBACK discards everything anyway */
      }
      throw err;
    }
  } finally {
    depth.set(db, level - 1);
  }
}

function withSavepoint<T>(db: DatabaseSync, fn: (db: DatabaseSync) => T): T {
  const level = (depth.get(db) ?? 0) + 1;
  depth.set(db, level);
  const name = `zenith_sp_${level}`;
  try {
    db.exec(`SAVEPOINT ${name}`);
    try {
      const value = fn(db);
      db.exec(`RELEASE ${name}`);
      return value;
    } catch (err) {
      // ROLLBACK TO leaves the savepoint on the stack; RELEASE pops it. Both,
      // in that order, or the next sibling savepoint nests inside a dead one.
      try {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
      } catch {
        /* the outer frame's ROLLBACK discards everything anyway */
      }
      throw err;
    }
  } finally {
    depth.set(db, level - 1);
  }
}
