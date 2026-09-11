/**
 * The per-app data plane on Postgres: `PgDataBackend` over PostgREST, and
 * `PgTrackerStore`, the tracker's `AppDataStore` on top of it.
 *
 * This is what `ZENITH_HOSTED_STORE=postgres` selects instead of one SQLite
 * file per app (`open.ts`). It occupies the seam `D1HttpBackend` already
 * occupies — {@link AsyncDataBackend}, the promise-returning twin of
 * `DataBackend` — so the statements in `sql.ts` stay the single description of
 * what the tracker asks a database for, and the broker worker contract is
 * untouched.
 *
 * ## Isolation
 *
 * On SQLite an app reaches only its own records because it opens only its own
 * file, and no statement in `sql.ts` names an app. That property cannot survive
 * verbatim in a shared database, so it is rebuilt one level down: every hosted
 * table's primary key starts with `app_id`, one `PgDataBackend` is bound to one
 * app id at construction, and every request it builds carries
 * `app_id = eq.<that id>`. There is no method here that takes an
 * app id per call, so "forgot the WHERE clause" is not a mistake this file can
 * make.
 *
 * ## Statement dispatch
 *
 * PostgREST does not execute SQL. `run`/`get`/`all` therefore recognise the
 * named statements from `sql.ts` and issue the equivalent PostgREST request —
 * the mapping is the table in `README.md` and the `switch` in
 * {@link PgDataBackend.execute}. An unrecognised statement is refused loudly
 * rather than approximated: a silent no-op here would look like an empty table.
 *
 * ## What is atomic and what is not
 *
 * The two decisions that must not come apart from their effect stay together:
 *
 *  - **quota admission** is one round trip — the plpgsql function
 *    `hosted.app_record_insert_within_quota` compares, inserts and moves the
 *    counter under one row lock, the counterpart of
 *    `INSERT_REQUEST_WITHIN_QUOTA`'s conditional insert;
 *  - **the version check** is one round trip — the PATCH carries
 *    `version = eq.<expected>`, so zero rows changed means, and only means,
 *    another writer moved the record on, exactly as `UPDATE_REQUEST_CAS` does.
 *
 * TODO(ceiling): what does *not* survive is the outer transaction. On SQLite the
 * record, the counter and the write-id ledger row commit together; here they are
 * separate statements, so a process killed between the accepted insert and the
 * ledger write leaves a record whose write id was never recorded — a retry of
 * that write id would then create a second record. The window is one round trip
 * wide. Closing it needs the whole mutation inside one plpgsql function, which
 * would move the tracker's policy into the database and out of `tracker-store.ts`
 * — the trade the pilot deliberately has not made. Same shape as the D1 note in
 * `backend.ts`.
 */
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  APP_ROLE_RANK,
  type AppDataStore,
  CreateRequestBody,
  DEFAULT_LIMITS,
  type DataContext,
  type EquipmentRequest,
  HostedError,
  ListRequestsQuery,
  type ListRequestsResult,
  TRACKER_LIMITS,
  UpdateRequestBody,
} from "@/lib/hosted/contracts";
import type { AsyncDataBackend, RunResult, SqlParam } from "./backend";
import { logicalBytes } from "./bytes";
import { writeIntentHash } from "./intent";
import { LATEST_TRACKER_SCHEMA_VERSION } from "./schema";
import {
  COUNT_REQUESTS,
  COUNT_WRITES,
  DELETE_WRITES_BEFORE,
  INSERT_REQUEST_WITHIN_QUOTA,
  INSERT_WRITE,
  SELECT_REQUESTS_PAGE,
  SELECT_REQUEST_BY_ID,
  SELECT_STORAGE_BYTES,
  SELECT_WRITE_BY_ID,
  UPDATE_REQUEST_CAS,
  UPDATE_STORAGE_ADD,
} from "./sql";
import {
  type CreateRequestInput,
  type ListRequestsInput,
  type MutationResult,
  type UpdateRequestInput,
} from "./tracker-store";
import {
  type RequestRow,
  appMismatch,
  decodeCursor,
  encodeCursor,
  insertColumns,
  notEditor,
  notFound,
  parseOrThrow,
  quotaExceeded,
  roleNotGranted,
  roleRank,
  staleVersion,
  toRecord,
} from "./tracker-rows";

/** The Postgres schema migration 0003 creates. PostgREST must expose it. */
export const HOSTED_SCHEMA = "hosted";

