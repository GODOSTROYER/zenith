/** Scheduler/auth contracts with synthetic product and platform ports. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type ModeledFallback = (job: string, run: (db: object, signal: AbortSignal) => Promise<{ value: object }>, idle: object) => Promise<object>;
const fake = vi.hoisted(() => ({
  boot: vi.fn(async () => undefined), platform: vi.fn(async () => true),
  maintenance: vi.fn(async () => ({ ran: true, idempotencyKeys: 2, nonces: 3, uncertain: 4, expired: 5 })),
  db: vi.fn(async () => ({})), reaper: vi.fn(async () => ({ ran: true, jobs: 0 })), flush: vi.fn(async () => undefined),
  runbooks: vi.fn(async () => ({ ran: true, created: 0, missed: 0, blocked: 0, executed: 0 })),
  fallback: vi.fn<ModeledFallback>(),
}));
vi.mock("@/lib/server/boot", () => ({ ensureBoot: fake.boot }));
vi.mock("@/lib/platform/app", () => ({ ensurePlatformApp: fake.platform, platformRunnerReaperPass: fake.reaper, reapRunnerJobs: fake.reaper }));
vi.mock("@/lib/platform/housekeeping", () => ({ housekeepingPass: fake.maintenance }));
vi.mock("@/lib/platform/runbooks", () => ({ runbookTickPass: fake.runbooks }));
// Model the durable lease adapter only; the real job inventory, composers and
// counters still select and call the existing platform-only implementations.
vi.mock("@/lib/platform/critical-jobs", async (importOriginal) => {
  const current = await importOriginal<typeof import("@/lib/platform/critical-jobs")>();
  return { ...current, runFallbackJob: fake.fallback };
});
vi.mock("@/lib/controlplane/db", () => ({ platformDb: fake.db }));
vi.mock("@/lib/db/store", () => ({ db: () => ({ deployments: [] }), isPostgres: () => false, flushPendingAsync: fake.flush }));
vi.mock("@/lib/db/request-snapshot", () => ({ outsideSnapshot: (fn: () => unknown) => fn() }));
vi.mock("@/lib/engine/engine", () => ({ engine: { resumeInFlight: () => undefined }, engineTick: () => undefined }));
vi.mock("@/lib/alerts", () => ({ evaluateAll: () => 0, replayOutbox: async () => 0 }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }, withRequestId: (_: string, fn: () => unknown) => fn(), currentRequestId: () => undefined }));
import { cronRoute, housekeepingTickPass, runScheduledPass, scheduledPasses, SCHEDULER_SLOW_EVERY } from "@/lib/server/cron";

const globals = globalThis as typeof globalThis & { __zenithCronPassRunning?: boolean; __zenithCronPassCount?: number };
beforeEach(() => {
  vi.clearAllMocks(); fake.platform.mockResolvedValue(true); fake.db.mockResolvedValue({});
  fake.maintenance.mockResolvedValue({ ran: true, idempotencyKeys: 2, nonces: 3, uncertain: 4, expired: 5 });
  fake.reaper.mockResolvedValue({ ran: true, jobs: 0 });
  fake.runbooks.mockResolvedValue({ ran: true, created: 0, missed: 0, blocked: 0, executed: 0 });
  fake.fallback.mockImplementation(async (_job, run) => (await run(await fake.db(), new AbortController().signal)).value);
  vi.stubEnv("CRON_SECRET", "synthetic-cron-secret"); vi.stubEnv("ZENITH_PLATFORM_DB", "pglite");
  delete globals.__zenithCronPassRunning; delete globals.__zenithCronPassCount;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); delete globals.__zenithCronPassRunning; delete globals.__zenithCronPassCount; });
const request = (token = "synthetic-cron-secret", query = "?housekeeping=1") => new NextRequest(`https://zenith.test/api/internal/tick/jobs${query}`, { method: "POST", headers: { authorization: `Bearer ${token}` } });

describe("housekeeping cron wiring", () => {
  it("authenticates before boot, store open or housekeeping work", async () => {
    const legacy = vi.fn(async () => ({ jobs: 0 })); const route = cronRoute("jobs", legacy);
    expect((await route(request("wrong"))).status).toBe(401);
    vi.stubEnv("CRON_SECRET", ""); expect((await route(request())).status).toBe(503);
    expect(fake.boot).not.toHaveBeenCalled(); expect(fake.platform).not.toHaveBeenCalled(); expect(fake.db).not.toHaveBeenCalled(); expect(fake.maintenance).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled();
    expect(fake.fallback).not.toHaveBeenCalled();
  });

  it("runs the distinct platform-only jobs query without loading the product snapshot", async () => {
    const legacy = vi.fn(async () => ({ jobs: 0 }));
    const response = await cronRoute("jobs", legacy)(request());
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ pass: "housekeeping", ok: true, ran: true, idempotencyKeys: 2, nonces: 3, uncertain: 4, expired: 5 });
    expect(fake.maintenance).toHaveBeenCalledOnce(); expect(fake.boot).not.toHaveBeenCalled(); expect(fake.flush).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled();
    expect(fake.fallback).toHaveBeenCalledExactlyOnceWith("housekeeping", expect.any(Function), { ran: false, idempotencyKeys: 0, nonces: 0, uncertain: 0, expired: 0 });
    expect(fake.maintenance).toHaveBeenCalledExactlyOnceWith(await fake.db.mock.results[0].value);
  });

  it("preserves the existing jobs tick and all other route behavior", async () => {
    const legacy = vi.fn(async () => ({ jobs: 7 }));
    const response = await cronRoute("jobs", legacy)(request("synthetic-cron-secret", ""));
    expect(await response.json()).toMatchObject({ pass: "jobs", jobs: 7 });
    expect(fake.boot).toHaveBeenCalledOnce(); expect(fake.flush).toHaveBeenCalledOnce(); expect(legacy).toHaveBeenCalledOnce(); expect(fake.maintenance).not.toHaveBeenCalled();
    expect(fake.fallback).not.toHaveBeenCalled();
    const other = await cronRoute("alerts", legacy)(request()); expect(await other.json()).toMatchObject({ pass: "alerts", jobs: 7 });
  });

  it("reports an unconfigured platform honestly, without silently opening a default store", async () => {
    vi.stubEnv("ZENITH_PLATFORM_DB", ""); vi.stubEnv("ZENITH_PLATFORM_DB_URL", ""); vi.stubEnv("SUPABASE_DB_URL", "");
    expect(await housekeepingTickPass()).toEqual({ ran: false, idempotencyKeys: 0, nonces: 0, uncertain: 0, expired: 0 }); expect(fake.db).not.toHaveBeenCalled();
    vi.stubEnv("ZENITH_PLATFORM_DB", "pglite"); fake.platform.mockResolvedValue(false);
    expect(await housekeepingTickPass()).toMatchObject({ ran: false }); expect(fake.maintenance).not.toHaveBeenCalled();
  });

  it("returns fixed guidance for a failed maintenance pass without exposing raw input", async () => {
    fake.maintenance.mockRejectedValue(new Error("postgres://user:synthetic-secret-canary@db.test/app"));
    const response = await cronRoute("jobs", async () => ({}))(request());
    expect(response.status).toBe(503); const body = await response.text(); expect(body).toContain("housekeeping"); expect(body).not.toContain("synthetic-secret-canary");
  });

  it("adds maintenance to slow scheduler passes while preserving reaping, and skips overlapping ticks", async () => {
    const engine = vi.spyOn(scheduledPasses, "engine").mockResolvedValue({ deployments: 0, ticks: 0, remaining: 0, timedOut: false, ms: 0 });
    const alerts = vi.spyOn(scheduledPasses, "alerts").mockResolvedValue({ changed: 0 });
    const outbox = vi.spyOn(scheduledPasses, "outbox").mockResolvedValue({ pending: 0 });
    expect(await runScheduledPass()).toMatchObject({ housekeeping: { ran: true } });
    for (let i = 1; i < SCHEDULER_SLOW_EVERY; i++) expect((await runScheduledPass())?.housekeeping).toBeUndefined();
    expect(await runScheduledPass()).toMatchObject({ housekeeping: { ran: true } });
    expect(engine).toHaveBeenCalledTimes(SCHEDULER_SLOW_EVERY + 1); expect(alerts).toHaveBeenCalledTimes(2); expect(outbox).toHaveBeenCalledTimes(2); expect(fake.reaper).toHaveBeenCalledTimes(2); expect(fake.maintenance).toHaveBeenCalledTimes(2);
    expect(fake.fallback.mock.calls.map(([job]) => job)).toEqual(["runner-reaper", "housekeeping", "runbooks", "runner-reaper", "housekeeping", "runbooks"]);
    expect(fake.fallback.mock.calls.filter(([job]) => job === "runner-reaper").map(([, , idle]) => idle)).toEqual([{ ran: false, jobs: 0 }, { ran: false, jobs: 0 }]);
    expect(fake.fallback.mock.calls.filter(([job]) => job === "housekeeping").map(([, , idle]) => idle)).toEqual(Array.from({ length: 2 }, () => ({ ran: false, idempotencyKeys: 0, nonces: 0, uncertain: 0, expired: 0 })));
    expect(fake.fallback.mock.calls.filter(([job]) => job === "runbooks").map(([, , idle]) => idle)).toEqual(Array.from({ length: 2 }, () => ({ ran: false, created: 0, missed: 0, blocked: 0, executed: 0 })));
    expect(fake.runbooks).toHaveBeenCalledTimes(2);
    expect(fake.runbooks.mock.calls).toEqual([[{ budgetMs: 15_000 }], [{ budgetMs: 15_000 }]]);
    globals.__zenithCronPassRunning = true; expect(await runScheduledPass()).toBeNull();
  });
});
