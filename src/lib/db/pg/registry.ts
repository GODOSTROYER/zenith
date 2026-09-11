/**
 * The per-collection knowledge the Postgres store used to hard-code.
 *
 * ## How to add a collection / replace a delegate
 *
 * To add a collection, create your own file under `src/lib/db/pg/` (do **not**
 * edit this one or `./core.ts`), export nothing but a side effect, and call
 * `registerCollection({ ... })` once per table: give it the `collection` name,
 * its `table`, the `promote`/`rename` pair that says which columns live outside
 * `data`, a `key` that names the primary key as PostgREST filters, a `tenant`
 * that answers "which workspace owns this row", a `rows` accessor pointing at
 * the live array in `Database` (omit it for a singleton bag the store writes by
 * hand, as `settings` does), and a `prefetch` round — 1 for the tables that
 * answer "who is this caller", 2 for anything filtered by workspace id, 3 for
 * anything filtered by what round 2 loaded. **Registration order is foreign-key
 * order**: writes run down the list and deletes run back up it, so register a
 * parent before its children, and import your file from `./core.ts`'s importer
 * (`postgres-store.ts`) side-by-side with the others. To replace a delegated
 * method group (manifests, events, audit — everything Phase 3 still hands to
 * `FileStore`), do not touch `postgres-store.ts` either: call
 * `setDelegate("audit", myImpl)` from your own module. Both APIs exist so four
 * agents can extend this store in parallel without ever editing one file twice.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../types";

/** The install-global settings bag's reserved row id. See the migration. */
export const INSTALL_SETTINGS_ID = "__install__";

/** One row as PostgREST hands it back. */
export interface PgRow {
  id?: string;
  workspace_id?: string;
  data?: Record<string, unknown>;
  version?: number;
  [column: string]: unknown;
}

/**
 * A registered collection's name. Deliberately not a closed union: the registry
 * is open, and a Phase-3 agent adds a name from its own file.
 */
export type PgCollection = string;

/* ---------------------------------- tenant --------------------------------- */

/**
 * `Environment` carries no `workspaceId` in the domain model — it reaches its
 * tenant through its project. The column is not optional in the database
 * (uniform shape, and the prefetch filters on it), so the store carries it on
 * the object as a non-enumerable property: invisible to `JSON.stringify`, so no
 * response body or snapshot gains a field, and readable by the flush.
 */
const TENANT = Symbol.for("zenith.workspaceId");

type Tenanted = { [TENANT]?: string };

export const tenantOf = (row: object, fallback = ""): string =>
  (row as Tenanted)[TENANT] ?? (row as { workspaceId?: string }).workspaceId ?? fallback;

export const setTenant = (row: object, workspaceId: string): void => {
  if ((row as { workspaceId?: string }).workspaceId) return;
  Object.defineProperty(row, TENANT, { value: workspaceId, enumerable: false, writable: true });
};

/* -------------------------------- hydration -------------------------------- */

/** Timestamps are stored as `timestamptz` and read back in Postgres' format. */
const TIMESTAMP_FIELDS = ["createdAt", "acceptedAt", "lastCheckedAt"];

/**
 * `{ ...row.data, ...promoted }`, with the promoted columns renamed back.
 *
 * Hydration is this for every table, so an object read back here is
 * indistinguishable from the one the file store hands out. The promoted columns
 * win on purpose: they are the copy the database indexes, so a divergence must
 * resolve towards what queries would have found.
 */
export function hydrateWith<T>(rename: Record<string, string>): (row: PgRow) => T {
  return (row) => {
    const out: Record<string, unknown> = { ...(row.data ?? {}) };
    out.id = row.id;
    for (const [column, field] of Object.entries(rename)) {
      const value = row[column];
      // A null promoted column means "absent", never `field: null`: the domain
      // types use optional properties and a null would serialise into responses
      // the file store never produces.
      if (value === null || value === undefined) delete out[field];
      else out[field] = column.endsWith("_at") ? String(value) : value;
    }
    for (const f of TIMESTAMP_FIELDS) {
      const v = out[f];
      if (typeof v === "string") out[f] = new Date(v).toISOString();
    }
    return out as T;
  };
}

/** A promoted timestamp column, or null when the field is absent. */
export const iso = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/* --------------------------------- prefetch -------------------------------- */

/** What one round of the snapshot load knows when it builds its queries. */
export interface PrefetchContext {
  client: SupabaseClient;
  /** null means "load everything" — a script, a migration or a test. */
  user: { id: string; email: string } | null;
  /** workspace ids the caller belongs to, filled in after round 1 */
  workspaceIds: string[];
  /** project ids loaded in round 2, for the tables that hang off them */
  projectIds: string[];
}