/**
 * A PostgREST client whose default schema is `hosted`.
 *
 * The third generic parameter is the schema name, and `SupabaseClient`'s default
 * is `"public"` — a plain `SupabaseClient` therefore does not accept a client
 * built with `db: { schema: "hosted" }`. The first two parameters describe a
 * generated `Database` type this project does not generate, so they stay open.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HostedPgClient = SupabaseClient<any, any, typeof HOSTED_SCHEMA>;

/** Table names, so nothing else in this file spells them. */
const TABLE = {
  records: "app_records",
  writes: "app_writes",
  storage: "app_storage",
} as const;

/** The two functions migration 0003 defines. */
const FN = {
  insertWithinQuota: "app_record_insert_within_quota",
  storageAdd: "app_storage_add",
} as const;

/** The promoted columns a record read asks for; `body` carries the rest. */
const RECORD_COLUMNS = "record_id,subject,version,logical_bytes,body,created_at,updated_at";

/** The ledger columns a replay read asks for. */
const WRITE_COLUMNS = "write_id,subject,op,record_id,intent_hash,status_code,result,at";

/* ------------------------------- the backend ------------------------------ */

/** Everything {@link PgDataBackend} needs. Nothing is read from the environment here. */
export interface PgDataBackendOptions {
  /** The app this backend is bound to. Every request carries it. */
  appId: string;
  /**
   * A PostgREST client already pointed at the `hosted` schema. Supply this to
   * inject a double; omit it and one is built from the service-role
   * environment by {@link hostedPgClient}.
   */
  client?: HostedPgClient;
  /** Transport override, used when `client` is omitted. Tests inject a fetch double. */
  fetch?: typeof globalThis.fetch;
}

/** How one PostgREST row of `hosted.app_records` comes back. */
interface PgRecordRow {
  record_id: string;
  subject: string;
  version: number;
  logical_bytes: number;
  body: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** How one PostgREST row of `hosted.app_writes` comes back. */
interface PgWriteRow {
  write_id: string;
  subject: string;
  op: string;
  record_id: string | null;
  intent_hash: string;
  status_code: number;
  result: unknown;
  at: string;
}

/** Shape a PostgREST error arrives in, whichever client built it. */
interface PgErrorLike {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

/**
 * One service-role PostgREST client pointed at the `hosted` schema.
 *
 * Built on first use, never at import: `sqlite` is the default store and an
 * install with no Supabase configuration at all must keep booting. Mirrors
 * `@/lib/supabase/admin`'s contract — service-role key, no session persistence,
 * no token refresh — but adds `db.schema`, because the hosted tables are not in
 * `public`.
 */
export function hostedPgClient(fetchImpl?: typeof globalThis.fetch): HostedPgClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new HostedError(
      "runtime_unavailable",
      "ZENITH_HOSTED_STORE=postgres needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, and one of them is missing.",
      {
        fix: "Add both to .env.local (the service-role key is server-only and must never reach a browser), or set ZENITH_HOSTED_STORE=sqlite to keep app data in per-app files.",
      }
    );
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    db: { schema: HOSTED_SCHEMA },
    ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}),
  });
}

/**
 * `AsyncDataBackend` over PostgREST for one hosted app.
 *
 * Every statement in `sql.ts` that the tracker store issues at request time has
 * a mapping here; the schema statements do not, because migration 0003 creates
 * the tables once for every app rather than per app.
 */
export class PgDataBackend implements AsyncDataBackend {
  /** The app every request from this instance is scoped to. */
  readonly appId: string;

  private readonly client: HostedPgClient;

  constructor(options: PgDataBackendOptions) {
    const appId = typeof options.appId === "string" ? options.appId.trim() : "";
    if (appId.length === 0 || appId.length > 200) {
      throw new HostedError("invalid_input", "An app id is required to reach an app's Postgres data.", {
        fix: "Pass the app's id from the control authority, not its slug or name.",
        details: { issues: [{ path: "appId", code: "custom", message: "must be 1–200 characters" }] },
      });
    }
    this.appId = appId;
    this.client = options.client ?? hostedPgClient(options.fetch);
  }

  async run(sql: string, params: readonly SqlParam[] = []): Promise<RunResult> {
    const { changes } = await this.execute(sql, params);
    return { changes };
  }

