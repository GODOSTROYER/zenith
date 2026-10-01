/** HTTP handler plus real callerOf bearer resolution; request-snapshot wrapper
 * and policy/credential authorities are explicit fakes, no remote auth. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { tempDataDir } from "../_support/data-dir";
import type { NextRequest as RequestType } from "next/server";

tempDataDir("zenith-placement-route-");
const auth = vi.hoisted(() => ({ verify: vi.fn(), authorize: vi.fn(), session: vi.fn(), configured: vi.fn() }));
vi.mock("@/lib/agent-access/authority", () => ({ requireCredentialAuthority: async () => ({ verify: auth.verify }) }));
vi.mock("@/lib/capabilities/platform", () => ({ platformBroker: async () => ({ authorizeRead: auth.authorize }) }));
type RouteHandler = (req: RequestType, params: { id: string }) => Promise<Response>;
// route(handler) or route(options, handler), as src/lib/server/request.ts accepts
vi.mock("@/lib/server/request", () => ({ currentRequest: () => auth.session(), route: (a: RouteHandler | object, b?: RouteHandler) => { const fn = (typeof a === "function" ? a : b) as RouteHandler; return (req: RequestType, context: { params: Promise<{ id: string }> }) => context.params.then((p) => fn(req, p)); } }));
vi.mock("@/lib/server/actor", () => ({ resolveActor: async () => ({ type: "user", id: "bob", name: "Bob" }) }));
vi.mock("@/lib/server/workspace", () => ({ requireWorkspace: () => ({ id: "ws-a" }) }));
vi.mock("@/lib/supabase/env", () => ({ isSupabaseConfigured: () => auth.configured() }));

const { resetDb } = await import("@/lib/db/store");
const { Manifest } = await import("@/lib/domain/types");
const { placementReads } = await import("@/lib/placement/recommend");
const { POST } = await import("@/app/api/platform/v1/environments/[id]/placement/route");
const { BrokerError } = await import("@/lib/capabilities/errors");

beforeEach(() => {
  auth.verify.mockResolvedValue({ id: "int-a", label: "Test", subject: "bob", workspaceId: "ws-a" });
  auth.authorize.mockResolvedValue({ decision: { outcome: "allow" }, claims: {} });
  auth.configured.mockReturnValue(true); auth.session.mockReturnValue({ user: { id: "bob", name: "Bob" } });
  resetDb({ projects: [{ id: "proj-a", workspaceId: "ws-a", name: "A", slug: "a", createdAt: "2026-09-30T00:00:00Z", origin: { type: "blank" }, workingManifest: Manifest.parse({ version: 1, services: [{ id: "svc-a", name: "web-app", kind: "web", port: 8080, source: { type: "image", image: "example.test/app:1" } }] }) },
    { id: "proj-b", workspaceId: "ws-b", name: "Foreign", slug: "foreign", createdAt: "2026-09-30T00:00:00Z", origin: { type: "blank" }, workingManifest: Manifest.parse({ version: 1 }) }],
    environments: ["a", "b"].map((suffix) => ({ id: `env-${suffix}`, projectId: `proj-${suffix}`, name: "Staging", class: "staging", connectionId: `conn-${suffix}`, region: "ap-south-1", baseDomain: "example.test", createdAt: "2026-09-30T00:00:00Z", policies: { approvalRequired: false, allowStatefulDeletion: false } })) });
  vi.spyOn(placementReads, "connections").mockResolvedValue([{ workspaceId: "ws-a", provider: "aws", verified: true }]);
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
const request = (id = "env-a", body: unknown = {}, headers: Record<string, string> = {}) => POST(new NextRequest(`http://localhost/api/platform/v1/environments/${id}/placement`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

describe("placement REST read", () => {
  it("supports a bearer and authorizes placement.solve at project scope", async () => {
    const response = await request("env-a", { constraints: { userRegions: ["india"] } }, { authorization: "Bearer opaque-test-token" });
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
    expect(auth.verify).toHaveBeenCalledWith("Bearer opaque-test-token");
    expect(auth.authorize).toHaveBeenCalledWith({ capability: "placement.solve", scope: { workspaceId: "ws-a", projectId: "proj-a", environmentId: "env-a" } }, expect.objectContaining({ kind: "integration", id: "int-a" }));
    const body = await response.json(); expect(body.result.chosen.cost.lines.length).toBeGreaterThan(0); expect(body).not.toHaveProperty("grant");
  });
  it("refuses unauthenticated browser requests in configured mode", async () => {
    auth.session.mockReturnValue(undefined);
    const response = await request(); expect(response.status).toBe(401); expect(auth.authorize).not.toHaveBeenCalled();
  });
  it("returns identical not-found for foreign and missing environment ids", async () => {
    const a = await request("env-b"); const b = await request("missing");
    expect(a.status).toBe(404); expect(await a.json()).toEqual(await b.json()); expect(auth.authorize).not.toHaveBeenCalled();
  });
  it("checks policy before reading connection metadata", async () => {
    auth.authorize.mockResolvedValue({ decision: { outcome: "deny" } });
    const response = await request(); expect(response.status).toBe(403); expect(placementReads.connections).not.toHaveBeenCalled();
  });
  it("rejects a revoked credential without calling the broker", async () => {
    auth.verify.mockRejectedValue(new BrokerError("unauthenticated", "Credential is unavailable."));
    const response = await request("env-a", {}, { authorization: "Bearer revoked-test-token" });
    expect(response.status).toBe(401); expect(auth.authorize).not.toHaveBeenCalled();
  });
  it("refuses unknown mutation fields and conflicting workspace selection", async () => {
    expect((await request("env-a", { apply: true })).status).toBe(400);
    expect((await request("env-a", {}, { authorization: "Bearer opaque-test-token", "x-zenith-workspace": "ws-b" })).status).toBe(404);
  });
});
