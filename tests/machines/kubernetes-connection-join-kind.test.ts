/**
 * Opt-in PROD-K8S-CONN acceptance on a genuine disposable kind cluster: ONE scoped_guest connection holds a namespaced
 * guest MINTER and a separate DEPLOYER credential; deploy/observe sessions get the deployer, guest sessions get a minted
 * namespace-scoped token, neither can do the other's work, verification covers both parts and revocation ends both.
 * Nothing about the Kubernetes API is modeled.
 *
 * Gate (same as tests/machines/kubernetes-guest-scoped-kind.test.ts): ZENITH_TEST_KIND=1, an absolute private KUBECONFIG
 * whose single context is kind-<ZENITH_TEST_KIND_GUEST_CLUSTER> (zenith-*). Only labeled, randomly named namespaces and
 * labeled cluster bindings (removed in cleanup) are created. The admin config is used for setup and cleanup only and never
 * reaches a broker or session callback. Skipped, never passed, without the gate.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import path from "node:path";
import { ApiException, AuthorizationV1Api, CoreV1Api, KubeConfig, RbacAuthorizationV1Api } from "@kubernetes/client-node";
import { dump as yamlDump } from "js-yaml";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import type { KubernetesConnectionConfig } from "@/lib/credentials/types";
import type { KubernetesMachineSession, MachineOperation, MachineSessionRequest } from "@/lib/machines/types";
import { tempDataDir } from "../_support/data-dir";
import { requestFor } from "./_helpers";

tempDataDir("zenith-kind-k8s-join-", { fast: true });
const { openPlatformDb, repos } = await import("@/lib/controlplane/db");
const { platformCredentialBroker, revokeKubernetesGuestBindings } = await import("@/lib/platform/credentials");
const { createMachineSessionProvider } = await import("@/lib/machines/sessions");
const { guestObjectName } = await import("@/lib/providers/kubernetes/guest");
const { generateSigningJwk, LocalJwkSigner } = await import("@/lib/credentials/signing");
const { signCapabilityGrant, verifyCapabilityGrant } = await import("@/lib/credentials/grants");
const vault = await import("@/lib/secrets");

const enabled = process.env.ZENITH_TEST_KIND === "1";
const RBAC_GROUP = "rbac.authorization.k8s.io";

class KindError extends Error {
  readonly httpStatus?: number;
  constructor(error: unknown) {
    super("The owned kind connection-join fixture request failed.");
    const status = error instanceof ApiException ? error.code : undefined;
    if (typeof status === "number") this.httpStatus = status;
  }
}
async function api<T>(request: () => Promise<T>): Promise<T> { try { return await request(); } catch (error) { throw new KindError(error); } }

function ownedAdminConfig(): KubeConfig {
  const file = process.env.KUBECONFIG, clusterName = process.env.ZENITH_TEST_KIND_GUEST_CLUSTER;
  if (!file || !path.isAbsolute(file) || file.includes(path.delimiter) || !clusterName || !/^zenith-[a-z0-9-]{1,40}$/.test(clusterName)) throw new Error("Opt-in kind acceptance requires the explicit owned kubeconfig and cluster name.");
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) || stat.size > 256 * 1024) throw new Error("The explicit owned kind kubeconfig is unsafe.");
  const kc = new KubeConfig();
  kc.loadFromFile(file);
  const name = `kind-${clusterName}`, cluster = kc.getCurrentCluster(), user = kc.getCurrentUser();
  if (kc.getCurrentContext() !== name || kc.contexts.length !== 1 || kc.clusters.length !== 1 || !cluster || !user || cluster.name !== name || cluster.skipTLSVerify || !cluster.caData
    || user.exec || user.authProvider || user.token || !user.certData || !user.keyData) throw new Error("The explicit owned kind kubeconfig does not select exactly the owned cluster.");
  const url = new URL(cluster.server);
  if (url.protocol !== "https:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("The owned kind API server must be loopback HTTPS.");
  return kc;
}

describe.skipIf(!enabled)("one scoped Kubernetes connection serves guests and deploy/observe on the owned kind cluster", () => {
  const suffix = randomBytes(6).toString("hex"), namespace = `zenith-cj-${suffix}`;
  const labels = { "app.kubernetes.io/managed-by": "zenith", "zenith.dev/acceptance": "connection-join", "zenith.dev/acceptance-run": suffix };
  const ownedNamespaces: { name: string; uid: string }[] = [], ownedVaultRefs: { workspaceId: string; ref: string }[] = [], ownedClusterBindings: string[] = [];
  let admin: KubeConfig, core: CoreV1Api, rbac: RbacAuthorizationV1Api;
  let db: Awaited<ReturnType<typeof openPlatformDb>>;
  let server = "", caData = "";
  let key: Awaited<ReturnType<typeof generateSigningJwk>>, signer: ReturnType<typeof LocalJwkSigner.fromJwk>;

  beforeAll(async () => {
    admin = ownedAdminConfig();
    server = admin.getCurrentCluster()!.server; caData = admin.getCurrentCluster()!.caData!;
    core = admin.makeApiClient(CoreV1Api); rbac = admin.makeApiClient(RbacAuthorizationV1Api);
    vi.stubEnv("ZENITH_STORE", "file");
    vi.stubEnv("ZENITH_SECRET_KEY", randomBytes(32).toString("hex"));
    db = await openPlatformDb({ kind: "pglite" });
    key = await generateSigningJwk("EdDSA"); signer = LocalJwkSigner.fromJwk("kind-connection-join", key.privateJwk, { alg: "EdDSA" });
    const created = await api(() => core.createNamespace({ body: { metadata: { name: namespace, labels } } }));
    if (!created.metadata?.uid) throw new Error("The owned namespace creation was not confirmed.");
    ownedNamespaces.push({ name: namespace, uid: created.metadata.uid });
  }, 150_000);

  afterAll(async () => {
    let failure = false;
    try {
      const cleanup = ownedAdminConfig(), cCore = cleanup.makeApiClient(CoreV1Api), cRbac = cleanup.makeApiClient(RbacAuthorizationV1Api);
      for (const name of ownedClusterBindings) { try { await api(() => cRbac.deleteClusterRoleBinding({ name })); } catch (e) { if (!(e instanceof KindError && e.httpStatus === 404)) failure = true; } }
      for (const owned of [...ownedNamespaces].reverse()) {
        try {
          const current = await api(() => cCore.readNamespace({ name: owned.name }));
          if (current.metadata?.uid !== owned.uid || !Object.entries(labels).every(([k, v]) => current.metadata?.labels?.[k] === v)) throw new Error("identity changed");
          await api(() => cCore.deleteNamespace({ name: owned.name }));
        } catch { failure = true; }
      }
    } catch { failure = true; }
    finally {
      for (const owned of ownedVaultRefs) { try { await vault.removeSecretAsync(owned.workspaceId, owned.ref); } catch { failure = true; } }
      try { await db?.close(); } catch { failure = true; }
      vi.unstubAllEnvs();
    }
    if (failure) throw new Error("The owned kind connection-join cleanup was not fully confirmed; root cluster cleanup remains required.");
  }, 120_000);

  /** A ServiceAccount token with exactly `rules` in `namespace` (plus an optional cluster-admin binding). */
  async function identity(prefix: string, rules: { apiGroups: string[]; resources: string[]; verbs: string[]; resourceNames?: string[] }[], clusterAdmin = false) {
    const name = `${prefix}-${randomBytes(4).toString("hex")}`;
    const sa = await api(() => core.createNamespacedServiceAccount({ namespace, body: { metadata: { name, labels }, automountServiceAccountToken: false } }));
    await api(() => rbac.createNamespacedRole({ namespace, body: { metadata: { name, labels }, rules } }));
    await api(() => rbac.createNamespacedRoleBinding({ namespace, body: { metadata: { name, labels }, roleRef: { apiGroup: RBAC_GROUP, kind: "Role", name }, subjects: [{ kind: "ServiceAccount", name, namespace }] } }));
    if (clusterAdmin) {
      const binding = `zenith-cj-admin-${suffix}-${randomBytes(3).toString("hex")}`;
      ownedClusterBindings.push(binding);
      await api(() => rbac.createClusterRoleBinding({ body: { metadata: { name: binding, labels }, roleRef: { apiGroup: RBAC_GROUP, kind: "ClusterRole", name: "cluster-admin" }, subjects: [{ kind: "ServiceAccount", name, namespace }] } }));
    }
    const issued = await api(() => core.createNamespacedServiceAccountToken({ name, namespace, body: { apiVersion: "authentication.k8s.io/v1", kind: "TokenRequest", metadata: { name, namespace, uid: sa.metadata!.uid }, spec: { audiences: [], expirationSeconds: 3000 } } }));
    if (!issued.status?.token) throw new Error("token not issued");
    return issued.status.token;
  }
  const kubeconfigOf = (token: string) => yamlDump({ apiVersion: "v1", kind: "Config", "current-context": "c",
    clusters: [{ name: "owning-cluster", cluster: { server, "certificate-authority-data": caData } }],
    contexts: [{ name: "c", context: { cluster: "owning-cluster", user: "u" } }], users: [{ name: "u", user: { token } }] }, { noRefs: true });
  const DEPLOYER_RULES = [
    { apiGroups: [""], resources: ["serviceaccounts", "pods", "configmaps"], verbs: ["get", "list"] },
    { apiGroups: ["apps"], resources: ["deployments"], verbs: ["get", "list", "create", "patch"] },
  ];

  async function fixture(operation: MachineOperation, opts: { scope?: "namespaced" | "cluster"; deployerClusterAdmin?: boolean } = {}) {
    const workspaceId = `ws-kind-cj-${randomUUID()}`, credentialRef = `vault:kind-cj/${randomUUID()}/MINTER`, deployerRef = `vault:kind-cj/${randomUUID()}/DEPLOYER`;
    const config: KubernetesConnectionConfig = { provider: "kubernetes", mode: "scoped_guest", server, caData, credentialRef, namespaces: [namespace], deployerCredentialRef: deployerRef, deployerScope: opts.scope ?? "namespaced" };
    const created = await repos.connections.create(db, { workspaceId, config, createdBy: "kind-connection-join" });
    const guestRoles = [guestObjectName(workspaceId, created.id, "read"), guestObjectName(workspaceId, created.id, "exec")];
    const minter = await identity("minter", [
      { apiGroups: [""], resources: ["serviceaccounts"], verbs: ["create", "get", "delete"] },
      { apiGroups: [""], resources: ["serviceaccounts/token"], verbs: ["create"] },
      { apiGroups: [RBAC_GROUP], resources: ["roles"], verbs: ["create", "get", "update", "delete"] },
      { apiGroups: [RBAC_GROUP], resources: ["roles"], verbs: ["bind", "escalate"], resourceNames: guestRoles },
      { apiGroups: [RBAC_GROUP], resources: ["rolebindings"], verbs: ["create", "get", "delete"] },
    ]);
    const deployer = await identity("deployer", DEPLOYER_RULES, opts.deployerClusterAdmin === true);
    ownedVaultRefs.push({ workspaceId, ref: credentialRef }, { workspaceId, ref: deployerRef });
    await vault.putSecretAsync(workspaceId, credentialRef, kubeconfigOf(minter), "kind-connection-join");
    await vault.putSecretAsync(workspaceId, deployerRef, kubeconfigOf(deployer), "kind-connection-join");
    const credentials = platformCredentialBroker(db);
    const verified = await credentials.verifyConnection(created.id, { workspaceId });
    await repos.connections.recordVerification(db, { workspaceId, id: created.id, ok: verified.ok, detail: verified.detail });
    const connection = (await repos.connections.get(db, workspaceId, created.id))!;
    const operationId = `op-kind-cj-${randomUUID()}`, environmentId = `env-kind-cj-${suffix}`, resourceId = `res-kind-cj-${randomUUID()}`, now = Math.floor(Date.now() / 1000);
    const claims: CapabilityGrantClaims = { jti: randomUUID(), iss: "kind-connection-join", aud: "worker", sub: "user:kind-connection-join", iat: now - 1, exp: now + 300, cap: operation, op: operationId, digest: "d".repeat(64), ws: workspaceId, env: environmentId, res: resourceId };
    const jws = await signCapabilityGrant(claims, { signer });
    const grant = await verifyCapabilityGrant(jws, { audience: "worker", expectedCapability: operation, expectedOperationId: operationId, keys: [key.publicJwk] });
    const request = requestFor(operation, { all: true }, { operationId, target: { workspaceId, environmentId, resourceId, address: "compute_instance/join", transport: "kubernetes", targetId: namespace }, timeoutSec: 20 });
    const sessionRequest: MachineSessionRequest = { operationId, operation, target: request.target, grant };
    const guestProvider = createMachineSessionProvider({ credentials, connection, grantJws: jws });
    return { workspaceId, connection, verified, credentials, grant, sessionRequest, guestProvider };
  }
  const can = (session: unknown) => {
    const authz = ((session as KubernetesMachineSession).kubeConfig() as KubeConfig).makeApiClient(AuthorizationV1Api);
    return async (resourceAttributes: { verb: string; resource: string; subresource?: string; group?: string; namespace?: string }) =>
      (await api(() => authz.createSelfSubjectAccessReview({ body: { apiVersion: "authorization.k8s.io/v1", kind: "SelfSubjectAccessReview", spec: { resourceAttributes: { group: "", ...resourceAttributes } } } }))).status?.allowed === true;
  };

  it("verifies both parts; deploy/observe get the deployer, guests get a minted token, privileges do not cross", async () => {
    const f = await fixture("container.list");
    expect(f.verified.ok).toBe(true);
    expect(f.verified.detail).toMatch(/minter/);
    expect(f.verified.detail).toMatch(/deployer \(namespaced\)/);
    // observe (and deploy: the same credential path) uses the deployer: it can patch deployments, it cannot mint guests or touch RBAC.
    await f.credentials.withSession({ connectionId: f.connection.id, grant: f.grant, purpose: "observe" }, async (session) => {
      const access = can(session);
      expect(await access({ verb: "list", resource: "pods", namespace })).toBe(true);
      expect(await access({ verb: "patch", resource: "deployments", group: "apps", namespace })).toBe(true);
      for (const denied of [{ verb: "create", resource: "serviceaccounts", namespace }, { verb: "create", resource: "serviceaccounts", subresource: "token", namespace },
        { verb: "create", resource: "roles", group: RBAC_GROUP, namespace }, { verb: "list", resource: "nodes" }]) expect(await access(denied)).toBe(false);
    });
    expect(await repos.k8sGuestBindings.listForConnection(db, f.workspaceId, f.connection.id)).toEqual([]);
    // the guest session of the SAME connection is a minted per-binding token: no deployment write, no deployer rights.
    await f.guestProvider.withSession(f.sessionRequest, async (session) => {
      const access = can(session);
      expect(await access({ verb: "list", resource: "pods", namespace })).toBe(true);
      expect(await access({ verb: "patch", resource: "deployments", group: "apps", namespace })).toBe(false);
      expect(await access({ verb: "get", resource: "configmaps", namespace })).toBe(false);
    });
    expect((await repos.k8sGuestBindings.listForConnection(db, f.workspaceId, f.connection.id))[0]).toMatchObject({ namespace, status: "active" });
  }, 150_000);

  it("a deployer declared namespaced but bound to cluster-admin is refused at verification; declared cluster it is accepted", async () => {
    const refused = await fixture("container.list", { deployerClusterAdmin: true });
    expect(refused.verified.ok).toBe(false);
    expect(refused.verified.detail).toMatch(/Deployer credential: .*cluster-wide or system-namespace/);
    await expect(refused.credentials.withSession({ connectionId: refused.connection.id, grant: refused.grant, purpose: "observe" }, async () => "entered")).rejects.toMatchObject({ name: "CredentialDeniedError" });
    const accepted = await fixture("container.list", { deployerClusterAdmin: true, scope: "cluster" });
    expect(accepted.verified.ok).toBe(true);
  }, 150_000);

  it("revocation ends both parts: deploy/observe and guest dispatch are refused and guest objects are deleted", async () => {
    const f = await fixture("container.exec");
    await f.guestProvider.withSession(f.sessionRequest, async () => undefined);
    await repos.connections.revokeAudited(db, { workspaceId: f.workspaceId, id: f.connection.id, actorId: "admin", reason: "kind acceptance" });
    await expect(f.credentials.withSession({ connectionId: f.connection.id, grant: f.grant, purpose: "deploy" }, async () => "entered")).rejects.toMatchObject({ reason: "connection_revoked" });
    await expect(f.guestProvider.withSession(f.sessionRequest, async () => "entered")).rejects.toMatchObject({ code: "denied" });
    const revoked = (await repos.connections.get(db, f.workspaceId, f.connection.id))!;
    const outcome = await revokeKubernetesGuestBindings(db, revoked);
    expect(outcome).toMatchObject({ pending: 0, attempted: true });
    const roleName = guestObjectName(f.workspaceId, f.connection.id, "exec");
    await expect(api(() => rbac.readNamespacedRole({ name: roleName, namespace }))).rejects.toMatchObject({ httpStatus: 404 });
  }, 150_000);
});