  async get<T>(sql: string, params: readonly SqlParam[] = []): Promise<T | undefined> {
    const rows = await this.all<T>(sql, params);
    return rows[0];
  }

  async all<T>(sql: string, params: readonly SqlParam[] = []): Promise<T[]> {
    const { rows } = await this.execute(sql, params);
    return rows as T[];
  }

  /** Stateless HTTP: nothing is held open. Present for interface parity. */
  close(): void {
    // PostgREST is reached over stateless HTTP; there is no connection to release.
  }

  /* ----------------------------- the mapping ----------------------------- */

  /**
   * The one place a `sql.ts` statement becomes a PostgREST request. Adding a
   * statement to `sql.ts` that the store issues means adding a case here; the
   * default arm is what stops that being forgotten silently.
   */
  private async execute(
    sql: string,
    params: readonly SqlParam[]
  ): Promise<{ rows: unknown[]; changes: number }> {
    switch (sql) {
      case SELECT_REQUEST_BY_ID:
        return { rows: await this.selectRecordById(String(params[0])), changes: 0 };
      case SELECT_REQUESTS_PAGE:
        return { rows: await this.selectRecordsPage(params), changes: 0 };
      case SELECT_STORAGE_BYTES:
        return { rows: [{ logical_bytes: await this.storageBytes() }], changes: 0 };
      case SELECT_WRITE_BY_ID:
        return { rows: await this.selectWriteById(String(params[0])), changes: 0 };
      case COUNT_REQUESTS:
        return { rows: [{ total: await this.countRows(TABLE.records) }], changes: 0 };
      case COUNT_WRITES:
        return { rows: [{ total: await this.countRows(TABLE.writes) }], changes: 0 };
      case INSERT_REQUEST_WITHIN_QUOTA:
        return { rows: [], changes: await this.insertRecordWithinQuota(params) };
      case UPDATE_REQUEST_CAS:
        return { rows: [], changes: await this.updateRecordCas(params) };
      case UPDATE_STORAGE_ADD:
        return { rows: [], changes: await this.addStorage(Number(params[0])) };
      case INSERT_WRITE:
        return { rows: [], changes: await this.insertWrite(params) };
      case DELETE_WRITES_BEFORE:
        return { rows: [], changes: await this.deleteWritesBefore(String(params[0])) };
      default:
        throw new HostedError(
          "internal",
          "The Postgres app-data backend was asked to run a statement it has no mapping for.",
          {
            fix: "Add the statement's PostgREST equivalent to PgDataBackend.execute() in src/lib/hosted/data/pg-backend.ts, or issue one of the statements it already maps.",
            details: { statement: sql.trim().split("\n")[0] },
          }
        );
    }
  }

  /** `SELECT … FROM equipment_requests WHERE id = ?` */
  private async selectRecordById(recordId: string): Promise<RequestRow[]> {
    const { data, error } = await this.table(TABLE.records)
      .select(RECORD_COLUMNS)
      .eq("app_id", this.appId)
      .eq("record_id", recordId)
      .limit(1);
    this.refuse(error, "read this app's request");
    return ((data ?? []) as unknown as PgRecordRow[]).map(requestRow);
  }

  /**
   * `SELECT_REQUESTS_PAGE`. Parameters, as `sql.ts` documents them: 1,2 status;
   * 3,4 category; 5,6,7 cursor `created_at`; 8 cursor id; 9 limit. The duplicated
   * binds exist because SQLite has to spell "NULL means no filter" twice per
   * filter; here the same decision is one `if`.
   *
   * The keyset predicate is `created_at < at OR (created_at = at AND id < id)`,
   * the same total order the SQLite statement uses, so a cursor issued by either
   * backend means the same position.
   */
  private async selectRecordsPage(params: readonly SqlParam[]): Promise<RequestRow[]> {
    const status = params[0] === null || params[0] === undefined ? null : String(params[0]);
    const category = params[2] === null || params[2] === undefined ? null : String(params[2]);
    const cursorAt = params[4] === null || params[4] === undefined ? null : String(params[4]);
    const cursorId = params[7] === null || params[7] === undefined ? null : String(params[7]);
    const limit = Number(params[8] ?? 1);

    let query = this.table(TABLE.records).select(RECORD_COLUMNS).eq("app_id", this.appId);
    if (status !== null) query = query.eq("body->>status", status);
    if (category !== null) query = query.eq("body->>category", category);
    if (cursorAt !== null) {
      query = query.or(
        `created_at.lt.${filterValue(cursorAt)},` +
          `and(created_at.eq.${filterValue(cursorAt)},record_id.lt.${filterValue(cursorId ?? "")})`
      );
    }
    const { data, error } = await query
      .order("created_at", { ascending: false })
      .order("record_id", { ascending: false })
      .limit(limit);
    this.refuse(error, "list this app's requests");
    return ((data ?? []) as unknown as PgRecordRow[]).map(requestRow);
  }

