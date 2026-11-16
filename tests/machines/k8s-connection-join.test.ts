/**
 * PROD-K8S-CONN contract tests: ONE scoped_guest Kubernetes connection serves guests (minter) AND deploy/observe
 * (separate deployer credential), with separated privileges. Real stack: PGlite repositories, encrypted tenant
 * vault, platform credential broker, machine session provider, rotation patch rules. ONLY the Kubernetes API
 * boundary is modeled (an in-memory SelfSubjectAccessReview port keyed by WHICH credential presented it). Not cluster
 * evidence; the real API server is covered by tests/machines/kubernetes-connection-join-kind.test.ts.
 */
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { dump as yamlDump } from "js-yaml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { KubernetesConnectionConfig, ProviderConnection } from "@/lib/credentials/types";
import type { AccessAttributes, GuestClusterPort } from "@/lib/providers/kubernetes/guest";
import type { KubernetesMachineSession, MachineOperation, MachineSessionRequest } from "@/lib/machines/types";
import { tempDataDir } from "../_support/data-dir";
import { T0, grantFor, requestFor } from "./_helpers";

const model = vi.hoisted(() => ({ current: undefined as undefined | { port: (token: string) => unknown } }));
vi.mock("@/lib/providers/kubernetes/guest", async (original) => ({
  ...(await original<typeof import("@/lib/providers/kubernetes/guest")>()),
  // The modeled cluster decides by the credential presented: minter token vs deployer token.
  createGuestClusterPort: (session: { kubeConfig(): { getCurrentUser(): { token?: string } | null } }) => {
    if (!model.current) throw new Error("no modeled cluster");
    return model.current.port(session.kubeConfig().getCurrentUser()?.token ?? "");
  },
}));

tempDataDir("zenith-k8s-join-", { fast: true });
const { openPlatformDb, repos } = await import("@/lib/controlplane/db");
const { platformCredentialBroker, revokeKubernetesGuestBindings } = await import("@/lib/platform/credentials");
const { createMachineSessionProvider } = await import("@/lib/machines/sessions");
const { generateSigningJwk, LocalJwkSigner } = await import("@/lib/credentials/signing");
const { signCapabilityGrant, verifyCapabilityGrant } = await import("@/lib/credentials/grants");
const { guestObjectName } = await import("@/lib/providers/kubernetes/guest");
const { verifyDeployerCredential, DeployerCredentialError } = await import("@/lib/providers/kubernetes/deployer");
const { applyRotationPatch, LifecycleInputError } = await import("@/lib/connections/schemas");
const vault = await import("@/lib/secrets");
type KubeConfig = import("@kubernetes/client-node").KubeConfig;

let db: Awaited<ReturnType<typeof openPlatformDb>>;
let key: Awaited<ReturnType<typeof generateSigningJwk>>;
let signer: ReturnType<typeof LocalJwkSigner.fromJwk>;
const MODEL_CA = Buffer.from("modeled-public-kubernetes-ca").toString("base64");
// Built at runtime: distinct credential values for the two roles.
const MINTER_TOKEN = `minter-${randomUUID()}`;
const DEPLOYER_TOKEN = `deployer-${randomUUID()}`;
const boundKubeconfig = (server: string, token: string) => yamlDump({ apiVersion: "v1", kind: "Config", "current-context": "bound",
  clusters: [{ name: "bound-cluster", cluster: { server, "certificate-authority-data": MODEL_CA } }],
  contexts: [{ name: "bound", context: { cluster: "bound-cluster", user: "bound-user" } }], users: [{ name: "bound-user", user: { token } }] }, { noRefs: true });
