/**
 * PROD-MACH-02 re-baseline: the positive guest cases use scoped_guest connections (namespaced minter +
 * per-dispatch TokenRequest). Real scoped PGlite repositories, encrypted tenant vault, platform broker,
 * machine provider and signed/verified fixture grants; ONLY the Kubernetes API (guest cluster port) is a
 * model here, and the real API is covered by kubernetes-guest-scoped-kind.test.ts. A legacy kubeconfig_ref
 * connection must be refused for guests. No live identity or browser/policy authority is modeled as accepted here. Credential issuance is
 * an upstream boundary; these fixtures sign explicit claims without minting a
 * product role or substituting a machine-session resolver.
 */
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { dump as yamlDump } from "js-yaml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import type { CredentialBroker, KubernetesConnectionConfig, ProviderConnection, ProviderSession } from "@/lib/credentials/types";
import type { KubernetesMachineSession, MachineOperation, MachineSessionRequest } from "@/lib/machines/types";
import { tempDataDir } from "../_support/data-dir";
import type { GuestClusterPort } from "@/lib/providers/kubernetes/guest";
import { T0, grantFor, requestFor } from "./_helpers";

const model = vi.hoisted(() => ({ current: undefined as undefined | { port: unknown } }));
vi.mock("@/lib/providers/kubernetes/guest", async (original) => ({
  ...(await original<typeof import("@/lib/providers/kubernetes/guest")>()),
  createGuestClusterPort: () => { if (!model.current) throw new Error("no modeled cluster"); return model.current.port; },
}));
const modelJwt = (claims: Record<string, unknown>) => { const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url"); return `${part({ alg: "RS256" })}.${part(claims)}.${Buffer.from("sig-bytes").toString("base64url")}`; };
/** Modeled Kubernetes API boundary: records calls; a namespaced minter holds exactly the needed rights. */
function modeledCluster() {
  const calls: string[] = [];
  const port: GuestClusterPort = {
    async allowed(a) { return !!a.namespace && a.namespace !== "kube-system" && a.verb !== "*"; },
    async ensureServiceAccount(ns, name) { calls.push(`sa:${ns}:${name}`); return { uid: `uid-${name}` }; },
    async ensureRole(ns, name) { calls.push(`role:${ns}:${name}`); },
    async ensureRoleBinding(ns, name) { calls.push(`rb:${ns}:${name}`); },
    async requestToken(ns, name, uid, aud, ttl) {
      calls.push(`token:${ns}:${name}`);
      return { token: modelJwt({ sub: `system:serviceaccount:${ns}:${name}`, aud: aud.length ? aud : ["modeled-audience"], exp: Math.floor(T0 / 1000) + ttl, "kubernetes.io": { serviceaccount: { uid } } }), expiresAt: new Date(T0 + ttl * 1000).toISOString() };
    },
    async deleteGuestObjects() { calls.push("delete"); },
  };
  model.current = { port };
  return { calls };
}

tempDataDir("zenith-default-kubernetes-guest-", { fast: true });
const { openPlatformDb, repos } = await import("@/lib/controlplane/db");
const { platformCredentialBroker } = await import("@/lib/platform/credentials");
const { createMachineSessionProvider } = await import("@/lib/machines/sessions");
const { generateSigningJwk, LocalJwkSigner } = await import("@/lib/credentials/signing");
const { signCapabilityGrant, verifyCapabilityGrant } = await import("@/lib/credentials/grants");
const vault = await import("@/lib/secrets");
const { KubeConfig } = await import("@kubernetes/client-node");
const { createKubernetesMachineDriver } = await import("@/lib/machines/transports/kubernetes");
let db: Awaited<ReturnType<typeof openPlatformDb>>;
let key: Awaited<ReturnType<typeof generateSigningJwk>>;
let signer: ReturnType<typeof LocalJwkSigner.fromJwk>;
// Synthetic public CA bytes bind this modeled target; they are not a TLS identity proof.
const MODEL_CA = Buffer.from("modeled-public-kubernetes-ca").toString("base64");
function boundKubeconfig(server: string, caData: string, token: string): string {
  return yamlDump({ apiVersion: "v1", kind: "Config", "current-context": "bound",
    clusters: [{ name: "bound-cluster", cluster: { server, "certificate-authority-data": caData } }],
    contexts: [{ name: "bound", context: { cluster: "bound-cluster", user: "bound-user" } }],
    users: [{ name: "bound-user", user: { token } }] }, { noRefs: true });
}
const TOKEN_CANARY = "guest-kubernetes-credential-canary";

beforeAll(async () => {
  db = await openPlatformDb({ kind: "pglite" });
  key = await generateSigningJwk("EdDSA");
  signer = LocalJwkSigner.fromJwk("guest-fixture", key.privateJwk, { alg: "EdDSA" });
});
let cluster: ReturnType<typeof modeledCluster>;
beforeEach(() => { vi.stubEnv("ZENITH_SECRET_KEY", "1".repeat(64)); cluster = modeledCluster(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); model.current = undefined; });
afterAll(async () => { await db.close(); });
function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

async function fixture(operation: MachineOperation = "container.list", mode: KubernetesConnectionConfig["mode"] = "scoped_guest") {
  const suffix = randomUUID(), workspaceId = `ws-guest-${suffix}`, operationId = `op-guest-${suffix}`;
  const environmentId = `env-guest-${suffix}`, resourceId = `res-guest-${suffix}`;
  const credentialRef = `vault:guest/${suffix}/KUBE_TOKEN`;
  const config: KubernetesConnectionConfig = { provider: "kubernetes", mode, server: "https://cluster.example.test", caData: MODEL_CA, credentialRef, namespaces: ["app", "old"] };
  const created = await repos.connections.create(db, { workspaceId, config, createdBy: "guest-fixture" });
  await repos.connections.recordVerification(db, { workspaceId, id: created.id, ok: true, detail: "Fixture verification only; no cluster identity read." });
  const connection = (await repos.connections.get(db, workspaceId, created.id))!;
  await vault.putSecretAsync(workspaceId, credentialRef, boundKubeconfig(config.server, MODEL_CA, TOKEN_CANARY), "guest-fixture");
  let currentTime = T0;
  const now = () => new Date(currentTime);
  const unsigned = grantFor(operation, { ws: workspaceId, op: operationId, env: environmentId, res: resourceId });
  const jws = await signCapabilityGrant(unsigned, { signer });
  const grant = await verifyCapabilityGrant(jws, { audience: "worker", expectedCapability: operation, expectedOperationId: operationId, now: now(), keys: [key.publicJwk] });
  const target = requestFor(operation, {}, { transport: "kubernetes", targetId: "app/pod-1", operationId,
    target: { workspaceId, environmentId, resourceId, address: "compute_instance/guest", transport: "kubernetes", targetId: "app/pod-1" } }).target;
  const request: MachineSessionRequest = { target, operation, operationId, grant };
  const credentials = platformCredentialBroker(db, { now });
  const provider = (signal?: AbortSignal, captured: ProviderConnection | undefined = connection, broker: CredentialBroker = credentials) =>
    createMachineSessionProvider({ credentials: broker, connection: captured, grantJws: jws, signal, now });
  return { workspaceId, credentialRef, connection, config, request, credentials, provider, now, jws,
    advance: (ms: number) => { currentTime += ms; } };
}
async function assertSafe(f: Awaited<ReturnType<typeof fixture>>, value: unknown) {
  expect(JSON.stringify(value)).not.toContain(TOKEN_CANARY);
  expect(inspect(value)).not.toContain(TOKEN_CANARY);
  expect(JSON.stringify(await repos.events.list(db, f.workspaceId))).not.toContain(TOKEN_CANARY);
  expect(JSON.stringify(await repos.connections.list(db, f.workspaceId))).not.toContain(TOKEN_CANARY);
}

describe("default Kubernetes guest session", () => {
  it.each([["container.list", "observe"], ["container.exec", "deploy"]] as const)("%s enters the canonical broker with %s purpose and signed verified claims", async (operation, purpose) => {
    const f = await fixture(operation), broker = vi.spyOn(f.credentials, "withSession");
    const secretRead = vi.spyOn(vault, "readSecretValueAsync");
    let held!: KubernetesMachineSession;
    expect(await f.provider().withSession(f.request, async value => {
      held = value as KubernetesMachineSession;
      const credentialObject = held.kubeConfig();
      expect(credentialObject).toBeInstanceOf(KubeConfig);
      expect((credentialObject as InstanceType<typeof KubeConfig>).getCurrentCluster()?.server).toBe(f.config.server);
      // Scoped guest: exactly the target namespace, never the connection's whole allowlist.
      expect(held.namespaces).toEqual(["app"]);
      expect((credentialObject as InstanceType<typeof KubeConfig>).getCurrentUser()?.token).not.toBe(TOKEN_CANARY);
      expect(Object.isFrozen(held)).toBe(true); expect(Object.isFrozen(held.namespaces)).toBe(true);
      expect(Date.parse(held.expiresAt)).toBe(f.request.grant.exp * 1000);
      await assertSafe(f, held);
      return { admitted: true };
    })).toEqual({ admitted: true });
    expect(broker).toHaveBeenCalledOnce();
    expect(broker.mock.calls[0][0]).toEqual({ connectionId: f.connection.id, purpose, grant: f.request.grant, kubernetesGuest: { namespace: "app", profile: operation === "container.list" ? "read" : "exec" } });
    expect(cluster.calls.filter(c => c.startsWith("token:"))).toHaveLength(1);
    expect(secretRead.mock.calls).toEqual([[f.workspaceId, f.credentialRef]]);
    expect(() => held.kubeConfig()).toThrow(/ended/);
    const events = await repos.events.list(db, f.workspaceId);
    expect(events).toEqual([expect.objectContaining({ workspaceId: f.workspaceId, type: "credential.assumed" })]);
    await assertSafe(f, events);
  });
  it("a narrower live SQL connection replaces the captured namespace list without widening it", async () => {
    const f = await fixture();
    await db.query("update platform.provider_connections set config=$3::text::jsonb where workspace_id=$1 and id=$2",
      [f.workspaceId, f.connection.id, JSON.stringify({ ...f.config, namespaces: ["app"] })]);
    expect(f.connection.config).toMatchObject({ namespaces: ["app", "old"] });
    const clients = vi.fn(async () => { throw new Error("Namespace refusal must precede client creation."); });
    const driver = createKubernetesMachineDriver({ clientFactory: clients });
    await f.provider().withSession(f.request, async value => {
      const session = value as KubernetesMachineSession;
      expect(session.namespaces).toEqual(["app"]);
      expect(() => (session.namespaces as string[]).push("old")).toThrow();
      expect(session.kubeConfig()).toBeInstanceOf(KubeConfig);
      const staleTarget = requestFor("container.list", {}, { transport: "kubernetes", targetId: "old/pod-1" });
      await expect(driver.execute(staleTarget, session, new AbortController().signal)).rejects.toMatchObject({ code: "denied" });
      expect(clients).not.toHaveBeenCalled();
    });
  });
  it("an empty live namespace list permits no machine request, mints nothing and cannot fall back to old scope", async () => {
    const f = await fixture();
    await db.query("update platform.provider_connections set config=$3::text::jsonb where workspace_id=$1 and id=$2",
      [f.workspaceId, f.connection.id, JSON.stringify({ ...f.config, namespaces: [] })]);
    const clients = vi.fn(async () => { throw new Error("Empty scope must precede client creation."); });
    const callback = vi.fn(async () => undefined);
    await expect(f.provider().withSession(f.request, callback)).rejects.toMatchObject({ code: "denied" });
    expect(callback).not.toHaveBeenCalled(); expect(clients).not.toHaveBeenCalled();
    expect(cluster.calls.some(c => c.startsWith("token:") || c.startsWith("sa:"))).toBe(false);
    const driver = createKubernetesMachineDriver({ clientFactory: clients });
    // Even a handle shaped like the old scope cannot be obtained: the driver refuses an empty allowlist outright.
    await expect(driver.execute(requestFor("container.list", {}, { transport: "kubernetes", targetId: "app/pod-1" }),
      { provider: "kubernetes", server: f.config.server, expiresAt: new Date(T0 + 60_000).toISOString(), namespaces: [], kubeConfig: () => ({}) } as unknown as KubernetesMachineSession, new AbortController().signal))
      .rejects.toMatchObject({ code: "denied" });
    expect(clients).not.toHaveBeenCalled();
  });
  it("a legacy kubeconfig_ref connection is refused for guest sessions with migration guidance and never reads its vault credential", async () => {
    const f = await fixture("container.list", "kubeconfig_ref"), broker = vi.spyOn(f.credentials, "withSession"), read = vi.spyOn(vault, "readSecretValueAsync");
    const callback = vi.fn(async () => undefined);
    const error = await f.provider().withSession(f.request, callback).then(() => undefined, (e: unknown) => e) as Error & { code?: string };
    expect(error.code).toBe("denied");
    expect(error.message).toMatch(/guest_credential_refused.*convertToScopedGuest/);
    expect(callback).not.toHaveBeenCalled(); expect(broker).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
    expect(cluster.calls).toEqual([]);
    await assertSafe(f, error);
  });
  it.each(["absent", "foreign", "revoked", "wrong provider"] as const)("refuses a captured %s connection before any broker or vault read", async mode => {
    const f = await fixture(), broker = vi.spyOn(f.credentials, "withSession"), secretRead = vi.spyOn(vault, "readSecretValueAsync");
    const connection: ProviderConnection | undefined = mode === "absent" ? undefined : mode === "foreign" ? { ...f.connection, workspaceId: "foreign" }
      : mode === "revoked" ? { ...f.connection, status: "revoked" } : { ...f.connection, config: { provider: "aws", mode: "runner", accountId: "123456789012", region: "us-east-1", observeRoleArn: "arn:aws:iam::123456789012:role/observe", deployRoleArn: "arn:aws:iam::123456789012:role/deploy" } };
    const callback = vi.fn(async () => undefined);
    const provider = connection === undefined
      ? createMachineSessionProvider({ credentials: f.credentials, grantJws: f.jws, now: f.now }) : f.provider(undefined, connection);
    await expect(provider.withSession(f.request, callback)).rejects.toMatchObject({ code: "denied" });
    expect(callback).not.toHaveBeenCalled(); expect(broker).not.toHaveBeenCalled(); expect(secretRead).not.toHaveBeenCalled();
  });
  it("a live SQL revocation refuses a stale verified capture before resolving its vault credential", async () => {
    const f = await fixture(), read = vi.spyOn(vault, "readSecretValueAsync");
    await repos.connections.revoke(db, f.workspaceId, f.connection.id);
    expect(f.connection.status).toBe("verified");
    const callback = vi.fn(async () => undefined);
    await expect(f.provider().withSession(f.request, callback)).rejects.toMatchObject({ code: "denied" });
    expect(callback).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
    expect((await repos.events.list(db, f.workspaceId)).some(event => event.type === "credential.assumed")).toBe(false);
  });
  it("a same-named vault secret in another workspace never supplies the missing owning credential", async () => {
    const f = await fixture(), missing = `vault:guest/${randomUUID()}/FOREIGN_ONLY`;
    await vault.putSecretAsync("ws-foreign-guest", missing, boundKubeconfig(f.config.server, MODEL_CA, TOKEN_CANARY), "foreign-fixture");
    await db.query("update platform.provider_connections set config=$3::text::jsonb where workspace_id=$1 and id=$2",
      [f.workspaceId, f.connection.id, JSON.stringify({ ...f.config, credentialRef: missing })]);
    const read = vi.spyOn(vault, "readSecretValueAsync"), callback = vi.fn(async () => undefined);
    await expect(f.provider().withSession(f.request, callback)).rejects.toMatchObject({ code: "denied" });
    expect(read.mock.calls).toEqual([[f.workspaceId, missing]]); expect(callback).not.toHaveBeenCalled();
    await assertSafe(f, await repos.events.list(db, f.workspaceId));
  });
  it.each(["ws", "op", "cap", "env", "res"] as const)("refuses a grant's foreign %s binding before broker access", async field => {
    const f = await fixture(), broker = vi.spyOn(f.credentials, "withSession"), callback = vi.fn(async () => undefined);
    const grant: CapabilityGrantClaims = { ...f.request.grant, [field]: "foreign-binding" };
    await expect(f.provider().withSession({ ...f.request, grant }, callback)).rejects.toMatchObject({ code: "grant_mismatch" });
    expect(broker).not.toHaveBeenCalled(); expect(callback).not.toHaveBeenCalled();
  });
  it("an already expired or aborted request never opens broker credentials and never echoes abort reasons", async () => {
    const f = await fixture(), broker = vi.spyOn(f.credentials, "withSession"), callback = vi.fn(async () => undefined);
    f.advance(300_000);
    await expect(f.provider().withSession(f.request, callback)).rejects.toMatchObject({ code: "grant_expired" });
    const fresh = await fixture(), signal = new AbortController(), freshBroker = vi.spyOn(fresh.credentials, "withSession"); signal.abort(new Error(TOKEN_CANARY));
    const error = await fresh.provider(signal.signal).withSession(fresh.request, callback).catch(value => value);
    expect(error).toMatchObject({ code: "aborted" }); await assertSafe(fresh, error);
    expect(broker).not.toHaveBeenCalled(); expect(freshBroker).not.toHaveBeenCalled(); expect(callback).not.toHaveBeenCalled();
  });
  it.each(["abort", "expire"] as const)("a late vault answer after %s cannot enter the machine callback", async mode => {
    const f = await fixture(), entered = barrier(), release = barrier(), signal = new AbortController();
    const original = vault.readSecretValueAsync;
    vi.spyOn(vault, "readSecretValueAsync").mockImplementation(async (...args) => {
      const secret = await original(...args); entered.release(); await release.promise; return secret;
    });
    const callback = vi.fn(async () => undefined);
    const outcome = f.provider(signal.signal).withSession(f.request, callback).then(value => ({ value }), error => ({ error }));
    let observationFailure: unknown;
    try {
      await Promise.race([entered.promise, outcome.then(() => { throw new Error("Session completed before the vault barrier."); })]);
      if (mode === "abort") signal.abort(new Error(TOKEN_CANARY)); else f.advance(300_000);
    } catch (error) { observationFailure = error; }
    finally { release.release(); }
    const completed = await outcome;
    if (observationFailure) throw observationFailure;
    expect(completed).toHaveProperty("error"); expect(callback).not.toHaveBeenCalled(); await assertSafe(f, completed);
  });
  it("the wrapper denies credentials on abort, grant expiry and callback failure", async () => {
    for (const mode of ["abort", "expire", "callback failure"] as const) {
      const f = await fixture(), signal = new AbortController(); let held!: KubernetesMachineSession;
      const outcome = f.provider(signal.signal).withSession(f.request, async value => {
        held = value as KubernetesMachineSession; expect(held.kubeConfig()).toBeInstanceOf(KubeConfig);
        if (mode === "abort") signal.abort(new Error(TOKEN_CANARY));
        if (mode === "expire") f.advance(300_000);
        if (mode !== "callback failure") expect(() => held.kubeConfig()).toThrow();
        throw new Error("Fixed callback failure.");
      });
      await expect(outcome).rejects.toThrow("Fixed callback failure.");
      expect(() => held.kubeConfig()).toThrow(); await assertSafe(f, held);
    }
  });
  it.each(["wrong provider", "missing namespaces", "wildcard namespace", "malformed expiry", "expired session", "unsafe server"] as const)("refuses a modeled broker's %s session without reconstructing from the captured connection", async mode => {
    const f = await fixture();
    const session = { provider: "kubernetes", server: f.config.server, expiresAt: new Date(T0 + 600_000).toISOString(), namespaces: ["app"], kubeConfig: () => ({}) };
    const malformed = mode === "wrong provider" ? { ...session, provider: "aws" } : mode === "missing namespaces" ? { ...session, namespaces: undefined }
      : mode === "wildcard namespace" ? { ...session, namespaces: ["*"] } : mode === "malformed expiry" ? { ...session, expiresAt: "invalid" }
      : mode === "expired session" ? { ...session, expiresAt: new Date(T0).toISOString() } : { ...session, server: "https://169.254.169.254" };
    // This explicit malformed-port model tests adapter refusal only. All other
    // default-path cases above use the actual SQL/vault/platform broker.
    const broker: CredentialBroker = { verifyConnection: async () => ({ ok: false, detail: "model" }),
      withSession: async (_request, callback) => callback(malformed as unknown as ProviderSession) };
    const callback = vi.fn(async () => undefined);
    await expect(f.provider(undefined, f.connection, broker).withSession(f.request, callback)).rejects.toMatchObject({ code: "denied" });
    expect(callback).not.toHaveBeenCalled();
  });
  it("an unscoped resource grant and a callback returning after grant expiry both refuse", async () => {
    const f = await fixture(), broker = vi.spyOn(f.credentials, "withSession"), callback = vi.fn(async () => undefined);
    const { res: _resource, ...grant } = f.request.grant;
    await expect(f.provider().withSession({ ...f.request, grant }, callback)).rejects.toMatchObject({ code: "grant_mismatch" });
    expect(broker).not.toHaveBeenCalled(); expect(callback).not.toHaveBeenCalled();
    let held!: KubernetesMachineSession;
    await expect(f.provider().withSession(f.request, async value => {
      held = value as KubernetesMachineSession; f.advance(300_000); return "expired callback result";
    })).rejects.toMatchObject({ code: "denied" });
    expect(() => held.kubeConfig()).toThrow(/ended/);
  });
  it("a provider exception before callback cannot carry credential bytes into errors", async () => {
    const f = await fixture(), callback = vi.fn(async () => undefined);
    const broker: CredentialBroker = { verifyConnection: async () => ({ ok: false, detail: "model" }),
      withSession: async () => { throw new Error(TOKEN_CANARY); } };
    const error = await f.provider(undefined, f.connection, broker).withSession(f.request, callback).catch(value => value);
    expect(error).toMatchObject({ code: "denied" }); expect(callback).not.toHaveBeenCalled(); await assertSafe(f, error);
  });
});
