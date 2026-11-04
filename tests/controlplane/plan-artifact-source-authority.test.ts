/** Actual PostgreSQL source admission and canonical consumed-human decisions. GitHub HTTP, scope and role reads are explicit fixtures; sealed bytes here are synthetic SQL custody, not OpenTofu provenance. */
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openPlatformDb, repos, type PlatformDbHandle } from "@/lib/controlplane/db";
import type { Sql } from "@/lib/controlplane/types";
import { digest } from "@/lib/controlplane/digest";
import { stableJson } from "@/lib/tofu/stable";
import { TOFU_VERSION } from "@/lib/tofu/types";
import { normalizePlan } from "@/lib/tofu/plan";
import type { PlanArtifactManifest } from "@/lib/tofu/engine";
import * as artifacts from "@/lib/controlplane/db/repos/plan-artifacts";
import { createApprovedSourceSnapshotStore } from "@/lib/controlplane/db/repos/approved-source-snapshots";
import { PLATFORM_SCHEMA_VERSION } from "@/lib/controlplane/db/migrations";
import { createOwningSourceBundles } from "@/lib/platform/source-bundle";
import { sourceRecipe, sourceSnapshotDigest, sourceSnapshotSetDigest, type ApprovedSourceSnapshot, type SourceCaptureInput } from "@/lib/execution/source-snapshot";
import { planEvidence } from "@/lib/execution/plan-evidence";
import { extractPlanFacts } from "@/lib/policy/plan-facts";
import { executionHolder, createOperationsPort } from "@/lib/execution/platform";
import { createExecutionBroker } from "@/lib/platform/broker";
import { planArtifactCipherFromEnv } from "@/lib/platform/plan-artifacts";
import { makeHarness, closeSharedPgliteAfterAll, scriptedEngine, requireApproval, sessionFor, user } from "../capabilities/support";
import { PG_URL, seedApprovedOperation, newWorkspace } from "./_support/harness";
import { mkNode } from "../providers/aws/drivers/compute/fixtures";
import { writeTar } from "../_support/tar";
import { keys, api } from "../sources/fixtures";

vi.mock("@/lib/execution/product-port", async original => ({
  ...await original<typeof import("@/lib/execution/product-port")>(),
  workerStoreScope: async <T>(body: () => Promise<T>): Promise<T> => body(),
}));
const required = process.env.ZENITH_TEST_PLAN_SOURCE_AUTHORITY_REQUIRED === "1";
if (required && !PG_URL) throw new Error("Plan source dispatch acceptance requires actual PostgreSQL.");
if (required && PLATFORM_SCHEMA_VERSION < 13) throw new Error("Plan source dispatch acceptance requires canonical schema13.");
closeSharedPgliteAfterAll();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

