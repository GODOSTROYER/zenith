/**
 * The managed-database port of the Zenith-managed provider.
 *
 * DECISION: Zenith does not run a Postgres fleet. Running stateful databases
 * for other people (backups, failover, upgrades, noisy neighbours, data-loss
 * liability) is disproportionate risk for this stage, so `postgres` on
 * `provider = zenith` is ALWAYS a managed database service behind this port and
 * NEVER an in-cluster StatefulSet (`isolation.ts` refuses the kind outright).
 * One adapter exists (Neon, `neon.ts`); another provider is one more
 * implementation of `ManagedDatabaseProvider`, not a change to any caller.
 *
 * Invariants of every implementation:
 *   - Connection details leave a provider only as a SECRET REFERENCE
 *     (`connectionSecretRef`, `vault:…`). The connection URI is written to an
 *     injected `ConnectionSecretSink` (the platform vault) and is never returned,
 *     logged, put in an error, or kept in memory past the call.
 *   - API credentials are references resolved at call time by an injected
 *     resolver; never cached across calls.
 *   - Unconfigured means `unavailable`, with the variables to set, never a
 *     throw and never a fake success.
 *   - `create` is idempotent on the tuple (workspace, environment, node
 *     address): running it twice converges on one database.
 *   - `delete` only ever deletes a database this module created for that exact
 *     tuple, and the caller (`database-lifecycle.ts`) is the one that enforces
 *     the deletion policy.
 *
 * Evidence is `contract`: the Neon adapter is tested against a fake HTTP server
 * shaped from Neon's public OpenAPI description, not against Neon.
 */
import { createHash } from "node:crypto";

export type DatabaseSize = "nano" | "small" | "standard" | "performance";

/** What the managed platform needs to know to provision one database (portable terms only). */
export interface ManagedDatabaseSpec {
  workspaceId: string;
  environmentId: string;
  /** the node address, e.g. `resource/db` */
  address: string;
  /** Postgres major version */
  engineVersion: number;
  size: DatabaseSize;
  backup: "none" | "daily" | "hourly";
  highAvailability: boolean;
  deletionPolicy: "deny" | "approval" | "allow";
}

/** Identifies a database Zenith created; `externalId` is the provider's id when known. */
export interface DatabaseTarget {
  workspaceId: string;
  environmentId: string;
  address: string;
  externalId?: string;
}

/** What the provider says about the database's compute: `idle` is scale-to-zero (it wakes on connection), `none` no compute exists. */
export type ComputeState = "active" | "idle" | "init" | "none" | "disabled" | "unknown";

export interface ManagedDatabaseInfo {
  provider: string;
  externalId: string;
  name: string;
  regionId: string;
  engineVersion: number;
  createdAt?: string;
  /** the ONLY form connection details take outside the vault */
  connectionSecretRef: string;
  /** non-secret settings read from the provider */
  settings: Record<string, string | number | boolean>;
  /** set by `get` only; `create` does not look */
  computeState?: ComputeState;
}

export type DatabaseErrorCode =
  | "unavailable"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "quota_exceeded"
  | "conflict"
  | "invalid_request"
  | "provider_error"
  | "unreachable"
  | "timeout"
  | "aborted"
  | "secret_store_failed"
  | "ambiguous";

export interface DatabaseError {
  code: DatabaseErrorCode;
  /** safe to show: scrubbed of credentials, bounded */
  message: string;
  retryable: boolean;
  status?: number;
  requestId?: string;
  retryAfterSec?: number;
}

export type DatabaseResult<T> = { ok: true; value: T } | { ok: false; error: DatabaseError };

export interface DatabaseCallOptions {
  signal?: AbortSignal;
}

export type DatabaseAvailability = { available: true } | { available: false; reason: string };

export interface ManagedDatabaseProvider {
  /** adapter id, e.g. `neon` */
  readonly id: string;
  availability(): DatabaseAvailability;
  /** Idempotent create-or-converge. `created` is false when the database already existed. */
  create(spec: ManagedDatabaseSpec, opts?: DatabaseCallOptions): Promise<DatabaseResult<ManagedDatabaseInfo & { created: boolean }>>;
  /** `null` when the database does not exist. Read-only. */
  get(target: DatabaseTarget, opts?: DatabaseCallOptions): Promise<DatabaseResult<ManagedDatabaseInfo | null>>;
  /** Delete the database Zenith created for `target`; `alreadyAbsent` when there was nothing to delete. */
  delete(target: DatabaseTarget, opts?: DatabaseCallOptions): Promise<DatabaseResult<{ deleted: boolean; alreadyAbsent: boolean }>>;
  /** The vault reference the connection URI is (or will be) stored under. Pure. */
  connectionSecretRef(target: Pick<DatabaseTarget, "environmentId" | "address">): string;
}

