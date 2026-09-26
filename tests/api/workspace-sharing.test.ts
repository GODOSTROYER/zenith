/** The HTTP sharing contract, including the real request and permission boundary. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest as RequestType } from "next/server";
import type { SessionUser } from "@/lib/auth/session";
import type { Invite, Member, Workspace } from "@/lib/domain/types";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-sharing-api-", { fast: true });
process.env.ZENITH_STORE = "file";
process.env.ZENITH_HOSTED_MODE = "1";

const state = vi.hoisted(() => ({ user: null as SessionUser | null }));
vi.mock("@/lib/server/boot", () => ({ ensureBoot: async () => undefined }));
vi.mock("@/lib/supabase/env", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: async () => state.user }));
vi.mock("@/lib/waitlist/enforcement", () => ({ requireProductRequestAccess: async () => undefined }));

const { GET: sharing } = await import("@/app/api/workspace/sharing/route");
const { GET: invitations } = await import("@/app/api/workspace/invitations/route");
const { GET: listInvites, POST: invite } = await import("@/app/api/workspace/invites/route");
const { DELETE: revoke } = await import("@/app/api/workspace/invites/[id]/route");
const { POST: renew } = await import("@/app/api/workspace/invites/[id]/resend/route");
const { POST: accept } = await import("@/app/api/workspace/invites/[id]/accept/route");
const { PATCH: changeRole, DELETE: remove } = await import("@/app/api/workspace/members/[id]/route");
const { POST: transfer } = await import("@/app/api/workspace/ownership/route");
const { POST: leave } = await import("@/app/api/workspace/leave/route");
const { WORKSPACE_COOKIE } = await import("@/lib/server/workspace");
const { db, readAudit, resetDb } = await import("@/lib/db/store");
const { NextRequest } = await import("next/server");

type Handler = (req: RequestType, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
type RequestOptions = { body?: unknown; rawBody?: string; selected?: string; id?: string };
const call = (handler: Handler, method: string, path: string, opts: RequestOptions = {}) => handler(
  new NextRequest(`https://zenith.test/api/workspace/${path}`, {
    method,
    headers: { cookie: `${WORKSPACE_COOKIE}=${opts.selected ?? "w-atlas"}`, "content-type": "application/json" },
    ...(opts.rawBody !== undefined ? { body: opts.rawBody } : opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  }),
  { params: Promise.resolve({ id: opts.id ?? "unused" }) },
);
const workspace = (id: string, ownerId: string): Workspace => ({
  id, ownerId, name: id === "w-atlas" ? "Atlas" : "Orbit", slug: id, createdAt: "2026-01-01T00:00:00.000Z",
});
const member = (id: string, workspaceId: string, role: Member["role"]): Member => ({
  id, workspaceId, role, name: id, email: `${id}@example.com`,
});
const pending = (id: string, workspaceId = "w-atlas", email = "guest@example.com", role: Member["role"] = "viewer"): Invite => ({
  id, workspaceId, email, role, createdBy: "owner", createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
const signIn = (id: string, email = `${id}@example.com`) => { state.user = { id, email, name: id }; };
const storedInvites = () => db().settings.invites as Invite[];
const accessSnapshot = () => structuredClone({ workspaces: db().workspaces, members: db().members, invites: storedInvites() });

beforeEach(() => {
  signIn("owner");
  resetDb({
    workspaces: [workspace("w-atlas", "owner"), workspace("w-orbit", "orbit-owner")],
    members: [member("owner", "w-atlas", "admin"), member("admin", "w-atlas", "admin"),
      member("editor", "w-atlas", "editor"), member("viewer", "w-atlas", "viewer"),
      member("orbit-owner", "w-orbit", "admin"), member("owner", "w-orbit", "admin")],
    settings: { invites: [pending("i-atlas"), pending("i-orbit", "w-orbit", "orbit-guest@example.com")] },
  });
});

describe("workspace sharing reads", () => {
  it("lets a viewer inspect their workspace but does not expose invitations or management access", async () => {
    signIn("viewer");
    const response = await call(sharing, "GET", "sharing?workspaceId=w-atlas");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ role: "viewer", isOwner: false, canManageMembers: false, canManageAdmins: false, invites: [] });
    expect(body.members.map((row: Member) => row.workspaceId)).toEqual(["w-atlas", "w-atlas", "w-atlas", "w-atlas"]);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("shows an admin only the selected workspace's invitations", async () => {
    signIn("admin");
    const response = await call(listInvites, "GET", "invites?workspaceId=w-atlas");
    expect(response.status).toBe(200);
    expect((await response.json()).invites.map((row: Invite) => row.id)).toEqual(["i-atlas"]);
  });

  it("does not use a forged workspace cookie to grant access", async () => {
    signIn("viewer");
    const response = await call(sharing, "GET", "sharing?workspaceId=w-orbit", { selected: "w-orbit" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { message: "Your active workspace changed in another tab." } });
  });

  it("refuses an authenticated nonmember before returning sharing data", async () => {
    signIn("outsider");
    const response = await call(sharing, "GET", "sharing");
    expect(response.status).toBe(403);
    expect(db().members.some((row) => row.id === "outsider")).toBe(false);
  });
});

describe("workspace sharing permission boundary", () => {
  const managedRoutes: [string, Handler, string, string, RequestOptions][] = [
    ["list invitations", listInvites, "GET", "invites", {}],
    ["invite", invite, "POST", "invites", { body: { email: "new@example.com", role: "viewer" } }],
    ["change role", changeRole, "PATCH", "members/editor", { id: "editor", body: { role: "viewer" } }],
    ["remove member", remove, "DELETE", "members/editor", { id: "editor" }],
    ["revoke invite", revoke, "DELETE", "invites/i-atlas", { id: "i-atlas" }],
    ["renew invite", renew, "POST", "invites/i-atlas/resend", { id: "i-atlas", body: {} }],
    ["transfer ownership", transfer, "POST", "ownership", { body: { memberId: "editor" } }],
  ];
  for (const role of ["viewer", "editor"] as const) {
    it.each(managedRoutes)(`prevents a ${role} from %s`, async (_name, handler, method, path, options) => {
      signIn(role);
      const before = accessSnapshot();
      const response = await call(handler, method, path, options);
      expect(response.status).toBe(403);
      expect(accessSnapshot()).toEqual(before);
      expect(readAudit({ workspaceId: "w-atlas" })).toHaveLength(0);
    });
  }

  it.each([
    ["invite an admin", invite, "POST", "invites", { body: { email: "next@example.com", role: "admin" } }],
    ["promote an admin", changeRole, "PATCH", "members/editor", { id: "editor", body: { role: "admin" } }],
    ["demote an admin", changeRole, "PATCH", "members/admin", { id: "admin", body: { role: "editor" } }],
    ["remove an admin", remove, "DELETE", "members/admin", { id: "admin" }],
    ["transfer ownership", transfer, "POST", "ownership", { body: { memberId: "editor" } }],
  ] satisfies [string, Handler, string, string, RequestOptions][])("prevents a non-owner admin from trying to %s", async (_name, handler, method, path, opts) => {
    signIn("admin");
    const before = accessSnapshot();
    const response = await call(handler, method, path, opts);
    expect(response.status).toBe(403);
    expect(accessSnapshot()).toEqual(before);
  });

  it("allows an admin to invite an editor and normalizes the recipient email", async () => {
    signIn("admin");
    const response = await call(invite, "POST", "invites", { body: { email: " New@Example.COM ", role: "editor", workspaceId: "w-atlas" } });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.invite).toMatchObject({ email: "new@example.com", role: "editor", workspaceId: "w-atlas", createdBy: "admin" });
    expect(body.inviteUrl).toBe(`/invite?invite=${encodeURIComponent(body.invite.id)}`);
    expect(Date.parse(body.invite.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("returns 404 when an admin tries to mutate an invitation in another workspace", async () => {
    const before = accessSnapshot();
    const response = await call(revoke, "DELETE", "invites/i-orbit?workspaceId=w-atlas", { id: "i-orbit" });
    expect(response.status).toBe(404);
    expect(accessSnapshot()).toEqual(before);
  });
});

describe("stale sharing tabs", () => {
  it.each([
    ["sharing read", sharing, "GET", "sharing?workspaceId=w-atlas", {}],
    ["invitation read", listInvites, "GET", "invites?workspaceId=w-atlas", {}],
    ["invitation creation", invite, "POST", "invites", { body: { workspaceId: "w-atlas", email: "next@example.com", role: "viewer" } }],
    ["role change", changeRole, "PATCH", "members/editor", { id: "editor", body: { workspaceId: "w-atlas", role: "viewer" } }],
    ["member removal", remove, "DELETE", "members/editor?workspaceId=w-atlas", { id: "editor" }],
    ["invitation revocation", revoke, "DELETE", "invites/i-atlas?workspaceId=w-atlas", { id: "i-atlas" }],
    ["invitation renewal", renew, "POST", "invites/i-atlas/resend", { id: "i-atlas", body: { workspaceId: "w-atlas" } }],
    ["ownership transfer", transfer, "POST", "ownership", { body: { workspaceId: "w-atlas", memberId: "editor" } }],
    ["leaving", leave, "POST", "leave", { body: { workspaceId: "w-atlas" } }],
  ] satisfies [string, Handler, string, string, RequestOptions][])("refuses %s when another tab changed the selected workspace", async (_name, handler, method, path, opts) => {
    const before = accessSnapshot();
    const response = await call(handler, method, path, { ...opts, selected: "w-orbit" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { message: "Your active workspace changed in another tab." } });
    expect(accessSnapshot()).toEqual(before);
  });
});

describe("sharing request validation", () => {
  it.each([
    { email: "not-an-email", role: "viewer" },
    { email: "new@example.com", role: "owner" },
    { email: "new@example.com", role: "EDITOR" },
    { email: "new@example.com", role: "viewer", workspaceId: 4 },
    null,
  ])("rejects an invalid invitation body: %j", async (body) => {
    const before = accessSnapshot();
    expect((await call(invite, "POST", "invites", { body })).status).toBe(400);
    expect(accessSnapshot()).toEqual(before);
  });

  it.each(["owner", "", null, 1])("rejects invalid member role %j", async (role) => {
    const before = accessSnapshot();
    expect((await call(changeRole, "PATCH", "members/editor", { id: "editor", body: { role } })).status).toBe(400);
    expect(accessSnapshot()).toEqual(before);
  });

  it.each([
    ["invite", invite, "POST", "invites", {}],
    ["change role", changeRole, "PATCH", "members/editor", { id: "editor" }],
    ["transfer", transfer, "POST", "ownership", {}],
    ["renew", renew, "POST", "invites/i-atlas/resend", { id: "i-atlas" }],
    ["leave", leave, "POST", "leave", {}],
  ] satisfies [string, Handler, string, string, RequestOptions][])("rejects malformed JSON for %s", async (_name, handler, method, path, opts) => {
    signIn("admin");
    const before = accessSnapshot();
    const response = await call(handler, method, path, { ...opts, rawBody: "{broken" });
    expect(response.status).toBe(400);
    expect(accessSnapshot()).toEqual(before);
  });
});

describe("recipient-bound invitation acceptance", () => {
  it("lists only live invitations addressed to the signed-in email, without accepting any", async () => {
    signIn("guest", "GUEST@example.com");
    const expired = { ...pending("expired"), expiresAt: "2020-01-01T00:00:00.000Z" };
    const revoked = { ...pending("revoked"), revokedAt: new Date().toISOString() };
    const accepted = { ...pending("accepted"), acceptedAt: new Date().toISOString() };
    storedInvites().push(expired, revoked, accepted, pending("missing-workspace", "missing"));
    const response = await call(invitations, "GET", "invitations");
    expect(response.status).toBe(200);
    expect((await response.json()).invitations).toEqual([expect.objectContaining({ id: "i-atlas", workspaceName: "Atlas" })]);
    expect(db().members.some((row) => row.id === "guest")).toBe(false);
    expect(storedInvites()[0].acceptedAt).toBeUndefined();
  });

  it("lets a signed-in member explicitly accept a second workspace and selects it in an httpOnly cookie", async () => {
    storedInvites().push(pending("second-workspace", "w-orbit", "editor@example.com", "viewer"));
    signIn("editor");
    const response = await call(accept, "POST", "invites/second-workspace/accept", { id: "second-workspace" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ workspace: { id: "w-orbit" }, member: { id: "editor", role: "viewer", workspaceId: "w-orbit" } });
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain(`${WORKSPACE_COOKIE}=w-orbit`);
    expect(cookie).toMatch(/httponly/i);
    expect(cookie).toMatch(/samesite=lax/i);
    expect(cookie).toContain("Path=/");
    expect(db().members.filter((row) => row.id === "editor").map((row) => row.workspaceId)).toEqual(["w-atlas", "w-orbit"]);
    expect(storedInvites().find((row) => row.id === "second-workspace")?.acceptedAt).toBeTruthy();
  });

  it("accepts a first workspace even when the caller has no current membership", async () => {
    signIn("guest");
    const response = await call(accept, "POST", "invites/i-atlas/accept", { id: "i-atlas" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ member: { id: "guest", role: "viewer", workspaceId: "w-atlas" } });
    expect(db().members.filter((row) => row.id === "guest")).toHaveLength(1);
  });

  it("refuses a different signed-in email even when that person already belongs to the workspace", async () => {
    signIn("editor");
    const before = accessSnapshot();
    const response = await call(accept, "POST", "invites/i-atlas/accept", { id: "i-atlas" });
    expect(response.status).toBe(404);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(accessSnapshot()).toEqual(before);
  });

  it("requires a signed-in account for listing and accepting invitations", async () => {
    state.user = null;
    const before = accessSnapshot();
    expect((await call(invitations, "GET", "invitations")).status).toBe(401);
    expect((await call(accept, "POST", "invites/i-atlas/accept", { id: "i-atlas" })).status).toBe(401);
    expect(accessSnapshot()).toEqual(before);
  });

  it.each(["expired", "revoked"])("returns 410 for an %s invitation without selecting a workspace", async (status) => {
    signIn("guest");
    if (status === "expired") storedInvites()[0].expiresAt = "2020-01-01T00:00:00.000Z";
    else storedInvites()[0].revokedAt = new Date().toISOString();
    const before = accessSnapshot();
    const response = await call(accept, "POST", "invites/i-atlas/accept", { id: "i-atlas" });
    expect(response.status).toBe(410);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(accessSnapshot()).toEqual(before);
  });

  it("allows a retry without a duplicate membership or changing the granted role", async () => {
    signIn("guest");
    expect((await call(accept, "POST", "invites/i-atlas/accept", { id: "i-atlas" })).status).toBe(200);
    db().members.find((row) => row.id === "guest")!.role = "editor";
    const response = await call(accept, "POST", "invites/i-atlas/accept", { id: "i-atlas" });
    expect(response.status).toBe(200);
    expect((await response.json()).member.role).toBe("editor");
    expect(db().members.filter((row) => row.id === "guest")).toHaveLength(1);
  });
});

describe("ownership and leaving a workspace", () => {
  it("transfers ownership to an existing viewer, promotes them, and removes the old owner's transfer authority", async () => {
    const response = await call(transfer, "POST", "ownership", { body: { workspaceId: "w-atlas", memberId: "viewer" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ workspace: { ownerId: "viewer" }, member: { id: "viewer", role: "admin" } });
    const second = await call(transfer, "POST", "ownership", { body: { workspaceId: "w-atlas", memberId: "editor" } });
    expect(second.status).toBe(403);
    signIn("viewer");
    expect((await call(changeRole, "PATCH", "members/owner", { id: "owner", body: { role: "editor", workspaceId: "w-atlas" } })).status).toBe(200);
  });

  it("prevents the owner from leaving before transferring ownership", async () => {
    const before = accessSnapshot();
    expect((await call(leave, "POST", "leave", { body: { workspaceId: "w-atlas" } })).status).toBe(409);
    expect(accessSnapshot()).toEqual(before);
  });

  it("lets a viewer leave, clears the selection cookie, and refuses further workspace access", async () => {
    signIn("viewer");
    const response = await call(leave, "POST", "leave", { body: { workspaceId: "w-atlas" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(`${WORKSPACE_COOKIE}=;`);
    expect(response.headers.get("set-cookie")).toContain("Expires=Thu, 01 Jan 1970");
    expect(db().members.some((row) => row.id === "viewer")).toBe(false);
    expect((await call(sharing, "GET", "sharing")).status).toBe(403);
  });
});
