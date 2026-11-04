/** Native read-only storage classification. Synthetic encrypted/receipt rows are not engine, Temporal or provider proof. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { digest } from "@/lib/controlplane/digest";
import { previewRetention, expire, type PlanArtifactRetentionPreviewInput } from "@/lib/controlplane/db/repos/plan-artifacts";
import * as repos from "@/lib/controlplane/db/repos";
import type { OperationStatus, Sql } from "@/lib/controlplane/types";
import { PG_URL, openLane, newWorkspace, proposalFor, user } from "./_support/harness";
import { openPlatformDb } from "@/lib/controlplane/db";

if (process.env.ZENITH_TEST_PLAN_RETENTION_REQUIRED === "1" && !PG_URL)
  throw new Error("Required plan retention cases need actual PostgreSQL.");
const old = "2020-01-01T00:00:00.000Z", cutoff = "2021-01-01T00:00:00.000Z";
const future = "2099-01-01T00:00:00.000Z";
describe.skipIf(!PG_URL)("plan artifact retention preview [postgres; synthetic storage and receipt fixtures]", () => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => { ctx = await openLane({ name: "postgres", independent: true,
    open: () => openPlatformDb({ kind: "postgres", url: PG_URL, migrate: true, max: 3 }) }); }, 60_000);
  afterAll(async () => { await ctx?.close(); });
  const policy = (workspaceId: string, over: Partial<PlanArtifactRetentionPreviewInput> = {}): PlanArtifactRetentionPreviewInput =>
    ({ workspaceId, createdBefore: cutoff, limit: 100, holdOperationIds: [], ...over });
  async function operation(workspaceId: string, status: OperationStatus = "succeeded") {
    const { operation: op } = await repos.operations.create(ctx.db, { workspaceId, principal: user(), proposal: proposalFor(workspaceId) });
    await ctx.db.query("update platform.operations set status=$3 where workspace_id=$1 and id=$2", [workspaceId, op.id, status]);
    return op;
  }
  async function artifact(workspaceId = newWorkspace(), status: OperationStatus = "succeeded", phase = "succeeded", createdAt = old, expiresAt = old) {
    const op = await operation(workspaceId, status), planDigest = digest(op.id), manifestDigest = digest({ op: op.id });
    // Real canonical schema rows, explicitly synthetic storage custody; no publication/dispatch constructor is mocked or invoked.
    await ctx.db.query(`insert into platform.plan_artifacts
      (workspace_id,operation_id,manifest,manifest_digest,plan_digest,iv,auth_tag,ciphertext,expires_at,created_at)
      values ($1,$2,$3::text::jsonb,$4,$5,$6,$7,$8,$9::timestamptz,$10::timestamptz)`,
      [workspaceId, op.id, JSON.stringify({ workspaceId, operationId: op.id, planDigest, privatePlanCanary: "synthetic-plan-content" }),
        manifestDigest, planDigest, "x".repeat(16), "x".repeat(24), "synthetic-encrypted-storage-canary", expiresAt, createdAt]);
    // A dispatched storage row must carry a durable identity for the canonical writer
    // ledger. This explicitly synthetic ID is not proof that any provider received bytes.
    const attemptId = phase === "dispatched" ? `synthetic-retention:${randomUUID()}` : null;
    if (phase !== "missing") await ctx.db.query("insert into platform.plan_artifact_uses (workspace_id,operation_id,phase,attempt_id) values ($1,$2,$3,$4)", [workspaceId, op.id, phase, attemptId]);
    return { workspaceId, op, planDigest, manifestDigest, attemptId };
  }
  async function associate(f: Awaited<ReturnType<typeof artifact>>, status: OperationStatus = "succeeded", phase = "succeeded", expiresAt = old) {
    const destination = await operation(f.workspaceId, status);
    await ctx.db.query(`insert into platform.plan_artifact_associations
      (workspace_id,operation_id,source_operation_id,source_evidence_id,source_manifest_digest,source_raw_sha256,proposal_digest,input_digest,expires_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz)`,
      [f.workspaceId, destination.id, f.op.id, `evd_${randomUUID()}`, f.manifestDigest, digest("synthetic-original"), destination.proposalDigest, destination.inputDigest, expiresAt]);
    const attemptId = phase === "dispatched" ? `synthetic-retention:${randomUUID()}` : null;
    if (phase !== "missing") await ctx.db.query("insert into platform.plan_artifact_uses (workspace_id,operation_id,phase,attempt_id) values ($1,$2,$3,$4)", [f.workspaceId, destination.id, phase, attemptId]);
    return destination;
  }
  async function startIntent(f: Awaited<ReturnType<typeof artifact>>, phase: "attempted" | "acknowledged") {
    const binding = { format: "zenith.workflow-start.v1", arguments: { workspaceId: f.workspaceId, operationId: f.op.id },
      endpointDigest: digest(f.op.id), namespace: "synthetic-retention", workflowId: f.op.id };
    await ctx.db.query(`insert into platform.workflow_start_intents
      (workspace_id,operation_id,binding,binding_digest,phase,attempt_id,attempted_at,run_id,observed_start_at,evidence_digest,acknowledged_at)
      values ($1,$2,$3::text::jsonb,$4,$5,$6,$7::timestamptz,$8,$9::timestamptz,$10,$11::timestamptz)`,
      [f.workspaceId, f.op.id, JSON.stringify(binding), digest(binding), phase, randomUUID(), old,
        phase === "acknowledged" ? randomUUID() : null, phase === "acknowledged" ? old : null,
        phase === "acknowledged" ? digest("synthetic-start-observation") : null, phase === "acknowledged" ? old : null]);
  }
  async function buildReceipt(f: Awaited<ReturnType<typeof artifact>>, terminal: boolean) {
    const binding = { workspaceId: f.workspaceId, operationId: f.op.id, environmentId: f.op.environmentId!, serviceAddress: "container_service/web" };
    await ctx.db.query(`insert into platform.build_launches
      (workspace_id,operation_id,service_address,environment_id,attempt_id,binding,binding_digest,proposal_digest,input_digest,plan_digest,fence_token,
        phase,build_id,request_ids,accepted_at,terminal_status,provider_finished_at,terminal_request_id,observed_at)
      values ($1,$2,$3,$4,$5,$6::text::jsonb,$7,$8,$9,$10,1,$11,$12,$13::text::jsonb,$14::timestamptz,$15,$16::timestamptz,$17,$18::timestamptz)`,
      [f.workspaceId, f.op.id, binding.serviceAddress, f.op.environmentId, randomUUID(), JSON.stringify(binding), digest(binding),
        f.op.proposalDigest, f.op.inputDigest, f.planDigest, terminal ? "terminal" : "dispatched", terminal ? `synthetic:${randomUUID()}` : null,
        terminal ? JSON.stringify(["synthetic-request"]) : null, terminal ? old : null, terminal ? "SUCCEEDED" : null,
        terminal ? old : null, terminal ? "synthetic-terminal-request" : null, terminal ? old : null]);
  }
  it("previews one expired terminal artifact for archive copy review while retaining all original rows", async () => {
    const f = await artifact(), before = await ctx.db.query("select * from platform.plan_artifacts where workspace_id=$1", [f.workspaceId]);
    expect(await previewRetention(ctx.db, policy(f.workspaceId))).toEqual({ mode: "dry-run", scanned: 1, hasMore: false,
      held: 0, active: 0, unresolved: 0, unavailable: 0, withinRetention: 0, archiveReview: 1 });
    expect(await ctx.db.query("select * from platform.plan_artifacts where workspace_id=$1", [f.workspaceId])).toEqual(before);
  });
  it.each(["proposed", "awaiting_approval", "approved", "queued", "running"] as const)("protects current %s operation before archive review", async status => {
    const f = await artifact(undefined, status);
    expect(await previewRetention(ctx.db, policy(f.workspaceId))).toMatchObject({ active: 1, archiveReview: 0 });
  });
  it("protects terminal uncertain operation independently of its use phase", async () => {
    const f = await artifact(undefined, "uncertain", "expired");
    expect(await previewRetention(ctx.db, policy(f.workspaceId))).toMatchObject({ unresolved: 1, archiveReview: 0 });
  });
  it.each(["claimed", "dispatched", "uncertain"])("protects %s original-byte attempt even with a terminal owner", async phase => {
    const f = await artifact(undefined, "succeeded", phase);
    if (phase === "dispatched") {
      expect(f.attemptId).toMatch(/^synthetic-retention:[0-9a-f-]+$/);
      expect(await ctx.db.query("select identity,attempt_id,capability from platform.cleanup_writer_deliveries where workspace_id=$1 and operation_id=$2 and family='plan'", [f.workspaceId, f.op.id]))
        .toEqual([{ identity: `${f.op.id}:${f.attemptId}`, attempt_id: f.attemptId, capability: f.op.capability }]);
    }
    expect(await previewRetention(ctx.db, policy(f.workspaceId))).toMatchObject({ unresolved: 1, archiveReview: 0 });
  });
  it("refuses archive classification when the original use row is absent", async () => {
    const f = await artifact(undefined, "succeeded", "missing");
    expect(await previewRetention(ctx.db, policy(f.workspaceId))).toMatchObject({ unavailable: 1, archiveReview: 0 });
  });
  it("protects an explicitly held original without extending operation or artifact expiry", async () => {
    const f = await artifact(), before = await ctx.db.query("select expires_at from platform.operations where workspace_id=$1 and id=$2", [f.workspaceId, f.op.id]);
    expect(await previewRetention(ctx.db, policy(f.workspaceId, { holdOperationIds: [f.op.id] }))).toMatchObject({ held: 1, archiveReview: 0 });
    expect(await ctx.db.query("select expires_at from platform.operations where workspace_id=$1 and id=$2", [f.workspaceId, f.op.id])).toEqual(before);
  });
  it("propagates a same-workspace destination hold to its retained source artifact", async () => {
    const f = await artifact(), destination = await associate(f);
    expect(await previewRetention(ctx.db, policy(f.workspaceId, { holdOperationIds: [destination.id] }))).toMatchObject({ held: 1, archiveReview: 0 });
  });
  it("protects a source used by a current active associated destination", async () => {
    const f = await artifact(); await associate(f, "running");
    expect(await previewRetention(ctx.db, policy(f.workspaceId))).toMatchObject({ active: 1, archiveReview: 0 });
  });
  it("protects a source with an uncertain associated original-byte attempt", async () => {
    const f = await artifact(); await associate(f, "succeeded", "uncertain");
    expect(await previewRetention(ctx.db, policy(f.workspaceId))).toMatchObject({ unresolved: 1, archiveReview: 0 });
  });
  it("protects a source when an associated destination use row is missing", async () => {
    const f = await artifact(); await associate(f, "succeeded", "missing");
    expect(await previewRetention(ctx.db, policy(f.workspaceId))).toMatchObject({ unavailable: 1, archiveReview: 0 });
  });
  it("protects a source whose associated custody has not expired", async () => {
    const f = await artifact(); await associate(f, "succeeded", "succeeded", future);
    expect(await previewRetention(ctx.db, policy(f.workspaceId))).toMatchObject({ withinRetention: 1, archiveReview: 0 });
  });
  it("requires both explicit creation cutoff and native artifact expiry before archive review", async () => {
    const ws = newWorkspace(); await artifact(ws, "succeeded", "succeeded", cutoff); await artifact(ws, "succeeded", "succeeded", old, future);
    expect(await previewRetention(ctx.db, policy(ws))).toMatchObject({ scanned: 2, withinRetention: 2, archiveReview: 0 });
  });
  it("bounds the oldest-first window and reports additional rows without claiming a complete inventory", async () => {
    const ws = newWorkspace(); for (let i = 0; i < 3; i++) await artifact(ws);
    expect(await previewRetention(ctx.db, policy(ws, { limit: 2 }))).toMatchObject({ scanned: 2, hasMore: true, archiveReview: 2 });
    expect(await previewRetention(ctx.db, policy(ws, { limit: 3 }))).toMatchObject({ scanned: 3, hasMore: false, archiveReview: 3 });
  });
  it("never lets another workspace artifact or hold alter the selected workspace preview", async () => {
    const f = await artifact(), foreign = await artifact();
    expect(await previewRetention(ctx.db, policy(f.workspaceId, { holdOperationIds: [foreign.op.id] }))).toMatchObject({ scanned: 1, held: 0, archiveReview: 1 });
    expect(await previewRetention(ctx.db, policy(newWorkspace()))).toMatchObject({ scanned: 0, archiveReview: 0 });
  });
  it("captures holds before an awaited native query without invoking a replacement hold accessor", async () => {
    const f = await artifact(), entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
    const input = { ...policy(f.workspaceId), holdOperationIds: [f.op.id] };
    const db: Sql = { tx: ctx.db.tx.bind(ctx.db), query: async <T>(text: string, params?: readonly unknown[]) => {
      entered.resolve(); await resume.promise; return ctx.db.query<T>(text, params);
    } };
    const preview = previewRetention(db, input); await entered.promise;
    let getterCalls = 0; Object.defineProperty(input.holdOperationIds, "0", { get() { getterCalls++; throw new Error("synthetic-private-canary"); } });
    resume.resolve(); expect(await preview).toMatchObject({ held: 1, archiveReview: 0 }); expect(getterCalls).toBe(0);
  });
  it("fresh independent-pool operation mutation changes the next preview instead of trusting an earlier candidate", async () => {
    const f = await artifact(); expect(await previewRetention(ctx.db, policy(f.workspaceId))).toMatchObject({ archiveReview: 1 });
    await ctx.db2.query("update platform.operations set status='running' where workspace_id=$1 and id=$2", [f.workspaceId, f.op.id]);
    expect(await previewRetention(ctx.db, policy(f.workspaceId))).toMatchObject({ active: 1, archiveReview: 0 });
  });
  it("protects permanent attempted workflow tombstones with an unconfirmed external start", async () => {
    const f = await artifact(); await startIntent(f, "attempted");
    expect(await previewRetention(ctx.db, policy(f.workspaceId))).toMatchObject({ unresolved: 1, archiveReview: 0 });
  });
  it("protects permanent build launch inventory until its terminal observation is retained", async () => {
    const f = await artifact(); await buildReceipt(f, false);
    expect(await previewRetention(ctx.db, policy(f.workspaceId))).toMatchObject({ unresolved: 1, archiveReview: 0 });
  });
  it("preserves audit evidence idempotency leases original custody and acknowledged start and terminal build receipts byte for byte", async () => {
    const f = await artifact(); await associate(f); await startIntent(f, "acknowledged"); await buildReceipt(f, true);
    await repos.evidence.insert(ctx.db, { workspaceId: f.workspaceId, operationId: f.op.id, kind: "tofu_plan", digest: f.planDigest, summary: {}, simulated: true });
    await repos.events.append(ctx.db, { workspaceId: f.workspaceId, operationId: f.op.id, type: "operation.succeeded", correlationId: f.op.id, data: {} });
    await repos.idempotency.reserve(ctx.db, { workspaceId: f.workspaceId, key: "synthetic-retention-idempotency", requestHash: digest("request"), ttlMs: 60_000 });
    await repos.leases.acquire(ctx.db, { workspaceId: f.workspaceId, scope: `env:${f.op.environmentId}`, holder: "synthetic-retention-owner", ttlMs: 60_000 });
    const snapshot = async () => Promise.all([
      ctx.db.query("select * from platform.operations where workspace_id=$1 order by id", [f.workspaceId]),
      ctx.db.query("select * from platform.plan_artifacts where workspace_id=$1 order by operation_id", [f.workspaceId]),
      ctx.db.query("select * from platform.plan_artifact_associations where workspace_id=$1 order by operation_id", [f.workspaceId]),
      ctx.db.query("select * from platform.plan_artifact_uses where workspace_id=$1 order by operation_id", [f.workspaceId]),
      ctx.db.query("select * from platform.evidence where workspace_id=$1 order by id", [f.workspaceId]),
      ctx.db.query("select * from platform.events where workspace_id=$1 order by id", [f.workspaceId]),
      ctx.db.query("select * from platform.idempotency_keys where workspace_id=$1 order by key", [f.workspaceId]),
      ctx.db.query("select * from platform.leases where workspace_id=$1 order by scope", [f.workspaceId]),
      ctx.db.query("select * from platform.workflow_start_intents where workspace_id=$1 order by operation_id", [f.workspaceId]),
      ctx.db.query("select * from platform.build_launches where workspace_id=$1 order by operation_id", [f.workspaceId]),
    ]);
    const before = await snapshot(); expect(await previewRetention(ctx.db, policy(f.workspaceId))).toMatchObject({ archiveReview: 1 });
    expect(await snapshot()).toEqual(before); expect(await previewRetention(ctx.db, policy(f.workspaceId))).toMatchObject({ archiveReview: 1 });
    await expect(ctx.db2.query("delete from platform.workflow_start_intents where workspace_id=$1 and operation_id=$2", [f.workspaceId, f.op.id])).rejects.toThrow();
    await expect(ctx.db2.query("delete from platform.build_launches where workspace_id=$1 and operation_id=$2", [f.workspaceId, f.op.id])).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it("returns counts without plan state ciphertext digests keys or row identities", async () => {
    const f = await artifact(), text = JSON.stringify(await previewRetention(ctx.db, policy(f.workspaceId)));
    for (const secret of [f.workspaceId, f.op.id, f.planDigest, f.manifestDigest, "synthetic-plan-content", "synthetic-encrypted-storage-canary"])
      expect(text).not.toContain(secret);
  });
  it("preview holds do not waive existing logical expiry or remove original encrypted bytes", async () => {
    const f = await artifact(undefined, "succeeded", "ready"), before = await ctx.db.query("select * from platform.plan_artifacts where workspace_id=$1", [f.workspaceId]);
    expect(await previewRetention(ctx.db, policy(f.workspaceId, { holdOperationIds: [f.op.id] }))).toMatchObject({ held: 1 });
    await expire(ctx.db, 1000);
    expect(await ctx.db.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2", [f.workspaceId, f.op.id])).toEqual([{ phase: "expired" }]);
    expect(await ctx.db.query("select * from platform.plan_artifacts where workspace_id=$1", [f.workspaceId])).toEqual(before);
  });
});
