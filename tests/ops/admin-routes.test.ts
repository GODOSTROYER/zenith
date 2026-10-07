/**
 * PROD-OPS-02: the operator routes (maintenance and quotas) and the Prometheus route, against a real
 * PGlite control store. The session lookup is mocked (that is Supabase); authorization, same-origin,
 * validation, optimistic versioning, audit history and the effect on live admission are real.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";

const OPERATOR = "0b9d4e1c-1111-4222-8333-444455556666";
const STRANGER = "9a8b7c6d-1111-4222-8333-444455556666";

const mocks = vi.hoisted(() => ({ session: vi.fn(), db: undefined as unknown as PlatformDbHandle }));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: mocks.session }));
vi.mock("@/lib/ops/operator", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ops/operator")>()), opsStore: async () => mocks.db }));

const maintenance = await import("@/app/api/admin/ops/maintenance/route");
const quotas = await import("@/app/api/admin/ops/quotas/route");
const metricsRoute = await import("@/app/api/internal/metrics/route");
const { beginRequest } = await import("@/lib/ops/admission");
const { buildRuntime, opsRuntime, setOpsRuntimeForTests } = await import("@/lib/ops/runtime");
const { opsLimitsFromEnv } = await import("@/lib/ops/config");

const ORIGIN = "http://zenith.test";
const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`${ORIGIN}${path}`, { method, headers: { origin: ORIGIN, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const asOperator = () => mocks.session.mockResolvedValue({ id: OPERATOR, email: "op@example.com" });

let handle: PlatformDbHandle;
beforeAll(async () => { handle = mocks.db = await openPlatformDb({ kind: "pglite" }); }, 60_000);
afterAll(async () => { await handle.close(); });
beforeEach(() => {
  vi.stubEnv("ZENITH_OPS_ADMIN_IDS", OPERATOR);
  setOpsRuntimeForTests(buildRuntime(opsLimitsFromEnv({ ZENITH_OPS_MAINTENANCE_CACHE_MS: "0" }), async () => handle));
  mocks.session.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); setOpsRuntimeForTests(undefined); });

describe("operator authorization", () => {
  it("refuses an anonymous caller with 401 and a signed-in non-operator with 403, on every method", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await maintenance.GET(json("GET", "/api/admin/ops/maintenance"))).status).toBe(401);
    expect((await maintenance.PUT(json("PUT", "/api/admin/ops/maintenance", { mode: "off" }))).status).toBe(401);
    mocks.session.mockResolvedValue({ id: STRANGER, email: "x@example.com" });
    expect((await maintenance.GET(json("GET", "/api/admin/ops/maintenance"))).status).toBe(403);
    expect((await maintenance.PUT(json("PUT", "/api/admin/ops/maintenance", { mode: "read_only", reason: "no" }))).status).toBe(403);
    expect((await quotas.PUT(json("PUT", "/api/admin/ops/quotas", { workspaceId: "ws_x", weight: 9 }))).status).toBe(403);
    expect((await quotas.DELETE(json("DELETE", "/api/admin/ops/quotas?workspaceId=ws_x"))).status).toBe(403);
    expect((await quotas.GET(json("GET", "/api/admin/ops/quotas"))).status).toBe(403);
  });

  it("grants nothing when no operator is configured, and ignores a workspace role or a malformed id list", async () => {
    vi.stubEnv("ZENITH_OPS_ADMIN_IDS", "");
    mocks.session.mockResolvedValue({ id: OPERATOR, email: "op@example.com" });
    expect((await maintenance.GET(json("GET", "/api/admin/ops/maintenance"))).status).toBe(403);
    vi.stubEnv("ZENITH_OPS_ADMIN_IDS", "not-a-uuid,*,admin");
    expect((await maintenance.GET(json("GET", "/api/admin/ops/maintenance"))).status).toBe(403);
  });

  it("refuses a cross-origin mutation even from an operator", async () => {
    asOperator();
    const res = await maintenance.PUT(json("PUT", "/api/admin/ops/maintenance", { mode: "read_only", reason: "csrf" }, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    const site = await maintenance.PUT(json("PUT", "/api/admin/ops/maintenance", { mode: "read_only", reason: "csrf" }, { "sec-fetch-site": "cross-site" }));
    expect(site.status).toBe(403);
  });
});

describe("maintenance route", () => {
  it("enters read-only maintenance, takes effect on live admission at once, records who and why, and leaves again", async () => {
    asOperator();
    const entered = await maintenance.PUT(json("PUT", "/api/admin/ops/maintenance", { mode: "read_only", reason: "failover drill" }));
    expect(entered.status).toBe(200);
    const body = (await entered.json()) as { effective: { mode: string; reason: string; version: number }; stored: { updatedBy: string }; history: { actor: string; mode: string }[]; drain: { drained: boolean } };
    expect(body.effective).toMatchObject({ mode: "read_only", reason: "failover drill" });
    expect(body.stored.updatedBy).toBe(OPERATOR);
    expect(body.history[0]).toMatchObject({ actor: OPERATOR, mode: "read_only" });
    expect(typeof body.drain.drained).toBe("boolean");

    // The same process's admission layer now refuses writes, keeps reads, and keeps this route reachable.
    vi.stubEnv("ZENITH_PLATFORM_DB", "pglite");
    const headers = new Headers();
    await expect(beginRequest({ method: "POST", pathname: "/api/projects", headers, requestId: "r" })).rejects.toMatchObject({ code: "maintenance_read_only", status: 503 });
    (await beginRequest({ method: "GET", pathname: "/api/projects", headers, requestId: "r" })).finish(200);
    (await beginRequest({ method: "PUT", pathname: "/api/admin/ops/maintenance", headers, requestId: "r" })).finish(200);

    const left = await maintenance.PUT(json("PUT", "/api/admin/ops/maintenance", { mode: "off", expectedVersion: body.effective.version }));
    expect(left.status).toBe(200);
    expect(((await left.json()) as { effective: { mode: string } }).effective.mode).toBe("off");
    (await beginRequest({ method: "POST", pathname: "/api/projects", headers, requestId: "r" })).finish(200);
  });

  it("GET reports the effective mode, the stored row, the host override and the drain status", async () => {
    asOperator();
    vi.stubEnv("ZENITH_MAINTENANCE_MODE", "dispatch_paused");
    vi.stubEnv("ZENITH_MAINTENANCE_REASON", "host override");
    setOpsRuntimeForTests(undefined); // rebuild from the environment
    expect(opsRuntime().limits.maintenanceOverride?.mode).toBe("dispatch_paused");
    const res = await maintenance.GET(json("GET", "/api/admin/ops/maintenance"));
    const body = (await res.json()) as { effective: { mode: string; source: string }; hostOverride: { mode: string }; drain: Record<string, unknown> };
    expect(body.effective).toMatchObject({ mode: expect.stringMatching(/dispatch_paused|read_only/) });
    expect(body.hostOverride.mode).toBe("dispatch_paused");
    expect(Object.keys(body.drain)).toEqual(expect.arrayContaining(["queuedOperations", "runningOperations", "queuedRunnerJobs", "activeRunnerJobs", "drained", "busiest"]));
  });

  it("validates the body strictly and requires a reason to enter; a stale version is a 409", async () => {
    asOperator();
    // Make sure the single row exists so a stale expectedVersion is a conflict rather than a first insert.
    await (await import("@/lib/ops/store")).setMaintenance(handle, { mode: "off", reason: "", actor: "test" });
    expect((await maintenance.PUT(json("PUT", "/api/admin/ops/maintenance", { mode: "sideways" }))).status).toBe(400);
    expect((await maintenance.PUT(json("PUT", "/api/admin/ops/maintenance", { mode: "read_only", reason: "x", extra: 1 }))).status).toBe(400);
    expect((await maintenance.PUT(json("PUT", "/api/admin/ops/maintenance", { mode: "read_only" }))).status).toBe(400); // no reason
    expect((await maintenance.PUT(json("PUT", "/api/admin/ops/maintenance", { mode: "off", expectedVersion: 9999 }))).status).toBe(409);
    expect((await maintenance.PUT(new NextRequest(`${ORIGIN}/api/admin/ops/maintenance`, { method: "PUT", headers: { origin: ORIGIN }, body: "{}" }))).status).toBe(415); // not JSON
  });
});

describe("quota route", () => {
  it("creates, lists, reads, replaces and deletes a workspace's overrides with an audit-visible version", async () => {
    asOperator();
    const put = await quotas.PUT(json("PUT", "/api/admin/ops/quotas", { workspaceId: "ws_route_a", weight: 3, maxActiveOperations: 40, apiBurst: null }));
    expect(put.status).toBe(200);
    const created = ((await put.json()) as { quota: { weight: number; version: number; updatedBy: string; maxActiveOperations: number } }).quota;
    expect(created).toMatchObject({ weight: 3, version: 1, updatedBy: OPERATOR, maxActiveOperations: 40 });
    const one = (await (await quotas.GET(json("GET", "/api/admin/ops/quotas?workspaceId=ws_route_a"))).json()) as { quota: { weight: number }; defaults: { api: { burst: number } } };
    expect(one.quota.weight).toBe(3);
    expect(one.defaults.api.burst).toBe(200);
    const list = (await (await quotas.GET(json("GET", "/api/admin/ops/quotas"))).json()) as { quotas: { workspaceId: string }[] };
    expect(list.quotas.map((q) => q.workspaceId)).toContain("ws_route_a");
    expect((await quotas.PUT(json("PUT", "/api/admin/ops/quotas", { workspaceId: "ws_route_a", weight: 5, expectedVersion: 99 }))).status).toBe(409);
    const del = await quotas.DELETE(json("DELETE", "/api/admin/ops/quotas?workspaceId=ws_route_a"));
    expect(((await del.json()) as { removed: boolean }).removed).toBe(true);
    expect(((await (await quotas.GET(json("GET", "/api/admin/ops/quotas?workspaceId=ws_route_a"))).json()) as { quota: unknown }).quota).toBeNull();
  });

  it("changes live admission for that workspace: a lowered concurrency override is enforced on the next request", async () => {
    asOperator();
    await quotas.PUT(json("PUT", "/api/admin/ops/quotas", { workspaceId: "ws_route_b", maxConcurrentRequests: 1 }));
    const headers = new Headers();
    const first = await beginRequest({ method: "GET", pathname: "/api/x", headers, requestId: "1" });
    await first.bindWorkspace("ws_route_b");
    const second = await beginRequest({ method: "GET", pathname: "/api/x", headers, requestId: "2" });
    await expect(second.bindWorkspace("ws_route_b")).rejects.toMatchObject({ code: "concurrency_exceeded", status: 429 });
    second.finish(429);
    first.finish(200);
    await quotas.DELETE(json("DELETE", "/api/admin/ops/quotas?workspaceId=ws_route_b"));
  });

  it("rejects invalid values and malformed ids", async () => {
    asOperator();
    for (const body of [{ workspaceId: "ws a!", weight: 1 }, { workspaceId: "ws_c", weight: 0 }, { workspaceId: "ws_c", weight: 101 }, { workspaceId: "ws_c", apiBurst: 0 }, { workspaceId: "ws_c", surprise: true }, { weight: 2 }])
      expect((await quotas.PUT(json("PUT", "/api/admin/ops/quotas", body))).status, JSON.stringify(body)).toBe(400);
    expect((await quotas.DELETE(json("DELETE", "/api/admin/ops/quotas"))).status).toBe(400);
    expect((await quotas.GET(json("GET", "/api/admin/ops/quotas?workspaceId=bad%20id"))).status).toBe(400);
  });
});

describe("GET /api/internal/metrics", () => {
  const get = (token?: string) => new NextRequest(`${ORIGIN}/api/internal/metrics`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

  it("is refused without the scheduler bearer, and refused when none is configured", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret-for-this-test");
    expect((await metricsRoute.GET(get())).status).toBe(401);
    expect((await metricsRoute.GET(get("wrong"))).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "");
    expect((await metricsRoute.GET(get("anything"))).status).toBe(503);
  });

  it("serves Prometheus text with every cataloged series family, including the store-up gauge", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret-for-this-test");
    const res = await metricsRoute.GET(get("s3cret-for-this-test"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    for (const name of ["zenith_api_requests_total", "zenith_admission_decisions_total", "zenith_maintenance_mode", "zenith_control_store_up", "zenith_runner_queue_depth_total", "zenith_worker_fair_waiting"])
      expect(text, name).toContain(`# TYPE ${name}`);
  });
});
