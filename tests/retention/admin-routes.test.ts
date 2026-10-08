/**
 * PROD-OPS-07: the operator retention routes (overview, preview, holds) and the critical-job wiring, against a real
 * PGlite control store. Session lookup, verified claims and live identity responses use Supabase provider doubles;
 * operator authorization, MFA step-up, same-origin, validation, the dry-run guarantee and the hold lifecycle are real.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";

const OPERATOR = "0b9d4e1c-1111-4222-8333-444455556666";
const STRANGER = "9a8b7c6d-1111-4222-8333-444455556666";

const mocks = vi.hoisted(() => ({ session: vi.fn(), claims: vi.fn(), authUser: vi.fn(), storeReads: vi.fn(), db: undefined as unknown as PlatformDbHandle }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: { getClaims: mocks.claims, getUser: mocks.authUser } }) }));
vi.mock("@/lib/supabase/env", () => ({ SUPABASE_URL: "http://auth.test", SUPABASE_PUBLIC_KEY: "", isSupabaseConfigured: () => true }));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: mocks.session }));
vi.mock("@/lib/ops/operator", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ops/operator")>()), opsStore: async () => { mocks.storeReads(); return mocks.db; } }));

const overview = await import("@/app/api/admin/ops/retention/route");
const previewRoute = await import("@/app/api/admin/ops/retention/preview/route");
const holdsRoute = await import("@/app/api/admin/ops/retention/holds/route");
const archivesRoute = await import("@/app/api/admin/ops/retention/archives/route");
const verifyRoute = await import("@/app/api/admin/ops/retention/archives/[id]/verify/route");
const restoreRoute = await import("@/app/api/admin/ops/retention/archives/[id]/restore/route");
const { CRITICAL_JOBS, MAINTENANCE_JOBS } = await import("@/lib/platform/critical-jobs");

const ORIGIN = "http://zenith.test";
const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`${ORIGIN}${path}`, { method, headers: { origin: ORIGIN, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const asOperator = () => mocks.session.mockResolvedValue({ id: OPERATOR, email: "op@example.com" });

let handle: PlatformDbHandle;
beforeAll(async () => { handle = mocks.db = await openPlatformDb({ kind: "pglite" }); }, 60_000);
afterAll(async () => { await handle.close(); });
beforeEach(() => {
  vi.stubEnv("ZENITH_OPS_ADMIN_IDS", OPERATOR);
  vi.stubEnv("ZENITH_PLATFORM_ORIGIN", ORIGIN);
  mocks.session.mockReset();
  mocks.claims.mockReset();
  mocks.authUser.mockReset();
  mocks.storeReads.mockClear();
  mocks.claims.mockResolvedValue({ data: { claims: { sub: OPERATOR, aal: "aal2", exp: Date.now() / 1000 + 600 } }, error: null });
  mocks.authUser.mockResolvedValue({ data: { user: { id: OPERATOR, email_confirmed_at: new Date().toISOString(), factors: [{ factor_type: "totp", status: "verified" }] } }, error: null });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("operator authorization", () => {
  it.each(["aal1", "unavailable", "removed-factor"])("refuses retention mutations before store access without verified MFA: %s", async state => {
    asOperator();
    if (state === "aal1") mocks.claims.mockResolvedValue({ data: { claims: { sub: OPERATOR, aal: "aal1", exp: Date.now() / 1000 + 600 } }, error: null });
    if (state === "unavailable") mocks.claims.mockRejectedValue(new Error("controlled identity provider outage"));
    if (state === "removed-factor") mocks.authUser.mockResolvedValue({ data: { user: { id: OPERATOR, email_confirmed_at: new Date().toISOString(), factors: [] } }, error: null });
    const context = { params: Promise.resolve({ id: "arc_none" }) };
    const responses = [
      await previewRoute.POST(req("POST", "/api/admin/ops/retention/preview", { policy: { version: 1 } })),
      await holdsRoute.POST(req("POST", "/api/admin/ops/retention/holds", { workspaceId: "ws_mfa", reason: "case 42" })),
      await holdsRoute.DELETE(req("DELETE", "/api/admin/ops/retention/holds?id=hold_none&workspaceId=ws_mfa&reason=closed")),
      await verifyRoute.POST(req("POST", "/api/admin/ops/retention/archives/arc_none/verify"), context),
      await restoreRoute.POST(req("POST", "/api/admin/ops/retention/archives/arc_none/restore", { mode: "source" }), context),
      await restoreRoute.POST(req("POST", "/api/admin/ops/retention/archives/arc_none/restore", { mode: "source", legacyKey: { originalPurpose: "enc:backup", keyId: "recorded", reason: "case 42" } }), context),
    ];
    expect(responses.map(response => response.status)).toEqual(Array(6).fill(state === "unavailable" ? 503 : 403));
    expect(mocks.claims).toHaveBeenCalledTimes(6);
    expect(mocks.storeReads).not.toHaveBeenCalled();
  });

  it("refuses anonymous callers (401) and non-operators (403) on every method, and cross-origin writes", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await overview.GET(req("GET", "/api/admin/ops/retention"))).status).toBe(401);
    expect((await holdsRoute.POST(req("POST", "/api/admin/ops/retention/holds", { workspaceId: "ws", reason: "x" }))).status).toBe(401);
    mocks.session.mockResolvedValue({ id: STRANGER, email: "x@example.com" });
    expect((await overview.GET(req("GET", "/api/admin/ops/retention"))).status).toBe(403);
    expect((await previewRoute.POST(req("POST", "/api/admin/ops/retention/preview", { policy: { version: 1 } }))).status).toBe(403);
    expect((await holdsRoute.GET(req("GET", "/api/admin/ops/retention/holds"))).status).toBe(403);
    expect((await holdsRoute.POST(req("POST", "/api/admin/ops/retention/holds", { workspaceId: "ws", reason: "x" }))).status).toBe(403);
    expect((await holdsRoute.DELETE(req("DELETE", "/api/admin/ops/retention/holds?id=hold_x"))).status).toBe(403);
    asOperator();
    const cross = req("POST", "/api/admin/ops/retention/holds", { workspaceId: "ws", reason: "x" }, { origin: "http://evil.test" });
    expect((await holdsRoute.POST(cross)).status).toBeGreaterThanOrEqual(400);
  });
});

describe("overview and preview", () => {
  it("shows the retain-everything default with deletion off and the protected tables listed", async () => {
    asOperator();
    vi.stubEnv("ZENITH_RETENTION_POLICY", "");
    vi.stubEnv("ZENITH_RETENTION_POLICY_FILE", "");
    vi.stubEnv("ZENITH_RETENTION_APPLY", "1");
    const res = await overview.GET(req("GET", "/api/admin/ops/retention"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.policy).toMatchObject({ valid: true, source: "default", retainsEverything: true, approved: false });
    // the apply flag alone never opens the delete gate
    expect(body.gate.enabled).toBe(false);
    expect(body.preview.dryRun).toBe(true);
    expect(body.preview.classes.map((c: { class: string }) => c.class)).toEqual(["runner_job_logs", "machine_request_logs", "resource_observations", "drift_reports"]);
    expect(JSON.stringify(body.preview.neverPrunable)).toContain("platform.agent_effect_receipts");
  });

  it("previews a candidate policy without storing it, and refuses a protected table with the reason", async () => {
    asOperator();
    const ok = await previewRoute.POST(req("POST", "/api/admin/ops/retention/preview", { policy: { version: 1, classes: { runner_job_logs: { archiveAfterDays: 30, pruneAfterDays: 90 } } } }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).preview.dryRun).toBe(true);
    const bad = await previewRoute.POST(req("POST", "/api/admin/ops/retention/preview", { policy: { version: 1, classes: { agent_effect_receipts: { archiveAfterDays: 1, pruneAfterDays: 2 } } } }));
    expect(bad.status).toBe(400);
    expect(JSON.stringify(await bad.json())).toMatch(/protected/);
    expect((await previewRoute.POST(req("POST", "/api/admin/ops/retention/preview", {}))).status).toBe(400);
    const stored = await overview.GET(req("GET", "/api/admin/ops/retention"));
    expect((await stored.json()).policy.source).toBe("default");
  });
});

describe("holds", () => {
  it("creates, lists and releases a hold, validating input", async () => {
    asOperator();
    expect((await holdsRoute.POST(req("POST", "/api/admin/ops/retention/holds", { workspaceId: "ws_h", reason: "" }))).status).toBe(400);
    expect((await holdsRoute.POST(req("POST", "/api/admin/ops/retention/holds", { workspaceId: "ws_h", reason: "x", dataClass: "operations" }))).status).toBe(400);
    expect((await holdsRoute.POST(req("POST", "/api/admin/ops/retention/holds", { workspaceId: "ws_h", reason: "x", extra: 1 }))).status).toBe(400);
    const created = await holdsRoute.POST(req("POST", "/api/admin/ops/retention/holds", { workspaceId: "ws_h", reason: "case 42", dataClass: "runner_job_logs", timeFrom: "2026-01-01T00:00:00Z", timeTo: "2026-06-01T00:00:00Z" }));
    expect(created.status).toBe(201);
    const { hold } = await created.json();
    expect(hold).toMatchObject({ workspaceId: "ws_h", dataClass: "runner_job_logs", createdBy: OPERATOR, releasedAt: null });

    const listed = await (await holdsRoute.GET(req("GET", "/api/admin/ops/retention/holds?workspaceId=ws_h"))).json();
    expect(listed.holds.map((h: { id: string }) => h.id)).toContain(hold.id);

    expect((await holdsRoute.DELETE(req("DELETE", `/api/admin/ops/retention/holds?id=${hold.id}&workspaceId=ws_other`))).status).toBe(404);
    const released = await holdsRoute.DELETE(req("DELETE", `/api/admin/ops/retention/holds?id=${hold.id}&workspaceId=ws_h&reason=closed`));
    expect(released.status).toBe(200);
    expect((await released.json()).hold).toMatchObject({ releasedBy: OPERATOR, releaseReason: "closed" });
    const after = await (await holdsRoute.GET(req("GET", "/api/admin/ops/retention/holds?workspaceId=ws_h"))).json();
    expect(after.holds).toHaveLength(0);
    const everything = await (await holdsRoute.GET(req("GET", "/api/admin/ops/retention/holds?workspaceId=ws_h&all=1"))).json();
    expect(everything.holds).toHaveLength(1);
  });
});

describe("archives, verify and restore routes", () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  it("are operator-only and validate input", async () => {
    mocks.session.mockResolvedValue({ id: STRANGER, email: "x@example.com" });
    expect((await archivesRoute.GET(req("GET", "/api/admin/ops/retention/archives"))).status).toBe(403);
    expect((await verifyRoute.POST(req("POST", "/api/admin/ops/retention/archives/a/verify"), ctx("a"))).status).toBe(403);
    expect((await restoreRoute.POST(req("POST", "/api/admin/ops/retention/archives/a/restore", { mode: "source" }), ctx("a"))).status).toBe(403);
    expect((await restoreRoute.POST(req("POST", "/api/admin/ops/retention/archives/a/restore", { mode: "source", legacyKey: { originalPurpose: "enc:backup", keyId: "recorded", reason: "case 42" } }), ctx("a"))).status).toBe(403);
    asOperator();
    const list = await archivesRoute.GET(req("GET", "/api/admin/ops/retention/archives?limit=5"));
    expect(list.status).toBe(200);
    expect(Array.isArray((await list.json()).archives)).toBe(true);
    expect((await archivesRoute.GET(req("GET", "/api/admin/ops/retention/archives?limit=0"))).status).toBe(400);
    expect((await verifyRoute.POST(req("POST", "/api/admin/ops/retention/archives/arc_none/verify"), ctx("arc_none"))).status).toBe(404);
    expect((await restoreRoute.POST(req("POST", "/api/admin/ops/retention/archives/a/restore", { mode: "drop" }), ctx("a"))).status).toBe(400);
    expect((await restoreRoute.POST(req("POST", "/api/admin/ops/retention/archives/a/restore", { mode: "staging", stagingSuffix: "Bad Name" }), ctx("a"))).status).toBe(400);
    expect((await restoreRoute.POST(req("POST", "/api/admin/ops/retention/archives/arc_none/restore", { mode: "source" }), ctx("arc_none"))).status).toBe(409);
  });
});

describe("critical job wiring", () => {
  it("registers data-retention on the durable maintenance schedule and it is a no-op without a policy", async () => {
    expect(CRITICAL_JOBS["data-retention"]).toMatchObject({ durableOnly: true });
    expect(typeof MAINTENANCE_JOBS["data-retention"]).toBe("function");
    vi.stubEnv("ZENITH_RETENTION_POLICY", "");
    vi.stubEnv("ZENITH_RETENTION_POLICY_FILE", "");
    const outcome = await MAINTENANCE_JOBS["data-retention"](handle);
    expect(outcome.value).toMatchObject({ policyActive: 0, archiveBatches: 0, prunedRows: 0, applied: false });
    expect(outcome.counts).toMatchObject({ archivedRows: 0, prunedRows: 0 });
  });
});
