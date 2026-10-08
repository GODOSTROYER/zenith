/** Real HTTP wrappers, with mocked Supabase claims/identity and mutation transports. No live Auth proof. */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDataDir } from "../_support/data-dir";
import { privilegedAction, privilegedRoute } from "@/lib/auth/mfa-routes";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { exemptFromReadOnly } from "@/lib/ops/maintenance";

tempDataDir("zenith-mfa-routes-", { fast: true });
const mocks = vi.hoisted(() => ({ claims: vi.fn(), user: vi.fn(), approve: vi.fn(), signal: vi.fn(), action: vi.fn(), controls: vi.fn(), role: "admin", id: "operator", configured: true }));
vi.mock("@/lib/controlplane/db/open", async (original) => ({ ...await original<typeof import("@/lib/controlplane/db/open")>(), platformDb: async () => ({}) }));
vi.mock("@/lib/controlplane/db/repos/workspace-mfa-controls", () => ({ getWorkspaceMfaControls: mocks.controls, putWorkspaceMfaControls: vi.fn() }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: { getClaims: mocks.claims, getUser: mocks.user } }) }));
vi.mock("@/lib/supabase/env", () => ({ SUPABASE_URL: "http://auth.test", SUPABASE_PUBLIC_KEY: "", isSupabaseConfigured: () => mocks.configured }));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: async () => mocks.configured ? { id: mocks.id, email: `${mocks.id}@example.test`, name: mocks.id } : null }));
vi.mock("@/lib/server/boot", () => ({ ensureBoot: async () => undefined }));
vi.mock("@/lib/waitlist/enforcement", () => ({ requireProductRequestAccess: async () => undefined }));
vi.mock("@/lib/hosted/access/identity", () => ({ verifyRequestIdentity: async () => ({ subject: mocks.id, emailVerified: true }) }));
vi.mock("@/lib/capabilities/platform", () => ({ platformBroker: async () => ({ approve: mocks.approve }) }));
vi.mock("@/lib/bridge/lifecycle", () => ({ deliverPlanApproval: mocks.signal }));
vi.mock("@/lib/actions/core", async (original) => ({ ...await original<typeof import("@/lib/actions/core")>(), runAction: mocks.action }));

const { route } = await import("@/lib/server/request");
const { resetDb } = await import("@/lib/db/store");
const { defineAction } = await import("@/lib/actions/core");
const { z } = await import("zod");
const { POST: approve } = await import("@/app/api/platform/v1/operations/[id]/approve/route");
const { POST: actionRoute } = await import("@/app/api/actions/[actionId]/route");
const { POST: verify, GET: verifyRead } = await import("@/app/api/auth/mfa/verify/route");
const { GET: controls } = await import("@/app/api/workspace/mfa/route");
const changed = vi.fn(async () => ({ changed: true }));
const mutation = route(changed);
const ctx = { params: Promise.resolve({ id: "op", actionId: "deploy.cancel" }) };
const request = (path: string, body: unknown = {}, method = "POST", headers: Record<string, string> = {}) => new NextRequest(`https://zenith.test${path}`, {
  method, headers: { origin: "https://zenith.test", "content-type": "application/json", cookie: "zenith-workspace=ws-a", ...headers }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
});
const answer = (...levels: unknown[]) => ({ data: { claims: { sub: mocks.id, aal: levels.length ? levels[0] : "aal2", exp: Date.now() / 1000 + 600 } }, error: null });

beforeEach(() => {
  vi.clearAllMocks(); mocks.configured = true; mocks.id = "operator"; mocks.role = "admin";
  vi.stubEnv("ZENITH_PLATFORM_ORIGIN", "https://zenith.test");
  mocks.claims.mockResolvedValue(answer());
  mocks.user.mockResolvedValue({ data: { user: { id: "operator", email_confirmed_at: new Date().toISOString(), factors: [{ factor_type: "totp", status: "verified" }] } }, error: null });
  mocks.approve.mockResolvedValue({ operation: { id: "op", workspaceId: "ws-a", status: "approved" } });
  mocks.signal.mockResolvedValue(null);
  mocks.action.mockResolvedValue({ result: { ok: true } });
  mocks.controls.mockImplementation((_sql, workspaceId) => ({ workspaceId, privilegedActionsRequireAal2: true, requireForAllMutations: false, maxAgeSeconds: null, version: 0, isDefault: true }));
  resetDb({ workspaces: [{ id: "ws-a", name: "A", slug: "a", createdAt: new Date().toISOString(), ownerId: "operator" }], members: [{ id: "operator", workspaceId: "ws-a", role: "admin", name: "Operator", email: "operator@example.test" }] });
  defineAction({ id: "deploy.cancel", category: "deploy", requiredRole: "editor", risk: "medium", mutates: true, title: "Cancel", input: z.object({}), plan: () => ({ summary: "", details: [], warnings: [], risk: "medium", costDeltaUsd: 0, requiresApproval: false }), execute: async () => ({ ok: true, summary: "cancelled" }) });
});
afterEach(() => { vi.unstubAllEnvs(); });

