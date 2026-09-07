/**
 * The storage seam under the per-app tracker store: a tiny synchronous SQL
 * interface, one real implementation over `node:sqlite`, and one real
 * implementation over Cloudflare's D1 REST API.
 *
 * Why a seam at all: the local runtime and the Cloudflare runtime run the same
 * policy code (decision R3-03), and `sql.ts` holds statements both accept. What
 * they cannot share is the transaction model — see `D1HttpBackend` below.
 *
 * Workstream W3 (hosted R3).
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { HostedError } from "@/lib/hosted/contracts";
import {
  PRAGMA_BUSY_TIMEOUT,
  PRAGMA_FOREIGN_KEYS,
  PRAGMA_JOURNAL_MODE,
  PRAGMA_SYNCHRONOUS,
  SQLITE_CONNECTION_PRAGMAS,
  TX_BEGIN_IMMEDIATE,
  TX_COMMIT,
  TX_ROLLBACK,
  sqliteBusyTimeoutPragma,
} from "./sql";

/**
 * What a statement parameter may be. Deliberately narrow: these three types
 * survive both `node:sqlite` binding and JSON transport to D1 unchanged, so a
 * statement cannot behave differently on the two backends.
 */
export type SqlParam = string | number | null;

/** What a write reports. `lastInsertRowid` is absent when the backend cannot supply it. */
export interface RunResult {
  changes: number;
  lastInsertRowid?: number;
}

/**
 * The synchronous SQL surface the tracker store is written against.
 *
 * Synchronous on purpose: the store's transactional invariants (read the write
 * id, decide, write the record, write the counter, write the write id) are only
 * simple to reason about when nothing can interleave between the steps, and
 * `node:sqlite` is synchronous anyway.
 */
export interface DataBackend {
  /** Executes a write and reports how many rows it changed. */
  run(sql: string, params?: readonly SqlParam[]): RunResult;
  /** Reads the first row, or undefined when the statement matched nothing. */
  get<T>(sql: string, params?: readonly SqlParam[]): T | undefined;
  /** Reads every matching row. */
  all<T>(sql: string, params?: readonly SqlParam[]): T[];
  /**
   * Runs `fn` inside `BEGIN IMMEDIATE` … `COMMIT`. A throw rolls back and
   * propagates. Calling `transaction` while one is already open runs `fn`
   * inline — one outermost transaction per operation, no savepoints.
   */
  transaction<T>(fn: () => T): T;
  /** Releases the connection. Idempotent. */
  close(): void;
}

/** Optional knobs for {@link SqliteBackend}. Production uses the defaults. */
export interface SqliteBackendOptions {
  /**
   * How long a second writer waits for the write lock before failing, in
   * milliseconds. Default 5000, which is the hosted profile. Tests lower it to
   * prove that contention fails fast rather than hanging.
   */
  busyTimeoutMs?: number;
}

/** The pragma values a healthy hosted connection reports back. */
export interface SqlitePragmaReadback {
  journalMode: string;
  synchronous: number;
  foreignKeys: number;
  busyTimeoutMs: number;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/**
 * `DataBackend` over one `node:sqlite` connection to one file.
 *
 * One connection per file per process. Prepared statements are cached because
 * the store issues the same dozen statements over and over; the cache is
 * dropped on `close()`.
 */
export class SqliteBackend implements DataBackend {
  /** Absolute path of the database file this connection is bound to. */
  readonly path: string;
  /** The `busy_timeout` this connection was opened with, in milliseconds. */
  readonly busyTimeoutMs: number;

  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;
  private closed = false;

  constructor(path: string, options: SqliteBackendOptions = {}) {
    this.path = path;
    this.busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    this.db = new DatabaseSync(path);
    for (const pragma of SQLITE_CONNECTION_PRAGMAS) this.db.exec(pragma);
    this.db.exec(sqliteBusyTimeoutPragma(this.busyTimeoutMs));
  }

  /** True once {@link close} has run. A closed backend refuses every statement. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** True while an explicit transaction is open on this connection. */
  get inTransaction(): boolean {
    return this.depth > 0;
  }

  /**
   * Reads the durability pragmas back off the live connection. The hosted
   * profile is WAL, synchronous FULL (2), foreign keys on (1).
   */
  pragmas(): SqlitePragmaReadback {
    return {
      journalMode: String(this.get<{ journal_mode: string }>(PRAGMA_JOURNAL_MODE)?.journal_mode ?? ""),
      synchronous: Number(this.get<{ synchronous: number }>(PRAGMA_SYNCHRONOUS)?.synchronous ?? -1),
      foreignKeys: Number(this.get<{ foreign_keys: number }>(PRAGMA_FOREIGN_KEYS)?.foreign_keys ?? -1),
      busyTimeoutMs: Number(this.get<{ timeout: number }>(PRAGMA_BUSY_TIMEOUT)?.timeout ?? -1),
    };
  }

