/**
 * PROD-OPS-02: maintenance mode policy, its cache, the config parser and the edge shield.
 * Pure: no database, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackpressureError } from "@/lib/ops/errors";
import { MaintenanceCache, assertApiWritable, assertDispatchAllowed, effectiveMaintenance, exemptFromReadOnly, isControlLane, type MaintenanceState } from "@/lib/ops/maintenance";
import { opsAdminIds, opsLimitsFromEnv } from "@/lib/ops/config";
import { clientKey, edgeAdmit, fingerprint, resetEdgeForTests } from "@/lib/ops/edge";

const off: MaintenanceState = { mode: "off", reason: "", version: 0, source: "default" };
const stored = (mode: MaintenanceState["mode"], reason = "upgrade"): MaintenanceState => ({ mode, reason, version: 3, updatedBy: "u", source: "database" });

describe("effectiveMaintenance", () => {
  it("takes the stricter of the stored state and the host override", () => {
    expect(effectiveMaintenance(off, undefined)).toEqual(off);
    expect(effectiveMaintenance(stored("dispatch_paused"), { mode: "read_only", reason: "host" })).toMatchObject({ mode: "read_only", source: "environment" });
    expect(effectiveMaintenance(stored("read_only"), { mode: "dispatch_paused", reason: "host" })).toMatchObject({ mode: "read_only", source: "database" });
    expect(effectiveMaintenance(off, { mode: "dispatch_paused", reason: "host" })).toMatchObject({ mode: "dispatch_paused", source: "environment" });
  });
});

describe("read-only maintenance", () => {
  const readOnly = stored("read_only");

  it("refuses mutating API calls with a 503 and Retry-After, and says nothing was changed", () => {
    for (const [method, path] of [["POST", "/api/platform/v1/operations/op_1/approve"], ["PUT", "/api/platform/v1/workspace/policy"], ["DELETE", "/api/projects/p1"], ["PATCH", "/api/x"]]) {
      try {
        assertApiWritable(readOnly, path, method);
        throw new Error("expected a refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(BackpressureError);
        const e = error as BackpressureError;
        expect(e.status).toBe(503);
        expect(e.code).toBe("maintenance_read_only");
        expect(e.retryAfterSec).toBeGreaterThanOrEqual(1);
        expect(e.message).toContain("nothing was changed");
      }
    }
  });

  it("keeps reads working", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) expect(() => assertApiWritable(readOnly, "/api/platform/v1/operations", method)).not.toThrow();
  });

  it("keeps the drain path working: runner and machine poll, heartbeat, result and logs; cron ticks; the operator route", () => {
    const keep: [string, string][] = [
      ["POST", "/api/platform/v1/runners/run_1/poll"], ["POST", "/api/platform/v1/runners/run_1/heartbeat"],
      ["POST", "/api/platform/v1/runners/run_1/jobs/job_1/result"], ["POST", "/api/platform/v1/runners/run_1/jobs/job_1/logs"],
      ["POST", "/api/platform/v1/machines/mac_1/poll"], ["POST", "/api/platform/v1/machines/mac_1/jobs/job_9/result"],
      ["POST", "/api/internal/tick/reconcile"], ["GET", "/api/internal/tick/status"],
      ["PUT", "/api/admin/ops/maintenance"], ["PUT", "/api/admin/ops/quotas"],
      ["POST", "/api/hosted/policy/admit"], ["POST", "/api/hosted/session/terminate"],
      ["POST", "/hosted-gateway/app.apps.example.com/submit"],
      ["POST", "/api/agent/v3/mcp"],
    ];
    for (const [method, path] of keep) expect(exemptFromReadOnly(path, method), `${method} ${path}`).toBe(true);
    // Registration creates state, so it is refused; so is a near-miss path.
    expect(exemptFromReadOnly("/api/platform/v1/runners/register", "POST")).toBe(false);
    expect(exemptFromReadOnly("/api/platform/v1/runners/run_1/jobs/job_1/result/extra", "POST")).toBe(false);
    expect(exemptFromReadOnly("/api/platform/v1/runners/../operations/op_1/approve", "POST")).toBe(false);
    expect(exemptFromReadOnly("/api/admin/opsx", "POST")).toBe(false);
  });

  it("does not block writes in dispatch_paused or off", () => {
    expect(() => assertApiWritable(stored("dispatch_paused"), "/api/x", "POST")).not.toThrow();
    expect(() => assertApiWritable(off, "/api/x", "POST")).not.toThrow();
  });
});

describe("dispatch pause", () => {
  it("refuses new dispatch in dispatch_paused and read_only, with the tenant attached for correlation, and not when off", () => {
    expect(() => assertDispatchAllowed(off)).not.toThrow();
    for (const mode of ["dispatch_paused", "read_only"] as const) {
      try {
        assertDispatchAllowed(stored(mode), "ws_1");
        throw new Error("expected a refusal");
      } catch (error) {
        const e = error as BackpressureError;
        expect(e.code).toBe("maintenance_dispatch_paused");
        expect(e.status).toBe(503);
        expect(e.tenant).toBe("ws_1");
        expect(e.message).toContain("not claimed");
      }
    }
  });
});

describe("control lanes", () => {
  it("are exactly the paths draining and recovery depend on", () => {
    expect(isControlLane("/api/platform/v1/runners/run_1/poll")).toBe(true);
    expect(isControlLane("/api/internal/tick/runbooks")).toBe(true);
    expect(isControlLane("/api/admin/ops/maintenance")).toBe(true);
    expect(isControlLane("/hosted-gateway/x")).toBe(true);
    expect(isControlLane("/api/platform/v1/operations")).toBe(false);
    expect(isControlLane("/api/agent/v3/mcp")).toBe(false); // limited, not exempt
    expect(isControlLane("/api/projects")).toBe(false);
  });
});

describe("MaintenanceCache", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("reuses a read for the TTL, refreshes after it, and runs one load at a time", async () => {
    let calls = 0;
    const cache = new MaintenanceCache(async () => { calls++; return stored("read_only", `n${calls}`); }, { ttlMs: 2000 });
    expect((await cache.get()).reason).toBe("n1");
    await Promise.all([cache.get(), cache.get()]);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(2001);
    const [a, b] = await Promise.all([cache.get(), cache.get()]);
    expect(calls).toBe(2);
    expect(a.reason).toBe("n2");
    expect(b.reason).toBe("n2");
  });

  it("keeps the last known state when the store fails, so a store outage never clears a maintenance window", async () => {
    let fail = false;
    const cache = new MaintenanceCache(async () => { if (fail) throw new Error("db down"); return stored("read_only"); }, { ttlMs: 1000 });
    expect((await cache.get()).mode).toBe("read_only");
    fail = true;
    await vi.advanceTimersByTimeAsync(1001);
    expect((await cache.get()).mode).toBe("read_only");
    expect(cache.failures).toBe(1);
  });

  it("does not stall a request on a hung store: it answers with the last known state after the timeout", async () => {
    const cache = new MaintenanceCache(() => new Promise<MaintenanceState>(() => undefined), { ttlMs: 1000, timeoutMs: 500 });
    const pending = cache.get();
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toMatchObject({ mode: "off", source: "default" });
  });

  it("can be primed by the operator route so this process sees a change immediately", async () => {
    const cache = new MaintenanceCache(async () => off, { ttlMs: 60_000 });
    cache.prime(stored("dispatch_paused"));
    expect((await cache.get()).mode).toBe("dispatch_paused");
  });
});

describe("opsLimitsFromEnv", () => {
  it("has bounded, safe defaults", () => {
    const l = opsLimitsFromEnv({});
    expect(l.issues).toEqual([]);
    expect(l.api).toMatchObject({ ratePerSec: 50, burst: 200, maxConcurrentPerTenant: 16, maxInFlight: 256 });
    expect(l.dispatch.maxActiveOperations).toBe(25);
    expect(l.runnerQueue).toEqual({ maxPerTenant: 200, maxGlobal: 5000 });
    expect(l.maintenanceOverride).toBeUndefined();
  });

  it("falls back to the default and reports an issue for a malformed or out-of-range value, never throws", () => {
    const l = opsLimitsFromEnv({ ZENITH_OPS_API_BURST: "-4", ZENITH_OPS_API_RATE_PER_SEC: "fast", ZENITH_OPS_RETRY_AFTER_SEC: "999999", ZENITH_OPS_TRUSTED_IP_HEADER: "x-evil", ZENITH_MAINTENANCE_MODE: "sideways" });
    expect(l.api.burst).toBe(200);
    expect(l.api.ratePerSec).toBe(50);
    expect(l.retryAfterSec).toBe(5);
    expect(l.edge.trustedIpHeader).toBeUndefined();
    expect(l.maintenanceOverride).toBeUndefined();
    expect(l.issues).toHaveLength(5);
  });

  it("parses the host-level maintenance override and bounds its reason", () => {
    const l = opsLimitsFromEnv({ ZENITH_MAINTENANCE_MODE: "read_only", ZENITH_MAINTENANCE_REASON: "x".repeat(900) });
    expect(l.maintenanceOverride?.mode).toBe("read_only");
    expect(l.maintenanceOverride?.reason.length).toBe(300);
    expect(opsLimitsFromEnv({ ZENITH_MAINTENANCE_MODE: "off" }).maintenanceOverride).toBeUndefined();
  });

  it("accepts only UUID operator ids", () => {
    const ok = "0b9d4e1c-1111-4222-8333-444455556666";
    expect([...opsAdminIds({ ZENITH_OPS_ADMIN_IDS: `${ok}, not-a-uuid ,` })]).toEqual([ok]);
    expect(opsAdminIds({}).size).toBe(0);
  });
});

describe("edge shield", () => {
  const headers = (init: Record<string, string> = {}) => new Headers(init);
  beforeEach(() => { resetEdgeForTests(); });

  it("rate limits one client, with a Retry-After, without touching another client", async () => {
    const env = { ZENITH_OPS_EDGE_RATE_PER_SEC: "1", ZENITH_OPS_EDGE_BURST: "3" };
    const mine = { method: "GET", pathname: "/api/projects", headers: headers({ authorization: "Bearer aaa" }) };
    const theirs = { method: "GET", pathname: "/api/projects", headers: headers({ authorization: "Bearer bbb" }) };
    for (let i = 0; i < 3; i++) expect(edgeAdmit(mine, env)).toBeNull();
    const refused = edgeAdmit(mine, env);
    expect(refused?.status).toBe(429);
    expect(Number(refused?.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(((await refused?.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
    expect(edgeAdmit(theirs, env)).toBeNull();
  });

  it("never limits control lanes or non-API paths", () => {
    const env = { ZENITH_OPS_EDGE_RATE_PER_SEC: "0.1", ZENITH_OPS_EDGE_BURST: "1" };
    const lane = { method: "POST", pathname: "/api/platform/v1/runners/run_1/poll", headers: headers({ authorization: "Bearer aaa" }) };
    for (let i = 0; i < 50; i++) expect(edgeAdmit(lane, env)).toBeNull();
    const page = { method: "GET", pathname: "/overview", headers: headers({ cookie: "a=b" }) };
    for (let i = 0; i < 50; i++) expect(edgeAdmit(page, env)).toBeNull();
  });

  it("applies the host read-only override to mutating API calls but not to reads, lanes or the data plane", async () => {
    const env = { ZENITH_MAINTENANCE_MODE: "read_only", ZENITH_MAINTENANCE_REASON: "database upgrade" };
    const post = edgeAdmit({ method: "POST", pathname: "/api/projects", headers: headers() }, env);
    expect(post?.status).toBe(503);
    expect(post?.headers.get("retry-after")).toBe("30");
    expect(((await post?.json()) as { error: { message: string } }).error.message).toContain("database upgrade");
    expect(edgeAdmit({ method: "GET", pathname: "/api/projects", headers: headers() }, env)).toBeNull();
    expect(edgeAdmit({ method: "POST", pathname: "/api/platform/v1/runners/r/jobs/j/result", headers: headers() }, env)).toBeNull();
    expect(edgeAdmit({ method: "POST", pathname: "/hosted-gateway/app.example/submit", headers: headers() }, env)).toBeNull();
  });

  it("keys a client by trusted-header IP when configured, else by a credential fingerprint that is not the credential", () => {
    const withIp = clientKey({ method: "GET", pathname: "/api/x", headers: headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1", authorization: "Bearer secret" }) }, "x-forwarded-for");
    expect(withIp).toEqual({ key: "ip:203.0.113.9", identified: true });
    const byCred = clientKey({ method: "GET", pathname: "/api/x", headers: headers({ authorization: "Bearer secret-token-value" }) }, undefined);
    expect(byCred.identified).toBe(true);
    expect(byCred.key).not.toContain("secret");
    expect(clientKey({ method: "GET", pathname: "/api/x", headers: headers() }, undefined)).toEqual({ key: "anon", identified: false });
    expect(fingerprint("a")).not.toBe(fingerprint("b"));
    expect(fingerprint("a")).toBe(fingerprint("a"));
  });
});
