/**
 * The platform-store ports over the REAL control store (PGlite): the mapping of
 * the workflow's statuses onto the operations ledger, leases and fences, event
 * and evidence idempotency, resources/observations/drift, connections.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import * as repos from "@/lib/controlplane/db/repos";
import { LeaseLostError, type OperationRecord } from "@/lib/controlplane/types";
import { StepFailedError } from "@/lib/execution/errors";
import { createPlatformPorts, executionHolder, type PlatformPorts } from "@/lib/execution/platform";
import type { ResourceNode } from "@/lib/resources/types";
import type { ConnectionConfig } from "@/lib/credentials/types";
import { backdate, newWorkspace, proposalFor, uid, user } from "../controlplane/_support/harness";
import { proposeOperation } from "@/lib/controlplane/operations";
import { connectionConfig } from "./fakes/fixtures";

let db: PlatformDbHandle;
let ports: PlatformPorts;

beforeAll(async () => {
  db = await openPlatformDb({ kind: "pglite" });
  ports = createPlatformPorts(db);
}, 60_000);
afterAll(async () => {
  await db.close();
});

/** An operation of a fresh workspace in the given starting status. */
async function seed(status: "approved" | "proposed" | "awaiting_approval" = "approved", over: Parameters<typeof proposalFor>[1] = {}): Promise<{ ws: string; op: OperationRecord }> {
  const ws = newWorkspace();
  const { operation } = await proposeOperation(db, { workspaceId: ws, principal: user(), proposal: proposalFor(ws, over), status: status === "awaiting_approval" ? "awaiting_approval" : status });
  return { ws, op: operation };
}

const status = async (ws: string, id: string) => (await repos.operations.get(db, ws, id))!.status;
const eventTypes = async (ws: string, id: string) => (await repos.events.list(db, ws, { operationId: id })).map((e) => e.type);

