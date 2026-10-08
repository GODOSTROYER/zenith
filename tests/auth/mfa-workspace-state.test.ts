/** Actual PGlite storage/API contracts; Auth is mocked. Real Postgres is explicitly gated. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import { PLATFORM_MIGRATIONS } from "@/lib/controlplane/db/migrations";
import { migration0057WorkspaceMfaControls } from "@/lib/controlplane/db/migrations/0057_workspace_mfa_controls";
import * as controls from "@/lib/controlplane/db/repos/workspace-mfa-controls";
import * as events from "@/lib/controlplane/db/repos/events";
import { workspaceMfaControl } from "@/lib/auth/mfa-policy";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-mfa-state-", { fast: true });
const mocks = vi.hoisted(() => ({ platform: vi.fn(), claims: vi.fn(), user: vi.fn(), id: "operator" }));
vi.mock("@/lib/controlplane/db/open", async (original) => ({ ...await original<typeof import("@/lib/controlplane/db/open")>(), platformDb: mocks.platform }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: { getClaims: mocks.claims, getUser: mocks.user } }) }));
vi.mock("@/lib/supabase/env", () => ({ SUPABASE_URL: "http://auth.test", SUPABASE_PUBLIC_KEY: "", isSupabaseConfigured: () => true }));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: async () => ({ id: mocks.id, email: `${mocks.id}@example.test`, name: "Operator" }) }));
vi.mock("@/lib/server/boot", () => ({ ensureBoot: async () => undefined }));
vi.mock("@/lib/waitlist/enforcement", () => ({ requireProductRequestAccess: async () => undefined }));
const { resetDb } = await import("@/lib/db/store");
const { route } = await import("@/lib/server/request");
const { GET, PUT } = await import("@/app/api/workspace/mfa/route");
const context = { params: Promise.resolve({}) };
const changed = vi.fn(async () => ({ changed: true }));
const mutation = route(changed);
const pgEnabled = process.env.ZENITH_MFA_PG === "1";
const pgUrl = process.env.ZENITH_TEST_PLATFORM_PG_URL;
if (pgEnabled && !pgUrl) throw new Error("ZENITH_MFA_PG=1 requires an owned ZENITH_TEST_PLATFORM_PG_URL.");

it("registers assigned expand-only migration 57 last and enables default-stack TOTP", () => {
  expect(PLATFORM_MIGRATIONS.at(-1)).toEqual(migration0057WorkspaceMfaControls);
  expect(migration0057WorkspaceMfaControls.version).toBe(57);
  expect(migration0057WorkspaceMfaControls.sql).not.toMatch(/drop\s|delete\s|truncate\s/i);
  const config = readFileSync("supabase/config.toml", "utf8");
  const totp = config.split("[auth.mfa.totp]")[1].split("[auth.mfa.phone]")[0];
  expect(totp).toMatch(/^enroll_enabled\s*=\s*true$/m); expect(totp).toMatch(/^verify_enabled\s*=\s*true$/m);
  expect(config).toMatch(/\[auth.mfa\][\s\S]*?max_enrolled_factors\s*=\s*10/);
});

for (const engine of ["pglite", "postgres"] as const) {
  describe.skipIf(engine === "postgres" && !pgEnabled)(`workspace MFA persistence/API [${engine}; postgres needs ZENITH_MFA_PG=1]`, () => {
    let db: PlatformDbHandle, ws: string, other: string;
    beforeAll(async () => { db = await openPlatformDb(engine === "pglite" ? { kind: "pglite" } : { kind: "postgres", url: pgUrl, migrate: true, max: 2 }); }, 60_000);
    afterAll(async () => { await db?.close(); });
    beforeEach(() => {
      vi.clearAllMocks(); ws = `ws_${randomUUID()}`; other = `ws_${randomUUID()}`; mocks.id = randomUUID();
      mocks.platform.mockResolvedValue(db);
      vi.stubEnv("ZENITH_PLATFORM_ORIGIN", "https://zenith.test");
      mocks.claims.mockResolvedValue({ data: { claims: { sub: mocks.id, aal: "aal2", exp: Date.now() / 1000 + 600, amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }] } }, error: null });
      mocks.user.mockResolvedValue({ data: { user: { id: mocks.id, email_confirmed_at: new Date().toISOString(), factors: [{ factor_type: "totp", status: "verified" }] } }, error: null });
      resetDb({ workspaces: [ws, other].map((id) => ({ id, name: id, slug: id, createdAt: new Date().toISOString() })), members: [ws, other].map((workspaceId) => ({ id: mocks.id, workspaceId, name: "Operator", email: `${mocks.id}@example.test`, role: "admin" })) });
    });
    afterEach(() => { vi.unstubAllEnvs(); });
    const input = (expectedVersion = 0) => ({ workspaceId: ws, requireForAllMutations: true, maxAgeSeconds: 300, expectedVersion, actor: { kind: "user" as const, id: mocks.id, name: "Operator" }, correlationId: randomUUID() });
    const body = (over: Record<string, unknown> = {}) => ({ workspaceId: ws, requireForAllMutations: true, maxAgeSeconds: 300, expectedVersion: 0, ...over });
    const request = (payload: unknown = body(), method = "PUT", headers: Record<string, string> = {}) => new NextRequest("https://zenith.test/api/workspace/mfa", { method, headers: { origin: "https://zenith.test", "content-type": "application/json", cookie: `zenith-workspace=${ws}`, ...headers }, ...(method === "GET" ? {} : { body: JSON.stringify(payload) }) });

    it("reads defaults without writing and preserves the mandatory privileged minimum", async () => {
      expect(await controls.getWorkspaceMfaControls(db, ws)).toEqual({ workspaceId: ws, privilegedActionsRequireAal2: true, requireForAllMutations: false, maxAgeSeconds: null, version: 0, isDefault: true });
      expect(await db.query("select workspace_id from platform.workspace_mfa_controls where workspace_id=$1", [ws])).toEqual([]);
      expect(await events.list(db, ws)).toEqual([]);
    });
    it("persists settings and an exact actor/before/after audit in one transaction", async () => {
      const data = input(); const saved = await controls.putWorkspaceMfaControls(db, data);
      expect(saved).toMatchObject({ workspaceId: ws, version: 1, requireForAllMutations: true, maxAgeSeconds: 300, updatedBy: mocks.id, isDefault: false, privilegedActionsRequireAal2: true });
      expect(await controls.getWorkspaceMfaControls(db, ws)).toEqual(saved);
      expect(await events.list(db, ws)).toMatchObject([{ type: "workspace.mfa_controls_changed", workspaceId: ws, actor: { kind: "user", id: mocks.id, name: "Operator" }, correlationId: data.correlationId, data: { before: { version: 0, requireForAllMutations: false, maxAgeSeconds: null }, after: { version: 1, requireForAllMutations: true, maxAgeSeconds: 300 }, privilegedActionsRequireAal2: true } }]);
      expect(await controls.putWorkspaceMfaControls(db, { ...input(1), requireForAllMutations: false, maxAgeSeconds: null })).toMatchObject({ version: 2, requireForAllMutations: false, maxAgeSeconds: null, privilegedActionsRequireAal2: true });
    });
    it("isolates reads, changes and audit history by workspace", async () => {
      const owning = await controls.putWorkspaceMfaControls(db, input());
      expect(await controls.getWorkspaceMfaControls(db, other)).toMatchObject({ workspaceId: other, version: 0, isDefault: true, requireForAllMutations: false });
      await expect(controls.putWorkspaceMfaControls(db, { ...input(1), workspaceId: other })).rejects.toMatchObject({ code: "conflict" });
      await controls.putWorkspaceMfaControls(db, { ...input(), workspaceId: other, requireForAllMutations: false, maxAgeSeconds: null });
      expect(await controls.getWorkspaceMfaControls(db, ws)).toEqual(owning);
      expect((await events.list(db, ws)).every((event) => event.workspaceId === ws)).toBe(true);
      expect((await events.list(db, other)).every((event) => event.workspaceId === other)).toBe(true);
    });
    it("allows exactly one racing initial writer and refuses stale or missing versions", async () => {
      const results = await Promise.allSettled([controls.putWorkspaceMfaControls(db, input()), controls.putWorkspaceMfaControls(db, input())]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const refusal = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
      expect(refusal.reason).toMatchObject({ code: "conflict" });
      await expect(controls.putWorkspaceMfaControls(db, input())).rejects.toMatchObject({ code: "conflict" });
      expect(await events.list(db, ws)).toHaveLength(1);
    });
    it.each([59, 86401, 60.5, NaN])("refuses invalid persisted MFA age %s without writes/audits", async (maxAgeSeconds) => {
      await expect(controls.putWorkspaceMfaControls(db, { ...input(), maxAgeSeconds })).rejects.toMatchObject({ code: "invalid_input" });
      expect((await controls.getWorkspaceMfaControls(db, ws)).version).toBe(0); expect(await events.list(db, ws)).toEqual([]);
    });
    it("rejects a non-human writer and empty tenancy before any write", async () => {
      await expect(controls.putWorkspaceMfaControls(db, { ...input(), actor: { kind: "integration", id: randomUUID(), name: "Test integration" } })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(controls.putWorkspaceMfaControls(db, { ...input(), workspaceId: "" })).rejects.toMatchObject({ code: "invalid_input" });
      expect(await events.list(db, ws)).toEqual([]);
    });
    it("rolls back the settings change when the actual audit insert is refused", async () => {
      const before = await controls.putWorkspaceMfaControls(db, input());
      await db.tx(async (tx) => {
        await tx.query("alter table platform.events add constraint mfa_audit_refusal check (type <> 'workspace.mfa_controls_changed') not valid");
        await expect(controls.putWorkspaceMfaControls(tx, { ...input(1), maxAgeSeconds: 600 })).rejects.toBeDefined();
        expect(await controls.getWorkspaceMfaControls(tx, ws)).toEqual(before); expect(await events.list(tx, ws)).toHaveLength(1);
        await tx.query("alter table platform.events drop constraint mfa_audit_refusal");
      });
    });
    it("requires AAL2 on the real settings PUT, then saves and enforces the new policy", async () => {
      mocks.claims.mockResolvedValueOnce({ data: { claims: { sub: mocks.id, aal: "aal1" } }, error: null });
      expect((await PUT(request(), context)).status).toBe(403); expect(await events.list(db, ws)).toEqual([]);
      expect((await PUT(request(), context)).status).toBe(200);
      const read = await GET(request(undefined, "GET"), context); expect(read.status).toBe(200); expect(await read.json()).toMatchObject({ workspaceId: ws, version: 1, requireForAllMutations: true });
      mocks.claims.mockResolvedValueOnce({ data: { claims: { sub: mocks.id, aal: "aal1" } }, error: null });
      const ordinary = new NextRequest("https://zenith.test/api/ordinary-change", { method: "POST", headers: { origin: "https://zenith.test", cookie: `zenith-workspace=${ws}` } });
      expect((await mutation(ordinary, context)).status).toBe(403); expect(changed).not.toHaveBeenCalled();
    });
    it("refuses expired step-up before changing existing enforcement", async () => {
      await controls.putWorkspaceMfaControls(db, input());
      mocks.claims.mockResolvedValue({ data: { claims: { sub: mocks.id, aal: "aal2", exp: Date.now() / 1000 + 600, amr: [{ method: "totp", timestamp: Date.now() / 1000 - 301 }] } }, error: null });
      expect((await PUT(request(body({ expectedVersion: 1, maxAgeSeconds: null })), context)).status).toBe(403);
      expect((await controls.getWorkspaceMfaControls(db, ws)).maxAgeSeconds).toBe(300); expect(await events.list(db, ws)).toHaveLength(1);
    });
    it("refuses a changed selected workspace and stale version without creating extra audit events", async () => {
      expect((await PUT(request(body({ workspaceId: other })), context)).status).toBe(409);
      expect((await PUT(request(), context)).status).toBe(200); expect((await PUT(request(), context)).status).toBe(409);
      expect(await events.list(db, ws)).toHaveLength(1); expect(await events.list(db, other)).toEqual([]);
    });
    it.each([{}, { requireForAllMutations: "true" }, { maxAgeSeconds: 0 }, { maxAgeSeconds: 90000 }, { maxAgeSeconds: 60.5 }, { privilegedActionsRequireAal2: false }, { expectedVersion: -1 }])("rejects malformed/weakening controls at the API %j", async (fields) => {
      const payload = Object.keys(fields).length ? body(fields) : {};
      expect((await PUT(request(payload), context)).status).toBe(400);
      expect((await controls.getWorkspaceMfaControls(db, ws)).version).toBe(0); expect(await events.list(db, ws)).toEqual([]);
    });
    it("keeps viewer access read-only even with AAL2", async () => {
      resetDb({ workspaces: [{ id: ws, name: ws, slug: ws, createdAt: new Date().toISOString() }], members: [{ id: mocks.id, workspaceId: ws, name: "Viewer", email: `${mocks.id}@example.test`, role: "viewer" }] });
      expect((await GET(request(undefined, "GET"), context)).status).toBe(200); expect((await PUT(request(), context)).status).toBe(403);
      expect(await events.list(db, ws)).toEqual([]);
    });
    it("fails closed when the platform store is unavailable", async () => {
      mocks.platform.mockRejectedValue(new Error(randomUUID()));
      await expect(workspaceMfaControl(ws)).rejects.toMatchObject({ status: 503 });
      expect((await PUT(request(), context)).status).toBe(503); expect(await events.list(db, ws)).toEqual([]);
    });
  });
}

describe("MFA table permissions on an owned PGlite database", () => {
  it("enables RLS, denies browser roles and grants service reads/inserts/updates only", async () => {
    const db = await openPlatformDb({ kind: "pglite" });
    try {
      await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
      await db.exec(migration0057WorkspaceMfaControls.sql);
      const [rls] = await db.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where oid='platform.workspace_mfa_controls'::regclass"); expect(rls.relrowsecurity).toBe(true);
      for (const role of ["anon", "authenticated"]) {
        const [row] = await db.query<{ allowed: boolean }>("select has_table_privilege($1, 'platform.workspace_mfa_controls', 'select,insert,update,delete') as allowed", [role]); expect(row.allowed).toBe(false);
      }
      const [service] = await db.query<{ read: boolean; insert: boolean; update: boolean; delete: boolean }>("select has_table_privilege('service_role','platform.workspace_mfa_controls','select') as read, has_table_privilege('service_role','platform.workspace_mfa_controls','insert') as insert, has_table_privilege('service_role','platform.workspace_mfa_controls','update') as update, has_table_privilege('service_role','platform.workspace_mfa_controls','delete') as delete");
      expect(service).toEqual({ read: true, insert: true, update: true, delete: false });
    } finally { await db.close(); }
  }, 60_000);
});
