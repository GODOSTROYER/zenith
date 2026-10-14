/**
 * PROD-OPS-07: configurable non-destructive retention on real PGlite SQL and a real filesystem object store.
 * Covers the policy schema and gate, the hard never-prunable invariants, copy-only archiving with sealed readback,
 * archive-gated bounded pruning, legal holds (tenant, resource, time) and the dry-run preview. Contract level
 * (PGlite, local directory), no live Postgres or S3 claim. Keys are generated at runtime.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import * as repos from "@/lib/controlplane/db/repos";
import { FilesystemTarget, S3Target } from "@/lib/hosted/backup/targets";
import { unseal } from "@/lib/hosted/backup/crypto";
import { archiveBatch, archiveTargetFromEnv, pruneArchive, rowsDigestOf, type ArchiveTarget } from "@/lib/retention/archive";
import { CLASS_SPECS, NEVER_PRUNABLE, RETENTION_CLASSES, RetentionInvariantError, assertPrunableClass, refusalFor } from "@/lib/retention/classes";
import { RETENTION_WORKSPACE_PAGES_PER_CLASS, retentionPass, type RetentionOptions } from "@/lib/retention/job";
import {
  APPROVED_ARCHIVE_EXPIRY_DAYS, APPROVED_LOG_RETENTION_DAYS, APPROVED_PAYLOAD_RETENTION_HOURS, AUDIT_MINIMUM_RETENTION_DAYS, DEFAULT_RETENTION_POLICY, loadRetentionPolicy, parseRetentionPolicy, resolveArchiveExpiry, resolveWindow, retentionApplyGate, RetentionPolicyError, tenantArchiveExpiryOptIn, type PolicyLoad, type RetentionPolicy,
} from "@/lib/retention/policy";
import { archiveWatermark, classSql, createHold, listArchives, listHolds, markPruned, previewRetention, pruneSql, recordArchive, releaseHold } from "@/lib/retention/store";
import { newWorkspace, seedApprovedOperation, uid } from "../controlplane/_support/harness";

const PUBKEY = "A".repeat(43);
const KEY = randomBytes(32);
const APPROVAL = { decision: "DEC-RETENTION", approvedBy: "test-operator", approvedAt: "2026-10-01T00:00:00.000Z" } as const;
const APPLY_ENV = { ZENITH_RETENTION_APPLY: "1" };

let db: PlatformDbHandle;
let dir: string;
let target: FilesystemTarget;
beforeAll(async () => {
  db = await openPlatformDb({ kind: "pglite" });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-retention-"));
  target = new FilesystemTarget(dir);
}, 60_000);
afterAll(async () => { await db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const policyOf = (classes: RetentionPolicy["classes"], approved = true, workspaces: RetentionPolicy["workspaces"] = {}): RetentionPolicy =>
  parseRetentionPolicy({ version: 1, classes, workspaces, ...(approved ? { approval: APPROVAL } : {}) });
const loadOf = (policy: RetentionPolicy): PolicyLoad => ({ ok: true, policy, source: "inline", digest: "0".repeat(64) });
const run = (o: RetentionOptions) => retentionPass(db, { maxBatches: 100, maxPrunes: 100, ...o });
const LOGS = { runner_job_logs: { archiveAfterDays: 30, pruneAfterDays: 90 } } as const;
/** A policy with no windows at all, for tests that need "retain everything". */
const RETAIN_ALL: RetentionPolicy = parseRetentionPolicy({ version: 1, classes: {}, workspaces: {}, approval: APPROVAL });

async function runner(ws: string) {
  const { tokenHash } = repos.runners.generateRegistrationToken("runner");
  await repos.runners.createRegistrationToken(db, { workspaceId: ws, kind: "runner", createdBy: "admin", tokenHash });
  return repos.runners.registerRunner(db, { tokenHash, name: "r", publicKey: PUBKEY, capabilities: ["tofu.run"] });
}

/** A runner job with `lines` log lines recorded `ageDays` ago; settled unless `settle` is false. */
async function jobWithLogs(ws: string, runnerId: string, ageDays: number, lines = 3, settle = true): Promise<{ jobId: string; operationId: string }> {
  const { operation } = await seedApprovedOperation(db, ws);
  const jobId = uid("job");
  await repos.jobs.enqueue(db, { id: jobId, workspaceId: ws, runnerId, operationId: operation.id, kind: "tofu.run", capability: "infrastructure.apply", envelope: "eyJhbGciOiJFZERTQSJ9.payload.signature" });
  expect(await repos.jobs.claimNext(db, { workspaceId: ws, runnerId, max: 1 })).toHaveLength(1);
  if (settle) expect(await repos.jobs.settle(db, { workspaceId: ws, runnerId, jobId, status: "succeeded", result: { exitCode: 0 } })).toBe(true);
  for (let i = 0; i < lines; i++) {
    await db.query(
      `insert into platform.runner_job_logs (job_id, workspace_id, batch_seq, line_no, ts, stream, line, recorded_at)
       values ($1, $2, 0, $3, clock_timestamp(), 'stdout', $4, clock_timestamp() - ($5::int * interval '1 day'))`,
      [jobId, ws, i, `line-${i}-${randomBytes(6).toString("hex")}`, ageDays]);
  }
  return { jobId, operationId: operation.id };
}

const logCount = async (ws: string, jobId?: string): Promise<number> =>
  (await db.query<{ n: number }>("select count(*)::int as n from platform.runner_job_logs where workspace_id = $1 and ($2::text is null or job_id = $2)", [ws, jobId ?? null]))[0].n;

const protectedCounts = async (): Promise<Record<string, number>> => {
  const out: Record<string, number> = {};
  for (const t of ["operations", "events", "approvals", "agent_effect_receipts", "external_effects", "idempotency_keys", "runner_jobs", "agent_nonces"]) {
    out[t] = (await db.query<{ n: number }>(`select count(*)::int as n from platform.${t}`))[0].n;
  }
  return out;
};

