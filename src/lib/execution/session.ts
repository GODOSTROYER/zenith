/**
 * Credentials for an activity, and the context handed to drivers.
 *
 * `withProviderSession` is the ONLY place in this module that asks for cloud
 * credentials. The flow (ADR-0006, ADR-0007):
 *
 *   capability broker  ── issueGrant(operation, "worker", fence, capability) ──▶ grant claims
 *   credential broker  ── withSession({ connection, grant claims, purpose }) ──▶ AwsSession (callback only)
 *
 * The credential broker refuses the observe role to a mutating capability and
 * the deploy role to a non-mutating one. So read-only work inside a mutating
 * operation (planning, re-planning, verifying, observing) asks the capability
 * broker for a WEAKER grant (`infrastructure.plan`, `infrastructure.observe`);
 * mutating work uses the operation's own capability. The compact JWS the broker
 * returns is not used here and never stored; the claims are what the credential
 * broker checks.
 *
 * Nothing the callback returns may contain the session; activities return ids,
 * digests and counts only.
 */
import { capability as lookupCapability } from "@/lib/capabilities/catalog";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import type { OperationRecord } from "@/lib/controlplane/types";
import type { CredentialPurpose, ProviderConnection, ProviderSession } from "@/lib/credentials/types";
import type { DriverContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { ENVIRONMENT_ID_PATTERN, TAG_ENVIRONMENT, TAG_MANAGED, TAG_WORKSPACE, environmentName, awsBootstrapContextForConnection } from "@/lib/credentials/aws/naming";
import { isManagedConnection, MANAGED_CONNECTION_PREFIX, type ExecLike } from "./context";
import { ManagedSubstrateError } from "@/lib/providers/zenith/managed-port";
import type { ZenithSession } from "@/lib/providers/zenith/session";
import type { ManagedDatabaseProvider } from "@/lib/providers/zenith/database";
import type { ObjectStoragePorts } from "@/lib/managed-serving/storage";
import { StepFailedError } from "./errors";
import type { FenceRef } from "./ports";
import type { Runtime } from "./runtime";
import { safeText } from "./text";

/** Weaker capabilities requested for read-only work inside a mutating operation. */
export const PLAN_CAPABILITY = "infrastructure.plan";
export const OBSERVE_CAPABILITY = "infrastructure.observe";

export const GRANT_AUDIENCE = "worker";

/**
 * Stable tags every object Zenith creates in an environment carries — never
 * per-operation ones: a tag that changes every run would diff every resource on
 * every plan. `zenith:managed` and `zenith:environment` are the agreed contract
 * with the credential broker (credentials/aws/naming.ts): the customer's deploy
 * role and the per-capability session policies key off them.
 */
/** Creation-time tags from the proposal; only the live acceptance run tag is allowed. */
export function executionExtraTags(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Execution tags must be an object.");
  const out: Record<string, string> = {};
  for (const [key, tag] of Object.entries(value)) {
    if (key !== "zenith:live-run" || typeof tag !== "string" || !/^zlive-\d{12}-[a-z0-9]{4}$/.test(tag)) throw new Error("Execution tags allow only a valid zenith:live-run id.");
    out[key] = tag;
  }
  return out;
}

export function baseTags(ec: Pick<ExecLike, "workspaceId" | "environmentId" | "product"> & { op?: { id: string; proposal?: OperationRecord["proposal"] } }): Record<string, string> {
  const input = ec.op?.proposal?.input;
  return {
    [TAG_MANAGED]: "true",
    [TAG_WORKSPACE]: ec.workspaceId,
    "zenith:project": ec.product.project.id,
    [TAG_ENVIRONMENT]: ec.environmentId,
    ...executionExtraTags(input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>).executionTags : undefined),
  };
}

export const nodeTags = (base: Record<string, string>, node: ResourceNode): Record<string, string> => ({ ...base, "zenith:resource": node.address });

/**
 * Cloud-name prefix: `zenith-<environmentId>`, the convention the credential
 * broker's session policies and the customer bootstrap's deploy role are
 * written against (a resource outside it is simply out of reach). Derived from
 * the immutable environment id only: renaming a project or an environment must
 * never rename (and so replace) its database.
 *
 * Deviation, stated: `CompileContext.namePrefix` is documented as "≤ 20
 * characters"; `zenith-` plus today's 14-character product ids is 21. Drivers
 * truncate names against the provider's own limits (DRIVER-CONVENTIONS), so this
 * holds, but they must not assume 20.
 */
export const namePrefix = (environmentId: string): string => environmentName(environmentId);

/** Lowercase letters, digits and dashes: safe inside S3, ALB, RDS and IAM names and inside the broker's ARN patterns. */
export const USABLE_AS_CLOUD_NAME = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

export const environmentIdProblem = (environmentId: string): string | undefined =>
  ENVIRONMENT_ID_PATTERN.test(environmentId) && USABLE_AS_CLOUD_NAME.test(environmentId)
    ? undefined
    : `The environment id "${environmentId.slice(0, 40)}" cannot be used in cloud resource names (lowercase letters, digits and dashes only, up to 48 characters).`;

