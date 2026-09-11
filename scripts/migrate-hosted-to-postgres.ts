/**
 * Move a hosted SQLite install into Supabase Postgres — control authority,
 * per-app customer data and published artifacts — in one shot.
 *
 *     npm run migrate:hosted -- --dry-run
 *     npm run migrate:hosted -- --verify
 *     npm run migrate:hosted -- --data /srv/zenith/.data --artifacts /srv/zenith/artifacts
 *     npm run migrate:hosted -- --only control
 *
 * Flags
 *
 *   --data <dir>       the SQLite data directory. Default `ZENITH_DATA`.
 *   --artifacts <dir>  the artifact root. Default `ZENITH_ARTIFACT_DIR`, and
 *                      failing that `<data>/artifacts` — the same rule
 *                      `hostedConfig().artifactDir` applies, with the data
 *                      directory this run was pointed at.
 *   --only <phase>     `control`, `apps` or `artifacts`. Default: all three.
 *   --dry-run          read everything, print the plan, write nothing.
 *   --verify           after copying, compare per-table row counts and
 *                      recompute every uploaded artifact's manifest digest.
 *
 * Exit codes: 0 ok, 1 a `--verify` mismatch, 2 a usage or configuration error.
 *
 * ## What it moves
 *
 * **Control.** Every table of `<data>/control.sqlite` into `hosted.*`, in
 * foreign-key order — the order of `CONTROL_TABLES` below, which is
 * `CONTRACT_CLEANUP` (tests/hosted/authority/contract/_factories.ts) read
 * backwards. Two of those references are circular and are handled the same way
 * the Postgres migration handles them: the row goes in with the pointer NULL
 * and the pointer is patched once its target exists. `apps.active_release_id`
 * → `releases.id` is one; `app_invites.supersedes` → `app_invites.id` is the
 * other (a chain that a 500-row batch boundary could otherwise split).
 *
 * **Per-app data.** For every app, `<data>/apps/<id>/data.sqlite` opened
 * **read-only** — this script never writes to, and never deletes from, SQLite —
 * and copied into the shared tables: `equipment_requests` → `hosted.app_records`
 * (`body` is the tracker-v1 record `toRecord` rebuilds, so a migrated row reads
 * back exactly as it did on SQLite), `writes` → `hosted.app_writes`, and
 * `hosted.app_storage` set to the **recomputed** sum of `logical_bytes` rather
 * than to SQLite's running counter. If the two disagree the difference is
 * printed: the sum over the rows is the truth, and a drifted counter is worth
 * knowing about rather than carrying across.
 *
 * **Artifacts.** Every digest in the control `artifacts` table that is present
 * and intact on disk, uploaded through `StorageArtifactStore.put` — which
 * validates every file and writes the manifest last, so a digest whose upload
 * dies half way through simply does not exist for readers and a re-run finishes
 * it. A digest the bucket already holds is skipped. A digest that is not on
 * disk, or whose on-disk copy fails `FsArtifactStore.verify`, is a **warning**:
 * the control row still names it, and refusing to migrate the other 200
 * artifacts over one missing build would be the wrong trade.
 *
 * ## Idempotent
 *
 * Every insert is `... on conflict (<pk>) do nothing`, so a second run inserts
 * nothing and a run that died half way finishes the job. `hosted.app_storage`
 * is the single exception and is an upsert, because it is a derived total
 * rather than a copied row; it reports as inserted only when the row was new
 * (`xmax = 0`). Nothing here deletes anything, from either store.
 *
 * ## Why the statements are built rather than tagged
 *
 * Writes go through `sql.unsafe(text, params)` with a fixed, auditable
 * statement text and 500 rows of bound parameters, not through postgres.js's
 * `sql(rows, ...columns)` helper. Three of the columns need something that
 * helper cannot express: `revocation_ledger.seq` is an identity column and has
 * to be inserted `overriding system value` for the ledger's sequence numbers to
 * survive, `app_records.body` and `app_writes.result` are `jsonb` fed from JSON
 * text, and `invite_deliveries.sealed_payload` is `bytea`. One code path that
 * spells every statement out beats two that agree most of the time — and the
 * statement text is exactly what `--dry-run` can print and a test can assert.
 *
 * **No secret is ever printed.** `SUPABASE_DB_URL`,
 * `SUPABASE_SERVICE_ROLE_KEY` and the sealed invitation payloads are read,
 * passed and never logged.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StorageArtifactStore, FsArtifactStore, artifactDigest } from "@/lib/hosted/artifacts";
import type { Artifact, ArtifactFile, ArtifactProvenance } from "@/lib/hosted/contracts";
import { APP_DATA_FILENAMES, toRecord, type RequestRow } from "@/lib/hosted/data";
import { env } from "@/lib/env";

/* ------------------------------- the pg tag ------------------------------- */

