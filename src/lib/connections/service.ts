/**
 * Connection administration lifecycle (PROD-LIFE-01): create, verify, revoke
 * and rotate for AWS, GCP, Azure, OCI and Kubernetes connections.
 *
 * One service behind every surface. The action registry (UI, /api/actions), the
 * platform REST routes and the CLI all call these functions, so the five verbs
 * behave identically everywhere.
 *
 * Invariants:
 *  - Identifiers only. No key, token or secret is accepted, stored or returned.
 *  - Creation never verifies and never implies access; a connection deploys
 *    nothing until a verification readback marks it `verified`.
 *  - Revocation is terminal and committed in the platform store. The credential
 *    broker, the AWS broker, the deploy route and the workflow-start authority
 *    all read that status on every use, so the next dispatch is refused and no
 *    fallback connection, sandbox route or cached session replaces it.
 *  - Rotation stages a candidate beside the live config, verifies the candidate
 *    under the SAME connection id and workload subject, and only then swaps the
 *    config in one guarded transaction. The live access serves until that swap.
 *  - Provider-side revocation (removing the customer's trust, ending AWS STS
 *    sessions already issued) is the customer's step; Zenith says so in results.
 */
import { randomBytes } from "node:crypto";
import type { ActionContext } from "@/lib/actions/core";
import { db, flushPendingAsync, isPostgres, q, save } from "@/lib/db/store";
import { id, type CloudConnection, type ProviderId } from "@/lib/domain/types";
import { bridgeDeps } from "@/lib/bridge/deps";
import { loadCredentialsConfig } from "@/lib/credentials/config";
import { workloadSubject } from "@/lib/credentials/oidc/issuer";
import type { ConnectionConfig, ProviderConnection } from "@/lib/credentials/types";
import type { Sql } from "@/lib/controlplane/types";
import { ControlStoreError } from "@/lib/controlplane/db/errors";
import type { ConnectionRotation } from "@/lib/controlplane/db/repos/connection-rotations";
import { findSecret } from "@/lib/capabilities/secret-guard";
import { azureCloud } from "@/lib/providers/azure/cloud";
import { canonical } from "@/lib/controlplane/digest";
import { RUNNER_VERIFICATION_SCOPE, verifyRunnerReadiness } from "./runner";
import {
  applyRotationPatch, azureConfig, gcpConfig, LifecycleInputError, ociConfig, runnerOf,
  type CreateAzureInput, type CreateGcpInput, type CreateOciInput, type CreateRunnerInput, type RotateInput, type RotationRef,
} from "./schemas";

/* ----------------------------------- views --------------------------------- */

export interface RotationView {
  id: string;
  status: ConnectionRotation["status"];
  createdAt: string;
  verifiedAt?: string;
  verificationDetail?: string;
  /** field names the candidate changes; never values */
  changes: string[];
}

export interface ConnectionView {
  id: string;
  provider: ConnectionConfig["provider"];
  mode: string;
  label: string;
  region?: string;
  status: ProviderConnection["status"];
  verifiedAt?: string;
  verificationDetail?: string;
  createdAt: string;
  revokedAt?: string;
  /** a product-store connection mirrors this record (environments can select it) */
  productLinked: boolean;
  /** non-secret identity this connection is pinned to */
  identity: Record<string, string>;
  runnerId?: string;
  rotation?: RotationView;
}

function identityOf(config: ConnectionConfig): Record<string, string> {
  switch (config.provider) {
    case "aws": return { accountId: config.accountId, region: config.region, ...(config.bootstrapNameSuffix ? { bootstrapNameSuffix: config.bootstrapNameSuffix } : {}) };
    case "gcp": return { projectId: config.projectId, region: config.region };
    case "azure": return { tenantId: config.tenantId, subscriptionId: config.subscriptionId, region: config.region };
    case "oci": return { tenancyOcid: config.tenancyOcid, compartmentOcid: config.compartmentOcid, region: config.region };
    case "kubernetes": return { server: config.server, namespaces: config.namespaces.join(","), guestCredentials: config.mode === "scoped_guest" ? "scoped" : "legacy (guest sessions refused)",
      deployerCredentials: config.mode === "scoped_guest" ? (config.deployerCredentialRef ? `separate (${config.deployerScope ?? "namespaced"})` : "none (guest sessions only)") : "kubeconfig credential" };
  }
}

