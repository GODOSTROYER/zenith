import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openPlatformDb, migratePlatformDb, PLATFORM_MIGRATIONS, type PlatformDbHandle } from "@/lib/controlplane/db";
import { createGithubSourceStore } from "@/lib/sources/github/store";
import { captureGithubWebhookFence } from "@/lib/sources/github/webhook-store";
import { renderSupabaseMigration } from "@/lib/controlplane/db/migrations/emit";

describe("independent repository grants", () => {
  let db: PlatformDbHandle;
  beforeAll(async () => { db = await openPlatformDb({ kind: "pglite", migrate: true }); }, 60_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    for (const table of ["github_project_sources", "github_discovery_sessions", "github_binding_events", "github_install_intents", "github_source_bindings"])
      await db.query(`delete from platform.${table} where workspace_id='multi'`);
  });
  async function connect(repo: string, repositoryId: number, expectedVersion = 0) {
    const fence = await captureGithubWebhookFence(db, "42", 7);
    return createGithubSourceStore(db).bind({ workspaceId: "multi", appId: "42", installationId: 7, owner: "acme", repo, repositoryId, actorId: "admin", expectedVersion, installationGeneration: fence.generation });
  }

  it("allows independent version-one grants and refuses an ambiguous legacy lookup", async () => {
    const store = createGithubSourceStore(db);
    await connect("alpha", 101); await connect("beta", 102);
    expect((await store.listStates("multi")).map(row => row.binding.repo)).toEqual(["alpha", "beta"]);
    await expect(store.getBinding("multi")).rejects.toMatchObject({ code: "conflict" });
    expect((await store.getBinding("multi", { repositoryId: 102 }))?.repo).toBe("beta");
    const events = await db.query("select repository_id,version from platform.github_binding_events where workspace_id='multi' order by repository_id");
    expect(events.map(row => ({ id: Number(row.repository_id), version: row.version }))).toEqual([{ id: 101, version: 1 }, { id: 102, version: 1 }]);
  });

  it("revoking alpha leaves beta and its in-progress callback authorized", async () => {
    const store = createGithubSourceStore(db);
    const alpha = await connect("alpha", 101), beta = await connect("beta", 102);
    const alphaState = await store.getState("multi", { repositoryId: 101 });
    const betaIntent = { workspaceId: "multi", actorId: "admin", ...await store.begin("multi", "admin", beta) };
    await store.authorize(betaIntent, 7, "42");
    await store.revoke({ workspaceId: "multi", actorId: "admin", bindingId: alphaState!.bindingId, expectedVersion: 1 });
    await expect(store.assertCurrent(alpha)).rejects.toMatchObject({ code: "refused" });
    await store.assertCurrent(beta);
    expect((await store.consume(betaIntent)).expectedVersion).toBe(1);
    await expect(store.getBinding("multi", { owner: "acme", repo: "alpha" })).rejects.toMatchObject({ code: "refused" });
    await expect(store.revoke({ workspaceId: "other", actorId: "admin", bindingId: alphaState!.bindingId, expectedVersion: 2 })).rejects.toMatchObject({ code: "conflict" });
  });

  it("reconnection preserves the binding ID and invalidates the previous version", async () => {
    const store = createGithubSourceStore(db);
    const original = await connect("alpha", 101);
    const before = await store.getState("multi", { repositoryId: 101 });
    await store.revoke({ workspaceId: "multi", actorId: "admin", bindingId: before!.bindingId, expectedVersion: 1 });
    const next = await connect("alpha", 101, 2);
    expect(next.version).toBe(3);
    expect((await store.getState("multi", { repositoryId: 101 }))?.bindingId).toBe(before!.bindingId);
    await expect(store.assertCurrent(original)).rejects.toMatchObject({ code: "refused" });
  });

  it("discovered rename keeps the original grant ID and project association with a fresh CAS", async () => {
    const store = createGithubSourceStore(db);
    const original = await connect("alpha", 101);
    const before = await store.getState("multi", { repositoryId: 101 });
    await db.query("insert into platform.github_project_sources(workspace_id,project_id,binding_id,ref,updated_by) values('multi','school-project',$1,'main','admin')", [before!.bindingId]);
    const input = { workspaceId: "multi", actorId: "admin", ...await store.begin("multi", "admin", { owner: "acme", repo: "renamed", repositoryId: 101 }) };
    await store.authorize(input, 7, "42");
    const intent = await store.consume(input);
    expect(intent).toMatchObject({ repo: "renamed", expectedVersion: 1, expectedRepositoryId: 101 });
    await store.bind({ ...intent, workspaceId: "multi", actorId: "admin", repositoryId: 101 });
    const after = await store.getState("multi", { owner: "acme", repo: "renamed" });
    expect(after?.bindingId).toBe(before?.bindingId);
    expect(after?.binding.version).toBe(2);
    expect(await store.getState("multi", { owner: "acme", repo: "alpha" })).toBeUndefined();
    expect(await db.query("select binding_id from platform.github_project_sources where workspace_id='multi' and project_id='school-project'"))
      .toEqual([{ binding_id: before!.bindingId }]);
    await expect(store.assertCurrent(original)).rejects.toMatchObject({ code: "refused" });
  });

  it("discovery metadata is actor/tenant scoped, expiring and invalidated by installation generation", async () => {
    const store = createGithubSourceStore(db);
    const fence = await captureGithubWebhookFence(db, "42", 7);
    const session = await store.saveDiscovery({ workspaceId: "multi", actorId: "admin", appId: "42", installationId: 7, installationGeneration: fence.generation,
      repositories: [{ owner: "acme", repo: "alpha", repositoryId: 101, private: true, defaultBranch: "main" }], truncated: false });
    expect((await store.getDiscovery("multi", "admin", session)).repositories[0].repositoryId).toBe(101);
    for (const [workspace, actor] of [["other", "admin"], ["multi", "intruder"]]) await expect(store.getDiscovery(workspace, actor, session)).rejects.toMatchObject({ code: "refused" });
    const persisted = JSON.stringify(await db.query("select * from platform.github_discovery_sessions where workspace_id='multi'"));
    expect(persisted).not.toContain(session);
    await db.query("update platform.github_webhook_installation_epochs set generation=generation+1 where app_id='42' and installation_id=7");
    await expect(store.getDiscovery("multi", "admin", session)).rejects.toMatchObject({ code: "conflict" });
    await db.query("update platform.github_discovery_sessions set expires_at=clock_timestamp()-interval '1 second' where workspace_id='multi'");
    await expect(store.getDiscovery("multi", "admin", session)).rejects.toMatchObject({ code: "refused" });
  });
});

