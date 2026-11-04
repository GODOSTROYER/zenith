/** Real SQL tenant/replay/race contracts; HTTP is absent. Postgres is opt-in. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openPlatformDb } from "@/lib/controlplane/db";
import type { PlatformDb } from "@/lib/controlplane/types";
import { createGithubSourceStore, type InstallCaller } from "@/lib/sources/github/store";
import { binding } from "./fixtures";
import { captureGithubWebhookFence } from "@/lib/sources/github/webhook-store";

function contracts(kind: "pglite" | "postgres") {
  let db: PlatformDb; let store: ReturnType<typeof createGithubSourceStore>;
  beforeAll(async () => {
    db = await openPlatformDb({ kind, url: kind === "postgres" ? process.env.ZENITH_TEST_PLATFORM_PG_URL : undefined, migrate: true });
    store = createGithubSourceStore(db);
  });
  beforeEach(async () => {
    for (const table of ["github_binding_events", "github_install_intents", "github_source_bindings"]) await db.query(`delete from platform.${table} where workspace_id in ($1, $2)`, ["ws-a", "ws-b"]);
  });
  afterAll(async () => { await db?.close(); });
  const begin = async (): Promise<InstallCaller> => ({ workspaceId: "ws-a", actorId: "human", ...await store.begin("ws-a", "human", binding) });
  const bind = async (expectedVersion = 0) => {
    const fence = await captureGithubWebhookFence(db, binding.appId, binding.installationId);
    return store.bind({ ...binding, actorId: "human", expectedVersion, installationGeneration: fence.generation });
  };

  it("persists only identifiers and proof digests, and resolves bindings by workspace", async () => {
    expect(await store.getBinding("ws-a")).toBeUndefined();
    const input = await begin(); await store.authorize(input, 7, binding.appId); const intent = await store.consume(input);
    expect(intent).toEqual({ owner: "acme", repo: "app", installationId: 7, expectedVersion: 0, appId: binding.appId, installationGeneration: (await captureGithubWebhookFence(db, binding.appId, 7)).generation });
    expect(await bind()).toEqual(binding); expect(await store.getBinding("ws-a")).toEqual(binding); expect(await store.getBinding("ws-b")).toBeUndefined();
    const rows = await db.query("select * from platform.github_source_bindings where workspace_id = $1", ["ws-a"]);
    expect(JSON.stringify(rows).includes(input.browserProof) || JSON.stringify(rows).includes(input.state)).toBe(false);
  });
  it.each(["workspace", "actor", "browser", "state"])("refuses a changed callback %s without consuming the legitimate intent", async (part) => {
    const input = await begin();
    const bad = { ...input, ...(part === "workspace" ? { workspaceId: "ws-b" } : part === "actor" ? { actorId: "other" } : part === "browser" ? { browserProof: "b".repeat(43) } : { state: "s".repeat(43) }) };
    await expect(store.authorize(bad, 7, binding.appId)).rejects.toThrow("refused");
    await store.authorize(input, 7, binding.appId); await expect(store.consume(bad)).rejects.toThrow("refused");
    expect((await store.consume(input)).installationId).toBe(7);
  });
  it("refuses expired intents at both transitions using database time", async () => {
    for (const phase of ["install", "oauth"]) {
      const input = await begin(); if (phase === "oauth") await store.authorize(input, 7, binding.appId);
      await db.query("update platform.github_install_intents set expires_at = clock_timestamp() - interval '1 second' where workspace_id = $1", ["ws-a"]);
      if (phase === "install") await expect(store.authorize(input, 7, binding.appId)).rejects.toThrow("refused");
      else await expect(store.consume(input)).rejects.toThrow("refused");
    }
  });
  it("allows only one racing setup and one racing OAuth callback", async () => {
    const input = await begin();
    const setups = await Promise.allSettled([store.authorize(input, 7, binding.appId), store.authorize(input, 8, binding.appId)]);
    expect(setups.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const callbacks = await Promise.allSettled([store.consume(input), store.consume(input)]);
    expect(callbacks.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await expect(store.consume(input)).rejects.toThrow("refused");
  });
  it("stores hashed state/proof and never lets an install callback skip OAuth", async () => {
    const input = await begin(); await expect(store.consume(input)).rejects.toThrow("refused");
    const rows = await db.query("select * from platform.github_install_intents where workspace_id = $1", ["ws-a"]);
    const data = JSON.stringify(rows);
    expect(data.includes(input.state) || data.includes(input.browserProof)).toBe(false);
    expect(rows).toHaveLength(1);
  });
  it("rejects stale/racing bind intents rather than overwriting another admin's binding", async () => {
    const winners = await Promise.allSettled([bind(), bind()]); expect(winners.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const input = await begin(); await bind(1); await store.authorize(input, 7, binding.appId); const intent = await store.consume(input);
    expect(intent.expectedVersion).toBe(1);
    await expect(bind(intent.expectedVersion)).rejects.toThrow("changed"); expect((await store.getBinding("ws-a"))?.version).toBe(2);
  });
  it("revokes new access, preserves a monotonic version and requires a new install intent", async () => {
    await bind();
    const input = await begin(); await store.authorize(input, 7, binding.appId);
    await store.revoke({ workspaceId: "ws-a", actorId: "human", expectedVersion: 1 });
    expect(await store.getState("ws-a")).toMatchObject({ revoked: true, binding: { ...binding, version: 2 } });
    await expect(store.getBinding("ws-a")).rejects.toThrow("refused");
    await expect(store.consume(input)).rejects.toThrow("refused");
    await expect(bind(1)).rejects.toThrow("changed");
    await expect(bind(0)).rejects.toThrow("changed");
    const fresh = await begin(); await store.authorize(fresh, 7, binding.appId);
    const intent = await store.consume(fresh); expect(intent.expectedVersion).toBe(2);
    expect(await bind(intent.expectedVersion)).toEqual({ ...binding, version: 3 });
    expect(await store.getState("ws-a")).toMatchObject({ revoked: false });
    expect(await db.query("select version, action, actor_id from platform.github_binding_events where workspace_id = $1 order by version", ["ws-a"])).toEqual([
      { version: 1, action: "bound", actor_id: "human" }, { version: 2, action: "revoked", actor_id: "human" }, { version: 3, action: "bound", actor_id: "human" },
    ]);
  });
  it("blocks a consumed callback and serializes competing revocation and replacement", async () => {
    await bind();
    const input = await begin(); await store.authorize(input, 7, binding.appId);
    const consumed = await store.consume(input);
    await store.revoke({ workspaceId: "ws-a", actorId: "human", expectedVersion: 1 });
    await expect(bind(consumed.expectedVersion)).rejects.toThrow("changed");
    await bind(2);
    const attempts = await Promise.allSettled([bind(3), store.revoke({ workspaceId: "ws-a", actorId: "human", expectedVersion: 3 })]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await store.getState("ws-a"))?.binding.version).toBe(4);
  });
  it("scopes revocation by workspace and exact version; failed attempts retain legitimate intents", async () => {
    await bind(); const input = await begin();
    for (const bad of [{ workspaceId: "ws-b", expectedVersion: 1 }, { workspaceId: "ws-a", expectedVersion: 2 }]) {
      await expect(store.revoke({ ...bad, actorId: "human" })).rejects.toThrow("changed");
    }
    expect(await store.getBinding("ws-a")).toEqual(binding);
    await store.authorize(input, 7, binding.appId); expect(await store.consume(input)).toMatchObject({ expectedVersion: 1 });
  });
  it("validates identifiers and numeric IDs without reflecting malicious data", async () => {
    await expect(store.begin("ws-a' OR TRUE", "human", binding)).rejects.toThrow("invalid");
    await expect(store.bind({ ...binding, repositoryId: 0, actorId: "human", expectedVersion: 0, installationGeneration: "0" })).rejects.toThrow("invalid");
    await expect(store.getBinding("ws-a/foreign")).rejects.toThrow("invalid");
  });
}
describe("GitHub source PGlite store", () => contracts("pglite"));
describe.skipIf(!process.env.ZENITH_TEST_PLATFORM_PG_URL)("GitHub source Postgres store (opt-in)", () => contracts("postgres"));
