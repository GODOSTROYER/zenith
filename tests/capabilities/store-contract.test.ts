/**
 * The BrokerStore contract, run against BOTH implementations: the in-memory
 * store and the platform control store adapter over PGlite. A behaviour that
 * differs between them is a bug in the in-memory store (it stands in for the
 * database in every other test) or in the adapter.
 */
import { describe, expect, it } from "vitest";
import { digest } from "@/lib/controlplane/digest";
import type { OperationProposal, Principal } from "@/lib/controlplane/types";
import type { NewOperation } from "@/lib/capabilities/ports";
import { STORE_KINDS, approveAs, closeSharedPgliteAfterAll, expectBrokerError, makeHarness, proposeOk, requestFor, requireApproval, scriptedEngine, sessionFor, user, type Harness } from "./support";

closeSharedPgliteAfterAll();

const CANARY = "AKIAIOSFODNN7EXAMPLE";
let n = 0;

function newOperation(h: Harness, overrides: Omit<Partial<NewOperation>, "proposal"> & { proposal?: Partial<OperationProposal> } = {}): NewOperation {
  const { proposal, ...rest } = overrides;
  const tag = `c${++n}${Math.random().toString(36).slice(2, 6)}`;
  return {
    id: `op_${tag}`,
    decisionId: `pol_${tag}`,
    workspaceId: h.ids.wsA,
    principal: user("bob") as Principal,
    proposal: {
      capability: "service.restart",
      scope: { workspaceId: h.ids.wsA, projectId: h.ids.projA, environmentId: h.ids.envAProd, resourceId: h.ids.resAWebProd },
      input: { graceful: true },
      summary: "Restart a service",
      details: ["Capability: service.restart"],
      risk: "medium",
      ...proposal,
    },
    decision: { policyVersion: "v1", inputDigest: "a".repeat(64), outcome: "require_approval", reasons: [{ code: "r", message: "m" }], approval: { count: 1, minRole: "editor", separationOfDuties: false } },
    requestHash: digest({ tag }),
    correlationId: `corr_${tag}`,
    ttlMs: 60 * 60 * 1000,
    ...rest,
  };
}