it("migrates singleton event history without assigning replaced code to the current repository", async () => {
  const db = await openPlatformDb({ kind: "pglite", migrate: false });
  try {
    await migratePlatformDb(db, PLATFORM_MIGRATIONS.filter(m => m.version < 60));
    await db.query("insert into platform.github_source_bindings(workspace_id,app_id,installation_id,repository_id,owner,repo,version,bound_by) values('history','42',7,102,'acme','beta',2,'admin')");
    await db.query("insert into platform.github_binding_events(workspace_id,version,action,actor_id,app_id,installation_id,repository_id,owner,repo) values('history',1,'bound','admin','42',7,101,'acme','alpha'),('history',2,'bound','admin','42',7,102,'acme','beta')");
    await migratePlatformDb(db);
    const events = await db.query<{ repository_id: number; binding_id: string | null }>("select repository_id,binding_id from platform.github_binding_events where workspace_id='history' order by version");
    expect(Number(events[0].repository_id)).toBe(101); expect(events[0].binding_id).toBeNull();
    expect(Number(events[1].repository_id)).toBe(102);
    expect(events[1].binding_id).toBe((await createGithubSourceStore(db).getState("history", { repositoryId: 102 }))?.bindingId);
    // A later reconnect of the historically replaced repository starts its own
    // grant version. Replaying a generated migration must not relabel old events.
    const fence = await captureGithubWebhookFence(db, "42", 7);
    await createGithubSourceStore(db).bind({ workspaceId: "history", appId: "42", installationId: 7, repositoryId: 101, owner: "acme", repo: "alpha", actorId: "admin", expectedVersion: 0, installationGeneration: fence.generation });
    const audit = await db.query("select event_id,repository_id,binding_id,version from platform.github_binding_events where workspace_id='history' order by event_id");
    await db.exec(renderSupabaseMigration());
    await db.exec(renderSupabaseMigration());
    expect(await db.query("select event_id,repository_id,binding_id,version from platform.github_binding_events where workspace_id='history' order by event_id")).toEqual(audit);
  } finally { await db.close(); }
}, 60_000);
