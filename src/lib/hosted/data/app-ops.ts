/**
 * The three whole-database operations that are not reads or writes of one
 * record, expressed once per store.
 *
 * `OpenAppData.store` is the contract every request-time caller uses, and it is
 * the same shape on both stores. These three are not request-time work and do
 * not belong on it:
 *
 *  - **integrity** — what `hosted/health` and `hosted/backup/reopen` ask before
 *    they call an app healthy or reopen it after a restore;
 *  - **record count** — the reconciliation figure health reports;
 *  - **bulk import** — what `hosted/export` writes when it reads a bundle back.
 *
 * Until this file existed each of them reached through `OpenAppData.backend`
 * for a `PRAGMA` or a synchronous transaction, which is why that field had to
 * be a SQLite connection and why postgres mode could only refuse. They are
 * async here because one of the two implementations is a network round trip;
 * the SQLite implementation does exactly what it did before, inside the same
 * single transaction, and answers an already-resolved promise.
 *
 * What is NOT the same on both stores is said out loud rather than smoothed
 * over: `PRAGMA quick_check` asks SQLite to walk its own file, and Postgres has
 * no such question to ask about rows inside a cluster it does not own. The
 * Postgres integrity check is therefore a **logical** one — every record reads
 * back, and the storage counter equals the sum of their logical bytes — and
 * {@link IntegrityVerdict.kind} says which of the two ran so a caller can report
 * it honestly.
 */
import type { EquipmentRequest, HostedError } from "@/lib/hosted/contracts";
import type { SqliteBackend } from "./backend";
import { logicalBytes } from "./bytes";
import type { PgDataBackend, PgTrackerStore } from "./pg-backend";
import {
  COUNT_REQUESTS,
  INSERT_REQUEST_WITHIN_QUOTA,
  SELECT_REQUEST_BY_ID,
  UPDATE_STORAGE_ADD,
} from "./sql";
import type { TrackerDataStore } from "./tracker-store";
import { insertColumns } from "./tracker-rows";

/** Which integrity question was actually asked. */
export type IntegrityKind = "quick_check" | "logical";

/** What an integrity check found. `detail` is written to be shown to an operator. */
export interface IntegrityVerdict {
  ok: boolean;
  /**
   * `quick_check` — SQLite walked the app's own file.
   * `logical` — the app's rows were read back and reconciled against its
   * storage counter. Postgres owns the physical integrity of its cluster; this
   * is what can honestly be proved from outside it.
   */
  kind: IntegrityKind;
  detail: string;
}

/** One record an import did not write, and why. */
export interface ImportSkip {
  id: string;
  reason: string;
}

/** What an import wrote and what it passed over. */
export interface ImportOutcome {
  imported: number;
  skipped: ImportSkip[];
}

/** How a bulk import is asked for. */
export interface ImportRecordsOptions {
  /**
   * Builds the refusal thrown when a record would take the app past its
   * storage ceiling, given how many records were written before it. The caller
   * owns the wording because the caller knows what the import was — this
   * module only knows that the quota said no.
   */
  quotaRefusal: (imported: number) => HostedError;
}

/**
 * The whole-database operations for one open app, whichever store backs it.
 *
 * Reached as `openAppData(appId).ops`. Every method is available on both
 * stores; nothing here refuses by name.
 */
export interface AppDataOps {
  /** Which store answered. Reported, never branched on by a caller. */
  readonly kind: "sqlite" | "postgres";
  /** Is this app's stored data sound? See {@link IntegrityVerdict.kind}. */
  integrity(): Promise<IntegrityVerdict>;
  /** How many records this app holds. */
  countRecords(): Promise<number>;
  /**
   * Writes records that already have their ids, versions and timestamps —
   * an import, not a create. Every row goes through the same quota-admitted
   * insert a written record does, so an import cannot take an app past its
   * ceiling and cannot leave the byte counter behind.
   */
  importRecords(
    records: readonly EquipmentRequest[],
    options: ImportRecordsOptions
  ): Promise<ImportOutcome>;
}

/* --------------------------------- SQLite --------------------------------- */