const privileged = [
  ["/api/workspace/mfa", "PUT"],
  ["/api/platform/v1/audit/exports", "POST"],
  ["/api/platform/v1/environments/env/domains", "POST"], ["/api/platform/v1/environments/env/domains/verify", "POST"], ["/api/platform/v1/environments/env/domains/revoke", "POST"],
  ["/api/platform/v1/recovery/items/item/decide", "POST"],
  ["/api/platform/v1/operations/op/approve", "POST"], ["/api/platform/v1/operations/op/reject", "POST"], ["/api/platform/v1/operations/op/cancel", "POST"],
  ["/api/platform/v1/operations/op/mixed-run/teardown", "POST"], ["/api/platform/v1/operations/op/mixed-run/cancel", "POST"],
  ["/api/platform/v1/operations/op/start-portability", "POST"], ["/api/platform/v1/mixed/plans/plan/start", "POST"], ["/api/platform/v1/mixed/plans", "POST"], ["/api/platform/v1/mixed/plans/plan/children", "POST"],
  ["/api/platform/v1/connections", "POST"], ["/api/platform/v1/connections/conn/rotate", "POST"], ["/api/platform/v1/connections/conn/revoke", "POST"], ["/api/platform/v1/connections/conn/verify", "POST"],
  ["/api/platform/v1/connections/conn/rotation/promote", "POST"], ["/api/platform/v1/connections/conn/rotation/abort", "POST"], ["/platform/connections/aws/action", "POST"],
  ["/api/platform/v1/runbooks", "POST"], ["/api/platform/v1/runbooks/book/runs", "POST"], ["/api/platform/v1/runbooks/book/schedules", "POST"],
  ["/api/platform/v1/runbooks/runs/run/approve", "POST"], ["/api/platform/v1/runbooks/runs/run/cancel", "POST"], ["/api/platform/v1/runbooks/schedules/schedule/approve", "POST"], ["/api/platform/v1/runbooks/schedules/schedule/state", "POST"],
  ["/api/platform/v1/workspace/policy", "PUT"], ["/api/platform/v1/environments/env/autonomy", "PUT"], ["/api/platform/v1/environments/env/teardown-review", "POST"],
  ["/api/platform/v1/environments/env/state-backend", "PUT"], ["/api/platform/v1/environments/env/state-backend/restores/approve", "POST"], ["/api/platform/v1/environments/env/state-backend/restores/reject", "POST"], ["/api/platform/v1/environments/env/state-backend/restores/execute", "POST"],
  ["/api/platform/v1/environments/env/spend", "POST"], ["/api/platform/v1/effects/effect/resolve", "POST"], ["/api/platform/v1/releases/release/approve-migration", "POST"],
  ["/api/platform/v1/standing-grants", "POST"], ["/api/platform/v1/standing-grants/grant/revoke", "POST"], ["/api/platform/v1/mixed-output-preauthorizations", "POST"], ["/api/platform/v1/mixed-output-preauthorizations/preauth/revoke", "POST"],
  ["/api/platform/v1/runners/tokens", "POST"], ["/api/platform/v1/runners/runner/revoke", "POST"], ["/api/platform/v1/machines/machine/revoke", "POST"],
  ["/api/platform/v1/coding-agent/runs", "POST"], ["/api/platform/v1/coding-agent/runs/run/adopt", "POST"], ["/api/platform/v1/coding-agent/runs/run/cancel", "POST"], ["/api/platform/v1/coding-agent/runs/run/resume", "POST"],
  ["/api/platform/v1/github/binding", "POST"], ["/api/platform/v1/github/binding/unbind", "POST"], ["/api/platform/v1/github/callback", "GET"],
  ["/api/integrations/plugins", "POST"], ["/api/integrations/plugins/review", "POST"], ["/api/integrations/plugins/revoke", "POST"], ["/api/integrations/plugins/tokens", "POST"], ["/api/integrations/plugins/tokens/revoke", "POST"],
  ["/api/integrations/agent/review", "POST"], ["/api/integrations/agent/grants", "POST"], ["/api/integrations/agent/link/approve", "POST"], ["/api/integrations/agent/link/revoke", "POST"],
  ["/api/workspace/ownership", "POST"], ["/api/workspace/members/member", "PATCH"], ["/api/workspace/members/member", "DELETE"], ["/api/workspace/invites", "POST"], ["/api/workspace/invites/invite/resend", "POST"], ["/api/workspace/invites/invite", "DELETE"],
  ["/api/hosted/apps/app/publish", "POST"], ["/api/hosted/apps/app/grants/grant", "DELETE"], ["/api/hosted/ops/spending", "PUT"], ["/api/account", "DELETE"],
] as const;

