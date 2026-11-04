/** Owning independent PostgreSQL and encrypted FILE vault; human selection and namespace API are explicit models. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dump as yamlDump } from "js-yaml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "@/lib/controlplane/types";
import type { ProviderSession } from "@/lib/credentials/types";
import { tempDataDir } from "../_support/data-dir";
const DATA = tempDataDir("zenith-native-kube-link-", { fast: true });
const api = vi.hoisted(() => ({ topologyModel: true, read: vi.fn(), sessions: [] as ProviderSession[] }));
vi.mock("@/lib/providers/kubernetes/client", () => ({ createK8sClient: (session: ProviderSession) => { api.sessions.push(session); return { core: { readNamespacedServiceAccount: api.read } }; } }));
vi.mock("@/lib/controlplane/db/repos/workflow-start-deploy-authority", async original => {
  const actual = await original<typeof import("@/lib/controlplane/db/repos/workflow-start-deploy-authority")>();
  const owning = async (sql: Sql, tx: Sql) => {
    const { isOpenedPlatformDbHandle } = await import("@/lib/controlplane/db");
    if (!isOpenedPlatformDbHandle(sql, "postgres")) throw new Error("Modeled hosted association requires a genuine owning PostgreSQL handle.");
    const rows = await tx.query<{ database: string; role: string; schema: string }>("select current_database() as database,current_user as role,current_schema() as schema");
    if (rows.length !== 1 || !rows[0].database || !rows[0].role || rows[0].schema !== "public") throw new Error("Actual owning PostgreSQL session is unavailable.");
  };
  return { ...actual,
    // Only hosted association is modeled. Owning handle, transaction, members and final SQL remain real.
    assertDefaultMcpProductTopology: (sql: Sql) => api.topologyModel ? owning(sql, sql) : actual.assertDefaultMcpProductTopology(sql),
    assertFinalMcpProductTopology: (sql: Sql, tx: Sql) => {
      if (!api.topologyModel) return actual.assertFinalMcpProductTopology(sql, tx);
      if (sql === tx) throw new Error("Modeled hosted association requires the actual owning transaction.");
      return owning(sql, tx);
    },
  };
});
const { openPlatformDb, repos, PLATFORM_SCHEMA_VERSION } = await import("@/lib/controlplane/db");
const store = await import("@/lib/db/store");
const vault = await import("@/lib/secrets");
const { runAction } = await import("@/lib/actions/core");
const { setBridgeDepsForTests } = await import("@/lib/bridge/deps");
const { PG_URL } = await import("./_support/harness");
await import("@/lib/actions/defs");
if (process.env.ZENITH_TEST_KUBERNETES_CONNECTION_LINK_REQUIRED === "1" && (!PG_URL || PLATFORM_SCHEMA_VERSION < 13)) throw new Error("Kubernetes connection linking requires owned PostgreSQL and canonical schema13.");
const CA = Buffer.from("modeled-native-link-public-ca").toString("base64"), CANARY = "native-kube-link-credential-canary";
function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

describe.skipIf(!PG_URL)("human Kubernetes connection linking [postgres; modeled hosted association, human request and namespace API]", () => {
  let owner: Awaited<ReturnType<typeof openPlatformDb>>, peer: Awaited<ReturnType<typeof openPlatformDb>>, observer: Awaited<ReturnType<typeof openPlatformDb>>;
  let workspaceId: string;
  const refs: string[] = [];
  beforeAll(async () => {
    owner = await openPlatformDb({ kind: "postgres", url: PG_URL, migrate: true, max: 1 });
    peer = await openPlatformDb({ kind: "postgres", url: PG_URL, max: 1 }); observer = await openPlatformDb({ kind: "postgres", url: PG_URL, max: 1 });
    const pids = await Promise.all([owner, peer, observer].map(db => db.query<{ pid: number }>("select pg_backend_pid() as pid")));
    expect(new Set(pids.map(rows => rows[0].pid)).size).toBe(3);
    const migration = fs.readFileSync(new URL("../../supabase/migrations/0001_system_of_record.sql", import.meta.url), "utf8");
    const ddl = /create table if not exists public\.members \([\s\S]*?\n\);/.exec(migration)?.[0];
    if (!ddl) throw new Error("Canonical product membership DDL is unavailable.");
    await owner.exec(ddl);
  }, 60_000);
  afterAll(async () => { try { await observer?.close(); } finally { try { await peer?.close(); } finally { await owner?.close(); } } });
  beforeEach(async () => {
    workspaceId = `ws-kube-link-${randomUUID()}`; const at = new Date().toISOString();
    vi.stubEnv("ZENITH_STORE", "file"); vi.stubEnv("ZENITH_SECRET_KEY", "1".repeat(64));
    store.resetDb({ workspaces: [{ id: workspaceId, name: "Owning cluster", slug: workspaceId, createdAt: at }], members: [
      { id: "admin", workspaceId, name: "Modeled admin", email: "admin@example.test", role: "admin" },
      { id: "editor", workspaceId, name: "Modeled editor", email: "editor@example.test", role: "editor" }], connections: [] });
    await owner.query("insert into public.members(id,workspace_id,email,role,data) values('admin',$1,'admin@example.test','admin','{}'::jsonb),('editor',$1,'editor@example.test','editor','{}'::jsonb)", [workspaceId]);
    api.topologyModel = true; store.save(); api.sessions.length = 0; api.read.mockReset().mockImplementation(async ({ name, namespace }) => ({ metadata: { name, namespace } }));
    setBridgeDepsForTests({ connectionSql: async () => owner });
  });
  afterEach(async () => {
    try { for (const ref of refs.splice(0)) await vault.removeSecretAsync(workspaceId, ref);
      await observer.query("delete from platform.events where workspace_id=$1", [workspaceId]);
      await observer.query("delete from platform.provider_connections where workspace_id=$1", [workspaceId]);
      await observer.query("delete from public.members where workspace_id=$1 or workspace_id=$2", [workspaceId, `${workspaceId}-foreign`]);
    } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); setBridgeDepsForTests(null); }
  });
  const context = (id = "admin") => ({ workspaceId, actor: { type: "user" as const, id, name: `Modeled ${id}` } });
  async function action(name: string, input: unknown, id = "admin") { return (await runAction(name, context(id), input, { mode: "execute" })).result!; }
  async function preview(connectionId: string) {
    const native = await repos.connections.list(peer, workspaceId), product = structuredClone(store.db().connections);
    const events = await repos.events.list(peer, workspaceId), audit = structuredClone(store.readAudit());
    const output = await runAction("connection.verifyKubernetes", context("editor"), { connectionId }, { mode: "plan" });
    if (!output.plan) throw new Error("Verification preview was not returned.");
    expect(await repos.connections.list(peer, workspaceId)).toEqual(native); expect(store.db().connections).toEqual(product);
    expect(await repos.events.list(peer, workspaceId)).toEqual(events); expect(store.readAudit()).toEqual(audit);
    return output.plan;
  }
  async function fixture() {
    const credentialRef = `vault:link/${randomUUID()}/KUBECONFIG`, input = { server: "https://cluster.example.test", caData: CA, namespaces: ["orders"], credentialRef, scopedGuest: false };
    const result = await action("connection.createKubernetes", input); expect(result.ok).toBe(true);
    const { connectionId } = result.data as { connectionId: string };
    expect(await repos.connections.get(owner, workspaceId, connectionId)).toMatchObject({ id: connectionId, legacyConnectionId: connectionId, status: "pending_verification", config: { provider: "kubernetes", mode: "kubeconfig_ref" } });
    expect(store.q.connection(connectionId)).toMatchObject({ id: connectionId, platformConnectionId: connectionId, workspaceId, status: "connecting" });
    await vault.putSecretAsync(workspaceId, credentialRef, yamlDump({ apiVersion: "v1", kind: "Config", "current-context": "bound",
      clusters: [{ name: "cluster", cluster: { server: input.server, "certificate-authority-data": CA } }],
      contexts: [{ name: "bound", context: { cluster: "cluster", user: "reader" } }], users: [{ name: "reader", user: { token: CANARY } }] }, { noRefs: true }), "admin");
    refs.push(credentialRef); return { input, connectionId };
  }
  async function safe(result: unknown) { expect(JSON.stringify({ result, connections: await repos.connections.list(owner, workspaceId), events: await repos.events.list(owner, workspaceId), audit: store.readAudit() })).not.toContain(CANARY); }
  async function preciseCreatedAt(connectionId: string) {
    const raw = "2026-10-04T00:00:00.123456Z";
    await peer.query("update platform.provider_connections set created_at=$3::text::timestamptz where workspace_id=$1 and id=$2", [workspaceId, connectionId, raw]);
    expect(await peer.query<{ exact: boolean; normalized: boolean }>("select created_at=$3::text::timestamptz as exact,created_at=date_trunc('milliseconds',created_at) as normalized from platform.provider_connections where workspace_id=$1 and id=$2", [workspaceId, connectionId, raw])).toEqual([{ exact: true, normalized: false }]);
    expect((await repos.connections.get(peer, workspaceId, connectionId))?.createdAt).toBe("2026-10-04T00:00:00.123Z");
  }
  it("pending native same-ID onboarding becomes verified only after the saved bound namespace read", async () => {
    const read = vi.spyOn(vault, "readSecretValueAsync");
    const f = await fixture(); expect(api.read).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
    await preciseCreatedAt(f.connectionId);
    const planned = await preview(f.connectionId); expect(planned.blocked).toBeUndefined();
    expect(api.read).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); await safe(planned);
    const result = await action("connection.verifyKubernetes", { connectionId: f.connectionId }, "editor"); expect(result.ok).toBe(true);
    expect(api.read).toHaveBeenCalledExactlyOnceWith({ name: "default", namespace: "orders" });
    expect((await repos.connections.get(peer, workspaceId, f.connectionId))?.status).toBe("verified"); expect(store.q.connection(f.connectionId)?.status).toBe("healthy");
    const persisted = JSON.parse(fs.readFileSync(path.join(DATA, "state.json"), "utf8")) as { connections: { id: string; workspaceId: string; platformConnectionId?: string; status: string }[] };
    expect(persisted.connections.filter(connection => connection.id === f.connectionId)).toEqual([expect.objectContaining({ id: f.connectionId, workspaceId, platformConnectionId: f.connectionId, status: "healthy" })]);
    expect(fs.readFileSync(path.join(DATA, "secrets.json"), "utf8")).not.toContain(CANARY);
    await safe(result);
  });
  it.each(["config", "legacy link", "revocation", "status", "creator", "actor demotion", "product projection"] as const)("held native namespace read refuses changed %s before recording verification or product health", async fault => {
    const f = await fixture(), entered = barrier(), release = barrier();
    api.read.mockImplementationOnce(async ({ name, namespace }) => { entered.release(); await release.promise; return { metadata: { name, namespace } }; });
    const pending = action("connection.verifyKubernetes", { connectionId: f.connectionId }, "editor");
    await entered.promise;
    try {
      if (fault === "config") await peer.query("update platform.provider_connections set config=jsonb_set(config,'{server}','\"https://foreign.example.test\"'::jsonb) where workspace_id=$1 and id=$2", [workspaceId, f.connectionId]);
      else if (fault === "legacy link") await peer.query("update platform.provider_connections set legacy_connection_id='foreign' where workspace_id=$1 and id=$2", [workspaceId, f.connectionId]);
      else if (fault === "revocation") await repos.connections.revoke(peer, workspaceId, f.connectionId);
      else if (fault === "status") await repos.connections.recordVerification(peer, { workspaceId, id: f.connectionId, ok: false, detail: "Other recorded read." });
      else if (fault === "creator") await peer.query("update platform.provider_connections set created_by='foreign' where workspace_id=$1 and id=$2", [workspaceId, f.connectionId]);
      else if (fault === "actor demotion") { await peer.query("update public.members set role='viewer' where workspace_id=$1 and id='editor'", [workspaceId]); store.db().members.find(member => member.id === "editor")!.role = "viewer"; store.save(); }
      else { store.q.connection(f.connectionId)!.label = "Changed by another actor"; store.save(); }
    } finally { release.release(); }
    const result = await pending; expect(result.ok).toBe(false);
    expect(store.q.connection(f.connectionId)?.status).toBe("connecting");
    expect((await repos.connections.get(peer, workspaceId, f.connectionId))?.status).not.toBe("verified"); expect(api.read).toHaveBeenCalledOnce(); await safe(result);
  });
  it.each(["same DTO microsecond", "config", "legacy link", "mode", "status"] as const)("observed native verification update waiter refuses changed %s after its original capture", async fault => {
    const f = await fixture();
    if (fault === "same DTO microsecond") {
      await repos.connections.recordVerification(owner, { workspaceId, id: f.connectionId, ok: true });
      await peer.query("update platform.provider_connections set verified_at=date_trunc('milliseconds',clock_timestamp())+interval '100 microseconds' where workspace_id=$1 and id=$2", [workspaceId, f.connectionId]);
    }
    const captured = await repos.connections.captureVerification(owner, workspaceId, f.connectionId, "editor"); expect(captured).not.toBeNull();
    if (!captured) throw new Error("Native verification capture is unavailable.");
    const pid = (await owner.query<{ pid: number }>("select pg_backend_pid() as pid"))[0].pid;
    const entered = barrier(), release = barrier();
    const lock = peer.tx(async tx => { await tx.query("select id from platform.provider_connections where workspace_id=$1 and id=$2 for update", [workspaceId, f.connectionId]); entered.release(); await release.promise;
      if (fault === "same DTO microsecond") await tx.query("update platform.provider_connections set verified_at=verified_at+interval '1 microsecond' where workspace_id=$1 and id=$2", [workspaceId, f.connectionId]);
      else if (fault === "config") await tx.query("update platform.provider_connections set config=jsonb_set(config,'{namespaces}','[\"foreign\"]'::jsonb) where workspace_id=$1 and id=$2", [workspaceId, f.connectionId]);
      else if (fault === "legacy link") await tx.query("update platform.provider_connections set legacy_connection_id='foreign' where workspace_id=$1 and id=$2", [workspaceId, f.connectionId]);
      else if (fault === "mode") await tx.query("update platform.provider_connections set mode='runner' where workspace_id=$1 and id=$2", [workspaceId, f.connectionId]);
      else await tx.query("update platform.provider_connections set status='failed' where workspace_id=$1 and id=$2", [workspaceId, f.connectionId]); });
    await entered.promise; const pending = repos.connections.recordCapturedVerification(owner, captured, { ok: true, detail: "Modeled read result; no provider call in this CAS-only control." });
    try {
      const { waitFor } = await import("../workflows/support");
      await waitFor("actual owned verification row waiter", async () => {
        const rows = await observer.query<{ waiting: boolean }>("select exists(select 1 from pg_stat_activity where pid=$1 and datname=current_database() and wait_event_type='Lock' and query like 'select id from platform.provider_connections%' and query like '%for update%') as waiting", [pid]);
        return rows[0]?.waiting ? true : false;
      });
    } finally { release.release(); }
    await lock; expect(await pending).toBeNull(); expect(store.q.connection(f.connectionId)?.status).toBe("connecting"); expect(api.read).not.toHaveBeenCalled();
    if (fault === "same DTO microsecond") expect((await repos.connections.get(peer, workspaceId, f.connectionId))?.verifiedAt).toEqual(captured.connection.verifiedAt);
  });
  it.each(["demotion", "removal", "foreign workspace"] as const)("current actor %s during the observed original-row wait refuses native verification and product health", async fault => {
    const f = await fixture(), pid = (await owner.query<{ pid: number }>("select pg_backend_pid() as pid"))[0].pid;
    const entered = barrier(), release = barrier();
    const lock = peer.tx(async tx => {
      await tx.query("select id from platform.provider_connections where workspace_id=$1 and id=$2 for update", [workspaceId, f.connectionId]);
      entered.release(); await release.promise;
    });
    await entered.promise;
    const pending = action("connection.verifyKubernetes", { connectionId: f.connectionId }, "editor");
    try {
      const { waitFor } = await import("../workflows/support");
      await waitFor("actual owned action verification row waiter", async () => {
        const rows = await observer.query<{ waiting: boolean }>("select exists(select 1 from pg_stat_activity where pid=$1 and datname=current_database() and wait_event_type='Lock' and query like 'select id from platform.provider_connections%' and query like '%for update%') as waiting", [pid]);
        return rows[0]?.waiting ? true : false;
      });
      expect(api.read).toHaveBeenCalledOnce();
      if (fault === "demotion") await observer.query("update public.members set role='viewer' where workspace_id=$1 and id='editor'", [workspaceId]);
      else if (fault === "removal") await observer.query("delete from public.members where workspace_id=$1 and id='editor'", [workspaceId]);
      else await observer.query("update public.members set workspace_id=$2 where workspace_id=$1 and id='editor'", [workspaceId, `${workspaceId}-foreign`]);
    } finally { release.release(); }
    await lock;
    const result = await pending; expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({ persistence: "verification_not_recorded" });
    expect((await repos.connections.get(peer, workspaceId, f.connectionId))?.status).toBe("pending_verification");
    expect(store.q.connection(f.connectionId)?.status).toBe("connecting"); await safe(result);
  });
  it("copied, wrong-owner and reused verification captures never originate native status updates", async () => {
    const f = await fixture(); await preciseCreatedAt(f.connectionId);
    const captured = await repos.connections.captureVerification(owner, workspaceId, f.connectionId, "editor");
    if (!captured) throw new Error("Native verification capture is unavailable.");
    expect(await repos.connections.captureVerification(owner, "foreign", f.connectionId, "editor")).toBeNull();
    expect(await repos.connections.recordCapturedVerification(owner, { connection: captured.connection }, { ok: true })).toBeNull();
    expect(await repos.connections.recordCapturedVerification(peer, captured, { ok: true })).toBeNull();
    expect((await repos.connections.get(owner, workspaceId, f.connectionId))?.status).toBe("pending_verification");
    expect(await repos.connections.recordCapturedVerification(owner, captured, { ok: false })).toMatchObject({ status: "failed" });
    expect(await repos.connections.recordCapturedVerification(owner, captured, { ok: true })).toBeNull();
    expect(api.read).not.toHaveBeenCalled();
    // A fresh genuine observation also preserves nonnull raw verification precision.
    await repos.connections.recordVerification(owner, { workspaceId, id: f.connectionId, ok: true });
    const verifiedRaw = "2026-10-04T00:00:01.456789Z";
    await peer.query("update platform.provider_connections set verified_at=$3::text::timestamptz where workspace_id=$1 and id=$2", [workspaceId, f.connectionId, verifiedRaw]);
    expect(await peer.query<{ exact: boolean; normalized: boolean }>("select verified_at=$3::text::timestamptz as exact,verified_at=date_trunc('milliseconds',verified_at) as normalized from platform.provider_connections where workspace_id=$1 and id=$2", [workspaceId, f.connectionId, verifiedRaw])).toEqual([{ exact: true, normalized: false }]);
    const fresh = await repos.connections.captureVerification(owner, workspaceId, f.connectionId, "editor");
    if (!fresh) throw new Error("Fresh precise native verification capture is unavailable.");
    expect(fresh.connection.verifiedAt).toBe("2026-10-04T00:00:01.456Z");
    expect(await repos.connections.recordCapturedVerification(owner, fresh, { ok: false })).toMatchObject({ status: "failed", verifiedAt: fresh.connection.verifiedAt });
    expect((await peer.query<{ exact: boolean }>("select verified_at=$3::text::timestamptz as exact from platform.provider_connections where workspace_id=$1 and id=$2", [workspaceId, f.connectionId, verifiedRaw]))[0]?.exact).toBe(true);
    expect(await repos.connections.recordCapturedVerification(owner, fresh, { ok: true })).toBeNull();
    expect(api.read).not.toHaveBeenCalled();
  });
  it.each(["provider", "mode"] as const)("contradictory physical %s and config refuse before capture or namespace probing", async field => {
    const f = await fixture();
    if (field === "provider") await peer.query("update platform.provider_connections set provider='aws' where workspace_id=$1 and id=$2", [workspaceId, f.connectionId]);
    else await peer.query("update platform.provider_connections set mode='runner' where workspace_id=$1 and id=$2", [workspaceId, f.connectionId]);
    expect(await repos.connections.captureVerification(owner, workspaceId, f.connectionId, "editor")).toBeNull();
    expect((await preview(f.connectionId)).blocked).toBe("Kubernetes verification is unavailable for the current workspace connection.");
    const result = await action("connection.verifyKubernetes", { connectionId: f.connectionId }, "editor");
    expect(result.ok).toBe(false); expect(api.read).not.toHaveBeenCalled();
    expect((await repos.connections.get(peer, workspaceId, f.connectionId))?.status).toBe("pending_verification");
    expect(store.q.connection(f.connectionId)?.status).toBe("connecting"); await safe(result);
  });
  it("unsupported FILE topology leaves the created native connection pending and refuses before any namespace probe", async () => {
    const f = await fixture(); api.topologyModel = false;
    const read = vi.spyOn(vault, "readSecretValueAsync");
    expect((await preview(f.connectionId)).blocked).toBe("Kubernetes verification is unavailable for the current workspace connection.");
    expect(read).not.toHaveBeenCalled();
    const result = await action("connection.verifyKubernetes", { connectionId: f.connectionId }, "editor");
    expect(result.ok).toBe(false); expect(api.read).not.toHaveBeenCalled();
    expect((await repos.connections.get(peer, workspaceId, f.connectionId))?.status).toBe("pending_verification");
    expect(store.q.connection(f.connectionId)?.status).toBe("connecting"); await safe(result);
  });
  it("foreign scope and a revoked owning link never resolve the saved namespace credential", async () => {
    const f = await fixture(); store.q.connection(f.connectionId)!.workspaceId = "foreign";
    const read = vi.spyOn(vault, "readSecretValueAsync");
    expect((await preview(f.connectionId)).blocked).toBe("Kubernetes verification is unavailable for the current workspace connection.");
    expect((await action("connection.verifyKubernetes", { connectionId: f.connectionId }, "editor")).ok).toBe(false);
    store.q.connection(f.connectionId)!.workspaceId = workspaceId; await repos.connections.revoke(peer, workspaceId, f.connectionId);
    expect((await preview(f.connectionId)).blocked).toBe("Kubernetes verification is unavailable for the current workspace connection.");
    const result = await action("connection.verifyKubernetes", { connectionId: f.connectionId }, "editor"); expect(result.ok).toBe(false);
    expect(api.read).not.toHaveBeenCalled(); expect(store.q.connection(f.connectionId)?.status).toBe("connecting"); await safe(result);
    // Additional availability refusals are read only and keep this native case identity unchanged.
    const missing = await fixture();
    await peer.query("delete from platform.provider_connections where workspace_id=$1 and id=$2", [workspaceId, missing.connectionId]);
    expect((await preview(missing.connectionId)).blocked).toBe("Kubernetes verification is unavailable for the current workspace connection.");
    const current = await fixture(), original = await repos.connections.get(peer, workspaceId, current.connectionId);
    if (!original) throw new Error("Owning native target is unavailable.");
    await peer.query("update platform.provider_connections set legacy_connection_id='foreign' where workspace_id=$1 and id=$2", [workspaceId, current.connectionId]);
    expect((await preview(current.connectionId)).blocked).toBe("Kubernetes verification is unavailable for the current workspace connection.");
    await peer.query("update platform.provider_connections set legacy_connection_id=$2 where workspace_id=$1 and id=$2", [workspaceId, current.connectionId]);
    for (const bad of [{ server: "http://127.0.0.1:6443" }, { caData: "%%%" }, { namespaces: [] }, { credentialRef: "inline" }]) {
      await peer.query("update platform.provider_connections set config=$3::text::jsonb where workspace_id=$1 and id=$2", [workspaceId, current.connectionId, JSON.stringify({ ...original.config, ...bad })]);
      expect((await preview(current.connectionId)).blocked).toBe("Kubernetes verification is unavailable for the current workspace connection.");
    }
    await peer.query("update platform.provider_connections set config=$3::text::jsonb where workspace_id=$1 and id=$2", [workspaceId, current.connectionId, JSON.stringify(original.config)]);
    await peer.query("update public.members set role='viewer' where workspace_id=$1 and id='editor'", [workspaceId]);
    expect((await preview(current.connectionId)).blocked).toBe("Kubernetes verification is unavailable for the current workspace connection.");
    await peer.query("update public.members set role='editor' where workspace_id=$1 and id='editor'", [workspaceId]);
    expect((await preview(current.connectionId)).blocked).toBeUndefined();
    expect(read).not.toHaveBeenCalled(); expect(api.read).not.toHaveBeenCalled(); expect(api.sessions).toHaveLength(0);
    await safe(await preview(current.connectionId));
  });
});
