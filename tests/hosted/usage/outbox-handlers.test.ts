/**
 * The two effects ops owns: the spending alert, and the off-host revocation
 * ledger.
 *
 * The ledger append is the one that matters for recovery. A revocation that
 * never reaches the target is a revocation a clean-host restore cannot learn
 * about, so with no target configured the entry has to **fail, visibly, with
 * the variable named** — never settle `done` because there was nowhere to put
 * it.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir } from "../_fixtures";

const dataDir = isolatedDataDir("zenith-usage-outbox-");
const ledgerDir = path.join(dataDir, "off-host");
process.env.ZENITH_BACKUP_TARGET = "filesystem";
process.env.ZENITH_BACKUP_DIR = ledgerDir;

const { closeAuthority, flushOutbox, openAuthority } = await import("@/lib/hosted/authority");
const { REVOCATION_LEDGER_KEY } = await import("@/lib/hosted/backup");
const { registerOpsOutboxHandlers } = await import("@/lib/hosted/usage");
const { OWNER, seedApp, seedGrant, seedSession } = await import("../backup/_ops-fixtures");

const a = openAuthority();
await registerOpsOutboxHandlers();

afterAll(async () => {
  closeAuthority();
  removeDir(dataDir);
});

const ledgerFile = (): string => path.join(ledgerDir, ...REVOCATION_LEDGER_KEY.split("/"));

/** Revoke a grant the way W5 does: state change, ledger row and outbox entry in one transaction. */
async function revoke(appId: string, grantId: string, subject: string, reason: string): Promise<string> {
  const outboxId = randomUUID();
  await a.tx(async (repos) => {
    await repos.grants.revoke(grantId, OWNER.subject, reason);
    await repos.sessions.terminateByGrant(grantId, "revoked");
    const entry = await repos.revocations.append({
      appId,
      grantId,
      subject,
      by: OWNER.subject,
      reason,
    });
    await repos.outbox.enqueue({
      id: outboxId,
      idempotencyKey: `revocation:${entry.seq}`,
      kind: "revocation_ledger",
      payload: { entry },
    });
  });
  return outboxId;
}

describe("the revocation_ledger handler", () => {
  it("appends one JSON line per revocation to the target's ledger key", async () => {
    const app = await seedApp(a, { slug: "ledger-app" });
    const first = await seedGrant(a, app.id, { subject: "sub-1", email: "one@example.test" }, "editor");
    const second = await seedGrant(a, app.id, { subject: "sub-2", email: "two@example.test" }, "viewer");
    await seedSession(a, app.id, first.id, "sub-1");

    await revoke(app.id, first.id, "sub-1", "left the team");
    await revoke(app.id, second.id, "sub-2", "project finished");

    const drained = await flushOutbox({ kinds: ["revocation_ledger"] });
    expect(drained).toMatchObject({ done: 2, failed: 0 });

    const lines = fs
      .readFileSync(ledgerFile(), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ seq: 1, appId: app.id, grantId: first.id, subject: "sub-1", reason: "left the team" });
    expect(lines[1]).toMatchObject({ seq: 2, grantId: second.id, subject: "sub-2" });
    // Every line carries what a restore needs to re-apply it.
    for (const line of lines) expect(Object.keys(line).sort()).toEqual(["appId", "at", "by", "grantId", "reason", "seq", "subject"]);
  });

  it("appends without overwriting what is already there", async () => {
    const before = fs.readFileSync(ledgerFile(), "utf8");
    const app = await seedApp(a, { slug: "ledger-app-2" });
    const grant = await seedGrant(a, app.id, { subject: "sub-3", email: "three@example.test" }, "editor");
    await revoke(app.id, grant.id, "sub-3", "role ended");
    await flushOutbox({ kinds: ["revocation_ledger"] });

    const after = fs.readFileSync(ledgerFile(), "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
  });

  it("refuses a payload that carries no sequence number, rather than writing a line a restore cannot order", async () => {
    const id = randomUUID();
    await a.tx((repos) =>
      repos.outbox.enqueue({
        id,
        idempotencyKey: `revocation:malformed:${id}`,
        kind: "revocation_ledger",
        payload: { appId: "a", grantId: "g", subject: "s", by: "b", at: new Date().toISOString() },
      })
    );
    const drained = await flushOutbox({ kinds: ["revocation_ledger"] });
    expect(drained.failed).toBe(1);
    expect((await a.repos.outbox.get(id))?.error).toMatch(/seq/);
  });

  it("fails loudly, naming ZENITH_BACKUP_TARGET, when there is nowhere off-host to write", async () => {
    const app = await seedApp(a, { slug: "ledger-app-none" });
    const grant = await seedGrant(a, app.id, { subject: "sub-4", email: "four@example.test" }, "editor");
    const previous = process.env.ZENITH_BACKUP_TARGET;
    process.env.ZENITH_BACKUP_TARGET = "none";
    try {
      const outboxId = await revoke(app.id, grant.id, "sub-4", "access removed");
      const drained = await flushOutbox({ kinds: ["revocation_ledger"] });
      expect(drained).toMatchObject({ done: 0, failed: 1 });

      const row = await a.repos.outbox.get(outboxId);
      expect(row?.state).toBe("failed");
      expect(row?.error).toMatch(/no backup target/i);
      // The revocation itself still stuck: only the off-host copy is missing.
      expect((await a.repos.grants.get(grant.id))?.state).toBe("revoked");
    } finally {
      process.env.ZENITH_BACKUP_TARGET = previous;
    }
  });
});

describe("the spend_alert handler", () => {
  it("settles the entry, and is honest that a log line is all it does", async () => {
    const id = randomUUID();
    await a.tx((repos) =>
      repos.outbox.enqueue({
        id,
        idempotencyKey: `spend:ws-alert:2026-09:50`,
        kind: "spend_alert",
        payload: { workspaceId: "ws-alert", month: "2026-09", threshold: 50, estimatedUsd: 50, envelopeUsd: 100 },
      })
    );
    const drained = await flushOutbox({ kinds: ["spend_alert"] });
    expect(drained).toMatchObject({ done: 1, failed: 0 });
    expect((await a.repos.outbox.get(id))?.state).toBe("done");
  });
});
