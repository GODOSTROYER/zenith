/**
 * PROD-MAN-01 contract tests for the Zenith-managed substrate PORT.
 *
 * CONTRACT-LEVEL: the Kubernetes session factory, tenant resolver and credential
 * resolver are recording doubles. These tests prove what the port decides (which
 * configuration it accepts, which tenant and namespaces a session is scoped to,
 * what it refuses and how it words a refusal), not that a cluster accepts the
 * session. tests/providers/zenith/managed-kind.test.ts (gated) runs the same code
 * against a real kind cluster.
 */
import { describe, expect, it } from "vitest";
import type { AsyncSecretsBackend } from "@/lib/secrets/backend";
import type { KubernetesConnectionConfig, KubernetesSession } from "@/lib/credentials/types";
import { BUILD_ENV_VARS, readBuildConfig } from "@/lib/providers/zenith/managed-build-config";
import { ManagedSubstrateError, type ManagedSessionRequest, type TenantResolver } from "@/lib/providers/zenith/managed-port";
import { createManagedRegistry, registrySegment } from "@/lib/providers/zenith/managed-registry";
import { createManagedSubstrate, readManagedConfigs, type ManagedSubstrateDeps } from "@/lib/providers/zenith/managed-substrate";
import { tenantNamespace } from "@/lib/providers/zenith/tenancy";
import type { ZenithEnv } from "@/lib/providers/zenith/substrate";
import { FULL_ENV, TENANT } from "./support";

const BUILDER = `registry.example.com/zenith/builder@sha256:${"a".repeat(64)}`;
const REF: ManagedSessionRequest = { workspaceId: TENANT.workspaceId, environmentId: TENANT.environmentId };

/** A vault that holds nothing: the database runtime is built, never exercised, in these tests. */
const emptyVault: AsyncSecretsBackend = { kind: "file", get: async () => undefined, list: async () => [], put: async () => undefined, putIfAbsent: async (_w, record) => record, remove: async () => undefined };

function fakeSession(config: KubernetesConnectionConfig): KubernetesSession {
  return { provider: "kubernetes", server: config.server, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), kubeConfig: () => ({}) } as unknown as KubernetesSession;
}

function setup(env: ZenithEnv = FULL_ENV, over: Partial<ManagedSubstrateDeps> = {}) {
  const opened: KubernetesConnectionConfig[] = [];
  const resolved: string[] = [];
  const looked: { workspaceId: string; environmentId: string }[] = [];
  const tenants: TenantResolver = {
    resolve: async (ref) => {
      looked.push(ref);
      return { ...TENANT, workspaceId: ref.workspaceId, environmentId: ref.environmentId };
    },
  };
  const port = createManagedSubstrate({
    ...readManagedConfigs(env),
    toolkit: {} as unknown as ManagedSubstrateDeps["toolkit"],
    tenants,
    createKubernetesSession: async (config) => {
      opened.push(config);
      return fakeSession(config);
    },
    resolvePlatformCredential: async (ref) => {
      resolved.push(ref);
      return "unused";
    },
    fetch: globalThis.fetch,
    backend: emptyVault,
    ...over,
  });
  return { port, opened, resolved, looked };
}

/** The ManagedSubstrateError a promise rejects with; fails the test when it does not reject. */
async function refusalOf(promise: Promise<unknown>): Promise<ManagedSubstrateError> {
  try { await promise; } catch (e) { return e as ManagedSubstrateError; }
  throw new Error("expected a refusal");
}

const withBuilder: ZenithEnv = { ...FULL_ENV, ZENITH_MANAGED_BUILDER_IMAGE: BUILDER };