/** One statement's rows, as postgres.js answers them: an array that knows its count. */
export type PgRows = Record<string, unknown>[] & { count: number };

/**
 * The slice of postgres.js this script uses.
 *
 * Structural on purpose: `main()` hands it the real pooled client
 * (`pgAuthorityClient()`) and a test hands it a recorder. Everything goes
 * through `unsafe`, so this is the whole surface.
 */
export interface MigrateSql {
  unsafe(text: string, params?: readonly unknown[]): PromiseLike<PgRows>;
  begin<T>(fn: (tx: MigrateSql) => Promise<T>): Promise<T>;
}

/** The artifact store this script uploads into. `StorageArtifactStore` is one. */
export interface ArtifactTarget {
  get(digest: string): Promise<Artifact | null>;
  list(digest: string): Promise<ArtifactFile[]>;
  put(outputDir: string, provenance: ArtifactProvenance): Promise<Artifact>;
}

/* --------------------------------- tables --------------------------------- */

/** One control table, and everything that is not a literal column-for-column copy. */
interface ControlTable {
  /** Same name in `hosted.` as in the SQLite file. */
  table: string;
  /** Primary key: the `on conflict` target, and what `--verify` counts by. */
  pk: readonly string[];
  /** SQLite 0/1 under a CHECK; a real boolean in Postgres. */
  booleans?: readonly string[];
  /** SQLite BLOB; `bytea` in Postgres. */
  blobs?: readonly string[];
  /**
   * Columns inserted NULL and patched once their target exists. Both are
   * circular references Postgres resolves at create time and SQLite did not.
   */
  defer?: readonly { column: string; references: string }[];
  /** `seq` is `generated always as identity`; the ledger's numbering must survive. */
  identity?: boolean;
  /** Read order. Only matters where it makes the printed plan reproducible. */
  order?: string;
}

/**
 * Every control table, in foreign-key order.
 *
 * This is `CONTRACT_CLEANUP` reversed — the order that suite deletes in is the
 * order a loader has to insert in, and keeping the two mirrored means one list
 * to check a new table against rather than two that can disagree.
 */
export const CONTROL_TABLES: readonly ControlTable[] = [
  { table: "schema_migrations", pk: ["version"], order: "version" },
  {
    table: "apps",
    pk: ["id"],
    defer: [{ column: "active_release_id", references: "releases" }],
    order: "created_at, id",
  },
  { table: "artifacts", pk: ["digest"], order: "created_at, digest" },
  { table: "releases", pk: ["id"], order: "created_at, id" },
  { table: "app_grants", pk: ["id"], order: "created_at, id" },
  {
    table: "app_invites",
    pk: ["id"],
    defer: [{ column: "supersedes", references: "app_invites" }],
    order: "created_at, id",
  },
  { table: "invite_deliveries", pk: ["id"], blobs: ["sealed_payload"], order: "created_at, id" },
  { table: "app_sessions", pk: ["id"], order: "created_at, id" },
  { table: "app_exchanges", pk: ["code_hash"], order: "created_at, code_hash" },
  { table: "hosted_jobs", pk: ["id"], order: "created_at, id" },
  { table: "hosted_outbox", pk: ["id"], order: "created_at, id" },
  { table: "quota_counters", pk: ["app_id", "day"], order: "app_id, day" },
  { table: "usage_ledger", pk: ["id"], order: "at, id" },
  { table: "revocation_ledger", pk: ["seq"], identity: true, order: "seq" },
  { table: "backup_manifests", pk: ["id"], order: "created_at, id" },
  { table: "hosted_events", pk: ["id"], booleans: ["assisted"], order: "ts, id" },
];

/** How many rows go into one statement. Small enough that a failure names a place. */
export const BATCH = 500;

/* --------------------------------- options -------------------------------- */

/** Which phases a run covers. */
export type Phase = "control" | "apps" | "artifacts";

/** What `migrate()` needs. `main()` builds this from argv and the environment. */
export interface MigrateOptions {
  /** The SQLite data directory — `control.sqlite` and `apps/` live here. */
  dataDir: string;
  /** The artifact root; `sha256/<digest>/…` lives under it. */
  artifactDir: string;
  /** Read everything, write nothing. */
  dryRun?: boolean;
  /** Which phases to run. Default: all three. */
  only?: Phase | "all";
  /** Compare row counts and artifact manifests afterwards. */
  verify?: boolean;
  /** The Postgres tag. Required unless `dryRun` — a dry run connects to nothing. */
  sql?: MigrateSql;
  /** Where artifacts go. Default: a `StorageArtifactStore` on the configured bucket. */
  artifacts?: ArtifactTarget;
  /** Where the report goes. Default: `console.log`. */
  log?: (line: string) => void;
}

