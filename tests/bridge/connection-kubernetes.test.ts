/** Real PGlite/file actions and canonical credential broker; namespace API replies and actors are explicit models. */
import { dump as yamlDump } from "js-yaml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformDbHandle } from "@/lib/controlplane/db";
import type { ProviderSession } from "@/lib/credentials/types";
import { tempDataDir } from "../_support/data-dir";
tempDataDir("zenith-kube-link-model-", { fast: true });
const fixture = vi.hoisted(() => ({ read: vi.fn(), saveFailure: false, nextSaveFailure: false, nextFlushFailure: false, sessions: [] as ProviderSession[] }));
vi.mock("@/lib/providers/kubernetes/client", () => ({ createK8sClient: (session: ProviderSession) => {
  fixture.sessions.push(session); return { core: { readNamespacedServiceAccount: fixture.read } };
} }));
vi.mock("@/lib/db/store", async original => {
  const actual = await original<typeof import("@/lib/db/store")>();
  return { ...actual,
    save: (projectId?: string) => {
      if (fixture.saveFailure || fixture.nextSaveFailure) { fixture.nextSaveFailure = false; throw new Error("Modeled product-save failure."); }
      actual.save(projectId);
    },
    flushPendingAsync: async () => {
      if (fixture.nextFlushFailure) { fixture.nextFlushFailure = false; throw new Error("Modeled product-flush failure."); }
      return actual.flushPendingAsync();
    },
  };
});
const { ctx, seed } = await import("./support");
const store = await import("@/lib/db/store");
const vault = await import("@/lib/secrets");
const { runAction } = await import("@/lib/actions/core");
const { openPlatformDb, repos } = await import("@/lib/controlplane/db");
const { setBridgeDepsForTests } = await import("@/lib/bridge/deps");
await import("@/lib/actions/defs");
const CANARY = "kube-link-model-credential-canary";
const input = { label: "Owning cluster", server: "https://cluster.example.test", caData: Buffer.from("modeled-public-ca").toString("base64"), namespaces: ["orders"], credentialRef: "vault:kube-link/KUBECONFIG", scopedGuest: false };
let owner: PlatformDbHandle;
const exec = async (action: string, value: unknown = input, actorId = ctx.actor.id, idempotencyKey?: string) => (await runAction(action, { ...ctx, actor: { ...ctx.actor, id: actorId } }, value, { mode: "execute", idempotencyKey })).result!;
async function preview(connectionId: string) {
  const output = await runAction("connection.verifyKubernetes", { ...ctx, actor: { ...ctx.actor, id: "editor" } }, { connectionId }, { mode: "plan" });
  if (!output.plan) throw new Error("Verification preview was not returned.");
  return output.plan;
}
function boundCredential() {
  return yamlDump({ apiVersion: "v1", kind: "Config", "current-context": "bound", clusters: [{ name: "cluster", cluster: { server: input.server, "certificate-authority-data": input.caData } }],
    contexts: [{ name: "bound", context: { cluster: "cluster", user: "reader" } }], users: [{ name: "reader", user: { token: CANARY } }] }, { noRefs: true });
}
beforeAll(async () => { owner = await openPlatformDb({ kind: "pglite" }); }, 60_000);
afterAll(async () => { await owner?.close(); });
beforeEach(() => {
  seed(); fixture.saveFailure = false; fixture.nextSaveFailure = false; fixture.nextFlushFailure = false; fixture.sessions.length = 0; vi.clearAllMocks();
  vi.stubEnv("ZENITH_STORE", "file"); vi.stubEnv("ZENITH_SECRET_KEY", "1".repeat(64));
  fixture.read.mockImplementation(async ({ name, namespace }) => ({ metadata: { name, namespace } }));
  setBridgeDepsForTests({ connectionSql: async () => owner });
});
afterEach(async () => { fixture.saveFailure = false; fixture.nextSaveFailure = false; fixture.nextFlushFailure = false; await vault.removeSecretAsync(ctx.workspaceId, input.credentialRef); vi.restoreAllMocks(); vi.unstubAllEnvs(); setBridgeDepsForTests(null); });