describe("an unconfigured substrate refuses by name", () => {
  it("reports unconfigured and names every missing variable", async () => {
    const { port } = setup({});
    const status = port.status();
    expect(status.configured).toBe(false);
    expect(status.description.warnings.join(" ")).toContain("ZENITH_MANAGED_CLUSTER_SERVER");
    expect(() => port.substrate()).toThrowError(ManagedSubstrateError);
    try {
      port.substrate();
    } catch (e) {
      expect((e as ManagedSubstrateError).code).toBe("not_configured");
      expect((e as ManagedSubstrateError).message).toContain("ZENITH_MANAGED_KUBECONFIG_REF");
      expect((e as ManagedSubstrateError).message).toContain("ZENITH_MANAGED_APP_DOMAIN");
    }
  });

  it("refuses sessions, build sessions and database scope without opening anything", async () => {
    const { port, opened, looked } = setup({});
    await expect(port.openSession(REF)).rejects.toMatchObject({ code: "not_configured" });
    await expect(port.withSession(REF, async () => 1)).rejects.toMatchObject({ code: "not_configured" });
    await expect(port.withBuildSession(REF, async () => 1)).rejects.toMatchObject({ code: "not_configured" });
    expect(() => port.databaseRuntime({ ...REF, projectId: "p", nodes: [] })).toThrowError(ManagedSubstrateError);
    expect(opened).toEqual([]);
    expect(looked).toEqual([]);
    expect(port.registry()).toBeUndefined();
  });

  it("an inline credential is refused by variable name and never stored", () => {
    const { port } = setup({ ...FULL_ENV, ZENITH_MANAGED_KUBECONFIG_REF: "apiVersion: v1\nkind: Config" });
    expect(port.status().configured).toBe(false);
    expect(port.status().description.warnings.join(" ")).toContain("ZENITH_MANAGED_KUBECONFIG_REF");
  });
});

describe("a tenant-scoped managed session", () => {
  it("is scoped to exactly the tenant namespace, with the platform credential as a reference", async () => {
    const { port, opened, looked } = setup();
    const session = await port.openSession(REF);
    expect(looked).toEqual([REF]);
    expect(session.provider).toBe("zenith");
    expect(session.tenant).toMatchObject({ workspaceId: TENANT.workspaceId, environmentId: TENANT.environmentId, workspaceSlug: "acme" });
    const ns = tenantNamespace(TENANT.workspaceId, TENANT.environmentId);
    expect(opened[0]).toMatchObject({ provider: "kubernetes", mode: "kubeconfig_ref", namespaces: [ns], credentialRef: "vault:zenith-managed/kubeconfig" });
    // gateway_api mode: a SEPARATE operator scope that can only reach the gateway namespace
    expect(opened[1]?.namespaces).toEqual(["zenith-gateway"]);
    expect(opened).toHaveLength(2);
  });

  it("never serializes a credential", async () => {
    const { port } = setup();
    const session = await port.openSession(REF);
    const text = JSON.stringify(session);
    expect(text).not.toMatch(/token|vault:|kubeconfig/i);
    expect(JSON.parse(text)).toMatchObject({ provider: "zenith", workspaceId: TENANT.workspaceId, environmentId: TENANT.environmentId });
  });

  it("takes the slugs and tier from the control plane, not from the request", async () => {
    const { port } = setup(FULL_ENV, {
      tenants: { resolve: async (ref) => ({ ...TENANT, ...ref, workspaceSlug: "from-control-plane", planTier: "pro" }) },
    });
    const session = await port.openSession({ ...REF, ...({ workspaceSlug: "attacker", planTier: "free" } as object) });
    expect(session.tenant.workspaceSlug).toBe("from-control-plane");
    expect(session.tenant.planTier).toBe("pro");
  });

  it("refuses when the control plane answers with a different tenant", async () => {
    const { port, opened } = setup(FULL_ENV, { tenants: { resolve: async () => ({ ...TENANT, environmentId: "env_other" }) } });
    await expect(port.openSession(REF)).rejects.toMatchObject({ code: "tenant_invalid" });
    expect(opened).toEqual([]);
  });

  it("passes an unresolved tenant through by its own code", async () => {
    const { port } = setup(FULL_ENV, { tenants: { resolve: async () => { throw new ManagedSubstrateError("tenant_unresolved", "unknown"); } } });
    await expect(port.withSession(REF, async () => 1)).rejects.toMatchObject({ code: "tenant_unresolved" });
  });

  it("words a provider failure with a fixed message that never echoes the cause", async () => {
    const secret = ["tok", "en-from-the-vault"].join("");
    const { port } = setup(FULL_ENV, { createKubernetesSession: async () => { throw new Error(`cannot use ${secret}`); } });
    const error = await refusalOf(port.openSession(REF));
    expect(error).toBeInstanceOf(ManagedSubstrateError);
    expect(error.code).toBe("session_refused");
    expect(error.message).not.toContain(secret);
  });

  it("withSession gives the session to the callback and returns its result", async () => {
    const { port } = setup();
    await expect(port.withSession(REF, async (s) => s.tenant.environmentId)).resolves.toBe(TENANT.environmentId);
  });

  it("an ingress-mode substrate has no gateway session", async () => {
    const { port, opened } = setup({ ...FULL_ENV, ZENITH_MANAGED_GATEWAY_MODE: "ingress", ZENITH_MANAGED_INGRESS_CLASS: "nginx" });
    const session = await port.openSession(REF);
    expect(session.gatewayKubernetes).toBeUndefined();
    expect(opened).toHaveLength(1);
  });

  it("carries the supplied database port, or one that answers unavailable", async () => {
    const { port } = setup();
    const without = await port.openSession(REF);
    expect(without.databases.availability().available).toBe(false);
    const runtime = port.databaseRuntime({ ...REF, projectId: "p1", nodes: [] });
    const withDb = await port.openSession({ ...REF, databases: runtime.databases });
    expect(withDb.databases).toBe(runtime.databases);
    expect(withDb.databases.availability().available).toBe(true);
  });
});