const jwt = (claims: Record<string, unknown>) => { const p = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url"); return `${p({ alg: "RS256" })}.${p(claims)}.${Buffer.from("sig-bytes").toString("base64url")}`; };

/** RBAC defaults: both roles hold namespaced verbs only (every probe with a non-system namespace), nothing cluster-wide. */
const namespacedOnly = (a: AccessAttributes) => !!a.namespace && a.namespace !== "kube-system" && a.verb !== "*";

function modeledCluster(over: { minter?: (a: AccessAttributes) => boolean; deployer?: (a: AccessAttributes) => boolean; failDelete?: boolean } = {}) {
  const calls: string[] = [];
  const portFor = (token: string): GuestClusterPort => {
    const isDeployer = token === DEPLOYER_TOKEN;
    const allow = isDeployer ? (over.deployer ?? namespacedOnly) : (over.minter ?? namespacedOnly);
    return {
      async allowed(a) { calls.push(`allowed:${isDeployer ? "deployer" : "minter"}`); return allow(a); },
      async ensureServiceAccount(ns, name) { calls.push(`sa:${ns}:${name}`); return { uid: `uid-${name}` }; },
      async ensureRole(ns, name) { calls.push(`role:${ns}:${name}`); },
      async ensureRoleBinding(ns, name) { calls.push(`rb:${ns}:${name}`); },
      async requestToken(ns, name, uid, aud, ttl) {
        calls.push(`token:${ns}:${name}`);
        return { token: jwt({ sub: `system:serviceaccount:${ns}:${name}`, aud: aud.length ? aud : ["modeled-audience"], exp: Math.floor(T0 / 1000) + ttl, "kubernetes.io": { serviceaccount: { uid } } }), expiresAt: new Date(T0 + ttl * 1000).toISOString() };
      },
      async deleteGuestObjects(ns, name) { calls.push(`delete:${ns}:${name}`); if (over.failDelete) throw new Error("modeled delete failure"); },
    };
  };
  model.current = { port: portFor };
  return { calls };
}

beforeAll(async () => {
  db = await openPlatformDb({ kind: "pglite" });
  key = await generateSigningJwk("EdDSA");
  signer = LocalJwkSigner.fromJwk("k8s-join-fixture", key.privateJwk, { alg: "EdDSA" });
});
beforeEach(() => { vi.stubEnv("ZENITH_SECRET_KEY", "1".repeat(64)); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); model.current = undefined; });
afterAll(async () => { await db.close(); });

interface Options { operation?: MachineOperation; targetId?: string; deployer?: false | "namespaced" | "cluster"; deployerValue?: string | null; withVault?: boolean }
async function fixture(options: Options = {}) {
  const { operation = "container.list", targetId = "app/pod-1", deployer = "namespaced" } = options;
  const suffix = randomUUID(), workspaceId = `ws-join-${suffix}`, operationId = `op-join-${suffix}`, environmentId = `env-join-${suffix}`, resourceId = `res-join-${suffix}`;
  const credentialRef = `vault:minter/${suffix}/KUBE_TOKEN`, deployerRef = `vault:deployer/${suffix}/KUBE_TOKEN`;
  const config: KubernetesConnectionConfig = { provider: "kubernetes", mode: "scoped_guest", server: "https://cluster.example.test", caData: MODEL_CA, credentialRef, namespaces: ["app", "other"],
    ...(deployer ? { deployerCredentialRef: deployerRef, deployerScope: deployer } : {}) };
  const created = await repos.connections.create(db, { workspaceId, config, createdBy: "k8s-join-fixture" });
  await repos.connections.recordVerification(db, { workspaceId, id: created.id, ok: true, detail: "fixture" });
  const connection = (await repos.connections.get(db, workspaceId, created.id))!;
  await vault.putSecretAsync(workspaceId, credentialRef, boundKubeconfig(config.server, MINTER_TOKEN), "k8s-join-fixture");
  if (deployer && options.deployerValue !== null) await vault.putSecretAsync(workspaceId, deployerRef, boundKubeconfig(config.server, options.deployerValue ?? DEPLOYER_TOKEN), "k8s-join-fixture");
  const now = () => new Date(T0);
  const jws = await signCapabilityGrant(grantFor(operation, { ws: workspaceId, op: operationId, env: environmentId, res: resourceId }), { signer });
  const grant = await verifyCapabilityGrant(jws, { audience: "worker", expectedCapability: operation, expectedOperationId: operationId, now: now(), keys: [key.publicJwk] });
  const target = requestFor(operation, {}, { transport: "kubernetes", targetId, operationId,
    target: { workspaceId, environmentId, resourceId, address: "compute_instance/guest", transport: "kubernetes", targetId } }).target;
  const request: MachineSessionRequest = { target, operation, operationId, grant };
  const credentials = platformCredentialBroker(db, { now });
  const provider = (captured: ProviderConnection = connection) => createMachineSessionProvider({ credentials, connection: captured, grantJws: jws, now });
  return { workspaceId, connection, config, credentialRef, deployerRef, request, credentials, provider, now, grant };
}
const tokenOf = (session: unknown) => ((session as KubernetesMachineSession).kubeConfig() as KubeConfig).getCurrentUser()?.token ?? "";
const bindings = (f: { workspaceId: string; connection: ProviderConnection }) => repos.k8sGuestBindings.listForConnection(db, f.workspaceId, f.connection.id);
const safe = (value: unknown) => { for (const secret of [MINTER_TOKEN, DEPLOYER_TOKEN]) { expect(JSON.stringify(value)).not.toContain(secret); expect(inspect(value)).not.toContain(secret); } };

