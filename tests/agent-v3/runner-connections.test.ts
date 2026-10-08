/** Actual broker/signer and central action drafts; explicit product/policy fakes. */
import { describe, expect, it, vi } from "vitest";
import { runTool } from "@/lib/agent-access/v3/tools";
import { principalFromIdentity } from "@/lib/agent-access/v3/principal";
import { TOOL_CATALOG } from "@/lib/agent-access/v3/catalog";
import { parseConnectionHandoff, RUNNER_ACTIONS } from "@/lib/connections/handoff";
import { RUNNER_CONNECTION_PROVIDERS } from "@/lib/connections/schemas";
import { runnerInput } from "../connections/runner-inputs";
import { makeHarness, argsFor, ids, ORIGIN, identity, denyDecision, canaries } from "./support";

const tool = "zenith_plan_runner_connection";
describe("MCP runner connection review drafts", () => {
  it.each(RUNNER_CONNECTION_PROVIDERS)("proposes %s through the central registry without execution or durable approval", async provider => {
    const h = await makeHarness();
    const input = runnerInput(provider);
    const result = await h.invoke(tool, { ...argsFor(tool), input });
    expect(result).toMatchObject({ ok: true, data: { action: "connection.createRunner", requiredRole: "admin", requiresBrowserConfirmation: true, approved: false, executed: false } });
    const url = new URL(result.data.browserUrl as string);
    expect(url.origin).toBe(ORIGIN); expect(url.pathname).toBe("/platform/connections/confirm"); expect(url.search).toBe("");
    expect(parseConnectionHandoff(url.hash)).toEqual({ version: 1, workspaceId: ids.ws, request: { action: "connection.createRunner", input } });
    expect(result.untrusted_data?.content.request).toEqual({ action: "connection.createRunner", input });
    expect(h.trace[0]).toBe("authorizeRead"); expect(h.authorizeRead).toHaveBeenCalledOnce();
    expect(h.propose).not.toHaveBeenCalled(); expect(h.beginExecution).not.toHaveBeenCalled();
    expect(h.store.allEvents()).toEqual([expect.objectContaining({ type: "policy.evaluated", data: expect.objectContaining({ capability: "connection.plan", kind: "read", outcome: "allow" }) })]);
    expect(h.starts).toEqual({ deploy: [], dayTwo: [] }); expect(h.sessionRequests).toEqual([]);
  });
  it.each(RUNNER_ACTIONS)("%s preserves the action's confirmation role", async action => {
    const h = await makeHarness();
    const input = action === "connection.createRunner" ? runnerInput("oci") : action === "connection.rotate" ? { connectionId: "conn_runner", patch: { runnerId: "run_new" } } : action.includes("Rotation") ? { connectionId: "conn_runner", rotationId: "rot_1" } : { connectionId: "conn_runner" };
    const result = await h.invoke(tool, { ...argsFor(tool), action, input });
    expect(result).toMatchObject({ ok: true, data: { requiredRole: action === "connection.verify" ? "editor" : "admin", requiresBrowserConfirmation: true, approved: false, executed: false } });
    expect(parseConnectionHandoff(new URL(result.data.browserUrl as string).hash).request).toEqual({ action, input });
  });
  it("requires plan scope, current membership and policy before preparing a draft", async () => {
    const h = await makeHarness();
    const readOnly = principalFromIdentity(identity({ scopes: ["read"] }));
    const result = await runTool(tool, argsFor(tool), { ports: h.ports, principal: readOnly });
    expect(result.error?.code).toBe("insufficient_scope"); expect(h.authorizeRead).not.toHaveBeenCalled();
    h.setDecision(denyDecision);
    expect((await h.invoke(tool, argsFor(tool))).error?.code).toBe("policy_denied"); expect(h.trace).toEqual(["authorizeRead"]);
    h.world.members.delete(`${ids.ws}|bob`);
    expect((await h.invoke(tool, argsFor(tool))).ok).toBe(false);
    expect(h.propose).not.toHaveBeenCalled(); expect(h.starts).toEqual({ deploy: [], dayTwo: [] });
  });
  it("refuses foreign targets before reading a tenant and enforces plugin allowlists", async () => {
    const h = await makeHarness(); h.ports.broker = vi.fn(async () => h.broker);
    const a = await h.invoke(tool, { ...argsFor(tool), target: { workspaceId: ids.foreignWs, projectId: ids.foreignProject } });
    const b = await h.invoke(tool, { ...argsFor(tool), target: { workspaceId: "missing", projectId: "missing" } });
    expect(a.error?.code).toBe("not_found"); expect(a).toEqual(b); expect(h.ports.broker).not.toHaveBeenCalled();
    const principal = principalFromIdentity(identity());
    principal.plugin = { registrationId: "reg-a", grantId: "grant-a", pluginId: "reviewer", version: "1", manifestDigest: "a".repeat(64), tools: ["zenith_get_topology"] };
    expect((await runTool(tool, argsFor(tool), { ports: h.ports, principal })).error?.code).toBe("plugin_capability_denied");
    expect(h.authorizeRead).not.toHaveBeenCalled();
  });
  it("rejects model authority and credential material without echoing it", async () => {
    const h = await makeHarness();
    for (const key of ["approved", "approval", "actor", "policy"]) {
      expect((await h.invoke(tool, { ...argsFor(tool), input: { ...runnerInput("aws"), [key]: true } })).error?.code).toBe("invalid_input");
      expect((await h.invoke(tool, { ...argsFor(tool), action: "connection.rotate", input: { connectionId: "conn_runner", patch: { [key]: true } } })).error?.code).toBe("invalid_input");
    }
    for (const secret of canaries) {
      const result = await h.invoke(tool, { ...argsFor(tool), input: { ...runnerInput("oci"), label: secret } });
      expect(result.error?.code).toBe("invalid_input"); expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect((await h.invoke(tool, { ...argsFor(tool), action: "cloud.execute" })).error?.code).toBe("invalid_input");
    expect(h.propose).not.toHaveBeenCalled(); expect(h.beginExecution).not.toHaveBeenCalled();
    expect(TOOL_CATALOG.filter(t => t.requiredScope === "write").some(t => t.capability?.startsWith("connection."))).toBe(false);
  });
});