describe("the managed build session", () => {
  it("is unavailable until a builder image and a registry are configured, and says which", async () => {
    const { port } = setup();
    const status = port.status();
    expect(status.build.available).toBe(false);
    if (!status.build.available) expect(status.build.reason).toContain("ZENITH_MANAGED_BUILDER_IMAGE");
    await expect(port.withBuildSession(REF, async () => 1)).rejects.toMatchObject({ code: "build_unavailable" });
    expect(() => port.buildConfig()).toThrowError(ManagedSubstrateError);

    const noRegistry = setup({ ...withBuilder, ZENITH_MANAGED_REGISTRY: "" });
    const s2 = noRegistry.port.status();
    expect(s2.build.available).toBe(false);
    if (!s2.build.available) expect(s2.build.reason).toContain("ZENITH_MANAGED_REGISTRY");
  });

  it("opens a session for the platform build namespace only, never a tenant namespace", async () => {
    const { port, opened, looked } = setup(withBuilder);
    expect(port.status().build).toEqual({ available: true, namespace: "zenith-build", builderImage: BUILDER });
    const namespace = await port.withBuildSession(REF, async (_session, ns) => ns);
    expect(namespace).toBe("zenith-build");
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ namespaces: ["zenith-build"], credentialRef: "vault:zenith-managed/kubeconfig" });
    expect(looked).toEqual([REF]); // the environment must exist in the control plane
    await expect(port.withBuildSession({ ...REF, namespace: tenantNamespace(TENANT.workspaceId, TENANT.environmentId) }, async () => 1)).rejects.toMatchObject({ code: "build_refused" });
  });
});

