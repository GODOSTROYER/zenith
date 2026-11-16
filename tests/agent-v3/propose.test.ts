/** Proposal tools persist exact intent; deploy also commits its product association. No workflow can start. */
import { describe, expect, it, vi } from "vitest";
import type { ToolName } from "@/lib/agent-access/v3/contract";
import { argsFor, allowDecision, canaries, denyDecision, ids, makeHarness, ORIGIN, requireApproval } from "./support";

const TOOLS: ToolName[] = ["zenith_plan_change", "zenith_prepare_deploy", "zenith_restart_service", "zenith_scale_service"];
describe.each(TOOLS)("%s proposes only", (name) => {
  it.each([[allowDecision, "approved"], [requireApproval, "awaiting_approval"], [denyDecision, "denied"]] as const)("returns the broker decision %s", async (decision, status) => {
    const h = await makeHarness(decision);
    const result = await h.invoke(name, argsFor(name));
    if (name === "zenith_prepare_deploy" && status === "denied") {
      expect(result.error?.code).toBe("policy_denied"); expect(h.deployments.size).toBe(0);
      expect(h.propose).not.toHaveBeenCalled(); return;
    }
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ status, executed: false, replayed: false });
    const op = await h.store.getOperation(ids.ws, result.data.operationId as string);
    expect(result.data.proposalDigest).toBe(op?.proposalDigest);
    if (status === "awaiting_approval") expect(result.data.approval).toMatchObject({ required: true, url: `${ORIGIN}/platform/operations/${op?.id}`, requirement: { count: 1 } });
    expect(h.propose.mock.calls[0][2]).toEqual({ via: "mcp" });
    expect(h.beginExecution).not.toHaveBeenCalled();
    expect(h.ports.workflows.startDeploy).not.toHaveBeenCalled();
    expect(h.ports.workflows.startDayTwo).not.toHaveBeenCalled();
  });
  it("replays an idempotency key and refuses a changed intent", async () => {
    const h = await makeHarness();
    const first = await h.invoke(name, argsFor(name));
    const second = await h.invoke(name, argsFor(name));
    expect(second.data.operationId).toBe(first.data.operationId); expect(second.data.replayed).toBe(true);
    const changes = name === "zenith_scale_service" ? { replicas: 3 } : name === "zenith_plan_change" ? { description: "different intent" } : name === "zenith_prepare_deploy" ? { message: "different intent" } : { reason: "different intent" };
    expect((await h.invoke(name, { ...argsFor(name), ...changes })).error?.code).toBe("idempotency_conflict");
    expect(h.store.allEvents().filter((e) => e.type === "operation.proposed")).toHaveLength(1);
  });
  it("refuses secret-shaped free text before persistence", async () => {
    const h = await makeHarness();
    const key = name === "zenith_plan_change" ? "description" : name === "zenith_prepare_deploy" ? "message" : "reason";
    const result = await h.invoke(name, { ...argsFor(name), [key]: canaries.join(" ") });
    expect(result.error?.code).toBe("secret_material");
    expect(h.store.allEvents()).toEqual([]);
    for (const secret of canaries) expect(JSON.stringify(result)).not.toContain(secret);
  });
});

it("deploy commits its exact product projection before broker proposal and binds before ACK", async () => {
  const h = await makeHarness(), propose = h.propose.getMockImplementation()!;
  h.propose.mockImplementation(async (...args) => {
    expect(h.deployments.size).toBe(1); expect([...h.deployments.values()][0].operationId).toBeUndefined();
    return propose(...args);
  });
  const result = await h.invoke("zenith_prepare_deploy", argsFor("zenith_prepare_deploy"));
  expect(result.ok).toBe(true); expect([...h.deployments.values()][0].operationId).toBe(result.data.operationId);
  expect(h.trace.indexOf("deployment.commit")).toBeLessThan(h.trace.indexOf("deployment.bind"));
  expect(h.beginExecution).not.toHaveBeenCalled();
});
it("lost association ACK recovers the retained proposal and never replaces its deployment", async () => {
  const h = await makeHarness(), bind = h.ports.deployments.bind;
  h.ports.deployments.bind = vi.fn(async (...args: Parameters<typeof bind>) => { await bind(...args); throw new Error("Modeled committed association ACK lost"); });
  expect((await h.invoke("zenith_prepare_deploy", argsFor("zenith_prepare_deploy"))).ok).toBe(false);
  const original = [...h.deployments.values()][0].operationId;
  h.ports.deployments.bind = bind;
  const replay = await h.invoke("zenith_prepare_deploy", argsFor("zenith_prepare_deploy"));
  expect(replay.data.operationId).toBe(original); expect(replay.data.replayed).toBe(true); expect(h.deployments.size).toBe(1);
});
