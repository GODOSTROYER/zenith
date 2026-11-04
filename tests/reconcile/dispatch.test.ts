/** Real broker/store dispatch guards; only the Temporal network acknowledgement is scripted. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDataDir } from "../_support/data-dir";
tempDataDir("zenith-repair-dispatch-", { fast: true });
const dispatch = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/workflows/client", () => ({ startDayTwo: dispatch }));
const { composeReconcilePorts } = await import("@/lib/platform/reconcile");
const { RECONCILER_PRINCIPAL } = await import("@/lib/reconcile");
const { FakeCredentialBroker } = await import("../execution/fakes/broker");
const { allowDecision, approveAs, closeSharedPgliteAfterAll, makeHarness, requestFor, requireApproval, scriptedEngine, sessionFor, user } = await import("../capabilities/support");
closeSharedPgliteAfterAll();
afterEach(() => { dispatch.mockReset(); dispatch.mockResolvedValue(undefined); vi.restoreAllMocks(); });

async function fixture(approval = false) {
  const h = await makeHarness({ kind: "pglite", engine: scriptedEngine("repair-dispatch-fixture-v1", () => approval ? requireApproval(1) : allowDecision()) });
  if (!h.db) throw new Error("The dispatch fixture requires the actual control store.");
  const ports = composeReconcilePorts(h.db, new FakeCredentialBroker(), async () => h.broker);
  const proposed = await h.broker.propose(requestFor(h, "drift.repair", "prod", { input: { action: "reapply_desired_state" } }), RECONCILER_PRINCIPAL, { origin: "reconciler", via: "reconciler" });
  const request = { operationId: proposed.operation.id, workspaceId: h.ids.wsA, projectId: h.ids.projA, environmentId: h.ids.envAProd, correlationId: proposed.operation.id };
  return { h, ports, proposed, request };
}

describe("canonical repair dispatch authority", () => {
  it("claims an allowed operation once and dispatches the existing day-two workflow", async () => {
    const { h, ports, request } = await fixture();
    await ports.startRepair(request);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operationId: request.operationId, capability: "drift.repair" }));
    expect(await h.store.getOperation(request.workspaceId, request.operationId)).toMatchObject({ status: "running" });
    await expect(ports.startRepair(request)).rejects.toThrow("not available for a new dispatch");
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("preserves accepted/lost dispatch as uncertain and never restarts after a cooldown", async () => {
    const { h, ports, request } = await fixture();
    const sensitive = ["dispatch", "private", "value"].join("-");
    dispatch.mockRejectedValueOnce(new Error(sensitive));
    await expect(ports.startRepair(request)).rejects.toThrow("dispatch is unconfirmed");
    expect(await h.store.getOperation(request.workspaceId, request.operationId)).toMatchObject({ status: "uncertain" });
    h.clock.advance(48 * 60 * 60_000);
    await expect(ports.startRepair(request)).rejects.toThrow("not available for a new dispatch");
    expect(dispatch).toHaveBeenCalledOnce();
    expect(JSON.stringify(await h.store.getOperation(request.workspaceId, request.operationId))).not.toContain(sensitive);
  });

  it("an uncertainty storage outage leaves the claimed operation blocking another dispatch", async () => {
    const { h, ports, request } = await fixture();
    dispatch.mockRejectedValueOnce(new Error("lost acknowledgement"));
    vi.spyOn(h.broker, "markUncertain").mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(ports.startRepair(request)).rejects.toThrow("dispatch is unconfirmed");
    expect(await h.store.getOperation(request.workspaceId, request.operationId)).toMatchObject({ status: "running" });
    await expect(ports.startRepair(request)).rejects.toThrow("not available for a new dispatch");
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("rechecks policy before claiming and refuses a changed denial", async () => {
    const { h, ports, request } = await fixture();
    h.setEngine(scriptedEngine("repair-denied-fixture-v2", () => ({ outcome: "deny", reasons: [{ code: "fixture_denied", message: "Denied" }] })));
    await expect(ports.startRepair(request)).rejects.toMatchObject({ code: "policy_denied" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(await h.store.getOperation(request.workspaceId, request.operationId)).toMatchObject({ status: "denied" });
  });

  it("requires the current human approval and rejects its revocation", async () => {
    const { h, ports, proposed, request } = await fixture(true);
    await expect(ports.startRepair(request)).rejects.toThrow("not available for a new dispatch");
    await approveAs(h, proposed.operation, "dave");
    await h.broker.revokeApproval({ workspaceId: request.workspaceId, operationId: request.operationId, actor: user("dave"), session: sessionFor("dave") });
    await expect(ports.startRepair(request)).rejects.toThrow("not available for a new dispatch");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("refuses changed scope and cancellation before any execution claim", async () => {
    const { h, ports, request } = await fixture();
    await expect(ports.startRepair({ ...request, environmentId: h.ids.envBProd })).rejects.toThrow("scoped proposal");
    const cancelled = new AbortController(); cancelled.abort(new Error("pass cancelled"));
    await expect(ports.startRepair({ ...request, signal: cancelled.signal })).rejects.toThrow("pass cancelled");
    expect(dispatch).not.toHaveBeenCalled();
    expect(await h.store.getOperation(request.workspaceId, request.operationId)).toMatchObject({ status: "approved" });
  });
});
