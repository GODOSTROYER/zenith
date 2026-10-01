/** Simulated lifecycle checks ensure an unknown operation cannot be swept. */
import { describe, expect, it, vi } from "vitest";
import type { ControlPlaneClient, OperationViewLike } from "../../scripts/acceptance/clients/control-plane";
import { settleRunOperations, trackControlPlane, trackOperation } from "../../scripts/acceptance/lifecycle";
import { executeScenarios } from "../../scripts/acceptance/aws-live";
import { context, definition } from "./_helpers";

const op = (status: OperationViewLike["status"]): OperationViewLike => ({ id: "op_test", capability: "deployment.deploy", status, approvalRequired: false });
describe("run lifecycle cleanup safety (simulated)", () => {
  it("tracks only this run's proposals, cancels in-flight work and waits for terminal", async () => {
    const c = await context("simulated");
    const cancel = vi.fn(async () => ({ operation: op("cancelled") }));
    const get = vi.fn().mockResolvedValueOnce({ operation: op("running"), approvals: [] }).mockResolvedValue({ operation: op("cancelled"), approvals: [] });
    const client = { proposeCapability: vi.fn(async () => ({ operation: op("running"), decision: { outcome: "allow", reasons: [] }, replayed: false })), getOperation: get, cancelOperation: cancel } as unknown as ControlPlaneClient;
    c.controlPlane = trackControlPlane(client, c);
    await c.controlPlane.proposeCapability({ capability: "deployment.deploy", scope: { workspaceId: "ws_test", environmentId: "env_test" } });
    expect(await settleRunOperations(c)).toBe(true); expect(cancel).toHaveBeenCalledWith("op_test", expect.stringContaining(c.runId)); expect(get).toHaveBeenCalledTimes(2);
  });
  it("refuses destructive sweep if cancellation or observation fails", async () => {
    const c = await context("simulated"); trackOperation(c, "op_test");
    c.controlPlane = { getOperation: vi.fn(async () => { throw new Error("cannot observe"); }) } as unknown as ControlPlaneClient;
    const sweep = vi.fn(async () => true); const hook = vi.fn(async () => undefined); const err = vi.fn();
    expect(await executeScenarios(c, [definition({ runsLocally: false, cleanup: hook })], {}, sweep, { out: () => undefined, err })).toBe(1);
    expect(sweep).not.toHaveBeenCalled(); expect(hook).not.toHaveBeenCalled(); expect(err).toHaveBeenCalledWith(expect.stringContaining("CLEANUP INCOMPLETE"));
    expect(c.evidence.summary().verdict).toBe("failed");
  });
});
