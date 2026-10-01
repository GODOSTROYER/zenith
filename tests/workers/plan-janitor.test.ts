/** Real filesystem/PGlite, synthetic plans, injected retention clock. No tofu or cloud I/O. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openPlatformDb, repos } from "@/lib/controlplane/db";
import { sha256Hex } from "@/lib/controlplane/digest";
import { TERMINAL_OPERATION_STATUSES, type Sql } from "@/lib/controlplane/types";
import { PLAN_JANITOR_INTERVAL_MS, planJanitorPass, planMaxAgeFromEnv, startPlanJanitor } from "@/lib/execution/plan-janitor";
import { proposalFor, user } from "../controlplane/_support/harness";

let db: Awaited<ReturnType<typeof openPlatformDb>>;
let temp: string, planDir: string;
const NOW = Date.parse("2026-10-01T12:00:00Z");
const options = () => ({ planDir, maxAgeMs: 3600_000, clock: () => NOW });
beforeEach(async () => { db = await openPlatformDb({ kind: "pglite" }); temp = await mkdtemp(path.join(os.tmpdir(), "zenith-janitor-")); planDir = path.join(temp, "plans"); await mkdir(planDir); });
afterEach(async () => { vi.useRealTimers(); await db.close(); await rm(temp, { recursive: true, force: true }); });
async function file(digest: string, ageHours = 2) {
  const name = path.join(planDir, `${digest}.tfplan`);
  await writeFile(name, "synthetic private plan");
  await utimes(name, new Date(NOW - ageHours * 3600_000), new Date(NOW - ageHours * 3600_000));
  return name;
}
async function owner(digest: string, status: string, workspaceId = "ws-a", evidenceOnly = false) {
  const { operation } = await repos.operations.create(db, { workspaceId, principal: user(), proposal: proposalFor(workspaceId, evidenceOnly ? {} : { planDigest: digest }) });
  await db.query("update platform.operations set status=$3 where workspace_id=$1 and id=$2", [workspaceId, operation.id, status]);
  if (evidenceOnly) await repos.evidence.insert(db, { workspaceId, operationId: operation.id, kind: "tofu_plan", digest, summary: { planDigest: digest }, simulated: true });
  return operation;
}

describe("plan janitor", () => {
  it("deletes old plans for each terminal outcome, at inclusive retention, without changing any rows", async () => {
    for (const [i, status] of TERMINAL_OPERATION_STATUSES.entries()) { const digest = sha256Hex(String(i)); await file(digest, 1); await owner(digest, status); }
    const before = await db.query("select * from platform.operations order by seq");
    expect(await planJanitorPass(db, options())).toMatchObject({ removed: 7, retained: 0, errors: 0 });
    expect(await db.query("select * from platform.operations order by seq")).toEqual(before);
    expect(await planJanitorPass(db, options())).toMatchObject({ removed: 0 });
  });

  it("never deletes a plan belonging to any non-terminal status", async () => {
    for (const [i, status] of ["proposed", "awaiting_approval", "approved", "queued", "running"].entries()) { const digest = sha256Hex(String(i)); await file(digest); await owner(digest, status); }
    expect(await planJanitorPass(db, options())).toMatchObject({ scanned: 5, removed: 0, retained: 5 });
  });

  it("keeps recent/unowned plans, unknown names, directories and outside files", async () => {
    const digest = "a".repeat(64); const recent = await file(digest, 0.99); await owner(digest, "succeeded");
    const unowned = await file("b".repeat(64));
    await writeFile(path.join(planDir, "unrecognized.tfplan"), "keep"); await mkdir(path.join(planDir, `${"c".repeat(64)}.tfplan`));
    const outside = path.join(temp, `${digest}.tfplan`); await writeFile(outside, "outside");
    expect(await planJanitorPass(db, options())).toMatchObject({ removed: 0, retained: 4 });
    expect(await readFile(recent, "utf8")).toBe("synthetic private plan"); expect(await lstat(unowned)).toBeDefined(); expect(await readFile(outside, "utf8")).toBe("outside");
  });

  it("protects shared digests across workspaces and owners found only through re-plan evidence", async () => {
    const shared = "a".repeat(64); await file(shared); await owner(shared, "succeeded"); const active = await owner(shared, "awaiting_approval", "ws-b", true);
    expect(await planJanitorPass(db, options())).toMatchObject({ removed: 0, retained: 1 });
    await db.query("update platform.operations set status='cancelled' where workspace_id=$1 and id=$2", [active.workspaceId, active.id]);
    expect(await planJanitorPass(db, options())).toMatchObject({ removed: 1 });
  });

  it("retains a digest with evidence that cannot be bound to an operation", async () => {
    const digest = "a".repeat(64); await file(digest); await owner(digest, "succeeded");
    await repos.evidence.insert(db, { workspaceId: "ws-other", kind: "tofu_plan", digest, summary: {}, simulated: true });
    expect(await planJanitorPass(db, options())).toMatchObject({ removed: 0, retained: 1 });
  });

  it("refuses a symlink root and never follows nested directory links", async () => {
    const outside = path.join(temp, "outside"); await mkdir(outside);
    const link = path.join(planDir, "nested"); await symlink(outside, link, "junction");
    const digest = "a".repeat(64); const protectedFile = path.join(outside, `${digest}.tfplan`); await writeFile(protectedFile, "outside"); await owner(digest, "succeeded");
    expect(await planJanitorPass(db, options())).toMatchObject({ removed: 0, retained: 1 });
    expect(await readFile(protectedFile, "utf8")).toBe("outside");
    await expect(planJanitorPass(db, { ...options(), planDir: link })).rejects.toThrow("unsafe");
  });

  it("bounds scanning/deletions and reports a missing directory without creating it", async () => {
    for (let i = 0; i < 3; i++) { const digest = sha256Hex(String(i)); await file(digest); await owner(digest, "expired"); }
    expect(await planJanitorPass(db, { ...options(), limit: 2 })).toMatchObject({ scanned: 2, removed: 2 });
    expect(await planJanitorPass(db, options())).toMatchObject({ removed: 1 });
    expect(await planJanitorPass(db, { ...options(), planDir: path.join(temp, "missing") })).toMatchObject({ status: "missing" });
  });

  it("skips overlapping cleanup under its directory lease", async () => {
    const root = await import("node:fs/promises").then((fs) => fs.realpath(planDir));
    const lease = await repos.leases.acquire(db, { scope: `system:plan-janitor:${sha256Hex(root)}`, holder: "other", ttlMs: 60_000 });
    expect(lease).not.toBeNull();
    expect(await planJanitorPass(db, options())).toMatchObject({ status: "busy", scanned: 0 });
  });

  it("does not delete on a failed ownership read, and reports no raw errors or names", async () => {
    const digest = "a".repeat(64); const retained = await file(digest); await owner(digest, "failed");
    const failing: Sql = { tx: db.tx.bind(db), query: async (sql, params) => { if (sql.includes("with owners")) throw new Error("synthetic-secret-canary"); return db.query(sql, params); } };
    const result = await planJanitorPass(failing, options());
    expect(result).toMatchObject({ removed: 0, errors: 1 }); expect(JSON.stringify(result)).not.toContain("synthetic-secret-canary"); expect(JSON.stringify(result)).not.toContain(digest);
    expect(await lstat(retained)).toBeDefined();
  });

  it("rechecks a file refreshed while its ownership is being read", async () => {
    const digest = "a".repeat(64); const refreshed = await file(digest); await owner(digest, "failed");
    let refreshedOnce = false;
    const changing: Sql = { tx: db.tx.bind(db), query: async <T>(sql: string, params?: readonly unknown[]) => { const rows = await db.query<T>(sql, params); if (sql.includes("with owners") && !refreshedOnce) { refreshedOnce = true; await utimes(refreshed, new Date(NOW), new Date(NOW)); } return rows; } };
    expect(await planJanitorPass(changing, options())).toMatchObject({ removed: 0, retained: 1 });
    expect(await lstat(refreshed)).toBeDefined();
  });

  it("retains a plan if a new active owner appears between ownership checks", async () => {
    const digest = "a".repeat(64); const retained = await file(digest); await owner(digest, "succeeded");
    let added = false;
    const changing: Sql = { tx: db.tx.bind(db), query: async <T>(sql: string, params?: readonly unknown[]) => { const rows = await db.query<T>(sql, params); if (sql.includes("with owners") && !added) { added = true; await owner(digest, "running", "ws-new", true); } return rows; } };
    expect(await planJanitorPass(changing, options())).toMatchObject({ removed: 0, retained: 1 });
    expect(await lstat(retained)).toBeDefined();
  });

  it("runs periodically, stays single-flight and awaits the active pass on stop", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
    let acquisitions = 0;
    const paused: Sql = { tx: db.tx.bind(db), query: async (sql, params) => { if (sql.includes("insert into platform.leases")) { acquisitions++; entered.resolve(); await resume.promise; } return db.query(sql, params); } };
    const report = vi.fn(); const janitor = startPlanJanitor(paused, options(), report);
    await entered.promise; await vi.advanceTimersByTimeAsync(PLAN_JANITOR_INTERVAL_MS * 2);
    expect(acquisitions).toBe(1);
    let stopped = false; const stopping = janitor.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false); resume.resolve(); await stopping;
    expect(report).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(PLAN_JANITOR_INTERVAL_MS); expect(acquisitions).toBe(1);
  });

  it("continues bounded scans beyond retained entries so later terminal plans are eventually removed", async () => {
    for (let i = 0; i < 5; i++) { const digest = sha256Hex(String(i)); await file(digest); await owner(digest, i === 4 ? "cancelled" : "running"); }
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const report = vi.fn(); const janitor = startPlanJanitor(db, { ...options(), limit: 2 }, report);
    try {
      await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
      for (let i = 2; i <= 4; i++) { await vi.advanceTimersByTimeAsync(PLAN_JANITOR_INTERVAL_MS); await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(i)); }
      const results = report.mock.calls.map(([result]) => result);
      expect(results.reduce((count, result) => count + result.removed, 0)).toBe(1);
      expect(results.every((result) => result.scanned <= 2)).toBe(true);
      for (let i = 0; i < 4; i++) expect(await lstat(path.join(planDir, `${sha256Hex(String(i))}.tfplan`))).toBeDefined();
    } finally { await janitor.stop(); }
  });

  it("validates retention and batch settings", async () => {
    expect(planMaxAgeFromEnv({})).toBe(24 * 3600_000); expect(planMaxAgeFromEnv({ ZENITH_WORKER_PLAN_MAX_AGE_HOURS: "48" })).toBe(48 * 3600_000);
    for (const hours of ["0", "-1", "no", "Infinity", "8761"]) expect(() => planMaxAgeFromEnv({ ZENITH_WORKER_PLAN_MAX_AGE_HOURS: hours })).toThrow("MAX_AGE_HOURS");
    await expect(planJanitorPass(db, { ...options(), limit: 0 })).rejects.toThrow("limit");
    await expect(planJanitorPass(db, { ...options(), clock: () => NaN })).rejects.toThrow("clock");
  });
});
