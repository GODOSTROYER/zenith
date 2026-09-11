/**
 * The Postgres control authority: the same `Authority` a caller already has,
 * over Supabase rather than a file.
 *
 * ## Why it does not apply migrations
 *
 * `migrate()` here **reads** `hosted.schema_migrations` and refuses to boot if
 * the newest version in `MIGRATIONS` is missing. It does not run any DDL. The
 * SQLite authority applies its migrations on open because there is exactly one
 * process and exactly one file; this one runs as a serverless function that can
 * start a hundred copies of itself in a second, and a hundred copies racing
 * `CREATE TABLE` against a free-tier pooler is not a migration strategy — it is
 * an outage with a schema in it. So `supabase/migrations/0002_hosted_authority.sql`
 * is applied by hand, deliberately, by whoever owns the project, and this
 * checks that it was.
 *
 * The refusal names the file. "Schema out of date" with nothing to run is the
 * error that costs an afternoon.
 *
 * ## Why the check is not awaited at construction
 *
 * `ensureHosted()` is synchronous — deliberately, so `boot()` cannot proceed
 * with the authority half-open — and a network round trip is not. So
 * `createPostgresAuthority()` returns synchronously with the check *in flight*,
 * and every `tx()` and every repository call awaits it before its first
 * statement. The check therefore still gates every read and every write; it
 * just does not gate the construction of the object that will do them. A failed
 * check is remembered, not retried into a storm: the same rejection is handed
 * to every caller until the process restarts.
 *
 * ## What is here
 *
 * Every repository of the control authority has a Postgres implementation
 * under `repos/`, each a statement-for-statement twin of its SQLite
 * counterpart. `createPostgresAuthority()` is a whole `Authority`; the
 * cross-store contract suites under `tests/hosted/authority/contract/` are
 * what hold the two implementations to the same answers.
 */
import { HostedError } from "@/lib/hosted/contracts";
import { MIGRATIONS } from "../schema";
import type { Repos } from "../repos";
import type { TransactOptions } from "../tx";
import type { Authority } from "../types";
import {
  closePgAuthorityClient,
  hostedDatabaseUrl,
  pgAuthorityClient,
  pgIdentity,
  type Sql,
} from "./client";
import { bindPgRepos } from "./repos";
import { readAppliedMigrations } from "./repos/migrations";
import { currentPgTransaction, transactPg } from "./tx";

/** The Postgres implementation. Nothing on it that `Authority` does not have. */
export interface PostgresAuthority extends Authority {
  kind: "postgres";
}

/** How a Postgres authority is built. */
export interface PostgresAuthorityOptions {
  /** Override the client. Tests and the contract harness pass their own. */
  client?: Sql;
  /** Override the identity used for `path`. Defaults to the URL's host and database. */
  identity?: string;
  /** Called after the client is closed — lifecycle uses it to forget the singleton. */
  onClose?: () => void;
}

/** The newest version this build expects to find recorded in the database. */
const newestMigration = (): { version: number; name: string } => {
  const newest = MIGRATIONS[MIGRATIONS.length - 1];
  return { version: newest.version, name: newest.name };
};

/** The refusal when the database has not been brought up to this build's schema. */
function schemaBehind(found: number[], expected: { version: number; name: string }): HostedError {
  return new HostedError(
    "internal",
    found.length === 0
      ? `The hosted control database has no hosted.schema_migrations rows, so its schema has never been applied, and this build needs version ${expected.version} ("${expected.name}").`
      : `The hosted control database records schema versions ${found.join(", ")}, and this build needs version ${expected.version} ("${expected.name}"), which is not among them.`,
    {
      fix: "Apply supabase/migrations/0002_hosted_authority.sql to the Supabase project (SQL editor, or `psql` against SUPABASE_DB_URL) and start again. It is idempotent, so re-applying it is safe. Nothing was read or written in the meantime.",
      details: { found, expected: expected.version, file: "supabase/migrations/0002_hosted_authority.sql" },
    }
  );
}