  run(sql: string, params: readonly SqlParam[] = []): RunResult {
    const changed = this.prepared(sql).run(...params);
    return { changes: Number(changed.changes), lastInsertRowid: Number(changed.lastInsertRowid) };
  }

  get<T>(sql: string, params: readonly SqlParam[] = []): T | undefined {
    return this.prepared(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, params: readonly SqlParam[] = []): T[] {
    return this.prepared(sql).all(...params) as T[];
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    // A BEGIN that fails (the write lock is held past `busy_timeout`) leaves no
    // transaction to roll back, so it is deliberately outside the try.
    this.exec(TX_BEGIN_IMMEDIATE);
    this.depth = 1;
    let value: T;
    try {
      value = fn();
    } catch (error) {
      this.depth = 0;
      this.rollbackQuietly();
      throw error;
    }
    try {
      this.exec(TX_COMMIT);
    } catch (error) {
      this.depth = 0;
      this.rollbackQuietly();
      throw error;
    }
    this.depth = 0;
    return value;
  }

  /** Runs a statement that takes no parameters and returns nothing (DDL, transaction control). */
  exec(sql: string): void {
    this.assertOpen();
    this.db.exec(sql);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.db.close();
  }

  private rollbackQuietly(): void {
    try {
      this.exec(TX_ROLLBACK);
    } catch {
      // The transaction was already gone (the failure itself aborted it). The
      // original error is the one worth propagating, so this one is dropped.
    }
  }

  private prepared(sql: string): StatementSync {
    this.assertOpen();
    const hit = this.statements.get(sql);
    if (hit) return hit;
    const statement = this.db.prepare(sql);
    this.statements.set(sql, statement);
    return statement;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new HostedError("internal", "This app database connection is already closed.", {
        fix: "Open the app's data store again with openAppData() instead of reusing a closed handle.",
      });
    }
  }
}

/* ------------------------------- Cloudflare ------------------------------- */

/**
 * The `DataBackend` operations lifted to promises.
 *
 * ponytail: HTTP cannot be synchronous in Node, so `D1HttpBackend` cannot
 * implement `DataBackend` itself. The two interfaces are kept
 * method-for-method identical so the store's operations — which are already
 * `Promise`-returning at the `AppDataStore` boundary — can be lifted
 * mechanically when the Cloudflare runtime is enabled. Until then the shipping
 * store runs on `SqliteBackend` only.
 */
export interface AsyncDataBackend {
  /** Executes a write and reports how many rows it changed. */
  run(sql: string, params?: readonly SqlParam[]): Promise<RunResult>;
  /** Reads the first row, or undefined when the statement matched nothing. */
  get<T>(sql: string, params?: readonly SqlParam[]): Promise<T | undefined>;
  /** Reads every matching row. */
  all<T>(sql: string, params?: readonly SqlParam[]): Promise<T[]>;
  /** Releases whatever the backend holds. Idempotent. */
  close(): void;
}

/** One statement queued inside a {@link D1HttpBackend.transaction} batch. */
export interface D1BatchStatement {
  sql: string;
  params: SqlParam[];
}

/**
 * What a `transaction` callback may do on D1: queue statements, nothing else.
 *
 * There is no `get`/`all` here by design. D1's HTTP API has no interactive
 * transaction, so a read cannot observe an uncommitted statement from the same
 * batch, and offering one would be a lie.
 */
export interface D1TransactionScope {
  /** Queues a statement. Nothing executes until the whole batch is sent. */
  run(sql: string, params?: readonly SqlParam[]): void;
}

/** What {@link D1HttpBackend.transaction} reports back. */
export interface D1BatchOutcome<T> {
  /** Whatever the callback returned — typically the statement plan it built. */
  value: T;
  /** One entry per queued statement, in the order they were queued. */
  results: RunResult[];
}

/** Everything `D1HttpBackend` needs. The token is passed in; it is never read from the environment. */
export interface D1HttpBackendOptions {
  /** Cloudflare account id (32 hex characters). */
  accountId: string;
  /** D1 database id. */
  databaseId: string;
  /**
   * API token with D1 edit permission. Held only to build the
   * `Authorization: Bearer` header; the runtime supplies it, this class never
   * looks it up.
   */
  token: string;
  /** Injected so tests and the runtime can supply their own transport. */
  fetch: typeof globalThis.fetch;
  /** Override for the API root. Defaults to Cloudflare's public API. */
  baseUrl?: string;
}

/** Cloudflare's error envelope entry. */
interface D1ApiError {
  code?: number;
  message?: string;
}

/** One statement's result inside Cloudflare's `result` array. */
interface D1QueryResult {
  results?: Record<string, unknown>[];
  success?: boolean;
  meta?: { changes?: number; last_row_id?: number; rows_written?: number };
}

interface D1ApiEnvelope {
  success?: boolean;
  errors?: D1ApiError[];
  result?: D1QueryResult[] | null;
}

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/**
 * `AsyncDataBackend` over Cloudflare's D1 REST API
 * (`POST /accounts/{account}/d1/database/{id}/query` with `{ sql, params }`).
 *
 * Transactions: D1's HTTP API has no interactive transaction. `transaction()`
 * therefore collects the statements the callback queues and sends them as one
 * batch; reads inside a transaction are not supported, which is why
 * {@link D1TransactionScope} exposes only `run`. The store's mutations are
 * written to suit that shape — the quota decision rides inside
 * `INSERT_REQUEST_WITHIN_QUOTA` and the version check rides inside
 * `UPDATE_REQUEST_CAS`, so success is judged by `changes` rather than by a read.
 *
 * ponytail: the batch is sent as one request whose `sql` is the queued
 * statements joined with `;` and whose `params` is their bound values
 * concatenated. That is the only batching shape the documented REST body
 * (`{ sql, params }`) allows, and it has NOT been exercised against a live D1
 * database — no Cloudflare credentials exist on this machine (decision R3-03).
 * Confirm multi-statement parameter binding, and whether a failed statement
 * rolls the batch back, in the Cloudflare spike before enabling the cloudflare
 * runtime. Until then this class is exercised only with an injected fetch.
 *
 * ponytail: the store still reads inside its transaction to build the replayed
 * result and the `stale_version` payload. On D1 those reads have to become a
 * second round trip after the batch, because the batch cannot read its own
 * uncommitted rows. The decisions are already conditional statements; only the
 * reporting reads remain.
 */
export class D1HttpBackend implements AsyncDataBackend {
  /** The exact endpoint every query and batch is posted to. */
  readonly endpoint: string;

