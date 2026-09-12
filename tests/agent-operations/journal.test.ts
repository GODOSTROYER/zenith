import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationJournal, OperationError, canonical, digest, openPrivateJournal, type Owner, type Preview } from "../../src/lib/agent-operations/journal";

const owner: Owner = { subject: "user-one", credentialId: "grant-one", workspaceId: "workspace-one", projectId: "project-one", environmentId: "env-one", authorizationHash: "authorization-v1" };
const preview: Preview = { summary: "Deploy the reviewed definition", details: ["Sandbox simulation"], risk: "low", costDeltaUsd: 1, warnings: [], requiredRole: "editor", requiresApproval: true };
let now: number, journal: OperationJournal;
const prepare = () => journal.prepare(owner, { kind: "deploy", input: {} }, "state-one", preview, randomUUID());
const approved = () => { const p = prepare(); return journal.decide(p.id, p.digest, "admin-one", "approve", randomUUID(), now + 10000); };
const guard = () => undefined;
beforeEach(() => { now = Date.now(); journal = new OperationJournal(new DatabaseSync(":memory:"), () => now); });
afterEach(() => { journal.close(); });

describe("durable review and dispatch", () => {
  it("canonicalizes objects without depending on property insertion order", () => {
    expect(canonical({ b: 2, a: [null, true] })).toBe('{"a":[null,true],"b":2}');
    expect(digest({ a: 1, b: 2 })).toBe(digest({ b: 2, a: 1 }));
    expect(() => canonical(Infinity)).toThrow(OperationError);
  });
  it("persists a receipt without dispatching anything", () => {
    const p = prepare(); expect(p.state).toBe("prepared"); expect(p.preview.requiresApproval).toBe(true);
    expect(journal.receipt(p.id, owner).digest).toBe(p.digest);
  });
  it("returns the same receipt for the same preparation ID", () => {
    const key = randomUUID(), intent = { kind: "deploy" as const, input: {} };
    const a = journal.prepare(owner, intent, "state", preview, key);
    expect(journal.prepare(owner, intent, "state", preview, key).id).toBe(a.id);
    expect(() => journal.prepare(owner, intent, "changed", preview, key)).toThrow(/already names different/);
  });
  it("does not create an executable receipt for a blocked action", () => {
    expect(() => journal.prepare(owner, { kind: "deploy", input: {} }, "state", { ...preview, blocked: "AWS Preview cannot apply" }, randomUUID())).toThrow(/AWS Preview/);
  });
  it("refuses execution without independent approval", () => {
    expect(() => journal.claim(prepare().id, owner, randomUUID(), guard)).toThrow(/independent operator/);
  });
  it("requires review of the exact immutable digest", () => {
    expect(() => journal.decide(prepare().id, "wrong", "admin-one", "approve", randomUUID(), now + 10000)).toThrow(/does not match/);
  });
  it("rejects an expired approval request", () => {
    const p = prepare(); expect(() => journal.decide(p.id, p.digest, "admin", "approve", randomUUID(), now)).toThrow(/expired/);
  });
  it("cannot reuse one signed approval nonce for another receipt", () => {
    const p = prepare(), q = prepare(), nonce = randomUUID();
    journal.decide(p.id, p.digest, "admin", "approve", nonce, now + 10000);
    expect(() => journal.decide(q.id, q.digest, "admin", "approve", nonce, now + 10000)).toThrow(/already used/);
  });
  it("refuses rejected and cancelled plans", () => {
    const p = prepare(); journal.decide(p.id, p.digest, "admin", "reject", randomUUID(), now + 10000);
    expect(() => journal.claim(p.id, owner, randomUUID(), guard)).toThrow(/independent operator/);
    const q = approved(); journal.cancel(q.id, owner);
    expect(() => journal.claim(q.id, owner, randomUUID(), guard)).toThrow(/independent operator/);
  });
  it("rejects stale state in the same transaction as the claim", () => {
    const p = approved();
    expect(() => journal.claim(p.id, owner, randomUUID(), () => { throw new OperationError("plan_stale", "State changed; re-plan."); })).toThrow(/State changed/);
    expect(journal.receipt(p.id, owner).state).toBe("approved");
    expect(journal.claim(p.id, owner, randomUUID(), guard).created).toBe(true);
  });
  it("rechecks a revoked approver before allocating an operation", () => {
    const p = approved(); expect(() => journal.claim(p.id, owner, randomUUID(), () => { throw new OperationError("approval_revoked", "Approver no longer has access."); })).toThrow(/no longer/);
    expect(journal.receipt(p.id, owner).state).toBe("approved");
  });
  it("expires approved receipts too", () => {
    const p = approved(); now += 900001;
    expect(() => journal.claim(p.id, owner, randomUUID(), guard)).toThrow(/expired/);
  });
  it.each(["subject", "credentialId", "workspaceId", "projectId", "environmentId", "authorizationHash"] as const)("binds receipts to %s", key => {
    const p = approved(); expect(() => journal.claim(p.id, { ...owner, [key]: "foreign" }, randomUUID(), guard)).toThrow(/No permitted/);
  });
  it("one hundred concurrent requests reserve exactly one dispatch", async () => {
    const p = approved();
    const results = await Promise.all(Array.from({ length: 100 }, async () => journal.claim(p.id, owner, randomUUID(), guard)));
    expect(results.filter(r => r.created)).toHaveLength(1);
    expect(new Set(results.map(r => r.operation.id)).size).toBe(1);
  });
  it("does not repurpose an idempotency key for different intent", () => {
    const key = randomUUID(); journal.claim(approved().id, owner, key, guard);
    expect(() => journal.claim(approved().id, owner, key, guard)).toThrow(/already belongs/);
  });
  it("returns a completed operation on retry even after plan expiry", () => {
    const p = approved(), key = randomUUID(), { operation } = journal.claim(p.id, owner, key, guard);
    journal.settle(operation.id, "accepted", { deploymentId: "deployment-one" }); now += 1000000;
    expect(journal.claim(p.id, owner, key, () => { throw new Error("must not run"); }).operation.result).toEqual({ deploymentId: "deployment-one" });
  });
  it("cannot use plan cancellation to undo an action already dispatched", () => {
    const p = approved(); journal.claim(p.id, owner, randomUUID(), guard);
    expect(() => journal.cancel(p.id, owner)).toThrow(/already.*|dispatched/);
  });
  it("records uncertain dispatch without retrying it", () => {
    const p = approved(), { operation } = journal.claim(p.id, owner, randomUUID(), guard);
    expect(journal.recoverInterrupted()).toBe(1);
    expect(journal.operation(operation.id, owner).state).toBe("needs_reconciliation");
    expect(journal.claim(p.id, owner, randomUUID(), guard).created).toBe(false);
    expect(journal.recoverInterrupted()).toBe(0);
  });
  it("persists state across a real SQLite close/reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "zenith-journal-")), path = join(dir, "journal.sqlite");
    try {
      const a = openPrivateJournal(path), p = a.prepare(owner, { kind: "deploy", input: {} }, "state", preview, randomUUID());
      a.decide(p.id, p.digest, "admin", "approve", randomUUID(), Date.now() + 10000);
      const op = a.claim(p.id, owner, randomUUID(), guard).operation; a.close();
      const b = openPrivateJournal(path); expect(b.recoverInterrupted()).toBe(1);
      expect(b.operation(op.id, owner).state).toBe("needs_reconciliation");
      expect(b.claim(p.id, owner, randomUUID(), guard).created).toBe(false); b.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("refuses unsafe directories and symlink journals", () => {
    const dir = mkdtempSync(join(tmpdir(), "zenith-journal-"));
    try {
      chmodSync(dir, 0o755); expect(() => openPrivateJournal(join(dir, "a.sqlite"))).toThrow(/0700/);
      chmodSync(dir, 0o700); const a = openPrivateJournal(join(dir, "a.sqlite")); a.close();
      symlinkSync(join(dir, "a.sqlite"), join(dir, "link.sqlite"));
      expect(() => openPrivateJournal(join(dir, "link.sqlite"))).toThrow(/0600/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("provides scoped ordered metadata-only operation events", () => {
    const { operation } = journal.claim(approved().id, owner, randomUUID(), guard);
    journal.settle(operation.id, "accepted", { deploymentId: "one" });
    const events = journal.events(operation.id, owner); expect(events.map(e => e.kind)).toEqual(["dispatching", "accepted"]);
    expect(journal.events(operation.id, owner, events[0].seq)).toHaveLength(1);
    expect(() => journal.events(operation.id, { ...owner, subject: "other" })).toThrow(/No permitted/);
  });
});