  /** `SELECT_WRITE_BY_ID`, shaped exactly as the SQLite ledger row is. */
  private async selectWriteById(writeId: string): Promise<Record<string, unknown>[]> {
    const { data, error } = await this.table(TABLE.writes)
      .select(WRITE_COLUMNS)
      .eq("app_id", this.appId)
      .eq("write_id", writeId)
      .limit(1);
    this.refuse(error, "read this app's write ledger");
    return ((data ?? []) as unknown as PgWriteRow[]).map((row) => ({
      write_id: row.write_id,
      subject: row.subject,
      op: row.op,
      record_id: row.record_id,
      intent_hash: row.intent_hash,
      status_code: Number(row.status_code),
      // `result` is jsonb in Postgres and TEXT in SQLite, and the store does
      // `JSON.parse(row.result)`. Serialising here rather than changing the
      // store keeps one reader for both backends.
      result: typeof row.result === "string" ? row.result : JSON.stringify(row.result),
      created_at: row.at,
    }));
  }

  /**
   * `INSERT_REQUEST_WITHIN_QUOTA` → the plpgsql function. Parameters are
   * `insertColumns(record, bytes)` (17 values in column order), then the row's
   * logical bytes again, then the limit.
   *
   * Returns 1 accepted / 0 refused, which the store reads as `changes` — so
   * `changes !== 1` means the quota and nothing else, the same judgement it
   * makes on SQLite.
   */
  private async insertRecordWithinQuota(params: readonly SqlParam[]): Promise<number> {
    const record = recordFromInsertColumns(params);
    const bytes = Number(params[16]);
    const limitBytes = Number(params[18]);
    const { data, error } = await this.client.rpc(FN.insertWithinQuota, {
      p_app_id: this.appId,
      p_record_id: record.id,
      p_subject: record.createdBy,
      p_version: record.version,
      p_logical_bytes: bytes,
      p_body: record,
      p_created_at: record.createdAt,
      p_updated_at: record.updatedAt,
      p_limit_bytes: limitBytes,
    });
    this.refuse(error, "store this request");
    return Number(data ?? 0);
  }

  /**
   * `UPDATE_REQUEST_CAS`. Parameters: title, details, category, quantity,
   * priority, status, requested_for, needed_by, updated_by, updated_by_email,
   * updated_at, logical_bytes, id, expected version.
   *
   * TODO(ceiling): two round trips, because PostgREST has no way to say "merge
   * these keys into the existing jsonb" — the current body is read, the patch is
   * applied to it and the whole document is written back. The compare-and-swap
   * is unaffected: the PATCH still carries `version = eq.<expected>`, so a
   * writer that moved the record between the read and the write makes this
   * change zero rows and the store answers `stale_version`. Only the wasted
   * round trip is the cost.
   */
  private async updateRecordCas(params: readonly SqlParam[]): Promise<number> {
    const recordId = String(params[12]);
    const expectedVersion = Number(params[13]);
    const bytes = Number(params[11]);

    const current = await this.selectRecordById(recordId);
    if (current.length === 0) return 0;

    const next: EquipmentRequest = {
      ...toRecord(current[0]),
      title: String(params[0]),
      details: String(params[1]),
      category: String(params[2]) as EquipmentRequest["category"],
      quantity: Number(params[3]),
      priority: String(params[4]) as EquipmentRequest["priority"],
      status: String(params[5]) as EquipmentRequest["status"],
      requestedFor: String(params[6]),
      neededBy: params[7] === null || params[7] === undefined ? null : String(params[7]),
      version: expectedVersion + 1,
      updatedBy: String(params[8]),
      updatedByEmail: String(params[9]),
      updatedAt: String(params[10]),
    };

    const { data, error } = await this.table(TABLE.records)
      .update({
        version: next.version,
        logical_bytes: bytes,
        body: next,
        updated_at: next.updatedAt,
      })
      .eq("app_id", this.appId)
      .eq("record_id", recordId)
      .eq("version", expectedVersion)
      .select("record_id");
    this.refuse(error, "update this request");
    return (data ?? []).length;
  }