describe("operations port", () => {
  it("looks an operation up by id alone and returns null for an unknown id", async () => {
    const { op } = await seed();
    expect((await ports.ops.get(op.id))?.id).toBe(op.id);
    expect(await ports.ops.get("op_does_not_exist")).toBeNull();
  });

  it("claims an approved operation when the workflow marks it running, with the stable execution holder, and is idempotent", async () => {
    const { ws, op } = await seed();
    const running = await ports.ops.transition({ workspaceId: ws, operationId: op.id, to: "running" });
    expect(running?.status).toBe("running");
    expect(await eventTypes(ws, op.id)).toContain("operation.started");
    const again = await ports.ops.transition({ workspaceId: ws, operationId: op.id, to: "running" });
    expect(again?.status).toBe("running");
    expect((await eventTypes(ws, op.id)).filter((t) => t === "operation.started")).toHaveLength(1);
    const row = await db.query<{ lease_holder: string }>("select lease_holder from platform.operations where id = $1", [op.id]);
    expect(row[0].lease_holder).toBe(executionHolder(op.id));
  });

  it("extends the execution lease from any worker, and stops once the operation is no longer running", async () => {
    const { ws, op } = await seed();
    expect(await ports.ops.heartbeat({ workspaceId: ws, operationId: op.id })).toBe(false); // not running yet
    await ports.ops.transition({ workspaceId: ws, operationId: op.id, to: "running" });
    expect(await ports.ops.heartbeat({ workspaceId: ws, operationId: op.id })).toBe(true);
    expect(await ports.ops.heartbeat({ workspaceId: newWorkspace(), operationId: op.id })).toBe(false); // wrong tenant
    await ports.ops.transition({ workspaceId: ws, operationId: op.id, to: "succeeded" });
    expect(await ports.ops.heartbeat({ workspaceId: ws, operationId: op.id })).toBe(false);
  });

  it("ends a running operation succeeded or failed with the event and the error, and treats terminal as terminal", async () => {
    const a = await seed();
    await ports.ops.transition({ workspaceId: a.ws, operationId: a.op.id, to: "running" });
    const ok = await ports.ops.transition({ workspaceId: a.ws, operationId: a.op.id, to: "succeeded" });
    expect(ok?.status).toBe("succeeded");
    expect(await eventTypes(a.ws, a.op.id)).toContain("operation.succeeded");
    const late = await ports.ops.transition({ workspaceId: a.ws, operationId: a.op.id, to: "failed", error: "too late" });
    expect(late?.status).toBe("succeeded"); // the ledger keeps what it has

    const b = await seed();
    await ports.ops.transition({ workspaceId: b.ws, operationId: b.op.id, to: "running" });
    const failed = await ports.ops.transition({ workspaceId: b.ws, operationId: b.op.id, to: "failed", error: "apply failed (partial apply; reconcile will observe)" });
    expect(failed).toMatchObject({ status: "failed", error: expect.stringContaining("partial apply") });
  });

  it("marks uncertain with the event, only from running", async () => {
    const { ws, op } = await seed();
    expect((await ports.ops.markUncertain({ workspaceId: ws, operationId: op.id, reason: "lease lost" }))?.status).toBe("approved"); // not running: untouched
    await ports.ops.transition({ workspaceId: ws, operationId: op.id, to: "running" });
    const marked = await ports.ops.markUncertain({ workspaceId: ws, operationId: op.id, reason: "lease lost" });
    expect(marked).toMatchObject({ status: "uncertain", error: "lease lost" });
    expect(await eventTypes(ws, op.id)).toContain("operation.uncertain");
    expect((await ports.ops.markUncertain({ workspaceId: ws, operationId: op.id, reason: "again" }))?.status).toBe("uncertain");
    expect((await eventTypes(ws, op.id)).filter((t) => t === "operation.uncertain")).toHaveLength(1);
  });

  it("supports the plan-level approval round trip: running → awaiting_approval → (human approves) → approved → running, consuming that approval", async () => {
    const { ws, op } = await seed();
    await ports.ops.transition({ workspaceId: ws, operationId: op.id, to: "running" });
    const suspended = await ports.ops.transition({ workspaceId: ws, operationId: op.id, to: "awaiting_approval" });
    expect(suspended).toMatchObject({ status: "awaiting_approval", approvalRequired: true });
    const claim = await db.query<{ lease_holder: string | null }>("select lease_holder from platform.operations where id = $1", [op.id]);
    expect(claim[0].lease_holder).toBeNull(); // the execution claim was released

    // while suspended it cannot be heartbeated or completed
    expect(await ports.ops.heartbeat({ workspaceId: ws, operationId: op.id })).toBe(false);

    const decided = await repos.approvals.record(db, { workspaceId: ws, operationId: op.id, approver: user(uid("approver")), approverRole: "editor", decision: "approve", proposalDigest: op.proposalDigest, policyVersion: "a".repeat(64) });
    expect(decided.operation.status).toBe("approved");

    const resumed = await ports.ops.transition({ workspaceId: ws, operationId: op.id, to: "running" });
    expect(resumed?.status).toBe("running");
    const approvals = await repos.approvals.listForOperation(db, ws, op.id);
    expect(approvals).toHaveLength(1);
    expect(approvals[0].consumedAt).toBeTruthy(); // single use
  });

  it("cannot be talked into suspending an operation that is not running", async () => {
    const { ws, op } = await seed();
    const unchanged = await ports.ops.transition({ workspaceId: ws, operationId: op.id, to: "awaiting_approval" });
    expect(unchanged?.status).toBe("approved");
    expect(unchanged?.approvalRequired).toBe(false);
  });

  it("cancels pre-execution and running operations, including after changes began, without claiming rollback", async () => {
    const pre = await seed();
    expect((await ports.ops.transition({ workspaceId: pre.ws, operationId: pre.op.id, to: "cancelled", error: "user cancelled" }))?.status).toBe("cancelled");
    expect(await eventTypes(pre.ws, pre.op.id)).toContain("operation.cancelled");

    const clean = await seed();
    await ports.ops.transition({ workspaceId: clean.ws, operationId: clean.op.id, to: "running" });
    const cancelled = await ports.ops.transition({ workspaceId: clean.ws, operationId: clean.op.id, to: "cancelled", error: "Cancelled by request." });
    expect(cancelled).toMatchObject({ status: "cancelled", error: "Cancelled by request." });

    const acted = await seed();
    await ports.ops.transition({ workspaceId: acted.ws, operationId: acted.op.id, to: "running" });
    await repos.events.append(db, { type: "resource.applying", workspaceId: acted.ws, operationId: acted.op.id, correlationId: acted.op.correlationId, data: {} });
    const stopped = await ports.ops.transition({ workspaceId: acted.ws, operationId: acted.op.id, to: "cancelled", error: "Cancelled by request. Steps that change the environment had started." });
    expect(stopped?.status).toBe("cancelled");
    expect(await eventTypes(acted.ws, acted.op.id)).toContain("operation.cancelled");
  });

  it("expires an operation whose approval never came", async () => {
    const { ws, op } = await seed("awaiting_approval");
    const expired = await ports.ops.transition({ workspaceId: ws, operationId: op.id, to: "expired", error: "No approval in 24 h." });
    expect(expired?.status).toBe("expired");
    expect(await eventTypes(ws, op.id)).toContain("operation.cancelled");
  });

  it("turns a definitive claim refusal into a clean failure and a missing operation into null", async () => {
    const { ws, op } = await seed();
    await backdate(db, "operations", "expires_at", op.id);
    await expect(ports.ops.transition({ workspaceId: ws, operationId: op.id, to: "running" })).rejects.toBeInstanceOf(StepFailedError);
    expect(await ports.ops.transition({ workspaceId: ws, operationId: "op_nope", to: "running" })).toBeNull();
  });

  it("never lets another workspace move, uncertain or stamp an operation", async () => {
    const { ws, op } = await seed();
    const other = newWorkspace();
    expect(await ports.ops.transition({ workspaceId: other, operationId: op.id, to: "running" })).toBeNull();
    expect(await ports.ops.markUncertain({ workspaceId: other, operationId: op.id, reason: "x" })).toBeNull();
    await ports.ops.setPlanDigest({ workspaceId: other, operationId: op.id, planDigest: "c".repeat(64) });
    expect((await repos.operations.get(db, ws, op.id))?.planDigest).toBeUndefined();
    expect(await status(ws, op.id)).toBe("approved");
  });

  it("records the plan digest once, and refuses a malformed one", async () => {
    const { ws, op } = await seed();
    await ports.ops.setPlanDigest({ workspaceId: ws, operationId: op.id, planDigest: "c".repeat(64) });
    await expect(ports.ops.setPlanDigest({ workspaceId: ws, operationId: op.id, planDigest: "d".repeat(64) })).rejects.toThrow("plan_changed");
    expect((await repos.operations.get(db, ws, op.id))?.planDigest).toBe("c".repeat(64));
    await expect(ports.ops.setPlanDigest({ workspaceId: ws, operationId: op.id, planDigest: "../etc" })).rejects.toBeInstanceOf(StepFailedError);
  });

  it("links a policy decision of the same workspace to a running operation, and ignores a foreign or unknown one", async () => {
    const { ws, op } = await seed();
    const decision = await repos.policyDecisions.insert(db, { workspaceId: ws, operationId: op.id, policyVersion: "a".repeat(64), inputDigest: "b".repeat(64), outcome: "require_approval", reasons: [{ code: "prod", message: "m" }], approval: { count: 2, minRole: "admin", separationOfDuties: true } });
    await ports.ops.setPolicyDecision({ workspaceId: ws, operationId: op.id, decisionId: decision.id }); // approved, not running: ignored
    expect((await repos.operations.get(db, ws, op.id))?.policyDecisionId).toBeUndefined();
    await ports.ops.transition({ workspaceId: ws, operationId: op.id, to: "running" });
    await ports.ops.setPolicyDecision({ workspaceId: ws, operationId: op.id, decisionId: "pol_unknown" });
    expect((await repos.operations.get(db, ws, op.id))?.policyDecisionId).toBeUndefined();
    await ports.ops.setPolicyDecision({ workspaceId: ws, operationId: op.id, decisionId: decision.id });
    expect((await repos.operations.get(db, ws, op.id))?.policyDecisionId).toBe(decision.id);
  });
});

