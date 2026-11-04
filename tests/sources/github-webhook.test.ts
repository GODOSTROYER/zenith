/** Signed raw HTTP and canonical migrations on real platform SQL backends. */
import { createHash, createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import { chmod, link, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openPlatformDb, PLATFORM_MIGRATIONS, assertPlatformSchemaCurrent, type PlatformDbHandle } from "@/lib/controlplane/db";
import type { Sql } from "@/lib/controlplane/types";
import { authenticateGithubWebhook, createGithubWebhookHandler, GITHUB_WEBHOOK_MAX_BYTES, isVerifiedGithubRevocation, type VerifiedGithubRevocation } from "@/lib/sources/github/webhook";
import { assertGithubWebhookFence, captureGithubWebhookFence, createGithubWebhookStore } from "@/lib/sources/github/webhook-store";
import { createGithubSourceStore } from "@/lib/sources/github/store";

const routeState = vi.hoisted(() => ({ db: undefined as Sql | undefined, opens: 0 }));
vi.mock("@/lib/controlplane/db/open", async original => ({ ...await original<typeof import("@/lib/controlplane/db/open")>(),
  platformDb: async () => { routeState.opens++; if (!routeState.db) throw new Error("test SQL not assigned"); return routeState.db; },
}));
const { POST } = await import("@/app/api/platform/v1/github/webhook/route");

const URL = "https://zenith.test/api/platform/v1/github/webhook";
let directory: string; let file: string; let secret: Buffer;
beforeAll(async () => {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "zenith-github-webhook-")));
  await chmod(directory, 0o700); file = path.join(directory, "secret");
  secret = Buffer.from(randomBytes(32).toString("hex"));
  await writeFile(file, secret, { mode: 0o600 });
});
afterAll(async () => { secret?.fill(0); await rm(directory, { recursive: true, force: true }); });
afterEach(() => { vi.unstubAllEnvs(); });
const env = (appId = "42", secretFile = file) => ({ ZENITH_GITHUB_APP_ID: appId, ZENITH_GITHUB_APP_WEBHOOK_SECRET_FILE: secretFile });
function data(action = "deleted", appId = "42", installationId: unknown = 7, removed: unknown[] = [{ id: 99 }]) {
  return { action, installation: { id: installationId, app_id: Number(appId), suspended_at: action === "suspend" ? "2026-10-03T00:00:00Z" : null,
    suspended_by: action === "suspend" ? { id: 55 } : null }, sender: { id: 55 },
    ...(action === "removed" ? { repository_selection: "selected", repositories_added: [], repositories_removed: removed } : {}),
    // These strings are deliberately never used as SQL selectors or URLs.
    ignored: "unicode repository metadata Ω", html_url: "https://untrusted.invalid/ignored" };
}
function request(raw: string | Buffer, options: { event?: string; delivery?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}) {
  const bytes = typeof raw === "string" ? Buffer.from(raw) : raw;
  return new Request(URL, { method: "POST", signal: options.signal, body: new Uint8Array(bytes).buffer, headers: {
    "content-type": "application/json", "x-github-event": options.event ?? "installation", "x-github-delivery": options.delivery ?? randomUUID(),
    "x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update(bytes).digest("hex"), ...options.headers,
  } });
}

