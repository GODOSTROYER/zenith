/**
 * PROD-LIFE-08: signed installation lifecycle events and explicit unbind revoke the workspace
 * binding with a recorded reason, and a revoked binding blocks source acquisition (no token
 * minted, no anonymous fallback). Real PGlite platform SQL; the webhook is signed with a
 * runtime-generated secret in a private POSIX file (skipped where POSIX custody is unavailable).
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import { createGithubAccess } from "@/lib/sources/github/runtime";
import { createGithubSourceStore } from "@/lib/sources/github/store";
import { createGithubWebhookHandler } from "@/lib/sources/github/webhook";
import { captureGithubWebhookFence } from "@/lib/sources/github/webhook-store";
import { api, keys } from "./fixtures";

const posix = typeof process.getuid === "function";
const WS = "ws-life08";
const APP = "42";
let db: PlatformDbHandle; let directory: string; let secretFile: string; let secret: Buffer;
let material: Awaited<ReturnType<typeof keys>>;
const handler = () => createGithubWebhookHandler({ db: async () => db, env: { ZENITH_GITHUB_APP_ID: APP, ZENITH_GITHUB_APP_WEBHOOK_SECRET_FILE: secretFile } });

function payload(event: string, action: string) {
  return { action, installation: { id: 7, app_id: Number(APP), suspended_at: action === "suspend" ? "2026-10-03T00:00:00Z" : null, suspended_by: action === "suspend" ? { id: 55 } : null },
    sender: { id: 55 }, ...(event === "installation_repositories" ? { repository_selection: "selected", repositories_added: action === "added" ? [{ id: 1 }] : [], repositories_removed: action === "removed" ? [{ id: 99 }] : [] } : {}) };
}
async function send(event: string, action: string): Promise<number> {
  const bytes = Buffer.from(JSON.stringify(payload(event, action)));
  const response = await handler()(new Request("https://zenith.test/api/platform/v1/github/webhook", { method: "POST", body: new Uint8Array(bytes).buffer, headers: {
    "content-type": "application/json", "x-github-event": event, "x-github-delivery": randomUUID(), "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(bytes).digest("hex")}` } }));
  return response.status;
}
async function seed(): Promise<void> {
  for (const table of ["github_binding_events", "github_install_intents", "github_source_bindings"]) await db.query(`delete from platform.${table} where workspace_id = $1`, [WS]);
  await db.query(`insert into platform.github_source_bindings (workspace_id, app_id, installation_id, repository_id, owner, repo, version, bound_by)
    values ($1, $2, 7, 99, 'acme', 'app', 1, 'human')`, [WS, APP]);
}

describe.skipIf(!posix)("GitHub source binding lifecycle", () => {
  beforeAll(async () => {
    material = await keys();
    directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "zenith-life08-")));
    await chmod(directory, 0o700); secretFile = path.join(directory, "secret");
    secret = Buffer.from(randomBytes(32).toString("hex")); await writeFile(secretFile, secret, { mode: 0o600 });
    db = await openPlatformDb({ kind: "pglite", migrate: true });
  }, 60_000);
  afterAll(async () => { await db?.close(); await material?.close(); secret?.fill(0); if (directory) await rm(directory, { recursive: true, force: true }); });
  beforeEach(seed);

  it.each([
    ["installation", "deleted", "installation_deleted"],
    ["installation", "suspend", "installation_suspended"],
    ["installation_repositories", "removed", "repositories_removed"],
  ])("signed %s/%s revokes the binding with reason %s and audits it", async (event, action, reason) => {
    expect(await send(event, action)).toBe(204);
    const state = await createGithubSourceStore(db).getState(WS);
    expect(state).toMatchObject({ revoked: true, revokedReason: reason, binding: { version: 2 } });
    expect(await db.query("select action, actor_id, reason from platform.github_binding_events where workspace_id = $1", [WS]))
      .toEqual([{ action: "revoked", actor_id: "github_webhook", reason }]);
  });

  it("a revoked binding blocks source access: no token is minted and nothing falls back to anonymous", async () => {
    expect(await send("installation", "deleted")).toBe(204);
    const fetchImpl = api(); const use = vi.fn(async () => "ok");
    const access = createGithubAccess({ db: async () => db, fetchImpl, env: { ZENITH_GITHUB_APP_ID: APP, ZENITH_GITHUB_APP_PRIVATE_KEY_FILE: material.config.privateKeyFile } });
    await expect(access({ owner: "acme", repo: "app", workspaceId: WS }, use)).rejects.toThrow("could not be confirmed");
    expect(use).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("unsuspend, install creation and repository addition never restore a revoked binding", async () => {
    expect(await send("installation", "suspend")).toBe(204);
    for (const [event, action] of [["installation", "unsuspend"], ["installation", "created"], ["installation_repositories", "added"]]) expect(await send(event, action)).toBe(204);
    expect(await createGithubSourceStore(db).getState(WS)).toMatchObject({ revoked: true, revokedReason: "installation_suspended" });
  });

  it("explicit unbind is a version CAS, records user_unbind, and a later bind clears the reason", async () => {
    const store = createGithubSourceStore(db);
    await expect(store.revoke({ workspaceId: WS, actorId: "human", expectedVersion: 5 })).rejects.toThrow("changed");
    await store.revoke({ workspaceId: WS, actorId: "human", expectedVersion: 1 });
    expect(await store.getState(WS)).toMatchObject({ revoked: true, revokedReason: "user_unbind", binding: { version: 2 } });
    await expect(store.getBinding(WS)).rejects.toThrow("refused");
    await expect(store.revoke({ workspaceId: WS, actorId: "human", expectedVersion: 2 })).rejects.toThrow("changed");
    const fence = await captureGithubWebhookFence(db, APP, 7);
    await store.bind({ workspaceId: WS, appId: APP, installationId: 7, repositoryId: 99, owner: "acme", repo: "app", actorId: "human", expectedVersion: 2, installationGeneration: fence.generation });
    const state = await store.getState(WS);
    expect(state).toMatchObject({ revoked: false, binding: { version: 3 } }); expect(state?.revokedReason).toBeUndefined();
    expect(await db.query("select action, reason from platform.github_binding_events where workspace_id = $1 order by version", [WS]))
      .toEqual([{ action: "revoked", reason: "user_unbind" }, { action: "bound", reason: null }]);
  });
});
