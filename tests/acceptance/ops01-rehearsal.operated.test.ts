/**
 * PROD-OPS-01 operational rehearsal (docs/platform/operations/SLO.md "Running the capacity test") on an owned, already
 * running lean J1 stack.
 *
 * An operator gives the API a run-scoped CRON_SECRET (in a 0600 file) and themselves operator access, runs the capacity
 * test against the stack's own metrics route with --report, and reads the measured result back on the operator SLO route.
 * The figure is what this machine and this stack sustained, compared with the PROVISIONAL target: an engineering target, not
 * an approved objective. The API's original composition is restored afterwards; the stack is never torn down.
 *
 * Gated: ZENITH_LOCAL_OPS_REHEARSAL=1 with ZENITH_DEFAULT_STACK_DIRECTORY and ZENITH_DEFAULT_MAILPIT_URL naming the stack.
 */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { browserRequest, ok } from "../e2e/default/support.mjs";
import { openRealSession } from "../../scripts/acceptance/live/product/mix-03-driver";
import { withApiEnvironment } from "../../scripts/release/drivers/stack-env";

const gated = process.env.ZENITH_LOCAL_OPS_REHEARSAL === "1";

describe.skipIf(!gated)("PROD-OPS-01 operated rehearsal: measured capacity reported to the operator SLO page", () => {
  it("runs the capacity test against the stack, records it and reads the measurement back", async () => {
    const directory = process.env.ZENITH_DEFAULT_STACK_DIRECTORY!;
    const { tenant, close } = await openRealSession(process.env);
    const scratch = mkdtempSync(path.join(realpathSync(os.tmpdir()), "zenith-ops01-"));
    const bearer = path.join(scratch, "cron.secret");
    const secret = randomBytes(32).toString("hex");
    writeFileSync(bearer, secret, { mode: 0o600 });
    // The admission limits are raised for the test window (SLO.md): at their defaults the run measures the rate limiter's
    // 429s, not capacity. The original composition, with the defaults, is restored afterwards.
    const api = await withApiEnvironment(directory, { CRON_SECRET: secret, ZENITH_OPS_ADMIN_IDS: tenant.ownerId,
      ZENITH_OPS_EDGE_RATE_PER_SEC: "100000", ZENITH_OPS_EDGE_BURST: "100000", ZENITH_OPS_API_RATE_PER_SEC: "100000", ZENITH_OPS_API_BURST: "100000" });
    try {
      const before = ok(await browserRequest(tenant.owner, "/api/admin/ops/slo", undefined, "GET", tenant.workspaceId));
      const run = spawnSync(process.execPath, ["scripts/slo/capacity-test.mjs", "--url", tenant.stack.apiUrl, "--path", "/api/internal/metrics",
        "--bearer-file", bearer, "--concurrency", "8", "--duration", "20", "--report"], { cwd: process.cwd(), encoding: "utf8", timeout: 300_000 });
      // 0: within the target. 1 would be a measured miss, 2 nothing measured.
      expect(run.status, "capacity test exit").toBe(0);
      const after = ok(await browserRequest(tenant.owner, "/api/admin/ops/slo", undefined, "GET", tenant.workspaceId));
      const capacity = (slo: { objectives?: { id?: string }[] }) => slo.objectives?.find(objective => /capacity/i.test(objective.id ?? ""));
      if (process.env.ZENITH_OPERATED_DIAGNOSTICS === "1") process.stderr.write(`ops01-slo ${JSON.stringify({ before: capacity(before), after: capacity(after), status: run.status })}\n`);
      type Measurement = { id: string; source: string; withinTarget: boolean; measuredAt: string; details?: { environment?: string; errorRate?: number } };
      const seen = new Set(((capacity(before) as { measurements?: Measurement[] } | undefined)?.measurements ?? []).map(m => m.id));
      const fresh = ((capacity(after) as { measurements?: Measurement[] } | undefined)?.measurements ?? []).filter(m => !seen.has(m.id));
      expect(fresh).toHaveLength(1);
      expect(fresh[0]).toMatchObject({ source: "capacity-test", withinTarget: true, details: { environment: "local machine" } });
      expect(Date.now() - new Date(fresh[0]!.measuredAt.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")).getTime()).toBeLessThan(15 * 60_000);
    } finally {
      await api.restore();
      rmSync(scratch, { recursive: true, force: true });
      await close();
    }
  }, 1_800_000);
});