type AnyRepo = Record<string, (...args: unknown[]) => Promise<unknown>>;

/**
 * The repository set on the authority itself, with two things deferred to call
 * time rather than decided here.
 *
 * The **schema check** is awaited before the first statement of every call, so
 * a build talking to a database that never had `0002_hosted_authority.sql`
 * applied says so instead of reporting a missing relation.
 *
 * The **connection** is resolved per call, not per property read: a call made
 * inside a `tx()` callback runs on that transaction's tag, and whether this
 * async context is inside one can change between reading `authority().repos`
 * and invoking the method on it.
 *
 * The method *names* come from one binding built here, which is safe because
 * the shape never varies — only what each method is bound to does.
 */
function deferredRepos(bind: () => Repos, ready: () => Promise<void>): Repos {
  const shape = bind() as unknown as Record<string, AnyRepo>;
  const out: Record<string, AnyRepo> = {};
  for (const table of Object.keys(shape)) {
    const repo: AnyRepo = {};
    for (const method of Object.keys(shape[table])) {
      repo[method] = async (...args: unknown[]) => {
        await ready();
        return ((bind() as unknown as Record<string, AnyRepo>)[table][method] as (
          ...a: unknown[]
        ) => Promise<unknown>)(...args);
      };
    }
    out[table] = repo;
  }
  return out as unknown as Repos;
}

/**
 * Build the Postgres authority. Synchronous, because `ensureHosted()` is.
 *
 * Throws straight away when `SUPABASE_DB_URL` is unset — that is a
 * configuration fact, not a network one, and there is no reason to defer it.
 */
export function createPostgresAuthority(opts: PostgresAuthorityOptions = {}): PostgresAuthority {
  // Read before anything else, so an install that asked for Postgres and gave
  // no URL is told which variable to set rather than told about a connection.
  const identity = opts.identity ?? pgIdentity(hostedDatabaseUrl());
  const client = opts.client ?? pgAuthorityClient();

  /**
   * The schema check, started once and awaited by everything.
   *
   * A rejection is kept and re-thrown to every later caller rather than
   * retried: a hundred instances re-checking a schema that is still missing is
   * load the project does not need, and the answer will not have changed
   * without somebody applying the file.
   */
  let checked: Promise<void> | undefined;
  const ready = (): Promise<void> => {
    if (!checked)
      checked = (async () => {
        const expected = newestMigration();
        const applied = await readAppliedMigrations(client);
        const versions = applied.map((m) => m.version);
        if (!versions.includes(expected.version)) throw schemaBehind(versions, expected);
      })();
    return checked;
  };

  /**
   * Repositories on the authority itself: one statement, autocommitted — unless
   * this async context is already inside a transaction, in which case the
   * statement belongs to it.
   *
   * The second half is the same courtesy `sqlite.ts` extends: reaching for
   * `authority().repos` inside a `tx()` callback where the callback's own
   * `repos` were meant is a mistake, and joining the open transaction is a
   * kinder answer than a second connection quietly committing on its own.
   */
  const repos = deferredRepos(() => bindPgRepos(currentPgTransaction() ?? client), ready);

  const authority: PostgresAuthority = {
    kind: "postgres",
    path: identity,
    repos,

    async tx<T>(fn: (repos: Repos) => Promise<T>, txOpts?: TransactOptions): Promise<T> {
      await ready();
      return transactPg(client, (sql) => fn(bindPgRepos(sql)), txOpts);
    },

    /**
     * Read the applied versions and refuse if this build's newest is missing.
     * Idempotent, and the same promise the first repository call awaits — so
     * calling it on the boot path costs one round trip, not two.
     */
    migrate(): Promise<void> {
      return ready();
    },

    async close(): Promise<void> {
      // Only the process-wide client is this authority's to close. A client
      // handed in by a test belongs to the test, which closes it itself.
      if (!opts.client) await closePgAuthorityClient();
      opts.onClose?.();
    },
  };
  return authority;
}