/** One line of a phase's table. */
export interface PhaseRow {
  table: string;
  sqliteRows: number;
  inserted: number;
  skipped: number;
}

/** One phase's table of counts. */
export interface PhaseReport {
  phase: Phase;
  rows: PhaseRow[];
}

/** Everything a run did, and what it would exit with. */
export interface MigrateResult {
  phases: PhaseReport[];
  /** Things a human should read: missing files, drifted counters, absent artifacts. */
  warnings: string[];
  /** What `--verify` found wrong. Empty is a pass. */
  mismatches: string[];
  /** Rows this run actually inserted, across every phase. */
  inserted: number;
  dryRun: boolean;
  /** 0 ok, 1 verify mismatch. A usage error throws `UsageError` instead. */
  exitCode: 0 | 1;
}

/** A bad flag, a missing directory, an unconfigured target: exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/* --------------------------------- sqlite --------------------------------- */

/** The control database, opened read-only. Nothing here may write to SQLite. */
function openControl(dataDir: string): DatabaseSync {
  const file = path.join(dataDir, "control.sqlite");
  if (!fs.existsSync(file))
    throw new UsageError(
      `There is no control authority at ${file}, so there is nothing to migrate.\n` +
        `Fix: point --data at the directory ZENITH_DATA names on the host that ran the SQLite install.`
    );
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch (error) {
    throw new UsageError(
      `${file} could not be opened read-only: ${(error as Error).message}\n` +
        `Fix: stop the hosted server first — a database mid-write cannot be copied consistently.`
    );
  }
}

/** The column names of one SQLite table, in declaration order. */
function columnsOf(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  return rows.map((r) => r.name);
}

/** Does this SQLite file have that table at all? */
function hasTable(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return row !== undefined;
}

/** Every row of a table, as plain objects. Control tables are small enough to hold. */
function readAll(db: DatabaseSync, table: string, order?: string): Record<string, unknown>[] {
  const sql = `SELECT * FROM ${table}${order ? ` ORDER BY ${order}` : ""}`;
  return db.prepare(sql).all() as unknown as Record<string, unknown>[];
}

/* ------------------------------ value mapping ----------------------------- */

/** How one column's value is bound: its SQL cast, and the JS value to send. */
interface Bind {
  cast: string;
  value: unknown;
}

/**
 * One SQLite value, ready for Postgres.
 *
 * Timestamps stay the text they already are — 0002_hosted_authority.sql keeps
 * every timestamp column `text` on purpose, so there is nothing to convert and
 * a conversion would be a bug. Flags become booleans, BLOBs become `bytea`,
 * and everything else goes across as it came.
 */
function bind(column: string, raw: unknown, spec: ControlTable): Bind {
  if (spec.booleans?.includes(column)) return { cast: "", value: raw === null ? null : Boolean(raw) };
  if (spec.blobs?.includes(column))
    return {
      cast: "::bytea",
      value: raw === null || raw === undefined ? null : Buffer.from(raw as Uint8Array),
    };
  // node:sqlite hands back a BigInt for an integer that will not fit a double.
  // Postgres takes the decimal text of one; a Number would silently round it.
  if (typeof raw === "bigint") return { cast: "", value: raw.toString() };
  return { cast: "", value: raw === undefined ? null : raw };
}

/** `"a", "b"` — every identifier quoted, so a column named `by` stays a column. */
const quoteAll = (names: readonly string[]): string => names.map((n) => `"${n}"`).join(", ");

/* ------------------------------- the writer ------------------------------- */

/**
 * One batched `insert … on conflict do nothing`, returning how many rows landed.
 *
 * The statement text is fixed for a given table and batch size; only the
 * parameters change. `casts` names the per-column cast (`::jsonb`, `::bytea`)
 * that makes a bound text or Buffer parameter unambiguous to Postgres.
 */
async function insertBatch(
  sql: MigrateSql,
  table: string,
  columns: readonly string[],
  casts: readonly string[],
  rows: readonly unknown[][],
  conflict: readonly string[],
  overriding = false
): Promise<number> {
  if (rows.length === 0) return 0;
  const width = columns.length;
  const tuples = rows
    .map(
      (_, r) =>
        `(${columns.map((__, c) => `$${r * width + c + 1}${casts[c] ?? ""}`).join(", ")})`
    )
    .join(", ");
  const statement =
    `insert into hosted.${table} (${quoteAll(columns)})` +
    `${overriding ? " overriding system value" : ""}` +
    ` values ${tuples} on conflict (${quoteAll(conflict)}) do nothing`;
  const result = await sql.unsafe(statement, rows.flat());
  return result.count;
}