  /** `UPDATE_STORAGE_ADD` → the increment function; PostgREST cannot express `x = x + ?`. */
  private async addStorage(delta: number): Promise<number> {
    const { error } = await this.client.rpc(FN.storageAdd, { p_app_id: this.appId, p_delta: delta });
    this.refuse(error, "account for this app's storage");
    return 1;
  }

  /** `INSERT_WRITE`: the ledger row for an accepted mutation. */
  private async insertWrite(params: readonly SqlParam[]): Promise<number> {
    const { data, error } = await this.table(TABLE.writes)
      .insert({
        app_id: this.appId,
        write_id: String(params[0]),
        subject: String(params[1]),
        op: String(params[2]),
        record_id: params[3] === null || params[3] === undefined ? null : String(params[3]),
        intent_hash: String(params[4]),
        status_code: Number(params[5]),
        result: JSON.parse(String(params[6])) as unknown,
        at: String(params[7]),
      })
      .select("write_id");
    if (error && (error as PgErrorLike).code === "23505") {
      throw new HostedError(
        "idempotency_conflict",
        "This writeId was already used for a different change, so it cannot be reused for this one.",
        {
          fix: "Send this change with a new writeId. Reuse a writeId only to retry the identical request.",
          details: { writeId: String(params[0]) },
        }
      );
    }
    this.refuse(error, "record this write");
    return (data ?? []).length;
  }

  /** `DELETE_WRITES_BEFORE`: the retention sweep, within this app only. */
  private async deleteWritesBefore(cutoff: string): Promise<number> {
    const { data, error } = await this.table(TABLE.writes)
      .delete()
      .eq("app_id", this.appId)
      .lt("at", cutoff)
      .select("write_id");
    this.refuse(error, "purge this app's expired write ids");
    return (data ?? []).length;
  }

  private async storageBytes(): Promise<number> {
    const { data, error } = await this.table(TABLE.storage).select("logical_bytes").eq("app_id", this.appId).limit(1);
    this.refuse(error, "read this app's storage total");
    const rows = (data ?? []) as unknown as { logical_bytes: number | string }[];
    return rows.length === 0 ? 0 : Number(rows[0].logical_bytes);
  }

  private async countRows(name: string): Promise<number> {
    const { count, error } = await this.table(name).select("*", { count: "exact", head: true }).eq("app_id", this.appId);
    this.refuse(error, "count this app's rows");
    return Number(count ?? 0);
  }

  /**
   * The one accessor for a hosted table. Every caller below immediately adds
   * `.eq("app_id", this.appId)`, and `app_id` is the first column of every
   * hosted primary key, so the tenant filter is also the access path. Nothing
   * in this class reaches a table any other way.
   */
  private table(name: string) {
    return this.client.from(name);
  }

  /** Turns a PostgREST error into a refusal that says what to do about it. */
  private refuse(error: unknown, attempted: string): void {
    if (!error) return;
    const e = error as PgErrorLike;
    const code = e.code ?? "";
    const detail = [e.message, e.details, e.hint].filter(Boolean).join(" — ") || "no detail was returned";

    if (code === "PGRST106" || code === "PGRST205" || code === "42P01" || code === "42883") {
      throw new HostedError(
        "runtime_unavailable",
        `Postgres could not ${attempted}: the hosted app-data schema is not reachable — ${detail}`,
        {
          fix: "Apply supabase/migrations/0003_hosted_app_data.sql, then add `hosted` to the project's exposed schemas (Settings → API). Nothing was written.",
          details: { code },
        }
      );
    }
    throw new HostedError("runtime_unavailable", `Postgres could not ${attempted}: ${detail}`, {
      fix: "Check the Supabase project's availability and the service-role key, then retry. A refused statement wrote nothing.",
      details: { code },
    });
  }
}

/* -------------------------------- the store ------------------------------- */

