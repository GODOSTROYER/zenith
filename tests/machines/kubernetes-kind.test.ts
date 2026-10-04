/**
 * Opt-in genuine disposable-kind guest acceptance. ZENITH_TEST_KIND=1 requires
 * an explicit private KUBECONFIG and ZENITH_TEST_KIND_GUEST_CLUSTER=zenith-*.
 * Root creates/deletes that cluster and loads ZENITH_TEST_KIND_RELEASE_IMAGE.
 * Only two random, labeled namespaces are mutated; their UID/labels fence cleanup.
 * Setup/cleanup alone use the root-admin config. Guest calls use the DEFAULT
 * platform credential broker, actual tenant vault, machine session and clients.
 * PGlite/locally signed explicit claims are fixtures, not live product/PG authority.
 * No client/resolver/API ports are injected. Tokens/configs/raw API errors stay private.
 * TokenRequest audience defaults: upstream v1.35.0 serviceaccount/storage/token.go
 * https://github.com/kubernetes/kubernetes/blob/v1.35.0/pkg/registry/core/serviceaccount/storage/token.go#L105-L108
 * RBAC scope: https://kubernetes.io/docs/reference/access-authn-authz/rbac/#rolebinding-and-clusterrolebinding
 */
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { ApiException, KubeConfig, type KubernetesObject } from "@kubernetes/client-node";
import { dump as yamlDump, FAILSAFE_SCHEMA, load as yamlLoad } from "js-yaml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import type { KubernetesConnectionConfig } from "@/lib/credentials/types";
import type { KubernetesMachineSession, MachineSessionRequest } from "@/lib/machines/types";
import { tempDataDir } from "../_support/data-dir";
import { requestFor } from "./_helpers";

tempDataDir("zenith-kind-guest-", { fast: true });
const { openPlatformDb, repos } = await import("@/lib/controlplane/db");
const { platformCredentialBroker } = await import("@/lib/platform/credentials");
const { createMachineSessionProvider } = await import("@/lib/machines/sessions");
const { createKubernetesMachineDriver } = await import("@/lib/machines/transports/kubernetes");
const { createK8sClient } = await import("@/lib/providers/kubernetes/client");
const { sessionFromKubeConfig } = await import("@/lib/providers/kubernetes/session");
const { generateSigningJwk, LocalJwkSigner } = await import("@/lib/credentials/signing");
const { signCapabilityGrant, verifyCapabilityGrant } = await import("@/lib/credentials/grants");
const vault = await import("@/lib/secrets");

/** Project fixed scalar status only; failed matchers cannot serialize API auth. */
class KindFixtureError extends Error {
  readonly httpStatus?: number;
  readonly machineCode?: string;
  constructor(error?: unknown) {
    super("The owned kind guest fixture request failed.");
    const status = error instanceof ApiException ? error.code
      : error instanceof KindFixtureError ? error.httpStatus
        : error && typeof error === "object" && "cause" in error && error.cause instanceof ApiException ? error.cause.code : undefined;
    if (Number.isInteger(status) && status! >= 100 && status! <= 599) this.httpStatus = status;
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (typeof code === "string" && ["denied", "aborted", "grant_expired", "grant_mismatch", "transport_error"].includes(code)) this.machineCode = code;
  }
}
async function api<T>(request: () => Promise<T>): Promise<T> {
  try { return await request(); } catch (error) { throw new KindFixtureError(error); }
}

const OWNED_CONFIG_REFUSAL = "The explicit owned kind kubeconfig is unsafe or changed.";