describe("GitHub webhook authentication and custody", () => {
  it("a type cast, copied Symbol or cloned authenticated object cannot bypass runtime authentication", async () => {
    const accepted = await authenticateGithubWebhook(request(JSON.stringify(data())), env());
    expect(isVerifiedGithubRevocation(accepted)).toBe(true);
    const db = { kind: "pglite" as const, query: vi.fn(), tx: vi.fn() };
    const store = createGithubWebhookStore(db);
    for (const forged of [undefined, null, {}, { ...accepted }, structuredClone(accepted)]) {
      expect(isVerifiedGithubRevocation(forged)).toBe(false);
      await expect(store.apply(forged as VerifiedGithubRevocation)).rejects.toThrow("refused");
    }
    expect(db.tx).not.toHaveBeenCalled(); expect(db.query).not.toHaveBeenCalled();
  });
  it("refuses an unknown backend instead of silently omitting PostgreSQL tenant locks", () => {
    const db = { query: vi.fn(), tx: vi.fn() };
    expect(() => createGithubWebhookStore(db)).toThrow("could not be confirmed");
    expect(db.tx).not.toHaveBeenCalled(); expect(db.query).not.toHaveBeenCalled();
  });
  it("authenticates original UTF8 bytes, emits only immutable revocation metadata, and never opens SQL on refusal", async () => {
    const body = JSON.stringify(data());
    const value = await authenticateGithubWebhook(request(body), env());
    expect(value).toMatchObject({ appId: "42", installationId: 7, event: "installation", action: "deleted", repositoryIds: [], bodySha256: createHash("sha256").update(body).digest("hex") });
    expect(JSON.stringify(value)).not.toContain("unicode"); expect(JSON.stringify(value)).not.toContain("untrusted.invalid");
    const db = vi.fn(async (): Promise<Sql> => { throw new Error("SQL must not open"); });
    const handler = createGithubWebhookHandler({ db, env: env() });
    expect((await handler(request(body, { headers: { "x-hub-signature-256": "sha256=" + "0".repeat(64) } }))).status).toBe(403);
    expect(db).not.toHaveBeenCalled();
  });
  it.each<Record<string, string>>([
    { "x-hub-signature-256": "" },
    { "x-hub-signature-256": "sha1=" + "a".repeat(40) }, { "x-hub-signature-256": "sha256=" + "a".repeat(63) },
    { "x-hub-signature-256": "sha256=" + "a".repeat(64) + ", sha256=" + "a".repeat(64) },
    { "x-github-event": "installation, installation" }, { "x-github-delivery": "not-a-guid" },
    { "content-type": "application/x-www-form-urlencoded" }, { "content-encoding": "gzip" },
  ])("refuses malformed or ambiguous typed headers before SQL", async headers => {
    const db = vi.fn(async (): Promise<Sql> => { throw new Error("SQL must not open"); });
    expect((await createGithubWebhookHandler({ db, env: env() })(request(JSON.stringify(data()), { headers }))).status).toBeGreaterThanOrEqual(400);
    expect(db).not.toHaveBeenCalled();
  });
  it("requires SHA256 over the exact bytes rather than parsed or reformatted JSON", async () => {
    const compact = JSON.stringify(data()); const pretty = JSON.stringify(data(), null, 2);
    const signature = "sha256=" + createHmac("sha256", secret).update(compact).digest("hex");
    expect((await createGithubWebhookHandler({ db: vi.fn(), env: env() })(request(pretty, { headers: { "x-hub-signature-256": signature } }))).status).toBe(403);
  });
  it.each(["duplicate", "escaped-duplicate", "invalid-json", "invalid-utf8", "unsafe-id", "wrong-app", "missing-suspension", "empty-removal", "duplicate-removal", "string-removal", "nonempty-added"])("refuses signed malformed authority: %s", async kind => {
    let raw: string | Buffer = JSON.stringify(data()); let event = "installation";
    if (kind === "duplicate") raw = raw.replace('{"action":"deleted",', '{"action":"deleted","action":"suspend",');
    if (kind === "escaped-duplicate") raw = raw.replace('{"action":"deleted",', '{"action":"deleted","act\\u0069on":"deleted",');
    if (kind === "invalid-json") raw = "{";
    if (kind === "invalid-utf8") raw = Buffer.from([0x80]);
    if (kind === "unsafe-id") raw = JSON.stringify(data("deleted", "42", Number.MAX_SAFE_INTEGER + 1));
    if (kind === "wrong-app") raw = JSON.stringify(data("deleted", "43"));
    if (kind === "missing-suspension") raw = JSON.stringify({ ...data("suspend"), installation: { id: 7, app_id: 42 } });
    if (["empty-removal", "duplicate-removal", "string-removal", "nonempty-added"].includes(kind)) {
      event = "installation_repositories";
      raw = JSON.stringify({ ...data("removed", "42", 7, kind === "empty-removal" ? [] : kind === "duplicate-removal" ? [{ id: 99 }, { id: 99 }] : kind === "string-removal" ? [{ id: "99" }] : [{ id: 99 }]),
        ...(kind === "nonempty-added" ? { repositories_added: [{ id: 100 }] } : {}) });
    }
    const db = vi.fn(async (): Promise<Sql> => { throw new Error("SQL must not open"); });
    expect((await createGithubWebhookHandler({ db, env: env() })(request(raw, { event }))).status).toBe(kind === "wrong-app" ? 403 : 400);
    expect(db).not.toHaveBeenCalled();
  });
  it("bounds actual bytes, declared bytes, cancellation and configuration before SQL", async () => {
    const db = vi.fn(async (): Promise<Sql> => { throw new Error("SQL must not open"); }); const handler = createGithubWebhookHandler({ db, env: env() });
    expect((await handler(request("x".repeat(GITHUB_WEBHOOK_MAX_BYTES + 1)))).status).toBe(413);
    expect((await handler(request("{}", { headers: { "content-length": String(GITHUB_WEBHOOK_MAX_BYTES + 1) } }))).status).toBe(413);
    expect((await handler(request("{}", { headers: { "content-length": "3" } }))).status).toBe(400);
    const controller = new AbortController(); controller.abort();
    expect((await handler(request(JSON.stringify(data()), { signal: controller.signal }))).status).toBe(408);
    expect((await createGithubWebhookHandler({ db, env: {} })(request(JSON.stringify(data())))).status).toBe(503);
    expect(db).not.toHaveBeenCalled();
  });
  it.each(["public-file", "public-parent", "hardlink", "symlink", "short", "newline"])("requires real private secret custody: %s", async kind => {
    let configured = file; const alias = path.join(directory, "alias");
    try {
      if (kind === "public-file") await chmod(file, 0o644);
      if (kind === "public-parent") await chmod(directory, 0o755);
      if (kind === "hardlink") await link(file, alias);
      if (kind === "symlink") { await symlink(file, alias); configured = alias; }
      if (kind === "short") await writeFile(file, "short");
      if (kind === "newline") await writeFile(file, Buffer.concat([secret, Buffer.from("\n")]));
      const db = vi.fn(async (): Promise<Sql> => { throw new Error("SQL must not open"); });
      expect((await createGithubWebhookHandler({ db, env: env("42", configured) })(request(JSON.stringify(data())))).status).toBe(503);
      expect(db).not.toHaveBeenCalled();
    } finally {
      await unlink(alias).catch(() => undefined); await chmod(directory, 0o700); await chmod(file, 0o600); await writeFile(file, secret);
    }
  });
  it.each(["created", "unsuspend", "new_permissions_accepted", "added", "ping"])("authenticated %s never grants, rebinds or opens SQL", async action => {
    const db = vi.fn(async (): Promise<Sql> => { throw new Error("SQL must not open"); });
    const event = action === "ping" ? "ping" : action === "added" ? "installation_repositories" : "installation";
    expect((await createGithubWebhookHandler({ db, env: env() })(request(JSON.stringify(data(action)), { event }))).status).toBe(204);
    expect(db).not.toHaveBeenCalled();
  });
});