/**
 * Patch a deferred pointer for every row that has one.
 *
 * `update … from (values …)` rather than a statement per row: the same shape
 * for two rows and for twenty thousand.
 */
async function patchDeferred(
  sql: MigrateSql,
  table: string,
  key: string,
  column: string,
  pairs: readonly [string, string][]
): Promise<number> {
  let patched = 0;
  for (let i = 0; i < pairs.length; i += BATCH) {
    const chunk = pairs.slice(i, i + BATCH);
    const tuples = chunk.map((_, r) => `($${r * 2 + 1}::text, $${r * 2 + 2}::text)`).join(", ");
    const statement =
      `update hosted.${table} as t set "${column}" = v.value ` +
      `from (values ${tuples}) as v(key, value) ` +
      `where t."${key}" = v.key and t."${column}" is distinct from v.value`;
    const result = await sql.unsafe(statement, chunk.flat());
    patched += result.count;
  }
  return patched;
}

/* ------------------------------ control phase ----------------------------- */

/** Copy every control table. Each table is one transaction. */
async function copyControl(
  db: DatabaseSync,
  sql: MigrateSql | undefined,
  dryRun: boolean,
  warnings: string[]
): Promise<PhaseRow[]> {
  const out: PhaseRow[] = [];
  // Deferred pointers are patched after **every** table is in, not at the end
  // of their own: `apps.active_release_id` points at a table that is copied
  // later, so patching it in the apps transaction would trip the very foreign
  // key the NULL was there to avoid.
  const pending: { table: string; key: string; column: string; pairs: [string, string][] }[] = [];

  for (const spec of CONTROL_TABLES) {
    if (!hasTable(db, spec.table)) {
      warnings.push(`control: ${spec.table} is not in this control.sqlite; nothing copied from it.`);
      out.push({ table: spec.table, sqliteRows: 0, inserted: 0, skipped: 0 });
      continue;
    }
    const columns = columnsOf(db, spec.table);
    const rows = readAll(db, spec.table, spec.order);
    const deferred = spec.defer ?? [];
    const deferredNames = deferred.map((d) => d.column);

    if (dryRun || !sql) {
      out.push({ table: spec.table, sqliteRows: rows.length, inserted: 0, skipped: 0 });
      continue;
    }

    const casts = columns.map((c) => bind(c, null, spec).cast);
    const values = rows.map((row) =>
      columns.map((c) => (deferredNames.includes(c) ? null : bind(c, row[c] ?? null, spec).value))
    );

    let inserted = 0;
    await sql.begin(async (tx) => {
      for (let i = 0; i < values.length; i += BATCH)
        inserted += await insertBatch(
          tx,
          spec.table,
          columns,
          casts,
          values.slice(i, i + BATCH),
          spec.pk,
          spec.identity === true
        );

      // An identity column that was fed explicit values has left its sequence
      // where it started, so the next row the application writes would collide
      // with a migrated one. Move it past the highest number this table holds.
      if (spec.identity === true && rows.length > 0)
        await tx.unsafe(
          `select setval(pg_get_serial_sequence('hosted.${spec.table}', '${spec.pk[0]}'), ` +
            `coalesce((select max("${spec.pk[0]}") from hosted.${spec.table}), 1), true)`
        );
    });

    for (const { column } of deferred) {
      const pairs = rows
        .filter((row) => row[column] !== null && row[column] !== undefined)
        .map((row) => [String(row[spec.pk[0]]), String(row[column])] as [string, string]);
      if (pairs.length > 0)
        pending.push({ table: spec.table, key: spec.pk[0], column, pairs });
    }

    out.push({
      table: spec.table,
      sqliteRows: rows.length,
      inserted,
      skipped: rows.length - inserted,
    });
  }

  if (sql && !dryRun)
    for (const patch of pending)
      await sql.begin((tx) => patchDeferred(tx, patch.table, patch.key, patch.column, patch.pairs));

  return out;
}

/* -------------------------------- app phase ------------------------------- */

/** One app's data file: where it is, and what it holds. */
interface AppData {
  appId: string;
  file: string;
  records: RequestRow[];
  writes: Record<string, unknown>[];
  /** The running counter SQLite kept, for comparison only. */
  counter: number;
  /** The sum over the rows — what `hosted.app_storage` is set to. */
  sum: number;
}

/**
 * Open one app's `data.sqlite` read-only and read all three tables.
 *
 * The path is the one `open.ts` builds — `<data>/apps/<encoded id>/data.sqlite`
 * — with this run's data directory rather than `ZENITH_DATA`, so `--data`
 * means what it says.
 */