/**
 * `TrackerDataStore`'s policy over {@link PgDataBackend}.
 *
 * Method for method and refusal for refusal the same store as the SQLite one —
 * the parsing (`parseOrThrow` against the same frozen schemas), the byte measure
 * (`logicalBytes`, so the quota figure and `LOGICAL_BYTES_DISCLOSURE` are
 * byte-identical on both), the intent hash (`writeIntentHash`), the cursor
 * (`encodeCursor`/`decodeCursor`) and every refusal builder come from the same
 * modules `tracker-store.ts` uses. What differs is only that each backend call
 * is awaited, which is why this cannot simply be `TrackerDataStore` with a
 * different backend: that class is written against the synchronous
 * `DataBackend` and 10 call sites depend on its being synchronous.
 */
export class PgTrackerStore implements AppDataStore {
  /** The app whose rows this store is bound to. */
  readonly appId: string;
  /** The enforced storage ceiling for this app, in logical bytes. */
  readonly storageLimitBytes: number;

  private readonly backend: PgDataBackend;

  constructor(options: { backend: PgDataBackend; appId: string; limits?: { storageBytes: number } }) {
    this.backend = options.backend;
    this.appId = options.appId;
    this.storageLimitBytes = options.limits?.storageBytes ?? DEFAULT_LIMITS.storageBytes;
  }

  /** A page of equipment requests, newest first. Keyset pagination, never OFFSET. */
  async list(ctx: DataContext, query: ListRequestsInput): Promise<ListRequestsResult> {
    this.assertApp(ctx.appId);
    this.assertGranted(ctx);
    const parsed = parseOrThrow(ListRequestsQuery, query, "list query");
    const cursor = parsed.cursor === undefined ? null : decodeCursor(parsed.cursor);

    const rows = await this.backend.all<RequestRow>(SELECT_REQUESTS_PAGE, [
      parsed.status ?? null,
      parsed.status ?? null,
      parsed.category ?? null,
      parsed.category ?? null,
      cursor?.at ?? null,
      cursor?.at ?? null,
      cursor?.at ?? null,
      cursor?.id ?? null,
      parsed.limit + 1,
    ]);

    const items = rows.slice(0, parsed.limit).map(toRecord);
    const hasMore = rows.length > parsed.limit && items.length > 0;
    return hasMore ? { items, nextCursor: encodeCursor(items[items.length - 1]) } : { items };
  }

  /** One equipment request, or null when this app has no record with that id. */
  async get(ctx: DataContext, id: string): Promise<EquipmentRequest | null> {
    this.assertApp(ctx.appId);
    this.assertGranted(ctx);
    const row = await this.backend.get<RequestRow>(SELECT_REQUEST_BY_ID, [id]);
    return row ? toRecord(row) : null;
  }

  /** Creates one equipment request. Editor or owner only; quota-admitted; idempotent per write id. */
  async create(ctx: DataContext, body: CreateRequestInput): Promise<MutationResult> {
    this.assertApp(ctx.appId);
    this.assertEditor(ctx, "create");
    const parsed = parseOrThrow(CreateRequestBody, body, "create request body");
    const intentHash = writeIntentHash("create", this.appId, ctx.subject, null, parsed);

    const replayed = await this.replayOf(parsed.writeId, intentHash);
    if (replayed) return replayed;

    const now = new Date().toISOString();
    const record: EquipmentRequest = {
      id: randomUUID(),
      ...parsed.record,
      version: 1,
      createdBy: ctx.subject,
      createdByEmail: ctx.email,
      createdAt: now,
      updatedBy: ctx.subject,
      updatedByEmail: ctx.email,
      updatedAt: now,
    };
    const bytes = logicalBytes(record);

    const inserted = await this.backend.run(INSERT_REQUEST_WITHIN_QUOTA, [
      ...insertColumns(record, bytes),
      bytes,
      this.storageLimitBytes,
    ]);
    // The quota comparison is inside the function, so zero rows means the quota
    // and nothing else. Nothing has been written at this point.
    if (inserted.changes !== 1) throw await this.quotaExceeded(bytes);

    // No UPDATE_STORAGE_ADD here, and that is the one place this store's create
    // path differs from `TrackerDataStore`'s. On SQLite the conditional insert
    // only *compares* against the counter and a second statement moves it, both
    // inside one transaction. Postgres has no transaction spanning these round
    // trips, so `app_record_insert_within_quota` compares, inserts and moves the
    // counter under one row lock instead — the accounting is already done, and
    // adding to it again here would count every created record twice.
    await this.recordWrite(parsed.writeId, ctx.subject, "create", record.id, intentHash, 201, record, now);
    return { record, replayed: false };
  }