describe.skipIf(!PG_URL)("original plan source dispatch authority [postgres]", () => {
  let db: PlatformDbHandle, peer: PlatformDbHandle, observer: PlatformDbHandle, material: Awaited<ReturnType<typeof keys>>;
  beforeAll(async () => {
    db = await openPlatformDb({ kind: "postgres", url: PG_URL!, migrate: true, max: 1 });
    if (!((await db.query<{ version: number }>("select max(version)::integer as version from platform.schema_migrations"))[0]?.version >= 13))
      throw new Error("Plan source dispatch acceptance requires canonical schema13.");
    peer = await openPlatformDb({ kind: "postgres", url: PG_URL!, max: 1 });
    observer = await openPlatformDb({ kind: "postgres", url: PG_URL!, max: 1 });
    material = await keys();
  }, 60_000);
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { await material?.close(); await observer?.close(); await peer?.close(); await db?.close(); });

  async function capture(op: { workspaceId: string; id: string; projectId?: string; environmentId?: string }, lease: artifacts.ArtifactAccess["lease"], bound: boolean, name = "web") {
    const workspaceId = op.workspaceId, projectId = op.projectId!, environmentId = op.environmentId!;
    const pipeline = mkNode(`build_pipeline/${name}`, "build_pipeline", "aws:codebuild_project", { source: { repo: "acme/app", ref: "main", dockerfile: "Dockerfile" } }, { region: "eu-west-1", specDigest: digest("pipeline") });
    const service = mkNode(`container_service/${name}`, "container_service", "aws:ecs_service", { artifact: { type: "built", pipeline: pipeline.address } }, { region: "eu-west-1", specDigest: digest("service") });
    for (const node of [pipeline, service]) await repos.resources.upsertDesired(db, { workspaceId, projectId, environmentId, node, status: "active" });
    if (bound) {
      await db.query("insert into platform.github_source_bindings(workspace_id,app_id,installation_id,repository_id,owner,repo,version,bound_by) values ($1,'42',7,99,'acme','app',1,'fixture-admin')", [workspaceId]);
      vi.stubEnv("ZENITH_GITHUB_APP_ID", "42"); vi.stubEnv("ZENITH_GITHUB_APP_PRIVATE_KEY_FILE", material.config.privateKeyFile);
    }
    const app = api();
    const fetchImpl: typeof fetch = async (raw, init) => {
      const url = String(raw);
      if (url === "https://api.github.com/repos/acme/app") return Response.json({ id: 99, name: "app", owner: { login: "acme" }, private: bound });
      if (url.startsWith("https://api.github.com/repos/acme/app/commits/")) return new Response("a".repeat(40));
      if (url.startsWith("https://codeload.github.com/acme/app/tar.gz/")) return new Response(new Uint8Array(gzipSync(writeTar([{ path: "root/Dockerfile", bytes: Buffer.from("FROM scratch\n") }, { path: "root/app.txt", bytes: Buffer.from("immutable source fixture") }]))));
      return app(raw, init);
    };
    const store = createApprovedSourceSnapshotStore(db), source = createOwningSourceBundles(db, { sourceSnapshots: store, fetchImpl });
    const input: SourceCaptureInput = { workspaceId, operationId: op.id, projectId, environmentId, serviceAddress: service.address, serviceSpecDigest: service.specDigest,
      pipelineAddress: pipeline.address, pipelineSpecDigest: pipeline.specDigest, provider: "aws", region: service.region, repository: "acme/app", requestedRef: "main", dockerfile: "Dockerfile", recipeDigest: sourceRecipe(service, pipeline), archiveFormat: "zip" };
    const snapshot = await source.port.capture(input);
    return { snapshot, store, service, pipeline, lease };
  }
  async function fixture(bound = true, fault?: "missing source" | "foreign source" | "stripped source" | "source free", names: readonly string[] = ["web"]) {
    const h = fault ? undefined : await makeHarness({ kind: "postgres", engine: scriptedEngine("plan-source-policy", () => requireApproval(1, "admin", true)) });
    if (h) { h.deps.clock = { now: () => new Date() }; h.world.environments.get(h.ids.envAProd)!.region = "eu-west-1"; }
    const workspaceId = h?.ids.wsA ?? newWorkspace(), projectId = h?.ids.projA ?? `proj_${workspaceId}`, environmentId = h?.ids.envAProd ?? `env_${workspaceId}`;
    const proposed = h ? (await h.broker.propose({ capability: "deployment.deploy", scope: { workspaceId, projectId, environmentId }, input: {} }, user("alice"))).operation
      : (await seedApprovedOperation(db, workspaceId, { ttlMs: 120_000, proposal: { scope: { workspaceId, projectId, environmentId } } })).operation;
    const op = await repos.operations.get(db, workspaceId, proposed.id);
    if (!op || op.proposalDigest !== proposed.proposalDigest) throw new Error("Persisted plan source fixture operation is unavailable.");
    const lease = await repos.leases.acquire(db, { workspaceId, scope: `env:${environmentId}`, holder: `worker:${op.id}`, ttlMs: 120_000 });
    if (!lease) throw new Error("Plan source fixture lease is unavailable.");
    if (h) {
      await h.broker.approve({ workspaceId, operationId: op.id, proposalDigest: op.proposalDigest, approver: user("erin"), session: sessionFor("erin") });
      await h.broker.beginExecution({ workspaceId, operationId: op.id, holder: executionHolder(op.id), audience: "worker", lease, leaseMs: 120_000 });
    } else await repos.operations.claimForExecution(db, { workspaceId, id: op.id, expectedDigest: op.proposalDigest, holder: executionHolder(op.id), leaseMs: 120_000, lease });
    const sources = [];
    if (fault !== "source free") for (const name of names) sources.push(await capture(op, lease, bound, name));
    const source = sources[0];
    if (fault !== "missing source" && fault !== "foreign source") for (const captured of sources) await captured.store.retain(captured.snapshot, lease);
    if (source && fault === "foreign source") {
      // A valid, immutable native row with foreign scope models corrupt ownership, never genuine capture provenance.
      const foreign: ApprovedSourceSnapshot = { ...source.snapshot, projectId: "foreign-project" };
      await db.query("insert into platform.approved_source_snapshots(workspace_id,operation_id,project_id,environment_id,service_address,snapshot,snapshot_digest) values ($1,$2,$3,$4,$5,$6::text::jsonb,$7)",
        [workspaceId, op.id, foreign.projectId, environmentId, foreign.serviceAddress, JSON.stringify(foreign), sourceSnapshotDigest(foreign)]);
    }
    const snapshots = sources.map(value => value.snapshot).sort((a, b) => a.serviceAddress < b.serviceAddress ? -1 : a.serviceAddress > b.serviceAddress ? 1 : 0);
    const plan = normalizePlan({ format_version: "1.2", terraform_version: TOFU_VERSION, resource_changes: [], output_changes: {} }, { configDigest: digest("config"), lockDigest: digest("lock"), addressMap: {}, ...(source ? { executableSourceDigest: sourceSnapshotSetDigest(snapshots) } : {}) });
    const facts = extractPlanFacts(plan), summary = planEvidence({ plan, facts, cost: {}, graphDigest: digest("graph"), stage: "plan", ...(source ? { approvedSources: snapshots } : {}) }).summary;
    if (fault === "stripped source") { delete summary.executableSourceDigest; const view = summary.view as Record<string, unknown>; delete view.executableSourceDigest; delete view.approvedSources; }
    const worker = h && createExecutionBroker(db, async () => h.broker);
    if (h && worker) {
      await repos.evidence.insert(db, { workspaceId, operationId: op.id, kind: "tofu_plan", digest: plan.planDigest, summary, simulated: false });
      const ports = createOperationsPort(db); await ports.setPlanDigest({ workspaceId, operationId: op.id, planDigest: plan.planDigest });
      const policy = await worker.reevaluate(op.id, facts); await ports.setPolicyDecision({ workspaceId, operationId: op.id, decisionId: policy.decisionId });
      await ports.transition({ workspaceId, operationId: op.id, to: "awaiting_approval" });
      await h.broker.approve({ workspaceId, operationId: op.id, proposalDigest: op.proposalDigest, planDigest: plan.planDigest, approver: user("erin"), session: sessionFor("erin") });
      await repos.operations.claimForExecution(db, { workspaceId, id: op.id, expectedDigest: op.proposalDigest, holder: executionHolder(op.id), leaseMs: 120_000, lease, expectedPolicyVersion: "plan-source-policy" });
      await worker.issueGrant(op.id, "worker", lease);
    }
    const payload = "synthetic source-bound SQL custody payload", key = randomBytes(32).toString("hex"), cipher = planArtifactCipherFromEnv({ ZENITH_PLAN_ARTIFACT_KEY: key });
    const manifest: PlanArtifactManifest = { workspaceId, operationId: op.id, projectId, environmentId, proposalDigest: op.proposalDigest, inputDigest: op.inputDigest, expiresAt: op.expiresAt,
      sourceDigest: digest("source"), graphDigest: digest("graph"), format: "zenith.plan-artifact.v1", purpose: "deploy", configDigest: plan.configDigest, lockDigest: plan.lockDigest,
      backendDigest: digest("backend"), addressMapDigest: digest("addresses"), planDigest: plan.planDigest, rawSha256: hash(payload), bytes: Buffer.byteLength(payload),
      executable: { version: "fixture", platform: "fixture", sha256: digest("binary"), archiveSha256: null } };
    const sealed = cipher.seal(workspaceId, `zenith.tofu.plan-artifact.v1:${hash(stableJson(manifest))}`, Buffer.from(payload).toString("base64"));
    await artifacts.publish(db, { manifest, sealed, lease, evidence: { id: `evd_${randomUUID()}`, workspaceId, operationId: op.id, kind: "tofu_plan", digest: plan.planDigest, summary, simulated: false } });
    return { op, h, worker, source, snapshots, manifest, payload, access: { custody: manifest, planDigest: plan.planDigest, lease } };
  }
  async function live(f: Awaited<ReturnType<typeof fixture>>, sql: Sql = observer) {
    const rows = await sql.query<{ live: boolean }>(`select o.status='running' and o.expires_at>clock_timestamp() and o.lease_until>clock_timestamp()
      and l.expires_at>clock_timestamp() and l.fence_token=o.fence_token and l.holder=$3
      and exists(select 1 from platform.approvals a where a.workspace_id=o.workspace_id and a.operation_id=o.id and a.approval_round=o.approval_round
        and a.decision='approve' and a.consumed_at is not null and a.expires_at>clock_timestamp()) as live
      from platform.operations o join platform.leases l on l.scope=o.lease_scope where o.workspace_id=$1 and o.id=$2`, [f.op.workspaceId, f.op.id, f.access.lease.holder]);
    expect(rows).toEqual([{ live: true }]);
  }
  function delayRole(f: Awaited<ReturnType<typeof fixture>>) {
    if (!f.h) throw new Error("Canonical human-role fixture is unavailable.");
    const entered = barrier(), release = barrier(), roles = f.h.deps.roles;
    let reads = 0;
    f.h.deps.roles = { resolve: async (principal, workspaceId) => {
      if (principal.kind === "user" && principal.id === "erin") { reads++; entered.release(); await release.promise; }
      return roles.resolve(principal, workspaceId);
    } };
    return { entered: entered.promise, release: release.release, reads: () => reads };
  }
  async function mutate(f: Awaited<ReturnType<typeof fixture>>, change: string) {
    if (change === "revoked private binding") await observer.query("update platform.github_source_bindings set revoked_at=clock_timestamp(),version=version+1 where workspace_id=$1", [f.op.workspaceId]);
    if (change === "removed private binding") await observer.query("delete from platform.github_source_bindings where workspace_id=$1", [f.op.workspaceId]);
    if (change === "replaced private binding") await observer.query("update platform.github_source_bindings set installation_id=8,version=version+1 where workspace_id=$1", [f.op.workspaceId]);
    if (change === "introduced public binding") await observer.query("insert into platform.github_source_bindings(workspace_id,app_id,installation_id,repository_id,owner,repo,version,bound_by) values ($1,'42',7,99,'acme','app',1,'fixture-admin')", [f.op.workspaceId]);
  }
  async function dispatch(f: Awaited<ReturnType<typeof fixture>>, sql: Sql = peer) {
    if (!f.worker) throw new Error("Canonical approval fixture is unavailable.");
    const current = await f.worker.approvalStatus(f.op.id);
    expect(current.approved).toBe(true); expect(current.rejected).toBe(false); expect(current.dispatchApproval?.requiredApprovalCount).toBe(1);
    await artifacts.dispatch(sql, f.access, "source-attempt", current.dispatchApproval);
  }
  it.each(["unchanged private binding", "revoked private binding", "removed private binding", "replaced private binding", "introduced public binding"] as const)("final original-plan source admission fences %s during delayed current human role lookup", async change => {
    const f = await fixture(change !== "introduced public binding"); await artifacts.claim(db, f.access, "source-attempt");
    const wait = delayRole(f); let mutations = 0;
    const outcome = dispatch(f).then(() => { mutations++; return { error: undefined }; }, error => ({ error }));
    try { await wait.entered; await mutate(f, change); await live(f); expect(mutations).toBe(0); }
    finally { wait.release(); }
    const result = await outcome; expect(wait.reads()).toBe(1);
    if (change === "unchanged private binding") {
      expect(result.error).toBeUndefined(); expect(mutations).toBe(1);
      expect(await peer.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2", [f.op.workspaceId, f.op.id])).toEqual([{ phase: "dispatched" }]);
      await expect(dispatch(f)).rejects.toThrow(); expect(mutations).toBe(1);
      expect((await artifacts.read(peer, f.access)).manifest.rawSha256).toBe(hash(f.payload)); await artifacts.finish(db, f.access, "source-attempt", true);
    } else {
      expect(result.error).toMatchObject({ code: "plan_artifact_unavailable" }); expect(mutations).toBe(0);
      expect(await peer.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2", [f.op.workspaceId, f.op.id])).toEqual([{ phase: "claimed" }]);
      await artifacts.finish(db, f.access, "source-attempt", false);
    }
  });
  it.each(["service", "pipeline"] as const)("full %s recipe JSON mutation with unchanged stored digest refuses original dispatch", async kind => {
    const f = await fixture(); await artifacts.claim(db, f.access, "source-attempt");
    const node = kind === "service" ? f.source!.service : f.source!.pipeline;
    await observer.query("update platform.resources set spec=spec || $3::text::jsonb where workspace_id=$1 and address=$2", [f.op.workspaceId, node.address, JSON.stringify({ recipeChanged: true })]);
    expect((await observer.query<{ spec_digest: string }>("select spec_digest from platform.resources where workspace_id=$1 and address=$2", [f.op.workspaceId, node.address]))[0].spec_digest).toBe(node.specDigest);
    await live(f); await expect(dispatch(f)).rejects.toMatchObject({ code: "plan_artifact_unavailable" });
    expect(await peer.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2", [f.op.workspaceId, f.op.id])).toEqual([{ phase: "claimed" }]);
  });
  it.each(["missing source", "foreign source", "stripped source"] as const)("native original-plan custody refuses %s without entering dispatch", async fault => {
    const f = await fixture(false, fault); let mutations = 0;
    await expect(artifacts.claim(peer, f.access, "source-attempt").then(() => { mutations++; })).rejects.toThrow();
    expect(mutations).toBe(0); expect(await peer.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2", [f.op.workspaceId, f.op.id])).toEqual([{ phase: "ready" }]);
  });
  it("genuine native source-free absence retains historical original dispatch compatibility", async () => {
    const f = await fixture(false, "source free");
    expect(await peer.query("select service_address from platform.approved_source_snapshots where workspace_id=$1 and operation_id=$2", [f.op.workspaceId, f.op.id])).toEqual([]);
    await artifacts.claim(db, f.access, "source-attempt"); await artifacts.dispatch(peer, f.access, "source-attempt"); await artifacts.finish(db, f.access, "source-attempt", true);
    expect(await peer.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2", [f.op.workspaceId, f.op.id])).toEqual([{ phase: "succeeded" }]);
    await expect(artifacts.claim(peer, f.access, "source-repeat")).rejects.toThrow();
  });
  it("mixed-case multi-source review and final native aggregate share exact ASCII lexical service ordering", async () => {
    const f = await fixture(false, undefined, ["zebra", "Alpha", "beta"]);
    expect(f.snapshots.map(value => value.serviceAddress)).toEqual(["container_service/Alpha", "container_service/beta", "container_service/zebra"]);
    expect((await repos.operations.get(peer, f.op.workspaceId, f.op.id))?.planDigest).toBe(f.access.planDigest);
    await artifacts.claim(db, f.access, "source-attempt"); await dispatch(f); await artifacts.finish(db, f.access, "source-attempt", true);
    expect(await peer.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2", [f.op.workspaceId, f.op.id])).toEqual([{ phase: "succeeded" }]);
  });
  it("committed private revocation during an observed three-connection use-row waiter refuses the final original dispatch CAS", async () => {
    const f = await fixture(); await artifacts.claim(db, f.access, "source-attempt");
    const current = await f.worker!.approvalStatus(f.op.id); expect(current.approved).toBe(true); await live(f);
    let claimantPid = 0; const entered = barrier(); let pending!: Promise<{ error?: unknown }>;
    const claimant: Sql = { query: peer.query.bind(peer), tx: body => peer.tx(async tx => { claimantPid = (await tx.query<{ pid: number }>("select pg_backend_pid() as pid"))[0].pid; entered.release(); return body(tx); }) };
    await db.tx(async blocker => {
      await blocker.query("select operation_id from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2 for update", [f.op.workspaceId, f.op.id]);
      const blockerPid = (await blocker.query<{ pid: number }>("select pg_backend_pid() as pid"))[0].pid;
      pending = artifacts.dispatch(claimant, f.access, "source-attempt", current.dispatchApproval).then(() => ({}), error => ({ error }));
      await Promise.race([entered.promise, pending.then(() => { throw new Error("Dispatch ended before the expected native transaction."); })]);
      let blocked = false; const deadline = Date.now() + 4_000;
      while (Date.now() < deadline) {
        const state = await observer.tx(async fresh => {
          await fresh.query("select pg_stat_clear_snapshot()");
          return (await fresh.query<{ pid: number; blocked: boolean }>(`select pg_backend_pid() as pid,exists(select 1 from pg_stat_activity a where a.pid=$1 and a.wait_event_type='Lock'
            and a.query=$3 and $2=any(pg_blocking_pids(a.pid))) as blocked`, [claimantPid, blockerPid, "select operation_id from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2\n      and phase='claimed' and attempt_id=$3 and holder=$4 and fence_token=$5 for update"]))[0];
        });
        expect(new Set([state.pid, claimantPid, blockerPid]).size).toBe(3);
        if (state.blocked) { blocked = true; break; } await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true); await mutate(f, "revoked private binding"); await live(f, blocker);
      expect((await observer.query<{ revoked: boolean }>("select revoked_at is not null as revoked from platform.github_source_bindings where workspace_id=$1", [f.op.workspaceId]))[0].revoked).toBe(true);
    });
    expect((await pending).error).toMatchObject({ code: "plan_artifact_unavailable" });
    expect(await peer.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2", [f.op.workspaceId, f.op.id])).toEqual([{ phase: "claimed" }]);
    await artifacts.finish(db, f.access, "source-attempt", false);
  }, 15_000);
});