function readAppData(dataDir: string, appId: string): AppData | null {
  const file = path.join(dataDir, "apps", encodeURIComponent(appId), APP_DATA_FILENAMES.data);
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const records = hasTable(db, "equipment_requests")
      ? (readAll(db, "equipment_requests", "created_at, id") as unknown as RequestRow[])
      : [];
    const writes = hasTable(db, "writes") ? readAll(db, "writes", "created_at, write_id") : [];
    const counterRow = hasTable(db, "storage")
      ? (db.prepare("SELECT logical_bytes FROM storage WHERE id = 1").get() as
          | { logical_bytes: number }
          | undefined)
      : undefined;
    return {
      appId,
      file,
      records,
      writes,
      counter: Number(counterRow?.logical_bytes ?? 0),
      sum: records.reduce((total, r) => total + Number(r.logical_bytes), 0),
    };
  } finally {
    db.close();
  }
}

const RECORD_COLUMNS = [
  "app_id",
  "record_id",
  "subject",
  "version",
  "logical_bytes",
  "body",
  "created_at",
  "updated_at",
] as const;
const RECORD_CASTS = ["", "", "", "", "", "::jsonb", "", ""];

const WRITE_COLUMNS = [
  "app_id",
  "write_id",
  "subject",
  "op",
  "record_id",
  "intent_hash",
  "status_code",
  "result",
  "at",
] as const;
const WRITE_CASTS = ["", "", "", "", "", "", "", "::jsonb", ""];

/**
 * Copy every app's data.
 *
 * `body` is `toRecord(row)` — the very function the read path uses — so the
 * jsonb document is the record the tracker already served, field for field,
 * and `requestRow()` on the Postgres side rebuilds the same row from it.
 */
async function copyApps(
  db: DatabaseSync,
  dataDir: string,
  sql: MigrateSql | undefined,
  dryRun: boolean,
  warnings: string[]
): Promise<{ rows: PhaseRow[]; apps: AppData[] }> {
  const appIds = hasTable(db, "apps")
    ? (readAll(db, "apps", "created_at, id").map((r) => String(r.id)) as string[])
    : [];

  const apps: AppData[] = [];
  for (const appId of appIds) {
    const data = readAppData(dataDir, appId);
    if (!data) {
      warnings.push(`apps: ${appId} has no data.sqlite under ${dataDir}; skipped.`);
      continue;
    }
    if (data.counter !== data.sum)
      warnings.push(
        `apps: ${appId} storage counter is ${data.counter} but its rows sum to ${data.sum}; ` +
          `hosted.app_storage takes the sum.`
      );
    apps.push(data);
  }

  const totals = {
    app_records: apps.reduce((n, a) => n + a.records.length, 0),
    app_writes: apps.reduce((n, a) => n + a.writes.length, 0),
    app_storage: apps.length,
  };

  if (dryRun || !sql)
    return {
      rows: [
        { table: "app_records", sqliteRows: totals.app_records, inserted: 0, skipped: 0 },
        { table: "app_writes", sqliteRows: totals.app_writes, inserted: 0, skipped: 0 },
        { table: "app_storage", sqliteRows: totals.app_storage, inserted: 0, skipped: 0 },
      ],
      apps,
    };

  let records = 0;
  let writes = 0;
  let storage = 0;

  for (const app of apps) {
    const recordValues = app.records.map((row) => [
      app.appId,
      row.id,
      row.created_by,
      Number(row.version),
      Number(row.logical_bytes),
      JSON.stringify(toRecord(row)),
      row.created_at,
      row.updated_at,
    ]);
    const writeValues = app.writes.map((row) => [
      app.appId,
      String(row.write_id),
      String(row.subject),
      String(row.op),
      row.record_id === null || row.record_id === undefined ? null : String(row.record_id),
      String(row.intent_hash),
      Number(row.status_code),
      String(row.result),
      String(row.created_at),
    ]);

    await sql.begin(async (tx) => {
      for (let i = 0; i < recordValues.length; i += BATCH)
        records += await insertBatch(
          tx,
          "app_records",
          RECORD_COLUMNS,
          RECORD_CASTS,
          recordValues.slice(i, i + BATCH),
          ["app_id", "record_id"]
        );
      for (let i = 0; i < writeValues.length; i += BATCH)
        writes += await insertBatch(
          tx,
          "app_writes",
          WRITE_COLUMNS,
          WRITE_CASTS,
          writeValues.slice(i, i + BATCH),
          ["app_id", "write_id"]
        );
      // The one upsert in this script: a derived total, not a copied row, so a
      // re-run has to correct it rather than leave a stale figure. `xmax = 0`
      // is Postgres saying "this tuple was inserted, not updated", which is
      // what keeps the `inserted` column of the report honest.
      const set = await tx.unsafe(
        `insert into hosted.app_storage (app_id, logical_bytes) values ($1, $2) ` +
          `on conflict (app_id) do update set logical_bytes = excluded.logical_bytes ` +
          `returning (xmax = 0) as inserted`,
        [app.appId, app.sum]
      );
      if (set.some((row) => row.inserted === true)) storage += 1;
    });
  }

  return {
    rows: [
      {
        table: "app_records",
        sqliteRows: totals.app_records,
        inserted: records,
        skipped: totals.app_records - records,
      },
      {
        table: "app_writes",
        sqliteRows: totals.app_writes,
        inserted: writes,
        skipped: totals.app_writes - writes,
      },
      {
        table: "app_storage",
        sqliteRows: totals.app_storage,
        inserted: storage,
        skipped: totals.app_storage - storage,
      },
    ],
    apps,
  };
}