describe("policy schema and gate", () => {
  it("ships the approved DEC-RETENTION baseline as the default: logs 30 days, audit-evidence classes retained, approval recorded", () => {
    expect(loadRetentionPolicy({}).ok).toBe(true);
    expect(loadRetentionPolicy({}).policy).toEqual(DEFAULT_RETENTION_POLICY);
    expect(APPROVED_LOG_RETENTION_DAYS).toBe(30);
    expect(APPROVED_PAYLOAD_RETENTION_HOURS).toBe(72);
    expect(AUDIT_MINIMUM_RETENTION_DAYS).toBe(365);
    for (const cls of ["runner_job_logs", "machine_request_logs"] as const) expect(resolveWindow(DEFAULT_RETENTION_POLICY, "ws", cls)).toEqual({ archiveAfterDays: 30, pruneAfterDays: 30 });
    for (const cls of ["resource_observations", "drift_reports"] as const) expect(resolveWindow(DEFAULT_RETENTION_POLICY, "ws", cls)).toEqual({ archiveAfterDays: null, pruneAfterDays: null });
    expect(DEFAULT_RETENTION_POLICY.workspaces).toEqual({});
    expect(DEFAULT_RETENTION_POLICY.approval).toMatchObject({ decision: "DEC-RETENTION", approvedBy: "Arnav Bule", approvedAt: "2026-10-13T00:00:00.000Z" });
    // the built-in policy is itself a valid policy
    expect(parseRetentionPolicy(JSON.parse(JSON.stringify(DEFAULT_RETENTION_POLICY)))).toEqual(DEFAULT_RETENTION_POLICY);
    // approved is not running: deletion still needs the operator switch, and an operator policy needs its own approval
    expect(retentionApplyGate({}, loadRetentionPolicy({})).enabled).toBe(false);
    expect(retentionApplyGate(APPLY_ENV, loadRetentionPolicy({})).enabled).toBe(true);
    const operator = loadRetentionPolicy({ ZENITH_RETENTION_POLICY: JSON.stringify({ version: 1, classes: LOGS }) });
    expect(retentionApplyGate(APPLY_ENV, operator).enabled).toBe(false);
  });

  it("refuses a prune window shorter than one year on audit-evidence classes, at class and workspace level", () => {
    for (const cls of ["resource_observations", "drift_reports"]) {
      expect(() => parseRetentionPolicy({ version: 1, classes: { [cls]: { archiveAfterDays: 30, pruneAfterDays: 90 } } })).toThrow(/at least 365 days/);
      expect(() => parseRetentionPolicy({ version: 1, classes: { [cls]: { archiveAfterDays: 30, pruneAfterDays: 364 } } })).toThrow(RetentionPolicyError);
      expect(() => parseRetentionPolicy({ version: 1, workspaces: { ws_a: { [cls]: { archiveAfterDays: 30, pruneAfterDays: 30 } } } })).toThrow(/at least 365 days/);
      expect(parseRetentionPolicy({ version: 1, classes: { [cls]: { archiveAfterDays: 30, pruneAfterDays: 365 } } }).classes).toBeTruthy();
      expect(parseRetentionPolicy({ version: 1, classes: { [cls]: { archiveAfterDays: 30 } } }).classes).toBeTruthy();
    }
    // logs are not audit evidence
    expect(() => parseRetentionPolicy({ version: 1, classes: { runner_job_logs: { archiveAfterDays: 1, pruneAfterDays: 1 } } })).not.toThrow();
    // a bad file never half-applies: the loader reports it and nothing is deleted
    const bad = loadRetentionPolicy({ ZENITH_RETENTION_POLICY: JSON.stringify({ version: 1, classes: { drift_reports: { archiveAfterDays: 1, pruneAfterDays: 2 } }, approval: APPROVAL }) });
    expect(bad.ok).toBe(false);
    expect(retentionApplyGate(APPLY_ENV, bad).enabled).toBe(false);
  });

  it("applies workspace overrides over class defaults", () => {
    const p = policyOf({ runner_job_logs: { archiveAfterDays: 30, pruneAfterDays: 90 } }, false, { ws_a: { runner_job_logs: { pruneAfterDays: null } }, ws_b: { runner_job_logs: { archiveAfterDays: 7, pruneAfterDays: 14 } } });
    expect(resolveWindow(p, "ws_x", "runner_job_logs")).toEqual({ archiveAfterDays: 30, pruneAfterDays: 90 });
    expect(resolveWindow(p, "ws_a", "runner_job_logs")).toEqual({ archiveAfterDays: 30, pruneAfterDays: null });
    expect(resolveWindow(p, "ws_b", "runner_job_logs")).toEqual({ archiveAfterDays: 7, pruneAfterDays: 14 });
  });

  it("refuses protected tables and unknown classes with the reason", () => {
    for (const name of ["operations", "approvals", "events", "agent_effect_receipts", "external_effects", "idempotency_keys", "platform.agent_nonces", "evidence"]) {
      const bad = () => parseRetentionPolicy({ version: 1, classes: { [name]: { archiveAfterDays: 1, pruneAfterDays: 2 } } });
      expect(bad).toThrow(RetentionPolicyError);
      expect(refusalFor(name)).toMatch(/protected/);
    }
    expect(() => parseRetentionPolicy({ version: 1, classes: { nonsense: { archiveAfterDays: 1 } } })).toThrow(/not a retention class/);
  });

  it("refuses a prune window that is not preceded by an archive window, and malformed values", () => {
    expect(() => parseRetentionPolicy({ version: 1, classes: { runner_job_logs: { pruneAfterDays: 30 } } })).toThrow(/archived before/);
    expect(() => parseRetentionPolicy({ version: 1, classes: { runner_job_logs: { archiveAfterDays: 40, pruneAfterDays: 30 } } })).toThrow(RetentionPolicyError);
    for (const days of [0, -1, 1.5, "30", 40_000]) expect(() => parseRetentionPolicy({ version: 1, classes: { runner_job_logs: { archiveAfterDays: days } } })).toThrow(RetentionPolicyError);
    expect(() => parseRetentionPolicy({ version: 2 })).toThrow(RetentionPolicyError);
    expect(() => parseRetentionPolicy({ version: 1, surprise: true })).toThrow(RetentionPolicyError);
    expect(() => parseRetentionPolicy({ version: 1, approval: { decision: "DEC-RETENTION" } })).toThrow(RetentionPolicyError);
    expect(() => parseRetentionPolicy({ version: 1, workspaces: { ws: { runner_job_logs: { pruneAfterDays: 5 } } } })).toThrow(RetentionPolicyError);
  });

  it("loads from a file or inline JSON, and an invalid or ambiguous source keeps everything", () => {
    const inline = JSON.stringify({ version: 1, classes: LOGS });
    expect(loadRetentionPolicy({ ZENITH_RETENTION_POLICY: inline })).toMatchObject({ ok: true, source: "inline" });
    expect(loadRetentionPolicy({ ZENITH_RETENTION_POLICY_FILE: "p.json" }, () => inline)).toMatchObject({ ok: true, source: "file" });
    const both = loadRetentionPolicy({ ZENITH_RETENTION_POLICY: inline, ZENITH_RETENTION_POLICY_FILE: "p.json" }, () => inline);
    expect(both).toMatchObject({ ok: false, source: "both", policy: DEFAULT_RETENTION_POLICY });
    for (const text of ["{not json", JSON.stringify({ version: 1, classes: { operations: { archiveAfterDays: 1 } } })]) {
      const bad = loadRetentionPolicy({ ZENITH_RETENTION_POLICY: text });
      expect(bad.ok).toBe(false);
      expect(bad.policy).toEqual(DEFAULT_RETENTION_POLICY);
    }
    expect(loadRetentionPolicy({ ZENITH_RETENTION_POLICY_FILE: "missing.json" }, () => { throw new Error("ENOENT secret/path"); })).toMatchObject({ ok: false, problems: [expect.not.stringContaining("secret")] });
  });

  it("opens the delete gate only with ZENITH_RETENTION_APPLY=1 AND a DEC-RETENTION approval in a valid policy", () => {
    const approved = loadOf(policyOf(LOGS, true));
    const unapproved = loadOf(policyOf(LOGS, false));
    expect(retentionApplyGate({}, approved).enabled).toBe(false);
    expect(retentionApplyGate({ ZENITH_RETENTION_APPLY: "true" }, approved).enabled).toBe(false);
    expect(retentionApplyGate(APPLY_ENV, unapproved).enabled).toBe(false);
    expect(retentionApplyGate(APPLY_ENV, { ok: false, policy: DEFAULT_RETENTION_POLICY, source: "inline", digest: "", problems: ["x"] }).enabled).toBe(false);
    expect(retentionApplyGate(APPLY_ENV, approved).enabled).toBe(true);
  });
});

describe("hard invariants", () => {
  it("no retention class names a protected table, and every statement targets only its class table", () => {
    for (const cls of RETENTION_CLASSES) {
      const spec = CLASS_SPECS[cls];
      expect(spec.table in NEVER_PRUNABLE).toBe(false);
      expect(assertPrunableClass(cls)).toBe(cls);
      const del = pruneSql(cls);
      expect(del).toMatch(new RegExp(`^delete from ${spec.table.replace(".", "\\.")} l`));
      // the only other tables a delete may mention are the settled-parent join, the hold table and the same-table latest check
      const mentioned = new Set([...del.matchAll(/platform\.\w+/g)].map((m) => m[0]));
      const allowed = new Set([spec.table, "platform.legal_holds", ...(spec.parent ? [spec.parent.table] : [])]);
      for (const t of mentioned) expect(allowed.has(t)).toBe(true);
      // the parent is read, never deleted
      expect(del.includes(`delete from ${spec.parent?.table ?? "\u0000"}`)).toBe(false);
      expect(classSql(cls).held).toContain("released_at is null");
    }
  });

  it("refuses to build a statement for anything that is not a retention class", () => {
    for (const name of Object.keys(NEVER_PRUNABLE).concat(["platform.runner_jobs", "runner_jobs", "x; drop table platform.operations"])) {
      expect(() => assertPrunableClass(name)).toThrow(RetentionInvariantError);
      expect(() => pruneSql(name as never)).toThrow(RetentionInvariantError);
    }
    for (const required of ["platform.operations", "platform.approvals", "platform.events", "platform.agent_effect_receipts", "platform.external_effects", "platform.idempotency_keys", "platform.agent_nonces", "platform.runner_jobs"]) {
      expect(required in NEVER_PRUNABLE).toBe(true);
    }
  });

  it("never touches protected tables or unsettled jobs, even with the gate open and a one-day window", async () => {
    const ws = newWorkspace();
    const { id: runnerId } = await runner(ws);
    const settled = await jobWithLogs(ws, runnerId, 400);
    const running = await jobWithLogs(ws, runnerId, 400, 2, false);
    const before = await protectedCounts();
    const policy = policyOf({ runner_job_logs: { archiveAfterDays: 1, pruneAfterDays: 1 } });
    const first = await run({ env: APPLY_ENV, load: loadOf(policy), target, key: KEY });
    expect(first).toMatchObject({ applied: true, archiveFailed: 0 });
    const second = await run({ env: APPLY_ENV, load: loadOf(policy), target, key: KEY });
    expect(first.prunedRows + second.prunedRows).toBeGreaterThanOrEqual(3);
    expect(await logCount(ws, settled.jobId)).toBe(0);
    expect(await logCount(ws, running.jobId)).toBe(2);
    expect(await protectedCounts()).toEqual(before);
    const job = await db.query<{ status: string; envelope: string }>("select status, envelope from platform.runner_jobs where id = $1", [settled.jobId]);
    expect(job[0]).toEqual({ status: "succeeded", envelope: "eyJhbGciOiJFZERTQSJ9.payload.signature" });
  });
});

