/**
 * Disposable primitive probe, not the hosted authority or a migration.
 * Run: node node_modules/tsx/dist/cli.mjs scripts/hosted-spike/sqlite-feasibility.ts
 * It never reads ZENITH_DATA or application configuration.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

interface Check {
  id: string;
  status: "passed" | "failed";
  detail: string;
  elapsedMs: number;
}

export interface SqliteFeasibilityReport {
  kind: "sqlite-primitive-feasibility";
  startedAt: string;
  runtime: string;
  sqliteVersion?: string;
  status: "locally_verified" | "failed" | "blocked";
  checks: Check[];
  limitations: string[];
  blocker?: string;
  scratchRemoved: boolean;
}

const LIMITATIONS = [
  "Only this Node runtime and OS temporary filesystem were exercised; CI/container and deployment volumes require their own run.",
  "No application authority, permission migration, job runner or app data implementation is verified by this primitive probe.",
  "No process-kill, power-loss, disk-full, encrypted off-host backup, key recovery or clean-host recovery drill was performed.",
  "Two connections in one process exercise SQLite locking; this does not prove safe multi-replica application operation.",
];

/** Uses real temporary database files; every connection is closed before cleanup. */
export async function runSqliteFeasibility(): Promise<SqliteFeasibilityReport> {
  const report: SqliteFeasibilityReport = {
    kind: "sqlite-primitive-feasibility", startedAt: new Date().toISOString(),
    runtime: process.version, status: "failed", checks: [],
    limitations: [...LIMITATIONS], scratchRemoved: false,
  };
  let sqlite: typeof import("node:sqlite");
  try {
    sqlite = await import("node:sqlite");
    if (typeof sqlite.DatabaseSync !== "function" || typeof sqlite.backup !== "function")
      throw new Error("missing API");
  } catch {
    report.status = "blocked";
    report.blocker = "This runtime lacks DatabaseSync/backup. Use a supported Node version and rerun; no fallback store was created.";
    return report;
  }

  const root = fs.realpathSync(os.tmpdir());
  const scratch = fs.mkdtempSync(path.join(root, "zenith-sqlite-feasibility-"));
  const connections: InstanceType<typeof sqlite.DatabaseSync>[] = [];
  const open = (filename: string) => {
    const connection = new sqlite.DatabaseSync(path.join(scratch, filename));
    connections.push(connection);
    return connection;
  };
  let activeCheck = "open";
  let checkStart = performance.now();
  const check = async (id: string, detail: string, body: () => void | Promise<void>) => {
    activeCheck = id;
    checkStart = performance.now();
    await body();
    report.checks.push({ id, status: "passed", detail, elapsedMs: Math.round((performance.now() - checkStart) * 100) / 100 });
  };
  try {
    const writer = open("control.sqlite");
    report.sqliteVersion = String(writer.prepare("SELECT sqlite_version() AS version").get()!.version);

    await check("durability-pragmas", "Read back foreign_keys=1, journal_mode=wal, synchronous=2 (FULL), busy_timeout=80 ms.", () => {
      writer.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=80;");
      assert.equal(writer.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
      assert.equal(writer.prepare("PRAGMA journal_mode").get()!.journal_mode, "wal");
      assert.equal(writer.prepare("PRAGMA synchronous").get()!.synchronous, 2);
      assert.equal(writer.prepare("PRAGMA busy_timeout").get()!.timeout, 80);
    });
    writer.exec(`
      CREATE TABLE apps (id TEXT PRIMARY KEY);
      CREATE TABLE grants (app_id TEXT NOT NULL REFERENCES apps(id), actor_id TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(app_id, actor_id));
      CREATE TABLE operations (id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id), intent TEXT NOT NULL);
      CREATE TABLE outbox (operation_id TEXT PRIMARY KEY REFERENCES operations(id), state TEXT NOT NULL);
      INSERT INTO apps(id) VALUES ('test-app');
    `);

    await check("foreign-key-refusal", "An invalid parent ID was rejected and inserted no grant.", () => {
      assert.throws(() => writer.prepare("INSERT INTO grants(app_id, actor_id) VALUES (?, ?)").run("absent", "test-actor"), /FOREIGN KEY/);
      assert.equal(writer.prepare("SELECT COUNT(*) AS count FROM grants").get()!.count, 0);
    });

    await check("atomic-rollback", "A failing outbox insert rolled back its operation and grant in the same transaction.", () => {
      writer.exec("BEGIN IMMEDIATE");
      try {
        writer.prepare("INSERT INTO grants(app_id, actor_id) VALUES (?, ?)").run("test-app", "test-actor");
        writer.prepare("INSERT INTO operations(id, app_id, intent) VALUES (?, ?, ?)").run("test-operation", "test-app", "fixture-intent");
        assert.throws(() => writer.prepare("INSERT INTO outbox(operation_id, state) VALUES (?, ?)").run("absent-operation", "pending"), /FOREIGN KEY/);
      } finally {
        writer.exec("ROLLBACK");
      }
      for (const table of ["grants", "operations", "outbox"]) {
        assert.equal(writer.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count, 0);
      }
    });

    const reader = open("control.sqlite");
    reader.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=80;");
    await check("committed-visibility", "Grant, operation and outbox became visible together to a second connection only after commit.", () => {
      writer.exec("BEGIN IMMEDIATE");
      try {
        writer.prepare("INSERT INTO grants(app_id, actor_id) VALUES (?, ?)").run("test-app", "test-actor");
        writer.prepare("INSERT INTO operations(id, app_id, intent) VALUES (?, ?, ?)").run("test-operation", "test-app", "fixture-intent");
        writer.prepare("INSERT INTO outbox(operation_id, state) VALUES (?, ?)").run("test-operation", "pending");
        for (const table of ["grants", "operations", "outbox"]) {
          assert.equal(reader.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count, 0);
        }
        writer.exec("COMMIT");
      } catch (error) {
        writer.exec("ROLLBACK");
        throw error;
      }
      for (const table of ["grants", "operations", "outbox"]) {
        assert.equal(reader.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count, 1);
      }
    });

    await check("busy-writer-refusal", "A second BEGIN IMMEDIATE refused an occupied writer; it succeeded after rollback released the lock.", () => {
      writer.exec("BEGIN IMMEDIATE");
      try {
        assert.throws(() => reader.exec("BEGIN IMMEDIATE"), /database is locked/);
      } finally {
        writer.exec("ROLLBACK");
      }
      reader.exec("BEGIN IMMEDIATE; ROLLBACK;");
    });

    await check("fresh-revocation-read", "The next uncached read on the second connection observed a committed revocation.", () => {
      writer.exec("BEGIN IMMEDIATE; UPDATE grants SET revoked=1 WHERE app_id='test-app' AND actor_id='test-actor'; COMMIT;");
      assert.equal(reader.prepare("SELECT revoked FROM grants WHERE app_id=? AND actor_id=?").get("test-app", "test-actor")!.revoked, 1);
    });

    await check("wal-aware-backup", "The online backup passed integrity/foreign-key checks and retained the committed revocation, operation and outbox.", async () => {
      await sqlite.backup(writer, path.join(scratch, "backup.sqlite"));
      const restored = open("backup.sqlite");
      assert.equal(restored.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
      assert.deepEqual(restored.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(restored.prepare("SELECT revoked FROM grants WHERE app_id=? AND actor_id=?").get("test-app", "test-actor")!.revoked, 1);
      assert.equal(restored.prepare("SELECT state FROM outbox WHERE operation_id=?").get("test-operation")!.state, "pending");
      assert.equal(restored.prepare("SELECT intent FROM operations WHERE id=?").get("test-operation")!.intent, "fixture-intent");
    });

    await check("reopen-after-close", "Closing every live connection and reopening retained the committed records.", () => {
      // Keep an unclosed connection registered if close throws, so finally
      // still attempts it and every remaining connection before cleanup.
      while (connections.length) {
        connections[connections.length - 1].close();
        connections.pop();
      }
      const reopened = open("control.sqlite");
      assert.equal(reopened.prepare("SELECT revoked FROM grants WHERE app_id=? AND actor_id=?").get("test-app", "test-actor")!.revoked, 1);
      assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM outbox").get()!.count, 1);
    });
    report.status = "locally_verified";
  } catch (error) {
    // Do not emit raw database errors, paths, fixture contents or credentials.
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "probe_failure";
    report.checks.push({ id: activeCheck, status: "failed", detail: `Check failed (${code}). Inspect this probe under the same runtime.`, elapsedMs: Math.round(performance.now() - checkStart) });
    report.status = "failed";
  } finally {
    for (const connection of connections) {
      try { connection.close(); } catch { report.status = "failed"; }
    }
    // Delete only the known files in the unique directory this invocation made.
    // Never recurse, never accept a caller-provided cleanup path.
    try {
      assert.equal(path.dirname(fs.realpathSync(scratch)), root);
      assert.ok(path.basename(scratch).startsWith("zenith-sqlite-feasibility-"));
      for (const filename of ["control.sqlite", "control.sqlite-wal", "control.sqlite-shm", "backup.sqlite", "backup.sqlite-wal", "backup.sqlite-shm"]) {
        try { fs.unlinkSync(path.join(scratch, filename)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      fs.rmdirSync(scratch);
      report.scratchRemoved = true;
    } catch {
      report.status = "failed";
      report.blocker = "Temporary-file cleanup did not complete. No recursive deletion was attempted.";
    }
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runSqliteFeasibility().then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.status === "locally_verified" ? 0 : report.status === "blocked" ? 2 : 1;
  }).catch(() => {
    process.stderr.write("SQLite probe could not create its isolated test environment. Application data was not opened.\n");
    process.exitCode = 1;
  });
}