/* ----------------------------- artifacts phase ---------------------------- */

/** What the artifact phase did, per digest, so `--verify` knows what to check. */
interface ArtifactOutcome {
  uploaded: string[];
  existing: string[];
  /** On disk but unreadable, or not on disk at all. Warnings, never failures. */
  absent: string[];
}

/**
 * Upload every artifact the control table names and the disk still has.
 *
 * The provenance comes from the on-disk manifest rather than from the control
 * row: the store validates what it is given, and the manifest is the copy that
 * travelled with the bytes.
 */
async function copyArtifacts(
  db: DatabaseSync,
  artifactDir: string,
  target: ArtifactTarget | undefined,
  dryRun: boolean,
  warnings: string[]
): Promise<{ row: PhaseRow; outcome: ArtifactOutcome }> {
  const digests = hasTable(db, "artifacts")
    ? readAll(db, "artifacts", "created_at, digest").map((r) => String(r.digest))
    : [];
  const outcome: ArtifactOutcome = { uploaded: [], existing: [], absent: [] };

  const fsStore = new FsArtifactStore(artifactDir);
  const present: { digest: string; provenance: ArtifactProvenance }[] = [];
  for (const digest of digests) {
    const stored = await fsStore.get(digest);
    if (!stored) {
      outcome.absent.push(digest);
      warnings.push(`artifacts: ${digest} is named by the control database but is not under ${artifactDir}.`);
      continue;
    }
    const check = await fsStore.verify(digest);
    if (!check.ok) {
      outcome.absent.push(digest);
      warnings.push(`artifacts: ${digest} did not verify on disk (${check.detail}); not uploaded.`);
      continue;
    }
    present.push({ digest, provenance: stored.provenance });
  }

  if (dryRun || !target) {
    return {
      row: { table: "artifacts", sqliteRows: digests.length, inserted: 0, skipped: 0 },
      outcome,
    };
  }

  for (const { digest, provenance } of present) {
    if (await target.get(digest)) {
      outcome.existing.push(digest);
      continue;
    }
    const uploaded = await target.put(path.join(artifactDir, "sha256", digest, "files"), provenance);
    if (uploaded.digest !== digest) {
      // Content addressing makes this impossible unless the bytes moved under
      // us between verify() and put(); say which key the bytes landed under.
      warnings.push(
        `artifacts: ${digest} uploaded as ${uploaded.digest} — the files on disk changed mid-run.`
      );
      outcome.absent.push(digest);
      continue;
    }
    outcome.uploaded.push(digest);
  }

  return {
    row: {
      table: "artifacts",
      sqliteRows: digests.length,
      inserted: outcome.uploaded.length,
      skipped: outcome.existing.length,
    },
    outcome,
  };
}

/* --------------------------------- verify --------------------------------- */

/** How many rows in `hosted.<table>` carry one of these primary keys. */
async function countByKeys(
  sql: MigrateSql,
  table: string,
  pk: readonly string[],
  keys: readonly unknown[][]
): Promise<number> {
  const width = pk.length;
  // A single-column key is `id in ($1, $2, …)`; a composite one is the row
  // constructor `(app_id, record_id) in (($1, $2), …)`. Same predicate, and
  // both use the table's own primary key index.
  const lhs = width === 1 ? `"${pk[0]}"` : `(${quoteAll(pk)})`;
  let total = 0;
  for (let i = 0; i < keys.length; i += BATCH) {
    const chunk = keys.slice(i, i + BATCH);
    const terms = chunk.map((_, r) => {
      const holes = pk.map((__, c) => `$${r * width + c + 1}`).join(", ");
      return width === 1 ? holes : `(${holes})`;
    });
    const rows = await sql.unsafe(
      `select count(*)::int as n from hosted.${table} where ${lhs} in (${terms.join(", ")})`,
      chunk.flat()
    );
    total += Number(rows[0]?.n ?? 0);
  }
  return total;
}

