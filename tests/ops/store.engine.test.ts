/**
 * PROD-OPS-02 against a REAL engine: PGlite always, PostgreSQL when ZENITH_TEST_PLATFORM_PG_URL is set
 * (the same lanes the control-store suites use). Covers migration 41's tables, the store functions, the
 * bounded runner queue enforced inside `jobs.enqueue`, and dispatch admission over real operation rows.
 * No fakes: every assertion reads SQL results.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as repos from "@/lib/controlplane/db/repos";
import type { PlatformDbHandle } from "@/lib/controlplane/db";
import { assertDispatchAdmitted } from "@/lib/ops/admission";
import { BackpressureError } from "@/lib/ops/errors";
import { opsLimitsFromEnv } from "@/lib/ops/config";
import { buildRuntime, setOpsRuntimeForTests } from "@/lib/ops/runtime";
import { sampleControlPlane } from "@/lib/ops/sampler";
import { activeOperationCount, deleteTenantQuota, drainStatus, getMaintenance, getTenantQuota, listTenantQuotas, maintenanceHistory, putTenantQuota, queuedJobCount, setMaintenance } from "@/lib/ops/store";
import { metricsRegistry } from "@/lib/ops/telemetry/metrics";
import { LANES, expectCode, newWorkspace, openLane, seedApprovedOperation, uid } from "../controlplane/_support/harness";

const KEY = "A".repeat(43);

describe.each(LANES)("fair bounded control plane [$name]", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => { ctx = await openLane(lane); }, 60_000);
  afterAll(async () => { await ctx.close(); });
  const db = (): PlatformDbHandle => ctx.db;
  afterEach(() => { vi.unstubAllEnvs(); setOpsRuntimeForTests(undefined); });
  // The maintenance row is process-global. On a shared PostgreSQL it would flip maintenance under any other suite
  // using the same database, so those cases run on PGlite always and on PostgreSQL only when it is exclusively owned.
  const itGlobal = it.skipIf(lane.name === "postgres" && process.env.ZENITH_TEST_OPS_EXCLUSIVE_PG !== "1");

  async function runner(ws: string) {
    const { tokenHash } = repos.runners.generateRegistrationToken("runner");
    await repos.runners.createRegistrationToken(db(), { workspaceId: ws, kind: "runner", createdBy: "admin", tokenHash });
    return repos.runners.registerRunner(db(), { tokenHash, name: "r", publicKey: KEY, version: "1.0.0", capabilities: ["tofu.run"] });
  }
  async function operationJob(ws: string, runnerId: string) {
    const { operation } = await seedApprovedOperation(db(), ws);
    return repos.jobs.enqueue(db(), { id: uid("job"), workspaceId: ws, runnerId, operationId: operation.id, kind: "tofu.run", capability: "infrastructure.apply", envelope: "eyJhbGciOiJFZERTQSJ9.payload.signature" });
  }
  const readJob = (ws: string, runnerId: string) =>
    repos.jobs.enqueue(db(), { id: uid("job"), workspaceId: ws, runnerId, operationId: `read:${uid("grant")}`, kind: "probe.tcp", capability: "infrastructure.observe", envelope: "eyJhbGciOiJFZERTQSJ9.payload.signature" });

  describe("maintenance row", () => {
    itGlobal("starts off, versions every change, records history, and refuses a stale writer", async () => {
      const before = await getMaintenance(db());
      const entered = await setMaintenance(db(), { mode: "read_only", reason: "failover drill", actor: "op_1" });
      expect(entered).toMatchObject({ mode: "read_only", reason: "failover drill", updatedBy: "op_1", source: "database" });
      expect(entered.version).toBe(before.version + 1);
      await expectCode(setMaintenance(db(), { mode: "off", actor: "op_2", expectedVersion: entered.version - 1 }), "conflict");
      const left = await setMaintenance(db(), { mode: "off", reason: "", actor: "op_2", expectedVersion: entered.version });
      expect(left).toMatchObject({ mode: "off", version: entered.version + 1 });
      const history = await maintenanceHistory(db(), 5);
      expect(history[0]).toMatchObject({ mode: "off", actor: "op_2", version: left.version });
      expect(history[1]).toMatchObject({ mode: "read_only", actor: "op_1", reason: "failover drill" });
    });

    itGlobal("requires a reason to enter maintenance, bounds it, and rejects an unknown mode", async () => {
      await expectCode(setMaintenance(db(), { mode: "dispatch_paused", actor: "op" }), "invalid_input");
      await expectCode(setMaintenance(db(), { mode: "dispatch_paused", reason: "x".repeat(301), actor: "op" }), "invalid_input");
      await expectCode(setMaintenance(db(), { mode: "sideways" as never, reason: "x", actor: "op" }), "invalid_input");
      await setMaintenance(db(), { mode: "off", reason: "", actor: "op" });
    });

    itGlobal("keeps the history append-only", async () => {
      await setMaintenance(db(), { mode: "off", reason: "", actor: "op" });
      await expect(db().query("update platform.ops_maintenance_history set actor = 'x'")).rejects.toThrow(/append-only/);
      await expect(db().query("delete from platform.ops_maintenance_history")).rejects.toThrow(/append-only/);
    });

    it("allows only the single global row and a closed set of modes", async () => {
      await expect(db().query("insert into platform.ops_maintenance (id, mode, updated_by) values ('other', 'off', 'x')")).rejects.toThrow();
      await expect(db().query("update platform.ops_maintenance set mode = 'sideways'")).rejects.toThrow();
    });
  });

  describe("tenant quotas", () => {
    it("stores overrides per workspace, treats null as the platform default, versions writes and deletes cleanly", async () => {
      const ws = newWorkspace();
      expect(await getTenantQuota(db(), ws)).toBeNull();
      const put = await putTenantQuota(db(), { workspaceId: ws, weight: 4, apiRatePerSec: 12.5, maxActiveOperations: 60, actor: "op" });
      expect(put).toMatchObject({ workspaceId: ws, weight: 4, apiRatePerSec: 12.5, maxActiveOperations: 60, version: 1 });
      expect(put.apiBurst).toBeUndefined();
      const again = await putTenantQuota(db(), { workspaceId: ws, weight: 2, apiBurst: 90, actor: "op", expectedVersion: 1 });
      expect(again).toMatchObject({ weight: 2, apiBurst: 90, version: 2 });
      expect(again.apiRatePerSec).toBeUndefined(); // a full replace: the omitted field went back to the default
      await expectCode(putTenantQuota(db(), { workspaceId: ws, weight: 3, actor: "op", expectedVersion: 1 }), "conflict");
      expect((await listTenantQuotas(db(), 500)).some((q) => q.workspaceId === ws)).toBe(true);
      expect(await deleteTenantQuota(db(), ws)).toBe(true);
      expect(await deleteTenantQuota(db(), ws)).toBe(false);
      expect(await getTenantQuota(db(), ws)).toBeNull();
    });

    it("validates every field and never lets one workspace's write touch another's row", async () => {
      const a = newWorkspace();
      const b = newWorkspace();
      for (const bad of [{ weight: 0 }, { weight: 101 }, { apiRatePerSec: 0 }, { apiBurst: 1.5 }, { maxConcurrentRequests: 0 }, { maxActiveOperations: -1 }, { maxQueuedJobs: 2_000_000 }])
        await expectCode(putTenantQuota(db(), { workspaceId: a, actor: "op", ...bad }), "invalid_input");
      await putTenantQuota(db(), { workspaceId: a, weight: 5, actor: "op" });
      await putTenantQuota(db(), { workspaceId: b, weight: 7, actor: "op" });
      expect((await getTenantQuota(db(), a))?.weight).toBe(5);
      expect((await getTenantQuota(db(), b))?.weight).toBe(7);
      await deleteTenantQuota(db(), a);
      expect((await getTenantQuota(db(), b))?.weight).toBe(7);
    });
  });

  describe("counts and drain status", () => {
    it("counts queued/running operations per workspace (excluding a retried one) and queued runner jobs, with foreign workspaces invisible", async () => {
      const ws = newWorkspace();
      const other = newWorkspace();
      const { operation: a } = await seedApprovedOperation(db(), ws);
      const { operation: b } = await seedApprovedOperation(db(), ws);
      await seedApprovedOperation(db(), other);
      expect(await activeOperationCount(db(), ws)).toBe(0); // approved is not yet dispatched
      await repos.operations.claimForExecution(db(), { workspaceId: ws, id: a.id, expectedDigest: a.proposalDigest, holder: "w1", leaseMs: 45_000 });
      await repos.operations.claimForExecution(db(), { workspaceId: ws, id: b.id, expectedDigest: b.proposalDigest, holder: "w1", leaseMs: 45_000 });
      expect(await activeOperationCount(db(), ws)).toBe(2);
      expect(await activeOperationCount(db(), ws, a.id)).toBe(1);
      expect(await activeOperationCount(db(), other)).toBe(0);

      const rn = await runner(ws);
      await operationJob(ws, rn.id);
      await readJob(ws, rn.id);
      const counts = await queuedJobCount(db(), ws);
      expect(counts.workspace).toBe(2);
      expect(counts.global).toBeGreaterThanOrEqual(2);
      expect((await queuedJobCount(db(), other)).workspace).toBe(0);
    });

    it("reports a drain: not drained while anything is queued or running, with the busiest workspaces named by id and counts only", async () => {
      const ws = newWorkspace();
      const { operation } = await seedApprovedOperation(db(), ws);
      await repos.operations.claimForExecution(db(), { workspaceId: ws, id: operation.id, expectedDigest: operation.proposalDigest, holder: "w1", leaseMs: 45_000 });
      const status = await drainStatus(db(), 50);
      expect(status.runningOperations).toBeGreaterThanOrEqual(1);
      expect(status.drained).toBe(false);
      expect(status.busiest.find((b) => b.workspaceId === ws)).toMatchObject({ activeOperations: 1 });
      expect(JSON.stringify(status)).not.toMatch(/envelope|proposal|principal/);
    });

    itGlobal("samples queue depth, active operations and maintenance into gauges and reports the store as up", async () => {
      metricsRegistry().reset();
      const ws = newWorkspace();
      const rn = await runner(ws);
      await readJob(ws, rn.id);
      await setMaintenance(db(), { mode: "dispatch_paused", reason: "sampling test", actor: "op" });
      const result = await sampleControlPlane(db(), {});
      await setMaintenance(db(), { mode: "off", reason: "", actor: "op" });
      expect(result.up).toBe(true);
      const text = metricsRegistry().renderPrometheus();
      expect(text).toContain("zenith_control_store_up 1");
      expect(text).toContain('zenith_maintenance_mode{mode="dispatch_paused"} 1');
      expect(text).toContain('zenith_maintenance_mode{mode="off"} 0');
      expect(text).toMatch(/zenith_runner_queue_depth_total \d+/);
    });

    it("sets the store-up gauge to 0 and never throws when the store cannot answer", async () => {
      metricsRegistry().reset();
      const broken = { query: async () => { throw new Error("down"); }, tx: async () => { throw new Error("down"); } };
      expect(await sampleControlPlane(broken as never, {})).toEqual({ up: false });
      expect(metricsRegistry().renderPrometheus()).toContain("zenith_control_store_up 0");
    });
  });

  describe("bounded runner queue (enforced inside jobs.enqueue)", () => {
    it("refuses an API-originated read job at the workspace's queued cap with a 429-class error, leaving other workspaces unaffected", async () => {
      vi.stubEnv("ZENITH_OPS_RUNNER_QUEUE_MAX_PER_TENANT", "2");
      const ws = newWorkspace();
      const rn = await runner(ws);
      await readJob(ws, rn.id);
      await readJob(ws, rn.id);
      const refused = await readJob(ws, rn.id).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(BackpressureError);
      expect(refused).toMatchObject({ code: "queue_full", status: 429, layer: "runner_queue", tenant: ws });
      expect((refused as BackpressureError).retryAfterSec).toBeGreaterThanOrEqual(1);
      expect((await queuedJobCount(db(), ws)).workspace).toBe(2); // nothing was buffered or half-written

      const other = newWorkspace();
      const otherRunner = await runner(other);
      await expect(readJob(other, otherRunner.id)).resolves.toMatchObject({ workspaceId: other, status: "queued" });
    });

    it("admits again once queued jobs leave the queue", async () => {
      vi.stubEnv("ZENITH_OPS_RUNNER_QUEUE_MAX_PER_TENANT", "1");
      const ws = newWorkspace();
      const rn = await runner(ws);
      const first = await readJob(ws, rn.id);
      await expect(readJob(ws, rn.id)).rejects.toBeInstanceOf(BackpressureError);
      await repos.jobs.cancel(db(), ws, first.id, "test");
      await expect(readJob(ws, rn.id)).resolves.toMatchObject({ status: "queued" });
    });

    it("uses the workspace's own max_queued_jobs override, scaled by weight when there is no override", async () => {
      vi.stubEnv("ZENITH_OPS_RUNNER_QUEUE_MAX_PER_TENANT", "1");
      const big = newWorkspace();
      const rn = await runner(big);
      await putTenantQuota(db(), { workspaceId: big, maxQueuedJobs: 3, actor: "op" });
      for (let i = 0; i < 3; i++) await readJob(big, rn.id);
      await expect(readJob(big, rn.id)).rejects.toMatchObject({ code: "queue_full" });

      const weighted = newWorkspace();
      const wr = await runner(weighted);
      await putTenantQuota(db(), { workspaceId: weighted, weight: 2, actor: "op" });
      await readJob(weighted, wr.id);
      await readJob(weighted, wr.id);
      await expect(readJob(weighted, wr.id)).rejects.toMatchObject({ code: "queue_full" });
    });

    itGlobal("never refuses an operation-bound job at the tenant cap (the operation was admitted at dispatch), only at the hard ceiling", async () => {
      vi.stubEnv("ZENITH_OPS_RUNNER_QUEUE_MAX_PER_TENANT", "1");
      const ws = newWorkspace();
      const rn = await runner(ws);
      for (let i = 0; i < 4; i++) await expect(operationJob(ws, rn.id)).resolves.toMatchObject({ status: "queued" });
      // Ceiling = 4 x the global cap. Set the global cap below what is already queued across the shared lane.
      const queued = (await queuedJobCount(db(), ws)).global;
      vi.stubEnv("ZENITH_OPS_RUNNER_QUEUE_MAX_GLOBAL", String(Math.max(1, Math.floor(queued / 4))));
      const refused = await operationJob(ws, rn.id).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(BackpressureError);
      expect(refused).toMatchObject({ code: "overloaded", status: 503, layer: "runner_queue" });
    });
  });

  describe("dispatch admission over real operation rows", () => {
    beforeEach(() => { vi.stubEnv("ZENITH_PLATFORM_DB", "pglite"); });

    it("refuses the START of new work for a workspace at its active-operation quota (429) but not another workspace, and releases as work finishes", async () => {
      const ws = newWorkspace();
      const other = newWorkspace();
      setOpsRuntimeForTests(buildRuntime(opsLimitsFromEnv({ ZENITH_OPS_MAX_ACTIVE_OPERATIONS: "2" }), async () => db()));
      const running: { id: string; digest: string }[] = [];
      for (let i = 0; i < 2; i++) {
        const { operation } = await seedApprovedOperation(db(), ws);
        await repos.operations.claimForExecution(db(), { workspaceId: ws, id: operation.id, expectedDigest: operation.proposalDigest, holder: "w1", leaseMs: 45_000 });
        running.push({ id: operation.id, digest: operation.proposalDigest });
      }
      const next = await seedApprovedOperation(db(), ws);
      await expect(assertDispatchAdmitted({ workspaceId: ws, kind: "deploy", operationId: next.operation.id })).rejects.toMatchObject({ code: "concurrency_exceeded", status: 429, layer: "dispatch" });
      await expect(assertDispatchAdmitted({ workspaceId: other, kind: "deploy", operationId: "op_other" })).resolves.toBeUndefined();
      await repos.operations.transition(db(), { workspaceId: ws, id: running[0].id, from: ["running"], to: "cancelled" });
      await expect(assertDispatchAdmitted({ workspaceId: ws, kind: "deploy", operationId: next.operation.id })).resolves.toBeUndefined();
    });

    itGlobal("pauses new dispatch while the stored maintenance row says so, and resumes when it is cleared, with no operation touched", async () => {
      const ws = newWorkspace();
      setOpsRuntimeForTests(buildRuntime(opsLimitsFromEnv({ ZENITH_OPS_MAINTENANCE_CACHE_MS: "0" }), async () => db()));
      const { operation } = await seedApprovedOperation(db(), ws);
      await setMaintenance(db(), { mode: "dispatch_paused", reason: "drain for upgrade", actor: "op" });
      try {
        await expect(assertDispatchAdmitted({ workspaceId: ws, kind: "deploy", operationId: operation.id })).rejects.toMatchObject({ code: "maintenance_dispatch_paused", status: 503 });
        expect((await repos.operations.get(db(), ws, operation.id))?.status).toBe("approved");
      } finally {
        await setMaintenance(db(), { mode: "off", reason: "", actor: "op" });
      }
      await expect(assertDispatchAdmitted({ workspaceId: ws, kind: "deploy", operationId: operation.id })).resolves.toBeUndefined();
    });

    itGlobal("lets in-flight work finish during maintenance: enqueue and settle of an already-running operation's job still succeed", async () => {
      const ws = newWorkspace();
      const rn = await runner(ws);
      const job = await operationJob(ws, rn.id);
      await setMaintenance(db(), { mode: "read_only", reason: "drain", actor: "op" });
      try {
        const claimed = await repos.jobs.claimNext(db(), { workspaceId: ws, runnerId: rn.id, max: 1 });
        expect(claimed.map((j) => j.id)).toContain(job.id);
        expect(await repos.jobs.settle(db(), { workspaceId: ws, runnerId: rn.id, jobId: job.id, status: "succeeded", result: { ok: true } })).toBe(true);
        await expect(operationJob(ws, rn.id)).resolves.toMatchObject({ status: "queued" });
      } finally {
        await setMaintenance(db(), { mode: "off", reason: "", actor: "op" });
      }
    });
  });
});
