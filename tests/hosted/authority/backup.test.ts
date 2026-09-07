/**
 * Online backup while the authority is being written to.
 *
 * A file copy of a WAL database taken during writes is not a backup — it is a
 * file that sometimes restores. This proves the difference: rows keep
 * committing on the live connection for the whole duration of
 * `backupAuthority`, and the copy that comes out is internally consistent,
 * referentially intact, and holds a *prefix* of the committed rows rather than
 * an arbitrary subset of them.
 *
 * Workstream W1 (hosted R3).
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir } from "../_fixtures";

const dataDir = isolatedDataDir("zenith-authority-backup-");

const { backupAuthority, closeAuthority, openAuthority } = await import("@/lib/hosted/authority");
const { seedApp } = await import("./_helpers");

const a = openAuthority();

afterAll(() => {
  closeAuthority();
  removeDir(dataDir);
});

/** Read a copy without touching it, and close the handle before anyone deletes it. */
function readCopy<T>(file: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

const rowId = (n: number): string => `usage-${String(n).padStart(5, "0")}`;

describe("backupAuthority", () => {
  it("produces a consistent, verified copy while the source is being written", async () => {
    const app = seedApp(a, { slug: "backup-app" });
    // Enough rows to make the backup take more than one step, so the writes
    // below genuinely overlap it rather than tidily following it.
    for (let n = 0; n < 400; n++)
      a.tx(() =>
        a.repos.usage.append({
          id: rowId(n),
          workspaceId: "ws-one",
          appId: app.id,
          kind: "requests",
          amount: 1,
        })
      );

    const dest = path.join(dataDir, "backups", "control-during-writes.sqlite");
    let backupFinished = false;
    const running = backupAuthority(dest).then(() => {
      backupFinished = true;
    });

    // Keep committing while the copy is being taken, yielding between writes
    // so the backup's own steps get to run.
    let written = 400;
    let writtenDuringBackup = 0;
    for (let n = 400; n < 700; n++) {
      a.tx(() =>
        a.repos.usage.append({
          id: rowId(n),
          workspaceId: "ws-one",
          appId: app.id,
          kind: "requests",
          amount: 1,
        })
      );
      written++;
      if (!backupFinished) writtenDuringBackup++;
      await new Promise((resolve) => setImmediate(resolve));
    }
    await running;

    expect(fs.existsSync(dest)).toBe(true);
    expect(written).toBe(700);
    // The writes really did overlap the copy; otherwise this test proves only
    // that a backup of an idle database works.
    expect(writtenDuringBackup).toBeGreaterThan(0);

    const copy = readCopy(dest, (db) => ({
      quickCheck: db.prepare("PRAGMA quick_check").get(),
      foreignKeys: db.prepare("PRAGMA foreign_key_check").all(),
      ids: db
        .prepare("SELECT id FROM usage_ledger ORDER BY id")
        .all()
        .map((row) => String(row.id)),
      apps: db.prepare("SELECT COUNT(*) AS n FROM apps").get(),
      migrations: db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get(),
    }));

    // Internally sound, and not missing the app the usage rows point at.
    expect(copy.quickCheck).toMatchObject({ quick_check: "ok" });
    expect(copy.foreignKeys).toEqual([]);
    expect(copy.apps).toMatchObject({ n: 1 });
    expect(copy.migrations).toMatchObject({ n: 1 });

    // A prefix of what was committed: every row up to some point, no gaps, and
    // nothing that was never written.
    expect(copy.ids.length).toBeGreaterThanOrEqual(400);
    expect(copy.ids.length).toBeLessThanOrEqual(written);
    expect(copy.ids).toEqual(Array.from({ length: copy.ids.length }, (_, n) => rowId(n)));

    // The source kept every row throughout.
    expect(
      a.repos.usage.listSince({ workspaceId: "ws-one", since: "0000" }, { limit: 1000 })
    ).toHaveLength(written);
  }, 30_000);

  it("creates the destination directory and refuses to leave an unusable file behind", async () => {
    const dest = path.join(dataDir, "backups", "nested", "deeper", "control.sqlite");
    await backupAuthority(dest);
    expect(fs.existsSync(dest)).toBe(true);
    expect(readCopy(dest, (db) => db.prepare("PRAGMA quick_check").get())).toMatchObject({
      quick_check: "ok",
    });
  });

  it("refuses to back up when no authority is open", async () => {
    closeAuthority();
    await expect(backupAuthority(path.join(dataDir, "backups", "never.sqlite"))).rejects.toThrow(
      /has not been opened/i
    );
    expect(fs.existsSync(path.join(dataDir, "backups", "never.sqlite"))).toBe(false);
    openAuthority();
  });
});