/** Where a provider writes the connection URI it obtained: the platform vault, behind a port. */
export interface ConnectionSecretSink {
  put(ref: string, value: string): Promise<void>;
  exists(ref: string): Promise<boolean>;
}

/** Resolves a `vault:` reference to its value, in memory, for one call. */
export type SecretRefResolver = (ref: string) => Promise<string | null | undefined>;

/* --------------------------------- helpers --------------------------------- */

/**
 * The vault reference of a database's connection URI. Same `vault:generated/…`
 * family the Kubernetes provider uses for generated credentials, so one
 * resolver convention covers both.
 */
export const managedDatabaseConnectionRef = (environmentId: string, address: string): string => `vault:generated/${environmentId}/${address}/connection-uri`;

/**
 * The provider-side name of the database for a tuple: stable, unique per
 * tuple, carrying no ids. Adapters find their own databases by this name.
 */
export function managedDatabaseName(t: Pick<DatabaseTarget, "workspaceId" | "environmentId" | "address">): string {
  return `zenith-${createHash("sha256").update(`zenith-managed-db-v1\0${t.workspaceId}\0${t.environmentId}\0${t.address}`).digest("hex").slice(0, 20)}`;
}

/** Remove known secret values and URL credentials from free text; bound its length. */
export function scrubText(text: string, secrets: readonly string[] = [], max = 300): string {
  let out = text;
  for (const s of secrets) if (s.length >= 3) out = out.split(s).join("[redacted]");
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@");
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]");
  return out.length <= max ? out : `${out.slice(0, max - 1)}…`;
}

export const dbError = (code: DatabaseErrorCode, message: string, retryable: boolean, extra: Partial<DatabaseError> = {}): { ok: false; error: DatabaseError } => ({
  ok: false,
  error: { code, message, retryable, ...extra },
});

/* ------------------------------- unavailable ------------------------------- */

/** The answer when no managed database provider is configured: present, honest, and never a success. */
export function unavailableDatabaseProvider(reason: string): ManagedDatabaseProvider {
  const refuse = <T>(): Promise<DatabaseResult<T>> => Promise.resolve(dbError("unavailable", reason, false));
  return {
    id: "unavailable",
    availability: () => ({ available: false, reason }),
    create: () => refuse(),
    get: () => refuse(),
    delete: () => refuse(),
    connectionSecretRef: (t) => managedDatabaseConnectionRef(t.environmentId, t.address),
  };
}

export const DATABASE_UNCONFIGURED_REASON =
  "No managed database provider is configured on this Zenith-managed platform. Set ZENITH_MANAGED_DB_PROVIDER=neon with ZENITH_MANAGED_DB_API_KEY_REF (a vault: reference) and ZENITH_MANAGED_DB_REGION. Postgres is never run inside the cluster.";

export interface DatabaseProviderDeps {
  fetch: typeof fetch;
  resolveSecret: SecretRefResolver;
  sink: ConnectionSecretSink;
  /** per-request ceiling, default 20 s */
  timeoutMs?: number;
}

/** Map a portable `postgres` spec (the subset of `PostgresSpec` this port needs) to a provisioning spec; throws nothing, returns what it cannot honor. */
export function databaseSpecFromNode(
  tenant: Pick<DatabaseTarget, "workspaceId" | "environmentId">,
  node: { address: string; spec: Record<string, unknown> }
): { spec: ManagedDatabaseSpec; notes: string[] } | { error: string } {
  const s = node.spec;
  const versionRaw = typeof s.version === "string" ? s.version : "16";
  const major = /^(\d{1,2})(\.\d{1,2})?$/.exec(versionRaw);
  if (!major) return { error: `${node.address}: postgres version "${versionRaw.slice(0, 20)}" is not a plain major or major.minor version.` };
  const size = typeof s.size === "string" ? s.size : "small";
  if (size !== "nano" && size !== "small" && size !== "standard" && size !== "performance") return { error: `${node.address}: unknown size "${size.slice(0, 40)}" (expected nano, small, standard or performance).` };
  const backup = s.backup === "daily" || s.backup === "hourly" || s.backup === "none" ? s.backup : "none";
  const deletionPolicy = s.deletionPolicy === "allow" || s.deletionPolicy === "approval" ? s.deletionPolicy : "deny";
  const notes: string[] = [];
  const highAvailability = s.highAvailability === true;
  if (highAvailability) notes.push(`${node.address}: highAvailability was requested; the managed database provider does not offer a separate standby compute through this adapter, so it is not configured. Storage is the provider's durable storage.`);
  if (backup !== "none") notes.push(`${node.address}: backup "${backup}" was requested; Zenith configures no scheduled backups. The provider keeps its own point-in-time history window (plan-dependent), which is not the same guarantee.`);
  return {
    spec: { ...tenant, address: node.address, engineVersion: Number(major[1]), size, backup, highAvailability, deletionPolicy },
    notes,
  };
}
