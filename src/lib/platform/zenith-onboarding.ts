/**
 * Read-only planning firewall and admission of a managed tenant. First-deploy
 * provisioning is a reviewed/custodied phase in direct-zenith.ts; session opening
 * verifies its complete readback and scoped operator identity without creating either.
 */
import type { KubernetesConnectionConfig, KubernetesSession } from "@/lib/credentials/types";
import { assertTenantOperatorAccess, readBackTenantIsolation } from "@/lib/execution/tenant-isolation";
import { digest } from "@/lib/controlplane/digest";
import { createGuestClusterPort } from "@/lib/providers/kubernetes/guest";
import { platformOrder } from "@/lib/providers/kubernetes/platform-kinds";
import { bundleObjects, operatorSubjectOf, renderIsolationBundle, validateIsolationBundle } from "@/lib/providers/zenith/isolation-bundle";
import { validateTenantObjects } from "@/lib/providers/zenith/isolation";
import { ManagedSubstrateError } from "@/lib/providers/zenith/managed-port";
import { assertTenant, substrateConnectionConfig, type ZenithSubstrate } from "@/lib/providers/zenith/substrate";
import { renderTenancy, tenantNamespace } from "@/lib/providers/zenith/tenancy";
import type { ZenithTenant } from "@/lib/providers/zenith/types";
import { isVaultRef } from "@/lib/secrets/refs";

/** Authentication firewall for internal first-deploy planning. No mutating request can use this credential. */
export function readOnlyManagedPlanningSession(session: KubernetesSession): KubernetesSession {
  type Context = { getHttpMethod(): string; getUrl(): string };
  const source = session.kubeConfig() as { getCurrentCluster(): unknown; applySecurityAuthentication(context: Context): Promise<void> };
  const config = {
    getCurrentCluster: () => source.getCurrentCluster(),
    async applySecurityAuthentication(context: Context) {
      const method = String(context.getHttpMethod()).toUpperCase();
      const url = new URL(context.getUrl());
      if (method !== "GET" && method !== "HEAD" && !(method === "PATCH" && url.searchParams.getAll("dryRun").length === 1 && url.searchParams.get("dryRun") === "All")) {
        throw new ManagedSubstrateError("session_refused", "Managed planning credentials cannot mutate the cluster.");
      }
      await source.applySecurityAuthentication(context);
    },
  };
  return { provider: "kubernetes", server: session.server, expiresAt: session.expiresAt,
    namespaces: (session as KubernetesSession & { namespaces?: readonly string[] }).namespaces ?? [],
    kubeConfig() { session.kubeConfig(); return config; }, toJSON: () => ({ provider: "kubernetes", purpose: "managed-planning", expiresAt: session.expiresAt }) } as KubernetesSession;
}

/** Must run before resolving any cluster credential; no platform-wide tenant fallback. */
export function assertManagedOperatorConfigured(substrate: ZenithSubstrate): void {
  const prefix = substrate.isolation?.operatorCredentialPrefix;
  if (!prefix || !isVaultRef(prefix) || prefix.endsWith("/")) {
    throw new ManagedSubstrateError("not_configured", "Managed tenant sessions require ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX and a verified tenant operator identity issued through reviewed isolation custody.");
  }
}

export interface ManagedTenantReadinessInput {
  tenant: ZenithTenant;
  substrate: ZenithSubstrate;
  /** Must come from the persisted desired environment, never a provider readback. */
  withManagedDatabase?: boolean;
  egressFqdns?: readonly string[];
}

export interface ManagedTenantReadinessDeps {
  /** The platform-scope vault resolver is already bound; only the verified tenant session leaves this check. */
  createKubernetesSession(config: KubernetesConnectionConfig, signal?: AbortSignal): Promise<KubernetesSession>;
}

/**
 * Read every isolation object under an internal bootstrap read session, then probe the
 * tenant identity. The bootstrap identity is never supplied to workload/build callers.
 * Returns the exact operator session checked, so callers never re-resolve an unchecked credential.
 * Any absent/changed object, unavailable credential or authorization-review failure
 * refuses the session. This verifies configuration, not CNI or sandbox enforcement.
 */
export async function assertManagedTenantReady(input: ManagedTenantReadinessInput, deps: ManagedTenantReadinessDeps, signal: AbortSignal = AbortSignal.timeout(30_000)): Promise<KubernetesSession> {
  assertManagedOperatorConfigured(input.substrate);
  try {
    const tenant = assertTenant(input.tenant);
    const namespace = tenantNamespace(tenant.workspaceId, tenant.environmentId);
    const baseline = renderTenancy(tenant, input.substrate, { withManagedDatabase: input.withManagedDatabase === true });
    if (validateTenantObjects(baseline.objects, { tenant, substrate: input.substrate }).length) throw new Error("invalid baseline");
    const bundle = renderIsolationBundle(tenant, input.substrate, { egressFqdns: input.egressFqdns });
    validateIsolationBundle(bundle, { tenant, substrate: input.substrate });
    const objects = platformOrder([...baseline.objects, ...bundleObjects(bundle)]);
    // Resolve the tenant credential first. A missing one must never cause a bootstrap fallback.
    const operator = await deps.createKubernetesSession(substrateConnectionConfig(input.substrate, namespace), signal);
    const bootstrap = await deps.createKubernetesSession({
      provider: "kubernetes",
      mode: "kubeconfig_ref",
      server: input.substrate.cluster.server,
      ...(input.substrate.cluster.caData ? { caData: input.substrate.cluster.caData } : {}),
      credentialRef: input.substrate.cluster.kubeconfigRef,
      namespaces: [namespace, operatorSubjectOf(namespace).namespace],
    }, signal);
    await readBackTenantIsolation(bootstrap, { tenant, objects, bundleDigest: digest({ kind: "zenith.tenant-isolation-bundle.v1", objects }) }, signal);
    await assertTenantOperatorAccess(createGuestClusterPort(operator, signal), namespace);
    return operator;
  } catch {
    // A provider can echo a token or private object into its error; expose only this fixed refusal.
    throw new ManagedSubstrateError("session_refused", "Managed tenant isolation is not ready: the complete reviewed isolation bundle and scoped tenant operator credential must be provisioned and verified before opening a tenant session.");
  }
}