describe("one scoped_guest connection serves deploy/observe through the deployer and guests through the minter", () => {
  it("observe and deploy get the DEPLOYER credential bound to the connection allowlist; the minter is never read", async () => {
    const reads = vi.spyOn(vault, "readSecretValueAsync");
    const f = await fixture({ operation: "container.exec" }), cluster = modeledCluster();
    await f.credentials.withSession({ connectionId: f.connection.id, grant: f.request.grant, purpose: "deploy" }, async (session) => {
      expect(session.provider).toBe("kubernetes");
      expect((session as KubernetesMachineSession).namespaces).toEqual(["app", "other"]);
      expect(tokenOf(session)).toBe(DEPLOYER_TOKEN);
    });
    const observe = await fixture({ operation: "container.list" });
    await observe.credentials.withSession({ connectionId: observe.connection.id, grant: observe.request.grant, purpose: "observe" }, async (session) => { expect(tokenOf(session)).toBe(DEPLOYER_TOKEN); });
    expect(reads.mock.calls.map((c) => c[1])).toEqual([f.deployerRef, observe.deployerRef]);
    expect(cluster.calls).toEqual([]);
    expect(await bindings(f)).toEqual([]);
  });

  it("a guest session of the SAME connection mints a namespace-scoped guest token and never reads or uses the deployer", async () => {
    const reads = vi.spyOn(vault, "readSecretValueAsync");
    const f = await fixture({ operation: "container.exec" }), cluster = modeledCluster();
    await f.provider().withSession(f.request, async (held) => {
      expect((held as KubernetesMachineSession).namespaces).toEqual(["app"]);
      const token = tokenOf(held);
      expect(token).not.toBe(MINTER_TOKEN);
      expect(token).not.toBe(DEPLOYER_TOKEN);
      expect(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub).toBe(`system:serviceaccount:app:${guestObjectName(f.workspaceId, f.connection.id, "exec")}`);
      safe(held);
    });
    expect(reads.mock.calls.map((c) => c[1])).toEqual([f.credentialRef]);
    expect(cluster.calls.every((c) => !c.startsWith("allowed:deployer"))).toBe(true);
    expect((await bindings(f))[0]).toMatchObject({ namespace: "app", profile: "exec", status: "active" });
  });

  it("no deployer part: deploy and observe are refused with deployer_credential_refused, and the minter is never used instead", async () => {
    const reads = vi.spyOn(vault, "readSecretValueAsync");
    const f = await fixture({ deployer: false }), cluster = modeledCluster();
    await expect(f.credentials.withSession({ connectionId: f.connection.id, grant: f.request.grant, purpose: "observe" }, async () => "entered"))
      .rejects.toMatchObject({ name: "CredentialDeniedError", reason: "deployer_credential_refused" });
    expect(reads).not.toHaveBeenCalled();
    expect(cluster.calls).toEqual([]);
    const denied = (await repos.events.list(db, f.workspaceId)).filter((e) => e.type === "credential.denied");
    expect(denied).toEqual([expect.objectContaining({ data: expect.objectContaining({ reason: "deployer_credential_refused" }) })]);
    // Guests of the same guest-only connection still work.
    modeledCluster();
    await f.provider().withSession(f.request, async (s) => { expect(tokenOf(s)).not.toBe(MINTER_TOKEN); });
  });

  it("deployer vault value missing: refused, no fallback to the minter, guests unaffected", async () => {
    const reads = vi.spyOn(vault, "readSecretValueAsync");
    const f = await fixture({ deployerValue: null }), cluster = modeledCluster();
    let entered = false;
    await expect(f.credentials.withSession({ connectionId: f.connection.id, grant: f.request.grant, purpose: "observe" }, async () => { entered = true; }))
      .rejects.toMatchObject({ reason: "deployer_credential_refused" });
    expect(entered).toBe(false);
    expect(reads.mock.calls.map((c) => c[1])).toEqual([f.deployerRef]);
    expect(cluster.calls).toEqual([]);
    await f.provider().withSession(f.request, async (s) => { expect(tokenOf(s)).not.toBe(MINTER_TOKEN); });
  });

  it("a deployer vault value bound to a different server is refused (target binding applies to the deployer too)", async () => {
    const f = await fixture({ deployerValue: DEPLOYER_TOKEN });
    await vault.putSecretAsync(f.workspaceId, f.deployerRef, boundKubeconfig("https://other.example.test", DEPLOYER_TOKEN), "k8s-join-fixture");
    await expect(f.credentials.withSession({ connectionId: f.connection.id, grant: f.request.grant, purpose: "observe" }, async () => "entered")).rejects.toMatchObject({ reason: "deployer_credential_refused" });
  });

  it("a guest failure never falls back to the deployer", async () => {
    const f = await fixture({ operation: "container.exec" });
    modeledCluster({ minter: () => true });
    let entered = false;
    await expect(f.provider().withSession(f.request, async (s) => { entered = true; safe(s); })).rejects.toMatchObject({ code: "denied" });
    expect(entered).toBe(false);
    const denied = (await repos.events.list(db, f.workspaceId)).filter((e) => e.type === "credential.denied");
    expect(denied).toEqual([expect.objectContaining({ data: expect.objectContaining({ reason: "guest_credential_refused" }) })]);
  });

  it("a guest scope outside the allowlist is still refused before any credential is read", async () => {
    const reads = vi.spyOn(vault, "readSecretValueAsync");
    const f = await fixture({ targetId: "elsewhere/pod-1" });
    await expect(f.provider().withSession(f.request, async () => "entered")).rejects.toMatchObject({ code: "denied" });
    expect(reads).not.toHaveBeenCalled();
  });
});

