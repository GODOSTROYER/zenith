/**
 * The Zenith-managed SUBSTRATE PORT (PROD-MAN-01): the one stable interface the
 * rest of the platform codes against when it needs "the cluster, registry and
 * services Zenith itself operates".
 *
 * Types and one error class only. No I/O, no environment reads, no imports of
 * the Kubernetes provider. The implementation is `managed-substrate.ts`; the
 * default composition that builds it from `ZENITH_MANAGED_*` and hands it to
 * execution is `src/lib/platform/zenith-managed.ts`. Later requirements
 * (MAN-02 serving integrations, MAN-03 storage/domains, MAN-04/05 isolation)
 * build on THIS module: add to the port, never fork it.
 *
 * Contract, in words:
 *   - A port is either configured or it refuses, by name, with the variables to
 *     set. There is no partial or "test" mode: tests pass a different
 *     implementation of the same interface, production passes the one built
 *     from the environment.
 *   - Every session is pinned to ONE tenant (workspace + environment) resolved
 *     from the control plane, never from the caller's claim of slugs or tier.
 *   - Credentials are `vault:` references in the PLATFORM scope, resolved in
 *     memory per session and never returned, serialized or logged.
 *   - Callers receive sessions only inside `withSession` (preferred) or
 *     through `openSession` and must drop them; sessions expire.
 */
import type { KubernetesSession } from "@/lib/credentials/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { ManagedDatabaseProvider } from "./database";
import type { ManagedBuildConfig } from "./managed-build-config";
import type { KubernetesToolkit } from "./k8s-port";
import type { ZenithSession } from "./session";
import type { SubstrateDescription, ZenithSubstrate } from "./substrate";
import type { ZenithTenant } from "./types";
import type { ServingInputs } from "@/lib/managed-serving/platform-store";
import type { ObjectStoragePorts } from "@/lib/managed-serving/storage";
import type { TenantIsolationProvisioner, TenantIsolationRequest } from "./onboarding";
import type { TenantIsolationRuntime } from "@/lib/execution/tenant-isolation";

export type ManagedSubstrateErrorCode =
  | "not_configured"
  | "tenant_unresolved"
  | "tenant_invalid"
  | "credential_unavailable"
  | "session_refused"
  | "registry_unavailable"
  | "registry_refused"
  | "build_unavailable"
  | "build_refused";

/** A failure with a stable code and a message that is safe to show (never a secret value). */
export class ManagedSubstrateError extends Error {
  readonly code: ManagedSubstrateErrorCode;
  constructor(code: ManagedSubstrateErrorCode, message: string) {
    super(message);
    this.name = "ManagedSubstrateError";
    this.code = code;
  }
}

/** The control plane's identity of a managed environment. Slugs and tier are looked up, never supplied. */
export interface TenantRef {
  workspaceId: string;
  environmentId: string;
}

/** Resolves the DNS-safe names and plan tier of a tenant from the control plane. */
export interface TenantResolver {
  /** Throws `ManagedSubstrateError` (`tenant_unresolved` / `tenant_invalid`); never invents a slug. */
  resolve(ref: TenantRef, signal?: AbortSignal): Promise<ZenithTenant>;
}

/** Resolves a PLATFORM-scope `vault:` reference to its value, in memory. Distinct from any workspace resolver. */
export interface PlatformCredentialResolver {
  resolve(ref: string, signal?: AbortSignal): Promise<string>;
}

export interface ManagedSessionRequest extends TenantRef {
  signal?: AbortSignal;
  /**
   * Managed-database port for this session, from `databaseRuntime()`. Absent, the session carries a port that
   * answers `unavailable` (a session that only observes, releases or tears down needs no database scope).
   */
  databases?: ManagedDatabaseProvider;
  storage?: ObjectStoragePorts;
}