/** Inert parsing controls only: no SDK, external files, API ports or credentials. */
function ownedSetupDocument(text: string, clusterName: string): string {
  try {
    // Generated kind data needs none of these YAML mechanisms. Reject before
    // parsing so anchors/aliases cannot allocate or hide a credential mechanism.
    if (!/^zenith-[a-z0-9-]{1,40}$/.test(clusterName) || Buffer.byteLength(text, "utf8") > 256 * 1024 || /[&*!%]/.test(text)) throw new Error("unsafe");
    let nodes = 0, depth = 0;
    const document: unknown = yamlLoad(text, {
      schema: FAILSAFE_SCHEMA, json: false,
      onWarning() { throw new Error("unsafe"); },
      listener(event) {
        if (event === "open") {
          nodes++; depth++;
          if (nodes > 1024 || depth > 16) throw new Error("unsafe");
        } else depth--;
      },
    });
    function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
        || !required.every(key => Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error("unsafe");
      return value as Record<string, unknown>;
    }
    function single(value: unknown, fields: readonly string[]): Record<string, unknown> {
      if (!Array.isArray(value) || value.length !== 1) throw new Error("unsafe");
      return record(value[0], fields);
    }
    function embedded(value: unknown): string {
      if (typeof value !== "string" || value.length < 8 || value.length > 128 * 1024 || value.length % 4 !== 0
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || Buffer.from(value, "base64").toString("base64") !== value) throw new Error("unsafe");
      return value;
    }
    const root = record(document, ["apiVersion", "kind", "clusters", "contexts", "current-context", "users"], ["preferences"]);
    if (root.apiVersion !== "v1" || root.kind !== "Config") throw new Error("unsafe");
    if (Object.hasOwn(root, "preferences")) record(root.preferences, []);
    const name = `kind-${clusterName}`;
    const cluster = single(root.clusters, ["name", "cluster"]), context = single(root.contexts, ["name", "context"]), user = single(root.users, ["name", "user"]);
    const rawCluster = record(cluster.cluster, ["server", "certificate-authority-data"]);
    const rawContext = record(context.context, ["cluster", "user"]);
    const rawUser = record(user.user, ["client-certificate-data", "client-key-data"]);
    if (root["current-context"] !== name || cluster.name !== name || context.name !== name || user.name !== name
      || rawContext.cluster !== name || rawContext.user !== name || typeof rawCluster.server !== "string") throw new Error("unsafe");
    const url = new URL(rawCluster.server);
    if (url.protocol !== "https:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !url.port
      || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("unsafe");
    // Only reconstruct known fields. The SDK parses JSON, not the untrusted YAML,
    // after every raw user field (including token-file) has been checked.
    return JSON.stringify({ apiVersion: "v1", kind: "Config", preferences: {}, "current-context": name,
      clusters: [{ name, cluster: { server: rawCluster.server, "certificate-authority-data": embedded(rawCluster["certificate-authority-data"]) } }],
      contexts: [{ name, context: { cluster: name, user: name } }],
      users: [{ name, user: { "client-certificate-data": embedded(rawUser["client-certificate-data"]), "client-key-data": embedded(rawUser["client-key-data"]) } }],
    });
  } catch { throw new Error(OWNED_CONFIG_REFUSAL); }
}
function decodeOwnedSetupConfig(text: string, clusterName: string): KubeConfig {
  const document = ownedSetupDocument(text, clusterName);
  try { const config = new KubeConfig(); config.loadFromString(document); return config; }
  catch { throw new Error(OWNED_CONFIG_REFUSAL); }
}

function ownedSetupConfig(): KubeConfig {
  const file = process.env.KUBECONFIG, clusterName = process.env.ZENITH_TEST_KIND_GUEST_CLUSTER;
  if (!file || !path.isAbsolute(file) || file.includes(path.delimiter) || !clusterName || !/^zenith-[a-z0-9-]{1,40}$/.test(clusterName)) {
    throw new Error("Opt-in kind guest acceptance requires the explicit owned kubeconfig and cluster name.");
  }
  let fd: number | undefined;
  try {
    const named = lstatSync(file);
    if (!named.isFile() || named.isSymbolicLink() || named.uid !== process.getuid?.() || (named.mode & 0o077) !== 0 || named.size > 256 * 1024 || realpathSync(file) !== file) throw new Error("unsafe");
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const pinned = fstatSync(fd);
    if (pinned.dev !== named.dev || pinned.ino !== named.ino || pinned.size !== named.size || pinned.mtimeMs !== named.mtimeMs
      || pinned.ctimeMs !== named.ctimeMs || pinned.uid !== named.uid || pinned.gid !== named.gid || pinned.mode !== named.mode) throw new Error("changed");
    // Bound the descriptor read even if its owner races a file-size change.
    const bytes = Buffer.alloc(256 * 1024 + 1), count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count !== pinned.size || count > 256 * 1024) throw new Error("changed");
    const config = decodeOwnedSetupConfig(bytes.subarray(0, count).toString("utf8"), clusterName);
    const after = lstatSync(file), held = fstatSync(fd);
    if ([after, held].some(value => value.dev !== pinned.dev || value.ino !== pinned.ino || value.size !== pinned.size || value.mtimeMs !== pinned.mtimeMs
      || value.ctimeMs !== pinned.ctimeMs || value.uid !== pinned.uid || value.gid !== pinned.gid || value.mode !== pinned.mode)) throw new Error("changed");
    const context = config.getContextObject(config.getCurrentContext()), cluster = config.getCurrentCluster(), user = config.getCurrentUser();
    const name = `kind-${clusterName}`;
    if (!context || !cluster || !user || config.contexts.length !== 1 || config.clusters.length !== 1 || config.users.length !== 1
      || context.name !== name || context.cluster !== name || context.user !== name || cluster.name !== name || user.name !== name
      || !cluster.caData || cluster.caFile || cluster.skipTLSVerify || cluster.proxyUrl || cluster.tlsServerName
      || !user.certData || !user.keyData || user.certFile || user.keyFile || user.exec || user.authProvider || user.token || user.username || user.password || user.impersonateUser) throw new Error("unsafe");
    const url = new URL(cluster.server);
    if (url.protocol !== "https:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !url.port
      || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("unsafe");
    return config;
  } catch { throw new Error(OWNED_CONFIG_REFUSAL); }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Prepared parser/ordering models; these do not establish cluster acceptance. */
describe("owned kind kubeconfig raw admission", () => {
  const clusterName = "zenith-parser-fixture", name = `kind-${clusterName}`;
  function document() {
    return { apiVersion: "v1", kind: "Config", preferences: {}, "current-context": name,
      clusters: [{ name, cluster: { server: "https://127.0.0.1:6443", "certificate-authority-data": Buffer.from("fixture-ca-data").toString("base64") } }],
      contexts: [{ name, context: { cluster: name, user: name } }],
      users: [{ name, user: { "client-certificate-data": Buffer.from("fixture-certificate-data").toString("base64"), "client-key-data": Buffer.from("fixture-key-data").toString("base64") } }],
    };
  }
  function refusedBeforeSdk(text: string) {
    const load = vi.spyOn(KubeConfig.prototype, "loadFromString");
    try {
      let error: unknown;
      try { decodeOwnedSetupConfig(text, clusterName); } catch (caught) { error = caught; }
      expect(error instanceof Error).toBe(true);
      expect(error instanceof Error ? error.message : undefined).toBe(OWNED_CONFIG_REFUSAL);
      expect(error instanceof Error && Object.hasOwn(error, "cause")).toBe(false);
      expect(load).not.toHaveBeenCalled();
    } finally { load.mockRestore(); }
  }
  it.each(["yaml", "json"])("admits the exact inert owning %s shape before SDK decoding", format => {
    const input = document(), text = format === "yaml" ? yamlDump(input, { noRefs: true }) : JSON.stringify(input);
    const canonical = JSON.parse(ownedSetupDocument(text, clusterName));
    // All data in this parser fixture is synthetic, never a cluster credential.
    expect(canonical).toEqual(input);
    const config = decodeOwnedSetupConfig(text, clusterName);
    expect(config.getCurrentContext()).toBe(name);
    expect(config.getCurrentCluster()?.server).toBe("https://127.0.0.1:6443");
    expect(config.getCurrentUser()?.name).toBe(name);
  });
  it.each([
    ["token-file", "/unread-external-test-file"], ["token-file", ""], ["token", "synthetic-token"],
    ["client-certificate", "/unread-external-cert"], ["client-key", "/unread-external-key"],
    ["exec", { command: "unexecuted-fixture-command" }], ["auth-provider", { name: "uninvoked-fixture-provider" }],
    ["username", "synthetic-user"], ["password", "synthetic-password"], ["as", "foreign-user"],
    ["as-groups", ["system:masters"]], ["as-user-extra", { example: ["foreign"] }], ["extensions", []],
  ])("refuses raw user mechanism %s before SDK or file/provider lookup", (field, value) => {
    const input = document(); Object.assign(input.users[0].user, { [String(field)]: value });
    refusedBeforeSdk(yamlDump(input, { noRefs: true }));
  });
  it.each([
    ["certificate-authority", "/unread-external-ca"], ["insecure-skip-tls-verify", false],
    ["proxy-url", "https://uninvoked-proxy.invalid"], ["tls-server-name", "foreign-host"], ["extensions", []],
  ])("refuses raw cluster mechanism %s before SDK decoding", (field, value) => {
    const input = document(); Object.assign(input.clusters[0].cluster, { [String(field)]: value });
    refusedBeforeSdk(yamlDump(input, { noRefs: true }));
  });
  it.each(["duplicate key", "anchor alias", "tag", "merge", "multiple documents", "escaped external key", "oversize", "deep nesting", "excess nodes"])("refuses %s with a fixed sanitized error before SDK decoding", variant => {
    const original = yamlDump(document(), { noRefs: true });
    const inputs: Record<string, string> = {
      "duplicate key": `${original}apiVersion: v1\n`,
      "anchor alias": original.replace("preferences: {}", "preferences: &empty {}\nunused: *empty"),
      tag: original.replace("preferences: {}", "preferences: !!map {}"),
      merge: original.replace("preferences: {}", "preferences: {\"<<\": {}}"),
      "multiple documents": `${original}---\n${original}`,
      "escaped external key": JSON.stringify(document()).replace('"client-key-data":', '"\\u0074oken-file":"/unread-external-test-file","client-key-data":'),
      oversize: `${original}#${"a".repeat(256 * 1024)}`,
      "deep nesting": `${original}unused: ${"[".repeat(32)}x${"]".repeat(32)}\n`,
      "excess nodes": `${original}unused: [${Array.from({ length: 1100 }, () => "x").join(",")}]\n`,
    };
    refusedBeforeSdk(inputs[variant]);
  });
  it.each(["foreign current context", "second user", "foreign namespace", "unknown top field", "nonempty preferences", "mapping certificate", "sequence key", "null context", "numeric server", "malformed base64", "nonloopback server"])("refuses unsafe shape %s before SDK decoding", variant => {
    const input = document();
    switch (variant) {
      case "foreign current context": input["current-context"] = "kind-zenith-foreign"; break;
      case "second user": input.users.push({ ...input.users[0] }); break;
      case "foreign namespace": Object.assign(input.contexts[0].context, { namespace: "foreign" }); break;
      case "unknown top field": Object.assign(input, { extensions: [] }); break;
      case "nonempty preferences": Object.assign(input.preferences, { colors: "true" }); break;
      case "mapping certificate": Object.assign(input.users[0].user, { "client-certificate-data": { nested: "value" } }); break;
      case "sequence key": Object.assign(input.users[0].user, { "client-key-data": ["value"] }); break;
      case "null context": Object.assign(input.contexts[0], { context: null }); break;
      case "numeric server": Object.assign(input.clusters[0].cluster, { server: 6443 }); break;
      case "malformed base64": input.users[0].user["client-key-data"] = "not base64"; break;
      case "nonloopback server": input.clusters[0].cluster.server = "https://foreign.invalid:6443"; break;
    }
    refusedBeforeSdk(yamlDump(input, { noRefs: true }));
  });
});

const enabled = process.env.ZENITH_TEST_KIND === "1";
describe.skipIf(!enabled)("default Kubernetes guest credentials against the owned kind cluster", () => {
  const suffix = randomBytes(8).toString("hex"), namespace = `zenith-guest-${suffix}`, foreignNamespace = `zenith-guest-foreign-${suffix}`;
  const labels = { "app.kubernetes.io/managed-by": "zenith", "zenith.dev/acceptance": "guest-session", "zenith.dev/acceptance-run": suffix };
  const ownedNamespaces: { name: string; uid: string }[] = [], ownedVaultRefs: { workspaceId: string; ref: string }[] = [];
  let db: Awaited<ReturnType<typeof openPlatformDb>> | undefined;
  let admin: ReturnType<typeof createK8sClient> | undefined;
  let cluster: { server: string; caData: string };
  let token: string | undefined, tokenExpiresAt: number;
  let key: Awaited<ReturnType<typeof generateSigningJwk>>, signer: ReturnType<typeof LocalJwkSigner.fromJwk>;
  let controller: AbortController;
  const setupController = new AbortController();

  beforeEach(() => { controller = new AbortController(); });
  afterEach(() => { controller?.abort(); });
  beforeAll(async () => {
    const config = ownedSetupConfig();
    const image = process.env.ZENITH_TEST_KIND_RELEASE_IMAGE;
    if (!image || !/^[a-zA-Z0-9][-a-zA-Z0-9._/:]*@sha256:[a-f0-9]{64}$/.test(image)) throw new Error("The root-loaded kind guest fixture image must be digest-pinned.");
    const current = config.getCurrentCluster()!;
    cluster = { server: current.server, caData: current.caData! };
    vi.stubEnv("ZENITH_STORE", "file");
    vi.stubEnv("ZENITH_SECRET_KEY", randomBytes(32).toString("hex"));
    db = await openPlatformDb({ kind: "pglite" });
    key = await generateSigningJwk("EdDSA"); signer = LocalJwkSigner.fromJwk("kind-guest-fixture", key.privateJwk, { alg: "EdDSA" });
    // This administrative session is never passed to a guest callback or broker.
    admin = createK8sClient(sessionFromKubeConfig(config, { namespaces: [namespace, foreignNamespace], ttlSec: 1800 }),
      { signal: AbortSignal.any([setupController.signal, AbortSignal.timeout(120_000)]), requestTimeoutMs: 20_000 });
    for (const name of [namespace, foreignNamespace]) {
      const created = await api(() => admin!.objects.create<KubernetesObject>({ apiVersion: "v1", kind: "Namespace", metadata: { name, labels } }));
      if (!created.metadata?.uid || created.metadata.name !== name || !Object.entries(labels).every(([k, v]) => created.metadata?.labels?.[k] === v)) throw new Error("The owned namespace creation was not confirmed.");
      ownedNamespaces.push({ name, uid: created.metadata.uid });
    }
    const serviceAccount = await api(() => admin!.objects.create<KubernetesObject>({ apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "guest-reader", namespace, labels }, automountServiceAccountToken: false } as KubernetesObject));
    if (!serviceAccount.metadata?.uid) throw new Error("The owned guest service account identity was not confirmed.");
    const serviceAccountUid = serviceAccount.metadata.uid;
    await api(() => admin!.objects.create({ apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role", metadata: { name: "guest-reader", namespace, labels },
      rules: [{ apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] },
        { apiGroups: [""], resources: ["serviceaccounts"], resourceNames: ["default"], verbs: ["get"] }] } as KubernetesObject));
    await api(() => admin!.objects.create({ apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding", metadata: { name: "guest-reader", namespace, labels },
      subjects: [{ kind: "ServiceAccount", name: "guest-reader", namespace }], roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "guest-reader" } } as KubernetesObject));
    await api(() => admin!.objects.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "guest-marker", namespace, labels },
      spec: { restartPolicy: "Never", activeDeadlineSeconds: 30, automountServiceAccountToken: false,
        securityContext: { runAsNonRoot: true, runAsUser: 65532, seccompProfile: { type: "RuntimeDefault" } },
        containers: [{ name: "marker", image, imagePullPolicy: "Never", command: ["/bin/sh", "-c", "exit 0"],
          resources: { requests: { cpu: "10m", memory: "8Mi" }, limits: { cpu: "50m", memory: "32Mi" } },
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] }, readOnlyRootFilesystem: true } }] } } as KubernetesObject));
    // Namespace controller creation is asynchronous; only a genuine 404 is retried.
    const accountDeadline = performance.now() + 10_000;
    for (;;) {
      try { await api(() => admin!.core.readNamespacedServiceAccount({ name: "default", namespace })); break; }
      catch (error) {
        if (!(error instanceof KindFixtureError) || error.httpStatus !== 404 || performance.now() >= accountDeadline) throw error;
        await wait(100, undefined, { signal: setupController.signal });
      }
    }
    const requestedAt = Date.now();
    const issued = await api(() => admin!.core.createNamespacedServiceAccountToken({ name: "guest-reader", namespace,
      body: { apiVersion: "authentication.k8s.io/v1", kind: "TokenRequest", metadata: { name: "guest-reader", namespace, uid: serviceAccountUid }, spec: { audiences: [], expirationSeconds: 600 } } }));
    const expiry = issued.status?.expirationTimestamp;
    tokenExpiresAt = expiry instanceof Date ? expiry.getTime() : NaN;
    if (issued.metadata?.uid !== serviceAccountUid || issued.metadata.name !== "guest-reader" || issued.metadata.namespace !== namespace
      || typeof issued.status?.token !== "string" || !issued.status.token || !Number.isFinite(tokenExpiresAt)
      || tokenExpiresAt <= Date.now() + 120_000 || tokenExpiresAt > requestedAt + 630_000) throw new Error("The bounded guest TokenRequest was not confirmed.");
    token = issued.status.token;
  }, 150_000);

  afterAll(async () => {
    setupController.abort();
    let failure = false;
    try {
      // Rebuild only an admin cleanup client from the already validated config;
      // current file must remain the explicit owning kind identity.
      if (ownedNamespaces.length) {
        const config = ownedSetupConfig();
        const cleanup = createK8sClient(sessionFromKubeConfig(config, { namespaces: ownedNamespaces.map(x => x.name), ttlSec: 300 }),
          { signal: AbortSignal.timeout(90_000), requestTimeoutMs: 15_000 });
        for (const owned of [...ownedNamespaces].reverse()) {
          try {
            const current = await api(() => cleanup.objects.read<KubernetesObject>({ apiVersion: "v1", kind: "Namespace", metadata: { name: owned.name } }));
            if (current.metadata?.uid !== owned.uid || !current.metadata.resourceVersion || !Object.entries(labels).every(([k, v]) => current.metadata?.labels?.[k] === v)) throw new Error("The owned namespace identity changed; deletion refused.");
            const resourceVersion = current.metadata.resourceVersion;
            await api(() => cleanup.objects.delete({ apiVersion: "v1", kind: "Namespace", metadata: { name: owned.name } }, undefined, undefined, undefined, undefined, "Foreground", { preconditions: { uid: owned.uid, resourceVersion } }));
            const deadline = performance.now() + 30_000;
            for (;;) {
              try { await api(() => cleanup.objects.read<KubernetesObject>({ apiVersion: "v1", kind: "Namespace", metadata: { name: owned.name } })); }
              catch (error) { if (error instanceof KindFixtureError && error.httpStatus === 404) break; throw error; }
              if (performance.now() >= deadline) throw new Error("Owned namespace removal was not independently confirmed.");
              await wait(100);
            }
          } catch { failure = true; }
        }
      }
    } catch { failure = true; }
    finally {
      token = undefined;
      for (const owned of ownedVaultRefs) { try { await vault.removeSecretAsync(owned.workspaceId, owned.ref); } catch { failure = true; } }
      try { await db?.close(); } catch { failure = true; }
      vi.unstubAllEnvs();
    }
    if (failure) throw new Error("The owned kind guest fixture cleanup was not fully confirmed; root cluster cleanup remains required.");
  }, 120_000);

  async function fixture(options: { workspaceId?: string; credentialRef?: string; owningToken?: boolean } = {}) {
    if (!db || !token || Date.now() >= tokenExpiresAt - 60_000) throw new Error("The owned kind guest fixture credentials are unavailable.");
    const workspaceId = options.workspaceId ?? `ws-kind-guest-${randomUUID()}`, credentialRef = options.credentialRef ?? `vault:kind/${randomUUID()}/GUEST_TOKEN`;
    const config: KubernetesConnectionConfig = { provider: "kubernetes", mode: "kubeconfig_ref", ...cluster, credentialRef, namespaces: [namespace] };
    const created = await repos.connections.create(db, { workspaceId, config, createdBy: "kind-guest-fixture" });
    const credentials = platformCredentialBroker(db);
    if (options.owningToken !== false) {
      ownedVaultRefs.push({ workspaceId, ref: credentialRef });
      await vault.putSecretAsync(workspaceId, credentialRef, token, "kind-guest-fixture");
      // Genuine HTTPS/default-ServiceAccount read through canonical onboarding.
      const verified = await credentials.verifyConnection(created.id, { workspaceId });
      expect(verified.ok).toBe(true);
      // Verification probes return their actual result; the scoped repository
      // records that outcome separately before the default broker's guest use.
      const recorded = await repos.connections.recordVerification(db, { workspaceId, id: created.id, ok: verified.ok, detail: verified.detail });
      expect(recorded?.workspaceId).toBe(workspaceId); expect(recorded?.id).toBe(created.id);
      expect(recorded?.status).toBe("verified"); expect(recorded?.verifiedAt).toBeTypeOf("string");
      expect(recorded?.verificationDetail).toBe(verified.detail);
    } else {
      // SQL-only negative fixture reaches tenant-vault lookup; never a claimed
      // cluster identity success. The owning positive control uses real onboarding.
      await repos.connections.recordVerification(db, { workspaceId, id: created.id, ok: true, detail: "Negative vault-scope fixture only." });
    }
    const connection = (await repos.connections.get(db, workspaceId, created.id))!;
    expect(connection.status).toBe("verified");
    const operationId = `op-kind-guest-${randomUUID()}`, environmentId = `env-kind-guest-${suffix}`, resourceId = `res-kind-guest-${randomUUID()}`;
    const now = Math.floor(Date.now() / 1000);
    const claims: CapabilityGrantClaims = { jti: randomUUID(), iss: "kind-guest-fixture", aud: "worker", sub: "user:kind-guest-fixture", iat: now - 1,
      exp: Math.min(now + 300, Math.floor(tokenExpiresAt / 1000)), cap: "container.list", op: operationId, digest: "d".repeat(64), ws: workspaceId, env: environmentId, res: resourceId };
    const jws = await signCapabilityGrant(claims, { signer });
    const grant = await verifyCapabilityGrant(jws, { audience: "worker", expectedCapability: "container.list", expectedOperationId: operationId, keys: [key.publicJwk] });
    const request = requestFor("container.list", { all: true }, { operationId,
      target: { workspaceId, environmentId, resourceId, address: "compute_instance/guest-marker", transport: "kubernetes", targetId: namespace }, timeoutSec: 20 });
    const sessionRequest: MachineSessionRequest = { operationId, operation: request.operation, target: request.target, grant };
    // No kubernetes resolver/test adapter, sandbox flag or API/client override.
    const provider = createMachineSessionProvider({ credentials, connection, grantJws: jws, signal: controller.signal });
    const driver = createKubernetesMachineDriver();
    const read = () => provider.withSession(sessionRequest, session => api(() => driver.execute(request, session, controller.signal)));
    return { workspaceId, credentialRef, connection, request, sessionRequest, provider, driver, read };
  }
  async function noTokenEvidence(workspaceId: string, value: unknown) {
    if (!db || !token) throw new Error("The kind guest evidence fixture is unavailable.");
    expect((JSON.stringify(value) ?? "").includes(token)).toBe(false);
    expect(JSON.stringify(await repos.events.list(db, workspaceId, { limit: 100 })).includes(token)).toBe(false);
    expect(JSON.stringify(await repos.connections.list(db, workspaceId, { includeRevoked: true })).includes(token)).toBe(false);
  }

  it("the default broker's owning vault token reads a real Pod and closes its guest handle", async () => {
    const f = await fixture(); let held!: KubernetesMachineSession;
    const result = await f.provider.withSession(f.sessionRequest, async value => {
      held = value as KubernetesMachineSession;
      expect(held.namespaces).toEqual([namespace]); expect(Object.isFrozen(held.namespaces)).toBe(true);
      expect((held.kubeConfig() as KubeConfig).getCurrentUser()?.name).toBe("zenith-user");
      expect(Date.parse(held.expiresAt) <= f.sessionRequest.grant.exp * 1000).toBe(true);
      return api(() => f.driver.execute(f.request, held, controller.signal));
    });
    expect(result.ok).toBe(true); expect(result.simulated).toBe(false);
    expect(result.data).toMatchObject({ containers: [expect.objectContaining({ pod: "guest-marker", namespace, name: "marker" })] });
    expect(() => held.kubeConfig()).toThrow("ended"); await noTokenEvidence(f.workspaceId, result);
  }, 60_000);

  it("foreign namespace machine scope and genuine API RBAC refuse without administrative fallback", async () => {
    const f = await fixture();
    await f.provider.withSession(f.sessionRequest, async value => {
      const session = value as KubernetesMachineSession;
      const foreign = { ...f.request, target: { ...f.request.target, targetId: foreignNamespace } };
      await expect(api(() => f.driver.execute(foreign, session, controller.signal))).rejects.toMatchObject({ machineCode: "denied" });
      // Independent real HTTPS authorization checks on the same guest credential.
      const guest = createK8sClient(session, { signal: controller.signal, requestTimeoutMs: 15_000 });
      await expect(api(() => guest.core.listNamespacedPod({ namespace: foreignNamespace }))).rejects.toMatchObject({ httpStatus: 403 });
      await expect(api(() => guest.core.listNamespacedSecret({ namespace }))).rejects.toMatchObject({ httpStatus: 403 });
      await expect(api(() => guest.core.listNode())).rejects.toMatchObject({ httpStatus: 403 });
      expect((await api(() => f.driver.execute(f.request, session, controller.signal))).ok).toBe(true);
    });
    await noTokenEvidence(f.workspaceId, await f.read());
  }, 90_000);

  it("a reduced live SQL namespace binding cannot reuse captured scope or root-admin identity", async () => {
    const f = await fixture();
    await db!.query("update platform.provider_connections set config=$3::text::jsonb where workspace_id=$1 and id=$2", [f.workspaceId, f.connection.id, JSON.stringify({ ...f.connection.config, namespaces: [] })]);
    expect((f.connection.config as KubernetesConnectionConfig).namespaces).toEqual([namespace]);
    await f.provider.withSession(f.sessionRequest, async value => {
      const session = value as KubernetesMachineSession; expect(session.namespaces).toEqual([]);
      await expect(api(() => f.driver.execute(f.request, session, controller.signal))).rejects.toMatchObject({ machineCode: "denied" });
    });
    expect((await (await fixture()).read()).ok).toBe(true);
  }, 60_000);

  it("live scoped SQL revocation refuses the stale verified capture before a guest callback", async () => {
    const f = await fixture(); expect((await f.read()).ok).toBe(true);
    await repos.connections.revoke(db!, f.workspaceId, f.connection.id);
    let entered = false;
    await expect(f.provider.withSession(f.sessionRequest, async () => { entered = true; })).rejects.toMatchObject({ code: "denied" });
    expect(entered).toBe(false);
    const events = await repos.events.list(db!, f.workspaceId);
    const denied = events.filter(event => event.workspaceId === f.workspaceId && event.correlationId === f.sessionRequest.operationId
      && event.type === "credential.denied" && event.data.connectionId === f.connection.id).at(-1);
    expect(denied).toBeDefined();
    expect(denied?.data.reason).toBe("connection_revoked");
    expect(denied?.operationId).toBeUndefined();
    await noTokenEvidence(f.workspaceId, events);
  }, 60_000);

  it("a foreign workspace cannot resolve the same-named owning vault token", async () => {
    const owning = await fixture(); expect((await owning.read()).ok).toBe(true);
    const foreign = await fixture({ credentialRef: owning.credentialRef, owningToken: false });
    expect((await vault.readSecretValueAsync(foreign.workspaceId, foreign.credentialRef)) === undefined).toBe(true);
    let entered = false;
    await expect(foreign.provider.withSession(foreign.sessionRequest, async () => { entered = true; })).rejects.toMatchObject({ code: "denied" });
    expect(entered).toBe(false); expect((await owning.read()).ok).toBe(true);
    await noTokenEvidence(foreign.workspaceId, await repos.events.list(db!, foreign.workspaceId));
  }, 90_000);

  it("removing the current owning vault value refuses; restoring that same token restores the real read", async () => {
    const f = await fixture(); expect((await f.read()).ok).toBe(true);
    await vault.removeSecretAsync(f.workspaceId, f.credentialRef);
    let entered = false;
    await expect(f.provider.withSession(f.sessionRequest, async () => { entered = true; })).rejects.toMatchObject({ code: "denied" });
    expect(entered).toBe(false);
    await vault.putSecretAsync(f.workspaceId, f.credentialRef, token!, "kind-guest-fixture");
    const result = await f.read(); expect(result.ok).toBe(true); await noTokenEvidence(f.workspaceId, result);
  }, 60_000);

  it("an invalid current vault token yields a genuine HTTP 401 instead of a root-admin fallback", async () => {
    const f = await fixture(); expect((await f.read()).ok).toBe(true);
    await vault.putSecretAsync(f.workspaceId, f.credentialRef, "invalid-guest-fixture-token", "kind-guest-fixture");
    await expect(f.read()).rejects.toMatchObject({ httpStatus: 401, machineCode: "transport_error" });
    await vault.putSecretAsync(f.workspaceId, f.credentialRef, token!, "kind-guest-fixture");
    expect((await f.read()).ok).toBe(true);
  }, 60_000);

  it("cancellation after a genuine owning read closes the default callback and retained accessor", async () => {
    const f = await fixture(); let held!: KubernetesMachineSession, readConfirmed = false;
    await expect(f.provider.withSession(f.sessionRequest, async value => {
      held = value as KubernetesMachineSession;
      readConfirmed = (await api(() => f.driver.execute(f.request, held, controller.signal))).ok;
      controller.abort(); expect(() => held.kubeConfig()).toThrow();
    })).rejects.toMatchObject({ code: "aborted" });
    expect(readConfirmed).toBe(true); expect(() => held.kubeConfig()).toThrow();
  }, 60_000);
});