describe("privileged route inventory through the real request wrapper", () => {
  it("covers every existing explicit browser-only platform mutation", () => {
    const root = join(process.cwd(), "src/app/api/platform/v1");
    let count = 0;
    function inspect(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = join(dir, entry.name);
        if (entry.isDirectory()) inspect(file);
        else if (entry.name === "route.ts") {
          const source = readFileSync(file, "utf8");
          if (!source.includes("assertBrowserSession")) continue;
          const path = `/api/platform/v1/${relative(root, file).replaceAll("\\", "/").replace(/\/route\.ts$/, "").replace(/\[[^/]+\]/g, "item")}`;
          for (const match of source.matchAll(/export\s+(?:const|async function)\s+(POST|PUT|PATCH|DELETE)\b/g)) {
            expect(privilegedRoute(path, match[1]), `${match[1]} ${path}`).toBe("human"); count++;
          }
        }
      }
    }
    inspect(root); expect(count).toBeGreaterThan(20);
  });
  it.each(privileged)("blocks AAL1 before mutation at %s %s", async (path, method) => {
    expect(privilegedRoute(path, method)).toBeDefined(); mocks.claims.mockResolvedValue(answer("aal1"));
    const result = await mutation(request(path, {}, method), ctx);
    expect(result.status).toBe(403); expect(changed).not.toHaveBeenCalled();
  });
  it("permits dashboard reads and proposals without step-up", async () => {
    mocks.claims.mockResolvedValue(answer("aal1"));
    expect((await mutation(request("/api/platform/v1/operations", {}, "GET"), ctx)).status).toBe(200);
    expect((await mutation(request("/api/platform/v1/audit/exports", {}, "GET"), ctx)).status).toBe(200);
    expect((await mutation(request("/api/platform/v1/environments/env/domains", {}, "GET"), ctx)).status).toBe(200);
    expect((await mutation(request("/api/platform/v1/capabilities/propose"), ctx)).status).toBe(200);
    expect(mocks.claims).not.toHaveBeenCalled();
  });
  it("enforces an admin mutation even when its path is newly added", async () => {
    mocks.claims.mockResolvedValue(answer("aal1"));
    const protectedAdmin = route({ workspaceRole: "admin" }, changed);
    expect((await protectedAdmin(request("/api/new-admin-control"), ctx)).status).toBe(403); expect(changed).not.toHaveBeenCalled();
  });
  it("enforces stricter workspace controls and cannot be fooled by a foreign header on product routes", async () => {
    mocks.claims.mockResolvedValue(answer("aal1"));
    mocks.controls.mockImplementation((_sql, workspaceId) => ({ workspaceId, privilegedActionsRequireAal2: true, requireForAllMutations: workspaceId === "ws-a", maxAgeSeconds: null }));
    expect((await mutation(request("/api/nonprivileged", {}, "POST", { "x-zenith-workspace": "ws-b" }), ctx)).status).toBe(403);
    expect(changed).not.toHaveBeenCalled();
  });
  it("refuses conflicting workspace selectors", async () => {
    expect((await mutation(request("/api/platform/v1/workspace/policy?workspace=ws-b", {}, "PUT", { "x-zenith-workspace": "ws-a" }), ctx)).status).toBe(400);
    expect(changed).not.toHaveBeenCalled();
  });
  it("preserves verified machine execution without treating a cookie or arbitrary header as authority", async () => {
    const machine = route({ integrationAccess: async () => ({ subject: "bound-human" }) }, changed);
    expect((await machine(request("/api/platform/v1/connections/conn/revoke", {}, "POST", { authorization: "Bearer test-double" }), ctx)).status).toBe(200);
    expect(mocks.claims).not.toHaveBeenCalled();
    changed.mockClear();
    expect((await machine(request("/api/platform/v1/operations/op/approve", {}, "POST", { authorization: "Bearer test-double" }), ctx)).status).toBe(403);
    expect(changed).not.toHaveBeenCalled();
  });
  it("refuses privileged demo actions without an identity provider", async () => {
    mocks.configured = false;
    expect((await mutation(request("/api/platform/v1/operations/op/approve"), ctx)).status).toBe(503); expect(changed).not.toHaveBeenCalled();
  });
  it("keeps the read-only effective controls bound to the selected member workspace", async () => {
    expect(await (await controls(request("/api/workspace/mfa", {}, "GET"), ctx)).json()).toEqual({ workspaceId: "ws-a", privilegedActionsRequireAal2: true, requireForAllMutations: false, maxAgeSeconds: null, version: 0, isDefault: true });
  });
});

