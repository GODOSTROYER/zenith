/**
 * The SQLite authority: today's connection, behind promises.
 *
 * The statements are unchanged — the repositories still run `DatabaseSync`
 * synchronously, and a read still answers without ever yielding. What changed
 * is the surface: every call returns a Promise, so a call site reads the same
 * whether the authority is this file or the Postgres one that replaces it.
 *
 * Three mechanisms make that honest rather than cosmetic:
 *
 *  - **One transaction at a time, enforced by a mutex.** `DatabaseSync` is one
 *    connection. Two awaited `tx()` callbacks that both got to run would
 *    interleave their statements between one `BEGIN` and one `COMMIT`, and the
 *    transaction that committed would be neither of them. Every top-level
 *    transaction is therefore queued on a promise chain and runs strictly after
 *    the previous one resolved — after its `COMMIT`, not after its callback.
 *  - **Nesting still uses savepoints.** A `tx()` called inside a `tx()` is
 *    detected through `AsyncLocalStorage`, so it inherits the open transaction
 *    (a `SAVEPOINT`, rolled back alone on failure) instead of deadlocking
 *    against the mutex its own caller is holding.
 *  - **A repository call outside a transaction autocommits.** It is one
 *    statement, and it takes the same mutex, so it can never land in the middle
 *    of somebody else's transaction. The same call *inside* a transaction —
 *    `authority().repos.x` where the tx callback's own `repos` was meant —
 *    runs on the open transaction rather than hanging, because the alternative
 *    is a deadlock nobody can read from a stack trace.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { HostedError } from "@/lib/hosted/contracts";
import { createRepos, promiseRepos, type Repos } from "./repos";
import { migrate } from "./schema";
import { transactAsync, type TransactOptions } from "./tx";
import type { Authority } from "./types";

/** The SQLite implementation. `connection` is not on `Authority` on purpose. */
export interface SqliteAuthority extends Authority {
  kind: "sqlite";
  /** The live connection. Reachable only through `sqliteConnection()`. */
  connection: DatabaseSync;
}

/** How a SQLite authority is built. */
export interface SqliteAuthorityOptions {
  /** Called after the connection is closed — lifecycle uses it to forget the singleton. */
  onClose?: () => void;
}

/**
 * True while this async context is inside a `tx()` callback of this authority.
 * Promise continuations inherit it, so an `await` inside the callback does not
 * lose the fact that a transaction is open.
 */
const inTransaction = new AsyncLocalStorage<{ db: DatabaseSync }>();

const noop = (): void => {};

/** Build the SQLite authority for an open, migrated connection. */
export function createSqliteAuthority(
  db: DatabaseSync,
  file: string,
  opts: SqliteAuthorityOptions = {}
): SqliteAuthority {
  // The mutex. `chain` always settles — its rejections are swallowed here, and
  // reported to the caller that owns them through the promise it was handed.
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(run: () => T | Promise<T>): Promise<T> => {
    const result = chain.then(run, run);
    chain = result.then(noop, noop);
    return result;
  };

  const sync = createRepos(db);

  /** Repositories for a `tx()` callback: the transaction is open, run now. */
  const txRepos = promiseRepos(sync, async (call) => call());

  /**
   * Repositories on the authority itself: one statement, autocommitted, behind
   * the mutex — unless this context is already inside a transaction, in which
   * case the statement belongs to it.
   */
  const repos = promiseRepos(sync, (call) =>
    inTransaction.getStore() ? Promise.resolve().then(call) : exclusive(call)
  );

  const authority: SqliteAuthority = {
    kind: "sqlite",
    path: file,
    connection: db,
    repos,

    tx<T>(fn: (repos: Repos) => Promise<T>, txOpts?: TransactOptions): Promise<T> {
      const run = (): Promise<T> => inTransaction.run({ db }, () => transactAsync(db, () => fn(txRepos), txOpts));
      // Nesting is decided by *this* async context, never by `db.isTransaction`:
      // while one awaited transaction is open the connection reports a
      // transaction to everybody, and a second flow that read that flag would
      // open a savepoint inside a transaction it does not own — and lose it the
      // moment the owner committed. Taking the mutex is what makes that second
      // flow wait instead. Inside our own callback the mutex is already held, so
      // `transactAsync` opens a savepoint.
      if (inTransaction.getStore()) return run();
      return exclusive(run);
    },

    async migrate(): Promise<void> {
      await exclusive(() => {
        migrate(db);
      });
    },

    async close(): Promise<void> {
      try {
        if (db.isOpen) db.close();
      } catch {
        /* closing twice is not a failure worth propagating */
      }
      opts.onClose?.();
    },
  };
  return authority;
}

/**
 * The raw connection behind a SQLite authority.
 *
 * For tests, migration tooling and diagnostics — the things that are allowed to
 * know which database this is. Nothing in `src/` that a Postgres authority will
 * also serve may call it: that is the whole reason the connection is not on
 * `Authority`.
 */
export function sqliteConnection(a: Authority): DatabaseSync {
  if (a.kind !== "sqlite")
    throw new HostedError("internal", `This authority is ${a.kind}, so it has no SQLite connection to hand out.`, {
      fix: "Use the repositories and tx() instead of the connection; they are the surface both implementations share.",
    });
  return (a as SqliteAuthority).connection;
}
