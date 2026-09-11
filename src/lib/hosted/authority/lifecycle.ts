/**
 * Opening, holding and closing the one control-authority connection.
 *
 * Re-exported by `./index`, which is the barrel every other module
 * imports. It lives in its own file only so that `jobs.ts` and `outbox.ts` can
 * depend on it without the barrel depending on them — `src/` keeps no static
 * import cycles (docs/OWNERSHIP.md).
 *
 * **One connection per process, held on `globalThis`.** Next.js re-evaluates
 * modules on HMR; a module-scoped variable would leak a second `DatabaseSync`
 * on every edit, and two connections in one process is how a busy-timeout
 * mystery starts. The JSON store solves this the same way (`__orreryDb`).
 *
 * **A corrupt file is never replaced by an empty one.** If the existing file
 * cannot be opened, cannot be configured, or fails `PRAGMA quick_check`, the
 * open copies it aside and refuses to start. Continuing would serve an install
 * with no apps and no grants, and the next write would make that permanent —
 * exactly the failure `src/lib/db/store.ts` refuses for `state.json`.
 */
import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { HostedError } from "@/lib/hosted/contracts";
import { controlDatabasePath } from "@/lib/hosted/config";
import { createRepos, type Repos } from "./repos";
import { migrate } from "./schema";
import { readText, type SqlRow } from "./sql";
import { transact, type TransactOptions } from "./tx";

/** The open control authority: its connection, its file, its transaction helper, its tables. */
export interface Authority {
  /** The live connection. Prefer `repos`; reach for this only for a one-off query. */
  db: DatabaseSync;
  /** Absolute path of the database file. */
  path: string;
  /**
   * Run `fn` in one durable transaction and return its value. Commit-before-
   * ACK: this returns only after `COMMIT` succeeded. `fn` is synchronous, must
   * do database work only, and may be re-run if SQLite reports the database
   * busy — see `tx.ts`.
   */
  tx<T>(fn: (db: DatabaseSync) => T, opts?: TransactOptions): T;
  /** One repository per table, all bound to `db`. */
  repos: Repos;
}

/** How the authority is opened. */
export interface OpenAuthorityOptions {
  /** Override the file. Defaults to `controlDatabasePath()` (`<ORRERY_DATA>/control.sqlite`). */
  path?: string;
}

/** The pragmas this authority refuses to run without, and the value each must read back as. */
const REQUIRED_PRAGMAS = [
  { set: "journal_mode = WAL", read: "journal_mode", column: "journal_mode", expect: "wal" },
  { set: "synchronous = FULL", read: "synchronous", column: "synchronous", expect: 2 },
  { set: "foreign_keys = ON", read: "foreign_keys", column: "foreign_keys", expect: 1 },
  { set: "busy_timeout = 5000", read: "busy_timeout", column: "timeout", expect: 5000 },
] as const;

type AuthorityGlobal = typeof globalThis & { __zenithAuthority?: Authority };

const held = (): Authority | undefined => {
  const existing = (globalThis as AuthorityGlobal).__zenithAuthority;
  // A connection closed behind our back (a test that called db.close(), a
  // half-finished teardown) must not be handed out as if it were live.
  if (existing && !existing.db.isOpen) {
    delete (globalThis as AuthorityGlobal).__zenithAuthority;
    return undefined;
  }
  return existing;
};

/**
 * Open the control authority, or return the one this process already has.
 *
 * Idempotent: calling it on every request, on every boot path and after a
 * hot reload is correct and cheap. Asking for a *different* path while one is
 * open is a mistake rather than a second authority, and says so.
 *
 * What one open does, in order: create the directory, open the file, apply the
 * durability pragmas and read every one of them back, run `quick_check` on a
 * file that already had content, then apply outstanding migrations.
 */