function contracts(kind: "pglite" | "postgres") {
  let db: PlatformDbHandle; const appId = String(randomInt(1_000_000, 1_000_000_000));
  const prefix = "ghw_" + randomUUID().replaceAll("-", ""); const workspaces = ["a", "b", "foreign-app", "foreign-install", "other-repo"].map(v => `${prefix}_${v}`);
  const firstWorkspace = `${prefix}_first`; const allOwned = [...workspaces, firstWorkspace];
  const handler = (sql: Sql = db) => createGithubWebhookHandler({ db: async () => sql, env: env(appId) });
  const send = (action = "deleted", delivery = randomUUID(), removed = [{ id: 99 }]) => handler()(request(JSON.stringify(data(action, appId, 7, removed)), { delivery, event: action === "removed" ? "installation_repositories" : "installation" }));
  const state = () => db.query("select workspace_id, version, revoked_at is not null as revoked from platform.github_source_bindings where workspace_id = any($1::text[]) order by workspace_id", [`{${allOwned.join(",")}}`]);
  const clear = async () => {
    await db.query("delete from platform.github_binding_events where workspace_id = any($1::text[])", [`{${allOwned.join(",")}}`]);
    await db.query("delete from platform.github_install_intents where workspace_id = any($1::text[])", [`{${allOwned.join(",")}}`]);
    await db.query("delete from platform.github_source_bindings where workspace_id = any($1::text[])", [`{${allOwned.join(",")}}`]);
    await db.query("delete from platform.github_webhook_deliveries where app_id = $1", [appId]);
    await db.query("delete from platform.github_webhook_installation_epochs where app_id = $1", [appId]);
  };
  beforeAll(async () => {
    db = await openPlatformDb({ kind, url: kind === "postgres" ? process.env.ZENITH_TEST_PLATFORM_PG_URL : undefined, migrate: true });
    expect(createHash("sha256").update(PLATFORM_MIGRATIONS.find(m => m.version === 9)!.sql).digest("hex")).toBe("7d00eb79279b57c682dda67af0a5eaffc5ff3825d5e6a370235dd0dfdb502060");
    await assertPlatformSchemaCurrent(db);
  }, 60_000);
  afterAll(async () => { if (db) { await clear(); await db.close(); } });
  beforeEach(async () => {
    await clear();
    for (const [index, workspace] of workspaces.entries()) await db.query(`insert into platform.github_source_bindings
      (workspace_id, app_id, installation_id, repository_id, owner, repo, version, bound_by)
      values ($1, $2, $3, $4, 'acme', 'app', 1, 'human')`, [workspace, index === 2 ? String(Number(appId) + 1) : appId, index === 3 ? 8 : 7, index === 4 ? 100 : 99]);
    for (const workspace of workspaces) await db.query(`insert into platform.github_install_intents
      (workspace_id, state_digest, actor_id, browser_digest, owner, repo, expected_version, phase, expires_at)
      values ($1, $2, 'human', $3, 'acme', 'app', 1, 'install', clock_timestamp() + interval '10 minutes')`, [workspace, "a".repeat(64), "b".repeat(64)]);
  });
  it.each(["deleted", "suspend"])("signed installation %s revokes exact App+installation bindings across tenants and preserves rows", async action => {
    expect((await send(action)).status).toBe(204);
    const rows = await state(); expect(rows).toHaveLength(5);
    expect(rows.filter(row => row.revoked).map(row => row.workspace_id).sort()).toEqual([workspaces[0], workspaces[1], workspaces[4]].sort());
    expect(rows.filter(row => row.revoked).every(row => row.version === 2)).toBe(true);
    expect(await db.query("select action, actor_id, version from platform.github_binding_events where app_id = $1 order by workspace_id", [appId])).toEqual(Array.from({ length: 3 }, () => ({ action: "revoked", actor_id: "github_webhook", version: 2 })));
    expect((await db.query("select workspace_id from platform.github_install_intents where workspace_id = any($1::text[])", [`{${workspaces.join(",")}}`])).map(row => row.workspace_id).sort()).toEqual([workspaces[2], workspaces[3]].sort());
  });
  it("repository removal selects exact immutable removed IDs and retains other repositories", async () => {
    expect((await send("removed")).status).toBe(204);
    const rows = await state(); expect(rows.filter(row => row.revoked).map(row => row.workspace_id).sort()).toEqual([workspaces[0], workspaces[1]].sort());
    expect(rows.find(row => row.workspace_id === workspaces[4])).toMatchObject({ version: 1, revoked: false });
  });
  it("duplicates and concurrent redeliveries commit one receipt, version change and audit per tenant", async () => {
    const delivery = randomUUID();
    expect((await Promise.all(Array.from({ length: 6 }, () => send("deleted", delivery)))).every(response => response.status === 204)).toBe(true);
    expect(await db.query("select revoked_count, replayed from platform.github_webhook_deliveries where app_id = $1", [appId])).toEqual([{ revoked_count: 3, replayed: false }]);
    const audit = await db.query("select version from platform.github_binding_events where app_id=$1", [appId]);
    expect(audit).toHaveLength(3); expect(audit.every(row => row.version === 2)).toBe(true);
    expect((await captureGithubWebhookFence(db, appId, 7)).generation).toBe("1");
  });
  it("refuses a delivery GUID reused with a different signed body without partial mutations", async () => {
    const delivery = randomUUID(); expect((await send("deleted", delivery)).status).toBe(204); const before = await state();
    expect((await send("suspend", delivery)).status).toBe(409); expect(await state()).toEqual(before);
    expect((await captureGithubWebhookFence(db, appId, 7)).generation).toBe("1");
  });
  it("changing the unsigned GUID cannot replay signed bytes against a freshly rebound row", async () => {
    expect((await send()).status).toBe(204);
    await db.query("update platform.github_source_bindings set revoked_at=null, revoked_by=null, version=3 where workspace_id=$1", [workspaces[0]]);
    expect((await send()).status).toBe(204);
    expect((await state()).find(row => row.workspace_id === workspaces[0])).toMatchObject({ version: 3, revoked: false });
    expect((await db.query("select replayed from platform.github_webhook_deliveries where app_id=$1 order by received_at", [appId])).map(row => row.replayed)).toEqual([false, true]);
    expect((await captureGithubWebhookFence(db, appId, 7)).generation).toBe("1");
  });
  it("receipt, epoch, audit and intent invalidation roll back on an actual SQL audit failure", async () => {
    const before = await state();
    const failAudit: Sql & { kind: "postgres" | "pglite" } = { kind, query: db.query.bind(db), tx: fn => db.tx(async tx => fn({
      query: <T,>(text: string, params?: readonly unknown[]) => text.includes("insert into platform.github_binding_events") ? tx.query<T>("select 1 / 0") : tx.query<T>(text, params), tx: tx.tx.bind(tx),
    })) };
    expect((await handler(failAudit)(request(JSON.stringify(data("deleted", appId))))).status).toBe(503);
    expect(await state()).toEqual(before);
    expect(await db.query("select delivery_id from platform.github_webhook_deliveries where app_id=$1", [appId])).toEqual([]);
    expect(await db.query("select generation from platform.github_webhook_installation_epochs where app_id=$1", [appId])).toEqual([]);
    expect(await db.query("select action from platform.github_binding_events where app_id=$1", [appId])).toEqual([]);
    expect(await db.query("select workspace_id from platform.github_install_intents where workspace_id=any($1::text[])", [`{${workspaces.join(",")}}`])).toHaveLength(5);
  });
  it("fences consumed callbacks including expectedVersion=0 before any binding row exists", async () => {
    const fence = await captureGithubWebhookFence(db, appId, 7);
    const firstFence = await captureGithubWebhookFence(db, appId, 777);
    await db.query(`insert into platform.github_install_intents
      (workspace_id, state_digest, actor_id, browser_digest, owner, repo, expected_version, phase, expires_at, app_id, installation_id, installation_generation)
      values ($1, $2, 'human', $3, 'acme', 'app', 0, 'oauth', clock_timestamp() + interval '10 minutes', $4, 777, 0)`,
    [firstWorkspace, "a".repeat(64), "b".repeat(64), appId]);
    expect((await send()).status).toBe(204);
    await expect(db.tx(tx => assertGithubWebhookFence(tx, fence))).rejects.toThrow("changed");
    const noBinding = await authenticateGithubWebhook(request(JSON.stringify(data("deleted", appId, 777))), env(appId));
    await createGithubWebhookStore(db).apply(noBinding!);
    expect(await db.query("select workspace_id from platform.github_install_intents where workspace_id=$1", [firstWorkspace])).toEqual([]);
    await expect(db.tx(tx => assertGithubWebhookFence(tx, firstFence))).rejects.toThrow("changed");
    const fresh = await captureGithubWebhookFence(db, appId, 777);
    await db.tx(tx => assertGithubWebhookFence(tx, fresh));
  });
  it.each(["first binding", "existing binding"])("refuses an actual consumed %s after signed installation revocation", async mode => {
    const workspaceId = mode === "first binding" ? firstWorkspace : workspaces[0];
    const store = createGithubSourceStore(db);
    const caller = { workspaceId, actorId: "human", ...await store.begin(workspaceId, "human", { owner: "acme", repo: "app" }) };
    await store.authorize(caller, 7, appId);
    const consumed = await store.consume(caller);
    expect(consumed.expectedVersion).toBe(mode === "first binding" ? 0 : 1);
    expect((await send()).status).toBe(204);
    const before = await state();
    const audit = await db.query("select workspace_id,version,action from platform.github_binding_events where app_id=$1 order by workspace_id,version", [appId]);
    await expect(store.bind({ ...consumed, workspaceId, actorId: "human", repositoryId: 99 })).rejects.toThrow("changed");
    expect(await state()).toEqual(before);
    expect(await db.query("select workspace_id,version,action from platform.github_binding_events where app_id=$1 order by workspace_id,version", [appId])).toEqual(audit);
    if (mode === "first binding") expect(await store.getState(workspaceId)).toBeUndefined();
    else await expect(store.getBinding(workspaceId)).rejects.toThrow("refused");
  });
  it("another signed revocation preserves already-revoked versions and never restores access", async () => {
    expect((await send("deleted")).status).toBe(204); const before = await state();
    expect((await send("suspend")).status).toBe(204); expect(await state()).toEqual(before);
    expect(await db.query("select version from platform.github_binding_events where app_id=$1", [appId])).toHaveLength(3);
    expect((await captureGithubWebhookFence(db, appId, 7)).generation).toBe("2");
  });
  it("serializes webhook revocation with a first-binding transaction holding the same epoch lock", async () => {
    const fence = await captureGithubWebhookFence(db, appId, 7);
    let release!: () => void; let reached!: () => void;
    let blockerPid: number | undefined;
    const waiting = new Promise<void>(resolve => { release = resolve; }); const locked = new Promise<void>(resolve => { reached = resolve; });
    const binding = db.tx(async tx => { await assertGithubWebhookFence(tx, fence);
      if (kind === "postgres") blockerPid = (await tx.query<{ pid: number }>("select pg_backend_pid() as pid"))[0].pid;
      reached(); await waiting;
      if (kind === "postgres") await tx.query("select pg_advisory_xact_lock(hashtextextended('zenith:github-binding:' || $1::text, 0))", [firstWorkspace]);
      await tx.query(`insert into platform.github_source_bindings
        (workspace_id, app_id, installation_id, repository_id, owner, repo, version, bound_by)
        values ($1, $2, 7, 99, 'acme', 'app', 1, 'human')`, [firstWorkspace, appId]); });
    await locked; const revoking = send();
    try {
      if (kind === "postgres") {
        const deadline = Date.now() + 5_000; let observed = false;
        while (Date.now() < deadline) {
          const rows = await db.query<{ blocked: boolean }>(`select exists(select 1 from pg_stat_activity
            where datname=current_database() and wait_event_type='Lock'
            and query like '%platform.github_webhook_installation_epochs%'
            and $1=any(pg_blocking_pids(pid))) as blocked`, [blockerPid]);
          if (rows[0].blocked) { observed = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(observed, "authenticated webhook must be observed waiting on the held installation lock").toBe(true);
      }
    } finally { release(); await Promise.all([binding, revoking]); }
    await binding; expect((await revoking).status).toBe(204);
    expect((await state()).find(row => row.workspace_id === firstWorkspace)).toMatchObject({ version: 2, revoked: true });
  });
  it.each(["00", "-1", "1.0", "9223372036854775808", "9".repeat(20)])("refuses noncanonical/out-of-range generation %s without changing it", async generation => {
    await expect(db.tx(tx => assertGithubWebhookFence(tx, { appId, installationId: 7, generation }))).rejects.toThrow("invalid");
    expect((await captureGithubWebhookFence(db, appId, 7)).generation).toBe("0");
  });
  it("stores digest and fixed metadata only, with no raw payload or secret-bearing columns", async () => {
    expect((await send()).status).toBe(204);
    const rows = await db.query("select * from platform.github_webhook_deliveries where app_id=$1", [appId]);
    const columns = Object.keys(rows[0]);
    expect(columns).toEqual(["app_id", "delivery_id", "body_sha256", "event", "action", "installation_id", "repository_ids", "revoked_count", "replayed", "received_at"]);
    expect(JSON.stringify(rows)).not.toContain("untrusted.invalid"); expect(JSON.stringify(rows)).not.toContain(secret.toString());
  });
  if (kind === "pglite") it("accepts actual loopback HTTP through the standalone route and authenticates before platform SQL", async () => {
    routeState.db = db; routeState.opens = 0; vi.stubEnv("ZENITH_GITHUB_APP_ID", appId); vi.stubEnv("ZENITH_GITHUB_APP_WEBHOOK_SECRET_FILE", file);
    const server = createServer(async (incoming, outgoing) => {
      try {
        const headers = new Headers(); for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        const init = { method: "POST", headers, body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: "half" };
        const response = await POST(new Request(URL, init)); outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch { outgoing.writeHead(503); outgoing.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("test HTTP port unavailable");
      const raw = JSON.stringify(data("removed", appId)); const signed = request(raw, { event: "installation_repositories" });
      const target = `http://127.0.0.1:${address.port}/webhook`;
      expect((await fetch(target, { method: "POST", headers: { ...Object.fromEntries(signed.headers), "x-hub-signature-256": "sha256=" + "0".repeat(64) }, body: raw })).status).toBe(403);
      expect(routeState.opens).toBe(0);
      expect((await fetch(target, { method: "POST", headers: signed.headers, body: raw })).status).toBe(204); expect(routeState.opens).toBe(1);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); routeState.db = undefined; }
  });
}
describe("GitHub webhook SQL [pglite]", () => contracts("pglite"));
describe.skipIf(!process.env.ZENITH_TEST_PLATFORM_PG_URL)("GitHub webhook SQL [postgres]", () => contracts("postgres"));