describe("verification covers both parts", () => {
  it("passes only when minter AND deployer pass; creates nothing", async () => {
    const f = await fixture(), cluster = modeledCluster();
    const result = await f.credentials.verifyConnection(f.connection.id, { workspaceId: f.workspaceId });
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/minter/);
    expect(result.detail).toMatch(/deployer \(namespaced\)/);
    expect(cluster.calls.some((c) => c === "allowed:minter")).toBe(true);
    expect(cluster.calls.some((c) => c === "allowed:deployer")).toBe(true);
    expect(cluster.calls.every((c) => c.startsWith("allowed:"))).toBe(true);
  });

  it("an over-privileged minter fails the connection even when the deployer is fine", async () => {
    const f = await fixture(); modeledCluster({ minter: () => true });
    const result = await f.credentials.verifyConnection(f.connection.id, { workspaceId: f.workspaceId });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/Guest minter/);
  });

  it("an insufficient deployer fails the connection even when the minter is fine", async () => {
    const f = await fixture(); modeledCluster({ deployer: (a) => a.resource === "serviceaccounts" && a.verb === "get" && a.namespace !== "kube-system" });
    const result = await f.credentials.verifyConnection(f.connection.id, { workspaceId: f.workspaceId });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/Deployer credential: .*cannot read and deploy/);
  });

  it("a deployer declared namespaced but holding cluster-wide power is refused; declared cluster it passes", async () => {
    const wide = (a: AccessAttributes) => a.verb === "*" ? false : true; // cluster-wide clusterroles/kube-system allowed, `*/*` denied
    const narrow = await fixture({ deployer: "namespaced" }); modeledCluster({ deployer: wide });
    const refused = await narrow.credentials.verifyConnection(narrow.connection.id, { workspaceId: narrow.workspaceId });
    expect(refused.ok).toBe(false);
    expect(refused.detail).toMatch(/Deployer credential: .*cluster-wide or system-namespace/);
    const broad = await fixture({ deployer: "cluster" }); modeledCluster({ deployer: wide });
    expect((await broad.credentials.verifyConnection(broad.connection.id, { workspaceId: broad.workspaceId })).ok).toBe(true);
  });

  it("a deployer that is the same credential as the minter is refused", async () => {
    const f = await fixture({ deployerValue: MINTER_TOKEN }); modeledCluster();
    const result = await f.credentials.verifyConnection(f.connection.id, { workspaceId: f.workspaceId });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/same credential as the guest minter/);
  });

  it("a guest-only connection (no deployer) verifies on the minter alone", async () => {
    const f = await fixture({ deployer: false }), cluster = modeledCluster();
    expect((await f.credentials.verifyConnection(f.connection.id, { workspaceId: f.workspaceId })).ok).toBe(true);
    expect(cluster.calls.every((c) => c === "allowed:minter")).toBe(true);
  });

  it("verifyDeployerCredential policy: system namespaces and empty allowlists are scope_refused", async () => {
    const port = { allowed: async () => true };
    await expect(verifyDeployerCredential(port, { scope: "cluster", namespaces: [] })).rejects.toMatchObject({ code: "scope_refused" });
    await expect(verifyDeployerCredential(port, { scope: "cluster", namespaces: ["kube-system"] })).rejects.toBeInstanceOf(DeployerCredentialError);
  });
});

