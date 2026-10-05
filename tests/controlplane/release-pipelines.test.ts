/**
 * PROD-LIFE-10 on the real SQL store: the digest is immutable, state moves only along the allowed
 * transitions (also enforced by the database), transitions are compare-and-set with an event row in
 * the same transaction, approvals are independent and single use, and everything is tenant scoped.
 * PGlite always; real PostgreSQL when ZENITH_TEST_PLATFORM_PG_URL is set (see `_support/harness.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLATFORM_MIGRATIONS } from "@/lib/controlplane/db";
import { createPlatformReleaseStore } from "@/lib/controlplane/db/repos/release-pipelines";
import { ReleaseSafetyService, type BeginInput, type ProvenanceVerifier, type ReleaseStore } from "@/lib/release-safety";
import { LANES, newWorkspace, openLane, uid } from "./_support/harness";

const SVC = "container_service/web";
const dg = (c: string) => `sha256:${c.repeat(64)}`;
const uri = (d: string) => `registry.example.test/web@${d}`;
const CMD = "c".repeat(64);
const verifier: ProvenanceVerifier = { name: "test", verify: async () => ({ verified: true, level: "build_record", evidenceRef: "ev:test" }) };

describe("migration inventory", () => {
  it("0024 creates the release tables with row level security", () => {
    const m = PLATFORM_MIGRATIONS.find((x) => x.name === "release_pipelines");
    expect(m?.version).toBe(24);
    for (const table of ["release_runs", "release_events", "release_migration_approvals"]) {
      expect(m!.sql).toContain(`platform.${table}`);
      expect(m!.sql).toContain(`alter table platform.${table} enable row level security`);
    }
  });
});

describe.each(LANES)("release pipeline store [$name]", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  let store: ReleaseStore;
  let svc: ReleaseSafetyService;
  beforeAll(async () => {
    ctx = await openLane(lane);
    store = createPlatformReleaseStore(ctx.db);
    svc = new ReleaseSafetyService({ store, verifiers: [verifier] });
  }, 60_000);
  afterAll(async () => {
    await ctx.close();
  });

  const input = (ws: string, env: string, over: Partial<BeginInput> = {}): BeginInput => ({
    workspaceId: ws,
    environmentId: env,
    operationId: uid("op"),
    serviceAddress: SVC,
    provider: "gcp",
    nodeKind: "container_service",
    kind: "deploy",
    imageUri: uri(dg("1")),
    imageDigest: dg("1"),
    origin: "built",
    requestedBy: "alice",
    ...over,
  });

  async function serve(ws: string, env: string, over: Partial<BeginInput> = {}) {
    let run = await svc.begin(input(ws, env, over));
    run = await svc.markDeployed(run, { percent: 100, detail: "d" });
    run = run.migration.status === "none" ? await svc.markMigrated(run, { ran: false }) : await svc.markMigrated(await svc.beginMigration(run), { ran: true, exitCode: 0 });
    run = await svc.markCutOver(await svc.markReady(run, "r"), "c");
    return svc.recordReadback(run, { supported: true, observedDigest: run.imageDigest });
  }

  it("walks the whole pipeline and records an event per transition", async () => {
    const ws = newWorkspace();
    const run = await serve(ws, uid("env"));
    expect(run.state).toBe("readback_verified");
    expect(run.version).toBe(8);
    expect((await store.listEvents(ws, run.id)).map((e) => e.to)).toEqual(["planned", "built", "verified", "deployed", "migrated", "ready", "cut_over", "readback_verified"]);
    expect(run.provenance.level).toBe("build_record");
  });

  it("insert is idempotent per operation and service; another digest is refused", async () => {
    const ws = newWorkspace();
    const env = uid("env");
    const first = input(ws, env);
    const a = await svc.begin(first);
    const b = await svc.begin(first);
    expect(b.id).toBe(a.id);
    await expect(svc.begin({ ...first, imageDigest: dg("2"), imageUri: uri(dg("2")) })).rejects.toMatchObject({ code: "digest_immutable" });
  });

  it("the database refuses to change a bound digest, skip a state, or deploy without provenance", async () => {
    const ws = newWorkspace();
    const run = await svc.begin(input(ws, uid("env")));
    await expect(ctx.db.query("update platform.release_runs set image_digest=$3, version=version+1 where workspace_id=$1 and id=$2", [ws, run.id, dg("9")])).rejects.toThrow(/bound to its image digest/);
    await expect(ctx.db.query("update platform.release_runs set state='cut_over', version=version+1 where workspace_id=$1 and id=$2", [ws, run.id])).rejects.toThrow(/cannot move from verified to cut_over/);
    await expect(ctx.db.query("update platform.release_runs set state='built', version=version+5 where workspace_id=$1 and id=$2", [ws, run.id])).rejects.toThrow(/advance by one/);
    await expect(ctx.db.query("delete from platform.release_runs where workspace_id=$1 and id=$2", [ws, run.id])).rejects.toThrow(/cannot be deleted/);

    // a run that never had provenance recorded cannot be pushed to deployed even by a raw writer
    const bare = await store.insertRun({ id: uid("rel"), workspaceId: ws, environmentId: uid("env"), operationId: uid("op"), requestedBy: "alice", serviceAddress: SVC, kind: "deploy", state: "planned", imageUri: uri(dg("3")), imageDigest: dg("3"), provenance: { level: "none" }, migration: { class: "none", status: "none", findings: [] }, rollout: { strategy: "rolling", steps: [100], bakeSec: 0, percent: 0 } });
    await ctx.db.query("update platform.release_runs set state='built', version=2 where workspace_id=$1 and id=$2", [ws, bare.run.id]);
    await ctx.db.query("update platform.release_runs set state='verified', version=3 where workspace_id=$1 and id=$2", [ws, bare.run.id]);
    await expect(ctx.db.query("update platform.release_runs set state='deployed', version=4 where workspace_id=$1 and id=$2", [ws, bare.run.id])).rejects.toThrow(/without verified provenance/);
  });

  it("events are append-only", async () => {
    const ws = newWorkspace();
    const run = await svc.begin(input(ws, uid("env")));
    await expect(ctx.db.query("update platform.release_events set detail='x' where workspace_id=$1 and run_id=$2", [ws, run.id])).rejects.toThrow(/append-only/);
    await expect(ctx.db.query("delete from platform.release_events where workspace_id=$1 and run_id=$2", [ws, run.id])).rejects.toThrow(/append-only/);
  });

  it("transitions are compare-and-set: exactly one of two racing writers wins", async () => {
    const ws = newWorkspace();
    const run = await svc.begin(input(ws, uid("env")));
    const move = (to: "deployed" | "failed") => store.transition({ workspaceId: ws, id: run.id, expectVersion: run.version, to, actor: "t", detail: to });
    const results = await Promise.all([move("deployed"), move("failed")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.getRun(ws, run.id))!.version).toBe(run.version + 1);
    expect(await store.listEvents(ws, run.id)).toHaveLength(run.version + 1);
  });

  it("a code rollback is refused after a contract migration, using the stored history", async () => {
    const ws = newWorkspace();
    const env = uid("env");
    await serve(ws, env);
    const decl = { commandDigest: CMD, declared: "contract" as const };
    const second = input(ws, env, { imageDigest: dg("2"), imageUri: uri(dg("2")), migration: decl });
    await expect(svc.begin(second)).rejects.toMatchObject({ code: "migration_approval_required" });
    const blocked = (await store.findRun(ws, second.operationId, SVC, "deploy"))!;
    expect(blocked.state).toBe("blocked_approval");
    await svc.approveMigration({ workspaceId: ws, runId: blocked.id, bindingDigest: blocked.migration.bindingDigest!, approver: { kind: "user", id: "bob", name: "Bob" } });
    let run = await svc.begin(second);
    run = await svc.markDeployed(run, { percent: 100, detail: "d" });
    run = await svc.markMigrated(await svc.beginMigration(run), { ran: true, exitCode: 0 });
    run = await svc.markCutOver(await svc.markReady(run, "r"), "c");
    expect(run.migration).toMatchObject({ class: "contract", status: "ran" });

    const verdict = await svc.rollbackSafety({ workspaceId: ws, environmentId: env, serviceAddress: SVC, targetDigest: dg("1") });
    expect(verdict.allowed).toBe(false);
    expect(verdict.blockingRunId).toBe(run.id);
    await expect(svc.begin(input(ws, env, { kind: "rollback", imageDigest: dg("1"), imageUri: uri(dg("1")), origin: "pinned" }))).rejects.toMatchObject({ code: "rollback_unsafe" });
  });

  it("an approval is single use, independent of the requester, and immutable", async () => {
    const ws = newWorkspace();
    const env = uid("env");
    const decl = { commandDigest: CMD, declared: "data" as const };
    const first = input(ws, env, { migration: decl });
    await expect(svc.begin(first)).rejects.toMatchObject({ code: "migration_approval_required" });
    const blocked = (await store.findRun(ws, first.operationId, SVC, "deploy"))!;
    const binding = blocked.migration.bindingDigest!;
    await expect(svc.approveMigration({ workspaceId: ws, runId: blocked.id, bindingDigest: binding, approver: { kind: "user", id: "alice", name: "Alice" } })).rejects.toMatchObject({ code: "forbidden" });
    const approval = await svc.approveMigration({ workspaceId: ws, runId: blocked.id, bindingDigest: binding, approver: { kind: "user", id: "bob", name: "Bob" } });

    expect((await store.findUsableApproval(ws, binding, new Date()))?.id).toBe(approval.id);
    expect(await store.findUsableApproval(newWorkspace(), binding, new Date())).toBeNull();
    expect(await store.consumeApproval(newWorkspace(), approval.id, new Date())).toBe(false);
    expect(await store.consumeApproval(ws, approval.id, new Date())).toBe(true);
    expect(await store.consumeApproval(ws, approval.id, new Date())).toBe(false);
    expect(await store.findUsableApproval(ws, binding, new Date())).toBeNull();

    await expect(ctx.db.query("update platform.release_migration_approvals set approved_by='mallory' where workspace_id=$1 and id=$2", [ws, approval.id])).rejects.toThrow(/can only be consumed/);
    await expect(ctx.db.query("insert into platform.release_migration_approvals(id, workspace_id, run_id, binding_digest, class, approved_by, requested_by, approved_at, expires_at) values ($1,$2,$3,$4,'data','same','same',now(),now() + interval '1 hour')", [uid("rma"), ws, blocked.id, "f".repeat(64)])).rejects.toThrow();
  });

  it("an expired approval is not usable", async () => {
    const ws = newWorkspace();
    const decl = { commandDigest: CMD, declared: "contract" as const };
    const first = input(ws, uid("env"), { migration: decl });
    await expect(svc.begin(first)).rejects.toBeInstanceOf(Error);
    const blocked = (await store.findRun(ws, first.operationId, SVC, "deploy"))!;
    const approval = await svc.approveMigration({ workspaceId: ws, runId: blocked.id, bindingDigest: blocked.migration.bindingDigest!, approver: { kind: "user", id: "bob", name: "Bob" }, ttlSec: 60 });
    expect(await store.findUsableApproval(ws, blocked.migration.bindingDigest!, new Date(Date.now() + 120_000))).toBeNull();
    expect(await store.consumeApproval(ws, approval.id, new Date(Date.now() + 120_000))).toBe(false);
  });

  it("tenant isolation: a foreign workspace sees and moves nothing", async () => {
    const ws = newWorkspace();
    const other = newWorkspace();
    const env = uid("env");
    const run = await serve(ws, env);
    expect(await store.getRun(other, run.id)).toBeNull();
    expect(await store.listRuns(other, { environmentId: env })).toHaveLength(0);
    expect(await store.listEvents(other, run.id)).toHaveLength(0);
    expect(await store.transition({ workspaceId: other, id: run.id, expectVersion: run.version, to: "rolled_back", actor: "x", detail: "x" })).toBeNull();
    expect((await store.listRuns(ws, { environmentId: env, states: ["readback_verified"] })).map((r) => r.id)).toEqual([run.id]);
    expect(await store.listRuns(ws, { environmentId: env, states: ["failed"] })).toHaveLength(0);
  });

  it("stores no argv or SQL text, only digests", async () => {
    const ws = newWorkspace();
    const first = input(ws, uid("env"), { migration: { commandDigest: CMD, declared: "expand", sql: "create table canary_secret_table (id int)" } });
    const run = await svc.begin(first);
    const rows = await ctx.db.query("select to_jsonb(r)::text as t from platform.release_runs r where workspace_id=$1 and id=$2", [ws, run.id]);
    expect(String(rows[0].t)).not.toContain("canary_secret_table");
    expect(run.migration.sqlDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});
