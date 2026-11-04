/** Real central registry and file-store role/audit contracts. No cloud or server. */
import { beforeEach, describe, expect, it } from "vitest";
import { tempDataDir } from "../_support/data-dir";
import { runnerInput } from "./runner-inputs";
tempDataDir("zenith-runner-registry-", { fast: true });
process.env.ZENITH_STORE = "file";
const { registerAllActions } = await import("@/lib/actions/defs");
const { actionRegistry, getAction, runAction } = await import("@/lib/actions/core");
const { resetDb, readAudit, db } = await import("@/lib/db/store");
const { mappingFor } = await import("@/lib/capabilities/action-bridge");
const { connectionHandoff, parseConnectionHandoff, ConnectionRequest, connectionMutation, RUNNER_ACTIONS } = await import("@/lib/connections/handoff");
const ctx = { workspaceId: "ws-a", actor: { type: "user" as const, id: "alice", name: "Alice" } };
beforeEach(() => { registerAllActions(); resetDb({ workspaces: [{ id: "ws-a", name: "A", slug: "a", createdAt: new Date().toISOString() }], members: [{ id: "alice", name: "Alice", email: "alice@zenith.test", role: "admin", workspaceId: "ws-a" }] }); });

describe("runner action registration and authority", () => {
  it("registers every lifecycle mutation centrally and maps only the read-only proposal for agents", async () => {
    for (const id of RUNNER_ACTIONS) {
      expect(actionRegistry().get(id)).toMatchObject({ id, mutates: true, requiredRole: id === "connection.verify" ? "editor" : "admin" });
      expect(mappingFor(id)).toBeUndefined();
    }
    expect(getAction("connection.proposeRunner")).toMatchObject({ mutates: false, requiredRole: "viewer" });
    expect(mappingFor("connection.proposeRunner")).toMatchObject({ capability: "connection.plan" });
    expect((await runAction("connection.createRunner", ctx, runnerInput("aws"), { mode: "plan" })).plan).toMatchObject({ requiresApproval: true, requiredRole: "admin" });
  });
  it.each(RUNNER_ACTIONS)("%s refuses Navigator and integration execution even with admin identity", async id => {
    const input = id === "connection.createRunner" ? runnerInput("aws") : id === "connection.rotate" ? { connectionId: "conn_runner", patch: { runnerId: "run_new" } } : id.includes("Rotation") ? { connectionId: "conn_runner", rotationId: "rot_1" } : { connectionId: "conn_runner" };
    for (const caller of [ { ...ctx, actor: { type: "navigator" as const, id: "alice", name: "Agent" }, autonomy: "approve" as const }, { ...ctx, integration: { clientId: "int-a", operationId: "op-draft", proposalDigest: "unapproved" } } ]) {
      const result = await runAction(id, caller, input, { mode: "execute" });
      expect(result.result).toMatchObject({ ok: false, error: expect.stringContaining("agents and the Navigator cannot") });
    }
    expect(db().connections).toEqual([]); expect(readAudit().filter(row => row.actionId === id)).toHaveLength(2);
  });
  it("shares identifier-only drafts without persisting a connection, operation or approval", async () => {
    const request = { action: "connection.createRunner" as const, input: runnerInput("oci") };
    const before = JSON.stringify(db());
    const result = await runAction("connection.proposeRunner", ctx, request, { mode: "execute" });
    expect(result.result).toMatchObject({ ok: true, data: { requiredRole: "admin", requiresBrowserConfirmation: true, approved: false, executed: false } });
    const data = result.result!.data as { browserPath: string };
    expect(parseConnectionHandoff(new URL(data.browserPath, "https://zenith.test").hash)).toEqual({ version: 1, workspaceId: "ws-a", request });
    expect(JSON.stringify(db())).toBe(before); expect(readAudit()).toEqual([]);
  });
  it("lets the Navigator prepare an exact browser review draft in read-only plan mode", async () => {
    const request = { action: "connection.createRunner" as const, input: runnerInput("aws") };
    const before = JSON.stringify(db());
    const out = await runAction("connection.proposeRunner", { ...ctx, actor: { type: "navigator", id: "nav-a", name: "Navigator" }, autonomy: "observe" }, request, { mode: "plan" });
    expect(out.plan).toMatchObject({ requiresApproval: false, requiredRole: "viewer" });
    expect(out.plan!.details).toContain(`Unapproved review draft: ${connectionHandoff(request, "ws-a")}`);
    expect(out.plan!.details).toContain("A signed-in admin reviews the exact identifiers and confirms in the browser.");
    expect(JSON.stringify(db())).toBe(before); expect(readAudit()).toEqual([]);
  });
  it("rejects draft approval overrides, secret values, oversized and invalid fragments", () => {
    const secret = ["AKIA", "A".repeat(16)].join("");
    for (const patch of [{ approved: true }, { actor: "admin" }, { clientSecret: secret }]) expect(ConnectionRequest.safeParse({ action: "connection.rotate", input: { connectionId: "conn_runner", patch } }).success).toBe(false);
    expect(ConnectionRequest.safeParse({ action: "connection.verify", input: { connectionId: "conn_runner", approved: true } }).success).toBe(false);
    expect(ConnectionRequest.safeParse({ action: "connection.abortRotation", input: { connectionId: "conn_runner", rotationId: "rot_1", retirePreviousRunner: true } }).success).toBe(false);
    expect(() => connectionHandoff({ action: "connection.rotate", input: { connectionId: "conn_runner", patch: { label: "a".repeat(17_000) } } })).toThrow("too large");
    for (const fragment of ["#%XX", "#{}", "#" + "a".repeat(50_000)]) expect(() => parseConnectionHandoff(fragment)).toThrow();
  });
  it("routes encoded connection ids and abort bodies exactly", () => {
    expect(connectionMutation({ action: "connection.abortRotation", input: { connectionId: "conn/a", rotationId: "rot_1" } })).toEqual({ path: "/api/platform/v1/connections/conn%2Fa/rotation/abort", body: { rotationId: "rot_1" } });
  });
});
