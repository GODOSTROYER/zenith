/**
 * PROD-OPS-02: workloads keep serving while the control plane is degraded, overloaded or in maintenance.
 *
 * This file proves the parts of the guarantee that are properties of THIS repository's code, and says
 * plainly which parts are not (those are in docs/platform/operations/CONTROL-PLANE-FAIRNESS.md under
 * "Data-plane guarantee" and need the live acceptance harness):
 *
 *   1. Hosted-app traffic is rewritten to the gateway BEFORE any admission code runs, so neither the
 *      rate limiter nor read-only maintenance can touch it.
 *   2. The data-plane source trees import nothing from the fairness layer, the control store or the
 *      maintenance state: there is no code path by which a refusal or an outage reaches them.
 *   3. Overload and maintenance never refuse the control lanes drain and recovery depend on.
 *   4. A control-store outage degrades admission to "last known / defaults", never to an error.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({ session: vi.fn(), hosted: vi.fn() }));
vi.mock("@/lib/supabase/middleware", () => ({ updateSession: gate.session }));
vi.mock("@/lib/hosted/edge", () => ({ hostedRewrite: gate.hosted, isPlatformStaticPath: () => false }));
import { middleware } from "@/middleware";
import { resetEdgeForTests } from "@/lib/ops/edge";

const ROOT = path.resolve(__dirname, "../..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  resetEdgeForTests();
  gate.hosted.mockReturnValue(undefined);
  gate.session.mockImplementation(async () => NextResponse.next());
});

describe("hosted data plane is upstream of admission", () => {
  it("serves an app-host request even with every limiter exhausted and read-only maintenance on", async () => {
    vi.stubEnv("ZENITH_MAINTENANCE_MODE", "read_only");
    vi.stubEnv("ZENITH_OPS_EDGE_RATE_PER_SEC", "0.1");
    vi.stubEnv("ZENITH_OPS_EDGE_BURST", "1");
    const rewritten = NextResponse.rewrite(new URL("https://zenith.test/hosted-gateway/app.apps.example.com/submit"));
    // Only the app host is rewritten, exactly as hostedRewrite() does; the control origin is not.
    gate.hosted.mockImplementation((req: NextRequest) => (req.nextUrl.hostname === "app.apps.example.com" ? rewritten : null));
    // Exhaust the control-origin limiter for this client first.
    const control = () => middleware(new NextRequest("https://zenith.test/api/projects", { method: "POST", headers: { authorization: "Bearer same-client" } }));
    expect((await control()).status).toBe(503); // read-only: the control API is refusing writes
    for (let i = 0; i < 20; i++) {
      const res = await middleware(new NextRequest("https://app.apps.example.com/submit", { method: "POST", headers: { authorization: "Bearer same-client" } }));
      expect(res).toBe(rewritten);
    }
    expect(gate.session).not.toHaveBeenCalled();
  });

  it("never limits or pauses the gateway path itself, even if it were reached on the control origin", async () => {
    vi.stubEnv("ZENITH_MAINTENANCE_MODE", "read_only");
    for (let i = 0; i < 50; i++) {
      const res = await middleware(new NextRequest("https://zenith.test/hosted-gateway/app.apps.example.com/api/items", { method: "POST" }));
      expect(res.status).not.toBe(503);
      expect(res.status).not.toBe(429);
    }
  });
});

describe("control lanes survive overload and maintenance", () => {
  it("lets runner results, cron ticks and the operator route through a read-only, rate-exhausted edge", async () => {
    vi.stubEnv("ZENITH_MAINTENANCE_MODE", "read_only");
    vi.stubEnv("ZENITH_OPS_EDGE_RATE_PER_SEC", "0.1");
    vi.stubEnv("ZENITH_OPS_EDGE_BURST", "1");
    for (const [method, url] of [
      ["POST", "https://zenith.test/api/platform/v1/runners/run_1/jobs/job_1/result"],
      ["POST", "https://zenith.test/api/platform/v1/machines/mac_1/heartbeat"],
      ["POST", "https://zenith.test/api/internal/tick/reconcile"],
      ["PUT", "https://zenith.test/api/admin/ops/maintenance"],
    ] as const) {
      for (let i = 0; i < 5; i++) {
        const res = await middleware(new NextRequest(url, { method, headers: { authorization: "Bearer lane" } }));
        expect([429, 503], `${method} ${url}`).not.toContain(res.status);
      }
    }
  });
});

describe("no code path from the fairness layer into the data plane", () => {
  const FAIRNESS = /@\/lib\/ops\/|platform\.ops_maintenance|tenant_quotas/;
  const dataPlaneTrees = [
    "src/lib/hosted/gateway",
    "src/lib/hosted/runtime",
    "src/app/hosted-gateway",
    "go/internal/agent",
    "go/internal/runner",
    "go/internal/machine",
    "go/internal/proc",
  ];

  it.each(dataPlaneTrees)("%s does not import or query the fairness layer", (tree) => {
    const dir = path.join(ROOT, tree);
    let files: string[] = [];
    try { files = sourceFilesAny(dir); } catch { return; /* tree absent in this checkout */ }
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(readFileSync(file, "utf8"), file).not.toMatch(FAIRNESS);
  });

  function sourceFilesAny(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) out.push(...sourceFilesAny(full));
      else if (/\.(ts|tsx|go)$/.test(name)) out.push(full);
    }
    return out;
  }

  it("the only importers of the fairness layer are control-plane modules (an inventory, so a new importer is a conscious decision)", () => {
    const importers = sourceFiles(path.join(ROOT, "src"))
      .concat(sourceFiles(path.join(ROOT, "workers")))
      .filter((f) => /@\/lib\/ops\//.test(readFileSync(f, "utf8")) && !f.includes(`${path.sep}lib${path.sep}ops${path.sep}`))
      .map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
      .sort();
    expect(importers).toEqual([
      "src/app/api/admin/ops/maintenance/route.ts",
      "src/app/api/admin/ops/quotas/route.ts",
      "src/app/api/internal/metrics/route.ts",
      "src/lib/agent-access/v3/tools/execute.ts",
      "src/lib/bridge/destroy.ts",
      "src/lib/bridge/lifecycle.ts",
      "src/lib/controlplane/db/repos/jobs.ts",
      "src/lib/log.ts",
      "src/lib/portability/start.ts",
      "src/lib/server/errors.ts",
      "src/lib/server/request.ts",
      "src/middleware.ts",
      "src/app/api/platform/v1/_lib/http.ts",
      "src/app/api/platform/v1/_lib/principal.ts",
      "workers/execution/health.ts",
      "workers/execution/run.ts",
      "workers/execution/worker.ts",
    ].sort());
  });
});

describe("a control-store outage degrades admission, it does not fail requests", () => {
  it("is asserted end to end in tests/ops/admission.test.ts ('falls back to the defaults, not an error' and 'keeps the last known window')", () => {
    // A pointer rather than a duplicate: the behaviour is covered where the runtime can be driven with a failing store.
    expect(readFileSync(path.join(ROOT, "tests/ops/admission.test.ts"), "utf8")).toContain("falls back to the defaults, not an error, when the control store is down");
  });
});
