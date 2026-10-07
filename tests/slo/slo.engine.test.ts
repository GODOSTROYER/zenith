/**
 * PROD-OPS-01 against a REAL engine: PGlite always, PostgreSQL when ZENITH_TEST_PLATFORM_PG_URL is set. Covers
 * migration 43 (slo_samples, slo_measurements), the additive sample writer, the durable operation indicators, the
 * RPO/RTO/capacity hooks, the append-only guard, the operator report and its two routes. No fakes beyond the
 * session lookup (Supabase) and the store handle injection the sibling ops route tests already use.
 *
 * Global tables on a shared PostgreSQL: assertions are deltas over a reading taken just before, and sample tests use
 * a unique SLI name, so concurrent suites cannot break them.
 */
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import { buildRuntime, setOpsRuntimeForTests } from "@/lib/ops/runtime";
import { opsLimitsFromEnv } from "@/lib/ops/config";
import { metricsRegistry } from "@/lib/ops/telemetry/metrics";
import { opsMetrics } from "@/lib/ops/telemetry/catalog";
import { reportCapacityTest, reportRecoveryRehearsal } from "@/lib/slo/recovery";
import { flushSloSamples, resetSloRecorderForTests } from "@/lib/slo/recorder";
import { buildSloReport } from "@/lib/slo/report";
import { addSamples, dispatchLatencyWindows, listMeasurements, recordMeasurement, sampleWindows, workflowCompletionWindows } from "@/lib/slo/store";
import { LANES, newWorkspace, openLane, seedApprovedOperation } from "../controlplane/_support/harness";

const OPERATOR = "0b9d4e1c-1111-4222-8333-444455556666";
const STRANGER = "9a8b7c6d-1111-4222-8333-444455556666";
const SECRET = randomBytes(24).toString("hex");

