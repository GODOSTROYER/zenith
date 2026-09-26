/** File-store sharing decisions use the real serialized mutation gate. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Invite, Member, Workspace } from "@/lib/domain/types";
import type { SharingInput } from "@/lib/server/workspace-sharing";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-sharing-");
process.env.ZENITH_STORE = "file";
vi.mock("@/lib/supabase/env", () => ({ isSupabaseConfigured: () => true }));

const { db, readAudit, resetDb } = await import("@/lib/db/store");
const { INVITE_LIFETIME_MS, mutateSharing, pendingInvitations, sharingDetails } = await import("@/lib/server/workspace-sharing");
const { readInvites, workspaceOwnerId } = await import("@/lib/server/membership");

const AT = "2026-09-01T00:00:00.000Z";
const identity = (id: string) => ({ id, email: `${id}@example.test`, name: id });
const actor = (id: string) => ({ actorId: id, actorEmail: identity(id).email, actorName: id });
const member = (id: string, role: Member["role"], workspaceId = "ws-a"): Member => ({ ...identity(id), role, workspaceId });
const workspace = (id: string, ownerId?: string): Workspace => ({ id, ownerId, name: id, slug: id, createdAt: AT });
const invite = (overrides: Partial<Invite> = {}): Invite => ({
  id: "invite-a", workspaceId: "ws-a", email: "recipient@example.test", role: "editor",
  createdBy: "owner", createdAt: AT, expiresAt: new Date(Date.now() + 60_000).toISOString(), ...overrides,
});
const run = (operation: SharingInput["operation"], as = "owner", fields: Partial<SharingInput> = {}) =>
  mutateSharing({ operation, workspaceId: "ws-a", ...actor(as), ...fields });
const findMember = (id: string, workspaceId = "ws-a") => db().members.find((row) => row.id === id && row.workspaceId === workspaceId);
const here = () => db().workspaces.find((row) => row.id === "ws-a")!;

beforeEach(() => {
  resetDb({
    workspaces: [workspace("ws-a", "owner"), workspace("ws-b", "other-owner")],
    members: [member("owner", "admin"), member("admin", "admin"), member("editor", "editor"), member("viewer", "viewer"), member("other-owner", "admin", "ws-b")],
    settings: { invites: [] },
  });
});

describe("workspace sharing permissions", () => {
  it.each([
    ["owner", "admin", true, true], ["admin", "admin", true, false],
    ["editor", "editor", false, false], ["viewer", "viewer", false, false],
  ] as const)("reports %s capabilities and scopes invitation visibility", (id, role, canManage, isOwner) => {
    db().settings.invites = [invite(), invite({ id: "other", workspaceId: "ws-b" })];
    const result = sharingDetails(here(), id);
    expect(result).toMatchObject({ role, isOwner, canManageMembers: canManage, canManageAdmins: isOwner });
    expect(result.members.map((row) => row.id)).toEqual(["owner", "admin", "editor", "viewer"]);
    expect(result.invites.map((row) => row.id)).toEqual(canManage ? ["invite-a"] : []);
  });

  it.each(["editor", "viewer"])("refuses every management operation for %s", async (id) => {
    db().settings.invites = [invite()];
    const operations: SharingInput["operation"][] = ["change-role", "remove-member", "transfer", "invite", "revoke", "resend"];
    for (const operation of operations) {
      await expect(run(operation, id, { memberId: "viewer", role: "editor", inviteId: "invite-a", email: "new@example.test" })).rejects.toMatchObject({ status: 403 });
    }
    expect(findMember("viewer")?.role).toBe("viewer");
    expect(readInvites()).toHaveLength(1);
    expect(readAudit({ workspaceId: "ws-a" })).toHaveLength(0);
  });

  it("lets an admin manage lower roles, invite collaborators, and remove members", async () => {
    await run("change-role", "admin", { memberId: "viewer", role: "editor" });
    expect(findMember("viewer")?.role).toBe("editor");
    await run("change-role", "admin", { memberId: "editor", role: "viewer" });
    expect(findMember("editor")?.role).toBe("viewer");
    const issued = await run("invite", "admin", { email: "new@example.test", role: "viewer" });
    expect(issued.invite).toMatchObject({ role: "viewer", createdBy: "admin" });
    await run("remove-member", "admin", { memberId: "editor" });
    expect(findMember("editor")).toBeUndefined();
  });

  it("refuses granting or changing admin access without ownership", async () => {
    db().members.push(member("second-admin", "admin"));
    db().settings.invites = [invite({ role: "admin" })];
    for (const fields of [{ memberId: "viewer", role: "admin" }, { memberId: "second-admin", role: "viewer" }, { memberId: "admin", role: "editor" }] as const)
      await expect(run("change-role", "admin", fields)).rejects.toMatchObject({ status: 403 });
    await expect(run("remove-member", "admin", { memberId: "second-admin" })).rejects.toMatchObject({ status: 403 });
    await expect(run("invite", "admin", { email: "new@example.test", role: "admin" })).rejects.toMatchObject({ status: 403 });
    for (const operation of ["revoke", "resend"] as const)
      await expect(run(operation, "admin", { inviteId: "invite-a" })).rejects.toMatchObject({ status: 403 });
    expect(findMember("second-admin")?.role).toBe("admin");
  });

  it("allows the owner to grant and remove admin access", async () => {
    await run("change-role", "owner", { memberId: "viewer", role: "admin" });
    expect(findMember("viewer")?.role).toBe("admin");
    await run("change-role", "owner", { memberId: "admin", role: "editor" });
    await run("remove-member", "owner", { memberId: "viewer" });
    expect(findMember("viewer")).toBeUndefined();
    expect(findMember("admin")?.role).toBe("editor");
    expect((await run("invite", "owner", { email: "next-admin@example.test", role: "admin" })).invite?.role).toBe("admin");
  });

  it.each(["admin", "editor", "viewer"])("allows %s to leave without removing another member", async (id) => {
    const result = await run("leave", id, { memberId: "owner" });
    expect(result.removed?.id).toBe(id);
    expect(findMember(id)).toBeUndefined();
    expect(findMember("owner")?.role).toBe("admin");
  });

  it("rejects strangers even when they own another workspace", async () => {
    expect(() => sharingDetails(here(), "other-owner")).toThrow(/not a member/);
    await expect(run("invite", "other-owner", { email: "new@example.test", role: "viewer" })).rejects.toMatchObject({ status: 403 });
    await expect(run("leave", "other-owner")).rejects.toMatchObject({ status: 403 });
  });

  it("looks up a member and invitation inside the selected workspace", async () => {
    db().settings.invites = [invite({ workspaceId: "ws-b" })];
    for (const operation of ["change-role", "remove-member", "transfer"] as const)
      await expect(run(operation, "owner", { memberId: "other-owner", role: "viewer" })).rejects.toMatchObject({ status: 404 });
    for (const operation of ["revoke", "resend"] as const)
      await expect(run(operation, "owner", { inviteId: "invite-a" })).rejects.toMatchObject({ status: 404 });
    expect(findMember("other-owner", "ws-b")?.role).toBe("admin");
    expect(readInvites()[0].revokedAt).toBeUndefined();
  });

  it("uses the actor's role in this workspace when they have another admin seat", async () => {
    db().members.unshift(member("viewer", "admin", "ws-b"));
    await expect(run("invite", "viewer", { email: "new@example.test", role: "viewer" })).rejects.toMatchObject({ status: 403 });
    await run("change-role", "owner", { memberId: "viewer", role: "editor" });
    expect(findMember("viewer", "ws-a")?.role).toBe("editor");
    expect(findMember("viewer", "ws-b")?.role).toBe("admin");
  });
});

describe("ownership and concurrent membership changes", () => {
  it("protects an owner from leaving, removal and demotion even with another admin", async () => {
    await expect(run("leave")).rejects.toMatchObject({ status: 409 });
    await expect(run("remove-member", "owner", { memberId: "owner" })).rejects.toMatchObject({ status: 409 });
    for (const role of ["viewer", "editor"] as const)
      await expect(run("change-role", "owner", { memberId: "owner", role })).rejects.toMatchObject({ status: 409 });
    expect(findMember("owner")?.role).toBe("admin");
  });

  it("atomically promotes a member to owner while retaining the former owner's admin role", async () => {
    const result = await run("transfer", "owner", { memberId: "viewer" });
    expect(result.workspace?.ownerId).toBe("viewer");
    expect(findMember("viewer")?.role).toBe("admin");
    expect(findMember("owner")?.role).toBe("admin");
    await expect(run("transfer", "owner", { memberId: "admin" })).rejects.toMatchObject({ status: 403 });
    await expect(run("leave", "viewer")).rejects.toMatchObject({ status: 409 });
    await run("change-role", "viewer", { memberId: "owner", role: "editor" });
    expect(findMember("owner")?.role).toBe("editor");
    expect(readAudit({ workspaceId: "ws-a", actionId: "workspace.transfer" })).toHaveLength(1);
  });

  it("does not permit an admin to transfer ownership", async () => {
    await expect(run("transfer", "admin", { memberId: "viewer" })).rejects.toMatchObject({ status: 403 });
    expect(here().ownerId).toBe("owner");
  });

  it.each(["started", "doors-closed", "identity-delete-attempted", "identity-deleted"])("refuses transfer to a member whose account deletion is %s", async (stage) => {
    db().settings.pendingAccountDeletions = [{ operationId: "deletion", user: identity("viewer"), stage, updatedAt: AT }];
    await expect(run("transfer", "owner", { memberId: "viewer" })).rejects.toMatchObject({
      status: 409, message: "That member is deleting their account. Choose another owner.",
    });
    expect(here().ownerId).toBe("owner");
    expect(findMember("viewer")?.role).toBe("viewer");
    expect(findMember("owner")?.role).toBe("admin");
    expect(readAudit({ workspaceId: "ws-a", actionId: "workspace.transfer" })).toHaveLength(0);
  });

  it("allows transfer when an unrelated member has a pending account deletion", async () => {
    db().settings.pendingAccountDeletions = [{ operationId: "deletion", user: identity("editor"), stage: "started", updatedAt: AT }];
    await run("transfer", "owner", { memberId: "viewer" });
    expect(here().ownerId).toBe("viewer");
    expect(findMember("viewer")?.role).toBe("admin");
  });

  it("persists the deterministic legacy owner before member mutations", async () => {
    delete here().ownerId;
    db().members.reverse();
    expect(workspaceOwnerId(here())).toBe("admin");
    await run("change-role", "admin", { memberId: "owner", role: "viewer" });
    expect(here().ownerId).toBe("admin");
    db().members.unshift(member("a-new-admin", "admin"));
    expect(workspaceOwnerId(here())).toBe("admin");
  });

  it("preserves an admin when both remaining admins try to leave concurrently", async () => {
    db().members = db().members.filter((row) => row.role === "admin");
    const results = await Promise.allSettled([run("leave", "admin"), run("leave", "owner")]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(results[1]).toMatchObject({ reason: { status: 409 } });
    expect(db().members.filter((row) => row.workspaceId === "ws-a")).toEqual([member("owner", "admin")]);
  });

  it("still preserves the last admin if an imported workspace has a stale owner reference", async () => {
    // Exercise the last-admin backstop independently of owner protection.
    // Another workspace's admin must not count as a replacement here.
    here().ownerId = "deleted-legacy-owner";
    const results = await Promise.allSettled([run("leave", "owner"), run("leave", "admin")]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(results[1]).toMatchObject({ reason: { status: 409, message: "The workspace must retain an admin." } });
    expect(db().members.filter((row) => row.workspaceId === "ws-a" && row.role === "admin").map((row) => row.id)).toEqual(["admin"]);
  });

  it("serializes competing transfers against the latest owner", async () => {
    const results = await Promise.allSettled([
      run("transfer", "owner", { memberId: "editor" }),
      run("transfer", "owner", { memberId: "viewer" }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(results[1]).toMatchObject({ reason: { status: 403 } });
    expect(here().ownerId).toBe("editor");
    expect(findMember("viewer")?.role).toBe("viewer");
  });

  it("does not execute a queued admin operation after that admin was demoted", async () => {
    const results = await Promise.allSettled([
      run("change-role", "owner", { memberId: "admin", role: "viewer" }),
      run("invite", "admin", { email: "new@example.test", role: "viewer" }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(results[1]).toMatchObject({ reason: { status: 403 } });
    expect(readInvites()).toEqual([]);
  });
});

describe("invitation lifecycle", () => {
  it("normalizes addresses, expires after seven days and records an audit", async () => {
    const started = Date.now();
    const result = await run("invite", "owner", { email: "  Invitee@Example.Test  ", role: "editor" });
    expect(result.invite).toMatchObject({ email: "invitee@example.test", role: "editor", createdBy: "owner", workspaceId: "ws-a" });
    expect(Date.parse(result.invite!.expiresAt!)).toBeGreaterThanOrEqual(started + INVITE_LIFETIME_MS);
    expect(Date.parse(result.invite!.expiresAt!)).toBeLessThanOrEqual(Date.now() + INVITE_LIFETIME_MS);
    expect(readAudit({ workspaceId: "ws-a", actionId: "workspace.invite" })[0]).toMatchObject({ actor: { id: "owner" }, input: { inviteId: result.invite!.id, role: "editor" } });
  });

  it("rejects duplicate offers and existing members case-insensitively within a workspace", async () => {
    await run("invite", "owner", { email: "new@example.test", role: "viewer" });
    await expect(run("invite", "owner", { email: " NEW@EXAMPLE.TEST ", role: "editor" })).rejects.toMatchObject({ status: 409 });
    await expect(run("invite", "owner", { email: " VIEWER@EXAMPLE.TEST ", role: "editor" })).rejects.toMatchObject({ status: 409 });
    await expect(run("invite", "other-owner", { workspaceId: "ws-b", email: "new@example.test", role: "viewer" })).resolves.toMatchObject({ invite: { workspaceId: "ws-b" } });
  });

  it("serializes two simultaneous invitations to the same normalized address", async () => {
    const results = await Promise.allSettled([
      run("invite", "owner", { email: "Race@example.test", role: "viewer" }),
      run("invite", "admin", { email: " race@EXAMPLE.TEST ", role: "editor" }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(results[1]).toMatchObject({ reason: { status: 409 } });
    expect(readInvites()).toHaveLength(1);
  });

  it("renews an expired offer without changing its role or identifier", async () => {
    db().settings.invites = [invite({ expiresAt: "2000-01-01T00:00:00.000Z" })];
    const result = await run("resend", "admin", { inviteId: "invite-a" });
    expect(result.invite).toMatchObject({ id: "invite-a", role: "editor", email: "recipient@example.test" });
    expect(Date.parse(result.invite!.expiresAt!)).toBeGreaterThan(Date.now());
    expect(readInvites()).toHaveLength(1);
  });

  it("does not revive an expired offer when a newer one is pending", async () => {
    db().settings.invites = [invite({ expiresAt: "2000-01-01T00:00:00.000Z" })];
    await run("invite", "owner", { email: "recipient@example.test", role: "viewer" });
    await expect(run("resend", "owner", { inviteId: "invite-a" })).rejects.toMatchObject({ status: 409 });
    expect(readInvites()[0].expiresAt).toBe("2000-01-01T00:00:00.000Z");
  });

  it("revokes idempotently and requires a new invitation instead of renewing a revoked link", async () => {
    db().settings.invites = [invite()];
    await run("revoke", "admin", { inviteId: "invite-a" });
    const revokedAt = readInvites()[0].revokedAt;
    await run("revoke", "admin", { inviteId: "invite-a" });
    expect(readInvites()[0].revokedAt).toBe(revokedAt);
    await expect(run("resend", "admin", { inviteId: "invite-a" })).rejects.toMatchObject({ status: 409 });
    expect((await run("invite", "admin", { email: "recipient@example.test", role: "viewer" })).invite?.id).not.toBe("invite-a");
  });

  it("revokes outstanding invitations when a member is removed", async () => {
    db().settings.invites = [invite({ email: identity("viewer").email }), invite({ id: "other-workspace", workspaceId: "ws-b", email: identity("viewer").email })];
    await run("remove-member", "owner", { memberId: "viewer" });
    expect(readInvites()[0].revokedAt).toBeTruthy();
    expect(readInvites()[1].revokedAt).toBeUndefined();
    await expect(run("accept", "viewer", { inviteId: "invite-a" })).rejects.toMatchObject({ status: 410 });
  });

  it("lists only live invitations addressed to the signed-in user", async () => {
    db().settings.invites = [
      invite(), invite({ id: "other-email", email: "someone-else@example.test" }),
      invite({ id: "expired", expiresAt: "2000-01-01T00:00:00.000Z" }),
      invite({ id: "revoked", revokedAt: AT }), invite({ id: "accepted", acceptedAt: AT }),
      invite({ id: "missing-workspace", workspaceId: "missing" }),
      invite({ id: "second-workspace", workspaceId: "ws-b" }),
    ];
    expect((await pendingInvitations({ id: "recipient", email: "RECIPIENT@example.test", name: "Recipient" })).map((row) => [row.id, row.workspaceName])).toEqual([
      ["invite-a", "ws-a"], ["second-workspace", "ws-b"],
    ]);
  });
});

describe("recipient-bound invitation acceptance", () => {
  beforeEach(() => { db().settings.invites = [invite()]; });

  it("refuses a different signed-in email without consuming the invitation", async () => {
    await expect(run("accept", "stranger", { inviteId: "invite-a" })).rejects.toMatchObject({ status: 404 });
    expect(readInvites()[0].acceptedAt).toBeUndefined();
    expect(findMember("stranger")).toBeUndefined();
  });

  it("accepts case-insensitively in the invited workspace and preserves existing workspaces", async () => {
    db().members.push(member("recipient", "admin", "ws-b"));
    const result = await run("accept", "recipient", { workspaceId: "ws-b", actorEmail: "RECIPIENT@example.test", inviteId: "invite-a" });
    expect(result).toMatchObject({ workspace: { id: "ws-a" }, member: { id: "recipient", workspaceId: "ws-a", role: "editor" } });
    expect(findMember("recipient", "ws-b")?.role).toBe("admin");
    expect(findMember("recipient", "ws-a")?.role).toBe("editor");
    expect(readInvites()[0].acceptedAt).toBeTruthy();
  });

  it("does not overwrite a membership granted after an invitation was issued", async () => {
    db().members.push(member("recipient", "viewer"));
    readInvites()[0].role = "admin";
    const result = await run("accept", "recipient", { inviteId: "invite-a" });
    expect(result.member?.role).toBe("viewer");
    expect(db().members.filter((row) => row.id === "recipient" && row.workspaceId === "ws-a")).toHaveLength(1);
  });

  it("makes repeated and concurrent accepts idempotent without a duplicate member or audit", async () => {
    const results = await Promise.all([
      run("accept", "recipient", { inviteId: "invite-a" }),
      run("accept", "recipient", { inviteId: "invite-a" }),
    ]);
    expect(results.map((result) => result.member?.id)).toEqual(["recipient", "recipient"]);
    expect(db().members.filter((row) => row.id === "recipient")).toHaveLength(1);
    expect(readAudit({ workspaceId: "ws-a", actionId: "workspace.accept" })).toHaveLength(1);
  });

  it.each([
    { expiresAt: "2000-01-01T00:00:00.000Z" }, { expiresAt: "invalid" }, { revokedAt: AT }, { acceptedAt: AT },
  ])("refuses unavailable invitation state %j", async (state) => {
    Object.assign(readInvites()[0], state);
    await expect(run("accept", "recipient", { inviteId: "invite-a" })).rejects.toMatchObject({ status: 410 });
    expect(findMember("recipient")).toBeUndefined();
  });

  it("does not let an accepted link restore a removed member", async () => {
    await run("accept", "recipient", { inviteId: "invite-a" });
    await run("remove-member", "owner", { memberId: "recipient" });
    await expect(run("accept", "recipient", { inviteId: "invite-a" })).rejects.toMatchObject({ status: 410 });
    expect(findMember("recipient")).toBeUndefined();
  });

  it("refuses local demo identity even when the supplied email matches", async () => {
    await expect(run("accept", "local", { actorEmail: "recipient@example.test", inviteId: "invite-a" })).rejects.toMatchObject({ status: 401 });
    expect(readInvites()[0].acceptedAt).toBeUndefined();
  });

  it("serializes revocation before a competing acceptance", async () => {
    const results = await Promise.allSettled([
      run("revoke", "owner", { inviteId: "invite-a" }),
      run("accept", "recipient", { inviteId: "invite-a" }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(results[1]).toMatchObject({ reason: { status: 410 } });
    expect(findMember("recipient")).toBeUndefined();
  });
});