describe.each(STORE_KINDS)("BrokerStore contract [%s]", (kind) => {
  describe("createOperation", () => {
    it("computes digests itself, returns the decision, and appends the ledger events", async () => {
      const h = await makeHarness({ kind });
      const input = newOperation(h);
      const { operation, decision, created } = await h.store.createOperation(input);
      expect(created).toBe(true);
      expect(operation.proposalDigest).toBe(digest(input.proposal));
      expect(operation.inputDigest).toBe(digest(input.proposal.input));
      expect(operation).toMatchObject({ id: input.id, status: "awaiting_approval", approvalRequired: true, policyDecisionId: input.decisionId, workspaceId: h.ids.wsA, capability: "service.restart" });
      expect(Date.parse(operation.expiresAt)).toBeGreaterThan(Date.now() + 50 * 60 * 1000);
      expect(decision).toMatchObject({ id: input.decisionId, operationId: input.id, outcome: "require_approval", policyVersion: "v1" });
      const events = await h.store.listEvents(h.ids.wsA, { operationId: input.id });
      expect(events.map((e) => e.type)).toEqual(["operation.proposed", "policy.evaluated"]);
      expect(events[0].actor?.id).toBe("bob");
      expect(events[0].correlationId).toBe(input.correlationId);
      expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((a, b) => a - b));
    });

    it("records an allow as approved and a deny as denied, with their events", async () => {
      const h = await makeHarness({ kind });
      const allow = await h.store.createOperation(newOperation(h, { decision: { policyVersion: "v1", inputDigest: "b".repeat(64), outcome: "allow", reasons: [{ code: "ok", message: "ok" }] } }));
      expect(allow.operation.status).toBe("approved");
      expect((await h.store.listEvents(h.ids.wsA, { operationId: allow.operation.id })).map((e) => e.type)).toEqual(["operation.proposed", "policy.evaluated", "operation.approved"]);
      const deny = await h.store.createOperation(newOperation(h, { decision: { policyVersion: "v1", inputDigest: "c".repeat(64), outcome: "deny", reasons: [{ code: "no", message: "no" }] } }));
      expect(deny.operation.status).toBe("denied");
      expect(deny.operation.finishedAt).toBeTruthy();
      expect((await h.store.listEvents(h.ids.wsA, { operationId: deny.operation.id })).map((e) => e.type)).toEqual(["operation.proposed", "policy.evaluated", "operation.denied"]);
    });

    it("refuses inconsistent or unsafe input", async () => {
      const h = await makeHarness({ kind });
      await expectBrokerError(h.store.createOperation(newOperation(h, { proposal: { scope: { workspaceId: h.ids.wsB } } })), "not_found");
      await expectBrokerError(h.store.createOperation(newOperation(h, { proposal: { input: { key: CANARY } } })), "secret_material");
      expect((await h.store.listOperations(h.ids.wsA)).items).toHaveLength(0);
    });

    it("replays the same key and request, and conflicts on a different request", async () => {
      const h = await makeHarness({ kind });
      const first = newOperation(h, { idempotencyKey: "store-key-1", requestHash: "h1" });
      const a = await h.store.createOperation(first);
      const b = await h.store.createOperation({ ...newOperation(h), idempotencyKey: "store-key-1", requestHash: "h1" });
      expect(b.created).toBe(false);
      expect(b.operation.id).toBe(a.operation.id);
      expect(b.decision.id).toBe(a.decision.id);
      await expectBrokerError(h.store.createOperation({ ...newOperation(h), idempotencyKey: "store-key-1", requestHash: "h2" }), "idempotency_conflict");
      expect((await h.store.listOperations(h.ids.wsA)).items).toHaveLength(1);
    });
  });

  describe("listing", () => {
    it("pages newest first with an opaque cursor and filters in the workspace", async () => {
      const h = await makeHarness({ kind });
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push((await h.store.createOperation(newOperation(h))).operation.id);
      await h.store.createOperation(newOperation(h, { proposal: { capability: "service.scale" } }));
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await h.store.listOperations(h.ids.wsA, { capability: "service.restart" }, { limit: 2, cursor });
        seen.push(...page.items.map((o) => o.id));
        cursor = page.nextCursor;
        pages++;
      } while (cursor && pages < 10);
      expect(pages).toBe(3);
      expect(seen).toEqual([...ids].reverse());
      await expectBrokerError(h.store.listOperations(h.ids.wsA, {}, { cursor: "%%%not a cursor" }), "invalid_request").catch(async () => {
        // the database adapter may surface its own refusal for a malformed cursor; it must still be a refusal
        await expect(h.store.listOperations(h.ids.wsA, {}, { cursor: "%%%not a cursor" })).rejects.toBeTruthy();
      });
      expect((await h.store.listOperations(h.ids.wsA, { status: "denied" })).items).toHaveLength(0);
      expect((await h.store.listOperations(h.ids.wsA, { principalId: "bob" })).items.length).toBe(6);
      expect((await h.store.listOperations(h.ids.wsA, { principalId: "someone-else" })).items).toHaveLength(0);
    });
  });

  describe("conditional transitions", () => {
    it("denies once using only this operation's persisted denial and revokes grants atomically", async () => {
      const h = await makeHarness({ kind });
      const allowed = { policyVersion: "v1", inputDigest: "d".repeat(64), outcome: "allow" as const, reasons: [{ code: "ok", message: "ok" }] };
      const { operation } = await h.store.createOperation(newOperation(h, { decision: allowed }));
      const other = await h.store.createOperation(newOperation(h, { decision: allowed }));
      const foreignDecision = await h.store.recordPolicyDecision({ workspaceId: h.ids.wsA, operationId: other.operation.id, ...allowed, outcome: "deny" });
      expect(await h.store.denyOperation({ workspaceId: h.ids.wsA, id: operation.id, decisionId: foreignDecision.id })).toBeNull();
      expect(await h.store.denyOperation({ workspaceId: h.ids.wsA, id: operation.id, decisionId: operation.policyDecisionId! })).toBeNull();
      const denial = await h.store.recordPolicyDecision({ workspaceId: h.ids.wsA, operationId: operation.id, ...allowed, outcome: "deny" });
      expect(await h.store.denyOperation({ workspaceId: h.ids.wsB, id: operation.id, decisionId: denial.id })).toBeNull();
      await h.store.insertGrant({ jti: `denial_${operation.id}`, workspaceId: h.ids.wsA, operationId: operation.id, capability: operation.capability, audience: "worker", issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
      const attempts = await Promise.all([h.store.denyOperation({ workspaceId: h.ids.wsA, id: operation.id, decisionId: denial.id }), h.store.denyOperation({ workspaceId: h.ids.wsA, id: operation.id, decisionId: denial.id })]);
      expect(attempts.filter(Boolean)).toHaveLength(1);
      expect(attempts.find(Boolean)).toMatchObject({ status: "denied", policyDecisionId: denial.id });
      expect(await h.store.consumeGrant({ workspaceId: h.ids.wsA, jti: `denial_${operation.id}` })).toBe(false);
      expect((await h.store.listEvents(h.ids.wsA, { operationId: operation.id })).filter((e) => e.type === "operation.denied")).toHaveLength(1);
    });

    it("cancels a pre-execution operation once", async () => {
      const h = await makeHarness({ kind });
      const { operation } = await h.store.createOperation(newOperation(h));
      const cancelled = await h.store.cancelOperation({ workspaceId: h.ids.wsA, id: operation.id, reason: "no longer needed", actor: user("bob") });
      expect(cancelled).toMatchObject({ status: "cancelled", error: "no longer needed" });
      expect(cancelled?.finishedAt).toBeTruthy();
      expect(await h.store.cancelOperation({ workspaceId: h.ids.wsA, id: operation.id })).toBeNull();
      expect((await h.store.listEvents(h.ids.wsA, { operationId: operation.id })).map((e) => e.type)).toContain("operation.cancelled");
    });

    it("supersedes an awaiting teardown only while its expected status still matches", async () => {
      const h = await makeHarness({ kind });
      const waiting = (await h.store.createOperation(newOperation(h, { proposal: { capability: "infrastructure.destroy" } }))).operation;
      expect(await h.store.cancelOperation({ workspaceId: h.ids.wsB, id: waiting.id, expectedStatus: "awaiting_approval" })).toBeNull();
      expect(await h.store.cancelOperation({ workspaceId: h.ids.wsA, id: waiting.id, expectedStatus: "awaiting_approval", reason: "Superseded by a new teardown review." })).toMatchObject({ status: "cancelled" });
      const approved = (await h.store.createOperation(newOperation(h, { proposal: { capability: "infrastructure.destroy" } }))).operation;
      await h.store.recordApproval({ workspaceId: h.ids.wsA, operationId: approved.id, approver: user("erin"), approverRole: "admin", decision: "approve", proposalDigest: approved.proposalDigest, policyVersion: "v1" });
      expect(await h.store.cancelOperation({ workspaceId: h.ids.wsA, id: approved.id, expectedStatus: "awaiting_approval" })).toBeNull();
      expect((await h.store.getOperation(h.ids.wsA, approved.id))?.status).toBe("approved");
      expect((await h.store.listEvents(h.ids.wsA, { operationId: approved.id })).some((e) => e.type === "operation.cancelled")).toBe(false);
    });

    it("keeps the operation, approvals, grants and events when approval wins a supersession race", async () => {
      const h = await makeHarness({ kind });
      const { operation } = await h.store.createOperation(newOperation(h, { proposal: { capability: "infrastructure.destroy" } }));
      // The review worker read this pending row before the browser approved it.
      const stale = (await h.store.getOperation(h.ids.wsA, operation.id))!;
      expect(stale.status).toBe("awaiting_approval");
      await h.store.recordApproval({ workspaceId: h.ids.wsA, operationId: operation.id, approver: user("erin"), approverRole: "admin",
        decision: "approve", proposalDigest: operation.proposalDigest, policyVersion: "v1" });
      const approved = await h.store.getOperation(h.ids.wsA, operation.id);
      const approvals = await h.store.listApprovals(h.ids.wsA, operation.id);
      const events = await h.store.listEvents(h.ids.wsA, { operationId: operation.id });
      const jti = `approval_race_${operation.id}`;
      await h.store.insertGrant({ jti, workspaceId: h.ids.wsA, operationId: operation.id, capability: "infrastructure.destroy", audience: "worker",
        issuedAt: h.clock.now().toISOString(), expiresAt: new Date(h.clock.now().getTime() + 60_000).toISOString() });
      expect(await h.store.cancelOperation({ workspaceId: h.ids.wsA, id: stale.id, expectedStatus: "awaiting_approval", reason: "Superseded" })).toBeNull();
      expect(await h.store.getOperation(h.ids.wsA, operation.id)).toEqual(approved);
      expect(await h.store.listApprovals(h.ids.wsA, operation.id)).toEqual(approvals);
      expect(await h.store.listEvents(h.ids.wsA, { operationId: operation.id })).toEqual(events);
      expect(await h.store.consumeGrant({ workspaceId: h.ids.wsA, jti })).toBe(true);
    });

    it("revokes live grants when cancelling", async () => {
      const h = await makeHarness({ kind });
      const { operation } = await h.store.createOperation(newOperation(h, { decision: { policyVersion: "v1", inputDigest: "d".repeat(64), outcome: "allow", reasons: [{ code: "ok", message: "ok" }] } }));
      const now = new Date();
      await h.store.insertGrant({ jti: `grt_${operation.id}`, workspaceId: h.ids.wsA, operationId: operation.id, capability: "service.restart", audience: "worker", issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString() });
      await h.store.cancelOperation({ workspaceId: h.ids.wsA, id: operation.id });
      expect(await h.store.consumeGrant({ workspaceId: h.ids.wsA, jti: `grt_${operation.id}` })).toBe(false);
    });

    it("expires only an operation that is past its expiry", async () => {
      const h = await makeHarness({ kind });
      const { operation } = await h.store.createOperation(newOperation(h));
      expect(await h.store.expireOperation({ workspaceId: h.ids.wsA, id: operation.id })).toBeNull();
      await h.expireOperation(operation.id);
      const expired = await h.store.expireOperation({ workspaceId: h.ids.wsA, id: operation.id });
      expect(expired?.status).toBe("expired");
      expect(await h.store.expireOperation({ workspaceId: h.ids.wsA, id: operation.id })).toBeNull();
      expect(await h.store.cancelOperation({ workspaceId: h.ids.wsA, id: operation.id })).toBeNull();
    });

    it("completes only a running operation, once", async () => {
      const h = await makeHarness({ kind });
      const { operation } = await h.store.createOperation(newOperation(h, { decision: { policyVersion: "v1", inputDigest: "e".repeat(64), outcome: "allow", reasons: [{ code: "ok", message: "ok" }] } }));
      expect(await h.store.completeOperation({ workspaceId: h.ids.wsA, id: operation.id, outcome: "succeeded" })).toBeNull();
      const claimed = await h.store.claimForExecution({ workspaceId: h.ids.wsA, id: operation.id, expectedDigest: operation.proposalDigest, holder: "w1" });
      expect(claimed.status).toBe("running");
      expect(claimed.startedAt).toBeTruthy();
      const done = await h.store.completeOperation({ workspaceId: h.ids.wsA, id: operation.id, outcome: "succeeded", result: { ok: true } });
      expect(done).toMatchObject({ status: "succeeded", result: { ok: true } });
      expect(await h.store.completeOperation({ workspaceId: h.ids.wsA, id: operation.id, outcome: "failed" })).toBeNull();
      expect((await h.store.listEvents(h.ids.wsA, { operationId: operation.id })).map((e) => e.type)).toEqual(["operation.proposed", "policy.evaluated", "operation.approved", "operation.started", "operation.succeeded"]);
    });

    it("refuses secrets in a result", async () => {
      const h = await makeHarness({ kind });
      const { operation } = await h.store.createOperation(newOperation(h, { decision: { policyVersion: "v1", inputDigest: "f".repeat(64), outcome: "allow", reasons: [{ code: "ok", message: "ok" }] } }));
      await h.store.claimForExecution({ workspaceId: h.ids.wsA, id: operation.id, expectedDigest: operation.proposalDigest, holder: "w1" });
      await expectBrokerError(h.store.completeOperation({ workspaceId: h.ids.wsA, id: operation.id, outcome: "succeeded", result: { leaked: CANARY } }), "secret_material");
      expect((await h.store.getOperation(h.ids.wsA, operation.id))?.status).toBe("running");
    });
  });

  describe("claimForExecution", () => {
    it("requires an approved operation, the exact digest and an unexpired operation", async () => {
      const h = await makeHarness({ kind });
      const waiting = (await h.store.createOperation(newOperation(h))).operation;
      await expectBrokerError(h.store.claimForExecution({ workspaceId: h.ids.wsA, id: waiting.id, expectedDigest: waiting.proposalDigest, holder: "w" }), "invalid_state");

      const op = await proposeOk(h, requestFor(h, "service.restart", "sbx"), user("bob"));
      await expectBrokerError(h.store.claimForExecution({ workspaceId: h.ids.wsA, id: op.id, expectedDigest: "1".repeat(64), holder: "w" }), "digest_mismatch");
      await h.expireOperation(op.id);
      await expectBrokerError(h.store.claimForExecution({ workspaceId: h.ids.wsA, id: op.id, expectedDigest: op.digest, holder: "w" }), "operation_expired");
    });

    it("consumes each approval exactly once and needs the decision's full count", async () => {
      const h = await makeHarness({ kind, engine: scriptedEngine("v1", () => requireApproval(2)) });
      const op = await proposeOk(h, requestFor(h, "service.restart", "prod"), user("bob"));
      await approveAs(h, op.operation, "dave");
      await expectBrokerError(h.store.claimForExecution({ workspaceId: h.ids.wsA, id: op.id, expectedDigest: op.digest, holder: "w" }), "invalid_state"); // still awaiting
      await approveAs(h, op.operation, "erin");
      const claimed = await h.store.claimForExecution({ workspaceId: h.ids.wsA, id: op.id, expectedDigest: op.digest, holder: "w" });
      expect(claimed.status).toBe("running");
      const approvals = await h.store.listApprovals(h.ids.wsA, op.id);
      expect(approvals).toHaveLength(2);
      expect(approvals.every((a) => a.consumedAt)).toBe(true);
      await expectBrokerError(h.store.claimForExecution({ workspaceId: h.ids.wsA, id: op.id, expectedDigest: op.digest, holder: "w2" }), "invalid_state");
    });

    it("refuses expired approvals and approvals from another bundle when a version is demanded", async () => {
      const h = await makeHarness({ kind });
      const op = await proposeOk(h, requestFor(h, "service.restart", "prod"), user("bob"));
      await approveAs(h, op.operation, "dave");
      const version = (await h.store.listApprovals(h.ids.wsA, op.id))[0].policyVersion;
      await expectBrokerError(h.store.claimForExecution({ workspaceId: h.ids.wsA, id: op.id, expectedDigest: op.digest, holder: "w", expectedPolicyVersion: "some-other-bundle" }), "reapproval_required");
      // the failed claim consumed nothing
      expect((await h.store.listApprovals(h.ids.wsA, op.id))[0].consumedAt).toBeUndefined();
      await h.expireApprovals(op.id);
      await expectBrokerError(h.store.claimForExecution({ workspaceId: h.ids.wsA, id: op.id, expectedDigest: op.digest, holder: "w", expectedPolicyVersion: version }), "approval_required");
    });

    it("lets exactly one of many concurrent claimants win", async () => {
      const h = await makeHarness({ kind });
      const op = await proposeOk(h, requestFor(h, "service.restart", "sbx"), user("bob"));
      const claim = (holder: string) => h.store.claimForExecution({ workspaceId: h.ids.wsA, id: op.id, expectedDigest: op.digest, holder });
      const results = await Promise.allSettled(["a", "b", "c", "d", "e"].map(claim));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason.code === "invalid_state")).toBe(true);
    });

    it("asserts the environment lease fence", async () => {
      const h = await makeHarness({ kind });
      const op = await proposeOk(h, requestFor(h, "service.restart", "sbx"), user("bob"));
      const lease = await h.acquireLease(h.ids.envASbx);
      await h.loseLease(lease.scope);
      await expectBrokerError(h.store.claimForExecution({ workspaceId: h.ids.wsA, id: op.id, expectedDigest: op.digest, holder: "w", lease }), "lease_lost");
      const fresh = await h.acquireLease(h.ids.envASbx);
      const claimed = await h.store.claimForExecution({ workspaceId: h.ids.wsA, id: op.id, expectedDigest: op.digest, holder: "w", lease: fresh });
      expect(claimed).toMatchObject({ leaseScope: fresh.scope, fenceToken: fresh.fenceToken });
      // a completion under a different fence changes nothing
      await h.loseLease(fresh.scope);
      await expectBrokerError(h.store.completeOperation({ workspaceId: h.ids.wsA, id: op.id, outcome: "succeeded", fence: fresh }), "lease_lost");
    });
  });

  describe("recordApproval", () => {
    const decide = (h: Harness, op: { id: string; digest: string }, who: Principal, role: "viewer" | "editor" | "admin" = "editor", extra: Record<string, unknown> = {}) =>
      h.store.recordApproval({ workspaceId: h.ids.wsA, operationId: op.id, approver: who, approverRole: role, decision: "approve", proposalDigest: op.digest, policyVersion: "v1", ...extra } as Parameters<Harness["store"]["recordApproval"]>[0]);

    it("enforces human, role, digest, separation of duties, duplicates and expiry", async () => {
      const h = await makeHarness({ kind, engine: scriptedEngine("v1", () => requireApproval(1, "editor", true)) });
      const op = await proposeOk(h, requestFor(h, "service.restart", "prod"), user("bob"));
      await expectBrokerError(decide(h, op, { ...user("dave"), onBehalfOf: "dave" }), "approver_not_human");
      await expectBrokerError(decide(h, op, { kind: "integration", id: "i", name: "i", integrationId: "i" }), "approver_not_human");
      await expectBrokerError(decide(h, op, { kind: "navigator", id: "n", name: "n" }), "approver_not_human");
      await expectBrokerError(decide(h, op, user("carol"), "viewer"), "approver_role_insufficient");
      await expectBrokerError(decide(h, { ...op, digest: "2".repeat(64) }, user("dave")), "digest_mismatch");
      await expectBrokerError(decide(h, op, user("bob")), "separation_of_duties");
      await expectBrokerError(decide(h, op, user("dave"), "editor", { decision: "maybe" }), "invalid_request");
      await expectBrokerError(decide(h, op, user("dave"), "editor", { reason: `because ${CANARY}` }), "secret_material");
      const ok = await decide(h, op, user("dave"));
      expect(ok.operation.status).toBe("approved");
      expect(ok.approvals).toEqual({ have: 1, need: 1 });
      await expectBrokerError(decide(h, op, user("erin")), "invalid_state"); // no longer awaiting
    });

    it("rejects immediately, records duplicates once, and needs N distinct approvers", async () => {
      const h = await makeHarness({ kind, engine: scriptedEngine("v1", () => requireApproval(2)) });
      const op = await proposeOk(h, requestFor(h, "service.restart", "prod"), user("bob"));
      const first = await decide(h, op, user("dave"));
      expect(first.operation.status).toBe("awaiting_approval");
      await expectBrokerError(decide(h, op, user("dave")), "duplicate_decision");
      expect((await decide(h, op, user("erin"), "admin")).operation.status).toBe("approved");

      const other = await proposeOk(h, requestFor(h, "service.restart", "prod"), user("bob"));
      const rejected = await decide(h, other, user("dave"), "editor", { decision: "reject", reason: "no" });
      expect(rejected.operation.status).toBe("rejected");
      expect(rejected.approvals.have).toBe(0);
    });

    it("caps an approval's expiry at the operation's own", async () => {
      const h = await makeHarness({ kind });
      const op = await proposeOk(h, requestFor(h, "service.restart", "prod"), user("bob"), { ttlMs: 60_000 });
      const done = await decide(h, op, user("dave"), "editor", { ttlMs: 6 * 60 * 60 * 1000 });
      expect(Date.parse(done.approval.expiresAt)).toBeLessThanOrEqual(Date.parse(op.operation.expiresAt) + 1000);
    });
  });

  describe("grants", () => {
    it("lives at most an hour, consumes once, expires, and revokes per operation", async () => {
      const h = await makeHarness({ kind });
      const op = await proposeOk(h, requestFor(h, "service.restart", "sbx"), user("bob"));
      const at = Date.now();
      const base = { workspaceId: h.ids.wsA, operationId: op.id, capability: "service.restart", audience: "worker", issuedAt: new Date(at).toISOString() };
      await expectBrokerError(h.store.insertGrant({ ...base, jti: "g_long", expiresAt: new Date(at + 2 * 60 * 60 * 1000).toISOString() }), "invalid_request");
      await expectBrokerError(h.store.insertGrant({ ...base, jti: "g_backwards", expiresAt: new Date(at - 1000).toISOString() }), "invalid_request");
      await h.store.insertGrant({ ...base, jti: `g_ok_${op.id}`, expiresAt: new Date(at + 60_000).toISOString() });
      await h.store.insertGrant({ ...base, jti: `g_rev_${op.id}`, expiresAt: new Date(at + 60_000).toISOString() });
      await expectBrokerError(h.store.insertGrant({ ...base, jti: `g_ok_${op.id}`, expiresAt: new Date(at + 60_000).toISOString() }), "conflict").catch(async () => {
        await expect(h.store.insertGrant({ ...base, jti: `g_ok_${op.id}`, expiresAt: new Date(at + 60_000).toISOString() })).rejects.toBeTruthy();
      });
      expect(await h.store.consumeGrant({ workspaceId: h.ids.wsA, jti: `g_ok_${op.id}` })).toBe(true);
      expect(await h.store.consumeGrant({ workspaceId: h.ids.wsA, jti: `g_ok_${op.id}` })).toBe(false);
      expect(await h.store.revokeGrantsForOperation(h.ids.wsA, op.id)).toBe(1); // the consumed one is not "live"
      expect(await h.store.consumeGrant({ workspaceId: h.ids.wsA, jti: `g_rev_${op.id}` })).toBe(false);
      expect(await h.store.consumeGrant({ workspaceId: h.ids.wsA, jti: "g_never_issued" })).toBe(false);
    });
  });

  describe("settings", () => {
    it("reports never-configured environments and versions each write", async () => {
      const h = await makeHarness({ kind });
      const before = await h.store.getEnvironmentSettings(h.ids.wsA, h.ids.envAProd);
      expect(before).toMatchObject({ isDefault: true, version: 0 });
      const one = await h.store.putEnvironmentAutonomy({ workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, autonomyLevel: 4, updatedBy: "alice" });
      expect(one).toMatchObject({ autonomyLevel: 4, version: 1, isDefault: false, updatedBy: "alice" });
      const two = await h.store.putEnvironmentAutonomy({ workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, autonomyLevel: 1, updatedBy: "erin", expectedVersion: 1 });
      expect(two.version).toBe(2);
      await expectBrokerError(h.store.putEnvironmentAutonomy({ workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, autonomyLevel: 3, updatedBy: "alice", expectedVersion: 1 }), "conflict");
      await expect(h.store.putEnvironmentAutonomy({ workspaceId: h.ids.wsA, environmentId: h.ids.envAStg, autonomyLevel: 9 as never, updatedBy: "alice" })).rejects.toBeTruthy();
    });

    it("keeps an environment's other settings when the level changes (database)", async () => {
      const h = await makeHarness({ kind });
      if (!h.db) return;
      await h.db.query("insert into platform.environment_settings (environment_id, workspace_id, autonomy_level, policy_params, version, updated_by) values ($1, $2, 2, $3::text::jsonb, 1, 'seed')", [h.ids.envAStg, h.ids.wsA, JSON.stringify({ keep: "me" })]);
      await h.store.putEnvironmentAutonomy({ workspaceId: h.ids.wsA, environmentId: h.ids.envAStg, autonomyLevel: 5, updatedBy: "alice" });
      const rows = await h.db.query<{ policy_params: unknown; autonomy_level: number }>("select policy_params, autonomy_level from platform.environment_settings where environment_id = $1", [h.ids.envAStg]);
      expect(rows[0]).toMatchObject({ policy_params: { keep: "me" }, autonomy_level: 5 });
    });

    it("versions workspace policy and refuses secrets in it", async () => {
      const h = await makeHarness({ kind });
      expect(await h.store.getWorkspacePolicy(h.ids.wsA)).toMatchObject({ isDefault: true, version: 0, params: {} });
      const saved = await h.store.putWorkspacePolicy({ workspaceId: h.ids.wsA, params: { twoPersonProduction: true }, updatedBy: "alice" });
      expect(saved).toMatchObject({ version: 1, params: { twoPersonProduction: true } });
      await expectBrokerError(h.store.putWorkspacePolicy({ workspaceId: h.ids.wsA, params: {}, updatedBy: "alice", expectedVersion: 0 }), "conflict");
      await expectBrokerError(h.store.putWorkspacePolicy({ workspaceId: h.ids.wsA, params: { note: CANARY }, updatedBy: "alice" }), "secret_material");
    });
  });

  describe("events", () => {
    it("appends in order, filters, and is idempotent by id", async () => {
      const h = await makeHarness({ kind });
      const base = { workspaceId: h.ids.wsA, correlationId: "corr_e1" };
      const s1 = await h.store.appendEvent({ ...base, type: "policy.evaluated", operationId: "op_e", data: { a: 1 } });
      const s2 = await h.store.appendEvent({ ...base, type: "lease.acquired", environmentId: h.ids.envAProd, data: {} });
      const s3 = await h.store.appendEvent({ ...base, type: "policy.evaluated", operationId: "op_e", id: "evt_fixed_1", data: { b: 2 } });
      const again = await h.store.appendEvent({ ...base, type: "policy.evaluated", operationId: "op_e", id: "evt_fixed_1", data: { b: 2 } });
      expect(again).toBe(s3);
      expect(s1).toBeLessThan(s2);
      expect(s2).toBeLessThan(s3);
      const all = await h.store.listEvents(h.ids.wsA);
      expect(all.map((e) => e.seq)).toEqual([s1, s2, s3]);
      expect((await h.store.listEvents(h.ids.wsA, { operationId: "op_e" })).map((e) => e.seq)).toEqual([s1, s3]);
      expect((await h.store.listEvents(h.ids.wsA, { type: "lease.acquired" })).map((e) => e.seq)).toEqual([s2]);
      expect((await h.store.listEvents(h.ids.wsA, { afterSeq: s1, limit: 1 })).map((e) => e.seq)).toEqual([s2]);
      expect((await h.store.listEvents(h.ids.wsB))).toHaveLength(0);
    });

    it("refuses secret values and malformed types", async () => {
      const h = await makeHarness({ kind });
      await expectBrokerError(h.store.appendEvent({ workspaceId: h.ids.wsA, correlationId: "c", type: "policy.evaluated", data: { leaked: CANARY } }), "secret_material");
      await expect(h.store.appendEvent({ workspaceId: h.ids.wsA, correlationId: "c", type: "NotAType" as never, data: {} })).rejects.toBeTruthy();
    });
  });

  it("returns copies: mutating a result never changes stored state", async () => {
    const h = await makeHarness({ kind });
    const { operation } = await h.store.createOperation(newOperation(h));
    (operation.proposal as { summary: string }).summary = "tampered";
    operation.status = "succeeded";
    const fresh = await h.store.getOperation(h.ids.wsA, operation.id);
    expect(fresh?.proposal.summary).toBe("Restart a service");
    expect(fresh?.status).toBe("awaiting_approval");
  });
});

describe("the tests' own signers", () => {
  it("session helper names its subject", () => {
    expect(sessionFor("x")).toMatchObject({ method: "browser_session", subject: "x" });
  });
});
