/**
 * The DEFAULT composition of the Zenith-managed substrate (PROD-MAN-01): the one
 * place `ZENITH_MANAGED_*`, the platform credential vault, the control-plane
 * tenant lookup and the Kubernetes provider are bound into a `ManagedSubstratePort`.
 *
 * `composeExecutionActivities` calls `createDefaultManagedSubstrate` and hands the
 * result to execution (sessions, plan/apply, release, teardown), to the release
 * ports (builds, rollouts, migrations) and to the source hand-off. No caller has to
 * inject anything: an unconfigured substrate is a port that refuses every
 * operation by variable name. Tests and the kind acceptance harness build the
 * same port with different inputs (a local cluster's values); they do not use a
 * different code path.
 *
 * Platform credentials. The operator's cluster credential and the managed-database
 * API key are `vault:` references resolved from the PLATFORM scope of the encrypted
 * vault (`ZENITH_MANAGED_VAULT_SCOPE`, default `zenith-platform`): a reserved
 * workspace id no customer workspace can have, so no tenant resolver can read it
 * and the platform resolver can read nothing else. Values are written into that
 * scope by an operator tool (`scripts/managed/seed-platform-vault.ts`), never
 * through any tenant surface.
 *
 * Tenants. A tenant is resolved from the product store through the same
 * `ProductPort` the execution worker uses (workspace slug, environment id). The
 * environment id is the environment segment of its hostnames: it is globally
 * unique and already a DNS-safe label, whereas names are neither. The plan tier
 * comes from its billing assignment when billing is managed. With billing disabled,
 * `ZENITH_MANAGED_DEFAULT_PLAN` (default `free`) is the operator capacity tier.
 */
import { billingConfigFromEnv } from "@/lib/billing/config";
import { getAccount } from "@/lib/billing/store";
import { getPlan, isPlanId } from "@/lib/billing/plans";
import { createBuildCustody, readBuildProfiles } from "@/lib/providers/kubernetes/build/custody";
import { readSecretValueAsync } from "@/lib/secrets";
import { isVaultRef } from "@/lib/secrets/refs";
import type { ProductPort } from "@/lib/execution/ports";
import { createProductPort, ProductNotFoundError } from "@/lib/execution/product-port";
import { createKubernetesSession } from "@/lib/providers/kubernetes";
import { ManagedSubstrateError, type ManagedSubstratePort, type PlatformCredentialResolver, type TenantResolver } from "@/lib/providers/zenith/managed-port";
import { createManagedSubstrate, readManagedConfigs } from "@/lib/providers/zenith/managed-substrate";
import { isHostLabel, type ZenithEnv } from "@/lib/providers/zenith/substrate";
import { PLAN_TIERS, type PlanTier } from "@/lib/providers/zenith/types";
import { createKubernetesToolkit } from "./kubernetes-toolkit";
import { platformDb, repos } from "@/lib/controlplane/db";
import type { Sql } from "@/lib/controlplane/types";
import { loadServingInputs, platformStorageKeyStore } from "@/lib/managed-serving/platform-store";
import { assertManagedOperatorConfigured, assertManagedTenantReady, readOnlyManagedPlanningSession } from "./zenith-onboarding";
import { createTenantIsolationProvisioner } from "@/lib/execution/tenant-isolation";
import { createGuestClusterPort } from "@/lib/providers/kubernetes/guest";
import { openZenithSession } from "@/lib/providers/zenith/session";
import { substrateConnectionConfig } from "@/lib/providers/zenith/substrate";
import { tenantNamespace } from "@/lib/providers/zenith/tenancy";
import { asyncSecretsBackend, KEY_VERSION, type AsyncSecretsBackend } from "@/lib/secrets/backend";
import { unavailableDatabaseProvider } from "@/lib/providers/zenith/database";
import { vaultCipherFromEnv } from "@/lib/secrets";

/** Reserved workspace id of the platform credential scope. */
export const DEFAULT_PLATFORM_VAULT_SCOPE = "zenith-platform";

const SCOPE_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

export function platformVaultScope(env: ZenithEnv): string {
  const raw = env.ZENITH_MANAGED_VAULT_SCOPE?.trim();
  const scope = raw === undefined || raw === "" ? DEFAULT_PLATFORM_VAULT_SCOPE : raw;
  if (!SCOPE_RE.test(scope)) throw new ManagedSubstrateError("not_configured", "ZENITH_MANAGED_VAULT_SCOPE must be 1-200 characters of letters, digits, '_', '.', ':' or '-'.");
  return scope;
}