export function openAuthority(opts: OpenAuthorityOptions = {}): Authority {
  const target = path.resolve(opts.path ?? controlDatabasePath());
  const existing = held();
  if (existing) {
    if (path.resolve(existing.path) !== target)
      throw new HostedError(
        "internal",
        `The hosted control authority is already open at ${existing.path}, so it cannot also be opened at ${target}.`,
        {
          fix: "Call closeAuthority() before opening a different file, or give this process its own data directory with ORRERY_DATA=<path>.",
        }
      );
    return existing;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const hadContent = fs.existsSync(target) && fs.statSync(target).size > 0;

  const db = new DatabaseSync(target);
  try {
    for (const pragma of REQUIRED_PRAGMAS) {
      db.exec(`PRAGMA ${pragma.set};`);
      const row = db.prepare(`PRAGMA ${pragma.read}`).get();
      const actual = row?.[pragma.column];
      if (actual !== pragma.expect)
        throw new HostedError(
          "internal",
          `The control database refused PRAGMA ${pragma.set}: it reads back ${JSON.stringify(actual ?? null)} instead of ${JSON.stringify(pragma.expect)}, so writes here would not be as durable as this system claims.`,
          {
            fix: `Check that ${target} is on a real local filesystem — a network share or a synced folder can silently refuse WAL — and that no other tool has the file open, then start again.`,
            details: { pragma: pragma.set, actual: actual ?? null },
          }
        );
    }
    if (hadContent) quickCheck(db, target);
    migrate(db);
  } catch (err) {
    // Close first: on Windows an open handle blocks the copy that preserves
    // the evidence, and this process is not going to use the connection again.
    try {
      db.close();
    } catch {
      /* already unusable */
    }
    throw hadContent ? refuseCorrupt(target, err) : err;
  }

  const authority: Authority = {
    db,
    path: target,
    tx: (fn, txOpts) => transact(db, fn, txOpts),
    repos: createRepos(db),
  };
  (globalThis as AuthorityGlobal).__zenithAuthority = authority;
  return authority;
}

/** The open authority. Throws when nothing opened it — never opens one implicitly. */
export function authority(): Authority {
  const existing = held();
  if (existing) return existing;
  throw new HostedError("internal", "The hosted control authority has not been opened in this process.", {
    fix: "Call openAuthority() on the boot path before anything reads hosted state (tests call it themselves after setting ORRERY_DATA).",
  });
}

/** True when this process holds an open authority. Boot paths and health checks read it. */
export const authorityOpen = (): boolean => held() !== undefined;

/**
 * Close the connection and forget it. Tests and scripts; a server closes by
 * exiting. Safe to call when nothing is open.
 */
export function closeAuthority(): void {
  const existing = (globalThis as AuthorityGlobal).__zenithAuthority;
  delete (globalThis as AuthorityGlobal).__zenithAuthority;
  if (!existing) return;
  try {
    if (existing.db.isOpen) existing.db.close();
  } catch {
    /* closing twice is not a failure worth propagating */
  }
}

/**
 * Copy the authority to `destPath` with SQLite's online backup, then verify
 * the copy.
 *
 * WAL-safe: the source stays writable throughout and the result is a
 * consistent snapshot, which a file copy of a WAL database is not.
 *
 * **The copy is read through its own connection, not the live one.** On
 * Node 24.19 / SQLite 3.53.3, `node:sqlite`'s `backup()` rejects with
 * `ERR_SQLITE_ERROR` and the contradictory message "not an error" (extended
 * code 0) whenever the *source connection* commits while the copy is in
 * flight — reproducibly, at every backup rate tried. Backing up from a second,
 * read-only connection to the same file has no such problem and produces a
 * verified consistent snapshot under continuous writes, which is what the
 * backup-under-load test exercises. This is a driver defect worked around
 * here, not a property of SQLite; if a later Node fixes it, the extra
 * connection stays harmless.
 *
 * The copy is then opened read-only and `quick_check`ed before this resolves —
 * a backup that has not been read back is a hope, not a backup. Anything that
 * fails is deleted rather than left somewhere a restore might find it.
 */
export async function backupAuthority(destPath: string): Promise<void> {
  const source = authority();
  const dest = path.resolve(destPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  try {
    let reader: DatabaseSync | undefined;
    try {
      reader = new DatabaseSync(source.path, { readOnly: true });
      reader.exec("PRAGMA busy_timeout = 5000;");
      await backup(reader, dest);
    } finally {
      try {
        reader?.close();
      } catch {
        /* the copy is what matters now */
      }
    }

    let copy: DatabaseSync | undefined;
    try {
      copy = new DatabaseSync(dest, { readOnly: true });
      quickCheck(copy, dest);
    } finally {
      try {
        copy?.close();
      } catch {
        /* verification result already decided */
      }
    }
  } catch (err) {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dest}${suffix}`, { force: true });
    throw new HostedError(
      "internal",
      `The backup of ${source.path} to ${dest} did not complete and verify, so the partial copy was deleted rather than kept as a backup that cannot be restored.`,
      {
        fix: "Check free space and write permissions on the backup target, then run the backup again. The source database was not modified.",
        details: { detail: err instanceof Error ? err.message : String(err) },
      }
    );
  }
}

/** `PRAGMA quick_check`, which must answer with exactly one row saying `ok`. */
function quickCheck(db: DatabaseSync, file: string): void {
  const rows: SqlRow[] = db.prepare("PRAGMA quick_check").all();
  if (rows.length === 1 && readText(rows[0], "quick_check") === "ok") return;
  throw new Error(
    `PRAGMA quick_check on ${file} reported: ${rows.map((row) => String(row.quick_check)).join("; ") || "no result"}`
  );
}

/**
 * Preserve a file that could not be opened as an authority, and refuse to
 * start. The original is copied — not moved — so nothing this process does can
 * be the reason a recovery tool finds less than it should.
 */
function refuseCorrupt(file: string, cause: unknown): HostedError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  let kept: string;
  try {
    kept = `${file}.corrupt-${Date.now()}`;
    fs.copyFileSync(file, kept);
  } catch (copyError) {
    return new HostedError(
      "internal",
      `The hosted control database at ${file} could not be opened (${detail}), and a copy of it could not be taken either (${copyError instanceof Error ? copyError.message : String(copyError)}).`,
      {
        fix: `Copy ${file} somewhere safe by hand before doing anything else, then restore a good backup over it or move it aside to start deliberately with an empty authority.`,
        details: { file },
      }
    );
  }
  return new HostedError(
    "internal",
    `The hosted control database at ${file} could not be opened (${detail}), so the server will not start: continuing would serve an install with no apps and no grants, and the next write would overwrite the only copy.`,
    {
      fix: `A copy is preserved at ${kept}. Restore a good backup over ${file} (see backupAuthority), or delete ${file} to start over deliberately with an empty authority — every hosted app, grant and release lives in it.`,
      details: { file, kept },
    }
  );
}