describe("concrete approval, action and MFA routes", () => {
  it.each(["aal1", undefined, "aal3"])("does not approve or signal at AAL %s", async (aal) => {
    mocks.claims.mockResolvedValue(answer(aal));
    expect((await approve(request("/api/platform/v1/operations/op/approve", { proposalDigest: "a".repeat(64) }), ctx)).status).toBe(403);
    expect(mocks.approve).not.toHaveBeenCalled(); expect(mocks.signal).not.toHaveBeenCalled();
  });
  it("passes the reviewed digest and verified human to existing approval machinery after AAL2", async () => {
    const digest = "a".repeat(64);
    expect((await approve(request("/api/platform/v1/operations/op/approve", { proposalDigest: digest, semanticsDigest: "b".repeat(64) }), ctx)).status).toBe(200);
    expect(mocks.approve).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-a", proposalDigest: digest, semanticsDigest: "b".repeat(64), approver: expect.objectContaining({ id: "operator", kind: "user" }) }));
    expect(mocks.signal).toHaveBeenCalledOnce();
  });
  it("protects legacy cancellation execution but leaves planning accessible", async () => {
    mocks.claims.mockResolvedValue(answer("aal1"));
    expect((await actionRoute(request("/api/actions/deploy.cancel", { mode: "execute", input: { deploymentId: "dep" } }), ctx)).status).toBe(403);
    expect(mocks.action).not.toHaveBeenCalled();
    expect((await actionRoute(request("/api/actions/deploy.cancel", { mode: "plan", input: { deploymentId: "dep" } }), ctx)).status).toBe(200);
    expect(mocks.action).toHaveBeenCalledOnce();
  });
  it("does not mistake a bogus Authorization header for verified machine transport", async () => {
    mocks.claims.mockResolvedValue(answer("aal1"));
    expect((await actionRoute(request("/api/actions/deploy.cancel", { mode: "execute" }, "POST", { authorization: "Bearer invalid" }), ctx)).status).toBe(403);
    expect(mocks.action).not.toHaveBeenCalled();
  });
  it("only the server-confirmed AAL2 session completes the MFA flow", async () => {
    mocks.claims.mockResolvedValue(answer("aal1")); expect((await verify(request("/api/auth/mfa/verify"), ctx)).status).toBe(403);
    mocks.claims.mockResolvedValue(answer()); expect(await (await verify(request("/api/auth/mfa/verify"), ctx)).json()).toEqual({ verified: true });
  });
  it("keeps read-only MFA confirmation guarded and reachable during maintenance", async () => {
    expect(exemptFromReadOnly("/api/auth/mfa/verify", "GET")).toBe(true);
    expect(privilegedRoute("/api/auth/mfa/verify", "GET")).toBe("human");
    mocks.claims.mockResolvedValue(answer("aal1")); expect((await verifyRead(request("/api/auth/mfa/verify", {}, "GET"), ctx)).status).toBe(403);
    mocks.claims.mockResolvedValue(answer()); expect(await (await verifyRead(request("/api/auth/mfa/verify", {}, "GET"), ctx)).json()).toEqual({ verified: true });
  });
  it("classifies admin, high risk, connection/secret and cancellation actions without requiring read helpers", () => {
    const def = { id: "other", requiredRole: "editor" as const, risk: "medium" as const, mutates: true, category: "system" as const };
    for (const fields of [{ requiredRole: "admin" as const }, { risk: "high" as const }, { category: "connection" as const }, { category: "secrets" as const }, { category: "operations" as const }, { category: "deploy" as const }]) expect(privilegedAction({ ...def, ...fields })).toBe(true);
    expect(privilegedAction(def)).toBe(false); expect(privilegedAction({ ...def, requiredRole: "admin", mutates: false })).toBe(false);
  });
});