export interface PlatformCredentialDeps {
  scope: string;
  /** default: the encrypted vault's async read (`readSecretValueAsync`) */
  read?: (scope: string, ref: string) => Promise<string | undefined>;
}

/** Resolves `vault:` references from ONE platform scope. Fixed-message failures: a reference name is not echoed. */
export function createPlatformCredentialResolver(deps: PlatformCredentialDeps): PlatformCredentialResolver {
  const read = deps.read ?? readSecretValueAsync;
  return {
    async resolve(ref) {
      if (typeof ref !== "string" || !isVaultRef(ref)) throw new ManagedSubstrateError("credential_unavailable", "A platform credential must be a vault: reference.");
      let value: string | undefined;
      try { value = await read(deps.scope, ref); }
      catch { throw new ManagedSubstrateError("credential_unavailable", "The platform credential store could not be read."); }
      if (!value) throw new ManagedSubstrateError("credential_unavailable", "A platform credential is not present in the platform vault scope; seed it with scripts/managed/seed-platform-vault.ts.");
      return value;
    },
  };
}

export interface ProductTenantOptions {
  /** plan tier of every managed workspace until billing supplies one; default `free` */
  defaultPlanTier?: PlanTier;
  /** Production composition supplies the workspace billing assignment in managed billing mode. */
  loadPlanTier?: (workspaceId: string) => Promise<PlanTier>;
}

/** Tenants from the control plane's product store. Never trusts a caller's slugs or tier. */
export function createProductTenantResolver(product: Pick<ProductPort, "loadContext">, options: ProductTenantOptions = {}): TenantResolver {
  const planTier = options.defaultPlanTier ?? "free";
  return {
    async resolve(ref) {
      let context: Awaited<ReturnType<ProductPort["loadContext"]>>;
      try { context = await product.loadContext({ workspaceId: ref.workspaceId, environmentId: ref.environmentId }); }
      catch (err) {
        if (err instanceof ProductNotFoundError) throw new ManagedSubstrateError("tenant_unresolved", "The workspace or environment is not known to the control plane.");
        throw new ManagedSubstrateError("tenant_unresolved", "The tenant could not be resolved from the control plane.");
      }
      if (context.workspace.id !== ref.workspaceId || context.environment.id !== ref.environmentId) throw new ManagedSubstrateError("tenant_invalid", "The control plane returned a different tenant than requested.");
      const workspaceSlug = context.workspace.slug;
      const environmentSlug = context.environment.id.toLowerCase() === context.environment.id ? context.environment.id : "";
      if (!isHostLabel(workspaceSlug)) throw new ManagedSubstrateError("tenant_invalid", "The workspace slug is not a valid DNS label, so it cannot form managed hostnames.");
      if (!isHostLabel(environmentSlug)) throw new ManagedSubstrateError("tenant_invalid", "The environment id is not a valid lowercase DNS label, so it cannot form managed hostnames.");
      const assignedTier = options.loadPlanTier ? await options.loadPlanTier(ref.workspaceId) : planTier;
      return { workspaceId: ref.workspaceId, environmentId: ref.environmentId, workspaceSlug, environmentSlug, planTier: assignedTier };
    },
  };
}

export function planTierOf(env: ZenithEnv): PlanTier {
  const raw = env.ZENITH_MANAGED_DEFAULT_PLAN?.trim();
  if (raw === undefined || raw === "") return "free";
  if ((PLAN_TIERS as readonly string[]).includes(raw)) return raw as PlanTier;
  throw new ManagedSubstrateError("not_configured", `ZENITH_MANAGED_DEFAULT_PLAN must be one of ${PLAN_TIERS.join(", ")}.`);
}

export interface DefaultManagedSubstrateOptions {
  /** default: a snapshot of `process.env` taken now */
  env?: ZenithEnv;
  /** default: the worker's product port */
  product?: Pick<ProductPort, "loadContext">;
  fetch?: typeof fetch;
  /** default: the encrypted vault; kind acceptance and tests may pass another reader of the SAME shape */
  readPlatformSecret?: PlatformCredentialDeps["read"];
  /** Sealed-record storage seam; production uses the configured async vault backend. */
  operatorCredentialBackend?: AsyncSecretsBackend;
  /** Execution supplies its existing store; other surfaces resolve the process store lazily. */
  db?: Sql;
}

/**
 * Build the substrate from the environment. An invalid scope or plan tier degrades to an unconfigured
 * substrate that names the variable (it never throws at worker start, and never half-configures).
 */
