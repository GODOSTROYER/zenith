/**
 * Full approval/claim/apply-ledger journey over the real control store. Cloud
 * mutation is simulated explicitly: this proves durable gates/events/resource
 * bookkeeping, not AWS or OpenTofu execution. The PostgreSQL lane is env-gated.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as repos from "@/lib/controlplane/db/repos";
import { decide } from "@/lib/controlplane/approvals";
import { claimOperation } from "@/lib/controlplane/operations";
import { createPlatformPorts, executionHolder } from "@/lib/execution/platform";
import { StepFailedError } from "@/lib/execution/errors";
import { LANES, openLane, seedAwaitingApproval, user } from "../controlplane/_support/harness";

it("keeps SQL and driver queries inside the control store", () => {
  const source = readFileSync("src/lib/execution/platform.ts", "utf8");
  expect(source).not.toMatch(/\b(?:sql|tx)\s*`/);
  expect(source).not.toMatch(/\.(?:query|exec|unsafe)\s*(?:<[^>]+>)?\s*\(/);
  expect(source).not.toMatch(/(?:select|update|insert|delete)\s+[\s\S]{0,100}\bplatform\./i);
  expect(source).not.toMatch(/OPERATION_COLUMNS|OperationRow|toOperation/);
});

describe.each(LANES)("execution plan approval journey [$name]", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => { ctx = await openLane(lane); }, 60_000);
  afterAll(async () => { await ctx.close(); });

  it("requires a fresh two-human plan approval after consuming proposal approvals, then reclaims and records simulated apply", async () => {
    const db = ctx.db;
    const ports = createPlatformPorts(db);
    const s = await seedAwaitingApproval(db, { count: 2 });
    const { workspaceId, operation: op } = s;
    const a = user(); const b = user();
    const review = (approver: ReturnType<typeof user>, policyVersion: string, planDigest?: string) => decide(db, { workspaceId, operationId: op.id, approver, approverRole: "admin", decision: "approve", proposalDigest: op.proposalDigest, policyVersion, planDigest });
    await review(a, s.decision.policyVersion);
    await review(b, s.decision.policyVersion);
    await claimOperation(db, { workspaceId, id: op.id, expectedDigest: op.proposalDigest, holder: executionHolder(op.id), expectedPolicyVersion: s.decision.policyVersion });
    expect((await repos.approvals.listForOperation(db, workspaceId, op.id)).every((row) => row.consumedAt)).toBe(true);

    const planDigest = "c".repeat(64);
    const planPolicy = await repos.policyDecisions.insert(db, { workspaceId, operationId: op.id, inputDigest: planDigest, policyVersion: "d".repeat(64), outcome: "require_approval", reasons: [], approval: { count: 2, minRole: "admin", separationOfDuties: true } });
    await ports.ops.setPlanDigest({ workspaceId, operationId: op.id, planDigest });
    await ports.ops.setPolicyDecision({ workspaceId, operationId: op.id, decisionId: planPolicy.id });
    expect((await ports.ops.transition({ workspaceId, operationId: op.id, to: "awaiting_approval" }))?.status).toBe("awaiting_approval");
    expect(await ports.ops.heartbeat({ workspaceId, operationId: op.id })).toBe(false);

    await expect(ports.ops.transition({ workspaceId, operationId: op.id, to: "running" })).resolves.toMatchObject({ status: "awaiting_approval" });
    expect((await review(a, planPolicy.policyVersion, planDigest)).approvals).toEqual({ have: 1, need: 2 });
    expect((await ports.ops.transition({ workspaceId, operationId: op.id, to: "running" }))?.status).toBe("awaiting_approval");
    const approved = await review(b, planPolicy.policyVersion, planDigest);
    expect(approved.operation).toMatchObject({ status: "approved", planDigest, policyDecisionId: planPolicy.id });
    expect((await ports.ops.transition({ workspaceId, operationId: op.id, to: "running" }))?.status).toBe("running");
    const approvals = await repos.approvals.listForOperation(db, workspaceId, op.id);
    expect(approvals).toHaveLength(4);
    expect(approvals.every((row) => row.consumedAt)).toBe(true);

    const resource = await ports.resources.upsertDesired({ workspaceId, projectId: op.projectId, environmentId: op.environmentId!, node: {
      address: "object_store/assets", kind: "object_store", provider: "aws", region: "us-east-1", nativeType: "aws:s3_bucket", ownership: "managed", spec: { versioning: true }, origin: [], dependsOn: [], specDigest: "e".repeat(64), labels: {},
    } });
    await ports.events.append({ workspaceId, operationId: op.id, correlationId: op.correlationId, resourceId: resource.id, type: "resource.applying", data: { simulated: true } });
    await ports.resources.setStatus({ workspaceId, resourceId: resource.id, status: "active" });
    await ports.evidence.append({ workspaceId, operationId: op.id, kind: "tofu_apply", digest: planDigest, summary: { fixture: "simulated apply ledger" }, simulated: true });
    await ports.events.append({ workspaceId, operationId: op.id, correlationId: op.correlationId, resourceId: resource.id, type: "resource.applied", data: { simulated: true } });
    expect((await ports.ops.transition({ workspaceId, operationId: op.id, to: "succeeded" }))?.status).toBe("succeeded");
    expect((await ports.resources.get(workspaceId, resource.id))?.status).toBe("active");
    expect((await ports.ops.get(op.id))?.planDigest).toBe(planDigest);
    const events = await repos.events.list(db, workspaceId, { operationId: op.id });
    expect(events.map((e) => e.type)).toEqual([
      "operation.proposed", "policy.evaluated", "operation.approved", "operation.started", "operation.prepared", "policy.evaluated", "operation.prepared", "operation.approved", "operation.started", "resource.applying", "resource.applied", "operation.succeeded",
    ]);
    expect(events.every((event) => event.correlationId === op.correlationId)).toBe(true);
  });

  it("refuses to reclaim plan approvals under a different policy version without consuming them", async () => {
    const db = ctx.db;
    const ports = createPlatformPorts(db);
    const s = await seedAwaitingApproval(db);
    await decide(db, { workspaceId: s.workspaceId, operationId: s.operation.id, approver: user(), approverRole: "editor", decision: "approve", proposalDigest: s.operation.proposalDigest, policyVersion: "z".repeat(64) });
    await expect(ports.ops.transition({ workspaceId: s.workspaceId, operationId: s.operation.id, to: "running" })).rejects.toBeInstanceOf(StepFailedError);
    expect((await repos.approvals.listForOperation(db, s.workspaceId, s.operation.id))[0].consumedAt).toBeUndefined();
    expect((await ports.ops.get(s.operation.id))?.status).toBe("approved");
  });

  it("can suspend after the workflow releases a recorded environment lease, clearing the old fence", async () => {
    const db = ctx.db;
    const ports = createPlatformPorts(db);
    const s = await seedAwaitingApproval(db);
    await decide(db, { workspaceId: s.workspaceId, operationId: s.operation.id, approver: user(), approverRole: "editor", decision: "approve", proposalDigest: s.operation.proposalDigest, policyVersion: s.decision.policyVersion });
    const scope = `env:${s.operation.environmentId}`;
    const lease = (await repos.leases.acquire(db, { scope, workspaceId: s.workspaceId, holder: "worker", ttlMs: 60_000 }))!;
    await claimOperation(db, { workspaceId: s.workspaceId, id: s.operation.id, expectedDigest: s.operation.proposalDigest, holder: executionHolder(s.operation.id), lease });
    await repos.leases.release(db, lease);
    const gate = await ports.ops.transition({ workspaceId: s.workspaceId, operationId: s.operation.id, to: "awaiting_approval" });
    expect(gate).toMatchObject({ status: "awaiting_approval", approvalRequired: true });
    expect(gate?.leaseScope).toBeUndefined();
    expect(gate?.fenceToken).toBeUndefined();
  });

  it("fails the activity if a valid replacement policy is refused after partial human review", async () => {
    const db = ctx.db;
    const ports = createPlatformPorts(db);
    const s = await seedAwaitingApproval(db, { count: 2 });
    await decide(db, { workspaceId: s.workspaceId, operationId: s.operation.id, approver: user(), approverRole: "editor", decision: "approve", proposalDigest: s.operation.proposalDigest, policyVersion: s.decision.policyVersion });
    const replacement = await repos.policyDecisions.insert(db, { workspaceId: s.workspaceId, operationId: s.operation.id, policyVersion: s.decision.policyVersion, inputDigest: "d".repeat(64), outcome: "require_approval", reasons: [], approval: { count: 3, minRole: "admin", separationOfDuties: true } });
    await expect(ports.ops.setPolicyDecision({ workspaceId: s.workspaceId, operationId: s.operation.id, decisionId: replacement.id })).rejects.toBeInstanceOf(StepFailedError);
    expect((await ports.ops.get(s.operation.id))?.policyDecisionId).toBe(s.decision.id);
    expect((await ports.ops.get(s.operation.id))?.status).toBe("awaiting_approval");
    await expect(ports.ops.setPolicyDecision({ workspaceId: s.workspaceId, operationId: s.operation.id, decisionId: s.decision.id })).resolves.toBeUndefined();
  });
});
