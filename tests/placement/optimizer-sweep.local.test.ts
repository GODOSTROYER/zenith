/** Actual default worker/schedule, human HTTP consent, native PostgreSQL and retained real Prometheus history. */
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Connection, Client } from "@temporalio/client";
import { describe, expect, it } from "vitest";
import { openPlatformDb } from "@/lib/controlplane/db";
import { assertCompatibleReconcileSchedule, inspectReconcileObservation, RECONCILE_SCHEDULE_ID } from "@/lib/workflows/reconcile-schedule";
import { DEFAULT_OPTIMIZER_POLICY } from "@/lib/placement/optimizer";

describe.skipIf(process.env.ZENITH_TEST_COST_DEFAULT_SWEEP !== "1")("actual default measured optimizer sweep", () => {
  it("does not propose before consent, proposes bounded unexecuted changes after consent and retains cooldown on another natural pass", async () => {
    const base = new URL(process.env.ZENITH_TEST_COST_OPT_IN_BASE_URL ?? "");
    const pgUrl = process.env.ZENITH_TEST_PLATFORM_PG_URL ?? "";
    if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) || !["http:", "https:"].includes(base.protocol) || base.username || base.password
      || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(pgUrl).hostname)) throw new Error("Default sweep acceptance needs owned loopback services.");
    const address = process.env.ZENITH_TEST_COST_TEMPORAL_ADDRESS ?? "";
    if (!/^(localhost|127\.0\.0\.1):[0-9]{1,5}$/.test(address)) throw new Error("Supply the owned loopback Temporal address.");
    const workspaceId = process.env.ZENITH_TEST_COST_WORKSPACE_ID ?? "", environmentId = process.env.ZENITH_TEST_COST_ENVIRONMENT_ID ?? "";
    const cookieFile = process.env.ZENITH_TEST_COST_HUMAN_COOKIE_FILE ?? "";
    if (![workspaceId, environmentId].every(id => /^[A-Za-z0-9_-]{1,100}$/.test(id)) || !isAbsolute(cookieFile)) throw new Error("Supply local scope IDs and an absolute human-cookie file.");
    const cookie = readFileSync(cookieFile, "utf8").trim();
    if (!cookie || /[\r\n]/.test(cookie)) throw new Error("Cookie file must contain one header value.");
    const headers = { cookie, "x-zenith-workspace": workspaceId };
    const request = (path: string, init: RequestInit = {}) => fetch(new URL(path, base), { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    const path = `/api/platform/v1/environments/${environmentId}/optimizer`;
    const get = async () => {
      const response = await request(path, { headers }); expect(response.status).toBe(200);
      const settings = await response.json() as { enabled: boolean; version: number };
      expect(typeof settings.enabled).toBe("boolean"); expect(Number.isInteger(settings.version)).toBe(true);
      return settings;
    };
    const set = async (enabled: boolean) => {
      const current = await get();
      const response = await request(path, { method: "POST", headers: { ...headers, origin: base.origin, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ enabled, expectedVersion: current.version }) });
      expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ proposalOnly: true, settings: { enabled } });
    };
    const db = await openPlatformDb({ kind: "postgres", url: pgUrl, migrate: false, max: 1 });
    let connection: Connection | undefined;
    let consent = false;
    try {
      connection = await Connection.connect({ address, connectTimeout: 5000 });
      const client = new Client({ connection, namespace: "default" });
      assertCompatibleReconcileSchedule(await client.schedule.getHandle(RECONCILE_SCHEDULE_ID).describe());
      expect((await get()).enabled).toBe(false);
      const [clock] = await db.query<{ at: string }>("select clock_timestamp() as at");
      const since = clock!.at;
      const operations = () => db.query<{ id: string; status: string; approval_required: boolean; started_at: string | null; runner_job_id: string | null }>(
        `select id,status,approval_required,started_at,runner_job_id from platform.operations
          where workspace_id=$1 and environment_id=$2 and capability='service.scale'
            and principal->>'kind'='system' and principal->>'id'='optimizer' and created_at >= $3::timestamptz order by seq`, [workspaceId, environmentId, since]);
      const nextPass = async (after: number) => {
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          const observation = await inspectReconcileObservation(client);
          if (observation.observationCurrent && (observation.completedAtUnixMs ?? 0) > after) return observation.completedAtUnixMs!;
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        throw new Error("No confirmed natural default sweep completed within its bound.");
      };
      const optedOutPass = await nextPass(Date.parse(since));
      expect(await operations()).toEqual([]);
      consent = true; await set(true);
      const enabledPass = await nextPass(optedOutPass);
      const proposals = await operations();
      expect(proposals.length, "requires real seven-day complete underutilization, actual policies and exact human-approved ownership transfers").toBeGreaterThan(0);
      expect(proposals.length).toBeLessThanOrEqual(DEFAULT_OPTIMIZER_POLICY.maxChangesPerWindow);
      expect(proposals.every(op => op.approval_required && ["proposed", "awaiting_approval"].includes(op.status) && op.started_at === null && op.runner_job_id === null)).toBe(true);
      await nextPass(enabledPass);
      expect(await operations()).toEqual(proposals);
    } finally {
      try { if (consent) await set(false); }
      finally { try { await connection?.close(); } finally { await db.close(); } }
    }
  }, 300_000);
});