describe("archive: copy only, sealed, read back", () => {
  it("copies cold rows to tenant-prefixed sealed storage and leaves the source untouched without the gate", async () => {
    const ws = newWorkspace();
    const { id: runnerId } = await runner(ws);
    const old = await jobWithLogs(ws, runnerId, 45, 4);
    const fresh = await jobWithLogs(ws, runnerId, 2, 2);
    const live = await jobWithLogs(ws, runnerId, 45, 2, false);
    const policy = policyOf(LOGS, false);
    const result = await run({ env: {}, load: loadOf(policy), target, key: KEY });
    expect(result).toMatchObject({ applied: false, archiveFailed: 0, prunedRows: 0 });
    expect(result.archivedRows).toBeGreaterThanOrEqual(4);
    expect(await logCount(ws, old.jobId)).toBe(4);
    expect(await logCount(ws, fresh.jobId)).toBe(2);
    expect(await logCount(ws, live.jobId)).toBe(2);

    const archives = (await listArchives(db, { workspaceId: ws })).filter((a) => a.dataClass === "runner_job_logs");
    expect(archives).toHaveLength(1);
    const a = archives[0];
    expect(a.rowCount).toBe(4);
    expect(a.objectKey.startsWith(`retention/${ws}/runner_job_logs/`)).toBe(true);
    const bytes = await target.get(a.objectKey);
    expect(bytes).not.toBeNull();
    // sealed: no plaintext lines in the stored object
    expect(bytes!.toString("utf8")).not.toContain("line-0-");
    const payload = JSON.parse(unseal(bytes!, KEY).plain.toString("utf8"));
    expect(payload.workspaceId).toBe(ws);
    expect(payload.manifest).toMatchObject({ rowCount: 4, rowsDigest: a.rowsDigest });
    expect(rowsDigestOf(payload.rows)).toBe(a.rowsDigest);
    expect(payload.rows.every((r: { job_id: string }) => r.job_id === old.jobId)).toBe(true);

    // idempotent: nothing new to archive
    const again = await run({ env: {}, load: loadOf(policy), target, key: KEY });
    expect((await listArchives(db, { workspaceId: ws })).filter((x) => x.dataClass === "runner_job_logs")).toHaveLength(1);
    expect(again.archiveFailed).toBe(0);
  });

  it("records no archive when the stored object does not read back to the same digest", async () => {
    const ws = newWorkspace();
    const { id: runnerId } = await runner(ws);
    await jobWithLogs(ws, runnerId, 60, 3);
    const corrupting: ArchiveTarget = {
      label: "corrupting",
      put: async (key, bytes) => { const bad = Buffer.from(bytes); bad[bad.length - 1] ^= 0xff; await target.put(key, bad); },
      get: (key) => target.get(key),
      delete: (key) => target.delete(key),
    };
    const out = await archiveBatch(db, ws, "runner_job_logs", 30, { target: corrupting, key: KEY, policy: policyOf(LOGS) });
    expect(out).toEqual({ status: "failed", reason: "digest_mismatch" });
    const lost: ArchiveTarget = { label: "lost", put: async () => undefined, get: async () => null, delete: async () => undefined };
    expect(await archiveBatch(db, ws, "runner_job_logs", 30, { target: lost, key: KEY, policy: policyOf(LOGS) })).toEqual({ status: "failed", reason: "digest_mismatch" });
    const broken: ArchiveTarget = { label: "broken", put: async () => { throw new Error("denied"); }, get: async () => null, delete: async () => undefined };
    expect(await archiveBatch(db, ws, "runner_job_logs", 30, { target: broken, key: KEY, policy: policyOf(LOGS) })).toEqual({ status: "failed", reason: "write_failed" });
    expect(await listArchives(db, { workspaceId: ws })).toHaveLength(0);
    expect(await logCount(ws)).toBe(3);
  });

  it("builds the archive target from configuration and refuses incomplete configuration", () => {
    expect(archiveTargetFromEnv({}).ok).toBe(false);
    expect(archiveTargetFromEnv({ ZENITH_RETENTION_ARCHIVE_TARGET: "filesystem" }).ok).toBe(false);
    expect(archiveTargetFromEnv({ ZENITH_RETENTION_ARCHIVE_TARGET: "s3" }).ok).toBe(false);
    expect(archiveTargetFromEnv({ ZENITH_RETENTION_ARCHIVE_TARGET: "ftp" }).ok).toBe(false);
    expect(archiveTargetFromEnv({ ZENITH_RETENTION_ARCHIVE_TARGET: "filesystem", ZENITH_RETENTION_ARCHIVE_DIR: dir })).toMatchObject({ ok: true, kind: "filesystem" });
    expect(archiveTargetFromEnv({ ZENITH_RETENTION_ARCHIVE_TARGET: "s3", ZENITH_RETENTION_ARCHIVE_S3_BUCKET: "b" }, { send: async () => ({}) })).toMatchObject({ ok: true, kind: "s3" });
  });

  it("does nothing without archive storage or with an invalid policy, and reports why", async () => {
    const wsNoStore = newWorkspace();
    await jobWithLogs(wsNoStore, (await runner(wsNoStore)).id, 60, 2);
    const noStorage = await run({ env: {}, load: loadOf(policyOf(LOGS)), key: KEY });
    expect(noStorage).toMatchObject({ policyActive: 1, archiveBatches: 0, prunedRows: 0 });
    expect(noStorage.note).toMatch(/archive storage/i);
    const invalid = await run({ env: APPLY_ENV, load: { ok: false, policy: DEFAULT_RETENTION_POLICY, source: "inline", digest: "", problems: ["bad"] }, target, key: KEY });
    expect(invalid).toMatchObject({ policyInvalid: 1, applied: false, archiveBatches: 0, prunedRows: 0 });
    const none = await run({ env: APPLY_ENV, load: loadOf(RETAIN_ALL), target, key: KEY });
    expect(none).toMatchObject({ policyActive: 0, archiveBatches: 0, prunedRows: 0 });
  });
});