/**
 * Compare what SQLite holds with what Postgres now holds.
 *
 * Counted **by primary key**, not by `count(*)`: the target database may hold
 * rows this data directory never had — another install's, or a contract
 * suite's — and a bare count would call that a mismatch. What is being checked
 * is that every row offered arrived.
 */
async function runVerify(
  db: DatabaseSync,
  sql: MigrateSql,
  phases: readonly Phase[],
  apps: readonly AppData[],
  artifacts: ArtifactOutcome,
  target: ArtifactTarget | undefined,
  mismatches: string[]
): Promise<void> {
  if (phases.includes("control")) {
    for (const spec of CONTROL_TABLES) {
      if (!hasTable(db, spec.table)) continue;
      const rows = readAll(db, spec.table, spec.order);
      if (rows.length === 0) continue;
      const keys = rows.map((row) => spec.pk.map((c) => (typeof row[c] === "bigint" ? String(row[c]) : row[c])));
      const found = await countByKeys(sql, spec.table, spec.pk, keys);
      if (found !== rows.length)
        mismatches.push(`control: hosted.${spec.table} holds ${found} of ${rows.length} migrated rows.`);
    }
  }

  if (phases.includes("apps")) {
    for (const app of apps) {
      if (app.records.length > 0) {
        const found = await countByKeys(
          sql,
          "app_records",
          ["app_id", "record_id"],
          app.records.map((r) => [app.appId, r.id])
        );
        if (found !== app.records.length)
          mismatches.push(
            `apps: hosted.app_records holds ${found} of ${app.records.length} records for ${app.appId}.`
          );
      }
      if (app.writes.length > 0) {
        const found = await countByKeys(
          sql,
          "app_writes",
          ["app_id", "write_id"],
          app.writes.map((w) => [app.appId, String(w.write_id)])
        );
        if (found !== app.writes.length)
          mismatches.push(
            `apps: hosted.app_writes holds ${found} of ${app.writes.length} writes for ${app.appId}.`
          );
      }
      const stored = await sql.unsafe(
        "select logical_bytes from hosted.app_storage where app_id = $1",
        [app.appId]
      );
      const bytes = Number(stored[0]?.logical_bytes ?? -1);
      if (bytes !== app.sum)
        mismatches.push(`apps: hosted.app_storage for ${app.appId} is ${bytes}, expected ${app.sum}.`);
    }
  }

  if (phases.includes("artifacts") && target) {
    for (const digest of [...artifacts.uploaded, ...artifacts.existing]) {
      const files = await target.list(digest);
      if (files.length === 0) {
        mismatches.push(`artifacts: ${digest} has no manifest in the bucket.`);
        continue;
      }
      const recomputed = artifactDigest(files);
      if (recomputed !== digest)
        mismatches.push(`artifacts: the bucket's manifest for ${digest} hashes to ${recomputed}.`);
    }
  }
}

/* --------------------------------- report --------------------------------- */

const cell = (value: string | number): string => String(value).padStart(10);

/** One phase's table, exactly as `--dry-run` prints it with inserted = 0. */
function printPhase(report: PhaseReport, log: (line: string) => void): void {
  log(`\n${report.phase}`);
  log(`  ${"table".padEnd(20)}${cell("sqlite")}${cell("inserted")}${cell("existing")}`);
  for (const row of report.rows)
    log(`  ${row.table.padEnd(20)}${cell(row.sqliteRows)}${cell(row.inserted)}${cell(row.skipped)}`);
}

/* --------------------------------- migrate -------------------------------- */

