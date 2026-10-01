/** Default connector policy: SQL is mocked here; its separate contracts use PGlite. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sql } from "@/lib/controlplane/types";
import { createGithubAccess } from "@/lib/sources/github/runtime";
import { api, keys } from "./fixtures";

let material: Awaited<ReturnType<typeof keys>>;
beforeAll(async () => { material = await keys(); });
afterAll(async () => { await material.close(); });
const row = { workspace_id: "ws-a", owner: "acme", repo: "app", app_id: "42", installation_id: 7, repository_id: 99, version: 1 };
const database = (rows: unknown[] = [row]): Sql => ({ query: vi.fn(async () => rows) as Sql["query"], tx: async (fn) => fn(database(rows)) });
const env = () => ({ ZENITH_GITHUB_APP_ID: "42", ZENITH_GITHUB_APP_PRIVATE_KEY_FILE: material.config.privateKeyFile });

describe("default C3 GitHub connector", () => {
  it("keeps unconfigured and standalone public reads anonymous without opening SQL", async () => {
    const db = vi.fn(async () => database());
    expect(await createGithubAccess({ db, env: {} })({ owner: "acme", repo: "app", workspaceId: "ws-a" }, async (token) => token === undefined)).toBe(true);
    expect(await createGithubAccess({ db, env: env() })({ owner: "acme", repo: "app" }, async (token) => token === undefined)).toBe(true);
    expect(db).not.toHaveBeenCalled();
  });
  it("keeps a workspace without a binding anonymous, even when an App is configured", async () => {
    const db = database([]); const fetchImpl = api();
    expect(await createGithubAccess({ db: async () => db, env: env(), fetchImpl })({ owner: "acme", repo: "app", workspaceId: "ws-b" }, async (token) => token === undefined)).toBe(true);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("where workspace_id = $1"), ["ws-b"]); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("checks the exact tenant repository before any GitHub request or callback", async () => {
    const fetchImpl = api(); const callback = vi.fn(async () => "ok");
    await expect(createGithubAccess({ db: async () => database(), env: env(), fetchImpl })({ workspaceId: "ws-a", owner: "foreign", repo: "private" }, callback)).rejects.toThrow("could not be confirmed");
    expect(fetchImpl).not.toHaveBeenCalled(); expect(callback).not.toHaveBeenCalled();
  });
  it("normalizes repository case and supplies a token once within the callback", async () => {
    let tokenSeen = false; const fetchImpl = api();
    expect(await createGithubAccess({ db: async () => database(), env: env(), fetchImpl })({ workspaceId: "ws-a", owner: "ACME", repo: "APP" }, async (token) => { tokenSeen = !!token; return "digest-only"; })).toBe("digest-only");
    expect(tokenSeen).toBe(true); expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("does not downgrade a SQL failure to anonymous access or leak diagnostics", async () => {
    const callback = vi.fn(async () => "ok");
    await expect(createGithubAccess({ db: async () => { throw new Error("synthetic-secret-canary"); }, env: env() })({ workspaceId: "ws-a", owner: "acme", repo: "app" }, callback)).rejects.toThrow("could not be confirmed");
    expect(callback).not.toHaveBeenCalled();
  });
});