/** {@link AppDataOps} over one app's own SQLite file. */
export function sqliteOps(backend: SqliteBackend, store: TrackerDataStore): AppDataOps {
  return {
    kind: "sqlite",

    async integrity(): Promise<IntegrityVerdict> {
      const rows = backend.all<{ quick_check?: unknown }>("PRAGMA quick_check");
      const ok = rows.length === 1 && String(rows[0]?.quick_check) === "ok";
      return {
        ok,
        kind: "quick_check",
        detail: ok
          ? "PRAGMA quick_check on the app's database reported ok."
          : `PRAGMA quick_check reported: ${rows.map((row) => String(row?.quick_check)).join("; ") || "no result"}`,
      };
    },

    async countRecords(): Promise<number> {
      return Number(backend.get<{ total: number }>(COUNT_REQUESTS)?.total ?? 0);
    },

    async importRecords(records, options): Promise<ImportOutcome> {
      const skipped: ImportSkip[] = [];
      let imported = 0;

      // One transaction for the whole import, exactly as before: a refusal
      // part-way through rolls back, rather than leaving an app holding an
      // arbitrary prefix of its own history.
      backend.transaction(() => {
        for (const record of records) {
          const existing = backend.get<{ id: string }>(SELECT_REQUEST_BY_ID, [record.id]);
          if (existing) {
            skipped.push({ id: record.id, reason: "A request with this id is already in the app." });
            continue;
          }
          const bytes = logicalBytes(record);
          // The 17 stored columns come from the tracker store's own list, so an
          // imported row and a row the app writes itself can never disagree
          // about column order; the two trailing values are the quota bounds
          // the conditional insert compares.
          const result = backend.run(INSERT_REQUEST_WITHIN_QUOTA, [
            ...insertColumns(record, bytes),
            bytes,
            store.storageLimitBytes,
          ]);
          // The only reason the conditional insert writes nothing: the storage
          // quota.
          if (result.changes !== 1) throw options.quotaRefusal(imported);
          backend.run(UPDATE_STORAGE_ADD, [bytes]);
          imported += 1;
        }
      });

      return { imported, skipped };
    },
  };
}

/* -------------------------------- Postgres -------------------------------- */

/** {@link AppDataOps} over one app's rows in `hosted.*`. */
export function postgresOps(backend: PgDataBackend, store: PgTrackerStore): AppDataOps {
  return {
    kind: "postgres",

    /**
     * The logical integrity check, and it says so.
     *
     * There is no file to walk: the app's data is rows in a managed cluster
     * whose physical integrity is that cluster's own business and is not
     * something this process can prove. What *is* worth proving, and is what a
     * restore or a health check actually needs to know, is that this app's rows
     * read back and that its accounting agrees with them — the storage counter
     * equals the sum of the stored records' logical bytes. A counter that has
     * drifted is a real fault: it is what every quota decision is made against.
     */
    async integrity(): Promise<IntegrityVerdict> {
      const { total, rows } = await backend.sumLogicalBytes();
      const counter = await backend.storageCounter();
      const ok = total === counter;
      return {
        ok,
        kind: "logical",
        detail: ok
          ? `Logical check: ${rows} stored record(s) read back and their ${total} logical bytes match the storage counter. Postgres has no PRAGMA quick_check; physical integrity belongs to the cluster.`
          : `Logical check: this app's ${rows} stored record(s) hold ${total} logical bytes and the storage counter says ${counter}. The counter every quota decision is made against has drifted from the rows.`,
      };
    },

    async countRecords(): Promise<number> {
      return backend.countRecords();
    },

    /**
     * The import path on Postgres. Same admission as a written record —
     * `hosted.app_record_insert_within_quota` from migration 0003 compares,
     * inserts and moves the counter under one row lock — one record at a time.
     *
     * DIFFERENCE from SQLite, deliberately not hidden: there is no transaction
     * around the whole import, so a refusal part-way through cannot roll the
     * earlier records back. The ceiling is therefore checked *before* anything
     * is written — the whole bundle's logical bytes against the app's remaining
     * headroom — so the quota refusal this path throws is one that wrote
     * nothing. What is left is the narrow case where another writer fills the
     * app while the import is running; that refusal names how many records were
     * already written, and those records stay.
     */
    async importRecords(records, options): Promise<ImportOutcome> {
      const skipped: ImportSkip[] = [];
      let imported = 0;

      const wanted = records.reduce((sum, record) => sum + logicalBytes(record), 0);
      const used = await store.storageBytes(store.appId);
      if (used + wanted > store.storageLimitBytes) throw options.quotaRefusal(0);

      for (const record of records) {
        const existing = await backend.get<{ id: string }>(SELECT_REQUEST_BY_ID, [record.id]);
        if (existing) {
          skipped.push({ id: record.id, reason: "A request with this id is already in the app." });
          continue;
        }
        const bytes = logicalBytes(record);
        const result = await backend.run(INSERT_REQUEST_WITHIN_QUOTA, [
          ...insertColumns(record, bytes),
          bytes,
          store.storageLimitBytes,
        ]);
        // No UPDATE_STORAGE_ADD: the admission function already moved the
        // counter under the same row lock as the comparison, and adding to it
        // here would count every imported record twice.
        if (result.changes !== 1) throw options.quotaRefusal(imported);
        imported += 1;
      }

      return { imported, skipped };
    },
  };
}
