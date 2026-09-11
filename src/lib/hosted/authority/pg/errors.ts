/**
 * Classifying what Postgres reports, and saying it in the same words SQLite's
 * authority does.
 *
 * The point of two implementations behind one interface is that a caller
 * cannot tell which it got — and a caller that catches `HostedError` and reads
 * `.code` is the caller most likely to notice a difference. So the mapping
 * here is deliberately not "the natural Postgres wording": it is the *same*
 * `HostedError` code, with a message that says the same thing about the same
 * situation, for every condition `authority/tx.ts` and `authority/sql.ts`
 * already classify on SQLite.
 *
 * | Situation | SQLite | Postgres |
 * | --- | --- | --- |
 * | Another writer held the database through every attempt | `SQLITE_BUSY`/`SQLITE_LOCKED` → `policy_unavailable` | `40001`/`40P01`/`53300`/`08006`/`08003` → `policy_unavailable` |
 * | A UNIQUE or PRIMARY KEY row already exists | extended codes 2067/1555 | SQLSTATE `23505` |
 *
 * The retryable set is wider than "the transaction conflicted" on purpose, and
 * each member is there because the *whole* transaction can be replayed safely:
 *
 *  - `40001` serialization_failure and `40P01` deadlock_detected — the classic
 *    two. Postgres has already rolled the transaction back.
 *  - `53300` too_many_connections — the free tier's pooler is out of slots.
 *    Nothing ran, so replaying after a backoff is exactly right.
 *  - `08006` connection_failure and `08003` connection_does_not_exist — the
 *    pooler recycled the backend under us. This is the one that needs care:
 *    the connection can drop *after* a COMMIT was sent and before its
 *    acknowledgement arrived, in which case a replay repeats work that already
 *    committed. Every transaction in this authority is therefore built to be
 *    replay-safe the same way the SQLite one is — conditional UPDATEs,
 *    `on conflict do nothing` inserts, idempotency keys — which is the rule
 *    `tx()`'s contract already states ("`fn` may run more than once").
 */
import { HostedError } from "@/lib/hosted/contracts";

/** SQLSTATEs whose whole transaction is safe to replay. See the header. */
export const PG_RETRYABLE_CODES = ["40001", "40P01", "53300", "08006", "08003"] as const;

/** SQLSTATE for a unique or primary key violation. */
export const PG_UNIQUE_VIOLATION = "23505";

/** SQLSTATE for a foreign key violation. */
export const PG_FOREIGN_KEY_VIOLATION = "23503";

/** SQLSTATE for a CHECK constraint violation. */
export const PG_CHECK_VIOLATION = "23514";

/** SQLSTATE for "that relation does not exist" — an unapplied migration, usually. */
export const PG_UNDEFINED_TABLE = "42P01";

interface PgError extends Error {
  code?: unknown;
  constraint_name?: unknown;
}

/** The SQLSTATE Postgres reported, or undefined for anything that is not a database error. */
export function pgErrorCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const code = (err as PgError).code;
  return typeof code === "string" ? code : undefined;
}

/** The constraint a violation names, when the driver reported one. */
export function pgConstraintName(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const name = (err as PgError).constraint_name;
  return typeof name === "string" ? name : undefined;
}

/** True when replaying the whole transaction is the right response. */
export function isRetryable(err: unknown): boolean {
  const code = pgErrorCode(err);
  return code !== undefined && (PG_RETRYABLE_CODES as readonly string[]).includes(code);
}

/**
 * True for a UNIQUE or PRIMARY KEY constraint violation.
 *
 * Deliberately the same name and the same meaning as `sql.ts`'s function, so
 * `repos/jobs.ts`-shaped code — "a UNIQUE failure here means the single-flight
 * index" — reads identically in both implementations.
 */
export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === PG_UNIQUE_VIOLATION;
}

/**
 * The refusal after every attempt was used up.
 *
 * The same `policy_unavailable` code and the same promise SQLite's busy error
 * makes — "this change was not made and nothing was half-written" — because
 * that is the property a caller acts on, and it is true here for the same
 * reason: the transaction was rolled back before the last attempt was counted.
 */
export function exhausted(err: unknown, attempts: number): HostedError {
  const code = pgErrorCode(err) ?? "unknown";
  return new HostedError(
    "policy_unavailable",
    `The hosted control database could not complete this change through ${attempts} attempt${attempts === 1 ? "" : "s"} (Postgres reported ${code} each time), so this change was not made and nothing was half-written.`,
    {
      fix: "Retry the request. If it keeps happening, check the Supabase project's connection and CPU usage — a free-tier pooler that is out of connections reports 53300, and a hot row under two writers reports 40001.",
      details: { attempts, reason: "postgres_retry_exhausted", sqlstate: code },
    }
  );
}