describe("revocation ends both parts together", () => {
  it("one SQL commit refuses deploy/observe AND guest minting; bindings are cleaned from the cluster", async () => {
    const f = await fixture({ operation: "container.exec" }), cluster = modeledCluster();
    await f.provider().withSession(f.request, async () => undefined);
    await f.credentials.withSession({ connectionId: f.connection.id, grant: f.request.grant, purpose: "deploy" }, async () => undefined);
    await repos.connections.revokeAudited(db, { workspaceId: f.workspaceId, id: f.connection.id, actorId: "admin", reason: "test" });
    expect((await bindings(f)).map((b) => b.status)).toEqual(["revoking"]);
    await expect(f.credentials.withSession({ connectionId: f.connection.id, grant: f.request.grant, purpose: "deploy" }, async () => "entered")).rejects.toMatchObject({ reason: "connection_revoked" });
    await expect(f.provider().withSession(f.request, async () => "entered")).rejects.toMatchObject({ code: "denied" });
    const revoked = (await repos.connections.get(db, f.workspaceId, f.connection.id))!;
    expect(await revokeKubernetesGuestBindings(db, revoked, { now: f.now })).toEqual({ revoked: 1, pending: 0, attempted: true });
    expect(cluster.calls.filter((c) => c.startsWith("delete:"))).toEqual([`delete:app:${guestObjectName(f.workspaceId, f.connection.id, "exec")}`]);
  });
});