describe("leases port", () => {
  it("acquires, refuses a second holder, renews, asserts the fence and releases", async () => {
    const scope = `env:${uid("env")}`;
    const lease = (await ports.leases.acquire({ scope, holder: "worker:a:op1", ttlMs: 30_000, workspaceId: newWorkspace() }))!;
    expect(lease.fenceToken).toBe(1);
    expect(await ports.leases.acquire({ scope, holder: "worker:b:op2", ttlMs: 30_000 })).toBeNull();
    expect(await ports.leases.renew(lease, 30_000)).toMatchObject({ fenceToken: 1 });
    await expect(ports.leases.assertFence(scope, 1)).resolves.toBeUndefined();
    expect(await ports.leases.release(lease)).toBe(true);
    expect(await ports.leases.release(lease)).toBe(false);
    await expect(ports.leases.assertFence(scope, 1)).rejects.toBeInstanceOf(LeaseLostError);
    const next = await ports.leases.acquire({ scope, holder: "worker:b:op2", ttlMs: 30_000 });
    expect(next?.fenceToken).toBe(2); // strictly increasing: the old fence is dead for good
    await expect(ports.leases.assertFence(scope, 1)).rejects.toBeInstanceOf(LeaseLostError);
  });

  it("reports a taken-over lease as lost on renewal", async () => {
    const scope = `env:${uid("env")}`;
    const mine = (await ports.leases.acquire({ scope, holder: "worker:a:op1", ttlMs: 30_000 }))!;
    await backdate(db, "leases", "expires_at", scope, "scope");
    await ports.leases.acquire({ scope, holder: "worker:b:op2", ttlMs: 30_000 });
    expect(await ports.leases.renew(mine, 30_000)).toBeNull();
  });
});

