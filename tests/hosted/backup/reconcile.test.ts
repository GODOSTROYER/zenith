/**
 * Revocation reconciliation on restore (G23).
 *
 * The failure being prevented: restoring last night's snapshot silently
 * re-admits everyone who was removed today. Three cases have to behave
 * differently, and each is here — the ledger reaches past the snapshot (apply
 * what it names), the ledger is gone (close everything), and the ledger is
 * behind its own backup (also close everything, because a ledger that stops
 * before the snapshot cannot say what happened after it).
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir } from "../_fixtures";

const dataDir = isolatedDataDir("zenith-backup-reconcile-");
const offHost = path.join(dataDir, "off-host");
process.env.ZENITH_BACKUP_KEY = Buffer.alloc(32, 5).toString("base64");
process.env.ZENITH_BACKUP_TARGET = "filesystem";
process.env.ZENITH_BACKUP_DIR = offHost;

const { closeAuthority, flushOutbox, openAuthority } = await import("@/lib/hosted/authority");
const { FilesystemTarget, REVOCATION_LEDGER_KEY, backupKeyFor, createBackup, restoreBackup } =
  await import("@/lib/hosted/backup");
const { closeAllAppData } = await import("@/lib/hosted/data");
const { registerOpsOutboxHandlers } = await import("@/lib/hosted/usage");
const { EDITOR, OWNER, VIEWER, seedApp, seedGrant, seedRecord, seedSession } = await import(
  "./_ops-fixtures"
);

const a = openAuthority();
registerOpsOutboxHandlers();

const app = await seedApp(a, { slug: "reconcile-app", workspaceId: "ws-reconcile" });
const ownerGrant = await seedGrant(a, app.id, OWNER, "owner");
const editorGrant = await seedGrant(a, app.id, EDITOR, "editor");
const viewerGrant = await seedGrant(a, app.id, VIEWER, "viewer");
const editorSession = await seedSession(a, app.id, editorGrant.id, EDITOR.subject);
await seedSession(a, app.id, ownerGrant.id, OWNER.subject);

afterAll(async () => {
  closeAllAppData();
  closeAuthority();
  removeDir(dataDir);
});

/** Revoke a grant the way the product does, and get the line off-host. */
async function revoke(grantId: string, subject: string, reason: string): Promise<number> {
  const seq = await a.tx(async (repos) => {
    await repos.grants.revoke(grantId, OWNER.subject, reason);
    await repos.sessions.terminateByGrant(grantId, "revoked");
    const entry = await repos.revocations.append({
      appId: app.id,
      grantId,
      subject,
      by: OWNER.subject,
      reason,
    });
    await repos.outbox.enqueue({
      id: randomUUID(),
      idempotencyKey: `revocation:${entry.seq}`,
      kind: "revocation_ledger",
      payload: { entry },
    });
    return entry.seq;
  });
  await flushOutbox({ kinds: ["revocation_ledger"] });
  return seq;
}

