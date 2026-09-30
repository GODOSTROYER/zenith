/**
 * Approvals: human-only, digest-bound, expiring, N-distinct, refused and audited
 * when they should be. Every test runs against both stores.
 */
import { describe, expect, it } from "vitest";
import { STORE_KINDS, allowDecision, approveAs, closeSharedPgliteAfterAll, expectBrokerError, integrationOf, makeHarness, navigator, proposeOk, requestFor, requireApproval, scriptedEngine, sessionFor, systemPrincipal, user, type Harness } from "./support";

closeSharedPgliteAfterAll();

const prodRestart = (h: Harness, principal = user("bob")) => proposeOk(h, requestFor(h, "service.restart", "prod"), principal);

const refusals = async (h: Harness, operationId: string) =>
  (await h.store.listEvents(h.ids.wsA, { operationId })).filter((e) => e.type === "policy.evaluated" && (e.data as { kind?: string }).kind === "approval_refused");

describe.each(STORE_KINDS)("approve [%s]", (kind) => {
  it("moves an operation awaiting approval to approved, recording role and policy version", async () => {
    const h = await makeHarness({ kind });
    const op = await prodRestart(h);
    const result = await approveAs(h, op.operation, "dave");
    expect(result.finalized).toBe(true);
    expect(result.operation.status).toBe("approved");
    expect(result.approvals).toEqual({ have: 1, need: 1 });
    expect(result.approval).toMatchObject({ decision: "approve", approverId: "dave", approverRole: "editor" });
    expect(result.approval.policyVersion).toBe(op.decision.policyVersion);
    const detail = await h.broker.getOperationDetail({ workspaceId: h.ids.wsA, operationId: op.id, principal: user("bob") });
    expect(detail.approvals).toHaveLength(1);
    expect(detail.approvals[0]).toMatchObject({ approverId: "dave", consumed: false });
    const types = (await h.broker.listOperationEvents({ workspaceId: h.ids.wsA, operationId: op.id, principal: user("bob") })).items.map((e) => e.type);
    expect(types).toContain("operation.approved");
  });

  it("refuses a model, an integration, the Navigator, a system principal and a mismatched session — and audits it", async () => {
    const h = await makeHarness({ kind });
    const op = await prodRestart(h);
    const attempt = (approver: ReturnType<typeof user>, session = sessionFor(approver.id)) =>
      h.broker.approve({ workspaceId: h.ids.wsA, operationId: op.id, proposalDigest: op.digest, approver, session });

    const integration = integrationOf(h, "intRW", "bob");
    await expectBrokerError(attempt(integration), "approver_not_human");
    await expectBrokerError(attempt(navigator("dave")), "approver_not_human");
    // a "user" principal carrying onBehalfOf is an agent wearing a person's id
    await expectBrokerError(attempt({ ...user("dave"), onBehalfOf: "dave" }), "approver_not_human");
    // a human without their own browser session proof
    await expectBrokerError(attempt(user("dave"), sessionFor("someone-else")), "browser_session_required");
    await expectBrokerError(attempt(user("dave"), null as never), "browser_session_required");
    await expectBrokerError(attempt(user("dave"), { method: "bearer", subject: "dave", verifiedAtMs: 0 } as never), "browser_session_required");

    const refused = await refusals(h, op.id);
    expect(refused.length).toBeGreaterThanOrEqual(6);
    expect(refused.map((e) => (e.data as { code: string }).code)).toEqual(expect.arrayContaining(["approver_not_human", "browser_session_required"]));
    expect(refused.some((e) => e.actor?.kind === "integration")).toBe(true);
    // none of it moved the operation
    const current = await h.broker.getOperationDetail({ workspaceId: h.ids.wsA, operationId: op.id, principal: user("bob") });
    expect(current.operation.status).toBe("awaiting_approval");
    expect(current.approvals).toHaveLength(0);
  });

  it("refuses a system principal", async () => {
    const h = await makeHarness({ kind });
    const op = await prodRestart(h);
    // not a member of the workspace: the same not_found as a foreign id
    await expectBrokerError(h.broker.approve({ workspaceId: h.ids.wsA, operationId: op.id, proposalDigest: op.digest, approver: systemPrincipal(), session: sessionFor("reconciler") }), "not_found");
  });

  it("refuses a viewer and an approver below the required role", async () => {
    const h = await makeHarness({ kind });
    const op = await prodRestart(h);
    await expectBrokerError(approveAs(h, op.operation, "carol"), "approver_role_insufficient");

    h.setEngine(scriptedEngine("v1", () => requireApproval(1, "admin")));
    const adminOnly = await prodRestart(h);
    await expectBrokerError(approveAs(h, adminOnly.operation, "dave"), "approver_role_insufficient");
    expect((await approveAs(h, adminOnly.operation, "alice")).operation.status).toBe("approved");
  });

  it("refuses the requester approving their own operation when separation of duties applies", async () => {
    const h = await makeHarness({ kind, engine: scriptedEngine("v1", () => requireApproval(1, "editor", true)) });
    const op = await prodRestart(h, user("bob"));
    const error = await expectBrokerError(approveAs(h, op.operation, "bob"), "separation_of_duties");
    expect(error.status).toBe(403);
    expect((await refusals(h, op.id)).map((e) => (e.data as { code: string }).code)).toContain("separation_of_duties");
    expect((await approveAs(h, op.operation, "dave")).operation.status).toBe("approved");
  });

  it("treats the human an agent works for as the requester", async () => {
    const h = await makeHarness({ kind, engine: scriptedEngine("v1", () => requireApproval(1, "editor", true)) });
    const op = await prodRestart(h, integrationOf(h, "intRW", "bob"));
    expect(op.operation.principal).toMatchObject({ kind: "integration", onBehalfOf: "bob" });
    await expectBrokerError(approveAs(h, op.operation, "bob"), "separation_of_duties");
    expect((await approveAs(h, op.operation, "erin")).operation.status).toBe("approved");
  });

  it("allows self-approval when policy does not require separation of duties", async () => {
    const h = await makeHarness({ kind });
    const op = await prodRestart(h, user("bob"));
    expect((await approveAs(h, op.operation, "bob")).operation.status).toBe("approved");
  });

  it("refuses an approval of a different digest and records nothing", async () => {
    const h = await makeHarness({ kind });
    const op = await prodRestart(h);
    const other = await proposeOk(h, requestFor(h, "service.restart", "prod", { input: { different: true } }), user("bob"));
    const error = await expectBrokerError(
      h.broker.approve({ workspaceId: h.ids.wsA, operationId: op.id, proposalDigest: other.digest, approver: user("dave"), session: sessionFor("dave") }),
      "digest_mismatch"
    );
    expect(error.status).toBe(409);
    await expectBrokerError(h.broker.approve({ workspaceId: h.ids.wsA, operationId: op.id, proposalDigest: "0".repeat(64), approver: user("dave"), session: sessionFor("dave") }), "digest_mismatch");
    const detail = await h.broker.getOperationDetail({ workspaceId: h.ids.wsA, operationId: op.id, principal: user("bob") });
    expect(detail.approvals).toHaveLength(0);
    expect(detail.operation.status).toBe("awaiting_approval");
  });

  it("refuses to approve an expired operation", async () => {
    const h = await makeHarness({ kind });
    const op = await prodRestart(h);
    await h.expireOperation(op.id);
    await expectBrokerError(approveAs(h, op.operation, "dave"), "operation_expired");
    const after = await h.broker.getOperationDetail({ workspaceId: h.ids.wsA, operationId: op.id, principal: user("bob") });
    expect(after.operation.status).toBe("expired");
  });

  it("refuses to approve something that is not awaiting approval", async () => {
    const h = await makeHarness({ kind });
    const auto = await proposeOk(h, requestFor(h, "service.restart", "sbx"), user("bob"));
    await expectBrokerError(approveAs(h, auto.operation, "dave"), "invalid_state");
    const denied = await proposeOk(h, requestFor(h, "service.restart", "prod"), user("carol"));
    await expectBrokerError(approveAs(h, denied.operation, "dave"), "invalid_state");
  });

  it("counts a second approval by the same person once", async () => {
    const h = await makeHarness({ kind, engine: scriptedEngine("v1", () => requireApproval(2)) });
    const op = await prodRestart(h);
    const first = await approveAs(h, op.operation, "dave");
    expect(first.finalized).toBe(false);
    expect(first.approvals).toEqual({ have: 1, need: 2 });
    expect(first.operation.status).toBe("awaiting_approval");
    await expectBrokerError(approveAs(h, op.operation, "dave"), "duplicate_decision");
    const detail = await h.broker.getOperationDetail({ workspaceId: h.ids.wsA, operationId: op.id, principal: user("bob") });
    expect(detail.approvals.filter((a) => a.decision === "approve")).toHaveLength(1);
    expect(detail.operation.status).toBe("awaiting_approval");
  });

  it("needs N distinct approvers and approves when the Nth lands", async () => {
    const h = await makeHarness({ kind, engine: scriptedEngine("v1", () => requireApproval(3)) });
    const op = await prodRestart(h);
    const a = await approveAs(h, op.operation, "dave");
    const b = await approveAs(h, op.operation, "erin");
    expect([a.operation.status, b.operation.status]).toEqual(["awaiting_approval", "awaiting_approval"]);
    expect(b.approvals).toEqual({ have: 2, need: 3 });
    const c = await approveAs(h, op.operation, "alice");
    expect(c.finalized).toBe(true);
    expect(c.operation.status).toBe("approved");
    expect(c.approvals).toEqual({ have: 3, need: 3 });
    const events = (await h.broker.listOperationEvents({ workspaceId: h.ids.wsA, operationId: op.id, principal: user("bob") })).items.map((e) => ({ type: e.type, kind: (e.data as { kind?: string }).kind }));
    expect(events.filter((e) => e.kind === "approval_recorded")).toHaveLength(2);
    expect(events.filter((e) => e.type === "operation.approved")).toHaveLength(1);
  });

  it("re-validates against current policy when approving", async () => {
    const h = await makeHarness({ kind, engine: scriptedEngine("v1", () => requireApproval(1)) });
    const stricter = await prodRestart(h);
    h.setEngine(scriptedEngine("v2", () => requireApproval(2)));
    await expectBrokerError(approveAs(h, stricter.operation, "dave"), "reapproval_required");

    h.setEngine(scriptedEngine("v1", () => requireApproval(1)));
    const denied = await prodRestart(h);
    h.setEngine(scriptedEngine("v3", () => ({ outcome: "deny", reasons: [{ code: "now_denied", message: "no", rule: "test" }] })));
    const error = await expectBrokerError(approveAs(h, denied.operation, "dave"), "policy_denied");
    expect(error.details).toMatchObject({ reasons: ["now_denied"] });

    // a bundle change that does not change the requirement is fine, and is what gets recorded
    h.setEngine(scriptedEngine("v1", () => requireApproval(1)));
    const same = await prodRestart(h);
    h.setEngine(scriptedEngine("v9", () => requireApproval(1)));
    const approved = await approveAs(h, same.operation, "dave");
    expect(approved.approval.policyVersion).toBe("v9");
  });

  it("refuses a non-member with the same answer as a missing operation", async () => {
    const h = await makeHarness({ kind });
    const op = await prodRestart(h);
    const foreign = await expectBrokerError(approveAs(h, op.operation, "mallory"), "not_found");
    const missing = await expectBrokerError(approveAs(h, { id: "op_missing", proposalDigest: op.digest }, "dave"), "not_found");
    expect({ m: foreign.message, f: foreign.fix, s: foreign.status }).toEqual({ m: missing.message, f: missing.fix, s: missing.status });
  });
});