/** One collection's read for its round. */
export type PrefetchQuery =
  | { kind: "all" }
  | { kind: "in"; column: string; values: string[] }
  /** anything the two shapes above cannot say (e.g. `members`' id-or-email or). */
  | { kind: "custom"; run: () => Promise<PgRow[]> };

/* --------------------------------- adapters -------------------------------- */

/** Where a collection's tenant answer comes from, load-time or diff-time. */
export interface TenantContext {
  /** the database row it was read from — present only during a load */
  row?: PgRow;
  /** the live graph — present only during a diff */
  db?: Database;
}

export interface CollectionAdapter<T extends { id: string } = { id: string }> {
  /** The collection name; also the baseline key prefix. */
  collection: PgCollection;
  /** The table it reads and writes. */
  table: string;
  /** The primary key, as PostgREST filters. `members` is (workspace_id, id). */
  key: (row: { id: string; workspaceId: string }) => Record<string, string>;
  /** Which workspace owns this object. */
  tenant: (row: T, ctx: TenantContext) => string;
  /** Columns promoted out of `data`, in the order the migration declares them. */
  promote: (row: T) => Record<string, unknown>;
  /** Promoted column → domain field. Drives `hydrate` and `data` stripping. */
  rename: Record<string, string>;
  /** One row as the domain object. */
  hydrate: (row: PgRow) => T;
  /** Which round loads it, and the filter for that round. */
  prefetch: {
    round: 1 | 2 | 3;
    filter: (ctx: PrefetchContext) => PrefetchQuery;
    /** Feed the context for later rounds (workspace ids, project ids). */
    provides?: (rows: PgRow[], ctx: PrefetchContext) => void;
  };
  /**
   * The live array in the graph. Omit for a singleton bag the store writes
   * itself (`settings`); such a collection is loaded but never diffed.
   */
  rows?: (db: Database) => { id: string }[];
  /** True when the primary key is (workspace_id, id) rather than id alone. */
  scopedByWorkspace?: boolean;
}

const REGISTRY = new Map<PgCollection, CollectionAdapter<never>>();

/**
 * Register one collection. Registration order is foreign-key order: a workspace
 * before its members, a project before its environments. Re-registering a name
 * replaces it in place (HMR, and a test that swaps one out).
 */
export function registerCollection<T extends { id: string }>(adapter: CollectionAdapter<T>): void {
  REGISTRY.set(adapter.collection, adapter as unknown as CollectionAdapter<never>);
}

/** Every adapter, in registration (= foreign-key) order. */
export const adapters = (): CollectionAdapter<never>[] => [...REGISTRY.values()];

/** Only the ones the generic diff owns — i.e. those with a `rows` accessor. */
export const rowAdapters = (): CollectionAdapter<never>[] =>
  adapters().filter((a) => a.rows !== undefined);

/** One adapter by name. Throws rather than writing to the wrong table. */
export function adapterFor(collection: PgCollection): CollectionAdapter<never> {
  const adapter = REGISTRY.get(collection);
  if (!adapter)
    throw new Error(
      `No Postgres collection adapter registered for "${collection}". ` +
        `Fix: register one with registerCollection() — see src/lib/db/pg/registry.ts.`
    );
  return adapter;
}

/* --------------------------------- running --------------------------------- */

/** The one error message every table failure wears, so the fix is always stated. */
export function storeError(table: string, op: string, message: string): Error {
  return new Error(
    `Postgres store could not ${op} "${table}": ${message}. ` +
      `Fix: check that supabase/migrations/0001_system_of_record.sql has been applied to the project ` +
      `named by NEXT_PUBLIC_SUPABASE_URL, and that SUPABASE_SERVICE_ROLE_KEY belongs to it.`
  );
}

/** Run one adapter's prefetch for its round. */
export async function runPrefetch(
  adapter: CollectionAdapter<never>,
  ctx: PrefetchContext
): Promise<PgRow[]> {
  const q = adapter.prefetch.filter(ctx);
  if (q.kind === "custom") return q.run();
  if (q.kind === "in" && q.values.length === 0) return [];
  let query = ctx.client.from(adapter.table).select("*");
  if (q.kind === "in") query = query.in(q.column, q.values);
  const { data, error } = await query;
  if (error) throw storeError(adapter.table, "read", error.message);
  return (data ?? []) as PgRow[];
}

/** Only `members` is keyed by (workspace_id, id); the rest are keyed by id alone. */
export const keyScope = (collection: PgCollection, workspaceId: string): string =>
  REGISTRY.get(collection)?.scopedByWorkspace ? workspaceId : "";
