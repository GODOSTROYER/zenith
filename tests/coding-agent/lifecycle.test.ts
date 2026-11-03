/** Real SQL lifecycle and admission checks; PostgreSQL races use two independent pools. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import { digest } from "@/lib/controlplane/digest";
import { expireAnalysisPayloads, modelWorkerAvailable, purgeRunPayload, recordModelWorker } from "@/lib/coding-agent/lifecycle";
import { platformRunStore, type CodingAgentRunRow, type CreateRunInput, type SaveRunInput } from "@/lib/coding-agent/store";
import { approve, LANES, newWorkspace, openLane, seedAwaitingApproval, uid } from "../controlplane/_support/harness";

const payload = "PRIVATE_SOURCE_PAYLOAD_TO_DELETE";
const runInput = (workspaceId: string, overrides: Partial<CreateRunInput> = {}): CreateRunInput => ({
  id: uid("run"), workspaceId, createdBy: "admin", model: "fixture-model", task: payload,
  source: { repository: "acme/school", repositoryId: 101, commit: "a".repeat(40), root: "apps/school" },
  limits: { spendMicroUsd: 400_000, toolCalls: 20 }, usage: { spendMicroUsd: 0, toolCalls: 0 },
  checkpoint: { version: 1, analysisMode: "model", messages: [{ role: "user", content: payload }], steps: 1 },
  workflowId: uid("workflow"), ...overrides,
});
const progress = (row: CodingAgentRunRow): SaveRunInput => ({
  workspaceId: row.workspaceId, id: row.id, expectedVersion: row.version, status: row.status,
  limits: row.limits, usage: row.usage, checkpoint: row.checkpoint,
});

describe.each(LANES)("analysis lifecycle and admissions on $name", lane => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => { ctx = await openLane(lane); }, 60_000);
  afterAll(async () => { await ctx?.close(); });

  async function binding(workspaceId: string, repositoryId = 101, bindingId = uid("github")) {
    await ctx.db.query(
      "insert into platform.github_source_bindings(workspace_id,binding_id,app_id,installation_id,repository_id,owner,repo,version,bound_by) values($1,$2,'42',7,$3,'acme',$4,1,'admin')",
      [workspaceId, bindingId, repositoryId, `repo-${repositoryId}`],
    );
    return bindingId;
  }

  async function limits(workspaceId: string, concurrentRuns: number, dailySpend: number) {
    await ctx.db.query("insert into platform.coding_agent_workspace_limits(workspace_id,concurrent_runs,daily_spend_micro_usd) values($1,$2,$3)", [workspaceId, concurrentRuns, dailySpend]);
  }

  it("stores SQL-queryable JSONB objects through create, save, resume and outcome attachment", async () => {
    const workspaceId = newWorkspace(), store = platformRunStore(ctx.db);
    const input = runInput(workspaceId);
    input.source = { ...(input.source as object), bindingId: "grant-shape", bindingVersion: 4 };
    const shape = async (resultType: string | null, budget: number, spent: number) => {
      const [row] = await ctx.db.query(
        "select jsonb_typeof(source) as source_type,jsonb_typeof(limits) as limits_type,jsonb_typeof(usage) as usage_type,jsonb_typeof(checkpoint) as checkpoint_type,jsonb_typeof(result) as result_type,source->>'bindingId' as binding_id,limits->>'spendMicroUsd' as budget,usage->>'spendMicroUsd' as spent,checkpoint->>'analysisMode' as mode from platform.coding_agent_runs where workspace_id=$1 and id=$2",
        [workspaceId, input.id],
      );
      expect(row).toEqual({ source_type: "object", limits_type: "object", usage_type: "object", checkpoint_type: "object", result_type: resultType,
        binding_id: "grant-shape", budget: String(budget), spent: String(spent), mode: "model" });
    };
    const initial = await store.create(input);
    await shape(null, 400_000, 0);
    const stopped = await store.save({ ...progress(initial), status: "budget_exhausted", stopReason: { kind: "budget", dimension: "spendMicroUsd" }, usage: { spendMicroUsd: 125_000 }, result: { finalText: "Retained findings" } });
    expect(stopped.stopReason).toEqual({ kind: "budget", dimension: "spendMicroUsd" });
    await shape("object", 400_000, 125_000);
    const resumed = await store.claimResume({ workspaceId, id: input.id, limits: { spendMicroUsd: 600_000 }, workflowId: uid("resume") });
    await shape("object", 600_000, 125_000);
    await store.save({ ...progress(resumed), status: "completed" });
    const noResult = await store.create(runInput(workspaceId));
    await store.save({ ...progress(noResult), status: "completed" });
    await store.attachOutcome({ workspaceId, id: noResult.id, result: { artifact: { manifestDigest: digest("attached") } } });
    expect(await ctx.db.query("select jsonb_typeof(result) as result_type,result->'artifact'->>'manifestDigest' as manifest_digest from platform.coding_agent_runs where workspace_id=$1 and id=$2", [workspaceId, noResult.id]))
      .toEqual([{ result_type: "object", manifest_digest: digest("attached") }]);
  });

  it("rejects scalar JSONB and invalid spend metadata instead of silently admitting a zero budget", async () => {
    const workspaceId = newWorkspace(), store = platformRunStore(ctx.db);
    const run = await store.create(runInput(workspaceId));
    for (const column of ["source", "limits", "usage", "checkpoint", "result"] as const) {
      await expect(ctx.db.query(`update platform.coding_agent_runs set ${column}=$3::text::jsonb where workspace_id=$1 and id=$2`, [workspaceId, run.id, JSON.stringify(JSON.stringify({ spendMicroUsd: 0 }))]))
        .rejects.toMatchObject({ sqlstate: "23514", constraint: "coding_agent_runs_jsonb_objects_check" });
    }
    for (const spend of [null, -1, 0.5, "100", 9_007_199_254_740_992]) {
      await expect(ctx.db.query("update platform.coding_agent_runs set limits=$3::text::jsonb where workspace_id=$1 and id=$2", [workspaceId, run.id, JSON.stringify({ spendMicroUsd: spend })]))
        .rejects.toMatchObject({ sqlstate: "23514", constraint: "coding_agent_runs_spend_metadata_check" });
    }
    await expect(store.create(runInput(workspaceId, { limits: { spendMicroUsd: Number.NaN } })))
      .rejects.toMatchObject({ code: "invalid_state" });
    expect(await store.get(workspaceId, run.id)).toEqual(run);
  });

  it("purges disposable content by tenant/version while preserving usage and the permanent authority ledger", async () => {
    const workspaceId = newWorkspace(), store = platformRunStore(ctx.db);
    const authority = await seedAwaitingApproval(ctx.db, { workspaceId });
    await approve(ctx.db, authority);
    const snapshot = {
      format: "zenith.approved-source.v1", workspaceId, operationId: authority.operation.id,
      projectId: "project_school", environmentId: "env_staging", serviceAddress: "container_service/web",
      serviceSpecDigest: digest("service"), pipelineAddress: "build_pipeline/web", pipelineSpecDigest: digest("pipeline"),
      provider: "aws", region: "eu-west-1", owner: "acme", repo: "school", repositoryId: 101,
      requestedRef: "main", commitSha: "a".repeat(40), githubBinding: null, dockerfile: "Dockerfile",
      dockerfileDigest: digest("dockerfile"), recipeDigest: digest("recipe"), archiveFormat: "zip", archiveDigest: digest("archive"), archiveBytes: 128,
    };
    await ctx.db.query(
      "insert into platform.approved_source_snapshots(workspace_id,operation_id,project_id,environment_id,service_address,snapshot,snapshot_digest) values($1,$2,$3,$4,$5,$6::text::jsonb,$7)",
      [workspaceId, authority.operation.id, snapshot.projectId, snapshot.environmentId, snapshot.serviceAddress, JSON.stringify(snapshot), digest(snapshot)],
    );
    const ledger = async () => Promise.all([
      ctx.db.query("select * from platform.operations where workspace_id=$1 order by id", [workspaceId]),
      ctx.db.query("select * from platform.approvals where workspace_id=$1 order by id", [workspaceId]),
      ctx.db.query("select * from platform.policy_decisions where workspace_id=$1 order by id", [workspaceId]),
      ctx.db.query("select * from platform.events where workspace_id=$1 order by seq", [workspaceId]),
      ctx.db.query("select * from platform.approved_source_snapshots where workspace_id=$1 order by operation_id,service_address", [workspaceId]),
    ]);
    const retained = await ledger();
    const originalRequest = runInput(workspaceId);
    const initial = await store.create(originalRequest);
    const row = await store.save({ ...progress(initial),
      usage: { spendMicroUsd: 125_000, toolCalls: 4 },
      checkpoint: { version: 1, analysisMode: "model", steps: 3, messages: [{ role: "assistant", content: payload }], artifact: { manifest: payload }, unsafeAttempts: [payload], injectionSignals: [payload] },
      result: { artifact: { manifest: payload, manifestDigest: digest("manifest"), requirementsDigest: digest("requirements") }, analysis: payload },
      proposalOperationId: authority.operation.id,
    });
    expect(await purgeRunPayload(ctx.db, newWorkspace(), row.id, row.version)).toBe(false);
    expect(await purgeRunPayload(ctx.db, workspaceId, row.id, row.version - 1)).toBe(false);
    expect((await store.get(workspaceId, row.id))?.task).toBe(payload);
    expect(await purgeRunPayload(ctx.db, workspaceId, row.id, row.version)).toBe(true);
    const purged = (await store.get(workspaceId, row.id))!;
    expect(purged).toMatchObject({
      task: "[Analysis content deleted]", status: "cancelled", version: row.version + 1,
      source: row.source, usage: row.usage, proposalOperationId: authority.operation.id,
      result: { purged: true, manifestDigest: digest("manifest"), requirementsDigest: digest("requirements") },
      checkpoint: { messages: [], usage: row.usage, steps: 3, toolHistogram: {}, unsafeAttempts: [], injectionSignals: [] },
    });
    expect(purged.payloadPurgedAt).toBeTruthy();
    expect(JSON.stringify(purged)).not.toContain(payload);
    expect(await ledger()).toEqual(retained);
    expect(await purgeRunPayload(ctx.db, workspaceId, row.id)).toBe(false);
    for (const expectedVersion of [row.version, purged.version]) {
      await expect(store.save({ ...progress(row), expectedVersion, checkpoint: row.checkpoint, result: row.result })).rejects.toMatchObject({ code: "conflict" });
    }
    await expect(store.claimResume({ workspaceId, id: row.id, limits: row.limits, workflowId: uid("resume") })).rejects.toMatchObject({ code: "invalid_state" });
    await expect(store.attachOutcome({ workspaceId, id: row.id, result: { artifact: { manifest: payload } } })).rejects.toThrow();
    expect(await store.get(workspaceId, row.id)).toEqual(purged);
    // A retry of a request whose acknowledgement was lost must not recreate deleted content.
    expect(await store.create({ ...originalRequest, idempotent: true })).toEqual(purged);
  });

  it("blocks expired writes before maintenance and then clears expired runs and discovery sessions only", async () => {
    const workspaceId = newWorkspace(), store = platformRunStore(ctx.db);
    const running = await store.create(runInput(workspaceId));
    const stopped = await store.save({ ...progress(await store.create(runInput(workspaceId))), status: "failed" });
    const current = await store.create(runInput(workspaceId));
    await ctx.db.query("update platform.coding_agent_runs set payload_expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and id in ($2,$3)", [workspaceId, running.id, stopped.id]);
    await expect(store.save({ ...progress(running), checkpoint: { messages: [payload] } })).rejects.toMatchObject({ code: "conflict" });
    await expect(store.claimResume({ workspaceId, id: stopped.id, limits: stopped.limits, workflowId: uid("resume") })).rejects.toMatchObject({ code: "invalid_state" });
    await expect(store.attachOutcome({ workspaceId, id: stopped.id, result: { artifact: { manifest: payload } } })).rejects.toThrow();

    const expiredSession = digest(uid("expired")), currentSession = digest(uid("current"));
    await ctx.db.query(
      "insert into platform.github_discovery_sessions(workspace_id,session_digest,actor_id,app_id,installation_id,installation_generation,repositories,expires_at) values($1,$2,'admin','42',7,0,'[]',clock_timestamp()-interval '1 second'),($1,$3,'admin','42',7,0,'[]',clock_timestamp()+interval '1 hour')",
      [workspaceId, expiredSession, currentSession],
    );
    expect(await expireAnalysisPayloads(ctx.db)).toBeGreaterThanOrEqual(2);
    for (const row of [running, stopped]) {
      const purged = await store.get(workspaceId, row.id);
      expect(purged).toMatchObject({ task: "[Analysis content deleted]", status: "cancelled" });
      expect(purged?.payloadPurgedAt).toBeTruthy();
      expect(JSON.stringify(purged)).not.toContain(payload);
    }
    expect(await store.get(workspaceId, current.id)).toEqual(current);
    expect(await ctx.db.query("select session_digest from platform.github_discovery_sessions where workspace_id=$1", [workspaceId]))
      .toEqual([{ session_digest: currentSession }]);
  });

  it("purges revoked and superseded grant versions without erasing another repository or tenant", async () => {
    const workspaceId = newWorkspace(), otherWorkspace = newWorkspace(), store = platformRunStore(ctx.db);
    const revokedId = await binding(workspaceId, 101), currentId = await binding(workspaceId, 102), reconnectedId = await binding(workspaceId, 103);
    await binding(otherWorkspace, 101, revokedId);
    const source = (bindingId: string, repositoryId: number) => ({ bindingId, bindingVersion: 1, repositoryId, repository: `acme/repo-${repositoryId}`, commit: "a".repeat(40) });
    const revoked = await store.create(runInput(workspaceId, { source: source(revokedId, 101) }));
    const unaffected = await store.create(runInput(workspaceId, { source: source(currentId, 102) }));
    const superseded = await store.create(runInput(workspaceId, { source: source(reconnectedId, 103) }));
    const foreign = await store.create(runInput(otherWorkspace, { source: source(revokedId, 101) }));
    await ctx.db.query("update platform.github_source_bindings set revoked_at=clock_timestamp(),version=version+1 where workspace_id=$1 and binding_id in ($2,$3)", [workspaceId, revokedId, reconnectedId]);
    // Reconnection happens before maintenance: the old run must not inherit the new grant.
    await ctx.db.query("update platform.github_source_bindings set revoked_at=null,version=version+1 where workspace_id=$1 and binding_id=$2", [workspaceId, reconnectedId]);
    expect(await expireAnalysisPayloads(ctx.db)).toBeGreaterThanOrEqual(2);
    for (const row of [revoked, superseded]) {
      const purged = await store.get(workspaceId, row.id);
      expect(purged?.payloadPurgedAt).toBeTruthy();
      expect(JSON.stringify(purged)).not.toContain(payload);
      await expect(store.claimResume({ workspaceId, id: row.id, limits: row.limits, workflowId: uid("resume") })).rejects.toMatchObject({ code: "invalid_state" });
    }
    expect(await store.get(workspaceId, unaffected.id)).toEqual(unaffected);
    expect(await store.get(otherWorkspace, foreign.id)).toEqual(foreign);
    expect(await ctx.db.query("select version,revoked_at from platform.github_source_bindings where workspace_id=$1 and binding_id=$2", [workspaceId, reconnectedId]))
      .toEqual([{ version: 3, revoked_at: null }]);
  });

  it("serializes competing model admissions so their reserved budgets cannot exceed the daily ceiling", async () => {
    const workspaceId = newWorkspace();
    await limits(workspaceId, 5, 1_000_000);
    const requests = [runInput(workspaceId, { limits: { spendMicroUsd: 600_000 } }), runInput(workspaceId, { limits: { spendMicroUsd: 600_000 } })];
    const results = await Promise.allSettled([
      platformRunStore(ctx.db).create(requests[0]), platformRunStore(ctx.db2).create(requests[1]),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "invalid_state", message: expect.stringContaining("daily analysis budget") } });
    const [usage] = await ctx.db.query<{ total: string | number; count: string | number }>("select sum((limits->>'spendMicroUsd')::bigint) as total,count(*) as count from platform.coding_agent_runs where workspace_id=$1", [workspaceId]);
    expect(Number(usage.total)).toBe(600_000);
    expect(Number(usage.count)).toBe(1);
    const winner = results.find(result => result.status === "fulfilled")!;
    if (winner.status !== "fulfilled") throw new Error("Missing admitted fixture run.");
    const original = requests.find(input => input.id === winner.value.id)!;
    expect(await platformRunStore(ctx.db2).create({ ...original, idempotent: true })).toEqual(winner.value);
    await expect(platformRunStore(ctx.db2).create({ ...original, idempotent: true, checkpoint: { version: 1, analysisMode: "static", messages: [] } }))
      .rejects.toMatchObject({ code: "conflict" });
    await expect(platformRunStore(ctx.db2).create({ ...original, idempotent: true, limits: { spendMicroUsd: 500_000 } }))
      .rejects.toMatchObject({ code: "conflict" });
    expect(await platformRunStore(ctx.db).list(workspaceId)).toHaveLength(1);
  });

  it("enforces concurrent slots for static work without charging its model budget or another tenant", async () => {
    const workspaceId = newWorkspace(), otherWorkspace = newWorkspace(), store = platformRunStore(ctx.db);
    await limits(workspaceId, 1, 1_000_000);
    const staticRun = await store.create(runInput(workspaceId, {
      limits: { spendMicroUsd: 1_000_000 }, checkpoint: { version: 1, analysisMode: "static", messages: [] },
    }));
    await expect(platformRunStore(ctx.db2).create(runInput(workspaceId, { limits: { spendMicroUsd: 100_000 } })))
      .rejects.toMatchObject({ code: "invalid_state", message: expect.stringContaining("concurrent analysis limit") });
    const other = await platformRunStore(ctx.db2).create(runInput(otherWorkspace, { limits: { spendMicroUsd: 1_000_000 } }));
    expect(other.status).toBe("running");
    await store.save({ ...progress(staticRun), status: "completed" });
    const model = await store.create(runInput(workspaceId, { limits: { spendMicroUsd: 1_000_000 } }));
    expect(model.status).toBe("running");
  });

  it("returns an accepted request after its result changes even when other work fills every admission allowance", async () => {
    const workspaceId = newWorkspace(), store = platformRunStore(ctx.db);
    await limits(workspaceId, 1, 1_000_000);
    const original = runInput(workspaceId, { limits: { spendMicroUsd: 100_000 } });
    const completed = await store.save({ ...progress(await store.create(original)), status: "completed", checkpoint: { version: 1, analysisMode: "model", messages: [], steps: 2 }, usage: { spendMicroUsd: 0 } });
    await store.create(runInput(workspaceId, { limits: { spendMicroUsd: 1_000_000 } }));
    // Both concurrency and budget are now full. A replay needs neither a slot nor another reservation.
    expect(await platformRunStore(ctx.db2).create({ ...original, idempotent: true })).toEqual(completed);
    await ctx.db.query("update platform.coding_agent_workspace_limits set concurrent_runs=2 where workspace_id=$1", [workspaceId]);
    expect(await platformRunStore(ctx.db2).create({ ...original, idempotent: true })).toEqual(completed);
    expect(await store.list(workspaceId)).toHaveLength(2);
  });

  it("counts recent completed spend and reserves stale running work even beyond the daily window", async () => {
    const workspaceId = newWorkspace(), store = platformRunStore(ctx.db);
    await limits(workspaceId, 4, 1_000_000);
    const complete = await store.save({ ...progress(await store.create(runInput(workspaceId))), status: "completed", usage: { spendMicroUsd: 300_000 } });
    await expect(store.create(runInput(workspaceId, { limits: { spendMicroUsd: 700_001 } })))
      .rejects.toMatchObject({ code: "invalid_state", message: expect.stringContaining("daily analysis budget") });
    await ctx.db.query("update platform.coding_agent_runs set updated_at=clock_timestamp()-interval '25 hours' where workspace_id=$1 and id=$2", [workspaceId, complete.id]);
    const running = await store.create(runInput(workspaceId, { limits: { spendMicroUsd: 900_000 } }));
    await ctx.db.query("update platform.coding_agent_runs set updated_at=clock_timestamp()-interval '25 hours' where workspace_id=$1 and id=$2", [workspaceId, running.id]);
    await expect(store.create(runInput(workspaceId, { limits: { spendMicroUsd: 100_001 } })))
      .rejects.toMatchObject({ code: "invalid_state", message: expect.stringContaining("daily analysis budget") });
    expect((await store.create(runInput(workspaceId, { limits: { spendMicroUsd: 100_000 } }))).status).toBe("running");
  });

  it("rechecks resume reservations and admits one concurrent resume at the exact remaining ceiling", async () => {
    const workspaceId = newWorkspace(), store = platformRunStore(ctx.db), peer = platformRunStore(ctx.db2);
    await limits(workspaceId, 2, 1_000_000);
    const stopped = await store.save({ ...progress(await store.create(runInput(workspaceId))), status: "budget_exhausted", usage: { spendMicroUsd: 250_000 } });
    const active = await peer.create(runInput(workspaceId, { limits: { spendMicroUsd: 600_000 } }));
    await expect(store.claimResume({ workspaceId, id: stopped.id, limits: { spendMicroUsd: 500_000 }, workflowId: uid("resume") }))
      .rejects.toMatchObject({ code: "invalid_state", message: expect.stringContaining("daily analysis budget") });
    expect(await store.get(workspaceId, stopped.id)).toEqual(stopped);
    const results = await Promise.allSettled([
      store.claimResume({ workspaceId, id: stopped.id, limits: { spendMicroUsd: 400_000 }, workflowId: uid("resume") }),
      peer.claimResume({ workspaceId, id: stopped.id, limits: { spendMicroUsd: 400_000 }, workflowId: uid("resume") }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "invalid_state" } });
    expect(await store.get(workspaceId, stopped.id)).toMatchObject({ status: "running", version: stopped.version + 1, limits: { spendMicroUsd: 400_000 }, usage: stopped.usage });
    expect(await peer.get(workspaceId, active.id)).toEqual(active);
  });
});

// Worker capability is global, so use an owned database instead of altering another suite's live leases.
describe("model worker capability lease", () => {
  let db: PlatformDbHandle;
  beforeAll(async () => { db = await openPlatformDb({ kind: "pglite", migrate: true }); }, 60_000);
  afterAll(async () => { await db?.close(); });

  it("expires a missing heartbeat, refreshes the same lease, and withdraws readiness explicitly", async () => {
    expect(await modelWorkerAvailable(db)).toBe(false);
    await recordModelWorker(db, "static-worker", false);
    expect(await modelWorkerAvailable(db)).toBe(false);
    await recordModelWorker(db, "model-worker", true);
    expect(await modelWorkerAvailable(db)).toBe(true);
    await db.query("update platform.coding_agent_workers set seen_at=clock_timestamp()-interval '91 seconds' where worker_id='model-worker'");
    expect(await modelWorkerAvailable(db)).toBe(false);
    await recordModelWorker(db, "model-worker", true);
    expect(await modelWorkerAvailable(db)).toBe(true);
    expect(await db.query("select worker_id from platform.coding_agent_workers where worker_id='model-worker'")).toHaveLength(1);
    await recordModelWorker(db, "model-worker", false);
    expect(await modelWorkerAvailable(db)).toBe(false);
    const anotherQueue = digest("another-temporal-namespace");
    await recordModelWorker(db, "model-worker", true, anotherQueue);
    expect(await modelWorkerAvailable(db, anotherQueue)).toBe(true);
    expect(await modelWorkerAvailable(db)).toBe(false);
    expect(await db.query("select worker_id from platform.coding_agent_workers where worker_id='model-worker'")).toHaveLength(2);
    await expect(recordModelWorker(db, "", true)).rejects.toThrow("Invalid worker identity");
  });
});
