/**
 * The one `postgres` client this process talks to Supabase through.
 *
 * Every option here is a consequence of *where* this runs: Vercel serverless
 * functions in `bom1`, against a free-tier Supabase project in `ap-south-1`,
 * reached through the Supavisor **transaction-mode** pooler on port 6543.
 *
 *  - **`prepare: false` is not a tuning knob, it is a correctness
 *    requirement.** Transaction-mode pooling hands a different backend
 *    connection to the next transaction, so a named prepared statement created
 *    on one backend is simply absent on the next — the classic
 *    `prepared statement "s1" does not exist`. Turning named prepares off makes
 *    every statement self-contained. Parameters are still sent out of band, so
 *    nothing about injection changes.
 *  - **`max: 1`.** A serverless invocation serves one request and then freezes;
 *    a pool of ten would hold ten pooler slots that this instance is not using
 *    while a hundred other instances wait for theirs. The free tier's pooler
 *    budget is small enough that one connection per instance is the difference
 *    between "slow" and "no connections available".
 *  - **A short `idle_timeout`.** A frozen instance cannot close anything, so
 *    the connection has to give itself up. Shorter than the pooler's own idle
 *    cutoff, so this side notices first and reconnects rather than discovering
 *    a half-open socket on the next query.
 *  - **A finite `connect_timeout`.** Mumbai to Mumbai is single-digit
 *    milliseconds when it works; ten seconds of waiting means it is not going
 *    to work, and a request that fails saying so is worth more than one that
 *    hangs until the platform kills it.
 *
 * **The URL is never logged, never in an error, never in a message.** It
 * carries the database password. `env.ts` already redacts `SUPABASE_DB_URL`;
 * nothing here undoes that.
 */
import postgres from "postgres";
import { HostedError } from "@/lib/hosted/contracts";
import { env } from "@/lib/env";

/** The tag function, as everything in this directory passes it around. */
export type Sql = postgres.Sql<Record<string, never>>;

/** The same tag, bound to an open transaction. What `tx()` hands its repositories. */
export type TransactionSql = postgres.TransactionSql<Record<string, never>>;

/** How long an unused connection is kept before it is closed, in seconds. */
export const PG_IDLE_TIMEOUT_S = 20;

/** How long a connection attempt may take before it is a failure, in seconds. */
export const PG_CONNECT_TIMEOUT_S = 10;

type PgGlobal = typeof globalThis & { __zenithHostedPg?: Sql };

/**
 * The connection string, or a refusal naming the variable to set.
 *
 * Read at call time rather than at import: the file store is the default, and
 * an install with no Postgres configuration at all must keep booting.
 */
export function hostedDatabaseUrl(): string {
  const url = env().SUPABASE_DB_URL;
  if (!url)
    throw new HostedError(
      "internal",
      "The hosted control authority is configured for Postgres (ZENITH_HOSTED_STORE=postgres) but SUPABASE_DB_URL is not set, so there is nothing to connect to.",
      {
        fix: "Set SUPABASE_DB_URL to the Supavisor transaction-mode pooler URI (port 6543) from the Supabase dashboard, or set ZENITH_HOSTED_STORE=sqlite to use the embedded control authority.",
      }
    );
  return url;
}

/**
 * The process-wide client, created on first use.
 *
 * Held on `globalThis` for the same reason the SQLite connection is: Next.js
 * re-evaluates modules on hot reload, and a module-scoped variable would leak a
 * second pool on every edit.
 */
export function pgAuthorityClient(): Sql {
  const g = globalThis as PgGlobal;
  if (g.__zenithHostedPg) return g.__zenithHostedPg;
  return (g.__zenithHostedPg = createPgAuthorityClient(hostedDatabaseUrl()));
}

/** Build a client for one connection string. Exported for tests and tooling. */
export function createPgAuthorityClient(url: string): Sql {
  return postgres(url, {
    max: 1,
    idle_timeout: PG_IDLE_TIMEOUT_S,
    connect_timeout: PG_CONNECT_TIMEOUT_S,
    // See the header: transaction-mode pooling forbids named prepares.
    prepare: false,
    // No `search_path` startup parameter: Supavisor is free to refuse a
    // non-default one in transaction mode, and every statement in this
    // directory names its schema anyway (`hosted.hosted_jobs`, never
    // `hosted_jobs`). Nothing here ever touches `public`, which belongs to the
    // system of record (0001_system_of_record.sql).
    //
    // The driver's own logging would put the connection string's host — and,
    // on some failures, its parameters — into stdout. Everything worth saying
    // is said by the HostedError this module raises.
    onnotice: () => {},
  }) as Sql;
}

/** Close the process-wide client and forget it. Tests and scripts; a server exits. */
export async function closePgAuthorityClient(): Promise<void> {
  const g = globalThis as PgGlobal;
  const existing = g.__zenithHostedPg;
  delete g.__zenithHostedPg;
  if (!existing) return;
  try {
    await existing.end({ timeout: 5 });
  } catch {
    /* closing twice, or closing a client that never connected, is not a failure */
  }
}

/**
 * The identity of the database, for `Authority.path` — host, port and database
 * name, and **never** the user or the password.
 *
 * Diagnostics print this. A connection string that could not be parsed answers
 * with a fixed placeholder rather than a substring of itself, because the one
 * thing worse than an unhelpful identity is half a credential in a log line.
 */
export function pgIdentity(url: string): string {
  try {
    const parsed = new URL(url);
    const database = parsed.pathname.replace(/^\//, "") || "postgres";
    return `postgres://${parsed.host}/${database}`;
  } catch {
    return "postgres://<unparseable SUPABASE_DB_URL>";
  }
}