  /** Applies a patch, guarded on the version the caller edited. */
  async update(ctx: DataContext, id: string, body: UpdateRequestInput): Promise<MutationResult> {
    this.assertApp(ctx.appId);
    this.assertEditor(ctx, "update");
    const parsed = parseOrThrow(UpdateRequestBody, body, "update request body");
    const patch = parsed.patch;
    const named = Object.keys(patch).filter((key) => (patch as Record<string, unknown>)[key] !== undefined);
    if (named.length === 0) {
      throw new HostedError("invalid_input", "The patch names no fields, so there is nothing to change.", {
        fix: "Include at least one of title, details, category, quantity, priority, status, requestedFor or neededBy in the patch.",
        details: { issues: [{ path: "patch", code: "too_small", message: "must name at least one field" }] },
      });
    }
    const intentHash = writeIntentHash("update", this.appId, ctx.subject, id, parsed);

    const replayed = await this.replayOf(parsed.writeId, intentHash);
    if (replayed) return replayed;

    const currentRow = await this.backend.get<RequestRow>(SELECT_REQUEST_BY_ID, [id]);
    if (!currentRow) throw notFound(id);
    const current = toRecord(currentRow);
    if (current.version !== parsed.expectedVersion) {
      throw staleVersion(parsed.expectedVersion, current);
    }

    const now = new Date().toISOString();
    const next: EquipmentRequest = {
      ...current,
      title: patch.title ?? current.title,
      details: patch.details ?? current.details,
      category: patch.category ?? current.category,
      quantity: patch.quantity ?? current.quantity,
      priority: patch.priority ?? current.priority,
      status: patch.status ?? current.status,
      requestedFor: patch.requestedFor ?? current.requestedFor,
      neededBy: "neededBy" in patch ? (patch.neededBy ?? null) : current.neededBy,
      version: current.version + 1,
      updatedBy: ctx.subject,
      updatedByEmail: ctx.email,
      updatedAt: now,
    };
    const bytes = logicalBytes(next);
    const delta = bytes - currentRow.logical_bytes;
    // Only growth can breach the quota; a patch that shrinks a record is always
    // allowed, which is what lets an app at its ceiling recover.
    if (delta > 0 && (await this.currentStorageBytes()) + delta > this.storageLimitBytes) {
      throw await this.quotaExceeded(delta);
    }

    const swapped = await this.backend.run(UPDATE_REQUEST_CAS, [
      next.title,
      next.details,
      next.category,
      next.quantity,
      next.priority,
      next.status,
      next.requestedFor,
      next.neededBy,
      next.updatedBy,
      next.updatedByEmail,
      next.updatedAt,
      bytes,
      id,
      parsed.expectedVersion,
    ]);
    if (swapped.changes !== 1) {
      // The version moved between the read and the swap. Answer with what is
      // actually stored now, rather than with what we had read.
      const reread = await this.backend.get<RequestRow>(SELECT_REQUEST_BY_ID, [id]);
      if (!reread) throw notFound(id);
      throw staleVersion(parsed.expectedVersion, toRecord(reread));
    }

    await this.backend.run(UPDATE_STORAGE_ADD, [delta]);
    await this.recordWrite(parsed.writeId, ctx.subject, "update", id, intentHash, 200, next, now);
    return { record: next, replayed: false };
  }

  /** Logical bytes currently stored by this app. See `bytes.ts` for what that measures. */
  async storageBytes(appId: string): Promise<number> {
    this.assertApp(appId);
    return this.currentStorageBytes();
  }

  /**
   * The tracker schema version this app's data is at.
   *
   * Constant, unlike the SQLite path: there are no per-app migrations to apply
   * because there is no per-app database — migration 0003 creates one set of
   * tables for every app, so every app is at the version this build ships.
   */
  async schemaVersion(appId: string): Promise<number> {
    this.assertApp(appId);
    return LATEST_TRACKER_SCHEMA_VERSION;
  }