describe("rotation patch rules for the deployer part", () => {
  const live = (over: Partial<KubernetesConnectionConfig> = {}): KubernetesConnectionConfig => ({ provider: "kubernetes", mode: "scoped_guest", server: "https://cluster.example.test", caData: MODEL_CA,
    credentialRef: "vault:minter-1", namespaces: ["app"], ...over });

  it("adds, rescopes and removes the deployer; both parts live in one config", () => {
    const added = applyRotationPatch(live(), { deployerCredentialRef: "vault:deployer-1" }) as KubernetesConnectionConfig;
    expect(added).toMatchObject({ credentialRef: "vault:minter-1", deployerCredentialRef: "vault:deployer-1", deployerScope: "namespaced" });
    const cluster = applyRotationPatch(added, { deployerScope: "cluster" }) as KubernetesConnectionConfig;
    expect(cluster.deployerScope).toBe("cluster");
    const removed = applyRotationPatch(cluster, { removeDeployer: true }) as KubernetesConnectionConfig;
    expect(removed.deployerCredentialRef).toBeUndefined();
    expect(removed.deployerScope).toBeUndefined();
  });

  it("refuses a deployer equal to the minter, a scope without a deployer, and removal combined with a new one", () => {
    expect(() => applyRotationPatch(live(), { deployerCredentialRef: "vault:minter-1" })).toThrow(LifecycleInputError);
    expect(() => applyRotationPatch(live(), { deployerScope: "cluster" })).toThrow(LifecycleInputError);
    expect(() => applyRotationPatch(live({ deployerCredentialRef: "vault:d" }), { removeDeployer: true, deployerCredentialRef: "vault:e" })).toThrow(LifecycleInputError);
    expect(() => applyRotationPatch(live({ deployerCredentialRef: "vault:d" }), { credentialRef: "vault:d" })).toThrow(LifecycleInputError);
  });

  it("legacy conversion can keep the broad credential as the DEPLOYER (never as the minter)", () => {
    const legacy = live({ mode: "kubeconfig_ref", credentialRef: "vault:legacy" });
    const converted = applyRotationPatch(legacy, { convertToScopedGuest: true, credentialRef: "vault:minter-new", retainLegacyAsDeployer: "cluster" }) as KubernetesConnectionConfig;
    expect(converted).toMatchObject({ mode: "scoped_guest", credentialRef: "vault:minter-new", deployerCredentialRef: "vault:legacy", deployerScope: "cluster" });
    const dropped = applyRotationPatch(legacy, { convertToScopedGuest: true, credentialRef: "vault:minter-new" }) as KubernetesConnectionConfig;
    expect(dropped.deployerCredentialRef).toBeUndefined();
    expect(() => applyRotationPatch(legacy, { convertToScopedGuest: true, credentialRef: "vault:legacy", retainLegacyAsDeployer: "cluster" })).toThrow(LifecycleInputError);
    expect(() => applyRotationPatch(legacy, { retainLegacyAsDeployer: "cluster", credentialRef: "vault:x" })).toThrow(LifecycleInputError);
    expect(() => applyRotationPatch(legacy, { deployerCredentialRef: "vault:d" })).toThrow(LifecycleInputError);
  });

  it("rotation verifies BOTH parts of the candidate before it can be promoted, and promotion switches deploy to the new deployer", async () => {
    const f = await fixture({ deployer: false }); modeledCluster();
    const deployerRef = `vault:deployer-new/${randomUUID()}/KUBE_TOKEN`;
    await vault.putSecretAsync(f.workspaceId, deployerRef, boundKubeconfig(f.config.server, DEPLOYER_TOKEN), "k8s-join-fixture");
    const candidate = applyRotationPatch(f.config, { deployerCredentialRef: deployerRef }) as KubernetesConnectionConfig;
    const staged = (await repos.connectionRotations.stage(db, { workspaceId: f.workspaceId, connectionId: f.connection.id, candidateConfig: candidate, createdBy: "admin" }))!;
    const broker = platformCredentialBroker(db, { now: f.now, verifyCandidate: { workspaceId: f.workspaceId, connectionId: f.connection.id, config: candidate } });
    modeledCluster({ deployer: () => true });
    const bad = await broker.verifyConnection(f.connection.id, { workspaceId: f.workspaceId });
    expect(bad.ok).toBe(false);
    await repos.connectionRotations.recordCandidateVerification(db, { workspaceId: f.workspaceId, id: staged.id, ok: false, detail: bad.detail });
    expect(await repos.connectionRotations.promote(db, { workspaceId: f.workspaceId, id: staged.id, actorId: "admin" })).toMatchObject({ ok: false });
    modeledCluster();
    const good = await broker.verifyConnection(f.connection.id, { workspaceId: f.workspaceId });
    expect(good.ok).toBe(true);
    await repos.connectionRotations.recordCandidateVerification(db, { workspaceId: f.workspaceId, id: staged.id, ok: true, detail: good.detail });
    expect(await repos.connectionRotations.promote(db, { workspaceId: f.workspaceId, id: staged.id, actorId: "admin" })).toMatchObject({ ok: true });
    // Before promotion deploy was refused (no deployer); now the promoted connection serves it with the new deployer.
    await f.credentials.withSession({ connectionId: f.connection.id, grant: f.request.grant, purpose: "observe" }, async (s) => { expect(tokenOf(s)).toBe(DEPLOYER_TOKEN); });
  });
});
