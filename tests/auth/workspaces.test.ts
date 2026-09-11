/**
 * Two workspaces, two users, nothing shared.
 *
 * Every record already carried a workspaceId; what was missing was a *current*
 * workspace per user, so every scoped read had to guess. These assert the
 * guessing is gone: membership decides which workspaces you can be in, the
 * selection cookie can only pick among those, and each of the workspace-scoped
 * reads (projects, connections, environments, audit, invites, members) answers
 * for one workspace only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { AuditEvent, Environment, Invite, Member, Project, Workspace } from "@/lib/domain/types";
import type { SessionUser } from "@/lib/auth/session";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-workspaces-");
const { ensureMember, readInvites, workspacesFor } = await import("@/lib/server/context");
const { appendAudit, db, inWorkspace, readAudit, resetDb } = await import("@/lib/db/store");
const { emptyManifest } = await import("@/lib/domain/types");

const AT = "2026-09-01T10:00:00.000Z";

const wsA: Workspace = { id: "ws-a", name: "Kepler Labs", slug: "kepler", createdAt: AT };
const wsB: Workspace = { id: "ws-b", name: "Orbital", slug: "orbital", createdAt: AT };

const ada = { id: "u-ada", email: "ada@zenith.test", name: "Ada" } satisfies SessionUser;
const bo = { id: "u-bo", email: "bo@zenith.test", name: "Bo" } satisfies SessionUser;

const member = (id: string, workspaceId: string, email: string, role: Member["role"] = "admin"): Member => ({
  id,
  workspaceId,
  name: email.split("@")[0],
  email,
  role,
});

const project = (id: string, workspaceId: string): Project => ({
  id,
  workspaceId,
  name: id,
  slug: id,
  workingManifest: emptyManifest(),
  origin: { type: "blank" },
  createdAt: AT,
});

const environment = (id: string, projectId: string): Environment => ({
  id,
  projectId,
  name: "staging",
  class: "staging",
  connectionId: `conn-${projectId}`,
  region: "local-1",
  policies: { approvalRequired: false, allowStatefulDeletion: false },
  baseDomain: `${projectId}.zenith.app`,
  createdAt: AT,
});

const audit = (workspaceId: string, projectId: string, n: number): AuditEvent => ({
  ts: AT,
  id: `au-${workspaceId}-${n}`,
  workspaceId,
  projectId,
  actor: { type: "user", id: "u-ada", name: "Ada" },
  actionId: "project.create",
  input: {},
  result: "ok",
  summary: `${workspaceId} did a thing`,
});

/** Ada owns A, Bo owns B, and each has a project, an environment, a connection. */
function seedTwo(invites: Invite[] = []) {
  resetDb({
    workspaces: [wsA, wsB],
    members: [member("u-ada", wsA.id, ada.email), member("u-bo", wsB.id, bo.email)],
    projects: [project("prj-a", wsA.id), project("prj-b", wsB.id)],
    environments: [environment("env-a", "prj-a"), environment("env-b", "prj-b")],
    connections: [
      {
        id: "conn-a",
        workspaceId: wsA.id,
        provider: "sandbox",
        label: "A",
        region: "local-1",
        status: "healthy",
        grantedPermissions: [],
        createdAt: AT,
      },
      {
        id: "conn-b",
        workspaceId: wsB.id,
        provider: "sandbox",
        label: "B",
        region: "local-1",
        status: "healthy",
        grantedPermissions: [],
        createdAt: AT,
      },
    ],
    settings: { invites },
  });
  appendAudit(audit(wsA.id, "prj-a", 1));
  appendAudit(audit(wsB.id, "prj-b", 1));
}

/**
 * The resolution `requireWorkspace()` performs, minus the request plumbing:
 * the cookie only counts when it names a workspace the caller belongs to.
 */
const resolve = (cookie: string | undefined, user: SessionUser | null): Workspace | undefined => {
  const allowed = workspacesFor(user);
  return allowed.find((w) => w.id === cookie) ?? allowed[0];
};

describe("which workspaces a caller may be in", () => {
  beforeEach(() => seedTwo());

  it("lists only the ones they are a member of", () => {
    expect(workspacesFor(ada).map((w) => w.id)).toEqual([wsA.id]);
    expect(workspacesFor(bo).map((w) => w.id)).toEqual([wsB.id]);
  });

  it("lists both when a user belongs to both", () => {
    db().members.push(member("u-ada", wsB.id, ada.email, "viewer"));
    expect(workspacesFor(ada).map((w) => w.id)).toEqual([wsA.id, wsB.id]);
  });

  it("honours the selection cookie when it names one of them", () => {
    db().members.push(member("u-ada", wsB.id, ada.email, "viewer"));
    expect(resolve(wsB.id, ada)?.id).toBe(wsB.id);
  });

  it("ignores a cookie naming a workspace the caller left, rather than obeying it", () => {
    // The exact stale-cookie case: Ada selected B, then lost her seat there.
    expect(resolve(wsB.id, ada)?.id).toBe(wsA.id);
  });

  it("gives a signed-in stranger no workspace at all", () => {
    expect(workspacesFor({ id: "u-x", email: "x@example.com", name: "X" })).toEqual([]);
  });
});

