/** Offline contracts only. No test in this file operates a stack. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPERATED_CHECKS, RESTORE_ORDER, restoreDatabaseName, upgradeImages } from "../../scripts/release/drivers/contracts";
import { assertOperatedGate, driverCli, finishOwned, receiptFor, operatedRun, OperatedSession, type DriverInput } from "../../scripts/release/drivers/operated";
import { requireRefusal, removePrivateTree } from "../../scripts/release/drivers/restore";
import { upgradeOrder } from "../../scripts/release/drivers/upgrade";
import { localTargetLane, requiredChecks, validateLocalReceipt } from "../../scripts/release/local-targets";
import { SCENARIOS } from "../../scripts/release/scenarios";
import { manifestFor } from "../../scripts/ci/gate-manifest.mjs";
import type { RestoreReport } from "@/lib/ops/recovery/restore";

const owner = randomBytes(12).toString("hex");
const images = () => Object.fromEntries(["api", "worker", "migration"].map(role => [role, `localhost:5000/zenith-${owner}/${role}@sha256:${randomBytes(32).toString("hex")}`])) as { api: string; worker: string; migration: string };
const input = (scenarioId: "upgrade" | "restore" = "upgrade"): DriverInput => ({ scenarioId, runId: "drv3-test", sourceCommit: randomBytes(20).toString("hex"), receiptFile: path.join(os.tmpdir(), `drv3-${randomBytes(8).toString("hex")}.json`),
  env: { NODE_ENV: "test", ZENITH_LOCAL_TARGETS: "1", ZENITH_LOCAL_OPERATED: "1", ZENITH_LOCAL_JOINED_DRIVERS: "1", ZENITH_ACCEPTANCE_DEFAULT_STACK: "1", ZENITH_DEFAULT_JOURNEY: "1", ZENITH_LOCAL_RUN_ID: "drv3-test", ZENITH_LOCAL_ROOT: path.join(os.tmpdir(), "zenith-j15-drv3-test-unit") } });
const scratch: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const file of scratch.splice(0)) rmSync(file, { recursive: true, force: true }); });

describe("DRV-3 operated planners and receipts", () => {
  it("uses the shipped expand-worker-api ordering and distinct immutable owned candidates", () => {
    const previous = images(), candidate = images();
    const parsed = upgradeImages({ schema: 1, ...candidate }, owner, previous);
    const order = upgradeOrder(parsed);
    expect(order.indexOf("gates")).toBeLessThan(order.indexOf("migrate"));
    expect(order.indexOf("migrate-dry-run")).toBeLessThan(order.indexOf("migrate"));
    expect(order.indexOf("migrate")).toBeLessThan(order.indexOf("worker"));
    expect(order.indexOf("worker-ready")).toBeLessThan(order.indexOf("api"));
    expect(() => upgradeImages({ schema: 1, ...previous }, owner, previous)).toThrow("candidate-must-change");
    for (const value of ["app:latest", candidate.api.replace(owner, randomBytes(12).toString("hex")), candidate.api.replace("localhost:5000", "registry.example")]) {
      expect(() => upgradeImages({ schema: 1, ...candidate, api: value }, owner, previous)).toThrow();
    }
  });
  it("fences the lost timeline before API reopen, and browser continuation before worker restart", () => {
    expect(RESTORE_ORDER.indexOf("stop-writers")).toBeLessThan(RESTORE_ORDER.indexOf("restore-fresh"));
    expect(RESTORE_ORDER.indexOf("epoch-readback")).toBeLessThan(RESTORE_ORDER.indexOf("start-api"));
    expect(RESTORE_ORDER.indexOf("browser-continuation")).toBeLessThan(RESTORE_ORDER.indexOf("start-worker"));
    expect(restoreDatabaseName("drv3-test")).toBe("j15_restore_drv3_test");
    for (const id of ["postgres", "x';drop database postgres;--", "UPPER", "x", "a".repeat(30)]) {
      if (id === "postgres") expect(restoreDatabaseName(id)).not.toBe("postgres");
      else expect(() => restoreDatabaseName(id)).toThrow();
    }
  });
  it.each(["upgrade", "restore"] as const)("registers %s with a strict operated label and closed check inventory", scenarioId => {
    const request = input(scenarioId);
    const checks = OPERATED_CHECKS[scenarioId].map(id => ({ id, status: "passed" as const }));
    const receipt = receiptFor(request, checks);
    expect(receipt.evidenceLabel).toBe("local_operated_rehearsal");
    expect(requiredChecks(scenarioId)).toEqual(OPERATED_CHECKS[scenarioId]);
    expect(() => validateLocalReceipt({ ...receipt, evidenceLabel: "local_rehearsal" }, request)).toThrow();
    expect(() => validateLocalReceipt({ ...receipt, secret: randomBytes(32).toString("hex") }, request)).toThrow();
    expect(() => receiptFor(request, checks.filter(c => c.id !== "cleanup"))).toThrow("Missing required");
    expect(() => receiptFor(request, [...checks, checks[0]])).toThrow("Duplicate");
    expect(() => receiptFor(request, [...checks, { id: "invented-pass", status: "passed" }])).toThrow("Unknown operated");
    expect(() => validateLocalReceipt(receipt, { ...request, runId: "other-run" })).toThrow();
    const scenario = SCENARIOS.find(s => s.id === scenarioId)!;
    expect(localTargetLane(scenario)).toMatchObject({ evidenceLabel: "local_operated_rehearsal" });
    expect(localTargetLane(scenario).gates).toContain("ZENITH_LOCAL_OPERATED=1");
    const manifest = manifestFor(`j15-operated-${scenarioId}`);
    expect(manifest.env.ZENITH_LOCAL_OPERATED).toBe("1");
    expect(manifest.requirements).toHaveLength(1);
    expect(manifest.requirements[0].test).toBe(`operates ${scenarioId} with independent readback and owned cleanup`);
  });
  it("preserves failure/skipped checks instead of manufacturing a passing receipt", () => {
    const request = input();
    const receipt = receiptFor(request, OPERATED_CHECKS.upgrade.map(id => ({ id, status: id === "cleanup" ? "failed" : "skipped" })));
    expect(receipt.checks.some(c => c.status === "failed")).toBe(true);
    expect(receipt.checks.filter(c => c.status === "passed")).toHaveLength(0);
  });
  it("refuses before operation invocation when any gate is missing", async () => {
    for (const key of ["ZENITH_LOCAL_TARGETS", "ZENITH_LOCAL_OPERATED", "ZENITH_LOCAL_JOINED_DRIVERS", "ZENITH_ACCEPTANCE_DEFAULT_STACK", "ZENITH_DEFAULT_JOURNEY"]) {
      const request = input(); delete request.env[key]; expect(() => assertOperatedGate(request)).toThrow();
    }
    const run = vi.fn();
    expect(await driverCli("upgrade", run, [], { NODE_ENV: "test" })).toBe(2); expect(run).not.toHaveBeenCalled();
  });
  it("attempts all cleanup in order despite failures, and never turns absence failure into success", async () => {
    const calls: string[] = [];
    await expect(finishOwned([
      async () => { calls.push("close-browser"); }, async () => { calls.push("stop-writers"); throw new Error("contract fault"); },
      async () => { calls.push("drop-owned-database"); }, async () => { calls.push("delete-owned-kind"); }, async () => { calls.push("j1-absence"); },
    ])).rejects.toThrow("owned-cleanup-failed");
    expect(calls).toEqual(["close-browser", "stop-writers", "drop-owned-database", "delete-owned-kind", "j1-absence"]);
  });
  it("writes failed sanitized evidence and performs owned cleanup after a mid-operation exception", async () => {
    const request = input("restore"); scratch.push(request.receiptFile);
    const clean = vi.fn(async () => {}), fakeSecret = randomBytes(32).toString("base64url");
    vi.spyOn(OperatedSession.prototype, "prepare").mockImplementation(async function (this: OperatedSession) { this.finalizers.push(clean); });
    expect(await operatedRun(request, async session => {
      await session.step("backup-verified", async () => { throw new Error(fakeSecret); });
    })).toBe(1);
    expect(clean).toHaveBeenCalledOnce();
    const text = readFileSync(request.receiptFile, "utf8");
    expect(text).not.toContain(fakeSecret);
    const receipt = JSON.parse(text);
    expect(receipt.checks).toContainEqual({ id: "backup-verified", status: "failed" });
    expect(receipt.checks).toContainEqual({ id: "cleanup", status: "passed" });
    expect(receipt.checks).toContainEqual({ id: "fresh-restore", status: "skipped" });
  });
  it("requires each injected failure to refuse before any restore write", () => {
    const report: Pick<RestoreReport, "ok" | "steps"> = { ok: false, steps: [{ id: "keys", status: "refused", detail: "", at: "" }] };
    expect(() => requireRefusal(report, "keys")).not.toThrow();
    expect(() => requireRefusal(report, "empty")).toThrow();
    expect(() => requireRefusal({ ...report, ok: true }, "keys")).toThrow();
    expect(() => requireRefusal({ ...report, steps: [...report.steps, { id: "restore", status: "ok", detail: "", at: "" }] }, "keys")).toThrow();
  });
  it("bounds private dump cleanup and refuses symlinks", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "drv3-cleanup-")); scratch.push(root);
    const owned = path.join(root, "backup"); mkdirSync(owned); writeFileSync(path.join(owned, "dump"), randomBytes(10));
    expect(() => removePrivateTree(root, root)).toThrow();
    expect(() => removePrivateTree(root, os.tmpdir())).toThrow();
    const foreign = path.join(root, "foreign"); mkdirSync(foreign); writeFileSync(path.join(foreign, "keep"), "contract");
    symlinkSync(foreign, path.join(owned, "link"), process.platform === "win32" ? "junction" : "dir");
    expect(() => removePrivateTree(root, owned)).toThrow("symlink");
    rmSync(path.join(owned, "link")); removePrivateTree(root, owned);
    expect(existsSync(owned)).toBe(false); expect(existsSync(path.join(foreign, "keep"))).toBe(true);
  });
});
