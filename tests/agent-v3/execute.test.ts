/** Real broker claims and single-use approvals, fake durable workflow starts. */
import { describe, expect, it, vi } from "vitest";
import { argsFor, approve, denyDecision, ids, makeHarness, proposeDeploy, requireApproval, target, user } from "./support";

describe("approved execution", () => {
  it("refuses awaiting approval without claiming or starting", async () => {
    const h = await makeHarness(() => requireApproval());
    const p = await proposeDeploy(h);
    expect((await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", p.id, p.digest))).error?.code).toBe("approval_required");
    expect(h.beginExecution).not.toHaveBeenCalled(); expect(h.starts.deploy).toHaveLength(0);
  });
  it("refuses denied and mismatched digests", async () => {
    const h = await makeHarness(denyDecision);
    const p = await proposeDeploy(h);
    expect((await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", p.id, p.digest))).error?.code).toBe("invalid_state");
    expect((await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", p.id))).error?.code).toBe("digest_mismatch");
    expect(h.beginExecution).not.toHaveBeenCalled(); expect(h.starts.deploy).toHaveLength(0);
  });
  it("refuses an expired operation", async () => {
    const h = await makeHarness(); const p = await proposeDeploy(h); h.clock.advance(25 * 3600_000);
    const result = await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", p.id, p.digest));
    expect(result.error?.code).toBe("operation_expired"); expect(h.starts.deploy).toHaveLength(0);
  });
  it("refuses plans, human proposals and another human's integration", async () => {
    const h = await makeHarness();
    const plan = await h.invoke("zenith_plan_change", argsFor("zenith_plan_change"));
    expect((await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", plan.data.operationId as string, plan.data.proposalDigest as string))).error?.code).toBe("not_executable");
    h.world.integrations.set(`${ids.ws}|int-alice`, { subject: "alice", scopes: ["read", "write"], projectIds: [ids.project], environmentIds: [ids.env] });
    for (const principal of [user("alice"), { kind: "integration" as const, id: "int-alice", name: "agent", integrationId: "int-alice", onBehalfOf: "alice" }]) {
      const op = await h.broker.propose({ capability: "deployment.deploy", scope: target, input: { operation: "deploy", revisionId: ids.revision, build: false } }, principal);
      const result = await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", op.operation.id, op.operation.proposalDigest));
      expect(result.error?.code).toBe("not_found");
    }
    expect(h.beginExecution).not.toHaveBeenCalled();
  });
  it("an engine outage leaves approvals unconsumed", async () => {
    const h = await makeHarness(() => requireApproval()); const p = await proposeDeploy(h); await approve(h, p.id, p.digest);
    h.ports.workflows.available = vi.fn(async () => ({ available: false, reason: "Test engine down." }));
    const result = await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", p.id, p.digest));
    expect(result.error?.code).toBe("execution_unavailable"); expect(h.beginExecution).not.toHaveBeenCalled();
    const detail = await h.broker.getOperationDetail({ workspaceId: ids.ws, operationId: p.id, principal: h.principal.principal });
    expect(detail.operation.status).toBe("approved"); expect(detail.approvals[0].consumed).toBe(false);
  });
  it("queued operations are claimed and consume approval before starting", async () => {
    const h = await makeHarness(() => requireApproval()); const p = await proposeDeploy(h); await approve(h, p.id, p.digest);
    const detail = await h.broker.getOperationDetail({ workspaceId: ids.ws, operationId: p.id, principal: h.principal.principal });
    // The facade's queued view is injected; the real store still has the
    // approved record, and verifies/consumes its real approval in the claim.
    detail.operation.status = "queued"; h.getOperationDetail.mockResolvedValue(detail);
    const result = await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", p.id, p.digest));
    expect(result.ok).toBe(true); expect(h.beginExecution).toHaveBeenCalledTimes(1);
    expect((await h.store.listApprovals(ids.ws, p.id))[0].consumedAt).toBeDefined();
    expect(h.trace.indexOf("beginExecution")).toBeLessThan(h.trace.indexOf("startDeploy"));
  });
  it("expired approvals cannot authorize execution", async () => {
    const h = await makeHarness(() => requireApproval()); const p = await proposeDeploy(h); await approve(h, p.id, p.digest); h.clock.advance(61 * 60_000);
    const result = await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", p.id, p.digest));
    expect(result.error?.code).toBe("approval_required"); expect(h.starts.deploy).toHaveLength(0);
    expect((await h.store.listApprovals(ids.ws, p.id))[0].consumedAt).toBeUndefined();
  });
  it("an expired ledger status has the operation_expired code", async () => {
    const h = await makeHarness(); const p = await proposeDeploy(h); h.clock.advance(25 * 3600_000); await h.store.expireOperation({ workspaceId: ids.ws, id: p.id });
    expect((await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", p.id, p.digest))).error?.code).toBe("operation_expired");
    expect(h.beginExecution).not.toHaveBeenCalled();
  });
  it("a malformed deployment proposal does not burn an approval", async () => {
    const h = await makeHarness();
    const op = await h.broker.propose({ capability: "deployment.deploy", scope: target, input: { operation: "deploy" } }, h.principal.principal);
    const result = await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", op.operation.id, op.operation.proposalDigest));
    expect(result.error?.code).toBe("operation_input_invalid"); expect(h.beginExecution).not.toHaveBeenCalled();
  });
  it("claims before starting, consumes once, retries with USE_EXISTING, never returns a grant", async () => {
    const h = await makeHarness(() => requireApproval()); const p = await proposeDeploy(h); await approve(h, p.id, p.digest);
    const args = argsFor("zenith_execute_approved_operation", p.id, p.digest);
    const first = await h.invoke("zenith_execute_approved_operation", args);
    const second = await h.invoke("zenith_execute_approved_operation", args);
    expect(first.ok).toBe(true); expect(second.ok).toBe(true);
    expect(first.data.workflow).toEqual(second.data.workflow);
    expect(first.data.startedNow).toBe(true); expect(second.data.startedNow).toBe(false);
    expect(h.trace.indexOf("beginExecution")).toBeLessThan(h.trace.indexOf("startDeploy"));
    expect(h.beginExecution).toHaveBeenCalledExactlyOnceWith({ workspaceId: ids.ws, operationId: p.id, holder: `mcp:${ids.integration}`, audience: "worker" });
    expect(h.starts.deploy).toHaveLength(1); expect(h.ports.workflows.startDeploy).toHaveBeenCalledTimes(2);
    const claim = await h.beginExecution.mock.results[0].value;
    expect(JSON.stringify([first, second, h.starts.deploy])).not.toContain(claim.grant);
    expect((await h.store.listApprovals(ids.ws, p.id))[0].consumedAt).toBeDefined();
    expect(h.starts.deploy[0]).toMatchObject({ deploymentId: `dep-${p.id}`, preApproved: false, connectionId: "conn-a" });
  });
  it("concurrent execute requests produce one claim and one effective workflow", async () => {
    const h = await makeHarness(); const p = await proposeDeploy(h);
    const results = await Promise.all(Array.from({ length: 4 }, () => h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", p.id, p.digest))));
    expect(results.every((r) => r.ok)).toBe(true); expect(h.starts.deploy).toHaveLength(1);
    expect(h.store.allEvents().filter((e) => e.type === "operation.started")).toHaveLength(1);
  });
  it("a start failure after claim is recoverable with the original arguments", async () => {
    const h = await makeHarness(); const p = await proposeDeploy(h);
    const start = h.ports.workflows.startDeploy;
    h.ports.workflows.startDeploy = vi.fn().mockRejectedValueOnce(new Error("fake transport failure")).mockImplementation(start);
    const args = argsFor("zenith_execute_approved_operation", p.id, p.digest);
    expect((await h.invoke("zenith_execute_approved_operation", args)).error).toMatchObject({ code: "workflow_start_failed", retryable: true });
    expect((await h.store.getOperation(ids.ws, p.id))?.status).toBe("running");
    const retry = await h.invoke("zenith_execute_approved_operation", args);
    expect(retry.ok).toBe(true);
    // This retry actually starts a workflow after the first attempt failed;
    // the note must not claim it started nothing new.
    expect(retry.notes.join(" ")).not.toContain("started nothing new");
    expect(h.beginExecution).toHaveBeenCalledTimes(1); expect(h.starts.deploy).toHaveLength(1);
  });
  it.each(["zenith_restart_service", "zenith_scale_service"] as const)("%s starts day-two work only when executed", async (name) => {
    const h = await makeHarness(); const proposal = await h.invoke(name, argsFor(name));
    expect(h.starts.dayTwo).toHaveLength(0);
    const result = await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", proposal.data.operationId as string, proposal.data.proposalDigest as string));
    expect(result.ok).toBe(true); expect(h.starts.dayTwo).toHaveLength(1); expect(h.starts.deploy).toHaveLength(0);
  });
  it("rechecks changed policy before claiming", async () => {
    const h = await makeHarness(); const p = await proposeDeploy(h); h.setDecision(denyDecision);
    const result = await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", p.id, p.digest));
    expect(result.error?.code).toBe("policy_denied"); expect(h.starts.deploy).toHaveLength(0);
  });
  it.each(["succeeded", "failed", "uncertain"] as const)("a terminal %s retry never starts again", async (status) => {
    const h = await makeHarness(); const p = await proposeDeploy(h);
    await h.broker.beginExecution({ workspaceId: ids.ws, operationId: p.id, holder: "worker", audience: "worker" });
    await h.broker.completeExecution({ workspaceId: ids.ws, operationId: p.id, outcome: status });
    h.beginExecution.mockClear();
    const result = await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", p.id, p.digest));
    expect(result.data).toMatchObject({ status, startedNow: false, workflow: { id: `op-${p.id}` } });
    expect(h.beginExecution).not.toHaveBeenCalled(); expect(h.starts.deploy).toHaveLength(0);
  });
});
