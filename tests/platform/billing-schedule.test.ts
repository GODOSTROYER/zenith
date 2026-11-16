/** Durable MAN-06 integration using the real PGlite billing store. No Stripe/network calls. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openPlatformDb, repos } from "@/lib/controlplane/db";
import { DEFAULT_PLAN_ID } from "@/lib/billing/plans";
import { assignPlan } from "@/lib/billing/store";
import { CRITICAL_JOBS, CRITICAL_JOB_NAMES, MAINTENANCE_JOBS, criticalJobHealth, runCriticalJob } from "@/lib/platform/critical-jobs";

let db: Awaited<ReturnType<typeof openPlatformDb>>;
beforeAll(async () => { db = await openPlatformDb({ kind: "pglite" }); }, 60_000);
afterAll(async () => { await db?.close(); });
afterEach(() => vi.unstubAllEnvs());

describe("durable billing schedule", () => {
  it("does not exempt missing billing health when every other fallback-capable job has run", async () => {
    const peers = CRITICAL_JOB_NAMES.filter(job => job !== "billing" && !("durableOnly" in CRITICAL_JOBS[job]));
    for (const job of peers) await runCriticalJob(db, job, "temporal", async () => ({ value: {} }));
    const health = await criticalJobHealth(db);
    expect(health.jobs.filter(row => peers.includes(row.job)).every(row => row.state === "healthy")).toBe(true);
    expect(health.jobs.find(row => row.job === "billing")).toMatchObject({ state: "never_run", durable: false });
    expect(health.healthy).toBe(false);
  });
  it("registers billing in the shared maintenance activity and records disabled mode without network", async () => {
    vi.stubEnv("ZENITH_BILLING", "disabled");
    expect(CRITICAL_JOBS.billing).toMatchObject({ cadenceMs: 60_000, leaseTtlMs: 120_000, kind: "billing" });
    expect(CRITICAL_JOBS.billing).not.toHaveProperty("durableOnly");
    expect(await runCriticalJob(db, "billing", "temporal", () => MAINTENANCE_JOBS.billing(db))).toMatchObject({ status: "ok", value: { enabled: false } });
    expect(await repos.scheduledJobs.getScheduledJob(db, "billing")).toMatchObject({ lastSuccessSource: "temporal", lastStatus: "ok" });
  });
  it("runs real metering/invoicing/dunning on natural-time durable records in managed mode", async () => {
    vi.stubEnv("ZENITH_BILLING", "managed");
    vi.stubEnv("ZENITH_BILLING_STRIPE_SECRET_KEY", "");
    await assignPlan(db, { workspaceId: "billing-schedule-contract", planId: DEFAULT_PLAN_ID, actor: "test:operator", reason: "contract" });
    const result = await runCriticalJob(db, "billing", "temporal", () => MAINTENANCE_JOBS.billing(db));
    expect(result).toMatchObject({ status: "ok", value: { enabled: true, accounts: 1, invoicing: "not_configured", invoiceErrors: 0 } });
    expect((await criticalJobHealth(db)).jobs.find(j => j.job === "billing")).toMatchObject({ state: "healthy", durable: true });
  });
  it("excludes overlapping billing passes with the existing fenced lease", async () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const first = runCriticalJob(db, "billing", "temporal", async () => { enter(); await held; return { value: {} }; });
    await entered;
    try { expect(await runCriticalJob(db, "billing", "temporal", async () => { throw new Error("must never execute"); })).toEqual({ status: "busy" }); }
    finally { release(); await first; }
  });
});