describe("events and evidence ports", () => {
  it("appends an event with a deterministic id once", async () => {
    const ws = newWorkspace();
    const event = { id: "evt_fixed_1", type: "resource.planned" as const, workspaceId: ws, correlationId: "corr-1", environmentId: "env-1", data: { n: 1 } };
    await ports.events.append(event);
    await ports.events.append(event);
    expect(await repos.events.list(db, ws)).toHaveLength(1);
  });

  it("refuses secret-shaped material in an event instead of storing it", async () => {
    const ws = newWorkspace();
    await expect(ports.events.append({ type: "resource.planned", workspaceId: ws, correlationId: "c", data: { note: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" } })).rejects.toMatchObject({ code: "secret_material" });
  });

  it("returns the existing evidence row for a repeated id (insert-or-return) and finds the newest by operation, kind and digest", async () => {
    const { ws, op } = await seed();
    const first = await ports.evidence.append({ id: "evd_fixed_1", workspaceId: ws, operationId: op.id, kind: "tofu_plan", digest: "a".repeat(64), summary: { n: 1 }, simulated: false });
    const again = await ports.evidence.append({ id: "evd_fixed_1", workspaceId: ws, operationId: op.id, kind: "tofu_plan", digest: "a".repeat(64), summary: { n: 2 }, simulated: false });
    expect(again.id).toBe(first.id);
    expect(again.summary).toEqual({ n: 1 });
    await ports.evidence.append({ id: "evd_fixed_2", workspaceId: ws, operationId: op.id, kind: "tofu_plan", digest: "b".repeat(64), summary: { n: 3 }, simulated: false });
    expect((await ports.evidence.find({ workspaceId: ws, operationId: op.id, kind: "tofu_plan", digest: "a".repeat(64) }))?.id).toBe("evd_fixed_1");
    expect((await ports.evidence.find({ workspaceId: ws, operationId: op.id, kind: "tofu_plan" }))?.id).toBe("evd_fixed_2");
    expect(await ports.evidence.find({ workspaceId: ws, operationId: op.id, kind: "build" })).toBeNull();
    expect(await ports.evidence.find({ workspaceId: newWorkspace(), operationId: op.id, kind: "tofu_plan" })).toBeNull();
  });

  it("refuses a malformed digest and secret-shaped summaries", async () => {
    const { ws, op } = await seed();
    await expect(ports.evidence.append({ workspaceId: ws, operationId: op.id, kind: "tofu_plan", digest: "short", summary: {}, simulated: false })).rejects.toBeTruthy();
    await expect(ports.evidence.append({ workspaceId: ws, operationId: op.id, kind: "http_probe", digest: "a".repeat(64), summary: { token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk" }, simulated: false })).rejects.toMatchObject({ code: "secret_material" });
  });
});

describe("resources port", () => {
  const node = (over: Partial<ResourceNode> = {}): ResourceNode => ({
    address: "object_store/assets",
    kind: "object_store",
    provider: "aws",
    region: "us-east-1",
    nativeType: "aws:s3_bucket",
    ownership: "managed",
    spec: { versioning: true },
    origin: ["res-assets"],
    dependsOn: [],
    specDigest: "e".repeat(64),
    labels: {},
    ...over,
  });

  it("upserts desired nodes, lists them workspace-scoped, tracks status, and refuses an ownership change", async () => {
    const ws = newWorkspace();
    const env = uid("env");
    const row = await ports.resources.upsertDesired({ workspaceId: ws, projectId: "p", environmentId: env, node: node(), revisionId: "rev-1" });
    expect(row).toMatchObject({ address: "object_store/assets", status: "planned", revisionId: "rev-1" });
    const again = await ports.resources.upsertDesired({ workspaceId: ws, projectId: "p", environmentId: env, node: node({ specDigest: "f".repeat(64) }) });
    expect(again.id).toBe(row.id);
    await ports.resources.setStatus({ workspaceId: ws, resourceId: row.id, status: "active" });
    expect((await ports.resources.list(ws, env)).map((r) => [r.address, r.status])).toEqual([["object_store/assets", "active"]]);
    expect(await ports.resources.list(newWorkspace(), env)).toEqual([]);
    expect(await ports.resources.get(newWorkspace(), row.id)).toBeNull();
    await expect(ports.resources.upsertDesired({ workspaceId: ws, environmentId: env, node: node({ ownership: "referenced" }) })).rejects.toMatchObject({ code: "conflict" });
    await expect(ports.resources.upsertDesired({ workspaceId: newWorkspace(), environmentId: env, node: node() })).rejects.toMatchObject({ code: "tenant_mismatch" });
  });

  it("stores observations and runtime state and a drift report with the previous one retrievable", async () => {
    const ws = newWorkspace();
    const env = uid("env");
    const row = await ports.resources.upsertDesired({ workspaceId: ws, environmentId: env, node: node() });
    await ports.resources.appendObservation({ workspaceId: ws, resourceId: row.id, observation: { address: row.address, presence: "present", attributes: { versioning: { state: "known", value: true, observedAt: "2026-09-30T12:00:00.000Z" } }, observedAt: "2026-09-30T12:00:00.000Z", source: "test@1", simulated: false } });
    await ports.resources.upsertRuntime({ workspaceId: ws, resourceId: row.id, runtime: { address: row.address, health: "healthy", counts: {}, signals: [], observedAt: "2026-09-30T12:00:00.000Z", source: "test@1", simulated: false } });
    expect((await repos.observations.latestObservation(db, ws, row.id))?.presence).toBe("present");
    expect((await repos.observations.getRuntime(db, ws, row.id))?.health).toBe("healthy");
    await expect(ports.resources.appendObservation({ workspaceId: newWorkspace(), resourceId: row.id, observation: { address: row.address, presence: "present", attributes: {}, observedAt: "2026-09-30T12:00:00.000Z", source: "x", simulated: false } })).rejects.toMatchObject({ code: "not_found" });

    expect(await ports.resources.latestDriftReport(ws, env)).toBeNull();
    await ports.resources.saveDriftReport({ workspaceId: ws, report: { environmentId: env, graphDigest: "g".repeat(16), computedAt: "2026-09-30T12:00:00.000Z", findings: [], unobserved: [], simulated: false } });
    expect((await ports.resources.latestDriftReport(ws, env))?.graphDigest).toBe("g".repeat(16));
    expect(await ports.resources.latestDriftReport(newWorkspace(), env)).toBeNull();
  });
});

describe("connections port", () => {
  const make = (ws: string, legacy?: string, config: ConnectionConfig = connectionConfig) => repos.connections.create(db, { workspaceId: ws, config, createdBy: "u", legacyConnectionId: legacy });

  it("resolves by platform id and by the product connection it extends, never across workspaces, never when revoked", async () => {
    const ws = newWorkspace();
    const created = await make(ws, "conn-legacy-1");
    await repos.connections.recordVerification(db, { workspaceId: ws, id: created.id, ok: true });
    expect((await ports.connections.resolve({ workspaceId: ws, connectionId: created.id }))?.id).toBe(created.id);
    expect((await ports.connections.resolve({ workspaceId: ws, connectionId: "conn-legacy-1" }))?.id).toBe(created.id);
    expect(await ports.connections.resolve({ workspaceId: newWorkspace(), connectionId: "conn-legacy-1" })).toBeNull();
    expect(await ports.connections.resolve({ workspaceId: newWorkspace(), connectionId: created.id })).toBeNull();
    await repos.connections.revoke(db, ws, created.id);
    expect(await ports.connections.resolve({ workspaceId: ws, connectionId: "conn-legacy-1" })).toBeNull();
  });

  it("prefers a verified connection among several that extend the same product connection", async () => {
    const ws = newWorkspace();
    await make(ws, "conn-legacy-2");
    const verified = await make(ws, "conn-legacy-2");
    await repos.connections.recordVerification(db, { workspaceId: ws, id: verified.id, ok: true });
    expect((await ports.connections.resolve({ workspaceId: ws, connectionId: "conn-legacy-2" }))?.id).toBe(verified.id);
  });
});
