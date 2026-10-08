/**
 * The per-operation session of the Zenith-managed provider: the drivers'
 * `Session` type.
 *
 * A managed session is NOT produced by the credential broker. The broker mints
 * short-lived credentials for CUSTOMER clouds from a customer's connection;
 * here the platform itself is the operator and holds its own cluster
 * credential. What it shares with the broker path is the discipline: the
 * credential is a reference (`ZENITH_MANAGED_KUBECONFIG_REF`), resolved in
 * memory by the Kubernetes provider's `createKubernetesSession`, scoped to one
 * operation, and never serialized. `ZenithSession` carries no secret of its
 * own: it holds the (opaque, expiring) Kubernetes session, the tenant, the
 * non-secret substrate and the managed-database port.
 *
 * Every session is pinned to ONE tenant. The workload connection allows exactly
 * that tenant's namespace; a separate TLS operator connection allows only the
 * gateway namespace. It is never handed to workload drivers. Drivers call
 * `assertSessionMatches` so a session opened for one environment can never be
 * used to observe or operate another.
 *
 * Honest note for the orchestrator: `credentials/types.ts` has no `zenith`
 * connection config and the broker refuses unknown providers. Managed sessions
 * are opened by the platform worker with this function; whether a
 * `ZenithConnectionConfig` should exist so the broker can audit them is a
 * contract question (see docs/platform/MANAGED-PLATFORM.md, "Integration").
 */
import type { KubernetesConnectionConfig, KubernetesSession } from "@/lib/credentials/types";
import type { ManagedDatabaseProvider } from "./database";
import type { ObjectStoragePorts } from "@/lib/managed-serving/storage";
import { assertTenant, substrateConnectionConfig, type ZenithSubstrate } from "./substrate";
import { tenantNamespace } from "./tenancy";
import { ZenithError, type ZenithTenant } from "./types";

export interface ZenithSession {
  readonly provider: "zenith";
  readonly tenant: ZenithTenant;
  readonly substrate: ZenithSubstrate;
  /** scoped to the tenant namespace; expires */
  readonly kubernetes: KubernetesSession;
  /** Separate operator scope for platform TLS; absent in ingress mode or older injected sessions. */
  readonly gatewayKubernetes?: KubernetesSession;
  readonly databases: ManagedDatabaseProvider;
  /** Verified custom hostnames this environment may serve (PROD-MAN-03); absent = managed hostnames only. */
  readonly customDomains?: readonly string[];
  readonly retiredDomains?: readonly string[];
  /** Tenant object-store provisioning ports (PROD-MAN-03); absent = object stores report unavailable. */
  readonly storage?: ObjectStoragePorts;
  readonly expiresAt: string;
  toJSON(): Record<string, unknown>;
}

export interface ZenithSessionDeps {
  substrate: ZenithSubstrate;
  /** The exact tenant credential session whose RBAC was checked by default onboarding admission. */
  kubernetes?: KubernetesSession;
  /** the Kubernetes provider's `createKubernetesSession` with its resolver bound (`vault:` reference → credential) */
  createKubernetesSession(config: KubernetesConnectionConfig, signal?: AbortSignal): Promise<KubernetesSession>;
  databases: ManagedDatabaseProvider;
  customDomains?: readonly string[];
  retiredDomains?: readonly string[];
  storage?: ObjectStoragePorts;
}

/** Open a session for one tenant. The credential is resolved inside `createKubernetesSession`, never here. */
export async function openZenithSession(tenantInput: ZenithTenant, deps: ZenithSessionDeps, signal?: AbortSignal): Promise<ZenithSession> {
  const tenant = assertTenant(tenantInput);
  const config = substrateConnectionConfig(deps.substrate, tenantNamespace(tenant.workspaceId, tenant.environmentId));
  const kubernetes = deps.kubernetes ?? await deps.createKubernetesSession(config, signal);
  const gatewayKubernetes = deps.substrate.gateway.mode === "gateway_api"
    ? await deps.createKubernetesSession({ ...substrateConnectionConfig(deps.substrate, deps.substrate.gateway.namespace), credentialRef: deps.substrate.cluster.kubeconfigRef }, signal)
    : undefined;
  const expiresAt = gatewayKubernetes && Date.parse(gatewayKubernetes.expiresAt) < Date.parse(kubernetes.expiresAt)
    ? gatewayKubernetes.expiresAt : kubernetes.expiresAt;
  return {
    provider: "zenith",
    tenant: { ...tenant },
    substrate: deps.substrate,
    kubernetes,
    ...(gatewayKubernetes ? { gatewayKubernetes } : {}),
    databases: deps.databases,
    ...(deps.customDomains ? { customDomains: [...deps.customDomains] } : {}),
    ...(deps.retiredDomains ? { retiredDomains: [...deps.retiredDomains] } : {}),
    ...(deps.storage ? { storage: deps.storage } : {}),
    expiresAt,
    toJSON: () => ({ provider: "zenith", workspaceId: tenant.workspaceId, environmentId: tenant.environmentId, expiresAt }),
  };
}

/** Refuse to act when the session belongs to a different workspace or environment than the call. */
export function assertSessionMatches(session: ZenithSession, ctx: { workspaceId: string; environmentId: string }): void {
  if (session.tenant.workspaceId !== ctx.workspaceId || session.tenant.environmentId !== ctx.environmentId) {
    throw new ZenithError("tenant_mismatch", "The Zenith-managed session was opened for a different workspace or environment than this operation; refusing to act across tenants.");
  }
}
