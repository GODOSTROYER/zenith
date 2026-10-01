/** Selected A–I failure paths against fakes. These are simulated checks only. */
import { describe, expect, it, vi } from "vitest";
import type { ControlPlaneClient } from "../../scripts/acceptance/clients/control-plane";
import { ControlPlaneError } from "../../scripts/acceptance/clients/control-plane";
import { demoF } from "../../scripts/acceptance/scenarios/f-credential-revocation";
import { demoH } from "../../scripts/acceptance/scenarios/h-mcp";
import { demoI } from "../../scripts/acceptance/scenarios/i-managed-provider";
import { runScenario } from "../../scripts/acceptance/runner";
import { context } from "./_helpers";

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
});
