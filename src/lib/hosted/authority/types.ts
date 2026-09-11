/**
 * What the control authority is, independently of what is storing it.
 *
 * One interface, two implementations to come: the SQLite authority this
 * process opens today (`sqlite.ts`) and a Postgres one later. Every method is
 * a Promise, including the ones SQLite answers without ever yielding, because
 * the whole point is that no call site has to know which it is talking to —
 * `await` is the only thing a caller says either way.
 *
 * There is deliberately no connection on this interface. A raw `DatabaseSync`
 * is a SQLite fact, and a caller holding one is a caller that cannot be moved.
 * Anything that needs a query the repositories do not have gets a repository
 * method, not the connection.
 */
import type { Repos } from "./repos";
import type { TransactOptions } from "./tx";

/** The open control authority: its transaction rule, its tables, its lifecycle. */
export interface Authority {
  /** Which implementation this is. The only thing a caller may branch on. */
  kind: "sqlite" | "postgres";
  /**
   * Where the authority lives: the absolute path of the database file for
   * SQLite, and the identity of the database for anything else. Diagnostics and
   * backups read it; nothing decides behaviour from its contents.
   */
  path: string;
  /**
   * Run `fn` in one durable transaction and resolve with its value.
   *
   * Commit-before-ACK: this resolves only after `COMMIT` succeeded. Use the
   * `repos` handed to `fn` — they run on this transaction; `authority().repos`
   * outside it would be a separate autocommitted statement everywhere but
   * SQLite, where a single connection makes the mistake invisible.
   *
   * `fn` may run more than once — a transaction the database reports busy is
   * rolled back whole and replayed — so it must be database work only: no
   * counters in module scope, no file writes, no sends. Anything that has to
   * leave the process is an outbox row written inside the same transaction.
   */
  tx<T>(fn: (repos: Repos) => Promise<T>, opts?: TransactOptions): Promise<T>;
  /**
   * One repository per table. Outside a transaction each call is a single
   * autocommitted statement; a sequence of them is a sequence of transactions,
   * which is why anything that must be atomic goes through `tx()`.
   */
  repos: Repos;
  /** Apply outstanding migrations. Idempotent; the open path already calls it. */
  migrate(): Promise<void>;
  /** Release the connection. Safe to call twice. */
  close(): Promise<void>;
}
