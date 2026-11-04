/**
 * Execution-ledger contracts against real PGlite transactions, and PostgreSQL
 * when ZENITH_TEST_PLATFORM_PG_URL is configured. PGlite races are serialized
 * promises; the PG lane uses independent connections. Event failures below
 * are injected faults over the real database, not a mocked storage engine.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as repos from "@/lib/controlplane/db/repos";
import { decide } from "@/lib/controlplane/approvals";
import { cancelRunningOperation, claimOperation, completeOperation, denyOperation, setPlanDigest, setPolicyDecision, suspendForApproval } from "@/lib/controlplane/operations";
import { LeaseLostError, TERMINAL_OPERATION_STATUSES, type OperationRecord, type Sql } from "@/lib/controlplane/types";
import { LANES, backdate, expectCode, newWorkspace, openLane, seedApprovedOperation, seedAwaitingApproval, uid, user } from "./_support/harness";

const PLAN = "c".repeat(64);
const VERSION = "a".repeat(64);
const eventFailure = new Error("injected event write failure");

function failEvents(sql: Sql): Sql {
  return {
    query: (text, params) => {
      if (/insert into platform\.events/.test(text)) throw eventFailure;
      return sql.query(text, params);
    },
    tx: (fn) => sql.tx((tx) => fn(failEvents(tx))),
  };
}

describe.each(LANES)("execution ledger [$name]", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => { ctx = await openLane(lane); }, 60_000);
  afterAll(async () => { await ctx.close(); });
  const db = () => ctx.db;
  const input = (s: { workspaceId: string; operation: OperationRecord }) => ({ workspaceId: s.workspaceId, id: s.operation.id });
  const events = (s: { workspaceId: string; operation: OperationRecord }) => repos.events.list(db(), s.workspaceId, { operationId: s.operation.id });
  const running = async () => {
    const s = await seedApprovedOperation(db());
    await claimOperation(db(), { ...input(s), expectedDigest: s.operation.proposalDigest, holder: "worker" });
    return s;
  };
  const decision = (s: { workspaceId: string; operation: OperationRecord }, outcome: "deny" | "require_approval" = "require_approval") =>
    repos.policyDecisions.insert(db(), { workspaceId: s.workspaceId, operationId: s.operation.id, policyVersion: VERSION, inputDigest: "b".repeat(64), outcome, reasons: [], approval: outcome === "require_approval" ? { count: 2, minRole: "admin", separationOfDuties: true } : undefined });

  it("separates trusted system lookup from uniformly missing foreign tenant reads", async () => {
    const s = await seedApprovedOperation(db());
    expect(await repos.operations.getForSystem(db(), s.operation.id)).toEqual(s.operation);
    expect(await repos.operations.getForSystem(db(), uid("missing"))).toBeNull();
    expect(await repos.operations.get(db(), newWorkspace(), s.operation.id)).toBeNull();
    await expectCode(repos.operations.getForSystem(db(), ""), "invalid_input");
  });

  it("stores a validated plan once, emits once, and cannot stamp terminal or expired operations", async () => {
    const s = await running();
    expect((await setPlanDigest(db(), { ...input(s), planDigest: PLAN }))?.planDigest).toBe(PLAN);
    const first = await repos.operations.get(db(), s.workspaceId, s.operation.id);
    expect(await setPlanDigest(db(), { ...input(s), planDigest: PLAN })).toBeNull();
    expect(await setPlanDigest(db(), { ...input(s), planDigest: "d".repeat(64) })).toBeNull();
    expect(await repos.operations.get(db(), s.workspaceId, s.operation.id)).toEqual(first);
    await expectCode(setPlanDigest(db(), { ...input(s), planDigest: "invalid" }), "invalid_input");
    expect((await events(s)).filter((e) => e.type === "operation.prepared" && e.data.kind === "plan_digest")).toHaveLength(1);
    const expired = await seedApprovedOperation(db());
    await backdate(db(), "operations", "expires_at", expired.operation.id);
    expect(await setPlanDigest(db(), { ...input(expired), planDigest: PLAN })).toBeNull();
    for (const status of TERMINAL_OPERATION_STATUSES) {
      const terminal = await seedApprovedOperation(db());
      await db().query("update platform.operations set status = $3 where workspace_id = $1 and id = $2", [terminal.workspaceId, terminal.operation.id, status]);
      expect(await setPlanDigest(db(), { ...input(terminal), planDigest: PLAN })).toBeNull();
      expect(await setPolicyDecision(db(), { ...input(terminal), decisionId: (await decision(terminal)).id })).toBeNull();
      expect(await suspendForApproval(db(), input(terminal))).toBeNull();
      expect(await cancelRunningOperation(db(), input(terminal))).toBeNull();
      expect(await denyOperation(db(), { ...input(terminal), decisionId: (await decision(terminal, "deny")).id })).toBeNull();
    }
  });

  it("only links the operation's same-tenant policy and freezes requirements after a human reviews", async () => {
    const s = await running();
    const d = await decision(s);
    const unrelated = await decision(await seedApprovedOperation(db(), s.workspaceId));
    expect(await setPolicyDecision(db(), { ...input(s), decisionId: unrelated.id })).toBeNull();
    expect(await setPolicyDecision(db(), { ...input(s), decisionId: uid("missing") })).toBeNull();
    expect((await setPolicyDecision(db(), { ...input(s), decisionId: d.id }))?.policyDecisionId).toBe(d.id);
    expect(await setPolicyDecision(db(), { ...input(s), decisionId: d.id })).toBeNull();
    await suspendForApproval(db(), input(s));
    const replacement = await decision(s);
    expect((await setPolicyDecision(db(), { ...input(s), decisionId: replacement.id }))?.policyDecisionId).toBe(replacement.id);
    await expectCode(decide(db(), { workspaceId: s.workspaceId, operationId: s.operation.id, approver: user(), approverRole: "editor", decision: "approve", proposalDigest: s.operation.proposalDigest, policyVersion: VERSION }), "approver_role_insufficient");
    await expectCode(decide(db(), { workspaceId: s.workspaceId, operationId: s.operation.id, approver: s.requester, approverRole: "admin", decision: "approve", proposalDigest: s.operation.proposalDigest, policyVersion: VERSION }), "separation_of_duties");
    await decide(db(), { workspaceId: s.workspaceId, operationId: s.operation.id, approver: user(), approverRole: "admin", decision: "approve", proposalDigest: s.operation.proposalDigest, policyVersion: VERSION });
    expect(await setPolicyDecision(db(), { ...input(s), decisionId: d.id })).toBeNull();
    expect((await events(s)).filter((e) => e.type === "policy.evaluated" && e.data.kind === "execution_policy_linked")).toHaveLength(2);
  });

  it("refuses foreign and missing targets identically for every new write", async () => {
    const s = await running();
    const d = await decision(s);
    for (const target of [{ workspaceId: newWorkspace(), id: s.operation.id }, { workspaceId: s.workspaceId, id: uid("missing") }]) {
      expect(await setPlanDigest(db(), { ...target, planDigest: PLAN })).toBeNull();
      expect(await setPolicyDecision(db(), { ...target, decisionId: d.id })).toBeNull();
      expect(await suspendForApproval(db(), target)).toBeNull();
      expect(await cancelRunningOperation(db(), target)).toBeNull();
      expect(await denyOperation(db(), { ...target, decisionId: d.id })).toBeNull();
    }
    const foreign = await decision(await running());
    expect(await setPolicyDecision(db(), { ...input(s), decisionId: foreign.id })).toBeNull();
    expect((await repos.operations.get(db(), s.workspaceId, s.operation.id))?.status).toBe("running");
    expect((await events(s)).map((e) => e.type)).toEqual(["operation.proposed", "operation.started"]);
  });

  it("suspends only a live running claim, clears its fence and heartbeat, and revokes grants once", async () => {
    const s = await seedApprovedOperation(db());
    expect(await suspendForApproval(db(), input(s))).toBeNull();
    await expectCode(repos.operations.transition(db(), { ...input(s), from: ["running"], to: "awaiting_approval" }), "invalid_state");
    const scope = `env:${uid("env")}`;
    const lease = (await repos.leases.acquire(db(), { scope, holder: "worker", workspaceId: s.workspaceId, ttlMs: 60_000 }))!;
    await claimOperation(db(), { ...input(s), expectedDigest: s.operation.proposalDigest, holder: "worker", lease });
    const jti = uid("grant");
    await repos.grants.insert(db(), { jti, workspaceId: s.workspaceId, operationId: s.operation.id, capability: "infrastructure.apply", audience: "worker", issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const suspended = await suspendForApproval(db(), { ...input(s), fence: lease });
    expect(suspended).toMatchObject({ status: "awaiting_approval", approvalRequired: true });
    expect(suspended?.leaseScope).toBeUndefined();
    expect(suspended?.fenceToken).toBeUndefined();
    const rows = await db().query("select lease_holder, lease_until, approval_round from platform.operations where workspace_id = $1 and id = $2", [s.workspaceId, s.operation.id]);
    expect(rows).toEqual([{ lease_holder: null, lease_until: null, approval_round: 1 }]);
    expect(await repos.grants.status(db(), s.workspaceId, jti)).toBe("revoked");
    expect(await repos.operations.heartbeat(db(), { ...input(s), holder: "worker" })).toBe(false);
    expect(await suspendForApproval(db(), input(s))).toBeNull();
    expect(await completeOperation(db(), { ...input(s), outcome: "succeeded" })).toBeNull();
    expect((await events(s)).filter((e) => e.type === "operation.prepared" && e.data.kind === "approval_gate")).toHaveLength(1);
    const lapsed = await running();
    await backdate(db(), "operations", "lease_until", lapsed.operation.id);
    expect(await suspendForApproval(db(), input(lapsed))).toBeNull();
    const expired = await running();
    await backdate(db(), "operations", "expires_at", expired.operation.id);
    expect(await suspendForApproval(db(), input(expired))).toBeNull();
  });

  it("fences metadata, suspension and running cancellation against stale/taken-over leases", async () => {
    for (const kind of ["plan", "policy", "suspend", "cancel"] as const) {
      const s = await seedApprovedOperation(db());
      const scope = `env:${uid("env")}`;
      const lease = (await repos.leases.acquire(db(), { scope, holder: "worker", ttlMs: 60_000 }))!;
      await claimOperation(db(), { ...input(s), expectedDigest: s.operation.proposalDigest, holder: "worker", lease });
      const d = await decision(s);
      const write = (fence: { scope: string; fenceToken: number }) => {
        const target = { ...input(s), fence };
        if (kind === "plan") return setPlanDigest(db(), { ...target, planDigest: PLAN });
        if (kind === "policy") return setPolicyDecision(db(), { ...target, decisionId: d.id });
        if (kind === "suspend") return suspendForApproval(db(), target);
        return cancelRunningOperation(db(), target);
      };
      await repos.leases.release(db(), lease);
      await expect(write(lease)).rejects.toBeInstanceOf(LeaseLostError);
      const replacement = (await repos.leases.acquire(db(), { scope, holder: "other", ttlMs: 60_000 }))!;
      expect(await write(replacement)).toBeNull();
      expect((await repos.operations.get(db(), s.workspaceId, s.operation.id))?.status).toBe("running");
    }
  });

  it("atomically cancels a running operation and revokes its grants without manufacturing success", async () => {
    const s = await running();
    const jti = uid("grant");
    await repos.grants.insert(db(), { jti, workspaceId: s.workspaceId, operationId: s.operation.id, capability: "x", audience: "worker", issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const op = await cancelRunningOperation(db(), { ...input(s), reason: "Requested stop" });
    expect(op).toMatchObject({ status: "cancelled", error: "Requested stop" });
    expect(op?.finishedAt).toBeDefined();
    expect(op?.result).toBeUndefined();
    expect(await repos.grants.status(db(), s.workspaceId, jti)).toBe("revoked");
    expect(await cancelRunningOperation(db(), input(s))).toBeNull();
    expect((await events(s)).filter((e) => e.type === "operation.cancelled")).toHaveLength(1);
  });

  it("denies only approved operations using their persisted same-tenant deny decision", async () => {
    const s = await seedApprovedOperation(db());
    expect(await denyOperation(db(), { ...input(s), decisionId: (await decision(s)).id })).toBeNull();
    const unrelated = await decision(await seedApprovedOperation(db(), s.workspaceId), "deny");
    expect(await denyOperation(db(), { ...input(s), decisionId: unrelated.id })).toBeNull();
    const foreign = await decision(await running(), "deny");
    expect(await denyOperation(db(), { ...input(s), decisionId: foreign.id })).toBeNull();
    const d = await decision(s, "deny");
    const denied = await denyOperation(db(), { ...input(s), decisionId: d.id });
    expect(denied).toMatchObject({ status: "denied", policyDecisionId: d.id });
    expect(denied?.finishedAt).toBeDefined();
    expect(await denyOperation(db(), { ...input(s), decisionId: d.id })).toBeNull();
    expect((await events(s)).filter((e) => e.type === "operation.denied")).toHaveLength(1);
    const active = await running();
    expect(await denyOperation(db(), { ...input(active), decisionId: (await decision(active, "deny")).id })).toBeNull();
  });

  it("rolls back every new service write and grant revocation if its event fails", async () => {
    for (const kind of ["plan", "policy", "suspend", "cancel", "deny"] as const) {
      const s = kind === "deny" ? await seedApprovedOperation(db()) : await running();
      const d = await decision(s, kind === "deny" ? "deny" : "require_approval");
      const jti = uid("grant");
      await repos.grants.insert(db(), { jti, workspaceId: s.workspaceId, operationId: s.operation.id, capability: "x", audience: "worker", issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
      const before = await repos.operations.get(db(), s.workspaceId, s.operation.id);
      const broken = failEvents(db());
      const write = kind === "plan" ? setPlanDigest(broken, { ...input(s), planDigest: PLAN })
        : kind === "policy" ? setPolicyDecision(broken, { ...input(s), decisionId: d.id })
        : kind === "suspend" ? suspendForApproval(broken, input(s))
        : kind === "cancel" ? cancelRunningOperation(broken, input(s))
        : denyOperation(broken, { ...input(s), decisionId: d.id });
      await expect(write).rejects.toBe(eventFailure);
      expect(await repos.operations.get(db(), s.workspaceId, s.operation.id)).toEqual(before);
      expect(await repos.grants.status(db(), s.workspaceId, jti)).toBe("active");
      expect((await events(s)).map((e) => e.type)).toEqual(kind === "deny" ? ["operation.proposed"] : ["operation.proposed", "operation.started"]);
    }
  });

  it("racing suspension and approval opens one round and cannot undo a human approval", async () => {
    const s = await running();
    const results = await Promise.allSettled([
      suspendForApproval(ctx.db, input(s)),
      suspendForApproval(ctx.db2, input(s)),
      decide(ctx.db2, { workspaceId: s.workspaceId, operationId: s.operation.id, approver: user(), approverRole: "editor", decision: "approve", proposalDigest: s.operation.proposalDigest, policyVersion: VERSION }),
    ]);
    const suspends = results.slice(0, 2);
    expect(suspends.every((r) => r.status === "fulfilled")).toBe(true);
    expect(suspends.filter((r) => r.status === "fulfilled" && r.value !== null)).toHaveLength(1);
    const approval = results[2];
    if (approval.status === "rejected") {
      expect(approval.reason).toMatchObject({ code: "invalid_state" });
      await decide(db(), { workspaceId: s.workspaceId, operationId: s.operation.id, approver: user(), approverRole: "editor", decision: "approve", proposalDigest: s.operation.proposalDigest, policyVersion: VERSION });
    }
    expect(await suspendForApproval(db(), input(s))).toBeNull();
    expect((await repos.operations.get(db(), s.workspaceId, s.operation.id))?.status).toBe("approved");
    expect((await events(s)).filter((e) => e.type === "operation.prepared" && e.data.kind === "approval_gate")).toHaveLength(1);
  });

  it("racing terminal completion and suspension has exactly one winner", async () => {
    const s = await running();
    const results = await Promise.all([
      suspendForApproval(ctx.db, input(s)),
      completeOperation(ctx.db2, { ...input(s), outcome: "succeeded" }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const writes = (await events(s)).filter((e) => (e.type === "operation.prepared" && e.data.kind === "approval_gate") || e.type === "operation.succeeded");
    expect(writes).toHaveLength(1);
  });

  it("serializes policy linking with partial human decisions without changing requirements after review", async () => {
    const s = await seedAwaitingApproval(db(), { count: 2 });
    const replacement = await repos.policyDecisions.insert(db(), { workspaceId: s.workspaceId, operationId: s.operation.id, policyVersion: VERSION, inputDigest: PLAN, outcome: "require_approval", reasons: [], approval: { count: 1, minRole: "editor", separationOfDuties: false } });
    const [reviewed, linked] = await Promise.all([
      decide(ctx.db, { workspaceId: s.workspaceId, operationId: s.operation.id, approver: user(), approverRole: "admin", decision: "approve", proposalDigest: s.operation.proposalDigest, policyVersion: VERSION }),
      setPolicyDecision(ctx.db2, { ...input(s), decisionId: replacement.id }),
    ]);
    const op = await repos.operations.get(db(), s.workspaceId, s.operation.id);
    if (reviewed.approvals.need === 2) {
      expect(linked).toBeNull();
      expect(op).toMatchObject({ status: "awaiting_approval", policyDecisionId: s.decision.id });
    } else {
      expect(reviewed.approvals).toEqual({ have: 1, need: 1 });
      expect(linked?.policyDecisionId).toBe(replacement.id);
      expect(op).toMatchObject({ status: "approved", policyDecisionId: replacement.id });
    }
  });

  it("running cancel/complete races emit exactly one terminal event", async () => {
    const s = await running();
    const results = await Promise.all([
      cancelRunningOperation(ctx.db, input(s)),
      completeOperation(ctx.db2, { ...input(s), outcome: "succeeded" }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await events(s)).filter((e) => e.type === "operation.cancelled" || e.type === "operation.succeeded")).toHaveLength(1);
  });

  it("racing plan stamps and denial/claim each have exactly one conditional winner", async () => {
    const s = await seedApprovedOperation(db());
    const stamps = await Promise.all([setPlanDigest(ctx.db, { ...input(s), planDigest: PLAN }), setPlanDigest(ctx.db2, { ...input(s), planDigest: "d".repeat(64) })]);
    expect(stamps.filter(Boolean)).toHaveLength(1);
    const d = await decision(s, "deny");
    const race = await Promise.allSettled([
      denyOperation(ctx.db, { ...input(s), decisionId: d.id }),
      claimOperation(ctx.db2, { ...input(s), expectedDigest: s.operation.proposalDigest, holder: "worker" }),
    ]);
    expect(race.filter((r) => r.status === "fulfilled" && r.value !== null)).toHaveLength(1);
    const event = (await events(s)).filter((e) => e.type === "operation.denied" || e.type === "operation.started");
    expect(event).toHaveLength(1);
  });

  it("refuses secret-shaped cancellation text without persisting it", async () => {
    const s = await running();
    await expectCode(cancelRunningOperation(db(), { ...input(s), reason: "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4eHh4eHh4eCJ9.c2lnbmF0dXJlLWJ5dGVz" }), "secret_material");
    expect((await repos.operations.get(db(), s.workspaceId, s.operation.id))?.error).toBeUndefined();
  });

  it("counts only live decisions in the current round, including after consumed proposal approvals", async () => {
    const s = await seedAwaitingApproval(db(), { count: 2 });
    const a = user(); const b = user();
    const review = (approver: ReturnType<typeof user>) => decide(db(), { workspaceId: s.workspaceId, operationId: s.operation.id, approver, approverRole: "editor", decision: "approve", proposalDigest: s.operation.proposalDigest, policyVersion: VERSION });
    const old = await review(a);
    await backdate(db(), "approvals", "expires_at", old.approval.id);
    expect((await review(b)).approvals).toEqual({ have: 1, need: 2 });
    await review(user());
    await claimOperation(db(), { ...input(s), expectedDigest: s.operation.proposalDigest, holder: "worker" });
    await suspendForApproval(db(), input(s));
    expect((await review(a)).approvals).toEqual({ have: 1, need: 2 });
    await expectCode(review(a), "duplicate_decision");
    expect((await review(b)).operation.status).toBe("approved");
    await claimOperation(db(), { ...input(s), expectedDigest: s.operation.proposalDigest, holder: "worker" });
    const approvals = await repos.approvals.listForOperation(db(), s.workspaceId, s.operation.id);
    expect(approvals).toHaveLength(5);
    expect(approvals.filter((row) => row.consumedAt)).toHaveLength(4);
  });
});
