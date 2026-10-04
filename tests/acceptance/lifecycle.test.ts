/** Simulated lifecycle checks ensure an unknown operation cannot be swept. */
import { describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { ControlPlaneClient, OperationViewLike } from "../../scripts/acceptance/clients/control-plane";
import { markRunMutation, settleRunOperations, trackControlPlane, trackOperation } from "../../scripts/acceptance/lifecycle";
import { cleanupBlockPath, readCleanupBlock } from "../../scripts/acceptance/run-state";
import { executeScenarios } from "../../scripts/acceptance/aws-live";
import { context, definition } from "./_helpers";

const op = (status: OperationViewLike["status"]): OperationViewLike => ({ id: "op_test", capability: "deployment.deploy", status, approvalRequired: false });
describe("run lifecycle cleanup safety (simulated)", () => {
  it("tracks this run's proposals but a cancellation acknowledgement never authorizes teardown", async () => {
    const c = await context("simulated");
    const cancel = vi.fn(async () => ({ operation: op("cancelled") }));
    const get = vi.fn().mockResolvedValueOnce({ operation: op("running"), approvals: [] }).mockResolvedValue({ operation: op("cancelled"), approvals: [] });
    const client = { proposeCapability: vi.fn(async () => ({ operation: op("running"), decision: { outcome: "allow", reasons: [] }, replayed: false })), getOperation: get, cancelOperation: cancel } as unknown as ControlPlaneClient;
    c.controlPlane = trackControlPlane(client, c);
    await c.controlPlane.proposeCapability({ capability: "deployment.deploy", scope: { workspaceId: "ws_test", environmentId: "env_test" } });
    expect(await settleRunOperations(c)).toBe(false); expect(cancel).toHaveBeenCalledWith("op_test", expect.stringContaining(c.runId)); expect(get).toHaveBeenCalledTimes(2);
    expect(await readCleanupBlock(c.runStateFile, { runId: c.runId })).toMatchObject({ status: "blocked" });
  });
  it("refuses destructive sweep if cancellation or observation fails", async () => {
    const c = await context("simulated"); trackOperation(c, "op_test");
    c.controlPlane = { getOperation: vi.fn(async () => { throw new Error("cannot observe"); }) } as unknown as ControlPlaneClient;
    const sweep = vi.fn(async () => true); const hook = vi.fn(async () => undefined); const err = vi.fn();
    expect(await executeScenarios(c, [definition({ runsLocally: false, cleanup: hook })], {}, sweep, { out: () => undefined, err })).toBe(1);
    expect(sweep).not.toHaveBeenCalled(); expect(hook).not.toHaveBeenCalled(); expect(err).toHaveBeenCalledWith(expect.stringContaining("CLEANUP INCOMPLETE"));
    expect(c.evidence.summary().verdict).toBe("failed");
  });
  it.each(["uncertain", "cancelled", "failed", "succeeded"] as const)("does not treat %s or a later success as provider quiescence", async (status) => {
    const c = await context("simulated"); trackOperation(c, "op_test");
    const get = vi.fn().mockResolvedValueOnce({ operation: op(status), approvals: [] }).mockResolvedValue({ operation: op("succeeded"), approvals: [] });
    c.controlPlane = { getOperation: get, cancelOperation: vi.fn() } as unknown as ControlPlaneClient;
    c.workflows = { describe: vi.fn(async () => ({ status: "COMPLETED", runId: "run_test", historyLength: 20 })), getProgress: vi.fn(async () => ({ operationId: "op_test", status: "succeeded", steps: [{ step: "release", status: "done" }] })) } as unknown as NonNullable<typeof c.workflows>;
    expect(await settleRunOperations(c)).toBe(false);
    expect(c.controlPlane.cancelOperation).not.toHaveBeenCalled(); expect(get).toHaveBeenCalledTimes(2);
    expect(await settleRunOperations({ ...c, state: new Map() })).toBe(false);
  });
  it("preserves a blocker before a proposal whose response is lost, even without an operation id", async () => {
    const c = await context("simulated"); const secret = randomBytes(24).toString("hex");
    const propose = vi.fn(async () => {
      expect(await readCleanupBlock(c.runStateFile, { runId: c.runId })).toMatchObject({ status: "blocked" });
      throw new Error(secret);
    });
    c.controlPlane = trackControlPlane({ proposeCapability: propose } as unknown as ControlPlaneClient, c);
    await expect(c.controlPlane.proposeCapability({ capability: "deployment.deploy", scope: { workspaceId: "ws_test" } })).rejects.toThrow();
    expect(await settleRunOperations({ ...c, state: new Map() })).toBe(false);
    expect(await readFile(cleanupBlockPath(c.runStateFile), "utf8")).not.toContain(secret);
  });
  it("a lost cancellation acknowledgement and late success do not clear the persisted blocker", async () => {
    const c = await context("simulated"); trackOperation(c, "op_test");
    const get = vi.fn().mockResolvedValueOnce({ operation: op("running"), approvals: [] }).mockResolvedValue({ operation: op("succeeded"), approvals: [] });
    c.controlPlane = { getOperation: get, cancelOperation: vi.fn(async () => { throw new Error("lost acknowledgement"); }) } as unknown as ControlPlaneClient;
    expect(await settleRunOperations(c)).toBe(false);
    expect(await settleRunOperations(c)).toBe(false);
    expect(c.controlPlane.cancelOperation).toHaveBeenCalledOnce();
  });
  it.each(["running", "uncertain"] as const)("fresh reread of %s cannot promote stale succeeded projection", async (fresh) => {
    const c = await context("simulated"); trackOperation(c, "op_test");
    c.controlPlane = { getOperation: vi.fn().mockResolvedValueOnce({ operation: op("succeeded"), approvals: [] }).mockResolvedValue({ operation: op(fresh), approvals: [] }) } as unknown as ControlPlaneClient;
    expect(await settleRunOperations(c)).toBe(false);
  });
  it("fails closed on a reread failure and does not store provider diagnostics", async () => {
    const c = await context("simulated"); trackOperation(c, "op_test"); const secret = randomBytes(24).toString("hex");
    c.controlPlane = { getOperation: vi.fn().mockResolvedValueOnce({ operation: op("succeeded"), approvals: [] }).mockRejectedValue(new Error(secret)) } as unknown as ControlPlaneClient;
    expect(await settleRunOperations(c)).toBe(false); await c.evidence.finalize();
    expect(await readFile(cleanupBlockPath(c.runStateFile), "utf8")).not.toContain(secret);
    expect(await readFile(`${c.evidence.dir}/summary.md`, "utf8")).not.toContain(secret);
  });
  it("an empty inventory never authorizes cleanup, and a direct mutation keeps its blocker", async () => {
    const c = await context("simulated"); expect(await settleRunOperations(c)).toBe(false);
    await markRunMutation(c); expect(await settleRunOperations(c)).toBe(false);
    expect(await settleRunOperations({ ...c, state: new Map() })).toBe(false);
  });
  it("refuses dispatch when a malformed persisted marker cannot be revalidated", async () => {
    const c = await context("simulated"); const secret = randomBytes(24).toString("hex");
    await writeFile(cleanupBlockPath(c.runStateFile), JSON.stringify({ cleared: true, diagnostic: secret }));
    const propose = vi.fn(); const tracked = trackControlPlane({ proposeCapability: propose } as unknown as ControlPlaneClient, c);
    await expect(tracked.proposeCapability({ capability: "deployment.deploy", scope: { workspaceId: "ws_test" } })).rejects.toThrow("authoritative resolution");
    expect(propose).not.toHaveBeenCalled(); expect(await settleRunOperations(c)).toBe(false);
  });
  it("blocks before an execute action with a lost response but leaves action planning read-only", async () => {
    const c = await context("simulated");
    const runAction = vi.fn(async (_id: string, body: { mode: string }) => {
      const marker = await readCleanupBlock(c.runStateFile, { runId: c.runId });
      if (body.mode === "plan") expect(marker).toBeUndefined();
      else { expect(marker).toMatchObject({ status: "blocked" }); throw new Error("response lost"); }
      return { actionId: "project.updateManifest", mode: "plan" as const, allowed: true };
    });
    const client = trackControlPlane({ runAction } as unknown as ControlPlaneClient, c);
    await client.runAction("project.updateManifest", { mode: "plan", scope: { projectId: "p_test" }, input: {} });
    await expect(client.runAction("project.updateManifest", { mode: "execute", scope: { projectId: "p_test" }, input: {} })).rejects.toThrow();
    expect(await settleRunOperations({ ...c, state: new Map() })).toBe(false);
    expect(runAction).toHaveBeenCalledTimes(2);
  });

});