describe("build configuration", () => {
  it("lists every variable it reads", () => {
    expect(BUILD_ENV_VARS).toEqual(["ZENITH_MANAGED_BUILD_NAMESPACE", "ZENITH_MANAGED_BUILDER_IMAGE", "ZENITH_MANAGED_BUILD_PUSH_SECRET", "ZENITH_MANAGED_BUILD_REGISTRY_INSECURE"]);
  });

  it("has no default builder: the toolchain that runs tenant Dockerfiles is the operator's recorded choice", () => {
    const result = readBuildConfig({});
    expect(result.configured).toBe(false);
    if (!result.configured) expect(result.reason).toContain("ZENITH_MANAGED_BUILDER_IMAGE");
  });

  it("refuses a mutable tag", () => {
    const result = readBuildConfig({ ZENITH_MANAGED_BUILDER_IMAGE: "registry.example.com/zenith/builder:latest" });
    expect(result.configured).toBe(false);
    if (!result.configured) expect(result.reason).toContain("digest");
  });

  it("accepts a digest-pinned builder and applies defaults and optional values", () => {
    expect(readBuildConfig({ ZENITH_MANAGED_BUILDER_IMAGE: BUILDER })).toEqual({
      configured: true,
      config: { namespace: "zenith-build", builderImage: BUILDER, insecureRegistry: false, serviceAccount: "zenith-builder" },
    });
    const full = readBuildConfig({ ZENITH_MANAGED_BUILDER_IMAGE: BUILDER, ZENITH_MANAGED_BUILD_NAMESPACE: "builds", ZENITH_MANAGED_BUILD_PUSH_SECRET: "push", ZENITH_MANAGED_BUILD_REGISTRY_INSECURE: "1" });
    expect(full).toMatchObject({ configured: true, config: { namespace: "builds", pushSecret: "push", insecureRegistry: true } });
  });

  it("refuses malformed optional values by name", () => {
    expect(readBuildConfig({ ZENITH_MANAGED_BUILDER_IMAGE: BUILDER, ZENITH_MANAGED_BUILD_NAMESPACE: "Not_A_Label" })).toMatchObject({ configured: false });
    expect(readBuildConfig({ ZENITH_MANAGED_BUILDER_IMAGE: BUILDER, ZENITH_MANAGED_BUILD_REGISTRY_INSECURE: "yes" })).toMatchObject({ configured: false });
  });
});

describe("the Zenith-operated registry policy", () => {
  const registry = createManagedRegistry({ host: "registry.example.com", repositoryPrefix: "zenith" });
  const digest = `sha256:${"b".repeat(64)}`;
  const other = { workspaceId: "ws_other", environmentId: "env_other" };

  it("lays repositories out per tenant", () => {
    expect(registry.tenantRepositoryRoot(TENANT)).toBe(`registry.example.com/zenith/${registrySegment(TENANT.workspaceId)}/${registrySegment(TENANT.environmentId)}`);
    expect(registry.repositoryFor(TENANT, "web")).toBe(`${registry.tenantRepositoryRoot(TENANT)}/web`);
  });

  it("derives injectively: an id that is not a path component hashes, valid ids pass through", () => {
    expect(registrySegment("abc123")).toBe("abc123");
    expect(registrySegment("Has_Upper")).toMatch(/^h-[0-9a-f]{20}$/);
    expect(registrySegment("a/b")).not.toBe(registrySegment("a%2Fb"));
    expect(registrySegment("h-aaaaaaaaaaaaaaaaaaaa")).toMatch(/^h-[0-9a-f]{20}$/);
  });

  it("owns a pinned image only inside the tenant's own repositories", () => {
    const own = `${registry.repositoryFor(TENANT, "web")}@${digest}`;
    expect(registry.ownsPinnedImage(TENANT, own)).toBe(true);
    expect(registry.ownsPinnedImage(other, own)).toBe(false);
    expect(registry.ownsPinnedImage(TENANT, `${registry.repositoryFor(TENANT, "web")}:latest`)).toBe(false);
    expect(registry.ownsPinnedImage(TENANT, `${registry.repositoryFor(TENANT, "web")}@sha256:short`)).toBe(false);
    expect(registry.ownsPinnedImage(TENANT, `${registry.tenantRepositoryRoot(TENANT)}/a/b@${digest}`)).toBe(false);
    expect(registry.ownsPinnedImage(TENANT, `docker.io/library/busybox@${digest}`)).toBe(false);
  });

  it("refuses a service name that is not a repository name, and knows its own host", () => {
    expect(() => registry.repositoryFor(TENANT, "Web/../x")).toThrowError(ManagedSubstrateError);
    expect(registry.isManagedHost(`registry.example.com/anything@${digest}`)).toBe(true);
    expect(registry.isManagedHost(`registry.example.com.evil.test/x@${digest}`)).toBe(false);
  });
});