export function createDefaultManagedSubstrate(options: DefaultManagedSubstrateOptions = {}): ManagedSubstratePort {
  const env: ZenithEnv = options.env ?? { ...process.env };
  const configs = readManagedConfigs(env);
  let credentials: PlatformCredentialResolver;
  let tenants: TenantResolver;
  let problem: ManagedSubstrateError | undefined;
  try {
    credentials = createPlatformCredentialResolver({ scope: platformVaultScope(env), ...(options.readPlatformSecret ? { read: options.readPlatformSecret } : {}) });
    tenants = createProductTenantResolver(options.product ?? createProductPort(), billingConfigFromEnv(env).mode === "managed" ? {
      async loadPlanTier(workspaceId) {
        try {
          const account = await getAccount(options.db ?? await platformDb(), workspaceId);
          if (!account || !isPlanId(account.planId)) throw new Error("unknown assignment");
          // Suspension is enforced at dispatch; reads and teardown still need a tenant session.
          return getPlan(account.planId).managedTier;
        } catch {
          throw new ManagedSubstrateError("tenant_unresolved", "The workspace billing plan is unknown or unavailable; managed hosting refuses an operator-tier fallback.");
        }
      },
    } : { defaultPlanTier: planTierOf(env) });
  } catch (err) {
    problem = err instanceof ManagedSubstrateError ? err : new ManagedSubstrateError("not_configured", "The Zenith-managed platform configuration is invalid.");
    credentials = { resolve: async () => { throw problem; } };
    tenants = { resolve: async () => { throw problem; } };
  }
  const config = problem
    ? { configured: false as const, missing: [], invalid: [{ variable: "ZENITH_MANAGED_*", problem: problem.message }], message: `Zenith-managed hosting is not configured (${problem.message}).` }
    : configs.config;
  const db = async () => options.db ?? platformDb();
  const buildCustody = createBuildCustody({ env });
  let isolatedBuild: typeof configs.build;
  try {
    const profile = readBuildProfiles(env).find(p => p.provider === "zenith");
    if (!profile) throw new Error();
    isolatedBuild = { configured: true, config: { namespace: profile.config.namespace, builderImage: profile.config.builderImage,
      pushSecret: profile.config.pushSecret, insecureRegistry: false, serviceAccount: "zenith-builder" } };
  } catch {
    isolatedBuild = { configured: false, reason: "Source builds require ZENITH_ISOLATED_BUILD_PROFILES with per-tenant build namespaces, separate tenant build credentials and verified dedicated nodes." };
  }
  const openKubernetes: Parameters<typeof assertManagedTenantReady>[1]["createKubernetesSession"] = (cfg, signal) => createKubernetesSession(cfg, { ttlSec: 3600, resolveCredential: (ref, s) => credentials.resolve(ref, s) }, signal);
  const bootstrapConfig = (namespace: string) => {
    if (!config.configured) throw new ManagedSubstrateError("not_configured", config.message);
    return { ...substrateConnectionConfig(config.substrate, namespace), credentialRef: config.substrate.cluster.kubeconfigRef };
  };
  const onboarding: NonNullable<ManagedSubstratePort["onboarding"]> = {
    request(tenant, operationId, lease, withManagedDatabase) {
      if (!config.configured) throw new ManagedSubstrateError("not_configured", config.message);
      assertManagedOperatorConfigured(config.substrate);
      return { tenant, substrate: config.substrate, operationId, lease, withManagedDatabase, tokenTtlSec: 3600 };
    },
    provisioner(rt) {
      return createTenantIsolationProvisioner({ rt,
        openBootstrapSession: async (request, namespaces, signal) => ({ session: await openKubernetes({ ...bootstrapConfig(namespaces[0]), namespaces: [...namespaces] }, signal) }),
        async openOperatorProbe(token, request) {
          const namespace = tenantNamespace(request.tenant.workspaceId, request.tenant.environmentId);
          const session = await createKubernetesSession(substrateConnectionConfig(request.substrate, namespace), { ttlSec: 600, resolveCredential: async () => token });
          return createGuestClusterPort(session);
        },
        async storeOperatorCredential(value) {
          if (!config.configured) throw new ManagedSubstrateError("not_configured", config.message);
          const tenant = await tenants.resolve(value);
          const namespace = tenantNamespace(tenant.workspaceId, tenant.environmentId);
          if (value.ref !== `${config.substrate.isolation?.operatorCredentialPrefix}/${namespace}` || Date.parse(value.expiresAt) <= Date.now()) throw new ManagedSubstrateError("session_refused", "Operator credential custody scope or expiry is invalid.");
          const scope = platformVaultScope(env);
          const backend = options.operatorCredentialBackend ?? asyncSecretsBackend();
          const current = await backend.get(scope, value.ref);
          const now = new Date().toISOString();
          await backend.put(scope, { ref: value.ref, createdAt: current?.createdAt ?? now, createdBy: current?.createdBy ?? "system:tenant-isolation", updatedAt: now, updatedBy: "system:tenant-isolation", version: (current?.version ?? 0) + 1, keyVersion: KEY_VERSION,
            ...vaultCipherFromEnv(env).seal(scope, value.ref, value.token) });
        },
      });
    },
    async withPlanningSession(request, fn) {
      if (!config.configured) throw new ManagedSubstrateError("not_configured", config.message);
      const tenant = await tenants.resolve(request);
      assertManagedOperatorConfigured(config.substrate);
      const namespace = tenantNamespace(tenant.workspaceId, tenant.environmentId);
      const kubernetes = readOnlyManagedPlanningSession(await openKubernetes(bootstrapConfig(namespace), request.signal));
      const serving = await loadServingInputs(await db(), tenant);
      const session = await openZenithSession(tenant, { substrate: config.substrate, kubernetes,
        createKubernetesSession: async (cfg, signal) => readOnlyManagedPlanningSession(await openKubernetes(cfg, signal)),
        databases: request.databases ?? unavailableDatabaseProvider("No managed database scope was supplied for planning."), storage: request.storage, customDomains: serving.verifiedDomains, retiredDomains: serving.retiredDomains });
      return fn(session);
    },
  };
  return createManagedSubstrate({
    onboarding,
    config,
    build: isolatedBuild,
    toolkit: createKubernetesToolkit(),
    async withIsolatedBuildSession(request, fn) {
      if (!isolatedBuild.configured) throw new ManagedSubstrateError("build_unavailable", isolatedBuild.reason);
      // Tenant existence and the target cluster are re-derived before credential custody is consumed.
      const tenant = await tenants.resolve(request, request.signal);
      if (tenant.workspaceId !== request.workspaceId || tenant.environmentId !== request.environmentId) {
        throw new ManagedSubstrateError("build_refused", "Build custody belongs to another tenant.");
      }
      if (!config.configured) throw new ManagedSubstrateError("not_configured", config.message);
      const profile = buildCustody.profile({ ...request, provider: "zenith" });
      if (profile.server.replace(/\/+$/, "") !== config.substrate.cluster.server.replace(/\/+$/, "") ||
          request.namespace && request.namespace !== profile.config.namespace) {
        throw new ManagedSubstrateError("build_refused", "Tenant build custody belongs to another cluster or namespace.");
      }
      return buildCustody.withSessions({ ...request, provider: "zenith", signal: request.signal ?? AbortSignal.timeout(3_600_000) },
        (writer, _verifier, current) => fn(writer, current.config.namespace));
    },
    tenants,
    async assertTenantReady(tenant, signal) {
      if (!config.configured) throw new ManagedSubstrateError("not_configured", config.message);
      assertManagedOperatorConfigured(config.substrate);
      const resources = await repos.resources.listByEnvironment(await db(), tenant.workspaceId, tenant.environmentId);
      return assertManagedTenantReady({ tenant, substrate: config.substrate, withManagedDatabase: resources.some((r) => r.provider === "zenith" && r.ownership === "managed" && r.kind === "postgres" && r.status !== "deleted") }, { createKubernetesSession: openKubernetes }, signal);
    },
    servingInputs: async (tenant) => loadServingInputs(await db(), tenant),
    storageKeyStore: (tenant) => ({
      active: async (address) => platformStorageKeyStore(await db(), tenant.workspaceId, tenant.environmentId).active(address),
      known: async (address) => platformStorageKeyStore(await db(), tenant.workspaceId, tenant.environmentId).known(address),
      record: async (input) => platformStorageKeyStore(await db(), tenant.workspaceId, tenant.environmentId).record(input),
      markRevoked: async (id) => platformStorageKeyStore(await db(), tenant.workspaceId, tenant.environmentId).markRevoked(id),
    }),
    // Sessions live as long as the longest managed step (plan/apply use hour-long sessions elsewhere).
    createKubernetesSession: openKubernetes,
    resolvePlatformCredential: (ref, signal) => credentials.resolve(ref, signal),
    fetch: options.fetch ?? fetch,
  });
}

let shared: ManagedSubstratePort | undefined;
/**
 * The process-wide default substrate, for surfaces that are not execution activities (serving integrations, status
 * pages). Execution composes its own through `createDefaultManagedSubstrate` with its own product port.
 */
export function defaultManagedSubstrate(): ManagedSubstratePort {
  return (shared ??= createDefaultManagedSubstrate());
}
