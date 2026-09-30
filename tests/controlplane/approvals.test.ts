/**
 * Approvals: human-only, digest-bound, role/SoD checked, single decision per
 * approver, expiring, single-use — and the events the service appends.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as repos from "@/lib/controlplane/db/repos";
import type { Principal } from "@/lib/controlplane/types";
import { decide } from "@/lib/controlplane/approvals";
import { LANES, agent, approve, backdate, expectCode, newWorkspace, openLane, seedApprovedOperation, seedAwaitingApproval, uid, user } from "./_support/harness";

describe.each(LANES)("approvals [$name]", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => {
    ctx = await openLane(lane);
  }, 60_000);
  afterAll(async () => {
    await ctx.close();
  });
  const db = () => ctx.db;

  const record = (seeded: { workspaceId: string; operation: { id: string; proposalDigest: string } }, approver: Principal, over: Partial<Parameters<typeof repos.approvals.record>[1]> = {}) =>
    repos.approvals.record(db(), {
      workspaceId: seeded.workspaceId,
      operationId: seeded.operation.id,
      approver,
      approverRole: "editor",
      decision: "approve",
      proposalDigest: seeded.operation.proposalDigest,
      policyVersion: "a".repeat(64),
      ...over,
    });

  it("only a human user can decide: agents, integrations, runners, systems — even 'on behalf of' a human — are refused", async () => {
    const seeded = await seedAwaitingApproval(db());
    const humanId = uid("user");
    const impostors: Principal[] = [
      agent(humanId),
      { kind: "integration", id: "int_1", name: "Codex" },
      { kind: "navigator", id: "nav", name: "Navigator", onBehalfOf: humanId },
      { kind: "system", id: "system", name: "Zenith" },
      { kind: "runner", id: "run_1", name: "runner" },
      { kind: "machine", id: "mac_1", name: "zenithd" },
      // a "user" that smuggles an integration link is still not a plain human decision
      { kind: "user", id: humanId, name: "Mallory", onBehalfOf: humanId },
      { kind: "user", id: humanId, name: "Mallory", integrationId: "int_1" },
    ];
    for (const who of impostors) await expectCode(record(seeded, who), "approver_not_human");
    // nothing was recorded and the operation still waits
    expect(await repos.approvals.listForOperation(db(), seeded.workspaceId, seeded.operation.id)).toEqual([]);
    expect((await repos.operations.get(db(), seeded.workspaceId, seeded.operation.id))?.status).toBe("awaiting_approval");
    // a real user then can
    expect((await record(seeded, user())).operation.status).toBe("approved");
  });

  it("refuses a digest that differs from the operation's proposal digest", async () => {
    const seeded = await seedAwaitingApproval(db());
    await expectCode(record(seeded, user(), { proposalDigest: "0".repeat(64) }), "digest_mismatch");
    await expectCode(record(seeded, user(), { proposalDigest: "short" }), "invalid_input");
    expect((await repos.operations.get(db(), seeded.workspaceId, seeded.operation.id))?.status).toBe("awaiting_approval");
    expect(await repos.approvals.listForOperation(db(), seeded.workspaceId, seeded.operation.id)).toEqual([]);
  });

  it("records an approve, moving awaiting_approval to approved in the same transaction", async () => {
    const seeded = await seedAwaitingApproval(db());
    const result = await record(seeded, user("u-approver"), { reason: "looks right" });
    expect(result.operation.status).toBe("approved");
    expect(result.approval).toMatchObject({ decision: "approve", approverRole: "editor", reason: "looks right", operationId: seeded.operation.id });
    expect(result.approval.approver).toEqual({ kind: "user", id: "u-approver", name: "Alice Admin" });
    expect(result.approval.consumedAt).toBeUndefined();
    expect(Date.parse(result.approval.expiresAt)).toBeLessThanOrEqual(Date.parse(seeded.operation.expiresAt));
  });

  it("a reject is immediate and terminal, and cannot be followed by an approve", async () => {
    const seeded = await seedAwaitingApproval(db());
    const rejected = await record(seeded, user("u1"), { decision: "reject", reason: "not now" });
    expect(rejected.operation.status).toBe("rejected");
    expect(rejected.operation.finishedAt).toBeDefined();
    await expectCode(record(seeded, user("u2")), "invalid_state");
  });

  it("only operations awaiting approval, in this workspace, and unexpired can be decided", async () => {
    const approved = await seedApprovedOperation(db());
    await expectCode(record(approved, user()), "invalid_state");
    const seeded = await seedAwaitingApproval(db());
    await expectCode(
      repos.approvals.record(db(), { workspaceId: newWorkspace(), operationId: seeded.operation.id, approver: user(), approverRole: "editor", decision: "approve", proposalDigest: seeded.operation.proposalDigest, policyVersion: "a".repeat(64) }),
      "operation_not_found"
    );
    await backdate(db(), "operations", "expires_at", seeded.operation.id);
    await expectCode(record(seeded, user()), "operation_expired");
  });

  it("roles: a viewer can never decide; the policy's minimum role is enforced", async () => {
    const seeded = await seedAwaitingApproval(db(), { minRole: "admin" });
    await expectCode(record(seeded, user(), { approverRole: "viewer" }), "approver_role_insufficient");
    await expectCode(record(seeded, user(), { approverRole: "editor" }), "approver_role_insufficient");
    expect((await record(seeded, user(), { approverRole: "admin" })).operation.status).toBe("approved");
  });

  it("separation of duties: the requester cannot approve their own operation, but another user can", async () => {
    const requester = user("requester-1");
    const seeded = await seedAwaitingApproval(db(), { requester, separationOfDuties: true });
    await expectCode(record(seeded, requester), "separation_of_duties");
    // an agent acting on behalf of the requester is the requester for this rule
    const delegated = await seedAwaitingApproval(db(), { requester: agent("requester-2"), separationOfDuties: true });
    await expectCode(record(delegated, user("requester-2")), "separation_of_duties");
    expect((await record(seeded, user("someone-else"))).operation.status).toBe("approved");
  });

  it("without a separation-of-duties requirement the requester may approve (autonomy rules, not the store, restrict it)", async () => {
    const requester = user("requester-3");
    const seeded = await seedAwaitingApproval(db(), { requester, separationOfDuties: false });
    expect((await record(seeded, requester)).operation.status).toBe("approved");
  });

  it("one decision per approver per operation; two required approvers must be distinct", async () => {
    const seeded = await seedAwaitingApproval(db(), { count: 2 });
    const a = user("approver-a");
    const first = await record(seeded, a);
    expect(first.operation.status).toBe("awaiting_approval");
    expect(first.approvals).toEqual({ have: 1, need: 2 });
    await expectCode(record(seeded, a), "duplicate_decision");
    await expectCode(record(seeded, a, { decision: "reject" }), "duplicate_decision");
    expect((await record(seeded, user("approver-b"))).operation.status).toBe("approved");
  });

  it("racing approvals of a two-approver operation both count and approve it exactly once", async () => {
    const seeded = await seedAwaitingApproval(db(), { count: 2 });
    const results = await Promise.all([
      repos.approvals.record(ctx.db, { workspaceId: seeded.workspaceId, operationId: seeded.operation.id, approver: user("r1"), approverRole: "editor", decision: "approve", proposalDigest: seeded.operation.proposalDigest, policyVersion: "a".repeat(64) }),
      repos.approvals.record(ctx.db2, { workspaceId: seeded.workspaceId, operationId: seeded.operation.id, approver: user("r2"), approverRole: "editor", decision: "approve", proposalDigest: seeded.operation.proposalDigest, policyVersion: "a".repeat(64) }),
    ]);
    expect(results.filter((r) => r.operation.status === "approved")).toHaveLength(1);
    expect((await repos.operations.get(db(), seeded.workspaceId, seeded.operation.id))?.status).toBe("approved");
    expect(await repos.approvals.listForOperation(db(), seeded.workspaceId, seeded.operation.id)).toHaveLength(2);
  });

  it("consume is single-use: the first call takes the approval, the second gets nothing", async () => {
    const seeded = await seedAwaitingApproval(db());
    const decided = await approve(db(), seeded);
    const input = { workspaceId: seeded.workspaceId, operationId: seeded.operation.id, proposalDigest: seeded.operation.proposalDigest };
    expect(await repos.approvals.consume(db(), input)).toEqual([decided.approval.id]);
    expect(await repos.approvals.consume(db(), input)).toEqual([]);
    // a different digest, or another workspace, never matches
    expect(await repos.approvals.consume(db(), { ...input, proposalDigest: "1".repeat(64) })).toEqual([]);
    expect(await repos.approvals.consume(db(), { ...input, workspaceId: newWorkspace() })).toEqual([]);
    // an expired approval cannot be consumed
    const other = await seedAwaitingApproval(db());
    const d2 = await approve(db(), other);
    await backdate(db(), "approvals", "expires_at", d2.approval.id);
    expect(await repos.approvals.consume(db(), { workspaceId: other.workspaceId, operationId: other.operation.id, proposalDigest: other.operation.proposalDigest })).toEqual([]);
  });

  it("concurrent consumers: exactly one gets the approval", async () => {
    const seeded = await seedAwaitingApproval(db());
    await approve(db(), seeded);
    const input = { workspaceId: seeded.workspaceId, operationId: seeded.operation.id, proposalDigest: seeded.operation.proposalDigest };
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? ctx.db : ctx.db2).tx((tx) => repos.approvals.consume(tx, input))));
    expect(results.flat()).toHaveLength(1);
  });

  it("listForOperation is workspace scoped", async () => {
    const seeded = await seedAwaitingApproval(db());
    await approve(db(), seeded);
    expect(await repos.approvals.listForOperation(db(), seeded.workspaceId, seeded.operation.id)).toHaveLength(1);
    expect(await repos.approvals.listForOperation(db(), newWorkspace(), seeded.operation.id)).toEqual([]);
  });

  it("the service appends operation.approved / operation.rejected once the decision moves the operation", async () => {
    const seeded = await seedAwaitingApproval(db(), { count: 2 });
    const input = (id: string) => ({
      workspaceId: seeded.workspaceId,
      operationId: seeded.operation.id,
      approver: user(id),
      approverRole: "editor" as const,
      decision: "approve" as const,
      proposalDigest: seeded.operation.proposalDigest,
      policyVersion: "a".repeat(64),
    });
    await decide(db(), input("s1"));
    let types = (await repos.events.list(db(), seeded.workspaceId, { operationId: seeded.operation.id })).map((e) => e.type);
    expect(types).not.toContain("operation.approved"); // partial set: nothing yet
    await decide(db(), input("s2"));
    types = (await repos.events.list(db(), seeded.workspaceId, { operationId: seeded.operation.id })).map((e) => e.type);
    expect(types).toContain("operation.approved");

    const rejectedSeed = await seedAwaitingApproval(db());
    await decide(db(), { ...input("s3"), workspaceId: rejectedSeed.workspaceId, operationId: rejectedSeed.operation.id, proposalDigest: rejectedSeed.operation.proposalDigest, decision: "reject" });
    const rejectedTypes = (await repos.events.list(db(), rejectedSeed.workspaceId, { operationId: rejectedSeed.operation.id })).map((e) => e.type);
    expect(rejectedTypes).toContain("operation.rejected");
  });

  it("a failing decision leaves neither the approval nor the event behind", async () => {
    const seeded = await seedAwaitingApproval(db());
    await expectCode(decide(db(), { workspaceId: seeded.workspaceId, operationId: seeded.operation.id, approver: agent(), approverRole: "editor", decision: "approve", proposalDigest: seeded.operation.proposalDigest, policyVersion: "a".repeat(64) }), "approver_not_human");
    const types = (await repos.events.list(db(), seeded.workspaceId, { operationId: seeded.operation.id })).map((e) => e.type);
    expect(types).not.toContain("operation.approved");
  });
});