describe("managed serving assembly", () => {
  it("loads current domain proof and retirement state for every session", async () => {
    let verifiedDomains = ["first.customer.example"];
    const scopes: unknown[] = [];
    const { port } = setup(FULL_ENV, { servingInputs: async (tenant) => { scopes.push(tenant); return { verifiedDomains, retiredDomains: ["retired.customer.example"] }; } });
    expect(await port.openSession(REF)).toMatchObject({ customDomains: ["first.customer.example"], retiredDomains: ["retired.customer.example"] });
    verifiedDomains = ["second.customer.example"];
    expect(await port.openSession(REF)).toMatchObject({ customDomains: ["second.customer.example"] });
    expect(scopes).toEqual([expect.objectContaining(REF), expect.objectContaining(REF)]);
  });

  it("refuses a session before credential opening when domain proof cannot be read", async () => {
    const { port, opened } = setup(FULL_ENV, { servingInputs: async () => { throw new Error("store unavailable"); } });
    await expect(port.openSession(REF)).rejects.toMatchObject({ code: "session_refused" });
    expect(opened).toEqual([]);
  });

  it("composes an environment-bound object-store runtime and passes it into the managed session", async () => {
    const scopes: unknown[] = [];
    const store = { active: async () => null, known: async () => [], record: async () => { throw new Error("unused"); }, markRevoked: async () => {} };
    const { port } = setup({ ...FULL_ENV, ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CREDENTIAL_REF: "vault:storage-admin" }, {
      storageKeyStore: (tenant) => { scopes.push(tenant); return store; },
    });
    const runtime = port.databaseRuntime({ ...REF, projectId: "p1", nodes: [] });
    expect(runtime.storage?.admin.availability()).toMatchObject({ available: true });
    expect(runtime.storage?.store).toBe(store);
    const session = await port.openSession({ ...REF, storage: runtime.storage });
    expect(session.storage).toBe(runtime.storage);
    expect(scopes).toEqual([expect.objectContaining(REF)]);
    await expect(runtime.storage!.sink.put("vault:generated/foreign/object/data/storage-secret", "unused")).rejects.toThrow();
  });

  it("reuses the exact tenant session whose isolation access was checked", async () => {
    const checked = fakeSession({ provider: "kubernetes", mode: "kubeconfig_ref", server: "https://cluster.example", credentialRef: "vault:checked", namespaces: [tenantNamespace(REF.workspaceId, REF.environmentId)] });
    const { port, opened } = setup(FULL_ENV, { assertTenantReady: async () => checked });
    expect((await port.openSession(REF)).kubernetes).toBe(checked);
    expect(opened).toHaveLength(1);
    expect(opened[0].namespaces).toEqual(["zenith-gateway"]);
  });

  it("uses per-tenant workload credentials and a separate gateway-only platform session", async () => {
    const { port, opened } = setup({ ...FULL_ENV, ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX: "vault:operators" });
    await port.openSession(REF);
    expect(opened).toHaveLength(2);
    expect(opened[0].credentialRef).toBe(`vault:operators/${tenantNamespace(REF.workspaceId, REF.environmentId)}`);
    expect(opened[0].namespaces).toEqual([tenantNamespace(REF.workspaceId, REF.environmentId)]);
    expect(opened[1].credentialRef).toBe(FULL_ENV.ZENITH_MANAGED_KUBECONFIG_REF);
    expect(opened[1].namespaces).toEqual(["zenith-gateway"]);
  });
});
