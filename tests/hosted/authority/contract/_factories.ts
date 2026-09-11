/**
 * The authority implementations the contract suite runs against, and the two
 * things a scenario needs from one: an open `Authority`, and a way to state a
 * raw statement that means the same thing on both stores.
 *
 * One row always (SQLite, on this run's own temporary file) and a second only
 * when it is asked for. The Postgres row needs **both**
 * `ZENITH_CONTRACT_POSTGRES=1` and `SUPABASE_DB_URL`, and the two conditions do
 * different jobs: the URL says a database exists, and the flag says you meant
 * it — because this runs against a **real** Supabase project, not a fixture,
 * and a suite that silently started writing to whatever `.env.local` points at
 * would be a very unpleasant surprise. Unset anywhere (CI, a fresh clone, the
 * default `npx vitest run`) the table has exactly one row.
 *
 * That is also why the skip is loud: `contract.test.ts` prints a line naming
 * both variables. A contract suite that appears to pass because half of it did
 * not run is worse than one that fails.
 *
 * ## Why there is a raw escape at all
 *
 * Three of the scenarios are about **partial unique indexes** — database
 * properties that no repository exposes and that no amount of repository calls
 * can prove directly. Two of the three (`app_grants_active`,
 * `hosted_events_logical`) sit on tables whose Postgres repositories belong to
 * later packages, so in this build there is no repository to reach them with on
 * that side at all. Proving them through `raw()` is not a shortcut around the
 * repositories; it is the only way to assert the thing itself, and it is the
 * assertion that will catch a migration that quietly dropped a `WHERE` clause.
 *
 * `raw()` takes one statement in a tiny shared dialect and each factory
 * translates it: `{{h}}` becomes `hosted.` on Postgres and nothing on SQLite,
 * and `?` placeholders become `$1`, `$2`… on Postgres. Nothing else differs,
 * because the migration is a literal translation of the same schema.
 *
 * Nothing here imports application code at module scope — the test file pins
 * `ZENITH_DATA` before its first import, and a static import here would run
 * first.
 */
import type { Authority } from "@/lib/hosted/authority";

/** One implementation under test. */
export interface AuthorityFactory {
  /** Shown in the test name. */
  name: string;
  /** Open it. Called once per suite. */
  open: () => Promise<Authority>;
  /** Run one statement in the shared dialect; answers with the rows it returned. */
  raw: (statement: string, params?: readonly unknown[]) => Promise<Record<string, unknown>[]>;
  /** Delete this run's rows and release the connection. Called from `afterAll`. */
  close: (a: Authority) => Promise<void>;
}

/**
 * The id prefix every row this suite writes carries, so cleanup deletes exactly
 * what the run created and never anything else. Two runs against one project
 * must not collide, so the tail is random per process.
 */
export const CONTRACT_PREFIX = `contract-${Math.random().toString(36).slice(2, 10)}`;