export interface SessionOptions {
  purpose: CredentialPurpose;
  /** a weaker capability than the operation's own; default the operation's */
  capability?: string;
  fence?: FenceRef;
  connection: ProviderConnection;
  /** session (and grant) lifetime the step needs; default the broker's (15 minutes) */
  durationSec?: number;
}

/** Plan, re-plan, apply and rollouts routinely outlive the default 15-minute session. */
export const LONG_SESSION_SEC = 3600;

/**
 * A Zenith-managed environment's session (PROD-MAN-01). The capability broker still issues the grant (so the operation's
 * capability, fence, approval and policy gate this exactly as they gate a customer session); only the credential
 * source differs: the platform's own cluster credential, resolved in memory by the managed substrate and pinned to this
 * environment's namespace. The session never leaves `fn`. Observe and deploy purposes use the SAME operator credential:
 * a read-only managed credential is a separate hardening step (PROD-MAN-04), not claimed here.
 */
export async function withManagedSession<T>(
  rt: Runtime,
  ec: { op: { id: string } },
  opts: Omit<SessionOptions, "connection" | "purpose"> & { workspaceId: string; environmentId: string; databases?: ManagedDatabaseProvider; storage?: ObjectStoragePorts },
  fn: (session: ZenithSession, claims: CapabilityGrantClaims) => Promise<T>
): Promise<T> {
  const managed = rt.d.managed;
  if (!managed) throw new StepFailedError("This worker has no Zenith-managed substrate composed, so a managed environment cannot be operated.");
  const fence = opts.fence ? { scope: opts.fence.scope, fenceToken: opts.fence.fenceToken } : undefined;
  const { claims } = await rt.d.broker.issueGrant(ec.op.id, GRANT_AUDIENCE, fence, {
    ...(opts.capability ? { capability: opts.capability } : {}),
    ...(opts.durationSec ? { durationSec: opts.durationSec } : {}),
  });
  try {
    return await managed.withSession({ workspaceId: opts.workspaceId, environmentId: opts.environmentId, ...(opts.databases ? { databases: opts.databases } : {}), ...(opts.storage ? { storage: opts.storage } : {}) }, (session) => fn(session, claims));
  } catch (err) {
    if (err instanceof ManagedSubstrateError) throw new StepFailedError(err.message);
    throw err;
  }
}

export async function withProviderSession<T>(
  rt: Runtime,
  ec: Pick<ExecLike, "op">,
  opts: SessionOptions,
  fn: (session: ProviderSession, claims: CapabilityGrantClaims) => Promise<T>
): Promise<T> {
  if (isManagedConnection(opts.connection)) {
    // Typed as ProviderSession for the shared step code; it IS a ZenithSession, which the zenith drivers and release
    // adapters assert on (`provider: "zenith"`, tenant pinned to this operation's workspace and environment).
    return withManagedSession(rt, ec, { ...opts, workspaceId: opts.connection.workspaceId, environmentId: opts.connection.id.slice(MANAGED_CONNECTION_PREFIX.length) },
      (session, claims) => fn(session as unknown as ProviderSession, claims));
  }
  const fence = opts.fence ? { scope: opts.fence.scope, fenceToken: opts.fence.fenceToken } : undefined; // the grant names the fence, never the holder
  const { claims } = await rt.d.broker.issueGrant(ec.op.id, GRANT_AUDIENCE, fence, {
    ...(opts.capability ? { capability: opts.capability } : {}),
    ...(opts.durationSec ? { durationSec: opts.durationSec } : {}),
  });
  return rt.d.credentials.withSession(
    { connectionId: opts.connection.id, grant: claims, purpose: opts.purpose, ...(opts.durationSec ? { durationSec: opts.durationSec } : {}) },
    (session) => fn(session, claims)
  );
}

/** The credential purpose the operation's own capability needs. */
export const purposeOf = (capabilityName: string): CredentialPurpose => (lookupCapability(capabilityName).mutates ? "deploy" : "observe");

export function driverContext(
  rt: Runtime,
  ec: Pick<ExecLike, "op" | "workspaceId" | "environmentId" | "product">,
  session: ProviderSession,
  signal: AbortSignal,
  opts: { node?: ResourceNode; fence?: FenceRef; connection?: ProviderConnection } = {}
): DriverContext {
  const { node, fence } = opts;
  const env = ec.product.environment;
  const tags = node ? nodeTags(baseTags(ec), node) : baseTags(ec);
  const provider = node?.provider ?? env.provider;
  const awsBootstrap = provider === "aws" && opts.connection
    ? awsBootstrapContextForConnection(opts.connection.config, node?.region ?? env.region) : undefined;
  if (awsBootstrap && (session.provider !== "aws" || session.accountId !== awsBootstrap.accountId || opts.connection?.status !== "verified")) throw new Error("AWS observation requires a matching verified connection and session.");
  return {
    provider,
    ...(awsBootstrap ? { awsBootstrap } : {}),
    region: node?.region ?? env.region,
    workspaceId: ec.workspaceId,
    environmentId: ec.environmentId,
    operationId: ec.op.id,
    session,
    signal,
    log: (line, level) => rt.log(level ?? "info", "driver", { address: node?.address, line: safeText(line, 300) }),
    tags,
    ...(fence ? { fence: { scope: fence.scope, token: fence.fenceToken } } : {}),
    now: () => rt.now(),
  };
}