describe("prune: archive-gated, bounded, gated", () => {
  it("deletes nothing without the gate, and only archived rows past the prune window with it", async () => {
    const ws = newWorkspace();
    const { id: runnerId } = await runner(ws);
    const veryOld = await jobWithLogs(ws, runnerId, 120, 3);
    const middle = await jobWithLogs(ws, runnerId, 45, 3);
    const policy = policyOf(LOGS);
    // unapproved policy and missing flag: archive but never delete
    await run({ env: APPLY_ENV, load: loadOf(policyOf(LOGS, false)), target, key: KEY });
    await run({ env: {}, load: loadOf(policy), target, key: KEY });
    expect(await logCount(ws)).toBe(6);

    // a row that was never archived is never pruned: add old logs after the archive
    const late = await jobWithLogs(ws, runnerId, 200, 2);
    await db.query("update platform.runner_job_logs set recorded_at = recorded_at - interval '400 days' where job_id = $1", [late.jobId]);
    const lateBefore = await logCount(ws, late.jobId);
    const out = await run({ env: APPLY_ENV, load: loadOf(policy), target, key: KEY, recheckMs: 0 });
    expect(out.applied).toBe(true);
    expect(await logCount(ws, veryOld.jobId)).toBe(0);
    expect(await logCount(ws, middle.jobId)).toBe(3);
    // the late rows sit before the archive watermark, so they were not archived and must survive
    expect(await logCount(ws, late.jobId)).toBe(lateBefore);
    const archive = (await listArchives(db, { workspaceId: ws })).find((a) => a.dataClass === "runner_job_logs")!;
    expect(archive.prunedRows).toBeGreaterThanOrEqual(3);
  });

  it("refuses to prune when the archive object can no longer be verified", async () => {
    const ws = newWorkspace();
    const { id: runnerId } = await runner(ws);
    const j = await jobWithLogs(ws, runnerId, 150, 2);
    await run({ env: {}, load: loadOf(policyOf(LOGS, false)), target, key: KEY });
    const archive = (await listArchives(db, { workspaceId: ws })).find((a) => a.dataClass === "runner_job_logs")!;
    const bytes = (await target.get(archive.objectKey))!;
    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 2] ^= 0x01;
    await target.put(archive.objectKey, tampered);
    const r = await pruneArchive(db, archive, 90, true, { target, key: KEY });
    expect(r).toEqual({ status: "skipped", reason: "archive_unreadable" });
    expect(await logCount(ws, j.jobId)).toBe(2);
    // wrong sealing key
    await target.put(archive.objectKey, bytes);
    expect(await pruneArchive(db, archive, 90, true, { target, key: randomBytes(32) })).toEqual({ status: "skipped", reason: "archive_unreadable" });
    expect(await logCount(ws, j.jobId)).toBe(2);
    // intact object and gate open: pruned
    expect(await pruneArchive(db, archive, 90, true, { target, key: KEY })).toMatchObject({ status: "pruned", deleted: 2 });
  });

  it("pruneArchive cannot be called without the apply gate", async () => {
    const ws = newWorkspace();
    const { id: runnerId } = await runner(ws);
    await jobWithLogs(ws, runnerId, 150, 1);
    await run({ env: {}, load: loadOf(policyOf(LOGS, false)), target, key: KEY });
    const archive = (await listArchives(db, { workspaceId: ws }))[0];
    await expect(pruneArchive(db, archive, 90, false, { target, key: KEY })).rejects.toThrow(/apply gate/);
    expect(await logCount(ws)).toBe(1);
  });

  it("keeps the latest drift report of every environment and prunes the older ones", async () => {
    const ws = newWorkspace();
    const ins = (env: string, ageDays: number) => db.query(
      `insert into platform.drift_reports (id, workspace_id, environment_id, graph_digest, computed_at, simulated, recorded_at)
       values ($1, $2, $3, $4, clock_timestamp() - ($5::int * interval '1 day'), true, clock_timestamp() - ($5::int * interval '1 day'))`,
      [uid("drift"), ws, env, "d".repeat(64), ageDays]);
    await ins("env_a", 900); await ins("env_a", 800); await ins("env_a", 700); // newest of env_a is 700 days old
    await ins("env_b", 10);
    const policy = policyOf({ drift_reports: { archiveAfterDays: 365, pruneAfterDays: 400 } });
    await run({ env: APPLY_ENV, load: loadOf(policy), target, key: KEY });
    await run({ env: APPLY_ENV, load: loadOf(policy), target, key: KEY, recheckMs: 0 });
    const left = await db.query<{ environment_id: string }>("select environment_id from platform.drift_reports where workspace_id = $1 order by environment_id, computed_at", [ws]);
    expect(left.map((r) => r.environment_id)).toEqual(["env_a", "env_b"]);
  });
});

