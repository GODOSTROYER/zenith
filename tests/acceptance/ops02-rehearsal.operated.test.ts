/**
 * PROD-OPS-02 operational rehearsal (docs/platform/operations/CONTROL-PLANE-FAIRNESS.md "Operational rehearsal") on an
 * owned, already running lean J1 stack.
 *
 *  1. Read-only maintenance: an operator with step-up sets read_only. A write answers 503 with Retry-After, a read still
 *     answers and the drain reports drained. The mode is put back to off (also on failure) before anything else runs.
 *  2. Control-store outage: the API is recreated with an unreachable ZENITH_PLATFORM_DB_URL. Its metrics report
 *     zenith_control_store_up 0 and reads degrade to defaults instead of failing. The composition is then restored.
 *  3. Flood: the operator gives one workspace a tight API quota (/api/admin/ops/quotas) and drives it past that limit until
 *     it is answered 429. A second workspace, on the defaults, is never answered 429. The quota is then deleted.
 *
 * Gated: ZENITH_LOCAL_OPS_REHEARSAL=1 with ZENITH_DEFAULT_STACK_DIRECTORY and ZENITH_DEFAULT_MAILPIT_URL naming the stack.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Page } from "@playwright/test";
import { browserRequest, ok } from "../e2e/default/support.mjs";
import { openRealSession, stepUpWithAuthenticator } from "../../scripts/acceptance/live/product/mix-03-driver";
import { withApiEnvironment } from "../../scripts/release/drivers/stack-env";

const gated = process.env.ZENITH_LOCAL_OPS_REHEARSAL === "1";

/** One same-origin request from the page, with the status and the Retry-After header (browserRequest drops headers). */
const raw = (page: Page, endpoint: string, method: string, workspaceId: string, body?: unknown) => page.evaluate(async ({ endpoint, method, workspaceId, body }) => {
  const response = await fetch(endpoint, { method, credentials: "same-origin", redirect: "error",
    headers: { "x-zenith-workspace": workspaceId, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, retryAfter: response.headers.get("retry-after") };
}, { endpoint, method, workspaceId, body });

/** A burst of reads from one page, returning how many came back with each status. */
const burst = (page: Page, workspaceId: string, count: number) => page.evaluate(async ({ workspaceId, count }) => {
  const statuses = await Promise.all(Array.from({ length: count }, () => fetch("/api/workspace/invitations", { credentials: "same-origin", headers: { "x-zenith-workspace": workspaceId } }).then(r => r.status, () => 0)));
  return statuses.reduce<Record<string, number>>((counts, status) => ({ ...counts, [status]: (counts[status] ?? 0) + 1 }), {});
}, { workspaceId, count });

describe.skipIf(!gated)("PROD-OPS-02 operated rehearsal: maintenance, control-store outage and per-workspace fairness", () => {
  it("serves reads but refuses writes in read_only, degrades during a store outage and throttles only the flooding workspace", async () => {
    const directory = process.env.ZENITH_DEFAULT_STACK_DIRECTORY!;
    const a = await openRealSession(process.env), b = await openRealSession(process.env);
    const secret = randomBytes(32).toString("hex");
    let api = await withApiEnvironment(directory, { ZENITH_OPS_ADMIN_IDS: a.tenant.ownerId, CRON_SECRET: secret });
    const owner = a.tenant.owner, ws = a.tenant.workspaceId;
    try {
      // 1. Read-only maintenance.
      await stepUpWithAuthenticator(owner, a.tenant.stack, a.tenant.ownerSecret);
      const set = (mode: string) => browserRequest(owner, "/api/admin/ops/maintenance", { mode, reason: "PROD-OPS-02 operated rehearsal" }, "PUT", ws);
      ok(await set("read_only"));
      try {
        const write = await raw(owner, "/api/actions/project.create", "POST", ws, { mode: "execute", input: { name: "ops02 refused", withEnvironment: false }, scope: {}, idempotencyKey: randomBytes(12).toString("hex") });
        expect(write.status).toBe(503);
        expect(Number(write.retryAfter)).toBeGreaterThan(0);
        expect((await raw(owner, "/api/workspace/invitations", "GET", ws)).status).toBe(200);
        const state = ok(await browserRequest(owner, "/api/admin/ops/maintenance", undefined, "GET", ws)) as { effective?: { mode?: string }; drain?: { drained?: boolean } };
        expect(state.effective?.mode).toBe("read_only");
        expect(state.drain?.drained).toBe(true);
      } finally {
        ok(await set("off"));
      }
      expect((ok(await browserRequest(owner, "/api/admin/ops/maintenance", undefined, "GET", ws)) as { effective?: { mode?: string } }).effective?.mode).toBe("off");

      // 3. Flood one workspace; the other keeps being served (before the outage, on the healthy API).
      // A browser sends only a few requests at a time, which the default burst (200) absorbs, so the operator tightens A's quota.
      ok(await browserRequest(owner, "/api/admin/ops/quotas", { workspaceId: ws, apiRatePerSec: 0.5, apiBurst: 10 }, "PUT", ws));
      try {
        const flooded = await burst(owner, ws, 60), other = await burst(b.tenant.owner, b.tenant.workspaceId, 20);
        expect(flooded["429"] ?? 0, "the flooding workspace must be throttled").toBeGreaterThan(0);
        expect(other["429"] ?? 0, "the other workspace must never be throttled").toBe(0);
        expect(other["200"]).toBe(20);
      } finally {
        ok(await browserRequest(owner, `/api/admin/ops/quotas?workspaceId=${ws}`, undefined, "DELETE", ws));
      }

      // 2. Control-store outage on the API: metrics say so and reads degrade rather than fail.
      await api.restore();
      api = await withApiEnvironment(directory, { CRON_SECRET: secret, ZENITH_PLATFORM_DB_URL: "postgresql://zenith:unreachable@127.0.0.1:1/zenith?sslmode=disable" });
      const metrics = await fetch(`${a.tenant.stack.apiUrl}/api/internal/metrics`, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(30_000) });
      expect(metrics.status).toBe(200);
      expect(await metrics.text()).toMatch(/^zenith_control_store_up(\{[^}]*\})? 0$/m);
      expect((await fetch(`${a.tenant.stack.apiUrl}/api/me`, { signal: AbortSignal.timeout(30_000) })).status).toBeLessThan(500);
    } finally {
      await api.restore();
      await a.close();
      await b.close();
    }
  }, 1_800_000);
});
