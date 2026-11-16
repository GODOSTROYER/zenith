/** Selected A–I failure paths against fakes. These are simulated checks only. */
import { describe, expect, it, vi } from "vitest";
import type { ControlPlaneClient } from "../../scripts/acceptance/clients/control-plane";
import { ControlPlaneError } from "../../scripts/acceptance/clients/control-plane";
import { demoF } from "../../scripts/acceptance/scenarios/f-credential-revocation";
import { demoH } from "../../scripts/acceptance/scenarios/h-mcp";
import { demoI } from "../../scripts/acceptance/scenarios/i-managed-provider";
import { runScenario } from "../../scripts/acceptance/runner";
import { executeScenarios } from "../../scripts/acceptance/aws-live";
import { demoE } from "../../scripts/acceptance/scenarios/e-restart-recovery";
import { cleanupBlockPath, readCleanupBlock } from "../../scripts/acceptance/run-state";
import { unlink } from "node:fs/promises";
import { context, definition } from "./_helpers";

describe("simulated live scenario contracts", () => {
  it("F observes baseline, rejection and five further failures; runner remains skipped", async () => {
    const c = await context("simulated"); c.config.apiUrl = "http://localhost"; c.config.apiToken = "fake-token";
    const list = vi.fn().mockResolvedValueOnce({ operations: [] }).mockRejectedValue(new ControlPlaneError(401, "revoked"));
    c.controlPlane = { listOperations: list } as unknown as ControlPlaneClient;
    await runScenario(demoF, c, {}, []);
    expect(list).toHaveBeenCalledTimes(7); expect(c.evidence.summary()).toMatchObject({ verdict: "incomplete", counts: { passedLive: 0, passedSimulated: 3, skipped: 1 } }); expect(c.state.has("completed:F")).toBe(false);
  });
  it("F fails rejection stability when a revoked token starts working again", async () => {
    const c = await context("simulated"); c.config.apiUrl = "http://localhost"; c.config.apiToken = "fake-token";
    const list = vi.fn().mockResolvedValueOnce({ operations: [] }).mockRejectedValueOnce(new ControlPlaneError(403, "revoked")).mockResolvedValue({ operations: [] });
    c.controlPlane = { listOperations: list } as unknown as ControlPlaneClient;
    await runScenario(demoF, c, {}, []); expect(c.evidence.checksFor("F").find((r) => r.id === "stays-rejected")?.status).toBe("failed"); expect(c.evidence.summary().verdict).toBe("failed");
  });
  it("F never counts timeout/500 as credential revocation", async () => {
    const c = await context("simulated"); c.config.apiUrl = "http://localhost"; c.config.apiToken = "fake-token";
    c.controlPlane = { listOperations: vi.fn().mockResolvedValueOnce({ operations: [] }).mockRejectedValue(new ControlPlaneError(500, "server error")) } as unknown as ControlPlaneClient;
    await runScenario(demoF, c, {}, []); expect(c.evidence.summary().verdict).toBe("failed"); expect(c.evidence.checksFor("F").find((r) => r.id === "rejected-after-revoke")?.status).toBe("skipped");
  });
  it("H requires a held approval gate and never invokes execute after unattended allowance", async () => {
    const c = await context("simulated"); c.confirmBillable = true; Object.assign(c.config, { apiUrl: "http://localhost", apiToken: "fake-token", workspaceId: "ws_test", mcpUrl: "http://localhost/mcp", mcpTools: { inspect: "inspect", propose: "propose", status: "status", execute: "execute" } });
    const call = vi.fn(async (name: string) => ({ isError: false, text: "{}", structured: name === "propose" ? { operationId: "op_test" } : {}, credentialPatterns: [] }));
    c.mcp = { describe: () => ({ url: "http://localhost/mcp", tokenSet: false }), initialize: async () => ({ serverName: "fake" }), listTools: async () => ["inspect", "propose", "status", "execute"].map((name) => ({ name })), callTool: call };
    c.controlPlane = { getOperation: async () => ({ operation: { id: "op_test", capability: "infrastructure.plan", status: "running", approvalRequired: false }, approvals: [] }), listOperationEvents: async () => ({ events: [{ type: "operation.started" }] }) } as unknown as ControlPlaneClient;
    await runScenario(demoH, c, {}, []); expect(c.evidence.checksFor("H").find((r) => r.id === "propose-gated")?.status).toBe("failed"); expect(call.mock.calls.map((r) => r[0])).toEqual(["inspect", "propose"]); expect(c.evidence.summary().counts.passedLive).toBe(0);
  });
  it("I stays blocked before any mutation when the Node/managed contract is unsupported", async () => {
    const c = await context("simulated"); c.confirmBillable = true; Object.assign(c.config, { managedApiUrl: "http://localhost", managedConnectionId: "conn_test", apiToken: "fake-token", workspaceId: "ws_test" });
    const action = vi.fn(); c.controlPlane = { runAction: action } as unknown as ControlPlaneClient;
    expect((await runScenario(demoI, c, {}, [])).status).toBe("blocked"); expect(action).not.toHaveBeenCalled(); expect(c.evidence.checksFor("I").every((r) => r.status === "skipped")).toBe(true);
  });
  it("a finalizer cannot restart E's crashed worker while an accepted mutation is unresolved", async () => {
    const c = await context("simulated"); c.confirmBillable = true; const start = vi.fn(async () => ({ done: true, detail: "started" }));
    c.worker = { kind: "manual", describe: () => "fixture", kill: vi.fn(), start };
    const sweep = vi.fn(async () => true);
    const d = definition({ id: "E", runsLocally: false, mutates: true, cleanup: demoE.cleanup, steps: [{ id: "crash", title: "crash", effect: "mutate", plan: () => ["crash"], run: async () => { c.state.set("e.workerDown", true); throw new Error("lost response"); } }] });
    expect(await executeScenarios(c, [d], {}, sweep, { out: () => undefined, err: () => undefined })).toBe(1);
    expect(start).not.toHaveBeenCalled(); expect(sweep).not.toHaveBeenCalled(); expect(c.state.get("e.workerDown")).toBe(true);
    expect(await readCleanupBlock(c.runStateFile, { runId: c.runId })).toMatchObject({ status: "blocked" });
  });
  it("lost tracking on a new external context cannot authorize a cleanup hook", async () => {
    const c = await context("simulated"); const hook = vi.fn(); const sweep = vi.fn(async () => true);
    const d = definition({ runsLocally: false, cleanup: hook });
    await executeScenarios(c, [d], {}, sweep, { out: () => undefined, err: () => undefined });
    await unlink(cleanupBlockPath(c.runStateFile));
    const restarted = await context("simulated");
    restarted.runStateFile = c.runStateFile;
    expect(restarted.state.size).toBe(0);
    expect(await executeScenarios(restarted, [d], {}, sweep, { out: () => undefined, err: () => undefined })).toBe(1);
    expect(hook).not.toHaveBeenCalled(); expect(sweep).not.toHaveBeenCalled();
    expect(await readCleanupBlock(restarted.runStateFile, { runId: restarted.runId })).toMatchObject({ status: "blocked" });
  });
});
