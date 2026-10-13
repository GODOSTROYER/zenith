/**
 * PROD-OPS-01 / DEC-BUSINESS against a REAL engine: PGlite always, PostgreSQL when ZENITH_TEST_PLATFORM_PG_URL is set. Covers
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
import type { Sql } from "@/lib/controlplane/types";
import { TARGET_LABEL } from "@/lib/slo/definitions";
import { reportCapacityTest, reportRecoveryRehearsal, reportRestoreCompletion } from "@/lib/slo/recovery";
import { flushSloSamples, managedRuntimeTally, recordManagedRuntimeHealth, reportExternalProbe, resetSloRecorderForTests, SLI_EXTERNAL_PROBE, SLI_MANAGED_RUNTIME, SLI_MANAGED_RUNTIME_UNKNOWN, type RuntimeObservationInput } from "@/lib/slo/recorder";
import { buildSloReport, lowerOfSources, PROBE_NOT_REPORTING_NOTICE } from "@/lib/slo/report";
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

const readinessRoute = await import("@/app/api/internal/recovery/readiness/route");
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

  it("records database completion separately, withholding RTO until first application health, idempotently", async () => {
    const reference = `restore_${randomBytes(8).toString("hex")}`;
    const f = new Date(Date.now() - 3600_000);
    const input = { reference, recordedBy: "operator", failureAt: f, dataRecoveredThrough: new Date(f.getTime() - 60_000), restoreStartedAt: new Date(f.getTime() + 60_000), databaseRestoreFinishedAt: new Date(f.getTime() + 180_000) };
    expect((await reportRestoreCompletion(db(), input)).map(m => m.kind)).toEqual(["database_restore"]);
    expect(await reportRestoreCompletion(db(), input)).toEqual([]);
    const applicationHealthyAt = new Date(f.getTime() + 420_000);
    const rows = await reportRestoreCompletion(db(), { ...input, applicationHealthyAt });
    expect(rows.map(m => [m.kind, m.value])).toEqual([["application_health", 360], ["rpo", 60], ["rto", 420]]);
    expect(await reportRestoreCompletion(db(), { ...input, applicationHealthyAt })).toEqual([]);
    const samples = await db().query<{ kind: string }>("select kind from platform.slo_measurements where details->>'reference' = $1 order by seq", [reference]);
    expect(samples.map(m => m.kind)).toEqual(["database_restore", "application_health", "rpo", "rto"]);
    await expect(reportRestoreCompletion(db(), { ...input, applicationHealthyAt: input.restoreStartedAt })).rejects.toThrow(/order/);
  });

  it("readiness refuses unauthenticated, unknown and old epochs and answers the current fenced application", async () => {
    const restoreRunId = `restore_${randomBytes(8).toString("hex")}`;
    const url = `/api/internal/recovery/readiness?restoreRunId=${restoreRunId}`;
    expect((await readinessRoute.GET(request("GET", url))).status).toBe(401);
    const auth = { authorization: `Bearer ${SECRET}` };
    expect((await readinessRoute.GET(request("GET", url, undefined, auth))).status).toBe(503);
    await db().query("insert into platform.recovery_epochs (epoch, kind, actor, reason, restore_run_id) select max(epoch)+1, 'restore', 'operator', 'test recovery readiness', $1 from platform.recovery_epochs", [restoreRunId]);
    const ready = await readinessRoute.GET(request("GET", url, undefined, auth));
    expect(ready.status).toBe(200); expect(await ready.json()).toMatchObject({ ready: true, restoreRunId });
    await db().query("insert into platform.recovery_epochs (epoch, kind, actor, reason, restore_run_id) select max(epoch)+1, 'restore', 'operator', 'new recovery', $1 from platform.recovery_epochs", [`${restoreRunId}_later`]);
    expect((await readinessRoute.GET(request("GET", url, undefined, auth))).status).toBe(503);
  });

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

    it("dispatch latency counts operations that needed no approval and started within the threshold, and ignores human waits with no recorded approval", async () => {
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

    /** An operation with explicit ages (seconds before now): created, started (or never) and each approval. */
    async function dispatchOp(o: { status: string; approvalRequired: boolean; createdAgo: number; startedAgo?: number; approvalsAgo?: number[] }) {
      const { operation, workspaceId } = await seedApprovedOperation(db(), newWorkspace());
      await db().query(
        `update platform.operations set status = $2, approval_required = $3,
           created_at = clock_timestamp() - make_interval(secs => $4::int),
           started_at = case when $5::int is null then null else clock_timestamp() - make_interval(secs => $5::int) end
         where id = $1`,
        [operation.id, o.status, o.approvalRequired, o.createdAgo, o.startedAgo ?? null]);
      let n = 0;
      for (const ago of o.approvalsAgo ?? []) {
        await db().query(
          `insert into platform.approvals (id, operation_id, workspace_id, proposal_digest, decision, approver, approver_id, approver_role, policy_version, created_at, expires_at)
           values ($1, $2, $3, $4, 'approve', '{}'::jsonb, $5, 'admin', 'v1', clock_timestamp() - make_interval(secs => $6::int), clock_timestamp() + interval '1 day')`,
          [`apr_${randomBytes(8).toString("hex")}`, operation.id, workspaceId, "a".repeat(64), `approver-${n++}`, ago]);
      }
      return operation.id;
    }

    it("dispatch latency starts the clock at the LAST required approval, not at creation", async () => {
      const before = await dispatchLatencyWindows(db(), 30, 30);
      // created 10 minutes ago, approvals 300 s and 100 s ago, started 90 s ago: 10 s after the last approval (good; it would be a miss from creation)
      await dispatchOp({ status: "succeeded", approvalRequired: true, createdAgo: 600, approvalsAgo: [300, 100], startedAgo: 90 });
      // approved 200 s ago, started 100 s ago: waited 100 s after approval (miss)
      await dispatchOp({ status: "succeeded", approvalRequired: true, createdAgo: 600, approvalsAgo: [200], startedAgo: 100 });
      // an operation that needed approval but has no recorded approval has no eligibility instant: not counted
      await dispatchOp({ status: "succeeded", approvalRequired: true, createdAgo: 600, startedAgo: 100 });
      // no approval needed, created 40 s ago, started 5 s ago: 35 s (miss)
      await dispatchOp({ status: "succeeded", approvalRequired: false, createdAgo: 40, startedAgo: 5 });
      const after = await dispatchLatencyWindows(db(), 30, 30);
      expect(after.budget.total - before.budget.total).toBeGreaterThanOrEqual(3);
      expect(after.budget.good - before.budget.good).toBeGreaterThanOrEqual(1);
      if (lane.name === "pglite") {
        expect(after.budget.total - before.budget.total).toBe(3);
        expect(after.budget.good - before.budget.good).toBe(1);
      }
    });

    it("dispatch latency counts an approved or queued operation as a miss once it has waited past the threshold since eligibility, and only then", async () => {
      const before = await dispatchLatencyWindows(db(), 30, 30);
      await dispatchOp({ status: "queued", approvalRequired: true, createdAgo: 900, approvalsAgo: [120] });      // waiting 120 s after approval: miss
      await dispatchOp({ status: "approved", approvalRequired: false, createdAgo: 200 });                       // waiting 200 s since creation: miss
      await dispatchOp({ status: "queued", approvalRequired: true, createdAgo: 900, approvalsAgo: [5] });        // 5 s after approval: not late yet
      await dispatchOp({ status: "approved", approvalRequired: true, createdAgo: 900 });                        // no approval recorded: not counted
      await dispatchOp({ status: "cancelled", approvalRequired: false, createdAgo: 900 });                      // never started: not counted
      const after = await dispatchLatencyWindows(db(), 30, 30);
      expect(after.budget.total - before.budget.total).toBeGreaterThanOrEqual(2);
      if (lane.name === "pglite") { expect(after.budget.good - before.budget.good).toBe(0); expect(after.budget.total - before.budget.total).toBe(2); }
      // the miss is dated when it became late (eligible + 30 s): 120 s approval age -> 90 s ago, so it is inside the 5 minute window but not twice
      expect(after["5m"].total - before["5m"].total).toBeGreaterThanOrEqual(2);
    });
  });

  describe("external probe and managed runtime", () => {
    const aligned = (agoMs: number): Date => new Date(Math.floor((Date.now() - agoMs) / 300_000) * 300_000);
    const farWindow = (): Date => aligned((20 + Math.floor(Math.random() * 10)) * 86_400_000 + Math.floor(Math.random() * 1500) * 300_000);
    const probeRow = async (at: Date) => (await db().query<{ good: string; total: string }>("select good::text, total::text from platform.slo_samples where sli = $1 and bucket_start = $2::timestamptz", [SLI_EXTERNAL_PROBE, at.toISOString()]))[0];
    const auth = () => ({ authorization: `Bearer ${SECRET}` });
    const probeBody = (at: Date, over: Record<string, unknown> = {}) => ({ kind: "external_probe", windowStart: at.toISOString(), windowSeconds: 300, good: 9, total: 10, recordedBy: "uptime-probe-1", ...over });

    it("POST external_probe records a window under its own SLI, idempotently, and replaces on correction", async () => {
      const at = farWindow();
      const post = (body: unknown) => measurementsRoute.POST(request("POST", "/api/internal/slo/measurements", body, auth()));
      const first = await post(probeBody(at));
      expect(first.status).toBe(201);
      const json = await first.json() as { label: string; recorded: { kind: string; sli: string; good: number; total: number }[] };
      expect(json.label).toBe(TARGET_LABEL);
      expect(json.recorded[0]).toMatchObject({ kind: "external_probe", sli: "external_probe_availability", good: 9, total: 10 });
      expect(await probeRow(at)).toEqual({ good: "9", total: "10" });
      expect((await post(probeBody(at))).status).toBe(201);
      expect(await probeRow(at)).toEqual({ good: "9", total: "10" });
      expect((await post(probeBody(at, { good: 10 }))).status).toBe(201);
      expect(await probeRow(at)).toEqual({ good: "10", total: "10" });
    });

    it("POST external_probe needs the bearer and refuses malformed, misaligned, impossible and future windows", async () => {
      const at = farWindow();
      expect((await measurementsRoute.POST(request("POST", "/api/internal/slo/measurements", probeBody(at)))).status).toBe(401);
      expect((await measurementsRoute.POST(request("POST", "/api/internal/slo/measurements", probeBody(at), { authorization: "Bearer wrong" }))).status).toBe(401);
      const refuse = async (body: unknown) => (await measurementsRoute.POST(request("POST", "/api/internal/slo/measurements", body, auth()))).status;
      expect(await refuse(probeBody(new Date(at.getTime() + 60_000)))).toBe(400);   // not aligned to 5 minutes
      expect(await refuse(probeBody(at, { good: 11 }))).toBe(400);                  // good above total
      expect(await refuse(probeBody(at, { total: 0, good: 0 }))).toBe(400);         // a probe that sent nothing says nothing
      expect(await refuse(probeBody(at, { good: -1 }))).toBe(400);
      expect(await refuse(probeBody(at, { windowSeconds: 60 }))).toBe(400);
      expect(await refuse(probeBody(at, { extra: true }))).toBe(400);
      expect(await refuse(probeBody(new Date(aligned(0).getTime() + 3_600_000)))).toBe(400);   // ends in the future
      expect(await refuse(probeBody(aligned(40 * 86_400_000)))).toBe(400);                      // older than the retention
      expect(await probeRow(at)).toBeUndefined();
    });

    it("control-plane availability is the LOWER of the request-based and probe-based ratios, naming both", async () => {
      metricsRegistry().reset();
      resetSloRecorderForTests();
      const fresh = await openPlatformDb({ kind: "pglite" });
      const find = async () => (await buildSloReport(fresh)).objectives.find((o) => o.id === "control_plane_availability")!;
      try {
        // no probe: request-based only, with the explicit notice
        await addSamples(fresh, [{ sli: "api_availability", good: 9990, total: 10_000 }]);
        let o = await find();
        expect(o.current).toBeCloseTo(0.999, 6);
        expect(o.sources).toMatchObject({ probeReporting: false, basis: "request_based_only", notice: PROBE_NOT_REPORTING_NOTICE });
        expect(o.sources?.requestBased.current).toBeCloseTo(0.999, 6);
        expect(o.sources?.externalProbe).toEqual({ good: 0, total: 0, current: null });
        expect(o.note).toBe(PROBE_NOT_REPORTING_NOTICE);
        expect(PROBE_NOT_REPORTING_NOTICE).toMatch(/cannot see outages that stop requests arriving/);
        // probe reports an outage the requests could not see: the probe ratio is lower and wins
        await reportExternalProbe(fresh, { windowStart: aligned(600_000), good: 90, total: 100 });
        o = await find();
        expect(o.sources).toMatchObject({ probeReporting: true, basis: "lower_of_request_and_probe" });
        expect(o.sources?.notice).toBeUndefined();
        expect(o.sources?.externalProbe.current).toBeCloseTo(0.9, 9);
        expect(o.current).toBeCloseTo(0.9, 9);
        expect(o.state).toBe("breaching");
        expect(o.note).toBeUndefined();
        // probe healthier than requests: the request-based ratio wins
        await reportExternalProbe(fresh, { windowStart: aligned(600_000), good: 100, total: 100 });
        o = await find();
        expect(o.current).toBeCloseTo(0.999, 6);
        expect(o.state).toBe("meeting");
        expect(o.sources?.basis).toBe("lower_of_request_and_probe");
      } finally { await fresh.close(); }
    });

    it("lowerOfSources works window by window and ignores a source with no events", () => {
      const w = (good: number, total: number) => ({ good, total });
      const mk = (g: ReturnType<typeof w>) => ({ "5m": g, "30m": g, "1h": g, "6h": g, "3d": g, budget: g });
      expect(lowerOfSources(mk(w(99, 100)), mk(w(90, 100))).budget).toEqual(w(90, 100));
      expect(lowerOfSources(mk(w(90, 100)), mk(w(99, 100))).budget).toEqual(w(90, 100));
      expect(lowerOfSources(mk(w(99, 100)), mk(w(0, 0))).budget).toEqual(w(99, 100));
      expect(lowerOfSources(mk(w(0, 0)), mk(w(9, 10))).budget).toEqual(w(9, 10));
    });

    const obs = (over: Partial<RuntimeObservationInput> = {}): RuntimeObservationInput => ({ provider: "zenith", nativeType: "k8s:Deployment", health: "healthy", counts: { desired: 2, ready: 2 }, ...over });

    it("managed runtime tally: healthy is good, degraded or unhealthy is bad, unknown is counted apart, other workloads are ignored", () => {
      const all = [
        obs(),
        obs({ health: "degraded", counts: { desired: 3, ready: 1 } }),
        obs({ health: "unhealthy", counts: { desired: 2, ready: 0 } }),
        obs({ health: "unknown", counts: {} }),
        obs({ health: "degraded", counts: { desired: 2, ready: 2 } }),                 // rollout in progress, every desired replica ready: serving
        obs({ health: "degraded", counts: { desired: 0, ready: 0 } }),                 // scaled to zero on purpose
        obs({ provider: "kubernetes" }),                                                // customer cluster: not the managed runtime
        obs({ provider: "aws", nativeType: "aws:ecs_service" }),
        obs({ nativeType: "k8s:CronJob" }),
      ];
      expect(managedRuntimeTally("production", all)).toEqual({ good: 2, bad: 2, unknown: 1, scaledToZero: 1 });
      for (const cls of ["staging", "development", "sandbox"]) expect(managedRuntimeTally(cls, all), cls).toEqual({ good: 0, bad: 0, unknown: 0, scaledToZero: 0 });
    });

    it("managed runtime samples make the objective no_data until they exist, then a real ratio; unknown observations stay out of it", async () => {
      metricsRegistry().reset();
      resetSloRecorderForTests();
      const fresh = await openPlatformDb({ kind: "pglite" });
      const find = async () => (await buildSloReport(fresh)).objectives.find((o) => o.id === "managed_runtime_availability")!;
      try {
        let o = await find();
        expect(o).toMatchObject({ state: "no_data", current: null, kind: "ratio", status: "target" });
        expect(o.targetText).toBe("99.9% good events");
        // one unknown observation alone is not a sample of the ratio
        expect(await recordManagedRuntimeHealth(fresh, "production", [obs({ health: "unknown", counts: {} })])).toEqual({ good: 0, bad: 0, unknown: 1, scaledToZero: 0 });
        o = await find();
        expect(o.state).toBe("no_data");
        expect(o.note).toMatch(/1 observation of unknown health/);
        expect((await sampleWindows(fresh, SLI_MANAGED_RUNTIME_UNKNOWN, 30)).budget).toEqual({ good: 0, total: 1 });
        // two healthy and one unhealthy
        await recordManagedRuntimeHealth(fresh, "production", [obs(), obs(), obs({ health: "unhealthy", counts: { desired: 1, ready: 0 } })]);
        o = await find();
        expect(o.state).toBe("breaching");
        expect(o.current).toBeCloseTo(2 / 3, 9);
        expect((await sampleWindows(fresh, SLI_MANAGED_RUNTIME, 30)).budget).toEqual({ good: 2, total: 3 });
        // a non-production environment writes nothing
        await recordManagedRuntimeHealth(fresh, "staging", [obs(), obs()]);
        expect((await sampleWindows(fresh, SLI_MANAGED_RUNTIME, 30)).budget).toEqual({ good: 2, total: 3 });
        await recordManagedRuntimeHealth(fresh, "production", Array.from({ length: 2000 }, () => obs()));
        o = await find();
        expect(o.state).toBe("meeting");
      } finally { await fresh.close(); }
    });

    it("a failing sample write never propagates out of the managed runtime recorder", async () => {
      const broken = { query: async () => { throw new Error("store down"); } } as unknown as Sql;
      await expect(recordManagedRuntimeHealth(broken, "production", [obs()])).resolves.toBeNull();
    });
  });

  describe("RPO, RTO and capacity hooks", () => {
    const failureAt = new Date(Date.now() - 36_000_000);

    it("derives RPO and RTO from the three instants and records both append-only against the targets", async () => {
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

    it("flags a rehearsal that exceeds the targets rather than hiding it", async () => {
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
    it("lists every objective as an approved launch target, not a contractual SLA, with the approval recorded once", async () => {
      const report = await buildSloReport(db());
      expect(report.label).toBe(TARGET_LABEL);
      expect(report.approved).toBe(true);
      expect(report.approval).toMatchObject({ status: "approved_targets", decision: "DEC-BUSINESS", approvedBy: "Arnav Bule", approvedAt: "2026-10-13", commitment: "engineering_target" });
      expect(report.nextMilestone).toEqual({ objective: "control_plane_availability", target: 0.9999, status: "aspiration" });
      expect(report.objectives.map((o) => o.id)).toEqual(["control_plane_availability", "managed_runtime_availability", "api_latency", "dispatch_latency", "workflow_completion", "scheduler_health", "capacity", "rpo", "rto"]);
      for (const o of report.objectives) {
        expect(o.status).toBe("target");
        expect(o.label).toBe(TARGET_LABEL);
        expect(o.state).not.toBe("unavailable");
      }
      expect(JSON.stringify(report.objectives)).not.toMatch(/approvedBy|approver|service credit|contractual SLA offered/i);
      expect(report.objectives.some((o) => "target" in o)).toBe(false);
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
        for (const o of report.objectives.filter((x) => ["control_plane_availability", "managed_runtime_availability", "workflow_completion", "dispatch_latency"].includes(x.id))) expect(o.state, o.id).toBe("no_data");
        const availability = report.objectives.find((x) => x.id === "control_plane_availability")!;
        expect(availability.sources?.notice).toBe(PROBE_NOT_REPORTING_NOTICE);
      } finally { await fresh.close(); }
    });

    it("judges the latest measurement against the current target", async () => {
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
      expect(body.label).toBe(TARGET_LABEL);
      expect(body.objectives).toHaveLength(9);
    });

    it("POST /api/internal/slo/measurements needs the cron bearer", async () => {
      const body = { kind: "capacity", sustainedRps: 50, p95Ms: 100, errorRate: 0, durationSeconds: 20, concurrency: 8, environment: "route test", measuredAt: new Date().toISOString(), recordedBy: "ci" };
      expect((await measurementsRoute.POST(request("POST", "/api/internal/slo/measurements", body))).status).toBe(401);
      expect((await measurementsRoute.POST(request("POST", "/api/internal/slo/measurements", body, { authorization: "Bearer wrong" }))).status).toBe(401);
      const ok = await measurementsRoute.POST(request("POST", "/api/internal/slo/measurements", body, { authorization: `Bearer ${SECRET}` }));
      expect(ok.status).toBe(201);
      const json = await ok.json() as { label: string; recorded: { kind: string; withinTarget: boolean }[] };
      expect(json.label).toBe(TARGET_LABEL);
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