  private readonly token: string;
  private readonly doFetch: typeof globalThis.fetch;

  constructor(options: D1HttpBackendOptions) {
    const base = (options.baseUrl ?? CLOUDFLARE_API_BASE).replace(/\/+$/, "");
    this.endpoint = `${base}/accounts/${options.accountId}/d1/database/${options.databaseId}/query`;
    this.token = options.token;
    this.doFetch = options.fetch;
  }

  async run(sql: string, params: readonly SqlParam[] = []): Promise<RunResult> {
    const [result] = await this.post(sql, params);
    return result ?? { changes: 0 };
  }

  async get<T>(sql: string, params: readonly SqlParam[] = []): Promise<T | undefined> {
    const rows = await this.all<T>(sql, params);
    return rows[0];
  }

  async all<T>(sql: string, params: readonly SqlParam[] = []): Promise<T[]> {
    const envelope = await this.send(sql, params);
    return ((envelope.result?.[0]?.results ?? []) as T[]).slice();
  }

  /**
   * Collects the statements the callback queues and sends them as one batch.
   * The callback runs before anything is sent, so it must not depend on a read
   * of its own statements — see the class note.
   */
  async transaction<T>(fn: (tx: D1TransactionScope) => T): Promise<D1BatchOutcome<T>> {
    const queued: D1BatchStatement[] = [];
    const value = fn({
      run: (sql: string, params: readonly SqlParam[] = []) => {
        queued.push({ sql, params: [...params] });
      },
    });
    if (queued.length === 0) return { value, results: [] };
    const results = await this.post(
      queued.map((s) => s.sql).join(";\n"),
      queued.flatMap((s) => s.params)
    );
    return { value, results };
  }

  /** No connection is held, so there is nothing to release. Present for interface parity. */
  close(): void {
    // D1 is reached over stateless HTTP; nothing is held open.
  }

  private async post(sql: string, params: readonly SqlParam[]): Promise<RunResult[]> {
    const envelope = await this.send(sql, params);
    return (envelope.result ?? []).map((entry) => ({
      changes: Number(entry.meta?.changes ?? 0),
      lastInsertRowid: entry.meta?.last_row_id === undefined ? undefined : Number(entry.meta.last_row_id),
    }));
  }

  private async send(sql: string, params: readonly SqlParam[]): Promise<D1ApiEnvelope> {
    let response: Response;
    try {
      response = await this.doFetch(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sql, params }),
      });
    } catch (error) {
      throw this.unavailable(error instanceof Error ? error.message : "the request could not be sent");
    }

    let envelope: D1ApiEnvelope;
    try {
      envelope = (await response.json()) as D1ApiEnvelope;
    } catch {
      throw this.unavailable(`D1 answered HTTP ${response.status} with a body that is not JSON`);
    }

    if (!response.ok || envelope.success === false) {
      const detail = (envelope.errors ?? [])
        .map((e) => (e.code === undefined ? e.message : `${e.code}: ${e.message}`))
        .filter(Boolean)
        .join("; ");
      throw this.unavailable(detail || `D1 answered HTTP ${response.status}`);
    }
    return envelope;
  }

  private unavailable(detail: string): HostedError {
    return new HostedError("runtime_unavailable", `Cloudflare D1 refused this statement: ${detail}`, {
      fix: "Check ZENITH_CF_ACCOUNT_ID, the D1 database id and the API token's D1 edit permission, then retry. No data was written.",
    });
  }
}