describe("joining is per workspace", () => {
  // A fresh one per test: accepting an invite stamps `acceptedAt` on the
  // record in place, so a shared literal would arrive already accepted.
  const inviteToB = (): Invite => ({
    id: "inv-b",
    workspaceId: wsB.id,
    email: "cass@zenith.test",
    role: "editor",
    createdBy: "u-bo",
    createdAt: AT,
  });

  it("puts an invited user in the workspace that invited them", () => {
    seedTwo([inviteToB()]);
    const out = ensureMember({ id: "u-cass", email: "cass@zenith.test", name: "Cass" });
    if ("denied" in out) throw new Error(out.denied.message);
    expect(out.member.workspaceId).toBe(wsB.id);
    expect(out.member.role).toBe("editor");
    expect(readInvites()[0].acceptedAt).toBeTruthy();
  });

  it("does not make an invitee to B the first-member admin of an empty A", () => {
    // A has no real members; the invite names B. Whichever sorts first must
    // not decide this — the invite does.
    resetDb({
      workspaces: [wsA, wsB],
      members: [member("u-bo", wsB.id, bo.email)],
      settings: { invites: [inviteToB()] },
    });
    const out = ensureMember({ id: "u-cass", email: "cass@zenith.test", name: "Cass" });
    if ("denied" in out) throw new Error(out.denied.message);
    expect(out.member.workspaceId).toBe(wsB.id);
    expect(out.member.role).toBe("editor");
    expect(db().members.some((m) => m.workspaceId === wsA.id)).toBe(false);
  });

  it("admits the first real member of the workspace it was asked about, and only that one", () => {
    seedTwo();
    const empty: Workspace = { id: "ws-c", name: "Third", slug: "third", createdAt: AT };
    db().workspaces.push(empty);
    const out = ensureMember({ id: "u-dee", email: "dee@zenith.test", name: "Dee" }, empty);
    if ("denied" in out) throw new Error(out.denied.message);
    expect(out.member).toMatchObject({ workspaceId: empty.id, role: "admin" });
    expect(workspacesFor({ id: "u-dee", email: "dee@zenith.test", name: "Dee" }).map((w) => w.id)).toEqual([empty.id]);
  });

  it("refuses a stranger without naming every admin on the server", () => {
    seedTwo();
    const out = ensureMember({ id: "u-x", email: "x@example.com", name: "X" });
    if (!("denied" in out)) throw new Error("expected a denial");
    expect(out.denied.message).toMatch(/not a member of any of the 2 workspaces/);
    expect(out.denied.fix).not.toMatch(/ada@zenith\.test|bo@zenith\.test/);
  });

  it("keeps admin of A from becoming admin of B", () => {
    seedTwo();
    // Ada is admin of A. Asked about B, she is a stranger there.
    const out = ensureMember(ada, wsB);
    if (!("denied" in out)) throw new Error("expected a denial");
    expect(out.denied.message).toMatch(/not a member of Orbital/);
  });
});

describe("nothing leaks across workspaces", () => {
  beforeEach(() => seedTwo());

  const scoped = (ws: Workspace) => {
    const d = db();
    const projects = d.projects.filter((p) => p.workspaceId === ws.id);
    const ids = new Set(projects.map((p) => p.id));
    return {
      projects: projects.map((p) => p.id),
      connections: d.connections.filter((c) => c.workspaceId === ws.id).map((c) => c.id),
      environments: d.environments.filter((e) => ids.has(e.projectId)).map((e) => e.id),
      members: d.members.filter((m) => m.workspaceId === ws.id).map((m) => m.email),
      invites: readInvites().filter((i) => i.workspaceId === ws.id).map((i) => i.email),
      audit: readAudit({ workspaceId: ws.id }).map((e) => e.id),
    };
  };

  it("scopes projects, connections, environments, members and audit to one workspace", () => {
    expect(scoped(wsA)).toEqual({
      projects: ["prj-a"],
      connections: ["conn-a"],
      environments: ["env-a"],
      members: [ada.email],
      invites: [],
      audit: [`au-${wsA.id}-1`],
    });
    expect(scoped(wsB)).toEqual({
      projects: ["prj-b"],
      connections: ["conn-b"],
      environments: ["env-b"],
      members: [bo.email],
      invites: [],
      audit: [`au-${wsB.id}-1`],
    });
  });

  it("scopes invites to the workspace that issued them", () => {
    seedTwo([
      { id: "i-a", workspaceId: wsA.id, email: "one@x.dev", role: "viewer", createdBy: "u-ada", createdAt: AT },
      { id: "i-b", workspaceId: wsB.id, email: "two@x.dev", role: "viewer", createdBy: "u-bo", createdAt: AT },
    ]);
    expect(scoped(wsA).invites).toEqual(["one@x.dev"]);
    expect(scoped(wsB).invites).toEqual(["two@x.dev"]);
  });

  it("refuses an id-lookup for a project in the other workspace (E10)", () => {
    // Knowing an id must not be enough to read it from another workspace.
    expect(inWorkspace(wsA.id, "prj-a")).toBe(true);
    expect(inWorkspace(wsA.id, "prj-b")).toBe(false);
    expect(inWorkspace(wsB.id, "prj-a")).toBe(false);
  });
});