describe.each(STORE_KINDS)("reject and revoke [%s]", (kind) => {
  it("rejects an operation and leaves it unexecutable", async () => {
    const h = await makeHarness({ kind });
    const op = await prodRestart(h);
    const result = await h.broker.reject({ workspaceId: h.ids.wsA, operationId: op.id, proposalDigest: op.digest, approver: user("dave"), session: sessionFor("dave"), reason: "not now" });
    expect(result.operation.status).toBe("rejected");
    expect(result.finalized).toBe(true);
    await expectBrokerError(approveAs(h, op.operation, "erin"), "invalid_state");
    await expectBrokerError(h.broker.beginExecution({ workspaceId: h.ids.wsA, operationId: op.id, holder: "w1", audience: "worker" }), "invalid_state");
    const types = (await h.broker.listOperationEvents({ workspaceId: h.ids.wsA, operationId: op.id, principal: user("bob") })).items.map((e) => e.type);
    expect(types).toContain("operation.rejected");
  });

  it("refuses agents and viewers rejecting", async () => {
    const h = await makeHarness({ kind });
    const op = await prodRestart(h);
    await expectBrokerError(h.broker.reject({ workspaceId: h.ids.wsA, operationId: op.id, proposalDigest: op.digest, approver: navigator("dave"), session: sessionFor("dave") }), "approver_not_human");
    await expectBrokerError(h.broker.reject({ workspaceId: h.ids.wsA, operationId: op.id, proposalDigest: op.digest, approver: user("carol"), session: sessionFor("carol") }), "approver_role_insufficient");
  });

  it("withdrawing an approval cancels the operation; only an approver or an admin may", async () => {
    const h = await makeHarness({ kind });
    const op = await prodRestart(h);
    await approveAs(h, op.operation, "dave");
    await expectBrokerError(h.broker.revokeApproval({ workspaceId: h.ids.wsA, operationId: op.id, actor: user("bob"), session: sessionFor("bob") }), "role_insufficient");
    await expectBrokerError(h.broker.revokeApproval({ workspaceId: h.ids.wsA, operationId: op.id, actor: navigator("dave"), session: sessionFor("dave") }), "approver_not_human");
    const revoked = await h.broker.revokeApproval({ workspaceId: h.ids.wsA, operationId: op.id, actor: user("dave"), session: sessionFor("dave"), reason: "changed my mind" });
    expect(revoked.operation.status).toBe("cancelled");
    expect(revoked.operation.error).toContain("Approval revoked by dave");
    await expectBrokerError(h.broker.beginExecution({ workspaceId: h.ids.wsA, operationId: op.id, holder: "w1", audience: "worker" }), "invalid_state");
    await expectBrokerError(h.broker.revokeApproval({ workspaceId: h.ids.wsA, operationId: op.id, actor: user("dave"), session: sessionFor("dave") }), "invalid_state");

    const second = await prodRestart(h);
    await approveAs(h, second.operation, "dave");
    expect((await h.broker.revokeApproval({ workspaceId: h.ids.wsA, operationId: second.id, actor: user("alice"), session: sessionFor("alice") })).operation.status).toBe("cancelled");
  });

  it("cannot withdraw an approval once execution has started", async () => {
    const h = await makeHarness({ kind });
    const op = await prodRestart(h);
    await approveAs(h, op.operation, "dave");
    await h.broker.beginExecution({ workspaceId: h.ids.wsA, operationId: op.id, holder: "w1", audience: "worker" });
    await expectBrokerError(h.broker.revokeApproval({ workspaceId: h.ids.wsA, operationId: op.id, actor: user("dave"), session: sessionFor("dave") }), "invalid_state");
  });
});

