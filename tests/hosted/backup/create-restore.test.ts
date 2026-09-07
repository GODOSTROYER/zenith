/**
 * Taking a backup while the databases are being written to, and restoring it
 * into a clean directory.
 *
 * The three refusals at the end are the ones that decide whether a backup is
 * trustworthy at all: a changed byte, the wrong key and a directory that
 * already holds something. Each has to be refused with a sentence an operator
 * can act on, and none of them may half-write anything.
 *
 * Workstream W8 (hosted R3).
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir } from "../_fixtures";

const dataDir = isolatedDataDir("zenith-backup-create-");
const offHost = path.join(dataDir, "off-host");
const KEY = Buffer.alloc(32, 3).toString("base64");
process.env.ZENITH_BACKUP_KEY = KEY;
process.env.ZENITH_BACKUP_TARGET = "filesystem";
process.env.ZENITH_BACKUP_DIR = offHost;

const { closeAuthority, flushOutbox, openAuthority } = await import("@/lib/hosted/authority");
const { backupKeyFor, createBackup, restoreBackup, RESTORE_REPORT_FILE, unpackBundle, unseal } =
  await import("@/lib/hosted/backup");
const { closeAllAppData } = await import("@/lib/hosted/data");
const { registerOpsOutboxHandlers } = await import("@/lib/hosted/usage");
const { EDITOR, OWNER, VIEWER, seedApp, seedGrant, seedRecord, seedSession } = await import(
  "./_ops-fixtures"
);

const a = openAuthority();
registerOpsOutboxHandlers();

const app = seedApp(a, { slug: "backup-alpha", workspaceId: "ws-backup" });
const ownerGrant = seedGrant(a, app.id, OWNER, "owner");
seedGrant(a, app.id, EDITOR, "editor");
seedSession(a, app.id, ownerGrant.id, OWNER.subject);

afterAll(() => {
  closeAllAppData();
  closeAuthority();
  removeDir(dataDir);
});

/** Revoke a grant and get the line off-host, so the ledger exists and reaches the snapshot. */
async function revokeAndPublish(grantId: string, subject: string): Promise<void> {
  a.tx(() => {
    a.repos.grants.revoke(grantId, OWNER.subject, "fixture");
    a.repos.sessions.terminateByGrant(grantId, "revoked");
    const entry = a.repos.revocations.append({
      appId: app.id,
      grantId,
      subject,
      by: OWNER.subject,
      reason: "fixture",
    });
    a.repos.outbox.enqueue({
      id: randomUUID(),
      idempotencyKey: `revocation:${entry.seq}`,
      kind: "revocation_ledger",
      payload: { entry },
    });
  });
  await flushOutbox({ kinds: ["revocation_ledger"] });
}

