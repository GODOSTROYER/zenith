/** MCP dispatch contract with fake worker transport; no cloud or Temporal calls. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeHarness, ids, target, identity } from "../agent-v3/support";
import { principalFromIdentity } from "@/lib/agent-access/v3/principal";
import { runTool } from "@/lib/agent-access/v3/tools";
import { toolDescriptor, catalogFor } from "@/lib/agent-access/v3/catalog";
import { setDestroyReviewDispatcherForTests } from "@/lib/capabilities/destroy-review-dispatch";

afterEach(() => setDestroyReviewDispatcherForTests(undefined));
describe("MCP teardown review", () => {
  it("is listed for plan credentials and dispatches identifiers without a mutation scope", async () => {
    const h = await makeHarness();
    h.world.members.set(`${ids.ws}|bob`, "viewer");
    h.world.integrations.get(`${ids.ws}|${ids.integration}`)!.scopes = ["read", "plan"];
    const principal = principalFromIdentity(identity({ scopes: ["read", "plan"] }));
    const dispatch = vi.fn(async () => undefined); setDestroyReviewDispatcherForTests(dispatch);
    const result = await runTool("zenith_review_teardown", { target, idempotencyKey: "mcp-review-intent" }, { ports: h.ports, principal });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ status: "approved", poll: { tool: "zenith_get_operation" } });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ workspaceId: ids.ws, operationId: result.data.reviewOperationId });
    expect(h.starts.deploy).toHaveLength(0); expect(h.starts.dayTwo).toHaveLength(0);
    expect(toolDescriptor("zenith_review_teardown")).toMatchObject({ capability: "infrastructure.plan", requiredScope: "plan", access: "propose", annotations: { destructiveHint: false, readOnlyHint: false } });
    expect(catalogFor(["plan"]).map((t) => t.name)).toContain("zenith_review_teardown");
    expect(catalogFor(["write"]).map((t) => t.name)).not.toContain("zenith_review_teardown");
  });
  it.each(["approved", "approval", "planDigest", "command"])("strictly refuses injected %s before dispatch", async (field) => {
    const h = await makeHarness(); const dispatch = vi.fn(async () => undefined); setDestroyReviewDispatcherForTests(dispatch);
    const result = await h.invoke("zenith_review_teardown", { target, idempotencyKey: "mcp-review-intent", [field]: "untrusted" });
    expect(result.ok).toBe(false); expect(result.error?.code).toBe("invalid_input"); expect(dispatch).not.toHaveBeenCalled();
  });
  it("refuses a credential without plan scope and foreign targets before product reads", async () => {
    const h = await makeHarness(); const dispatch = vi.fn(async () => undefined); setDestroyReviewDispatcherForTests(dispatch);
    const readOnly = principalFromIdentity(identity({ scopes: ["read"] }));
    expect((await runTool("zenith_review_teardown", { target, idempotencyKey: "mcp-review-intent" }, { ports: h.ports, principal: readOnly })).ok).toBe(false);
    expect((await h.invoke("zenith_review_teardown", { target: { ...target, environmentId: ids.foreignEnv }, idempotencyKey: "mcp-review-intent" })).ok).toBe(false);
    expect(dispatch).not.toHaveBeenCalled(); expect(h.ports.reads.environment).not.toHaveBeenCalled();
  });
});
