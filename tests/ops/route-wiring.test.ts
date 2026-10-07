/**
 * PROD-OPS-02 reachability: the real `route()` wrapper (under every product and platform API route)
 * applies admission, answers refusals as 429/503 + Retry-After, and returns a traceparent.
 * File-store demo mode, exactly like tests/api/serverless-flush.test.ts: no mocks of route() itself.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-ops-route-", { fast: true });

const { db, resetDb, flush } = await import("@/lib/db/store");
const { route, currentRequest } = await import("@/lib/server/request");
const { buildRuntime, setOpsRuntimeForTests } = await import("@/lib/ops/runtime");
const { opsLimitsFromEnv } = await import("@/lib/ops/config");
const { BackpressureError } = await import("@/lib/ops/errors");
const { parseTraceparent } = await import("@/lib/ops/telemetry/tracing");
const { platformRoute } = await import("@/app/api/platform/v1/_lib/http");

const noStore = async (): Promise<never> => { throw new Error("no control store in this test"); };
const install = (env: Record<string, string>) => setOpsRuntimeForTests(buildRuntime(opsLimitsFromEnv(env), noStore));
const call = (handler: ReturnType<typeof route>, method = "GET", path = "/api/test") =>
  handler(new NextRequest(`http://zenith.test${path}`, { method }), { params: Promise.resolve({}) });

describe("route() admission wiring", () => {
  beforeEach(() => {
    delete process.env.ZENITH_PLATFORM_DB;
    delete process.env.ZENITH_PLATFORM_DB_URL;
    delete process.env.SUPABASE_DB_URL;
    delete process.env.VERCEL;
    delete process.env.ZENITH_SERVERLESS;
    resetDb();
    flush();
    db().workspaces.push({ id: "ws_ops", slug: "ops", name: "Ops", createdAt: new Date().toISOString() });
  });
  afterEach(() => { setOpsRuntimeForTests(undefined); });

  it("passes a normal request through and hands back a traceparent beside the request id", async () => {
    install({});
    let seen: string | undefined;
    const res = await call(route(async () => { seen = currentRequest()?.workspace?.id; return { ok: true }; }));
    expect(res.status).toBe(200);
    expect(seen).toBe("ws_ops");
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect(parseTraceparent(res.headers.get("traceparent"))).toBeDefined();
  });

  it("rate limits the resolved workspace: 429, Retry-After, the platform error body, and the handler never runs", async () => {
    install({ ZENITH_OPS_API_RATE_PER_SEC: "0.1", ZENITH_OPS_API_BURST: "2" });
    let runs = 0;
    const handler = route(async () => { runs++; return { ok: true }; });
    expect((await call(handler)).status).toBe(200);
    expect((await call(handler)).status).toBe(200);
    const refused = await call(handler);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(refused.headers.get("x-request-id")).toBeTruthy();
    expect(((await refused.json()) as { error: { code: string; retryAfterSec: number } }).error).toMatchObject({ code: "rate_limited" });
    expect(runs).toBe(2);
  });

  it("sheds load at the in-flight ceiling with 503 and frees the slot when the request completes", async () => {
    install({ ZENITH_OPS_API_MAX_IN_FLIGHT: "1" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const slow = route(async () => { started(); await gate; return { ok: true }; });
    const first = call(slow);
    await running;
    const shed = await call(route(async () => ({ ok: true })));
    expect(shed.status).toBe(503);
    expect(shed.headers.get("retry-after")).toBeTruthy();
    expect(((await shed.json()) as { error: { code: string } }).error.code).toBe("overloaded");
    release();
    expect((await first).status).toBe(200);
    expect((await call(route(async () => ({ ok: true })))).status).toBe(200);
  });

  it("enforces host-level read-only maintenance on mutating routes only, answering 503 with the reason", async () => {
    install({ ZENITH_MAINTENANCE_MODE: "read_only", ZENITH_MAINTENANCE_REASON: "storage migration" });
    let runs = 0;
    const handler = route(async () => { runs++; return { ok: true }; });
    const refused = await call(handler, "POST");
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("30");
    expect(((await refused.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "maintenance_read_only" });
    expect(runs).toBe(0);
    expect((await call(handler, "GET")).status).toBe(200);
    // A control lane (runner result) is never refused by read-only maintenance.
    expect((await call(handler, "POST", "/api/platform/v1/runners/run_1/jobs/job_1/result")).status).toBe(200);
  });

  it("answers a BackpressureError thrown deep inside a handler as 429/503 + Retry-After, never as a 500", async () => {
    install({});
    const res = await call(route(async () => { throw new BackpressureError("queue_full", "runner_queue", "This workspace already has 200 runner jobs waiting.", 12, "ws_ops"); }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("12");
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("queue_full");
    const paused = await call(route(async () => { throw new BackpressureError("maintenance_dispatch_paused", "maintenance", "New work is paused.", 30); }));
    expect(paused.status).toBe(503);
    expect(paused.headers.get("retry-after")).toBe("30");
  });

  it("the platform API wrapper answers a dispatch refusal with the platform error body and Retry-After", async () => {
    install({});
    const handler = platformRoute(async () => { throw new BackpressureError("concurrency_exceeded", "dispatch", "This workspace already has 25 operations running or queued.", 30, "ws_ops"); });
    const res = await handler(new NextRequest("http://zenith.test/api/platform/v1/operations/op_1/start-portability", { method: "POST" }), { params: Promise.resolve({}) });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(((await res.json()) as { error: { code: string; fix: string } }).error).toMatchObject({ code: "concurrency_exceeded" });
  });
});
