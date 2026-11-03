/** Project source CAS runs against real SQL; PostgreSQL adds independent connections when configured. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { changeProjectRepository, getProjectRepository } from "@/lib/sources/github/project-source";
import { LANES, newWorkspace, openLane, uid } from "../controlplane/_support/harness";

describe.each(LANES)("project repository attachments on $name", lane => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => { ctx = await openLane(lane); }, 60_000);
  afterAll(async () => { await ctx?.close(); });

  async function binding(workspaceId: string, repositoryId = 101, repo = "school") {
    const bindingId = uid("github");
    await ctx.db.query(
      "insert into platform.github_source_bindings(workspace_id,binding_id,app_id,installation_id,repository_id,owner,repo,version,bound_by) values($1,$2,'42',7,$3,'acme',$4,1,'admin')",
      [workspaceId, bindingId, repositoryId, repo],
    );
    return bindingId;
  }

  it("retains a detach tombstone and requires its version to reattach without revoking workspace grants", async () => {
    const workspaceId = newWorkspace(), projectId = uid("project");
    const original = await binding(workspaceId), replacement = await binding(workspaceId, 102, "students");
    const authorize = vi.fn(async () => {});
    expect(await getProjectRepository(ctx.db, workspaceId, projectId)).toEqual({ source: null, version: 0 });

    const attached = await changeProjectRepository(ctx.db, workspaceId, "admin", {
      projectId, bindingId: original, expectedVersion: 0, ref: "main", root: "apps/school", contextDir: "",
    }, authorize);
    expect(attached).toEqual({ version: 1, source: {
      projectId, bindingId: original, repositoryId: 101, repository: "acme/school", ref: "main",
      root: "apps/school", contextDir: "", version: 1, revoked: false,
    } });
    expect(await getProjectRepository(ctx.db2, workspaceId, projectId)).toEqual(attached);

    const detached = await changeProjectRepository(ctx.db, workspaceId, "admin", { projectId, expectedVersion: 1, detach: true }, authorize);
    expect(detached).toEqual({ source: null, version: 2 });
    expect(await getProjectRepository(ctx.db2, workspaceId, projectId)).toEqual(detached);
    for (const staleVersion of [0, 1]) {
      await expect(changeProjectRepository(ctx.db2, workspaceId, "admin", {
        projectId, bindingId: replacement, expectedVersion: staleVersion, ref: "release",
      }, authorize)).rejects.toMatchObject({ code: "conflict" });
    }
    expect(await getProjectRepository(ctx.db, workspaceId, projectId)).toEqual(detached);

    const reattached = await changeProjectRepository(ctx.db2, workspaceId, "second-admin", {
      projectId, bindingId: replacement, expectedVersion: 2, ref: "release", root: "apps/student", contextDir: "packages",
    }, authorize);
    expect(reattached).toMatchObject({ version: 3, source: {
      bindingId: replacement, repositoryId: 102, repository: "acme/students", ref: "release",
      root: "apps/student", contextDir: "packages", version: 3, revoked: false,
    } });
    const grants = await ctx.db.query("select binding_id,version,revoked_at from platform.github_source_bindings where workspace_id=$1 order by repository_id", [workspaceId]);
    expect(grants).toEqual([
      { binding_id: original, version: 1, revoked_at: null },
      { binding_id: replacement, version: 1, revoked_at: null },
    ]);
    expect(authorize).toHaveBeenCalledTimes(5);
    expect(await ctx.db.query("select type,project_id,actor,data from platform.events where workspace_id=$1 order by seq", [workspaceId])).toEqual([
      { type: "project.repository_attached", project_id: projectId, actor: { kind: "user", id: "admin", name: "admin" }, data: { version: 1, bindingId: original } },
      { type: "project.repository_detached", project_id: projectId, actor: { kind: "user", id: "admin", name: "admin" }, data: { version: 2 } },
      { type: "project.repository_attached", project_id: projectId, actor: { kind: "user", id: "second-admin", name: "second-admin" }, data: { version: 3, bindingId: replacement } },
    ]);
  });

  it("allows exactly one competing initial attachment and one competing update at the same version", async () => {
    const workspaceId = newWorkspace(), projectId = uid("project");
    const a = await binding(workspaceId), b = await binding(workspaceId, 102, "teachers");
    const inputs = [
      { projectId, bindingId: a, expectedVersion: 0, ref: "main" },
      { projectId, bindingId: b, expectedVersion: 0, ref: "staging" },
    ];
    const results = await Promise.allSettled([
      changeProjectRepository(ctx.db, workspaceId, "admin", inputs[0], async () => {}),
      changeProjectRepository(ctx.db2, workspaceId, "admin", inputs[1], async () => {}),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "conflict" } });
    expect((await getProjectRepository(ctx.db, workspaceId, projectId)).version).toBe(1);

    const updates = await Promise.allSettled([
      changeProjectRepository(ctx.db, workspaceId, "admin", { ...inputs[0], expectedVersion: 1, ref: "feature/student" }, async () => {}),
      changeProjectRepository(ctx.db2, workspaceId, "admin", { ...inputs[1], expectedVersion: 1, ref: "feature/teacher" }, async () => {}),
    ]);
    expect(updates.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(updates.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "conflict" } });
    expect((await getProjectRepository(ctx.db, workspaceId, projectId)).version).toBe(2);
  });

  it("refuses a foreign or revoked binding and never exposes another workspace's project source", async () => {
    const workspaceId = newWorkspace(), otherWorkspace = newWorkspace(), projectId = uid("project");
    const foreign = await binding(otherWorkspace), revoked = await binding(workspaceId);
    await ctx.db.query("update platform.github_source_bindings set revoked_at=clock_timestamp(),version=version+1 where workspace_id=$1 and binding_id=$2", [workspaceId, revoked]);
    await changeProjectRepository(ctx.db, otherWorkspace, "admin", { projectId, bindingId: foreign, expectedVersion: 0, ref: "main" }, async () => {});
    const authorize = vi.fn(async () => {});
    for (const bindingId of [foreign, revoked]) {
      await expect(changeProjectRepository(ctx.db, workspaceId, "admin", { projectId, bindingId, expectedVersion: 0, ref: "main" }, authorize))
        .rejects.toMatchObject({ code: "refused" });
    }
    expect(authorize).not.toHaveBeenCalled();
    expect(await getProjectRepository(ctx.db, workspaceId, projectId)).toEqual({ source: null, version: 0 });
    expect((await getProjectRepository(ctx.db, otherWorkspace, projectId)).source?.bindingId).toBe(foreign);
  });

  it("keeps a revoked source visible as revoked and permits a project detach while rejecting its reuse", async () => {
    const workspaceId = newWorkspace(), projectId = uid("project"), bindingId = await binding(workspaceId);
    await changeProjectRepository(ctx.db, workspaceId, "admin", { projectId, bindingId, expectedVersion: 0, ref: "main" }, async () => {});
    await ctx.db.query("update platform.github_source_bindings set revoked_at=clock_timestamp(),version=version+1 where workspace_id=$1 and binding_id=$2", [workspaceId, bindingId]);
    expect(await getProjectRepository(ctx.db, workspaceId, projectId)).toMatchObject({ version: 1, source: { bindingId, revoked: true } });
    await expect(changeProjectRepository(ctx.db, workspaceId, "admin", { projectId, bindingId, expectedVersion: 1, ref: "next" }, async () => {}))
      .rejects.toMatchObject({ code: "refused" });
    expect(await changeProjectRepository(ctx.db, workspaceId, "admin", { projectId, expectedVersion: 1, detach: true }, async () => {}))
      .toEqual({ source: null, version: 2 });
  });

  it("rolls back attach and detach when the caller's authority recheck fails", async () => {
    const workspaceId = newWorkspace(), projectId = uid("project"), bindingId = await binding(workspaceId);
    const denied = vi.fn(async () => { throw new Error("Current workspace authorization was revoked."); });
    await expect(changeProjectRepository(ctx.db, workspaceId, "admin", { projectId, bindingId, expectedVersion: 0, ref: "main" }, denied)).rejects.toThrow("authorization was revoked");
    expect(await getProjectRepository(ctx.db, workspaceId, projectId)).toEqual({ source: null, version: 0 });
    expect(await ctx.db.query("select id from platform.events where workspace_id=$1", [workspaceId])).toHaveLength(0);
    const attached = await changeProjectRepository(ctx.db, workspaceId, "admin", { projectId, bindingId, expectedVersion: 0, ref: "main" }, async () => {});
    await expect(changeProjectRepository(ctx.db, workspaceId, "admin", { projectId, expectedVersion: 1, detach: true }, denied)).rejects.toThrow("authorization was revoked");
    expect(await getProjectRepository(ctx.db, workspaceId, projectId)).toEqual(attached);
    expect(denied).toHaveBeenCalledTimes(2);
    expect(await ctx.db.query("select type,data from platform.events where workspace_id=$1", [workspaceId]))
      .toEqual([{ type: "project.repository_attached", data: { bindingId, version: 1 } }]);
  });

  it("refuses missing detach state and invalid app or context roots without consuming a version", async () => {
    const workspaceId = newWorkspace(), projectId = uid("project"), bindingId = await binding(workspaceId);
    await expect(changeProjectRepository(ctx.db, workspaceId, "admin", { projectId, expectedVersion: 0, detach: true }, async () => {}))
      .rejects.toMatchObject({ code: "conflict" });
    for (const invalid of [{ root: "../teacher" }, { contextDir: "/etc" }]) {
      await expect(changeProjectRepository(ctx.db, workspaceId, "admin", { projectId, bindingId, expectedVersion: 0, ref: "main", ...invalid }, async () => {}))
        .rejects.toMatchObject({ code: "invalid" });
    }
    expect(await getProjectRepository(ctx.db, workspaceId, projectId)).toEqual({ source: null, version: 0 });
  });
});