/** Read a restored control database without writing to it. */
function readControl<T>(into: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path.join(into, "control.sqlite"), { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

const grantState = (into: string, grantId: string): string =>
  readControl(into, (db) => String(db.prepare("SELECT state FROM app_grants WHERE id = ?").get(grantId)?.state));

const sessionRow = (into: string, id: string) =>
  readControl(into, (db) =>
    db.prepare("SELECT terminated_at, terminated_reason FROM app_sessions WHERE id = ?").get(id)
  );

const bundleOf = (id: string): Buffer =>
  fs.readFileSync(path.join(offHost, ...backupKeyFor(id).split("/")));

describe("reconciliation", () => {
  it("re-applies a revocation recorded after the snapshot, and ends that person's session", async () => {
    await seedRecord(app.id, { title: "Before the backup" });
    // One revocation before the backup, so the ledger exists and the snapshot
    // is not at sequence zero.
    await revoke(viewerGrant.id, VIEWER.subject, "left the pilot");

    const manifest = await createBackup();
    expect(manifest.revocationSeq).toBe(1);

    // The editor is removed *after* the backup was taken. In the snapshot they
    // are still active and their session is still live.
    const seq = await revoke(editorGrant.id, EDITOR.subject, "moved teams");
    expect(seq).toBe(2);

    const into = path.join(dataDir, "restores", "reconciled");
    const report = await restoreBackup({ bundle: bundleOf(manifest.id), into });

    expect(report.reconciliation.evidenceComplete).toBe(true);
    expect(report.reconciliation.cutoffSeq).toBe(1);
    expect(report.reconciliation.ledgerMaxSeq).toBe(2);
    expect(report.reconciliation.applied).toEqual([
      expect.objectContaining({ seq: 2, grantId: editorGrant.id, revoked: true }),
    ]);
    expect(report.reconciliation.detail).toMatch(/Re-applied 1 revocation/);

    // The person removed after the snapshot is removed in the restore too.
    expect(grantState(into, editorGrant.id)).toBe("revoked");
    expect(sessionRow(into, editorSession.id)).toMatchObject({ terminated_reason: "revoked" });
    // Everyone else keeps what they had.
    expect(grantState(into, ownerGrant.id)).toBe("active");
    expect(grantState(into, viewerGrant.id)).toBe("revoked");
    expect(report.counts.grantsByState).toMatchObject({ active: 1, revoked: 2, needs_reapproval: 0 });
    // Every session ends regardless: they were issued by a host that is gone.
    expect(report.sessionsTerminated).toBeGreaterThanOrEqual(1);
    expect(
      readControl(into, (db) =>
        Number(db.prepare("SELECT COUNT(*) AS n FROM app_sessions WHERE terminated_at IS NULL").get()?.n ?? -1)
      )
    ).toBe(0);
  });

  it("closes every grant and recovers every app when the ledger is not there", async () => {
    const manifest = await createBackup();
    const empty = path.join(dataDir, "no-ledger");
    const into = path.join(dataDir, "restores", "no-ledger");

    const report = await restoreBackup({
      bundle: bundleOf(manifest.id),
      into,
      target: new FilesystemTarget(empty),
    });

    expect(report.reconciliation.evidenceComplete).toBe(false);
    expect(report.reconciliation.ledgerAvailable).toBe(false);
    expect(report.reconciliation.detail).toMatch(/Evidence missing/);
    expect(report.reconciliation.detail).toMatch(/revocations\.jsonl/);
    expect(report.reconciliation.needsReapproval).toBeGreaterThan(0);
    expect(report.reconciliation.appsRecovering).toBe(1);

    // No live grant survives, and the app does not serve until someone decides.
    expect(grantState(into, ownerGrant.id)).toBe("needs_reapproval");
    expect(report.counts.grantsByState.active).toBe(0);
    expect(report.counts.appsByState).toMatchObject({ recovering: 1 });
    expect(readControl(into, (db) => String(db.prepare("SELECT state_reason FROM apps").get()?.state_reason))).toMatch(
      /could not be confirmed against the off-host ledger/
    );
    // Nothing was thrown away to achieve that.
    expect(report.counts.recordsByApp[0].records).toBeGreaterThan(0);
    expect(report.counts.releases).toBe(0);
    expect(report.limitations.join(" ")).toMatch(/could not be read far enough/);
  });

  it("treats a ledger that stops before the snapshot as missing evidence", async () => {
    const manifest = await createBackup();
    expect(manifest.revocationSeq).toBe(2);

    // A ledger that only knows about the first revocation cannot vouch for
    // anything that happened after it.
    const behind = path.join(dataDir, "ledger-behind");
    const target = new FilesystemTarget(behind);
    await target.append(REVOCATION_LEDGER_KEY, JSON.stringify({
      seq: 1,
      at: new Date().toISOString(),
      appId: app.id,
      grantId: viewerGrant.id,
      subject: VIEWER.subject,
      by: OWNER.subject,
      reason: "left the pilot",
    }));

    const into = path.join(dataDir, "restores", "ledger-behind");
    const report = await restoreBackup({ bundle: bundleOf(manifest.id), into, target });

    expect(report.reconciliation.ledgerAvailable).toBe(true);
    expect(report.reconciliation.ledgerMaxSeq).toBe(1);
    expect(report.reconciliation.evidenceComplete).toBe(false);
    expect(report.reconciliation.detail).toMatch(/reaches sequence 1 and this snapshot already contains 2/);
    expect(report.counts.grantsByState.active).toBe(0);
  });

  it("counts a ledger line it cannot parse instead of guessing at it", async () => {
    const manifest = await createBackup();
    const messy = path.join(dataDir, "ledger-messy");
    const target = new FilesystemTarget(messy);
    for (const seq of [1, 2])
      await target.append(REVOCATION_LEDGER_KEY, JSON.stringify({
        seq,
        at: new Date().toISOString(),
        appId: app.id,
        grantId: seq === 1 ? viewerGrant.id : editorGrant.id,
        subject: seq === 1 ? VIEWER.subject : EDITOR.subject,
        by: OWNER.subject,
        reason: "fixture",
      }));
    await target.append(REVOCATION_LEDGER_KEY, "{ this is not json");
    await target.append(REVOCATION_LEDGER_KEY, JSON.stringify({ grantId: "no-seq" }));

    const into = path.join(dataDir, "restores", "ledger-messy");
    const report = await restoreBackup({ bundle: bundleOf(manifest.id), into, target });

    expect(report.reconciliation.unreadable).toBe(2);
    expect(report.reconciliation.evidenceComplete).toBe(true);
    expect(report.reconciliation.ledgerMaxSeq).toBe(2);
  });
});