const changedKeys = (from: ConnectionConfig, to: ConnectionConfig): string[] => {
  const a = from as unknown as Record<string, unknown>;
  const b = to as unknown as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();
};

function productOf(ctx: ActionContext, row: ProviderConnection): CloudConnection | undefined {
  for (const key of [row.legacyConnectionId, row.id]) {
    if (!key) continue;
    const conn = q.connection(key);
    if (conn && conn.workspaceId === ctx.workspaceId && (conn.id === row.id || conn.platformConnectionId === row.id)) return conn;
  }
  return undefined;
}

function viewOf(ctx: ActionContext, row: ProviderConnection, open?: ConnectionRotation | null): ConnectionView {
  const product = productOf(ctx, row);
  return {
    id: row.id, provider: row.config.provider, mode: row.config.mode,
    label: product?.label ?? `${row.config.provider} ${("region" in row.config && row.config.region) || "connection"}`,
    ...("region" in row.config && row.config.region ? { region: row.config.region } : {}),
    status: row.status, verifiedAt: row.verifiedAt, verificationDetail: row.verificationDetail, createdAt: row.createdAt, revokedAt: row.revokedAt,
    productLinked: !!product, identity: identityOf(row.config), runnerId: runnerOf(row.config),
    ...(open ? { rotation: { id: open.id, status: open.status, createdAt: open.createdAt, verifiedAt: open.verifiedAt, verificationDetail: open.verificationDetail, changes: changedKeys(row.config, open.candidateConfig) } } : {}),
  };
}

/* ---------------------------------- helpers -------------------------------- */

async function stores() {
  const [{ repos }, sql] = await Promise.all([import("@/lib/controlplane/db"), bridgeDeps().connectionSql()]);
  return { repos, sql };
}

export class LifecycleRefusal extends Error {
  constructor(message: string, readonly code: "not_found" | "invalid_state" | "invalid_input" | "unavailable" = "invalid_state") { super(message); }
}
export const NOT_FOUND_MESSAGE = "That connection does not exist in this workspace.";
export const HUMAN_REQUIRED_MESSAGE = "A current human workspace member with the required role must do this; agents and the Navigator cannot.";
const NOT_FOUND = NOT_FOUND_MESSAGE;

/** Tenant-scoped load; a foreign id is the same refusal as a missing one. */
async function load(ctx: ActionContext, connectionId: string) {
  const { repos, sql } = await stores();
  const row = await repos.connections.get(sql, ctx.workspaceId, connectionId);
  if (!row) throw new LifecycleRefusal(NOT_FOUND, "not_found");
  return { repos, sql, row };
}

async function activeRunner(ctx: ActionContext, runner: string): Promise<void> {
  const { repos, sql } = await stores();
  const record = await repos.runners.getRunner(sql, ctx.workspaceId, runner);
  if (!record) throw new LifecycleRefusal("That runner is not registered in this workspace. Register it first (Settings, runners), then retry.", "invalid_input");
  if (record.status === "revoked") throw new LifecycleRefusal("That runner is revoked and cannot back a connection.", "invalid_input");
}

async function mirrorProduct(ctx: ActionContext, row: ProviderConnection, apply: (conn: CloudConnection) => void): Promise<"updated" | "none" | "unavailable"> {
  try {
    const conn = productOf(ctx, row);
    if (!conn) return "none";
    apply(conn);
    save();
    await flushPendingAsync();
    return "updated";
  } catch { return "unavailable"; }
}

