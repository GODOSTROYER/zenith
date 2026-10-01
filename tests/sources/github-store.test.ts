/** Real SQL tenant/replay/race contracts; HTTP is absent. Postgres is opt-in. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openPlatformDb } from "@/lib/controlplane/db";
import type { PlatformDb } from "@/lib/controlplane/types";
import { createGithubSourceStore, type InstallCaller } from "@/lib/sources/github/store";
import { binding } from "./fixtures";

function contracts(kind: "pglite" | "postgres") {
  let db: PlatformDb; let store: ReturnType<typeof createGithubSourceStore>;
  beforeAll(async () => {
    db = await openPlatformDb({ kind, url: kind === "postgres" ? process.env.ZENITH_TEST_PLATFORM_PG_URL : undefined, migrate: true });
    store = createGithubSourceStore(db);
  });
  beforeEach(async () => {
    for (const table of ["github_install_intents", "github_source_bindings"]) await db.query(`delete from platform.${table} where workspace_id in ($1, $2)`, ["ws-a", "ws-b"]);
  });
  afterAll(async () => { await db?.close(); });
  const begin = async (): Promise<InstallCaller> => ({ workspaceId: "ws-a", actorId: "human", ...await store.begin("ws-a", "human", binding) });
  const bind = (expectedVersion = 0) => store.bind({ ...binding, actorId: "human", expectedVersion });

  it("persists only identifiers and proof digests, and resolves bindings by workspace", async () => {
    expect(await store.getBinding("ws-a")).toBeUndefined();
    const input = await begin(); await store.authorize(input, 7); const intent = await store.consume(input);
    expect(intent).toEqual({ owner: "acme", repo: "app", installationId: 7, expectedVersion: 0 });
    expect(await bind()).toEqual(binding); expect(await store.getBinding("ws-a")).toEqual(binding); expect(await store.getBinding("ws-b")).toBeUndefined();
    const rows = await db.query("select * from platform.github_source_bindings where workspace_id = $1", ["ws-a"]);
    expect(JSON.stringify(rows).includes(input.browserProof) || JSON.stringify(rows).includes(input.state)).toBe(false);
  });
  it.each(["workspace", "actor", "browser", "state"])("refuses a changed callback %s without consuming the legitimate intent", async (part) => {
    const input = await begin();
    const bad = { ...input, ...(part === "workspace" ? { workspaceId: "ws-b" } : part === "actor" ? { actorId: "other" } : part === "browser" ? { browserProof: "b".repeat(43) } : { state: "s".repeat(43) }) };
    await expect(store.authorize(bad, 7)).rejects.toThrow("refused");
    await store.authorize(input, 7); await expect(store.consume(bad)).rejects.toThrow("refused");
    expect((await store.consume(input)).installationId).toBe(7);
  });
  it("refuses expired intents at both transitions using database time", async () => {
    for (const phase of ["install", "oauth"]) {
      const input = await begin(); if (phase === "oauth") await store.authorize(input, 7);
      await db.query("update platform.github_install_intents set expires_at = clock_timestamp() - interval '1 second' where workspace_id = $1", ["ws-a"]);
      if (phase === "install") await expect(store.authorize(input, 7)).rejects.toThrow("refused");
      else await expect(store.consume(input)).rejects.toThrow("refused");
    }
  });
  it("allows only one racing setup and one racing OAuth callback", async () => {
    const input = await begin();
    const setups = await Promise.allSettled([store.authorize(input, 7), store.authorize(input, 8)]);
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
    const input = await begin(); await bind(1); await store.authorize(input, 7); const intent = await store.consume(input);
    expect(intent.expectedVersion).toBe(1);
    await expect(bind(intent.expectedVersion)).rejects.toThrow("changed"); expect((await store.getBinding("ws-a"))?.version).toBe(2);
  });
  it("validates identifiers and numeric IDs without reflecting malicious data", async () => {
    await expect(store.begin("ws-a' OR TRUE", "human", binding)).rejects.toThrow("invalid");
    await expect(store.bind({ ...binding, repositoryId: 0, actorId: "human", expectedVersion: 0 })).rejects.toThrow("invalid");
    await expect(store.getBinding("ws-a/foreign")).rejects.toThrow("invalid");
  });
}
describe("GitHub source PGlite store", () => contracts("pglite"));
describe.skipIf(!process.env.ZENITH_TEST_PLATFORM_PG_URL)("GitHub source Postgres store (opt-in)", () => contracts("postgres"));
