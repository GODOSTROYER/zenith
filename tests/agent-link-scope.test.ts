/**
 * The whole-workspace grant on the read surfaces (PLAN3 §2a, P2 acceptance 6
 * and 7): a credential linked with "Whole workspace" reaches a project created
 * *after* the link, through `selectScope` and the reader, and still never
 * reaches another workspace's project. An explicit-list credential keeps its
 * fixed list.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { tempDataDir } from "./_support/data-dir";

tempDataDir("zenith-agent-link-scope-", { fast: true });

const { db, resetDb, save } = await import("@/lib/db/store");
const { emptyManifest } = await import("@/lib/domain/types");
const { callReader } = await import("@/lib/agent-access/zenith-reader");
const { selectScope } = await import("@/lib/agent-access/security");
import type { Credential, SelectedScope } from "@/lib/agent-access/security";

const at = new Date().toISOString();
const project = (id: string, workspaceId: string) => ({
  id,
  workspaceId,
  name: id,
  slug: id,
  workingManifest: emptyManifest(),
  createdAt: at,
  origin: { type: "blank" as const },
});

const grant = (overrides: Partial<Credential> = {}): Credential => ({
  id: "cred_scope",
  tokenHash: "a".repeat(64),
  subject: "member_scope",
  workspaceId: "ws_a",
  projectIds: [],
  allProjects: true,
  scopes: ["read"],
  issuedAt: new Date(Date.now() - 1000).toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  ...overrides,
});

const explicit = (): Credential => {
  const record = grant({ projectIds: ["prj_1"] });
  delete record.allProjects;
  return record;
};

const headers = (projectId?: string) =>
  new Headers({ "x-zenith-workspace": "ws_a", ...(projectId ? { "x-zenith-project": projectId } : {}) });

const workspaceOnly: SelectedScope = { workspaceId: "ws_a" };

beforeEach(() => {
  resetDb();
  const data = db();
  data.workspaces.push(
    { id: "ws_a", name: "A", slug: "a", createdAt: at },
    { id: "ws_b", name: "B", slug: "b", createdAt: at }
  );
  data.members.push(
    { id: "member_scope", workspaceId: "ws_a", name: "Scope", email: "s@example.com", role: "editor" },
    { id: "member_scope", workspaceId: "ws_b", name: "Scope", email: "s@example.com", role: "editor" }
  );
  data.projects.push(project("prj_1", "ws_a"), project("prj_x", "ws_b"));
  save();
});

/** A project a person (or an approved operation) creates after the link. */
function createLater(): void {
  db().projects.push(project("prj_2", "ws_a"));
  save();
}

describe("selectScope", () => {
  it("accepts a project created after a whole-workspace link", () => {
    createLater();
    expect(selectScope(headers("prj_2"), grant())).toEqual({ workspaceId: "ws_a", projectId: "prj_2" });
  });

  it("holds an explicit-list credential to its list", () => {
    createLater();
    expect(selectScope(headers("prj_1"), explicit())).toEqual({ workspaceId: "ws_a", projectId: "prj_1" });
    expect(() => selectScope(headers("prj_2"), explicit())).toThrow(/Select identifiers permitted/);
  });

  it("never lets a whole-workspace credential select another workspace", () => {
    expect(() =>
      selectScope(new Headers({ "x-zenith-workspace": "ws_b", "x-zenith-project": "prj_x" }), grant())
    ).toThrow(/Select identifiers permitted/);
  });
});

describe("the reader under a whole-workspace grant", () => {
  const listed = async (who: Credential) =>
    ((await callReader("zenith_list_projects", {}, who, workspaceOnly)) as { items: { id: string }[] }).items.map(
      (p) => p.id
    );

  it("lists the workspace's projects, including one created after the link, and nothing else", async () => {
    expect(await listed(grant())).toEqual(["prj_1"]);
    createLater();
    expect(await listed(grant())).toEqual(["prj_1", "prj_2"]);
    expect(await listed(explicit())).toEqual(["prj_1"]);
  });

  it("reads a new project, and refuses another workspace's project even though the flag is set", async () => {
    createLater();
    await expect(callReader("zenith_get_project", { projectId: "prj_2" }, grant(), workspaceOnly)).resolves.toMatchObject({
      id: "prj_2",
      workspaceId: "ws_a",
    });
    await expect(
      callReader("zenith_get_project", { projectId: "prj_x" }, grant(), workspaceOnly)
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      callReader("zenith_get_project", { projectId: "prj_2" }, explicit(), workspaceOnly)
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