const issuerHost = (): string | undefined => {
  try { return loadCredentialsConfig().oidcIssuer?.replace(/^https?:\/\//, ""); } catch { return undefined; }
};

/* ----------------------------------- read ---------------------------------- */

export async function listConnections(ctx: ActionContext, options: { includeRevoked?: boolean } = {}): Promise<ConnectionView[]> {
  const { repos, sql } = await stores();
  const rows = await repos.connections.list(sql, ctx.workspaceId, { includeRevoked: options.includeRevoked ?? true });
  const out: ConnectionView[] = [];
  for (const row of rows) out.push(viewOf(ctx, row, await repos.connectionRotations.getOpen(sql, ctx.workspaceId, row.id)));
  return out;
}

export async function describeConnection(ctx: ActionContext, connectionId: string): Promise<ConnectionView> {
  const { repos, sql, row } = await load(ctx, connectionId);
  return viewOf(ctx, row, await repos.connectionRotations.getOpen(sql, ctx.workspaceId, row.id));
}

/* --------------------------------- create ---------------------------------- */

export type CreateProviderInput =
  | { provider: "gcp"; input: CreateGcpInput }
  | { provider: "azure"; input: CreateAzureInput }
  | { provider: "oci"; input: CreateOciInput };

export interface TrustValues {
  subject?: string;
  issuerHost?: string;
  /** what the customer must create in their cloud before verification can pass */
  steps: string[];
}

export function trustFor(ctx: ActionContext, provider: "gcp" | "azure" | "oci", connectionId: string, config: ConnectionConfig): TrustValues {
  if (provider === "oci") {
    return { steps: [
      "Run zenith-runner in your OCI tenancy with an instance or resource principal that can read the compartment.",
      "Zenith verifies only that the registered runner is active and advertises oci.http; OCI identity and permissions stay unverified until jobs run.",
    ] };
  }
  const subject = workloadSubject(ctx.workspaceId, connectionId);
  const host = issuerHost();
  if (provider === "gcp" && config.provider === "gcp") {
    return { subject, issuerHost: host, steps: [
      `Create a workload identity pool provider with issuer https://${host ?? "<ZENITH_OIDC_ISSUER host>"} and require the exact subject ${subject}.`,
      `Grant roles/iam.workloadIdentityUser on ${config.observeServiceAccount} and ${config.deployServiceAccount} to that subject only.`,
      "Run verify. It impersonates the observe service account and reads the configured project; deploy permissions remain unverified.",
    ] };
  }
  if (config.provider === "azure") {
    return { subject, issuerHost: host, steps: [
      `Add a federated credential to application ${config.clientId} with issuer https://${host ?? "<ZENITH_OIDC_ISSUER host>"}, exact subject ${subject} and audience ${azureCloud(config.cloud).federationAudience}.`,
      `Assign that application Reader (observe) and the deploy roles you intend on subscription ${config.subscriptionId}.`,
      "Run verify. It reads the configured subscription; deploy permissions remain unverified.",
    ] };
  }
  return { steps: [] };
}

export async function createProviderConnection(ctx: ActionContext, request: CreateProviderInput): Promise<{ connection: ConnectionView; trust: TrustValues }> {
  const labelOf = (input: { label?: string }, fallback: string) => input.label?.trim() || fallback;
  let config: ConnectionConfig;
  let label: string;
  let region: string;
  if (request.provider === "gcp") { config = gcpConfig(request.input); label = labelOf(request.input, `GCP ${request.input.projectId}`); region = request.input.region; }
  else if (request.provider === "azure") { config = azureConfig(request.input); label = labelOf(request.input, `Azure ${request.input.subscriptionId.slice(0, 8)}`); region = request.input.region; }
  else { config = ociConfig(request.input); label = labelOf(request.input, `OCI ${request.input.region}`); region = request.input.region; await activeRunner(ctx, request.input.runnerId); }
  if (findSecret(label)) throw new LifecycleRefusal("Use a label without secret material.", "invalid_input");
  if (request.provider !== "oci" && !issuerHost()) throw new LifecycleRefusal("Set ZENITH_OIDC_ISSUER to the public HTTPS issuer URL, then create this connection.", "unavailable");

  const connection = await saveProviderConnection(ctx, config, label, region);
  return { connection, trust: trustFor(ctx, request.provider, connection.id, config) };
}

export async function createRunnerConnection(ctx: ActionContext, input: CreateRunnerInput): Promise<{ connection: ConnectionView; trust: TrustValues }> {
  const { label, ...config } = input;
  await activeRunner(ctx, input.runnerId);
  const connection = await saveProviderConnection(ctx, config, label || `${input.provider} runner`, "region" in input ? input.region : "local");
  return { connection, trust: { steps: [
    "Keep zenith-runner running in your network with its locally configured workload identity. Never upload its credentials to Zenith.",
    "Run Verify to check runner readiness. Cloud identity, target connectivity and permissions remain unverified.",
    "GCP and Azure runner jobs use tofu.run; their direct provider session transports remain unavailable. Kubernetes runner connections do not mint guest credentials.",
  ] } };
}

async function saveProviderConnection(ctx: ActionContext, config: ConnectionConfig, label: string, region: string): Promise<ConnectionView> {
  if (findSecret(label)) throw new LifecycleRefusal("Use a label without secret material.", "invalid_input");

  const { repos, sql } = await stores();
  const connectionId = id();
  const productProvider: ProviderId | undefined = config.provider === "oci" ? undefined : config.provider;
  try {
    await sql.tx(async (tx) => {
      if (config.mode === "runner") {
        await tx.query("select id from platform.runners where workspace_id=$1 and id=$2 for share", [ctx.workspaceId, runnerOf(config)]);
        const runner = await repos.runners.getRunner(tx, ctx.workspaceId, runnerOf(config)!);
        if (!runner || runner.status !== "active") throw new LifecycleRefusal("An active registered runner in this workspace is required.", "invalid_input");
      }
      const created = await repos.connections.create(tx, { id: connectionId, workspaceId: ctx.workspaceId, createdBy: ctx.actor.id, config, ...(productProvider ? { legacyConnectionId: connectionId } : {}) });
      if (!await repos.connections.appendLifecycleEvent(tx, { workspaceId: ctx.workspaceId, id: created.id, type: "connection.created", actorId: ctx.actor.id })) throw new LifecycleRefusal("The connection creation event could not be recorded.", "unavailable");
    });
  } catch (error) {
    if (error instanceof LifecycleRefusal) throw error;
    if (error instanceof ControlStoreError) throw new LifecycleRefusal(`The platform connection store refused the write (${error.code}).`, "invalid_input");
    throw new LifecycleRefusal("The platform connection store is unavailable. Check its configuration and schema, then retry.", "unavailable");
  }
  if (productProvider) {
    const product: CloudConnection = { id: connectionId, workspaceId: ctx.workspaceId, provider: productProvider, label, region, status: "connecting",
      grantedPermissions: [], platformConnectionId: connectionId, createdAt: new Date().toISOString() };
    db().connections.push(product);
    save();
    await flushPendingAsync();
  }
  const row = await repos.connections.get(sql, ctx.workspaceId, connectionId);
  if (!row) throw new LifecycleRefusal("The connection was saved but could not be read back.", "unavailable");
  return viewOf(ctx, row);
}

/* ---------------------------------- verify --------------------------------- */

export interface VerifyOutcome {
  ok: boolean;
  detail: string;
  connection: ConnectionView;
  /** what a pass does and does not establish */
  scope: string;
}

const SCOPE: Record<ConnectionConfig["provider"], string> = {
  aws: "Observe-role identity only; deploy-role permissions remain unverified.",
  gcp: "Observe service account read of the configured project only; deploy permissions remain unverified.",
  azure: "Federated identity read of the configured subscription only; deploy permissions remain unverified.",
  oci: "The registered runner is active and advertises oci.http; OCI identity and permissions remain unverified.",
  kubernetes: "Default ServiceAccount read in each saved namespace; deployment permissions remain unverified.",
};

/**
 * Verification readback for any provider. AWS and Kubernetes keep their
 * existing, stricter actions (membership re-checks, captured-tuple recording);
 * GCP, Azure and OCI verify through the platform credential broker and record
 * the outcome on the platform row only if the connection is not revoked.
 */
export async function verifyAnyConnection(ctx: ActionContext, connectionId: string): Promise<VerifyOutcome> {
  const { repos, sql, row } = await load(ctx, connectionId);
  if (row.status === "revoked") throw new LifecycleRefusal("This connection is revoked. Revocation is terminal; create a new connection.");
  const provider = row.config.provider;
  let ok: boolean;
  let detail: string;
  if (row.config.mode === "runner") {
    // Preserve the native verification authority used by the existing AWS/K8s
    // flows: exact captured tuple, default topology and final live membership.
    const captured = isPostgres() ? await repos.connections.captureVerification(sql, ctx.workspaceId, row.id, ctx.actor.id) : null;
    if (isPostgres() && !captured) throw new LifecycleRefusal("The native connection and current membership could not be captured for verification.", "unavailable");
    const result = await sql.tx(async (tx) => {
      // Read readiness while holding both rows; never apply an observation to a
      // different binding promoted while this request was waiting for a lock.
      await tx.query("select id from platform.provider_connections where workspace_id=$1 and id=$2 for update", [ctx.workspaceId, row.id]);
      const current = await repos.connections.get(tx, ctx.workspaceId, row.id);
      if (!current || current.status === "revoked" || canonical(current.config) !== canonical(row.config)) throw new LifecycleRefusal("The connection changed or was revoked during verification.");
      await tx.query("select id from platform.runners where workspace_id=$1 and id=$2 for share", [ctx.workspaceId, runnerOf(row.config)]);
      const checked = await verifyRunnerReadiness(tx, ctx.workspaceId, current.config);
      const recorded = captured
        ? await repos.connections.recordCapturedVerification(sql, captured, checked)
        : await repos.connections.recordVerification(tx, { workspaceId: ctx.workspaceId, id: row.id, ...checked });
      if (!recorded) throw new LifecycleRefusal("The connection or current membership changed during verification.");
      if (!await repos.connections.appendLifecycleEvent(tx, { workspaceId: ctx.workspaceId, id: row.id, type: "connection.verified", actorId: ctx.actor.id, data: { ok: checked.ok } })) throw new LifecycleRefusal("The verification event could not be recorded.", "unavailable");
      return checked;
    });
    ok = result.ok;
    detail = result.detail;
    await mirrorProduct(ctx, row, (conn) => { conn.status = ok ? "healthy" : "disconnected"; conn.lastCheckedAt = new Date().toISOString(); });
  } else if (provider === "aws" || provider === "kubernetes") {
    const { getAction } = await import("@/lib/actions/core");
    await import("@/lib/actions/defs");
    const result = await getAction(provider === "aws" ? "connection.verifyAws" : "connection.verifyKubernetes").execute(ctx, { connectionId });
    ok = result.ok;
    detail = result.ok ? result.summary : (result.error ?? result.summary);
  } else {
    const broker = await bridgeDeps().providerBroker(sql);
    const result = await broker.verifyConnection(row.id, { workspaceId: ctx.workspaceId });
    const recorded = await repos.connections.recordVerification(sql, { workspaceId: ctx.workspaceId, id: row.id, ok: result.ok, detail: result.detail.slice(0, 900) });
    if (!recorded) throw new LifecycleRefusal("The connection was revoked during verification; the result was not recorded.");
    ok = result.ok;
    detail = result.detail;
    await mirrorProduct(ctx, row, (conn) => { conn.status = result.ok ? "healthy" : "disconnected"; conn.lastCheckedAt = new Date().toISOString(); });
  }
  if (row.config.mode !== "runner") await repos.connections.appendLifecycleEvent(sql, { workspaceId: ctx.workspaceId, id: row.id, type: "connection.verified", actorId: ctx.actor.id, data: { ok } }).catch(() => false);
  const after = await repos.connections.get(sql, ctx.workspaceId, row.id);
  return { ok, detail, scope: row.config.mode === "runner" ? RUNNER_VERIFICATION_SCOPE : SCOPE[provider], connection: viewOf(ctx, after ?? row, await repos.connectionRotations.getOpen(sql, ctx.workspaceId, row.id)) };
}

/* ---------------------------------- revoke --------------------------------- */

export interface RevokeOutcome {
  connection: ConnectionView;
  alreadyRevoked: boolean;
  productMirror: "updated" | "none" | "unavailable";
  runnerRevoked?: { id: string; cancelledJobs: number };
  runnerKept?: string;
  /** scoped Kubernetes guest bindings: cluster objects deleted now vs still pending (unmintable either way) */
  guestBindings?: { revoked: number; pending: number };
  /** scoped_guest with a deployer part: both parts died in the same SQL commit (nothing can mint or deploy from it); the deployer holds no cluster objects of Zenith's. */
  deployer?: { revoked: true };
  /** what Zenith cannot do from its side */
  customerSteps: string[];
}

async function runnerInUse(ctx: ActionContext, runner: string, excluding: string): Promise<boolean> {
  const { repos, sql } = await stores();
  return (await repos.connections.list(sql, ctx.workspaceId)).some((c) => c.id !== excluding && runnerOf(c.config) === runner);
}

async function retireRunner(ctx: ActionContext, runner: string, excluding: string): Promise<{ revoked?: { id: string; cancelledJobs: number }; kept?: string }> {
  if (await runnerInUse(ctx, runner, excluding)) return { kept: runner };
  const [{ getRunnerRuntime }, { revokeAgent }] = await Promise.all([import("@/lib/runners/runtime"), import("@/lib/runners/service")]);
  const done = await revokeAgent(await getRunnerRuntime(), "runner", ctx.workspaceId, runner, ctx.actor.id);
  return { revoked: { id: done.id, cancelledJobs: done.cancelledJobs } };
}

const customerRevocationSteps = (provider: ConnectionConfig["provider"]): string[] => {
  switch (provider) {
    case "aws": return ["Remove the Zenith trust from the observe and deploy roles (or delete the bootstrap stack). STS sessions already issued expire within their 15 minute lifetime."];
    case "gcp": return ["Remove the workloadIdentityUser bindings for the Zenith subject. Access tokens already issued expire within their 15 minute lifetime."];
    case "azure": return ["Delete the federated credential for the Zenith subject. Access tokens already issued expire within their short lifetime."];
    case "oci": return ["Stop zenith-runner in your tenancy. Revoke the runner here too if it is no longer needed."];
    case "kubernetes": return ["Delete the service-account token or kubeconfig secret in your vault and revoke it in the cluster. For a scoped guest connection also remove the minter identity; Zenith deletes its guest ServiceAccounts, Roles and RoleBindings (labelled zenith.dev/component=guest)."];
  }
};

export async function revokeConnection(ctx: ActionContext, input: { connectionId: string; reason?: string; revokeRunner?: boolean }): Promise<RevokeOutcome> {
  const { repos, sql, row } = await load(ctx, input.connectionId);
  const revoked = await repos.connections.revokeAudited(sql, { workspaceId: ctx.workspaceId, id: row.id, actorId: ctx.actor.id, reason: input.reason });
  if (!revoked) throw new LifecycleRefusal(NOT_FOUND, "not_found");
  const productMirror = await mirrorProduct(ctx, row, (conn) => { conn.status = "disconnected"; conn.revokedAt = revoked.connection.revokedAt ?? new Date().toISOString(); conn.lastCheckedAt = conn.revokedAt; });
  const outcome: RevokeOutcome = { connection: viewOf(ctx, revoked.connection), alreadyRevoked: revoked.alreadyRevoked, productMirror, customerSteps: customerRevocationSteps(row.config.provider) };
  if (row.config.provider === "kubernetes" && row.config.mode === "scoped_guest" && row.config.deployerCredentialRef) {
    // PROD-K8S-CONN: the deployer part is refused by the same status flip that stopped the minter (broker status gate and the
    // admission re-read both see 'revoked'); there is no cluster object of Zenith's to delete, so the customer removes the identity.
    outcome.deployer = { revoked: true };
    outcome.customerSteps = [...outcome.customerSteps, "Also delete the deployer credential's vault secret and revoke that identity in the cluster; Zenith can no longer use it."];
  }
  if (row.config.provider === "kubernetes" && row.config.mode === "scoped_guest") {
    // PROD-MACH-02: bindings are already unmintable (revoked in the same SQL commit); now remove them from the cluster.
    // Safe to repeat: an already-revoked connection retries any binding left pending.
    const { revokeKubernetesGuestBindings } = await import("@/lib/platform/credentials");
    const guest = await revokeKubernetesGuestBindings(sql, revoked.connection);
    if (guest.attempted) {
      outcome.guestBindings = { revoked: guest.revoked, pending: guest.pending };
      if (guest.pending > 0) outcome.customerSteps = [...outcome.customerSteps, "Some guest ServiceAccounts could not be deleted from the cluster (minter unreachable or removed). They cannot be used by Zenith; delete objects labelled zenith.dev/component=guest yourself or revoke this connection again once the minter is reachable."];
    }
  }
  const runner = runnerOf(row.config);
  if (input.revokeRunner && runner) {
    const retired = await retireRunner(ctx, runner, row.id);
    if (retired.revoked) outcome.runnerRevoked = retired.revoked;
    if (retired.kept) outcome.runnerKept = retired.kept;
  }
  return outcome;
}

/* ---------------------------------- rotate --------------------------------- */

export interface RotationOutcome {
  rotationId: string;
  status: ConnectionRotation["status"];
  verified: boolean;
  detail: string;
  promoted: boolean;
  connection: ConnectionView;
  /** only when an ExternalId was generated: the customer must trust it before verification can pass */
  externalId?: string;
  nextSteps: string[];
  runnerRevoked?: { id: string; cancelledJobs: number };
  runnerKept?: string;
}

const generateExternalId = () => `zenith-${randomBytes(16).toString("hex")}`;

async function verifyCandidate(ctx: ActionContext, sql: Sql, row: ProviderConnection, candidate: ConnectionConfig): Promise<{ ok: boolean; detail: string }> {
  if (candidate.mode === "runner") return verifyRunnerReadiness(sql, ctx.workspaceId, candidate);
  const deps = bridgeDeps();
  try {
    if (candidate.provider === "aws") {
      const live: ProviderConnection = { ...row, config: candidate };
      const broker = await deps.credentialBroker(async (cid) => (cid === row.id ? live : null));
      return await broker.verifyConnection(row.id, { workspaceId: ctx.workspaceId });
    }
    const broker = await deps.providerBroker(sql, { workspaceId: ctx.workspaceId, connectionId: row.id, config: candidate });
    return await broker.verifyConnection(row.id, { workspaceId: ctx.workspaceId });
  } catch {
    return { ok: false, detail: "The candidate could not be verified: the credential broker or provider was unreachable." };
  }
}

const rotationGuidance = (config: ConnectionConfig, externalId: string | undefined, changes: string[]): string[] => {
  const steps: string[] = [];
  if (externalId) steps.push("Add this ExternalId to the sts:ExternalId condition of the observe and deploy roles trust policies next to the current one, so both work during the window.");
  if (changes.includes("runnerId")) steps.push("Start the new runner (registered with a fresh registration token) before promoting; the current runner keeps serving until promotion.");
  if (changes.includes("credentialRef")) steps.push("Keep the previous vault secret valid until promotion completes, then delete it.");
  if (!steps.length) steps.push(`Make sure the new ${config.provider} access trusts the same Zenith workload subject as the current access, then verify.`);
  return steps;
};

/** Validate a patch against the current connection without staging anything. Throws `LifecycleRefusal`. */
export async function previewRotation(ctx: ActionContext, input: { connectionId: string; patch: Record<string, unknown> }): Promise<string[]> {
  const { row } = await load(ctx, input.connectionId);
  if (row.status === "revoked") throw new LifecycleRefusal("This connection is revoked. Revocation is terminal; create a new connection.");
  try {
    const candidate = applyRotationPatch(row.config, input.patch, { newExternalId: () => "zenith-preview" });
    return changedKeys(row.config, candidate);
  } catch (error) {
    if (error instanceof LifecycleInputError) throw new LifecycleRefusal(error.message, "invalid_input");
    throw error;
  }
}

/** Stage a candidate, verify it beside the live access, and optionally promote it. */
export async function rotateConnection(ctx: ActionContext, input: RotateInput): Promise<RotationOutcome> {
  const { repos, sql, row } = await load(ctx, input.connectionId);
  if (row.status === "revoked") throw new LifecycleRefusal("This connection is revoked. Revocation is terminal; create a new connection.");
  let candidate: ConnectionConfig;
  let externalId: string | undefined;
  try {
    candidate = applyRotationPatch(row.config, input.patch, { newExternalId: () => (externalId = generateExternalId()) });
    const nextRunner = runnerOf(candidate);
    if (nextRunner && nextRunner !== runnerOf(row.config)) await activeRunner(ctx, nextRunner);
  } catch (error) {
    if (error instanceof LifecycleInputError) throw new LifecycleRefusal(error.message, "invalid_input");
    throw error;
  }
  let rotation: ConnectionRotation | null;
  try {
    rotation = await repos.connectionRotations.stage(sql, { workspaceId: ctx.workspaceId, connectionId: row.id, candidateConfig: candidate, createdBy: ctx.actor.id });
  } catch (error) {
    if (error instanceof ControlStoreError) throw new LifecycleRefusal(error.message, error.code === "invalid_state" ? "invalid_state" : "invalid_input");
    throw error;
  }
  if (!rotation) throw new LifecycleRefusal(NOT_FOUND, "not_found");
  const changes = changedKeys(row.config, candidate);
  const result = await verifyCandidate(ctx, sql, row, candidate);
  const verifiedRotation = await repos.connectionRotations.recordCandidateVerification(sql, { workspaceId: ctx.workspaceId, id: rotation.id, ok: result.ok, detail: result.detail.slice(0, 900) });
  if (!verifiedRotation) throw new LifecycleRefusal("The rotation was discarded or the connection was revoked during verification.");
  const base: Omit<RotationOutcome, "connection" | "nextSteps" | "promoted"> = { rotationId: rotation.id, status: verifiedRotation.status, verified: result.ok, detail: result.detail, ...(externalId ? { externalId } : {}) };
  if (result.ok && input.promote) {
    const promoted = await promoteRotation(ctx, { connectionId: row.id, rotationId: rotation.id, retirePreviousRunner: input.retirePreviousRunner });
    return { ...promoted, ...(externalId ? { externalId } : {}) };
  }
  const after = await repos.connections.get(sql, ctx.workspaceId, row.id);
  return {
    ...base, promoted: false,
    connection: viewOf(ctx, after ?? row, verifiedRotation),
    nextSteps: result.ok
      ? ["The candidate verified. The current access is still serving. Promote the rotation to switch, or abort to discard it."]
      : ["The candidate did not verify, so it cannot be promoted. The current access is unchanged. " + rotationGuidance(candidate, externalId, changes).join(" "), "Fix the customer-side trust, then run rotate again (this staged candidate is replaced)."],
  };
}

export async function promoteRotation(ctx: ActionContext, input: RotationRef): Promise<RotationOutcome> {
  const { repos, sql, row } = await load(ctx, input.connectionId);
  const rotation = await repos.connectionRotations.get(sql, ctx.workspaceId, input.rotationId);
  if (!rotation || rotation.connectionId !== row.id) throw new LifecycleRefusal("That rotation does not exist for this connection.", "not_found");
  const promote = (handle: Sql) => repos.connectionRotations.promote(handle, { workspaceId: ctx.workspaceId, id: rotation.id, actorId: ctx.actor.id });
  const result = rotation.candidateConfig.mode === "runner" ? await sql.tx(async (tx) => {
    await tx.query("select id from platform.connection_rotations where workspace_id=$1 and id=$2 for update", [ctx.workspaceId, rotation.id]);
    await tx.query("select id from platform.provider_connections where workspace_id=$1 and id=$2 for update", [ctx.workspaceId, row.id]);
    await tx.query("select id from platform.runners where workspace_id=$1 and id=$2 for share", [ctx.workspaceId, runnerOf(rotation.candidateConfig)]);
    const checked = await verifyRunnerReadiness(tx, ctx.workspaceId, rotation.candidateConfig);
    if (!checked.ok) throw new LifecycleRefusal(`The candidate runner is no longer ready: ${checked.detail}`);
    return promote(tx);
  }) : await promote(sql);
  if (!result.ok) {
    const why: Record<typeof result.reason, string> = {
      not_found: "That rotation does not exist for this connection.",
      not_verified: "The candidate has not passed verification. Run rotate again, or fix the trust, before promoting.",
      stale_verification: "The candidate was verified too long ago. Run rotate again so it is re-verified, then promote.",
      base_changed: "The connection changed after this rotation was staged. Abort it and stage a new one.",
      revoked: "The connection was revoked. Revocation is terminal; create a new connection.",
    };
    throw new LifecycleRefusal(why[result.reason], result.reason === "not_found" ? "not_found" : "invalid_state");
  }
  await mirrorProduct(ctx, row, (conn) => { conn.status = "healthy"; conn.lastCheckedAt = new Date().toISOString(); });
  const outcome: RotationOutcome = {
    rotationId: result.rotation.id, status: "promoted", verified: true, detail: result.rotation.verificationDetail ?? "", promoted: true,
    connection: viewOf(ctx, result.connection),
    nextSteps: ["The new access is live. Remove the previous access on the customer side now: it is no longer used."],
  };
  const previousRunner = runnerOf(result.previousConfig);
  if (input.retirePreviousRunner && previousRunner && previousRunner !== runnerOf(result.connection.config)) {
    const retired = await retireRunner(ctx, previousRunner, row.id);
    if (retired.revoked) outcome.runnerRevoked = retired.revoked;
    if (retired.kept) outcome.runnerKept = retired.kept;
  }
  return outcome;
}

export async function abortRotation(ctx: ActionContext, input: { connectionId: string; rotationId: string }): Promise<{ rotationId: string; connection: ConnectionView }> {
  const { repos, sql, row } = await load(ctx, input.connectionId);
  const rotation = await repos.connectionRotations.get(sql, ctx.workspaceId, input.rotationId);
  if (!rotation || rotation.connectionId !== row.id) throw new LifecycleRefusal("That rotation does not exist for this connection.", "not_found");
  const aborted = await repos.connectionRotations.abort(sql, { workspaceId: ctx.workspaceId, id: rotation.id, actorId: ctx.actor.id });
  if (!aborted) throw new LifecycleRefusal("That rotation is already resolved.");
  return { rotationId: aborted.id, connection: viewOf(ctx, row) };
}