/** Read a restored database without writing to it. */
function readRestored<T>(file: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

const freshDir = (name: string): string => path.join(dataDir, "restores", name);

describe("createBackup and restoreBackup", () => {
  it("snapshots under concurrent writes and restores into a clean directory", async () => {
    // A revoked grant before the snapshot, so the off-host ledger exists and
    // reaches at least as far as the backup does.
    const throwaway = seedGrant(a, app.id, VIEWER, "viewer");
    await revokeAndPublish(throwaway.id, VIEWER.subject);

    const before: string[] = [];
    for (let n = 0; n < 12; n++) before.push((await seedRecord(app.id, { title: `Before ${n}` })).id);

    let finished = false;
    let duringBackup = 0;
    const running = createBackup().then((manifest) => {
      finished = true;
      return manifest;
    });

    // Keep both databases moving while the copy is taken.
    for (let n = 0; n < 40; n++) {
      await seedRecord(app.id, { title: `During ${n}` });
      a.tx(() =>
        a.repos.usage.append({
          id: `usage-${String(n).padStart(4, "0")}`,
          workspaceId: "ws-backup",
          appId: app.id,
          kind: "requests",
          amount: 1,
        })
      );
      if (!finished) duringBackup += 1;
      await new Promise((resolve) => setImmediate(resolve));
    }
    const manifest = await running;
    expect(duringBackup).toBeGreaterThan(0);

    /* The bundle itself. */
    const stored = fs.readFileSync(path.join(offHost, ...backupKeyFor(manifest.id).split("/")));
    expect(stored.length).toBe(manifest.byteSize);
    const { plain } = unseal(stored, Buffer.from(KEY, "base64"));
    const unpacked = unpackBundle(plain);
    expect(unpacked.files.map((file) => file.name).sort()).toEqual([
      "artifacts.json",
      `apps/${app.id}/data.sqlite`,
      "control.sqlite",
    ].sort());
    expect(manifest.revocationSeq).toBe(1);
    expect(manifest.keyId).toMatch(/^[0-9a-f]{8}$/);
    // Recorded, and recorded once.
    expect(a.repos.backups.latest()?.id).toBe(manifest.id);
    expect(
      a.repos.events.listSince({ event: "backup.completed" }, { limit: 10 }).map((e) => e.logicalId)
    ).toEqual([`backup:${manifest.id}`]);

    /* The restore. */
    const into = freshDir("clean");
    const report = await restoreBackup({ bundle: stored, into });

    expect(report.reconciliation.evidenceComplete).toBe(true);
    expect(report.reconciliation.ledgerMaxSeq).toBe(1);
    expect(report.reconciliation.applied).toEqual([]);
    expect(report.counts.apps).toBe(1);
    // Nothing was held: the ledger reached the snapshot and named no newer revocation.
    expect(report.counts.grantsByState).toMatchObject({ active: 2, revoked: 1, needs_reapproval: 0 });
    expect(report.sessionsTerminated).toBe(1);

    const restoredDb = path.join(into, "apps", app.id, "data.sqlite");
    const restored = readRestored(restoredDb, (db) => ({
      count: Number(db.prepare("SELECT COUNT(*) AS n FROM equipment_requests").get()?.n ?? -1),
      rows: db
        .prepare("SELECT id, title, version, created_at FROM equipment_requests ORDER BY id")
        .all()
        .map((row) => ({ id: String(row.id), title: String(row.title), version: Number(row.version) })),
    }));

    // Every record that existed before the copy started is in the restore,
    // with its content intact; the ones written during it are a prefix.
    const restoredIds = new Set(restored.rows.map((row) => row.id));
    for (const id of before) expect(restoredIds.has(id)).toBe(true);
    const live = readRestored(path.join(dataDir, "apps", app.id, "data.sqlite"), (db) =>
      db.prepare("SELECT id, title FROM equipment_requests").all().map((row) => ({ id: String(row.id), title: String(row.title) }))
    );
    const liveById = new Map(live.map((row) => [row.id, row.title]));
    for (const row of restored.rows) expect(row.title).toBe(liveById.get(row.id));
    expect(restored.count).toBeLessThanOrEqual(live.length);
    expect(restored.count).toBeGreaterThanOrEqual(before.length);

    // And the report says the same number the database does.
    expect(report.counts.recordsByApp).toEqual([
      { appId: app.id, slug: app.slug, records: restored.count, detail: "quick_check ok" },
    ]);

    /* The report file. */
    const onDisk = JSON.parse(fs.readFileSync(path.join(into, RESTORE_REPORT_FILE), "utf8"));
    expect(onDisk).toMatchObject({ into, backup: { id: manifest.id } });
    expect(onDisk.limitations.join(" ")).toMatch(/has not been measured against an RPO/);
    // The restored install recorded that it was restored.
    expect(
      readRestored(path.join(into, "control.sqlite"), (db) =>
        Number(db.prepare("SELECT COUNT(*) AS n FROM hosted_events WHERE event = 'restore.completed'").get()?.n ?? 0)
      )
    ).toBe(1);
  }, 60_000);

  it("does not put artifact bytes in the bundle unless it is asked to, and says so", async () => {
    const manifest = await createBackup();
    const stored = fs.readFileSync(path.join(offHost, ...backupKeyFor(manifest.id).split("/")));
    const { files } = unpackBundle(unseal(stored, Buffer.from(KEY, "base64")).plain);
    const inventory = JSON.parse(files.find((file) => file.name === "artifacts.json")!.bytes.toString("utf8"));
    expect(inventory.includesBytes).toBe(false);
    expect(inventory.note).toMatch(/NOT in this bundle/);
    expect(files.some((file) => file.name.startsWith("artifacts/sha256/"))).toBe(false);
  });

  it("refuses a bundle with a changed byte, and writes nothing", async () => {
    const manifest = await createBackup();
    const stored = fs.readFileSync(path.join(offHost, ...backupKeyFor(manifest.id).split("/")));
    const tampered = Buffer.from(stored);
    const at = Math.floor(tampered.length / 2);
    tampered[at] = tampered[at] ^ 0xff;

    const into = freshDir("tampered");
    await expect(restoreBackup({ bundle: tampered, into })).rejects.toThrow(/does not authenticate/);
    expect(fs.existsSync(into)).toBe(false);
  });

  it("refuses a bundle sealed under a different key, naming both key ids", async () => {
    const manifest = await createBackup();
    const stored = fs.readFileSync(path.join(offHost, ...backupKeyFor(manifest.id).split("/")));
    const previous = process.env.ZENITH_BACKUP_KEY;
    process.env.ZENITH_BACKUP_KEY = Buffer.alloc(32, 9).toString("base64");
    try {
      const into = freshDir("wrong-key");
      await expect(restoreBackup({ bundle: stored, into })).rejects.toThrow(
        new RegExp(`sealed under key ${manifest.keyId}`)
      );
      expect(fs.existsSync(into)).toBe(false);
    } finally {
      process.env.ZENITH_BACKUP_KEY = previous;
    }
  });

  it("refuses a directory that already holds something, whatever it holds", async () => {
    const manifest = await createBackup();
    const stored = fs.readFileSync(path.join(offHost, ...backupKeyFor(manifest.id).split("/")));
    const into = freshDir("occupied");
    fs.mkdirSync(into, { recursive: true });
    fs.writeFileSync(path.join(into, "notes.txt"), "someone else's data");

    await expect(restoreBackup({ bundle: stored, into })).rejects.toThrow(/is not empty/);
    // Nothing of ours was written over it.
    expect(fs.readdirSync(into)).toEqual(["notes.txt"]);
  });

  it("refuses a file that is not a backup at all", async () => {
    await expect(restoreBackup({ bundle: Buffer.from("not a backup"), into: freshDir("garbage") })).rejects.toThrow(
      /does not start with the ZBKS header/
    );
  });

  it("refuses when the target holds no object under the given key", async () => {
    await expect(restoreBackup({ bundle: "backups/does-not-exist.zbk", into: freshDir("missing") })).rejects.toThrow(
      /holds no object/
    );
  });
});