/** A unique id inside this run's namespace. Every id the suite writes uses it. */
export const contractId = (label: string): string =>
  `${CONTRACT_PREFIX}-${label}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * The hex namespace for the columns the schema constrains to 64 hex characters
 * — `artifacts.digest`, `app_sessions.id`, `app_exchanges.code_hash`,
 * `app_invites.token_hash`, `hosted_jobs.intent_hash`. `contract-` is not hex,
 * so those rows carry this instead and cleanup filters on it the same way.
 */
export const CONTRACT_HEX = Array.from({ length: 12 }, () =>
  Math.floor(Math.random() * 16).toString(16)
).join("");

/** A 64-character hex id inside this run's namespace. */
export const contractHex = (): string =>
  (CONTRACT_HEX + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("")).slice(
    0,
    64
  );

/** Is the Postgres row in play? Both conditions, or neither. */
export const postgresContractEnabled = (): boolean =>
  process.env.ZENITH_CONTRACT_POSTGRES === "1" && Boolean(process.env.SUPABASE_DB_URL);

/** What to print when it is not. Names both variables, so enabling it is one read. */
export const postgresSkipReason = (): string => {
  const missing: string[] = [];
  if (process.env.ZENITH_CONTRACT_POSTGRES !== "1") missing.push("ZENITH_CONTRACT_POSTGRES=1");
  if (!process.env.SUPABASE_DB_URL) missing.push("SUPABASE_DB_URL=<Supavisor pooler URI>");
  return missing.join(" and ");
};

/**
 * Every table this suite writes, and the column carrying this run's namespace,
 * **in reverse foreign-key order**.
 *
 * The order is the contract: `app_exchanges` references `app_sessions`, which
 * references `app_grants`, which references `apps`; `releases` references
 * `artifacts`, and `apps.active_release_id` references `releases`. Deleting in
 * this order never trips a foreign key, which is what lets cleanup be a plain
 * loop rather than a puzzle.
 */
export const CONTRACT_CLEANUP: readonly { table: string; column: string; hex?: boolean }[] = [
  { table: "hosted_events", column: "id" },
  { table: "app_exchanges", column: "code_hash", hex: true },
  { table: "app_sessions", column: "id", hex: true },
  { table: "invite_deliveries", column: "id" },
  { table: "app_invites", column: "id" },
  { table: "app_grants", column: "id" },
  { table: "hosted_outbox", column: "id" },
  { table: "hosted_jobs", column: "id" },
  { table: "releases", column: "id" },
  { table: "artifacts", column: "digest", hex: true },
  { table: "quota_counters", column: "app_id" },
  { table: "usage_ledger", column: "id" },
  { table: "revocation_ledger", column: "app_id" },
  { table: "backup_manifests", column: "id" },
  { table: "apps", column: "id" },
];

/** `{{h}}` → nothing, `?` stays. */
const forSqlite = (statement: string): string => statement.replaceAll("{{h}}", "");

/** `{{h}}` → `hosted.`, `?` → `$1`, `$2`, … in order. */
function forPostgres(statement: string): string {
  let n = 0;
  return statement.replaceAll("{{h}}", "hosted.").replace(/\?/g, () => `$${++n}`);
}

/** The factory table. `describe.each` reads it. */
export async function loadAuthorities(): Promise<AuthorityFactory[]> {
  const { openAuthority, closeAuthority, sqliteConnection } = await import("@/lib/hosted/authority");

  const factories: AuthorityFactory[] = [
    {
      name: "SqliteAuthority",
      open: async () => openAuthority(),
      raw: async (statement, params = []) => {
        const { authority } = await import("@/lib/hosted/authority");
        const db = sqliteConnection(authority());
        // SQLite has no boolean storage class; the schema stores flags as 0/1
        // under a CHECK, where the migration made them real Postgres booleans.
        const bound = params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p));
        const prepared = db.prepare(forSqlite(statement));
        if (!/^\s*select/i.test(statement) && !/returning/i.test(statement)) {
          prepared.run(...(bound as never[]));
          return [];
        }
        return prepared.all(...(bound as never[])) as unknown as Record<string, unknown>[];
      },
      close: async () => closeAuthority(),
    },
  ];

  if (postgresContractEnabled())
    factories.push({
      name: "PostgresAuthority",
      open: async () => {
        const { createPostgresAuthority } = await import("@/lib/hosted/authority");
        const a = createPostgresAuthority();
        // Fail here, with the migration file named, rather than inside the
        // first scenario with a missing-relation error.
        await a.migrate();
        return a;
      },
      raw: async (statement, params = []) => {
        const { pgAuthorityClient } = await import("@/lib/hosted/authority/pg/client");
        const rows = await pgAuthorityClient().unsafe(forPostgres(statement), params as never[]);
        return rows as unknown as Record<string, unknown>[];
      },
      close: async (a) => {
        await cleanupPostgresContract();
        await a.close();
      },
    });

  return factories;
}

/**
 * Remove this run's Postgres rows, in reverse foreign-key order.
 *
 * `apps.active_release_id` points at `releases`, so it is cleared before the
 * releases go — otherwise the delete trips the very foreign key this suite is
 * there to prove exists. Safe to call when the Postgres row was never enabled.
 */
export async function cleanupPostgresContract(): Promise<void> {
  if (!postgresContractEnabled()) return;
  const { pgAuthorityClient } = await import("@/lib/hosted/authority/pg/client");
  const sql = pgAuthorityClient();
  await sql`update hosted.apps set active_release_id = null where id like ${`${CONTRACT_PREFIX}%`}`;
  for (const { table, column, hex } of CONTRACT_CLEANUP)
    await sql.unsafe(`delete from hosted.${table} where ${column} like $1`, [
      hex ? `${CONTRACT_HEX}%` : `${CONTRACT_PREFIX}%`,
    ]);
}