/**
 * Do the whole thing, and answer with what happened.
 *
 * Testable on purpose: `main()` is nothing but argv parsing and an exit code
 * around this function, so every decision it makes can be asserted without a
 * process.
 */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const dryRun = options.dryRun === true;
  const only = options.only ?? "all";
  const phases: Phase[] = only === "all" ? ["control", "apps", "artifacts"] : [only];

  if (!dryRun && !options.sql)
    throw new UsageError(
      "This run would write to Postgres but no client was given.\n" +
        "Fix: set SUPABASE_DB_URL to the Supavisor transaction-mode pooler URI (port 6543), or add --dry-run."
    );

  const db = openControl(options.dataDir);
  const warnings: string[] = [];
  const mismatches: string[] = [];
  const reports: PhaseReport[] = [];
  let apps: AppData[] = [];
  let artifacts: ArtifactOutcome = { uploaded: [], existing: [], absent: [] };
  let target: ArtifactTarget | undefined;

  try {
    log(
      `Hosted migration — ${dryRun ? "dry run, nothing will be written" : "writing"}\n` +
        `  data      ${options.dataDir}\n` +
        `  artifacts ${options.artifactDir}\n` +
        `  phases    ${phases.join(", ")}`
    );

    if (phases.includes("control"))
      reports.push({ phase: "control", rows: await copyControl(db, options.sql, dryRun, warnings) });

    if (phases.includes("apps")) {
      const result = await copyApps(db, options.dataDir, options.sql, dryRun, warnings);
      apps = result.apps;
      reports.push({ phase: "apps", rows: result.rows });
    }

    if (phases.includes("artifacts")) {
      target = dryRun ? undefined : (options.artifacts ?? artifactTarget());
      const result = await copyArtifacts(db, options.artifactDir, target, dryRun, warnings);
      artifacts = result.outcome;
      reports.push({ phase: "artifacts", rows: [result.row] });
    }

    for (const report of reports) printPhase(report, log);

    if (options.verify && !dryRun && options.sql) {
      await runVerify(db, options.sql, phases, apps, artifacts, target, mismatches);
      log(mismatches.length === 0 ? "\nverify: every migrated row is in Postgres." : "\nverify: mismatches");
      for (const line of mismatches) log(`  ! ${line}`);
    }

    if (warnings.length > 0) {
      log("\nwarnings");
      for (const line of warnings) log(`  ! ${line}`);
    }

    const inserted = reports.reduce((n, r) => n + r.rows.reduce((m, row) => m + row.inserted, 0), 0);
    log(
      `\n${dryRun ? "Would insert" : "Inserted"} ${inserted} row(s); ` +
        `${warnings.length} warning(s), ${mismatches.length} mismatch(es).`
    );

    return {
      phases: reports,
      warnings,
      mismatches,
      inserted,
      dryRun,
      exitCode: mismatches.length === 0 ? 0 : 1,
    };
  } finally {
    db.close();
  }
}

/**
 * The object-storage artifact store, or a refusal naming what is missing.
 *
 * Built only when there is something to upload, so a `--dry-run` and an
 * `--only control` run need no Supabase credentials at all.
 */
function artifactTarget(): ArtifactTarget {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (url.trim() === "" || key.trim() === "")
    throw new UsageError(
      "Artifacts go to Supabase Storage, but the project URL and service-role key are not both set.\n" +
        "Fix: export NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or run with --only control."
    );
  return new StorageArtifactStore();
}

/* ---------------------------------- main ---------------------------------- */

/** Parse argv into options. Every unknown flag is a usage error, not a default. */
export function parseArgs(argv: readonly string[]): Omit<MigrateOptions, "sql" | "artifacts" | "log"> {
  let dataDir: string | undefined;
  let artifactDir: string | undefined;
  let only: Phase | "all" = "all";
  let dryRun = false;
  let verify = false;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const take = (): string => {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--"))
        throw new UsageError(`${flag} needs a value.`);
      return value;
    };
    switch (flag) {
      case "--data":
        dataDir = take();
        break;
      case "--artifacts":
        artifactDir = take();
        break;
      case "--only": {
        const value = take();
        if (value !== "control" && value !== "apps" && value !== "artifacts")
          throw new UsageError(`--only takes control, apps or artifacts, not "${value}".`);
        only = value;
        break;
      }
      case "--dry-run":
        dryRun = true;
        break;
      case "--verify":
        verify = true;
        break;
      default:
        throw new UsageError(
          `Unknown flag "${flag}".\n` +
            "Usage: npm run migrate:hosted -- [--data <dir>] [--artifacts <dir>] [--only control|apps|artifacts] [--dry-run] [--verify]"
        );
    }
  }

  const data = dataDir ?? env().ZENITH_DATA;
  return {
    dataDir: data,
    // The Fs store's rule, with this run's data directory: an explicit
    // ZENITH_ARTIFACT_DIR wins, otherwise `<data>/artifacts`.
    artifactDir:
      artifactDir ??
      (process.env.ZENITH_ARTIFACT_DIR?.trim() ? process.env.ZENITH_ARTIFACT_DIR : path.join(data, "artifacts")),
    only,
    dryRun,
    verify,
  };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const { pgAuthorityClient, closePgAuthorityClient } = await import("@/lib/hosted/authority/pg/client");

  // One cast, named: the pooled postgres.js client is what `MigrateSql`
  // describes a corner of, and the structural overlap is `unsafe` and `begin`.
  const sql = parsed.dryRun ? undefined : (pgAuthorityClient() as unknown as MigrateSql);
  try {
    const result = await migrate({ ...parsed, sql });
    process.exitCode = result.exitCode;
  } finally {
    if (!parsed.dryRun) await closePgAuthorityClient();
  }
}

// Only when run as a script; `migrate()` above is what the tests import.
const invoked = process.argv[1] ?? "";
if (/migrate-hosted-to-postgres\.ts$/.test(invoked))
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(error instanceof UsageError ? 2 : 1);
  });