describe("human Kubernetes connection actions [PGlite; modeled namespace API]", () => {
  it("creates pending same-ID native and product records without resolving credentials or calling the cluster", async () => {
    const read = vi.spyOn(vault, "readSecretValueAsync");
    const result = await exec("connection.createKubernetes"); expect(result.ok).toBe(true);
    const data = result.data as { connectionId: string };
    expect(store.q.connection(data.connectionId)).toMatchObject({ id: data.connectionId, platformConnectionId: data.connectionId, provider: "kubernetes", status: "connecting" });
    expect(await repos.connections.get(owner, ctx.workspaceId, data.connectionId)).toMatchObject({ legacyConnectionId: data.connectionId, status: "pending_verification", config: { mode: "kubeconfig_ref", credentialRef: input.credentialRef } });
    expect(read).not.toHaveBeenCalled(); expect(fixture.read).not.toHaveBeenCalled();
  });
  it.each([{ server: "http://127.0.0.1:6443" }, { server: "https://metadata.google.internal" }, { server: "https://cluster.example.test?q=1" },
    { server: "https://cluster.example.test#fragment" }, { server: "https://name:private@cluster.example.test" }, { caData: "%%%" }, { caData: Buffer.from("-----BEGIN PRIVATE KEY-----").toString("base64") }, { namespaces: [] },
    { namespaces: ["orders", "orders"] }, { namespaces: ["Upper"] }, { credentialRef: "inline" }, { token: "CANARY" }, { kubeconfig: "CANARY" }, { mode: "runner" }])("strict input refuses %j before either store writes", async bad => {
    const before = await repos.connections.list(owner, ctx.workspaceId);
    const result = await exec("connection.createKubernetes", { ...input, ...bad });
    expect(result.ok).toBe(false); expect(result.summary).toBe("Invalid input.");
    expect(await repos.connections.list(owner, ctx.workspaceId)).toEqual(before); expect(store.db().connections).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("CANARY"); expect(fixture.read).not.toHaveBeenCalled();
  });
  it("refuses editor creation, viewer verification and missing-member demo fallback", async () => {
    expect((await exec("connection.createKubernetes", input, "editor")).ok).toBe(false);
    expect((await exec("connection.verifyKubernetes", { connectionId: "absent" }, "viewer")).ok).toBe(false);
    expect((await exec("connection.createKubernetes", input, "local")).ok).toBe(false);
    expect(fixture.read).not.toHaveBeenCalled();
  });
  it("refuses integration and Navigator contexts without widening their action bridge", async () => {
    for (const context of [{ ...ctx, integration: { operationId: "untrusted", clientId: "client", proposalDigest: "a".repeat(64) } }, { ...ctx, actor: { type: "navigator" as const, id: "admin-a", name: "Model" } }]) {
      expect((await runAction("connection.createKubernetes", context, input, { mode: "execute" })).result?.ok).toBe(false);
    }
    expect(fixture.read).not.toHaveBeenCalled(); expect(store.db().connections).toHaveLength(1);
  });
  it("reports an owning native ID and partial persistence when product save fails without deleting or retrying it", async () => {
    fixture.saveFailure = true;
    const before = await repos.connections.list(owner, ctx.workspaceId);
    const result = await exec("connection.createKubernetes", input, ctx.actor.id, "partial-native"); expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^persistence_unconfirmed:/);
    const data = result.data as { connectionId: string; persistence: string };
    expect(data.persistence).toBe("native_saved_product_unconfirmed");
    expect(await repos.connections.get(owner, ctx.workspaceId, data.connectionId)).toMatchObject({ status: "pending_verification", legacyConnectionId: data.connectionId });
    const retry = await exec("connection.createKubernetes", input, ctx.actor.id, "partial-native");
    expect(retry).toBe(result); fixture.saveFailure = false;
    expect(await exec("connection.createKubernetes", input, ctx.actor.id, "partial-native")).toBe(result);
    expect(await repos.connections.list(owner, ctx.workspaceId)).toHaveLength(before.length + 1);
    expect(fixture.read).not.toHaveBeenCalled();
  });
  it.each(["save", "flush"] as const)("inner native commit and product %s failure stays uncertain after outer persistence succeeds and TTL passes", async fault => {
    const before = await repos.connections.list(owner, ctx.workspaceId);
    if (fault === "save") fixture.nextSaveFailure = true; else fixture.nextFlushFailure = true;
    const result = await exec("connection.createKubernetes", input, ctx.actor.id, `inner-${fault}`);
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/^persistence_unconfirmed:/), data: { persistence: "native_saved_product_unconfirmed" } });
    expect(fixture.nextSaveFailure).toBe(false); expect(fixture.nextFlushFailure).toBe(false);
    await store.flushPendingAsync();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600_001);
    try { expect(await exec("connection.createKubernetes", input, ctx.actor.id, `inner-${fault}`)).toBe(result); }
    finally { clock.mockRestore(); }
    expect(await repos.connections.list(owner, ctx.workspaceId)).toHaveLength(before.length + 1);
    expect(fixture.read).not.toHaveBeenCalled();
  });
  it("unsupported FILE and PGlite topology refuses activation before any saved credential probe", async () => {
    const result = await exec("connection.createKubernetes"); const { connectionId } = result.data as { connectionId: string };
    await vault.putSecretAsync(ctx.workspaceId, input.credentialRef, boundCredential(), ctx.actor.id);
    const read = vi.spyOn(vault, "readSecretValueAsync");
    const verified = await exec("connection.verifyKubernetes", { connectionId }, "editor"); expect(verified.ok).toBe(false);
    expect(fixture.read).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
    expect(store.q.connection(connectionId)?.status).toBe("connecting"); expect((await repos.connections.get(owner, ctx.workspaceId, connectionId))?.status).toBe("pending_verification");
    expect(JSON.stringify({ verified, connection: store.q.connection(connectionId), events: await repos.events.list(owner, ctx.workspaceId), audit: store.readAudit() })).not.toContain(CANARY);
  });
  it("verification preview blocks unsupported FILE and PGlite without credential, cluster or metadata effects", async () => {
    const created = await exec("connection.createKubernetes"); const { connectionId } = created.data as { connectionId: string };
    await vault.putSecretAsync(ctx.workspaceId, input.credentialRef, boundCredential(), ctx.actor.id);
    const read = vi.spyOn(vault, "readSecretValueAsync");
    const native = await repos.connections.list(owner, ctx.workspaceId), product = structuredClone(store.db().connections);
    const events = await repos.events.list(owner, ctx.workspaceId), audit = structuredClone(store.readAudit());
    const planned = await preview(connectionId);
    expect(planned.blocked).toBe("Kubernetes verification is unavailable for the current workspace connection.");
    expect(await repos.connections.list(owner, ctx.workspaceId)).toEqual(native); expect(store.db().connections).toEqual(product);
    expect(await repos.events.list(owner, ctx.workspaceId)).toEqual(events); expect(store.readAudit()).toEqual(audit);
    expect(read).not.toHaveBeenCalled(); expect(fixture.read).not.toHaveBeenCalled(); expect(fixture.sessions).toHaveLength(0);
    expect(JSON.stringify(planned)).not.toContain(CANARY);
  });
  it.each(["missing product", "foreign product", "wrong provider", "wrong link"] as const)("verification preview blocks %s without credential, cluster or metadata effects", async fault => {
    const created = await exec("connection.createKubernetes"); const { connectionId } = created.data as { connectionId: string };
    const connection = store.q.connection(connectionId)!;
    if (fault === "foreign product") connection.workspaceId = "foreign";
    else if (fault === "wrong provider") connection.provider = "aws";
    else if (fault === "wrong link") connection.platformConnectionId = "foreign";
    const read = vi.spyOn(vault, "readSecretValueAsync");
    const native = await repos.connections.list(owner, ctx.workspaceId), product = structuredClone(store.db().connections);
    const events = await repos.events.list(owner, ctx.workspaceId), audit = structuredClone(store.readAudit());
    const planned = await preview(fault === "missing product" ? "missing-preview-input" : connectionId);
    expect(planned.blocked).toBe("Kubernetes verification is unavailable for the current workspace connection.");
    expect(await repos.connections.list(owner, ctx.workspaceId)).toEqual(native); expect(store.db().connections).toEqual(product);
    expect(await repos.events.list(owner, ctx.workspaceId)).toEqual(events); expect(store.readAudit()).toEqual(audit);
    expect(read).not.toHaveBeenCalled(); expect(fixture.read).not.toHaveBeenCalled(); expect(fixture.sessions).toHaveLength(0);
    expect(JSON.stringify(planned)).not.toContain(CANARY);
  });
  it("missing, foreign and revoked native links never read another credential or activate", async () => {
    const result = await exec("connection.createKubernetes"); const { connectionId } = result.data as { connectionId: string };
    const connection = store.q.connection(connectionId)!;
    connection.platformConnectionId = "foreign";
    expect((await exec("connection.verifyKubernetes", { connectionId }, "editor")).ok).toBe(false);
    connection.platformConnectionId = connectionId; await repos.connections.revoke(owner, ctx.workspaceId, connectionId);
    expect((await exec("connection.verifyKubernetes", { connectionId }, "editor")).ok).toBe(false);
    expect(fixture.read).not.toHaveBeenCalled(); expect(connection.status).toBe("connecting");
    expect((await exec("connection.verifyKubernetes", { connectionId: "missing" }, "editor")).ok).toBe(false);
  });
});