const mocks = vi.hoisted(() => ({ session: vi.fn(), db: undefined as unknown as PlatformDbHandle }));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: mocks.session }));
vi.mock("@/lib/ops/operator", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ops/operator")>()), opsStore: async () => mocks.db }));
vi.mock("@/lib/server/cron", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/server/cron")>()), ensurePlatformCron: async () => true }));
vi.mock("@/lib/controlplane/db", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/controlplane/db")>()), platformDb: async () => mocks.db }));

const sloRoute = await import("@/app/api/admin/ops/slo/route");
const measurementsRoute = await import("@/app/api/internal/slo/measurements/route");

const ORIGIN = "http://zenith.test";
const request = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`${ORIGIN}${p}`, { method, headers: { origin: ORIGIN, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const uniqueSli = (): string => `test_${randomBytes(6).toString("hex")}`;

describe.each(LANES)("service objectives [$name]", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => { ctx = await openLane(lane); mocks.db = ctx.db; }, 60_000);
  afterAll(async () => { await ctx.close(); });
  const db = (): PlatformDbHandle => ctx.db;
  beforeEach(() => {
    vi.stubEnv("ZENITH_OPS_ADMIN_IDS", OPERATOR);
    vi.stubEnv("CRON_SECRET", SECRET);
    setOpsRuntimeForTests(buildRuntime(opsLimitsFromEnv({}), async () => ctx.db));
    mocks.session.mockReset();
  });
  afterEach(() => { vi.unstubAllEnvs(); setOpsRuntimeForTests(undefined); });

  describe("samples", () => {
    it("adds counts additively and windows include only the buckets inside them", async () => {
      const sli = uniqueSli();
      await addSamples(db(), [{ sli, good: 90, total: 100 }]);
      await addSamples(db(), [{ sli, good: 90, total: 100 }, { sli, good: 0, total: 0 }]);
      // an older bucket: two hours ago is outside 5m/30m/1h, inside 6h/3d/budget
      await db().query(
        `insert into platform.slo_samples (sli, bucket_start, good, total)
         values ($1, to_timestamp(floor(extract(epoch from clock_timestamp() - interval '2 hours') / 300) * 300), 50, 50)`, [sli]);
      const w = await sampleWindows(db(), sli, 30);
      expect(w["5m"]).toEqual({ good: 180, total: 200 });
      expect(w["1h"]).toEqual({ good: 180, total: 200 });
      expect(w["6h"]).toEqual({ good: 230, total: 250 });
      expect(w.budget).toEqual({ good: 230, total: 250 });
    });

    it("refuses good above total, negative counts and a malformed SLI name", async () => {
      await expect(addSamples(db(), [{ sli: uniqueSli(), good: 5, total: 4 }])).rejects.toMatchObject({ code: "invalid_input" });
      await expect(addSamples(db(), [{ sli: uniqueSli(), good: -1, total: 4 }])).rejects.toMatchObject({ code: "invalid_input" });
      await expect(addSamples(db(), [{ sli: "Bad Name", good: 1, total: 1 }])).rejects.toMatchObject({ code: "invalid_input" });
      await expect(db().query("insert into platform.slo_samples (sli, bucket_start, good, total) values ('x', clock_timestamp(), 5, 4)")).rejects.toThrow();
    });

    it("flushSloSamples writes this process's counter deltas once and never double counts", async () => {
      metricsRegistry().reset();
      resetSloRecorderForTests();
      const before = await sampleWindows(db(), "api_availability", 30);
      const m = opsMetrics();
      m.apiRequests.inc({ tenant: "t", route_class: "/slo-test", method: "GET", status_class: "2xx" }, 7);
      m.apiRequests.inc({ tenant: "t", route_class: "/slo-test", method: "GET", status_class: "5xx" }, 1);
      await flushSloSamples(db(), Date.now());
      await flushSloSamples(db(), Date.now());
      const after = await sampleWindows(db(), "api_availability", 30);
      // other suites may add their own counts concurrently, so require AT LEAST ours and not double
      expect(after.budget.total - before.budget.total).toBeGreaterThanOrEqual(8);
      expect(after.budget.good - before.budget.good).toBeGreaterThanOrEqual(7);
      if (lane.name === "pglite") expect(after.budget.total - before.budget.total).toBe(8);
      resetSloRecorderForTests();
      metricsRegistry().reset();
    });
  });

  describe("durable operation indicators", () => {
    async function finished(status: "succeeded" | "failed", opts: { approvalRequired?: boolean; startedAfterSeconds?: number } = {}) {
      const { operation } = await seedApprovedOperation(db(), newWorkspace());
      await db().query(
        `update platform.operations set status = $2, approval_required = $3,
           created_at = clock_timestamp() - make_interval(secs => $4::int + 5),
           started_at = clock_timestamp() - interval '5 seconds', finished_at = clock_timestamp()
         where id = $1`,
        [operation.id, status, opts.approvalRequired ?? false, opts.startedAfterSeconds ?? 1]);
    }

    it("workflow completion is succeeded over succeeded, failed or uncertain, by finish time", async () => {
      const before = await workflowCompletionWindows(db(), 30);
      await finished("succeeded");
      await finished("succeeded");
      await finished("failed");
      const after = await workflowCompletionWindows(db(), 30);
      expect(after["1h"].total - before["1h"].total).toBeGreaterThanOrEqual(3);
      expect(after["1h"].good - before["1h"].good).toBeGreaterThanOrEqual(2);
      if (lane.name === "pglite") {
        expect(after.budget.total - before.budget.total).toBe(3);
        expect(after.budget.good - before.budget.good).toBe(2);
      }
    });

    it("dispatch latency counts unapproved operations that started within the threshold and ignores human waits", async () => {
      const before = await dispatchLatencyWindows(db(), 30, 30);
      await finished("succeeded", { startedAfterSeconds: 2 });     // fast
      await finished("succeeded", { startedAfterSeconds: 120 });   // slow
      await finished("succeeded", { startedAfterSeconds: 600, approvalRequired: true }); // human wait: excluded
      const after = await dispatchLatencyWindows(db(), 30, 30);
      expect(after.budget.total - before.budget.total).toBeGreaterThanOrEqual(2);
      expect(after.budget.good - before.budget.good).toBeGreaterThanOrEqual(1);
      if (lane.name === "pglite") {
        expect(after.budget.total - before.budget.total).toBe(2);
        expect(after.budget.good - before.budget.good).toBe(1);
      }
      await expect(dispatchLatencyWindows(db(), 0, 30)).rejects.toMatchObject({ code: "invalid_input" });
    });
  });

  describe("RPO, RTO and capacity hooks", () => {
    const failureAt = new Date(Date.now() - 36_000_000);

    it("derives RPO and RTO from the three instants and records both append-only against the provisional targets", async () => {
      const { rpo, rto } = await reportRecoveryRehearsal(db(), {
        source: "restore-rehearsal",
        failureAt,
        dataRecoveredThrough: new Date(failureAt.getTime() - 210_000),
        serviceRestoredAt: new Date(failureAt.getTime() + 2_530_000),
        recordedBy: "rehearsal-runner",
        reference: "rehearsal-test-1",
      });
      expect(rpo).toMatchObject({ kind: "rpo", value: 210, unit: "seconds", withinTarget: true, source: "restore-rehearsal" });
      expect(rto).toMatchObject({ kind: "rto", value: 2530, unit: "seconds", withinTarget: true });
      expect(rpo.targetVersion).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
      expect(rpo.details).toMatchObject({ reference: "rehearsal-test-1" });
      expect((await listMeasurements(db(), "rpo", 5)).some((m) => m.id === rpo.id)).toBe(true);
      await expect(db().query("update platform.slo_measurements set value = 0 where id = $1", [rpo.id])).rejects.toThrow(/append-only/);
      await expect(db().query("delete from platform.slo_measurements where id = $1", [rto.id])).rejects.toThrow(/append-only/);
    });

    it("flags a rehearsal that exceeds the provisional targets rather than hiding it", async () => {
      const { rpo, rto } = await reportRecoveryRehearsal(db(), {
        source: "recovery-drill",
        failureAt,
        dataRecoveredThrough: new Date(failureAt.getTime() - 1_800_000),
        serviceRestoredAt: new Date(failureAt.getTime() + 20_000_000),
        recordedBy: "drill",
      });
      expect(rpo.withinTarget).toBe(false);
      expect(rto.withinTarget).toBe(false);
    });

    it("refuses impossible orderings and a reference that is not a short token", async () => {
      const base = { source: "restore-rehearsal" as const, failureAt, recordedBy: "x" };
      await expect(reportRecoveryRehearsal(db(), { ...base, dataRecoveredThrough: new Date(failureAt.getTime() + 1000), serviceRestoredAt: new Date(failureAt.getTime() + 2000) })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(reportRecoveryRehearsal(db(), { ...base, dataRecoveredThrough: failureAt, serviceRestoredAt: new Date(failureAt.getTime() - 1000) })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(reportRecoveryRehearsal(db(), { ...base, dataRecoveredThrough: failureAt, serviceRestoredAt: failureAt, reference: "has spaces and ; symbols" })).rejects.toMatchObject({ code: "invalid_input" });
    });

    it("records a capacity test and judges it against the capacity objective", async () => {
      const ok = await reportCapacityTest(db(), { sustainedRps: 120, p95Ms: 80, errorRate: 0, durationSeconds: 30, concurrency: 16, environment: "unit test", measuredAt: new Date(), recordedBy: "ci" });
      const slow = await reportCapacityTest(db(), { sustainedRps: 120, p95Ms: 900, errorRate: 0, durationSeconds: 30, concurrency: 16, environment: "unit test", measuredAt: new Date(), recordedBy: "ci" });
      const low = await reportCapacityTest(db(), { sustainedRps: 3, p95Ms: 80, errorRate: 0, durationSeconds: 30, concurrency: 16, environment: "unit test", measuredAt: new Date(), recordedBy: "ci" });
      expect([ok.withinTarget, slow.withinTarget, low.withinTarget]).toEqual([true, false, false]);
      expect(ok).toMatchObject({ kind: "capacity", unit: "requests_per_second", value: 120 });
    });

    it("the database refuses a unit that does not match the kind", async () => {
      await expect(db().query("insert into platform.slo_measurements (id, kind, source, value, unit, recorded_by, measured_at) values ('slm_badunit01', 'rpo', 'manual', 1, 'requests_per_second', 'x', clock_timestamp())")).rejects.toThrow();
      await expect(recordMeasurement(db(), { kind: "rpo", source: "manual", value: 1, recordedBy: "x", measuredAt: new Date(Date.now() + 3_600_000) })).rejects.toMatchObject({ code: "invalid_input" });
    });
  });

  describe("operator report", () => {
    it("lists every objective, each labelled provisional, with the pending decision stated", async () => {
      const report = await buildSloReport(db());
      expect(report.label).toBe("Provisional, not approved");
      expect(report.approval).toMatchObject({ status: "not_approved", pendingDecision: "DEC-BUSINESS" });
      expect(report.objectives.map((o) => o.id)).toEqual(["control_plane_availability", "api_latency", "dispatch_latency", "workflow_completion", "scheduler_health", "capacity", "rpo", "rto"]);
      for (const o of report.objectives) {
        expect(o.status).toBe("provisional");
        expect(o.label).toBe("Provisional, not approved");
        expect(o.state).not.toBe("unavailable");
      }
      expect(JSON.stringify(report)).not.toMatch(/approvedBy|approver/i);
    });

    it("never reports RPO, RTO or capacity as met before something measured them", async () => {
      metricsRegistry().reset();
      resetSloRecorderForTests();
      const fresh = await openPlatformDb({ kind: "pglite" });
      try {
        const report = await buildSloReport(fresh);
        const measured = report.objectives.filter((o) => ["rpo", "rto", "capacity"].includes(o.id));
        expect(measured).toHaveLength(3);
        for (const o of measured) { expect(o.state, o.id).toBe("not_measured"); expect(o.current).toBeNull(); }
        // ratio objectives with no events say so instead of claiming to meet their target
        for (const o of report.objectives.filter((x) => ["control_plane_availability", "workflow_completion", "dispatch_latency"].includes(x.id))) expect(o.state, o.id).toBe("no_data");
      } finally { await fresh.close(); }
    });

    it("judges the latest measurement against the current provisional target", async () => {
      const f = new Date(Date.now() - 600_000);
      await reportRecoveryRehearsal(db(), { source: "restore-rehearsal", failureAt: f, dataRecoveredThrough: new Date(f.getTime() - 60_000), serviceRestoredAt: new Date(f.getTime() + 600), recordedBy: "r" });
      const objectives = Object.fromEntries((await buildSloReport(db())).objectives.map((o) => [o.id, o]));
      expect(objectives.rpo.state).toBe("met");
      expect(objectives.rto.state).toBe("met");
      expect(objectives.rpo.measurements?.[0]).toBeDefined();
    });
  });

  describe("routes", () => {
    it("GET /api/admin/ops/slo is for platform operators only", async () => {
      mocks.session.mockResolvedValue(null);
      expect((await sloRoute.GET(request("GET", "/api/admin/ops/slo"))).status).toBe(401);
      mocks.session.mockResolvedValue({ id: STRANGER, email: "x@example.com" });
      expect((await sloRoute.GET(request("GET", "/api/admin/ops/slo"))).status).toBe(403);
      mocks.session.mockResolvedValue({ id: OPERATOR, email: "op@example.com" });
      const res = await sloRoute.GET(request("GET", "/api/admin/ops/slo"));
      expect(res.status).toBe(200);
      const body = await res.json() as { label: string; objectives: unknown[] };
      expect(body.label).toBe("Provisional, not approved");
      expect(body.objectives).toHaveLength(8);
    });

    it("POST /api/internal/slo/measurements needs the cron bearer", async () => {
      const body = { kind: "capacity", sustainedRps: 50, p95Ms: 100, errorRate: 0, durationSeconds: 20, concurrency: 8, environment: "route test", measuredAt: new Date().toISOString(), recordedBy: "ci" };
      expect((await measurementsRoute.POST(request("POST", "/api/internal/slo/measurements", body))).status).toBe(401);
      expect((await measurementsRoute.POST(request("POST", "/api/internal/slo/measurements", body, { authorization: "Bearer wrong" }))).status).toBe(401);
      const ok = await measurementsRoute.POST(request("POST", "/api/internal/slo/measurements", body, { authorization: `Bearer ${SECRET}` }));
      expect(ok.status).toBe(201);
      const json = await ok.json() as { label: string; recorded: { kind: string; withinTarget: boolean }[] };
      expect(json.label).toBe("Provisional, not approved");
      expect(json.recorded[0]).toMatchObject({ kind: "capacity", withinTarget: true });
    });

    it("POST /api/internal/slo/measurements records a rehearsal and refuses an impossible one", async () => {
      const f = new Date(Date.now() - 600_000);
      const auth = { authorization: `Bearer ${SECRET}` };
      const good = { kind: "recovery", source: "restore-rehearsal", failureAt: f.toISOString(), dataRecoveredThrough: new Date(f.getTime() - 120_000).toISOString(), serviceRestoredAt: new Date(f.getTime() + 300_000).toISOString(), recordedBy: "rehearsal" };
      const ok = await measurementsRoute.POST(request("POST", "/api/internal/slo/measurements", good, auth));
      expect(ok.status).toBe(201);
      const recorded = (await ok.json() as { recorded: { kind: string; value: number }[] }).recorded;
      expect(recorded.map((r) => [r.kind, r.value])).toEqual([["rpo", 120], ["rto", 300]]);
      const impossible = { ...good, dataRecoveredThrough: new Date(f.getTime() + 1000).toISOString() };
      expect((await measurementsRoute.POST(request("POST", "/api/internal/slo/measurements", impossible, auth))).status).toBe(400);
      expect((await measurementsRoute.POST(request("POST", "/api/internal/slo/measurements", { kind: "recovery", extra: 1 }, auth))).status).toBe(400);
    });
  });
});