  /** Drops write-ledger rows older than the published retention window. */
  async purgeExpiredWrites(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - TRACKER_LIMITS.writeIdRetentionMs).toISOString();
    return (await this.backend.run(DELETE_WRITES_BEFORE, [cutoff])).changes;
  }

  /* ------------------------------- internals ------------------------------ */

  private async replayOf(writeId: string, intentHash: string): Promise<MutationResult | null> {
    const row = await this.backend.get<{
      intent_hash: string;
      op: string;
      result: string;
      created_at: string;
    }>(SELECT_WRITE_BY_ID, [writeId]);
    if (!row) return null;
    if (row.intent_hash !== intentHash) {
      throw new HostedError(
        "idempotency_conflict",
        "This writeId was already used for a different change, so it cannot be reused for this one.",
        {
          fix: "Send this change with a new writeId. Reuse a writeId only to retry the identical request.",
          details: { writeId, firstUsedAt: row.created_at, firstOperation: row.op },
        }
      );
    }
    return { record: JSON.parse(row.result) as EquipmentRequest, replayed: true };
  }

  private async recordWrite(
    writeId: string,
    subject: string,
    op: "create" | "update",
    recordId: string,
    intentHash: string,
    statusCode: number,
    record: EquipmentRequest,
    now: string
  ): Promise<void> {
    await this.backend.run(INSERT_WRITE, [
      writeId,
      subject,
      op,
      recordId,
      intentHash,
      statusCode,
      JSON.stringify(record),
      now,
    ]);
  }

  private async currentStorageBytes(): Promise<number> {
    const row = await this.backend.get<{ logical_bytes: number }>(SELECT_STORAGE_BYTES);
    return Number(row?.logical_bytes ?? 0);
  }

  private async quotaExceeded(required: number): Promise<HostedError> {
    return quotaExceeded(await this.currentStorageBytes(), this.storageLimitBytes, required);
  }

  private assertApp(appId: string): void {
    if (appId === this.appId) return;
    throw appMismatch(this.appId, appId);
  }

  private assertGranted(ctx: DataContext): void {
    if (roleRank(ctx.role) !== undefined) return;
    throw roleNotGranted(ctx.role);
  }

  private assertEditor(ctx: DataContext, verb: "create" | "update"): void {
    const rank = roleRank(ctx.role);
    if (rank !== undefined && rank >= APP_ROLE_RANK.editor) return;
    throw notEditor(ctx.role, rank !== undefined, verb);
  }
}

/* -------------------------------- helpers --------------------------------- */

/** Rebuilds the record from the 17 positional values `insertColumns` produced. */
function recordFromInsertColumns(params: readonly SqlParam[]): EquipmentRequest {
  return {
    id: String(params[0]),
    title: String(params[1]),
    details: String(params[2]),
    category: String(params[3]) as EquipmentRequest["category"],
    quantity: Number(params[4]),
    priority: String(params[5]) as EquipmentRequest["priority"],
    status: String(params[6]) as EquipmentRequest["status"],
    requestedFor: String(params[7]),
    neededBy: params[8] === null || params[8] === undefined ? null : String(params[8]),
    version: Number(params[9]),
    createdBy: String(params[10]),
    createdByEmail: String(params[11]),
    createdAt: String(params[12]),
    updatedBy: String(params[13]),
    updatedByEmail: String(params[14]),
    updatedAt: String(params[15]),
  };
}

/**
 * A Postgres row → the `RequestRow` shape `toRecord` reads.
 *
 * The promoted columns win over `body` for `version`, `logical_bytes` and the
 * timestamps: they are what the compare-and-swap and the page order actually
 * read, so if the two ever disagreed the promoted value is the one the database
 * enforced.
 */
function requestRow(row: PgRecordRow): RequestRow {
  const body = row.body ?? {};
  const text = (key: string): string => (body[key] === undefined || body[key] === null ? "" : String(body[key]));
  return {
    id: row.record_id,
    title: text("title"),
    details: text("details"),
    category: text("category"),
    quantity: Number(body.quantity ?? 1),
    priority: text("priority"),
    status: text("status"),
    requested_for: text("requestedFor"),
    needed_by: body.neededBy === undefined || body.neededBy === null ? null : String(body.neededBy),
    version: Number(row.version),
    created_by: text("createdBy"),
    created_by_email: text("createdByEmail"),
    created_at: row.created_at,
    updated_by: text("updatedBy"),
    updated_by_email: text("updatedByEmail"),
    updated_at: row.updated_at,
    logical_bytes: Number(row.logical_bytes),
  };
}

/**
 * A value inside a PostgREST `or=(…)` group, double-quoted.
 *
 * ISO-8601 timestamps and record ids both contain characters the filter grammar
 * gives meaning to (`,` separates conditions, `.` separates operator from
 * value), and quoting is how PostgREST is told a run of bytes is a value.
 */
function filterValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