/** Where tenant images live on the Zenith-operated registry. Pure naming and ownership; no network. */
export interface ManagedRegistryPort {
  readonly host: string;
  /** `<host>/<prefix>/<workspace>/<environment>`: every repository of this tenant starts with it. */
  tenantRepositoryRoot(tenant: Pick<ZenithTenant, "workspaceId" | "environmentId">): string;
  /** Full repository for one service: `<tenantRepositoryRoot>/<service>`. Refuses a name that is not a valid path segment. */
  repositoryFor(tenant: Pick<ZenithTenant, "workspaceId" | "environmentId">, serviceName: string): string;
  /** True only for `<repositoryFor(tenant, service)>@sha256:<64 hex>` with a valid service segment. */
  ownsPinnedImage(tenant: Pick<ZenithTenant, "workspaceId" | "environmentId">, imageRef: string): boolean;
  /** True for any reference whose host is this registry (any tenant). */
  isManagedHost(imageRef: string): boolean;
}

/** What the build path of the managed substrate needs to run, reported without secrets. */
export type ManagedBuildAvailability =
  | { available: true; namespace: string; builderImage: string }
  | { available: false; reason: string };

export interface ManagedSubstrateStatus {
  configured: boolean;
  description: SubstrateDescription;
  build: ManagedBuildAvailability;
}

export interface ManagedDatabaseRuntimeInput {
  workspaceId: string;
  projectId: string;
  environmentId: string;
  nodes: readonly ResourceNode[];
}

export interface ManagedSubstratePort {
  readonly id: "zenith-managed";
  /** Presence and non-secret shape only; safe for status pages and logs. */
  status(): ManagedSubstrateStatus;
  /** The validated substrate. Throws `not_configured` (naming every variable) when it is not. */
  substrate(): ZenithSubstrate;
  /** The Kubernetes provider's render/apply/read/list, shared by drivers and the apply pipeline. */
  readonly toolkit: KubernetesToolkit;
  readonly tenants: TenantResolver;
  /** Internal worker path; planning credentials reject every non-dry-run write. */
  onboarding?: {
    provisioner(rt: TenantIsolationRuntime): TenantIsolationProvisioner;
    withPlanningSession<T>(request: ManagedSessionRequest, fn: (session: ZenithSession) => Promise<T>): Promise<T>;
    request(tenant: ZenithTenant, operationId: string, lease: TenantIsolationRequest["lease"], withManagedDatabase: boolean): TenantIsolationRequest;
  };
  /** Current domain proof and retirement state, re-read at each reviewed dispatch. */
  servingInputs?(tenant: TenantRef): Promise<ServingInputs>;
  /** The Zenith-operated registry, or undefined when none is configured (built images then refuse). */
  registry(): ManagedRegistryPort | undefined;
  /** The validated build configuration. Throws `build_unavailable` (naming what to set) when builds are not configured. */
  buildConfig(): ManagedBuildConfig;
  /** Open a tenant-scoped session. The caller owns its lifetime (it expires); prefer `withSession`. */
  openSession(request: ManagedSessionRequest): Promise<ZenithSession>;
  /** Open, run, drop. The session never leaves `fn`. */
  withSession<T>(request: ManagedSessionRequest, fn: (session: ZenithSession) => Promise<T>): Promise<T>;
  /** The managed-database port and workload secret resolver for one environment, bound to its vault scope. */
  databaseRuntime(input: ManagedDatabaseRuntimeInput): { databases: ManagedDatabaseProvider; resolveSecret: (ref: string) => Promise<string | undefined>; storage?: ObjectStoragePorts };
  /**
   * A session for the platform build namespace (never a tenant namespace). Builds run there under the
   * platform's own identity, so a tenant session is never given build authority.
   */
  withBuildSession<T>(request: ManagedSessionRequest & { namespace?: string }, fn: (session: KubernetesSession, namespace: string) => Promise<T>): Promise<T>;
}

/** The part of the port a caller needs only to OPEN sessions: the shape `withZenithSession` has in destroy ports. */
export interface ManagedSessionOpener {
  withSession<T>(request: ManagedSessionRequest, fn: (session: ZenithSession) => Promise<T>): Promise<T>;
}
