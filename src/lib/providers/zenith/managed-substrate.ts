/**
 * The implementation of the Zenith-managed substrate port (PROD-MAN-01).
 *
 * Pure composition over injected capabilities: it reads no environment and
 * imports neither the Kubernetes provider nor the vault. `src/lib/platform/
 * zenith-managed.ts` is the production composition root that binds
 * `ZENITH_MANAGED_*`, the platform credential vault and the Kubernetes
 * provider's session/toolkit into this. A test passes different capabilities;
 * the CODE PATH is the same, so there is no test-only branch here.
 *
 * What it adds over `openZenithSession`:
 *   - the tenant is resolved from the control plane (never supplied by the
 *     caller), so a session can only be requested for a workspace/environment
 *     pair the control plane knows, with the slugs and tier IT holds;
 *   - an unconfigured substrate refuses every operation by name instead of
 *     failing deep inside a driver;
 *   - the build namespace has its own session, separate from every tenant's.
 */
import type { KubernetesConnectionConfig, KubernetesSession } from "@/lib/credentials/types";
import type { ManagedDatabaseProvider } from "./database";
import { createVaultDatabaseRuntime } from "./database-factory";
import { unavailableDatabaseProvider } from "./database";
import type { KubernetesToolkit } from "./k8s-port";
import { readBuildConfig, type ManagedBuildConfigResult } from "./managed-build-config";
import {
  ManagedSubstrateError,
  type ManagedBuildAvailability,
  type ManagedDatabaseRuntimeInput,
  type ManagedRegistryPort,
  type ManagedSessionRequest,
  type ManagedSubstratePort,
  type ManagedSubstrateStatus,
  type TenantResolver,
} from "./managed-port";
import { createManagedRegistry } from "./managed-registry";
import { openZenithSession, type ZenithSession } from "./session";
import { describeSubstrate, readSubstrateConfig, substrateConnectionConfig, type SubstrateConfig, type ZenithEnv, type ZenithSubstrate } from "./substrate";
import { ZenithError } from "./types";
import type { AsyncSecretsBackend } from "@/lib/secrets/backend";
import type { ServingInputs } from "@/lib/managed-serving/platform-store";
import type { ObjectStoragePorts, StorageKeyStore } from "@/lib/managed-serving/storage";
import { createIamAdminPort } from "@/lib/managed-serving/storage";
import type { StorageCredentialSink } from "@/lib/secrets/resolver";

export interface ManagedSubstrateDeps {
  /** Result of `readSubstrateConfig(env)`. */
  config: SubstrateConfig;
  /** Result of `readBuildConfig(env)`. */
  build: ManagedBuildConfigResult;
  toolkit: KubernetesToolkit;
  tenants: TenantResolver;
  /** The Kubernetes provider's `createKubernetesSession` with the PLATFORM credential resolver already bound. */
  createKubernetesSession(config: KubernetesConnectionConfig, signal?: AbortSignal): Promise<KubernetesSession>;
  /** Resolves platform-scope `vault:` references (the database API key). Never a workload resolver. */
  resolvePlatformCredential(ref: string, signal?: AbortSignal): Promise<string>;
  fetch: typeof fetch;
  /** Vault backend for per-tenant connection secrets; default the process backend. */
  backend?: AsyncSecretsBackend;
  servingInputs?: NonNullable<ManagedSubstratePort["servingInputs"]>;
  storageKeyStore?(tenant: { workspaceId: string; environmentId: string }): StorageKeyStore;
  /** Default composition requires readback of separately approved isolation before opening sessions. */
  assertTenantReady?(tenant: Awaited<ReturnType<TenantResolver["resolve"]>>, signal?: AbortSignal): Promise<KubernetesSession | void>;
}

