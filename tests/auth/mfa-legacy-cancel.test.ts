/** Real HTTP guard, deploy.cancel action runner and file-store audit. Auth/engine are contract doubles. */
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Deployment } from "@/lib/domain/types";
import type { Role } from "@/lib/actions/core";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-mfa-cancel-", { fast: true });
const mocks = vi.hoisted(() => ({ claims: vi.fn(), user: vi.fn(), cancel: vi.fn(), id: "", aal: "aal2" }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: { getClaims: mocks.claims, getUser: mocks.user } }) }));
vi.mock("@/lib/supabase/env", () => ({ SUPABASE_URL: "http://auth.test", SUPABASE_PUBLIC_KEY: "", isSupabaseConfigured: () => true }));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: async () => ({ id: mocks.id, name: "Operator", email: `${mocks.id}@example.test` }) }));
vi.mock("@/lib/server/boot", () => ({ ensureBoot: async () => undefined }));
vi.mock("@/lib/waitlist/enforcement", () => ({ requireProductRequestAccess: async () => undefined }));
vi.mock("@/lib/actions/defs/_engine", () => ({ getEngine: async () => ({ cancel: mocks.cancel }) }));
vi.mock("@/lib/controlplane/db/open", async (original) => ({ ...await original<typeof import("@/lib/controlplane/db/open")>(), platformDb: async () => ({}) }));
vi.mock("@/lib/controlplane/db/repos/workspace-mfa-controls", () => ({ getWorkspaceMfaControls: async () => ({ privilegedActionsRequireAal2: true, requireForAllMutations: false, maxAgeSeconds: null }) }));
const { db, q, resetDb, readAudit } = await import("@/lib/db/store");
await import("@/lib/actions/defs/deploy");
const { POST } = await import("@/app/api/actions/[actionId]/route");
let deployment: Deployment;
const seed = (role: Role = "admin") => {
  const now = new Date().toISOString();
  resetDb({ workspaces: [{ id: "ws-a", name: "A", slug: "a", createdAt: now }], members: [{ id: mocks.id, workspaceId: "ws-a", name: "Operator", email: `${mocks.id}@example.test`, role }],
    projects: [{ id: "project-a", workspaceId: "ws-a", name: "A", slug: "a", origin: { type: "blank" }, workingManifest: { version: 1, services: [], resources: [], routes: [], bindings: [] }, createdAt: now }], deployments: [deployment] });
};
const request = (deploymentId = deployment.id, mode = "execute") => new NextRequest("https://zenith.test/api/actions/deploy.cancel", { method: "POST", headers: { origin: "https://zenith.test", cookie: "zenith-workspace=ws-a", "content-type": "application/json" }, body: JSON.stringify({ mode, input: { deploymentId } }) });
const context = { params: Promise.resolve({ actionId: "deploy.cancel" }) };
beforeEach(() => {
  vi.clearAllMocks(); mocks.id = randomUUID(); mocks.aal = "aal2"; vi.stubEnv("ZENITH_PLATFORM_ORIGIN", "https://zenith.test");
  mocks.claims.mockImplementation(async () => ({ data: { claims: { sub: mocks.id, aal: mocks.aal, exp: Date.now() / 1000 + 600 } }, error: null }));
  mocks.user.mockResolvedValue({ data: { user: { id: mocks.id, email_confirmed_at: new Date().toISOString(), factors: [{ factor_type: "totp", status: "verified" }] } }, error: null });
  deployment = { id: randomUUID(), projectId: "project-a", environmentId: "env-a", revisionId: "revision-a", status: "rolling_back", executor: "engine", steps: [{ id: "step", seq: 1, title: "Applied", phase: "provision", targetId: "resource-a", status: "done" }], outputs: [], changeSummary: "A", estCostDeltaUsd: 0, actor: { type: "user", id: mocks.id, name: "Operator" }, createdAt: new Date().toISOString() };
  seed(); mocks.cancel.mockImplementation(async (id) => { const row = q.deployment(id)!; row.status = "cancelled"; return row; });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("legacy cancel guard and audit", () => {
  it("refuses AAL1 before engine cancellation", async () => {
    mocks.aal = "aal1"; expect((await POST(request(), context)).status).toBe(403);
    expect(mocks.cancel).not.toHaveBeenCalled(); expect(q.deployment(deployment.id)?.status).toBe("rolling_back");
  });
  it("executes the actual legacy action and retains the workspace/user audit", async () => {
    const response = await POST(request(), context); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ result: { ok: true, data: { deploymentId: deployment.id, status: "cancelled" } } });
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(deployment.id);
    expect(readAudit({ workspaceId: "ws-a" })).toMatchObject([{ actionId: "deploy.cancel", workspaceId: "ws-a", actor: { type: "user", id: mocks.id }, input: { deploymentId: deployment.id }, result: "ok" }]);
  });
  it("keeps role denial audited after successful step-up", async () => {
    seed("viewer"); expect(await (await POST(request(), context)).json()).toMatchObject({ result: { ok: false, error: expect.stringContaining("role_denied") } });
    expect(mocks.cancel).not.toHaveBeenCalled(); expect(readAudit({ workspaceId: "ws-a" })).toMatchObject([{ actionId: "deploy.cancel", result: "denied" }]);
  });
  it.each(["foreign", "unknown"])("refuses a %s target and records the refused execute", async (kind) => {
    const target = randomUUID();
    if (kind === "foreign") {
      const data = db(); data.workspaces.push({ id: "ws-b", name: "B", slug: "b", createdAt: new Date().toISOString() });
      data.projects.push({ ...data.projects[0], id: "project-b", workspaceId: "ws-b" });
      data.deployments.push({ ...deployment, id: target, projectId: "project-b" });
    }
    const response = await POST(request(target), context); expect(await response.json()).toMatchObject({ result: { ok: false } });
    expect(mocks.cancel).not.toHaveBeenCalled(); expect(readAudit({ workspaceId: "ws-a" })).toMatchObject([{ actionId: "deploy.cancel", result: "error" }]);
    if (kind === "foreign") expect(q.deployment(target)?.status).toBe("rolling_back");
  });
  it("leaves the cancel plan accessible without executing or claiming an audit", async () => {
    mocks.aal = "aal1"; expect((await POST(request(deployment.id, "plan"), context)).status).toBe(200);
    expect(mocks.cancel).not.toHaveBeenCalled(); expect(readAudit({ workspaceId: "ws-a" })).toEqual([]);
  });
});