describe.each(STORE_KINDS)("cancel [%s]", (kind) => {
  it("lets the requester, their human and staff cancel; not an unrelated viewer or another agent", async () => {
    const h = await makeHarness({ kind });
    const mine = await prodRestart(h, user("bob"));
    await expectBrokerError(h.broker.cancelOperation({ workspaceId: h.ids.wsA, operationId: mine.id, principal: user("carol") }), "role_insufficient");
    await expectBrokerError(h.broker.cancelOperation({ workspaceId: h.ids.wsA, operationId: mine.id, principal: integrationOf(h, "intRW") }), "role_insufficient");
    expect((await h.broker.cancelOperation({ workspaceId: h.ids.wsA, operationId: mine.id, principal: user("bob"), reason: "oops" })).status).toBe("cancelled");

    const viaAgent = await prodRestart(h, integrationOf(h, "intRW", "bob"));
    expect((await h.broker.cancelOperation({ workspaceId: h.ids.wsA, operationId: viaAgent.id, principal: user("bob") })).status).toBe("cancelled");

    const agentOwn = await prodRestart(h, integrationOf(h, "intRW", "bob"));
    expect((await h.broker.cancelOperation({ workspaceId: h.ids.wsA, operationId: agentOwn.id, principal: integrationOf(h, "intRW", "bob") })).status).toBe("cancelled");

    const staff = await prodRestart(h, user("bob"));
    expect((await h.broker.cancelOperation({ workspaceId: h.ids.wsA, operationId: staff.id, principal: user("erin") })).status).toBe("cancelled");
    await expectBrokerError(h.broker.cancelOperation({ workspaceId: h.ids.wsA, operationId: staff.id, principal: user("erin") }), "invalid_state");
  });

  it("cannot cancel a running operation", async () => {
    const h = await makeHarness({ kind });
    const op = await proposeOk(h, requestFor(h, "service.restart", "sbx"), user("bob"));
    await h.broker.beginExecution({ workspaceId: h.ids.wsA, operationId: op.id, holder: "w1", audience: "worker" });
    await expectBrokerError(h.broker.cancelOperation({ workspaceId: h.ids.wsA, operationId: op.id, principal: user("bob") }), "invalid_state");
  });
});

describe("the allow path never needed an approval", () => {
  it("a policy-approved operation has no approvals and is still claimable", async () => {
    const h = await makeHarness({ kind: "memory", engine: scriptedEngine("v1", () => allowDecision()) });
    const op = await proposeOk(h, requestFor(h, "service.restart", "prod"), user("bob"));
    expect(op.operation.status).toBe("approved");
    const begun = await h.broker.beginExecution({ workspaceId: h.ids.wsA, operationId: op.id, holder: "w1", audience: "worker" });
    expect(begun.operation.status).toBe("running");
  });
});