describe("legal holds", () => {
  async function archived(ws: string, ages: number[]) {
    const { id: runnerId } = await runner(ws);
    const jobs = [];
    for (const age of ages) jobs.push(await jobWithLogs(ws, runnerId, age, 2));
    await run({ env: {}, load: loadOf(policyOf(LOGS, false)), target, key: KEY });
    return jobs;
  }
  const prune = () => run({ env: APPLY_ENV, load: loadOf(policyOf(LOGS)), target, key: KEY, recheckMs: 0 });

  it("a tenant hold blocks pruning, other tenants are unaffected, release lets pruning proceed", async () => {
    const held = newWorkspace();
    const other = newWorkspace();
    const [h] = await archived(held, [150]);
    const [o] = await archived(other, [150]);
    const hold = await createHold(db, { workspaceId: held, reason: "litigation", actor: "op" });
    await prune();
    expect(await logCount(held, h.jobId)).toBe(2);
    expect(await logCount(other, o.jobId)).toBe(0);
    await releaseHold(db, { id: hold.id, workspaceId: held, actor: "op", reason: "resolved" });
    await prune();
    expect(await logCount(held, h.jobId)).toBe(0);
  });

  it("a resource hold protects one job (or every job of one operation) and nothing else", async () => {
    const ws = newWorkspace();
    const [a, b, c] = await archived(ws, [150, 150, 150]);
    await createHold(db, { workspaceId: ws, dataClass: "runner_job_logs", resourceRef: a.jobId, reason: "job", actor: "op" });
    await createHold(db, { workspaceId: ws, resourceRef: b.operationId, reason: "operation", actor: "op" });
    await prune();
    expect(await logCount(ws, a.jobId)).toBe(2);
    expect(await logCount(ws, b.jobId)).toBe(2);
    expect(await logCount(ws, c.jobId)).toBe(0);
  });

  it("a time-scoped hold protects only rows recorded inside its range", async () => {
    const ws = newWorkspace();
    const [early, late] = await archived(ws, [200, 120]);
    const from = new Date(Date.now() - 130 * 86_400_000).toISOString();
    const to = new Date(Date.now() - 110 * 86_400_000).toISOString();
    await createHold(db, { workspaceId: ws, timeFrom: from, timeTo: to, reason: "window", actor: "op" });
    await prune();
    expect(await logCount(ws, early.jobId)).toBe(0);
    expect(await logCount(ws, late.jobId)).toBe(2);
  });

  it("a hold stops archive copies, the watermark never passes a held row, and release resumes without skipping it", async () => {
    const ws = newWorkspace();
    const { id: runnerId } = await runner(ws);
    const early = await jobWithLogs(ws, runnerId, 300, 2);
    const heldJob = await jobWithLogs(ws, runnerId, 200, 2);
    const late = await jobWithLogs(ws, runnerId, 100, 2);
    const policy = policyOf(LOGS, false);
    const hold = await createHold(db, { workspaceId: ws, dataClass: "runner_job_logs", resourceRef: heldJob.jobId, reason: "case", actor: "op" });
    const first = await run({ env: {}, load: loadOf(policy), target, key: KEY });
    expect(first.archiveHeld).toBeGreaterThanOrEqual(1);
    const archivedFirst = (await listArchives(db, { workspaceId: ws })).filter((a) => a.dataClass === "runner_job_logs");
    // only the rows strictly before the held job were copied
    expect(archivedFirst).toHaveLength(1);
    expect(archivedFirst[0].rowCount).toBe(2);
    const copied = JSON.parse(unseal((await target.get(archivedFirst[0].objectKey))!, KEY).plain.toString("utf8"));
    expect(copied.rows.every((r: { job_id: string }) => r.job_id === early.jobId)).toBe(true);
    const wm = await archiveWatermark(db, ws, "runner_job_logs");
    expect(wm).not.toBeNull();
    // nothing further is copied while the first remaining row is held, and the later job is not skipped ahead to
    const again = await archiveBatch(db, ws, "runner_job_logs", 30, { target, key: KEY, policy });
    expect(again).toEqual({ status: "blocked", reason: "legal_hold" });
    expect(await archiveWatermark(db, ws, "runner_job_logs")).toEqual(wm);
    expect((await listArchives(db, { workspaceId: ws })).filter((a) => a.dataClass === "runner_job_logs")).toHaveLength(1);
    // a prune pass cannot delete the held or the not-yet-archived rows
    await run({ env: APPLY_ENV, load: loadOf(policyOf(LOGS)), target, key: KEY, recheckMs: 0 });
    expect(await logCount(ws, heldJob.jobId)).toBe(2);
    expect(await logCount(ws, late.jobId)).toBe(2);

    await releaseHold(db, { id: hold.id, workspaceId: ws, actor: "op" });
    await run({ env: {}, load: loadOf(policy), target, key: KEY });
    const archived = (await listArchives(db, { workspaceId: ws })).filter((a) => a.dataClass === "runner_job_logs");
    const ids = new Set<string>();
    for (const a of archived) for (const r of JSON.parse(unseal((await target.get(a.objectKey))!, KEY).plain.toString("utf8")).rows as { job_id: string }[]) ids.add(r.job_id);
    expect([...ids].sort()).toEqual([early.jobId, heldJob.jobId, late.jobId].sort());
  });

  describe("workspace paging", () => {
    /** `n` workspaces whose only (very old) rows are under a workspace-wide hold, plus helpers to release them. */
    async function blockedWorkspaces(n: number, ageDays: number) {
      const holds: { id: string; workspaceId: string }[] = [];
      for (let i = 0; i < n; i++) {
        const ws = newWorkspace();
        await jobWithLogs(ws, (await runner(ws)).id, ageDays, 1);
        holds.push(await createHold(db, { workspaceId: ws, reason: "paging", actor: "op" }));
      }
      return { holds, release: async () => { for (const h of holds) await releaseHold(db, { id: h.id, workspaceId: h.workspaceId, actor: "op" }); } };
    }
    const archivedFor = async (ws: string) => (await listArchives(db, { workspaceId: ws })).filter((a) => a.dataClass === "runner_job_logs").length;

    it("an unblocked workspace behind a full page of held workspaces is still archived in the same pass", async () => {
      const blocked = await blockedWorkspaces(3, 2000);
      const free = newWorkspace();
      await jobWithLogs(free, (await runner(free)).id, 1500, 2);
      try {
        const out = await run({ env: {}, load: loadOf(policyOf(LOGS, false)), target, key: KEY, workspacesPerPage: 2 });
        expect(out.archiveHeld).toBeGreaterThanOrEqual(3);
        expect(await archivedFor(free)).toBe(1);
        for (const h of blocked.holds) expect(await archivedFor(h.workspaceId)).toBe(0);
      } finally { await blocked.release(); }
      // archive the released workspaces now so they do not count as candidates in the next test
      await run({ env: {}, load: loadOf(policyOf(LOGS, false)), target, key: KEY });
      for (const h of blocked.holds) expect(await archivedFor(h.workspaceId)).toBe(1);
    });

    it("scans a bounded number of pages per class per tick", async () => {
      expect(RETENTION_WORKSPACE_PAGES_PER_CLASS).toBeGreaterThan(0);
      const pageSize = 2;
      const blocked = await blockedWorkspaces(RETENTION_WORKSPACE_PAGES_PER_CLASS * pageSize, 2000);
      const free = newWorkspace();
      await jobWithLogs(free, (await runner(free)).id, 1500, 1);
      try {
        const out = await run({ env: {}, load: loadOf(policyOf(LOGS, false)), target, key: KEY, workspacesPerPage: pageSize });
        // every page was full of held workspaces, so the scan stopped at the bound and never reached the free one
        expect(out.archiveHeld).toBe(RETENTION_WORKSPACE_PAGES_PER_CLASS * pageSize);
        expect(await archivedFor(free)).toBe(0);
      } finally { await blocked.release(); }
      const after = await run({ env: {}, load: loadOf(policyOf(LOGS, false)), target, key: KEY });
      expect(after.archiveFailed).toBe(0);
      expect(await archivedFor(free)).toBe(1);
    });
  });

  it("a hold on another data class does not stop archiving or protect log lines", async () => {
    const ws = newWorkspace();
    const [a] = await archived(ws, [150]);
    await createHold(db, { workspaceId: ws, dataClass: "drift_reports", reason: "drift only", actor: "op" });
    const [b] = await archived(ws, [150]);
    expect((await listArchives(db, { workspaceId: ws })).filter((x) => x.dataClass === "runner_job_logs")).toHaveLength(2);
    await prune();
    expect(await logCount(ws, b.jobId)).toBe(0);
    expect(await logCount(ws, a.jobId)).toBe(0);
  });

  it("holds are validated, only ever released, never edited or deleted", async () => {
    const ws = newWorkspace();
    await expect(createHold(db, { workspaceId: ws, reason: "", actor: "op" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(createHold(db, { workspaceId: ws, reason: "x", actor: "op", dataClass: "operations" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(createHold(db, { workspaceId: ws, reason: "x", actor: "op", timeFrom: "2026-02-01T00:00:00Z", timeTo: "2026-01-01T00:00:00Z" })).rejects.toMatchObject({ code: "invalid_input" });
    const hold = await createHold(db, { workspaceId: ws, reason: "x", actor: "op" });
    await expect(db.query("delete from platform.legal_holds where id = $1", [hold.id])).rejects.toThrow();
    await expect(db.query("update platform.legal_holds set reason = 'edited' where id = $1", [hold.id])).rejects.toThrow();
    await expect(releaseHold(db, { id: hold.id, workspaceId: "ws_other", actor: "op" })).rejects.toMatchObject({ code: "not_found" });
    const released = await releaseHold(db, { id: hold.id, workspaceId: ws, actor: "op2" });
    expect(released.releasedBy).toBe("op2");
    await expect(releaseHold(db, { id: hold.id, actor: "op" })).rejects.toMatchObject({ code: "not_found" });
    await expect(db.query("update platform.legal_holds set released_at = null, released_by = null where id = $1", [hold.id])).rejects.toThrow();
    expect((await listHolds(db, { workspaceId: ws, activeOnly: true })).map((h) => h.id)).not.toContain(hold.id);
    expect((await listHolds(db, { workspaceId: ws })).map((h) => h.id)).toContain(hold.id);
  });

  it("archive records cannot be deleted or rewritten", async () => {
    const ws = newWorkspace();
    await archived(ws, [100]);
    const [a] = await listArchives(db, { workspaceId: ws });
    await expect(db.query("delete from platform.retention_archives where id = $1", [a.id])).rejects.toThrow();
    await expect(db.query("update platform.retention_archives set rows_digest = $2 where id = $1", [a.id, "e".repeat(64)])).rejects.toThrow();
  });
});

describe("dry-run preview", () => {
  it("counts what would be archived and pruned per class, changes nothing, and shows protected tables", async () => {
    const ws = newWorkspace();
    const { id: runnerId } = await runner(ws);
    await jobWithLogs(ws, runnerId, 150, 3);
    await jobWithLogs(ws, runnerId, 45, 2);
    await jobWithLogs(ws, runnerId, 5, 4);
    await jobWithLogs(ws, runnerId, 150, 1, false);
    const before = await logCount(ws);
    const retainAll = await previewRetention(db, RETAIN_ALL);
    const none = retainAll.classes.find((c) => c.class === "runner_job_logs")!.workspaces.find((w) => w.workspaceId === ws)!;
    expect(none).toMatchObject({ totalRows: before, archiveEligible: 0, pruneEligible: 0, pruneWaitingForArchive: 0 });

    const prev = await previewRetention(db, policyOf(LOGS, false));
    expect(prev.dryRun).toBe(true);
    const row = prev.classes.find((c) => c.class === "runner_job_logs")!.workspaces.find((w) => w.workspaceId === ws)!;
    expect(row).toMatchObject({ archiveAfterDays: 30, pruneAfterDays: 90, totalRows: before, archiveEligible: 5, pruneEligible: 0, pruneWaitingForArchive: 3, heldRows: 0 });
    expect(prev.classes.map((c) => c.class)).toEqual([...RETENTION_CLASSES]);
    expect(prev.neverPrunable.map((p) => p.table)).toContain("platform.agent_effect_receipts");
    expect(await logCount(ws)).toBe(before);

    await createHold(db, { workspaceId: ws, reason: "preview", actor: "op" });
    const held = await previewRetention(db, policyOf(LOGS, false));
    const heldRow = held.classes.find((c) => c.class === "runner_job_logs")!.workspaces.find((w) => w.workspaceId === ws)!;
    expect(heldRow.pruneWaitingForArchive).toBe(0);
    expect(heldRow.heldRows).toBe(5);
  });

  it("reports archived rows as ready to prune once the archive covers them", async () => {
    const ws = newWorkspace();
    const { id: runnerId } = await runner(ws);
    await jobWithLogs(ws, runnerId, 150, 2);
    await run({ env: {}, load: loadOf(policyOf(LOGS, false)), target, key: KEY });
    const prev = await previewRetention(db, policyOf(LOGS, false));
    const row = prev.classes.find((c) => c.class === "runner_job_logs")!.workspaces.find((w) => w.workspaceId === ws)!;
    expect(row).toMatchObject({ pruneEligible: 2, pruneWaitingForArchive: 0, archiveEligible: 0 });
    expect(prev.classes.find((c) => c.class === "runner_job_logs")!.samplePrune.some((s) => s.workspaceId === ws)).toBe(true);
    expect(prev.classes.find((c) => c.class === "runner_job_logs")!.archivedRows).toBeGreaterThanOrEqual(2);
  });
});

/* ------------------------------ archive expiry (DEC-RETENTION, 2026-10-14) ------------------------------ */

/**
 * The archive expiry suites below also run against a real PostgreSQL when ZENITH_TEST_RETENTION_PG=1 and an owned,
 * disposable, already migrated ZENITH_TEST_PLATFORM_PG_URL are set: they swap `db` for that database for their own
 * duration. The older suites in this file are PGlite-only and are left untouched.
 */
function useNativePostgresForExpiry(): void {
  let pgdb: PlatformDbHandle | undefined;
  let pglite: PlatformDbHandle | undefined;
  beforeAll(async () => {
    if (process.env.ZENITH_TEST_RETENTION_PG !== "1") return;
    const url = process.env.ZENITH_TEST_PLATFORM_PG_URL;
    if (!url) throw new Error("ZENITH_TEST_RETENTION_PG=1 needs an owned disposable ZENITH_TEST_PLATFORM_PG_URL.");
    pglite = db;
    pgdb = db = await openPlatformDb({ kind: "postgres", url, max: 2 });
  }, 60_000);
  afterAll(async () => {
    if (!pgdb) return;
    db = pglite!;
    await pgdb.close();
    pgdb = undefined;
  });
}

describe("archive expiry policy", () => {
  const EXPIRY_LOGS = { runner_job_logs: { archiveAfterDays: 30, pruneAfterDays: 90, archiveExpireAfterDays: 365 } } as const;

  it("ships 365 days for both log classes in the approved baseline and keeps resolveWindow unchanged", () => {
    expect(APPROVED_ARCHIVE_EXPIRY_DAYS).toBe(365);
    for (const cls of ["runner_job_logs", "machine_request_logs"] as const) {
      expect(DEFAULT_RETENTION_POLICY.classes[cls]).toEqual({ archiveAfterDays: 30, pruneAfterDays: 30, archiveExpireAfterDays: 365 });
      expect(resolveArchiveExpiry(DEFAULT_RETENTION_POLICY, "ws", cls)).toBe(365);
    }
    for (const cls of ["resource_observations", "drift_reports"] as const) expect(resolveArchiveExpiry(DEFAULT_RETENTION_POLICY, "ws", cls)).toBeNull();
    expect(DEFAULT_RETENTION_POLICY.approval?.note).toMatch(/365 days after their newest row/);
  });

  it("validates the field: whole days 1..36500, not earlier than the prune window, null retains forever", () => {
    expect(parseRetentionPolicy({ version: 1, classes: EXPIRY_LOGS }).classes.runner_job_logs).toEqual(EXPIRY_LOGS.runner_job_logs);
    // equal to the prune window is allowed, earlier is refused
    expect(() => parseRetentionPolicy({ version: 1, classes: { runner_job_logs: { archiveAfterDays: 30, pruneAfterDays: 90, archiveExpireAfterDays: 90 } } })).not.toThrow();
    expect(() => parseRetentionPolicy({ version: 1, classes: { runner_job_logs: { archiveAfterDays: 30, pruneAfterDays: 90, archiveExpireAfterDays: 89 } } })).toThrow(/not be earlier than pruneAfterDays/);
    for (const days of [0, -1, 1.5, "365", 40_000]) expect(() => parseRetentionPolicy({ version: 1, classes: { runner_job_logs: { archiveAfterDays: 30, archiveExpireAfterDays: days } } })).toThrow(RetentionPolicyError);
    expect(parseRetentionPolicy({ version: 1, classes: { runner_job_logs: { archiveAfterDays: 30, archiveExpireAfterDays: null } } }).classes.runner_job_logs?.archiveExpireAfterDays).toBeNull();
    // a workspace override is checked against the merged prune window
    expect(() => parseRetentionPolicy({ version: 1, classes: EXPIRY_LOGS, workspaces: { ws_a: { runner_job_logs: { archiveExpireAfterDays: 60 } } } })).toThrow(/archiveExpireAfterDays must not be earlier/);
    const p = parseRetentionPolicy({ version: 1, classes: EXPIRY_LOGS, workspaces: { ws_a: { runner_job_logs: { archiveExpireAfterDays: 120 } }, ws_b: { runner_job_logs: { archiveExpireAfterDays: null } } } });
    expect(resolveArchiveExpiry(p, "ws_x", "runner_job_logs")).toBe(365);
    expect(resolveArchiveExpiry(p, "ws_a", "runner_job_logs")).toBe(120);
    expect(resolveArchiveExpiry(p, "ws_b", "runner_job_logs")).toBeNull();
  });

  it("refuses an expiry window on audit-evidence classes at class and workspace level", () => {
    for (const cls of ["resource_observations", "drift_reports"]) {
      expect(() => parseRetentionPolicy({ version: 1, classes: { [cls]: { archiveAfterDays: 30, pruneAfterDays: 365, archiveExpireAfterDays: 400 } } })).toThrow(/audit evidence/);
      expect(() => parseRetentionPolicy({ version: 1, workspaces: { ws_a: { [cls]: { archiveExpireAfterDays: 400 } } } })).toThrow(/audit evidence/);
      // null is the same as absent: nothing to refuse
      expect(() => parseRetentionPolicy({ version: 1, classes: { [cls]: { archiveAfterDays: 30, archiveExpireAfterDays: null } } })).not.toThrow();
    }
  });

  it("tenant buckets are customer-controlled unless the workspace opts in with a valid value", () => {
    const p = parseRetentionPolicy({ version: 1, classes: EXPIRY_LOGS, workspaces: { ws_in: { tenantArchiveExpiry: "policy" }, ws_out: { tenantArchiveExpiry: "customer_controlled" }, ws_plain: { runner_job_logs: { archiveExpireAfterDays: 200 } } } });
    expect(tenantArchiveExpiryOptIn(p, "ws_in")).toBe(true);
    expect(tenantArchiveExpiryOptIn(p, "ws_out")).toBe(false);
    expect(tenantArchiveExpiryOptIn(p, "ws_plain")).toBe(false);
    expect(tenantArchiveExpiryOptIn(p, "unknown")).toBe(false);
    for (const bad of ["always", true, 1, null]) expect(() => parseRetentionPolicy({ version: 1, workspaces: { ws: { tenantArchiveExpiry: bad } } })).toThrow(/customer_controlled/);
    // the reserved key never makes a data class, and a normal class name is still validated
    expect(() => parseRetentionPolicy({ version: 1, workspaces: { ws: { nonsense: { archiveAfterDays: 1 } } } })).toThrow(/not a retention class/);
    expect(parseRetentionPolicy(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });
});

describe("object store deletes (filesystem and S3)", () => {
  it("filesystem delete is idempotent, removes only the named file, and refuses links and escapes", async (ctx) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-delete-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-delete-outside-"));
    try {
      const t = new FilesystemTarget(root);
      await t.put("retention/ws/a.zra", Buffer.from("a"));
      await t.put("retention/ws/b.zra", Buffer.from("b"));
      await t.delete("retention/ws/a.zra");
      expect(await t.get("retention/ws/a.zra")).toBeNull();
      expect((await t.get("retention/ws/b.zra"))!.toString()).toBe("b");
      await t.delete("retention/ws/a.zra");
      await t.delete("never/existed.zra");
      await expect(t.delete("../escape.zra")).rejects.toThrow(/usable backup target key/);
      await expect(t.delete("/etc/passwd")).rejects.toThrow();
      // a key naming a directory is refused, not removed
      await expect(t.delete("retention/ws")).rejects.toThrow(/not a regular file/);
      expect(await t.get("retention/ws/b.zra")).not.toBeNull();
      // symlinks (when the platform lets this test create them): the link target outside the root is never touched
      fs.writeFileSync(path.join(outside, "victim.txt"), "keep");
      try {
        fs.symlinkSync(path.join(outside, "victim.txt"), path.join(root, "retention", "ws", "link.zra"));
        fs.symlinkSync(outside, path.join(root, "retention", "linked-dir"), "junction");
      } catch { ctx.skip(); }
      await expect(t.delete("retention/ws/link.zra")).rejects.toThrow(/not a regular file/);
      await expect(t.delete("retention/linked-dir/victim.txt")).rejects.toThrow(/outside the target/);
      expect(fs.readFileSync(path.join(outside, "victim.txt"), "utf8")).toBe("keep");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("S3 delete sends DeleteObject for the key and treats a missing key as success", async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    let missing = false;
    const client = { async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      sent.push({ name: command.constructor.name, input: command.input });
      if (missing) throw Object.assign(new Error("gone"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
      return {};
    } };
    const t = new S3Target({ bucket: "ops-archives", client });
    await t.delete("retention/ws/a.zra");
    missing = true;
    await t.delete("retention/ws/a.zra");
    expect(sent.map((s) => s.name)).toEqual(["DeleteObjectCommand", "DeleteObjectCommand"]);
    expect(sent[0].input).toEqual({ Bucket: "ops-archives", Key: "retention/ws/a.zra" });
    await expect(t.delete("../x")).rejects.toThrow();
    const denied = new S3Target({ bucket: "b", client: { send: async () => { throw Object.assign(new Error("denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }); } } });
    await expect(denied.delete("retention/a.zra")).rejects.toThrow(/denied/);
  });
});

describe("archive expiry", () => {
  useNativePostgresForExpiry();
  const EXP = { runner_job_logs: { archiveAfterDays: 30, pruneAfterDays: 90, archiveExpireAfterDays: 365 } } as const;
  const NO_EXP = LOGS;
  const expiry = (env: Record<string, string>, extra: Partial<RetentionOptions> = {}, policy: RetentionPolicy = policyOf(EXP)) =>
    run({ env, load: loadOf(policy), target, key: KEY, recheckMs: 0, maxExpiries: 100, ...extra });
  const recordOf = async (ws: string) => (await listArchives(db, { workspaceId: ws })).find((a) => a.dataClass === "runner_job_logs")!;

  /** Logs older than the expiry window, archived and fully pruned from the source with the expiry-free policy. */
  async function pruned(age = 450, lines = 2) {
    const ws = newWorkspace();
    const { id: runnerId } = await runner(ws);
    const job = await jobWithLogs(ws, runnerId, age, lines);
    for (let i = 0; i < 2; i++) await run({ env: APPLY_ENV, load: loadOf(policyOf(NO_EXP)), target, key: KEY, recheckMs: 0 });
    expect(await logCount(ws)).toBe(0);
    const archive = await recordOf(ws);
    expect(archive).toMatchObject({ prunedRows: lines, expiredAt: null });
    expect(archive.completedAt).not.toBeNull();
    expect(await target.get(archive.objectKey)).not.toBeNull();
    return { ws, job, archive };
  }

  it("a dry run reports what is due and deletes nothing", async () => {
    const { archive } = await pruned();
    const res = await expiry({});
    expect(res.applied).toBe(false);
    expect(res.archivesExpired).toBe(0);
    expect(res.archiveExpiryDue).toBeGreaterThanOrEqual(1);
    expect(res.archiveExpiryWouldExpire).toBeGreaterThanOrEqual(1);
    expect(await target.get(archive.objectKey)).not.toBeNull();
    expect(await recordOf(archive.workspaceId)).toMatchObject({ expiredAt: null, expiredBy: null, expiryOutcome: null });
    // an unapproved operator policy is also a dry run even with the switch on
    const unapproved = await expiry(APPLY_ENV, {}, policyOf(EXP, false));
    expect(unapproved.applied).toBe(false);
    expect(unapproved.archivesExpired).toBe(0);
    expect(await target.get(archive.objectKey)).not.toBeNull();
  });

  it("deletes the object, keeps the record with who and when, leaves the source alone, and is idempotent", async () => {
    const { ws, archive } = await pruned();
    const before = await protectedCounts();
    const res = await expiry(APPLY_ENV);
    expect(res.applied).toBe(true);
    expect(res.archivesExpired).toBeGreaterThanOrEqual(1);
    expect(await target.get(archive.objectKey)).toBeNull();
    const after = await recordOf(ws);
    expect(after).toMatchObject({ id: archive.id, rowCount: archive.rowCount, prunedRows: archive.prunedRows, rowsDigest: archive.rowsDigest, expiredBy: "system:data-retention", expiryOutcome: "deleted" });
    expect(after.expiredAt).not.toBeNull();
    expect(await logCount(ws)).toBe(0);
    expect(await protectedCounts()).toEqual(before);
    // running again changes nothing for this archive
    const again = await expiry(APPLY_ENV);
    expect(again.archiveExpiryFailed).toBe(0);
    expect(await recordOf(ws)).toEqual(after);
  });

  it("does not expire an archive newer than the window, nor without a window for the class", async () => {
    const { ws, archive } = await pruned(200);
    await expiry(APPLY_ENV);
    expect(await target.get(archive.objectKey)).not.toBeNull();
    expect(await recordOf(ws)).toMatchObject({ expiredAt: null });
    const old = await pruned(450);
    await expiry(APPLY_ENV, {}, policyOf(NO_EXP));
    expect(await target.get(old.archive.objectKey)).not.toBeNull();
    // a per-workspace null override retains the archive even though the class window has passed
    await expiry(APPLY_ENV, {}, policyOf(EXP, true, { [old.ws]: { runner_job_logs: { archiveExpireAfterDays: null } } }));
    expect(await target.get(old.archive.objectKey)).not.toBeNull();
    expect(await recordOf(old.ws)).toMatchObject({ expiredAt: null });
  });

  it("an object that is already gone is recorded as missing (idempotent)", async () => {
    const { ws, archive } = await pruned();
    await target.delete(archive.objectKey);
    const res = await expiry(APPLY_ENV);
    expect(res.archiveExpiryFailed).toBe(0);
    expect(await recordOf(ws)).toMatchObject({ expiryOutcome: "missing", expiredBy: "system:data-retention" });
  });

  it("an archive whose rows are not all pruned is never expired, and is counted", async () => {
    const ws = newWorkspace();
    const { id: runnerId } = await runner(ws);
    await jobWithLogs(ws, runnerId, 450, 2);
    // archive-only policy: rows stay in the source, so the archive is still the backup of live rows
    const archiveOnly = policyOf({ runner_job_logs: { archiveAfterDays: 30, archiveExpireAfterDays: 365 } });
    const res = await expiry(APPLY_ENV, {}, archiveOnly);
    const archive = await recordOf(ws);
    expect(archive).toMatchObject({ prunedRows: 0, expiredAt: null });
    expect(res.archiveExpiryBlockedUnpruned).toBeGreaterThanOrEqual(1);
    expect(await target.get(archive.objectKey)).not.toBeNull();
    expect(await logCount(ws)).toBe(2);
    // the database refuses it too, whatever the job does
    await expect(db.query("update platform.retention_archives set expired_at = clock_timestamp(), expired_by = 'x', expiry_outcome = 'deleted' where id = $1", [archive.id])).rejects.toThrow(/every archived row/);
  });

  it("a legal hold overlapping the archive keeps it; release lets it expire; non-overlapping holds do not block", async () => {
    const a = await pruned();
    const b = await pruned();
    const c = await pruned();
    const d = await pruned();
    const holdA = await createHold(db, { workspaceId: a.ws, reason: "case a", actor: "op" });
    const holdB = await createHold(db, { workspaceId: b.ws, dataClass: "runner_job_logs", resourceRef: b.job.jobId, reason: "case b", actor: "op" });
    // c: a hold on another class, another job and a future time range overlaps nothing
    await createHold(db, { workspaceId: c.ws, dataClass: "machine_request_logs", reason: "other class", actor: "op" });
    await createHold(db, { workspaceId: c.ws, resourceRef: "job_unrelated", reason: "other job", actor: "op" });
    await createHold(db, { workspaceId: c.ws, timeFrom: new Date(Date.now() + 86_400_000).toISOString(), reason: "future", actor: "op" });
    // d: a hold on the job's OPERATION also overlaps
    const holdD = await createHold(db, { workspaceId: d.ws, resourceRef: d.job.operationId, reason: "case d", actor: "op" });
    const res = await expiry(APPLY_ENV);
    expect(res.archiveExpiryHeld).toBeGreaterThanOrEqual(3);
    for (const x of [a, b, d]) { expect(await recordOf(x.ws)).toMatchObject({ expiredAt: null }); expect(await target.get(x.archive.objectKey)).not.toBeNull(); }
    expect(await recordOf(c.ws)).toMatchObject({ expiryOutcome: "deleted" });
    expect(await target.get(c.archive.objectKey)).toBeNull();
    for (const [h, x] of [[holdA, a], [holdB, b], [holdD, d]] as const) await releaseHold(db, { id: h.id, workspaceId: x.ws, actor: "op", reason: "resolved" });
    await expiry(APPLY_ENV);
    for (const x of [a, b, d]) { expect(await recordOf(x.ws)).toMatchObject({ expiryOutcome: "deleted" }); expect(await target.get(x.archive.objectKey)).toBeNull(); }
  });

  it("audit-evidence archives are never expired", async () => {
    const ws = newWorkspace();
    const rec = await recordArchive(db, { workspaceId: ws, dataClass: "drift_reports", objectKey: `retention/${ws}/drift_reports/x.zra`, rowsDigest: "a".repeat(64), rowCount: 1, firstRowId: "d1", lastRowId: "d1", lastRecordedAt: new Date(Date.now() - 900 * 86_400_000).toISOString(), keyId: "k", policyDigest: "b".repeat(64) });
    await markPruned(db, rec.id, ws, 1, 0, 0);
    await target.put(rec.objectKey, Buffer.from("evidence"));
    await expiry(APPLY_ENV);
    expect((await listArchives(db, { workspaceId: ws }))[0]).toMatchObject({ completedAt: expect.any(String), expiredAt: null });
    expect(await target.get(rec.objectKey)).not.toBeNull();
  });

  it("an archive sealed under another key is kept and reported, never deleted blind", async () => {
    const { ws, archive } = await pruned();
    const res = await run({ env: APPLY_ENV, load: loadOf(policyOf(EXP)), target, key: randomBytes(32), recheckMs: 0, maxExpiries: 100 });
    expect(res.archiveExpiryFailed).toBeGreaterThanOrEqual(1);
    expect(await target.get(archive.objectKey)).not.toBeNull();
    expect(await recordOf(ws)).toMatchObject({ expiredAt: null });
  });

  it("an object delete that fails records nothing and the next run succeeds", async () => {
    const { ws, archive } = await pruned();
    const failing: ArchiveTarget = { label: "flaky", put: (k, b) => target.put(k, b), get: (k) => target.get(k), delete: async () => { throw new Error("storage down"); } };
    const res = await run({ env: APPLY_ENV, load: loadOf(policyOf(EXP)), target: failing, key: KEY, recheckMs: 0, maxExpiries: 100 });
    expect(res.archiveExpiryFailed).toBeGreaterThanOrEqual(1);
    expect(await recordOf(ws)).toMatchObject({ expiredAt: null });
    expect(await target.get(archive.objectKey)).not.toBeNull();
    await expiry(APPLY_ENV);
    expect(await recordOf(ws)).toMatchObject({ expiryOutcome: "deleted" });
  });
});

describe("archive record trigger (expiry columns)", () => {
  useNativePostgresForExpiry();
  const recordRow = (ws: string, tag: string) => recordArchive(db, { workspaceId: ws, dataClass: "runner_job_logs", objectKey: `retention/${ws}/runner_job_logs/${tag}.zra`, rowsDigest: "c".repeat(64), rowCount: 3, firstRowId: "1", lastRowId: "3", lastRecordedAt: "2025-01-01T00:00:00Z", keyId: "k", policyDigest: "d".repeat(64) });
  async function fullyPrunedRecord() {
    const ws = newWorkspace();
    const rec = await recordRow(ws, "a");
    await markPruned(db, rec.id, ws, rec.rowCount, 0, 0);
    return { ws, id: rec.id };
  }
  const expire = (id: string, set = "expired_at = clock_timestamp(), expired_by = 'system:data-retention', expiry_outcome = 'deleted'") =>
    db.query(`update platform.retention_archives set ${set} where id = $1`, [id]);

  it("allows setting the expiry columns exactly once, after the archive is fully pruned", async () => {
    const { id } = await fullyPrunedRecord();
    await expire(id);
    const row = (await db.query<{ expired_at: unknown; expired_by: string; expiry_outcome: string }>("select expired_at, expired_by, expiry_outcome from platform.retention_archives where id = $1", [id]))[0];
    expect(row).toMatchObject({ expired_by: "system:data-retention", expiry_outcome: "deleted" });
    expect(row.expired_at).toBeTruthy();
    // never twice, never changed, never cleared
    await expect(expire(id)).rejects.toThrow(/recorded once/);
    await expect(expire(id, "expiry_outcome = 'missing'")).rejects.toThrow(/recorded once/);
    await expect(expire(id, "expired_at = null, expired_by = null, expiry_outcome = null")).rejects.toThrow(/recorded once/);
    await expect(expire(id, "expired_by = 'someone'")).rejects.toThrow(/recorded once/);
  });

  it("refuses a partial or invalid expiry, an expiry before the archive is fully pruned, and any other change", async () => {
    const ws = newWorkspace();
    const open = await recordRow(ws, "open");
    await expect(expire(open.id)).rejects.toThrow(/every archived row/);
    await markPruned(db, open.id, ws, 1, 2, 0);
    await expect(expire(open.id)).rejects.toThrow(/every archived row/);
    const { id } = await fullyPrunedRecord();
    await expect(expire(id, "expired_at = clock_timestamp()")).rejects.toThrow(/together/);
    await expect(expire(id, "expired_by = 'x', expiry_outcome = 'deleted'")).rejects.toThrow(/together/);
    await expect(expire(id, "expired_at = clock_timestamp(), expired_by = 'x', expiry_outcome = 'gone'")).rejects.toThrow();
    await expect(expire(id, "expired_at = clock_timestamp(), expired_by = '', expiry_outcome = 'deleted'")).rejects.toThrow();
    await expect(expire(id, "expired_at = clock_timestamp(), expired_by = 'x', expiry_outcome = 'deleted', pruned_rows = pruned_rows + 1")).rejects.toThrow(/cannot change anything else/);
    for (const set of ["object_key = 'retention/other.zra'", "rows_digest = '" + "e".repeat(64) + "'", "row_count = 9", "last_recorded_at = now()", "workspace_id = 'ws_other'", "destination_label = 'elsewhere'", "key_id = 'k2'", "verified_at = now()"]) {
      await expect(expire(id, set)).rejects.toThrow(/immutable/);
      await expect(expire(id, `${set}, expired_at = clock_timestamp(), expired_by = 'x', expiry_outcome = 'deleted'`)).rejects.toThrow();
    }
    await expect(expire(id, "pruned_rows = pruned_rows - 1")).rejects.toThrow(/only grows/);
    await expect(expire(id, "completed_at = null")).rejects.toThrow();
    await expect(db.query("delete from platform.retention_archives where id = $1", [id])).rejects.toThrow(/retained/);
    // the record is untouched by all of the refused attempts
    expect((await db.query<{ expired_at: unknown }>("select expired_at from platform.retention_archives where id = $1", [id]))[0].expired_at).toBeNull();
  });
});