export function createManagedSubstrate(deps: ManagedSubstrateDeps): ManagedSubstratePort {
  const { config } = deps;
  const registry: ManagedRegistryPort | undefined = config.configured && config.substrate.registry ? createManagedRegistry(config.substrate.registry) : undefined;

  const requireSubstrate = (): ZenithSubstrate => {
    if (!config.configured) throw new ManagedSubstrateError("not_configured", config.message);
    return config.substrate;
  };

  const sessionError = (e: unknown): never => {
    if (e instanceof ManagedSubstrateError || e instanceof ZenithError) throw e;
    // Provider and vault errors are fixed-message by construction; never forward their text from here.
    throw new ManagedSubstrateError("session_refused", "The managed cluster session could not be opened.");
  };

  function storageFor(tenant: { workspaceId: string; environmentId: string }, sink: StorageCredentialSink): ObjectStoragePorts | undefined {
    const storage = requireSubstrate().objectStorage;
    if (!storage?.adminCredentialRef || !deps.storageKeyStore) return undefined;
    return {
      admin: createIamAdminPort({ credentialRef: storage.adminCredentialRef, region: storage.region ?? "us-east-1", ...(storage.iamEndpoint ? { endpoint: storage.iamEndpoint } : {}) }, { resolveSecret: (ref) => deps.resolvePlatformCredential(ref) }),
      sink, store: deps.storageKeyStore(tenant),
    };
  }

  const servingInputs = (tenant: { workspaceId: string; environmentId: string }): Promise<ServingInputs> => deps.servingInputs?.(tenant) ?? Promise.resolve({ verifiedDomains: [], retiredDomains: [] });

  async function openSession(request: ManagedSessionRequest): Promise<ZenithSession> {
    const substrate = requireSubstrate();
    const tenant = await deps.tenants.resolve({ workspaceId: request.workspaceId, environmentId: request.environmentId }, request.signal);
    if (tenant.workspaceId !== request.workspaceId || tenant.environmentId !== request.environmentId) {
      throw new ManagedSubstrateError("tenant_invalid", "The resolved tenant does not match the requested workspace and environment.");
    }
    const databases: ManagedDatabaseProvider = request.databases ?? unavailableDatabaseProvider("No managed database scope was supplied for this session.");
    try {
      const kubernetes = await deps.assertTenantReady?.(tenant, request.signal);
      const serving = await servingInputs(tenant);
      const storage = request.storage ?? storageFor(tenant, {
        async exists() { throw new ManagedSubstrateError("session_refused", "Storage credential reads require the reviewed environment resource scope."); },
        async put() { throw new ManagedSubstrateError("session_refused", "Storage credential writes require the reviewed environment resource scope."); },
      });
      return await openZenithSession(tenant, { substrate, createKubernetesSession: (c, s) => deps.createKubernetesSession(c, s ?? request.signal), ...(kubernetes ? { kubernetes } : {}), databases, customDomains: serving.verifiedDomains, retiredDomains: serving.retiredDomains, ...(storage ? { storage } : {}) }, request.signal);
    } catch (e) {
      return sessionError(e);
    }
  }

  const build = deps.build;
  const buildAvailability = (): ManagedBuildAvailability => {
    if (!config.configured) return { available: false, reason: config.message };
    if (!config.substrate.registry) return { available: false, reason: "Managed builds need a Zenith-operated registry: set ZENITH_MANAGED_REGISTRY." };
    if (!build.configured) return { available: false, reason: build.reason };
    return { available: true, namespace: build.config.namespace, builderImage: build.config.builderImage };
  };

  const port: ManagedSubstratePort = {
    id: "zenith-managed",
    status(): ManagedSubstrateStatus {
      return { configured: config.configured, description: describeSubstrate(config), build: buildAvailability() };
    },
    substrate: requireSubstrate,
    toolkit: deps.toolkit,
    tenants: deps.tenants,
    servingInputs,
    registry: () => registry,
    buildConfig() {
      const availability = buildAvailability();
      if (!availability.available || !build.configured) throw new ManagedSubstrateError("build_unavailable", availability.available ? "Managed builds are not configured." : availability.reason);
      return build.config;
    },
    openSession,
    async withSession(request, fn) {
      const session = await openSession(request);
      return fn(session);
    },
    databaseRuntime(input: ManagedDatabaseRuntimeInput) {
      const substrate = requireSubstrate();
      const runtime = createVaultDatabaseRuntime(
        { workspaceId: input.workspaceId, projectId: input.projectId, environmentId: input.environmentId, substrate, nodes: input.nodes },
        { fetch: deps.fetch, resolveSecret: async (ref) => deps.resolvePlatformCredential(ref), ...(deps.backend ? { backend: deps.backend } : {}) },
      );
      const storage = storageFor(input, runtime.storageCredentials);
      return { ...runtime, ...(storage ? { storage } : {}) };
    },
    async withBuildSession(request, fn) {
      const substrate = requireSubstrate();
      const availability = buildAvailability();
      if (!availability.available) throw new ManagedSubstrateError("build_unavailable", availability.reason);
      // The environment must exist in the control plane; the build session itself is not tenant-scoped.
      await deps.tenants.resolve({ workspaceId: request.workspaceId, environmentId: request.environmentId }, request.signal);
      const namespace = request.namespace ?? availability.namespace;
      if (namespace !== availability.namespace) throw new ManagedSubstrateError("build_refused", "Builds run only in the configured platform build namespace.");
      let session: KubernetesSession;
      try {
        session = await deps.createKubernetesSession(substrateConnectionConfig(substrate, namespace), request.signal);
      } catch (e) {
        return sessionError(e);
      }
      return fn(session, namespace);
    },
  };
  return port;
}

/** Read both configs from one environment object (the only place the pair is read together). */
export function readManagedConfigs(env: ZenithEnv): { config: SubstrateConfig; build: ManagedBuildConfigResult } {
  return { config: readSubstrateConfig(env), build: readBuildConfig(env) };
}
