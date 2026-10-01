/** Proposal tools write the broker ledger only; no workflow can start. */
import { describe, expect, it } from "vitest";
import type { ToolName } from "@/lib/agent-access/v3/contract";
import { argsFor, allowDecision, canaries, denyDecision, ids, makeHarness, ORIGIN, requireApproval } from "./support";

const TOOLS: ToolName[] = ["zenith_plan_change", "zenith_prepare_deploy", "zenith_restart_service", "zenith_scale_service"];
describe.each(TOOLS)("%s proposes only", (name) => {
  it.each([[allowDecision, "approved"], [requireApproval, "awaiting_approval"], [denyDecision, "denied"]] as const)("returns the broker decision %s", async (decision, status) => {
    const h = await makeHarness(decision);
    const result = await h.invoke(name, argsFor(name));
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ status, executed: false, replayed: false });
    const op = await h.store.getOperation(ids.ws, result.data.operationId as string);
    expect(result.data.proposalDigest).toBe(op?.proposalDigest);
    if (status === "awaiting_approval") expect(result.data.approval).toMatchObject({ required: true, url: `${ORIGIN}/integrations/operations/${op?.id}`, requirement: { count: 1 } });
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
