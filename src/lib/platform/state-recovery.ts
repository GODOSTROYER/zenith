/**
 * State backend capability proof and human-approved restore (PROD-DUR-06).
 *
 * Models and integrations may PROPOSE a restore; only a human browser session can approve, reject or run it, and approval
 * binds the exact proposal digest. Execution:
 *  - re-derives ownership: the backend digest must equal one recorded by a plan artifact of the SAME tenant and environment,
 *    and the state key must live under that tenant's own prefix, so another tenant's state is unreachable;
 *  - obtains provider credentials ONLY from the existing credential broker (keyless federation or assumed role, the same path
 *    OpenTofu and other provider effects use), so connection mode and custody, revocation and rotation are honoured by the
 *    broker. No stored key, SAS token or vault secret is read. A connection whose mode cannot supply a session for the
 *    backend is refused explicitly (`sessionRefusal`);
 *  - re-probes the live backend: versioning proven enabled, no state lock held, encryption present, and the current
 *    version still equals the one the human reviewed;
 *  - runs under the environment lease, so Zenith's own apply/destroy cannot interleave;
 *  - writes the approved earlier version as a NEW current version (compare-and-set) and reads it back to prove its digest.
 * No path in this module deletes an object, a version or a lock. A write that cannot be confirmed is recorded as
 * failed_uncertain and is never retried automatically. Restore adapters exist for AWS S3 (brokered AWS session, session
 * policy narrowed to the state object) and GCS (brokered GCP session). Azure Blob, OCI Object Storage, http, local and pg are refused
 * with a plain reason.
 */
import { createHash } from "node:crypto";
import type { Principal, Sql } from "@/lib/controlplane/types";
import type { ProviderConnection, ProviderSession } from "@/lib/credentials/types";
import { CredentialDeniedError } from "@/lib/credentials/types";
import type { BrowserSessionProof } from "@/lib/capabilities/types";
import type { RoleResolver } from "@/lib/capabilities/ports";
import { BrokerError, notFound } from "@/lib/capabilities/errors";
import { requireHumanSession } from "@/lib/capabilities/internal";
import { backendFile, type BackendConfig } from "@/lib/tofu/backend-config";
import { backendForConnection } from "@/lib/tofu/backends";
import { stableJson } from "@/lib/tofu/stable";
import { assessBackend, assertBackendAdmissible, restoreRefusals, type BackendCapabilities, type BackendProbeVerdict } from "@/lib/tofu/backend-capabilities";
import { StateBackendError, type StateBackendStore, type StateObjectVersion } from "@/lib/tofu/state-backend-s3";
import { openStateStoreFromSession } from "@/lib/tofu/state-backend-open";
import { TofuWorkspaceError } from "@/lib/tofu/workspace-error";
import * as recovery from "@/lib/controlplane/db/repos/state-backend-recovery";
import { withLease, LeaseUnavailableError } from "@/lib/controlplane/leases";

export interface RecoveryCaller { principal: Principal; workspaceId: string; session?: BrowserSessionProof }

/** One brokered provider session for one narrow purpose. */
export interface StateSessionRequest {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly connectionId: string;
  readonly principalId: string;
  /** observe reads and probes; deploy additionally writes the restored version. */
  readonly purpose: "observe" | "deploy";
  /** Audit correlation, never an operation row. */
  readonly correlation: string;
  readonly digest: string;
  /** AWS only: IAM session policy narrowing the session to the state object. */
  readonly sessionPolicy?: Record<string, unknown>;
}
export interface StateRecoveryDeps {
  readonly db: Sql;
  readonly roles: RoleResolver;
  readonly connection: (workspaceId: string, connectionId: string) => Promise<ProviderConnection | null>;
  /** The existing credential broker path. Production: `createStateSessionPort(platformCredentialBroker(db))`. */
  readonly withSession: <T>(request: StateSessionRequest, fn: (session: ProviderSession) => Promise<T>) => Promise<T>;
  readonly openStore?: (session: ProviderSession, backend: BackendConfig, region: string, stateKey: string) => Promise<StateBackendStore>;
}
export interface StateBackendView {
  environmentId: string; backendKind: string; backendDigest: string; stateKey: string;
  capabilities: BackendCapabilities; session: { available: boolean; reason?: string };
  probe?: { id: string; createdAt: string; verdict: BackendProbeVerdict };
  restores: recovery.StateRestoreRecord[]; evidence: "contract";
}
interface Target { environmentId: string; connection: ProviderConnection; backend: BackendConfig; region: string; stateKey: string; backendDigest: string; projectId: string }

const ID = /^[A-Za-z0-9_-]{1,200}$/;
const refused = (message: string, fix?: string): BrokerError => new BrokerError("invalid_state", message, fix);

/** Digest of the serialized backend file exactly as the plan artifact manifest records it. */
export function backendDigestFor(backend: BackendConfig, region: string, stateKey: string): string {
  const file = backendFile(backend, region, stateKey).file;
  return createHash("sha256").update(stableJson([{ path: "backend.tf.json", content: stableJson(file) }])).digest("hex");
}

/**
 * Why this connection cannot supply a restore session for this backend, or undefined when it can. Deliberately explicit:
 * the broker would also deny these, but the operator should hear the reason before anything is minted.
 */
export function sessionRefusal(connection: ProviderConnection, backend: BackendConfig): string | undefined {
  if (connection.status === "revoked") return "The connection is revoked, so no provider session can be minted.";
  if (connection.status !== "verified") return "The connection is not verified, so no provider session can be minted.";
  const config = connection.config;
  if (backend.kind === "azurerm")
    return "Azure Blob restore is refused: the brokered Azure session authorizes Blob hosts only for a bound source-storage account, so it cannot reach a state storage account, and a stored SAS token or key is not an accepted credential path.";
  if (backend.kind === "s3" && backend.endpoint !== undefined)
    return "OCI Object Storage restore is refused: the brokered OCI session is a runner transport that carries JSON for allowlisted bucket paths only, so object bytes cannot flow through it, and a control-plane held signing key is not an accepted credential path.";
  if (backend.kind === "s3") {
    if (config.provider !== "aws") return "An S3 state backend can only be restored through an AWS connection.";
    if (config.mode === "runner") return "This AWS connection keeps its credentials on a runner (custody mode runner); the control plane cannot hold a session to restore state.";
    return undefined;
  }
  if (backend.kind === "gcs") {
    if (config.provider !== "gcp") return "A GCS state backend can only be restored through a GCP connection.";
    if (config.mode === "runner") return "This GCP connection keeps its credentials on a runner (custody mode runner); the control plane cannot hold a session to restore state.";
    return undefined;
  }
  return `The ${backend.kind} state backend has no restore adapter.`;
}

/** IAM session policy limiting an AWS restore session to the one state object, its lock object and (when configured) its KMS key. */
export function awsStateSessionPolicy(backend: BackendConfig, stateKey: string, purpose: "observe" | "deploy"): Record<string, unknown> {
  if (backend.kind !== "s3") throw new StateBackendError("unsupported_backend", "A state session policy needs an S3 backend.");
  const bucket = `arn:aws:s3:::${backend.bucket}`;
  const objects = [`${bucket}/${stateKey}`, `${bucket}/${stateKey}.tflock`];
  const kms = backend.encryptionKmsKeyArn !== undefined || backend.sseKmsKeyId !== undefined;
  return {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: ["s3:GetBucketVersioning", "s3:ListBucket", "s3:ListBucketVersions"], Resource: [bucket] },
      { Effect: "Allow", Action: ["s3:GetObject", "s3:GetObjectVersion", ...(purpose === "deploy" ? ["s3:PutObject"] : [])], Resource: objects },
      ...(kms ? [{ Effect: "Allow", Action: ["kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"], Resource: ["*"] }] : []),
    ],
  };
}

export function createStateRecovery(deps: StateRecoveryDeps) {
  const open = deps.openStore ?? openStateStoreFromSession;

  async function member(caller: RecoveryCaller, writer: boolean) {
    const access = await deps.roles.resolve(caller.principal, caller.workspaceId);
    if (access.role === "none") throw notFound();
    if (writer && access.role === "viewer") throw new BrokerError("role_insufficient", "A viewer cannot propose or decide a state restore.", "Ask an editor or admin.");
    return access;
  }
  async function targetFor(workspaceId: string, environmentId: string, connectionId: string): Promise<Target> {
    if (!ID.test(environmentId) || !ID.test(connectionId)) throw notFound();
    const connection = await deps.connection(workspaceId, connectionId);
    if (!connection || connection.workspaceId !== workspaceId) throw notFound();
    let chosen: { backend: BackendConfig; stateKey: string };
    try { chosen = backendForConnection(connection, { workspaceId, environmentId }); assertBackendAdmissible(chosen.backend); }
    catch (error) { if (error instanceof TofuWorkspaceError) throw refused(`The state backend is refused: ${error.message.slice(0, 300)}`); throw error; }
    const region = (connection.config as { region?: unknown }).region;
    if (typeof region !== "string") throw refused("The connection has no region.");
    const backendDigest = backendDigestFor(chosen.backend, region, chosen.stateKey);
    const owner = await recovery.provenOwner(deps.db, workspaceId, environmentId, backendDigest);
    if (!owner) throw refused("This backend has no recorded plan for this environment, so Zenith cannot prove it owns this state.", "Run a plan for the environment first.");
    if (!chosen.stateKey.startsWith(`zenith/${workspaceId}/${environmentId}/`)) throw refused("The state key is outside this environment's own prefix.");
    return { environmentId, connection, backend: chosen.backend, region, stateKey: chosen.stateKey, backendDigest, projectId: owner.projectId };
  }
  /** Open the store inside one brokered session. The session ends when `fn` settles. */
  async function withStore<T>(t: Target, caller: RecoveryCaller, purpose: "observe" | "deploy", correlation: string, digest: string, fn: (store: StateBackendStore) => Promise<T>): Promise<T> {
    const why = sessionRefusal(t.connection, t.backend);
    if (why) throw refused(why);
    try {
      return await deps.withSession({ workspaceId: caller.workspaceId, projectId: t.projectId, environmentId: t.environmentId, connectionId: t.connection.id,
        principalId: caller.principal.id, purpose, correlation, digest,
        ...(t.backend.kind === "s3" ? { sessionPolicy: awsStateSessionPolicy(t.backend, t.stateKey, purpose) } : {}) },
        async session => fn(await open(session, t.backend, t.region, t.stateKey)));
    } catch (error) {
      if (error instanceof CredentialDeniedError) throw refused(`The provider session was refused (${error.reason ?? "denied"}): ${error.message.slice(0, 200)}`);
      if (error instanceof StateBackendError && (error.code === "unsupported_backend")) throw refused(error.message);
      throw error;
    }
  }

  /** A restore id from another environment or tenant is the same 404 as a missing one, checked before any action. */
  async function inEnvironment(workspaceId: string, environmentId: string, restoreId: string): Promise<recovery.StateRestoreRecord> {
    if (!ID.test(environmentId) || !ID.test(restoreId)) throw notFound();
    const row = await recovery.get(deps.db, workspaceId, restoreId);
    if (!row || row.environmentId !== environmentId) throw notFound();
    return row;
  }
  const probeDigest = (t: Target, what: string): string => createHash("sha256").update(`${what}|${t.backendDigest}`).digest("hex");

  return Object.freeze({
    /** Static matrix, session availability, last stored probe and restore history. Reads nothing from the backend. */
    async describe(caller: RecoveryCaller, environmentId: string, connectionId: string): Promise<StateBackendView> {
      await member(caller, false);
      const t = await targetFor(caller.workspaceId, environmentId, connectionId);
      const probe = await recovery.latestProbe(deps.db, caller.workspaceId, environmentId, t.backendDigest);
      await recovery.expireStale(deps.db, caller.workspaceId);
      const why = sessionRefusal(t.connection, t.backend);
      return { environmentId, backendKind: t.backend.kind, backendDigest: t.backendDigest, stateKey: t.stateKey, capabilities: assessBackend(t.backend),
        session: why ? { available: false, reason: why } : { available: true },
        ...(probe ? { probe } : {}), restores: await recovery.list(deps.db, caller.workspaceId, environmentId, 50), evidence: "contract" };
    },
    /** Live probe. Read-only against the backend; the verdict is stored as immutable evidence. */
    async probe(caller: RecoveryCaller, input: { environmentId: string; connectionId: string }): Promise<{ verdict: BackendProbeVerdict; refusals: string[] }> {
      await member(caller, true);
      const t = await targetFor(caller.workspaceId, input.environmentId, input.connectionId);
      const verdict = await withStore(t, caller, "observe", `state-probe:${t.backendDigest.slice(0, 16)}`, probeDigest(t, "probe"), s => s.probe());
      await recovery.recordProbe(deps.db, { workspaceId: caller.workspaceId, projectId: t.projectId, environmentId: input.environmentId, backendDigest: t.backendDigest, verdict });
      return { verdict, refusals: restoreRefusals(assessBackend(t.backend), verdict) };
    },
    async versions(caller: RecoveryCaller, input: { environmentId: string; connectionId: string }): Promise<StateObjectVersion[]> {
      await member(caller, true);
      const t = await targetFor(caller.workspaceId, input.environmentId, input.connectionId);
      return withStore(t, caller, "observe", `state-versions:${t.backendDigest.slice(0, 16)}`, probeDigest(t, "versions"), s => s.listVersions(50));
    },
    /** Bind the exact effect: the earlier version's digest and the current version at review time. Writes nothing to the backend. */
    async propose(caller: RecoveryCaller, input: { environmentId: string; connectionId: string; sourceVersionId: string }): Promise<recovery.StateRestoreRecord> {
      await member(caller, true);
      const t = await targetFor(caller.workspaceId, input.environmentId, input.connectionId);
      const caps = assessBackend(t.backend);
      const seen = await withStore(t, caller, "observe", `state-propose:${t.backendDigest.slice(0, 16)}`, probeDigest(t, "propose"), async s => {
        const probe = await s.probe();
        const why = restoreRefusals(caps, probe);
        if (why.length) return { probe, why, source: undefined };
        let source;
        try { source = await s.readVersion(input.sourceVersionId); } catch { throw refused("The requested state version could not be read."); }
        return { probe, why, source };
      });
      await recovery.recordProbe(deps.db, { workspaceId: caller.workspaceId, projectId: t.projectId, environmentId: input.environmentId, backendDigest: t.backendDigest, verdict: seen.probe });
      if (seen.why.length) throw refused(`A restore cannot be proposed: ${seen.why.join(" ")}`);
      const source = seen.source!;
      if (source.versionId !== input.sourceVersionId || seen.probe.currentVersionId === input.sourceVersionId) throw refused("The requested version is unavailable or is already current.");
      return recovery.propose(deps.db, { workspaceId: caller.workspaceId, projectId: t.projectId, environmentId: input.environmentId, backendDigest: t.backendDigest,
        backend: { config: t.backend, region: t.region }, stateKey: t.stateKey, sourceVersionId: source.versionId, sourceSha256: source.sha256,
        currentVersionId: seen.probe.currentVersionId!, connectionId: t.connection.id, requestedBy: { kind: caller.principal.kind, id: caller.principal.id } });
    },
    async approve(caller: RecoveryCaller, input: { environmentId: string; restoreId: string; proposalDigest: string }): Promise<recovery.StateRestoreRecord> {
      requireHumanSession(caller.principal, caller.session, "approve a state restore");
      await member(caller, true);
      await inEnvironment(caller.workspaceId, input.environmentId, input.restoreId);
      try { return await recovery.approve(deps.db, { workspaceId: caller.workspaceId, id: input.restoreId, proposalDigest: input.proposalDigest, approverId: caller.principal.id }); }
      catch (error) { if (error instanceof recovery.StateRecoveryRecordError) throw new BrokerError("digest_mismatch", "The proposal changed, expired or was already decided; reload and review it again."); throw error; }
    },
    async reject(caller: RecoveryCaller, input: { environmentId: string; restoreId: string }): Promise<recovery.StateRestoreRecord> {
      requireHumanSession(caller.principal, caller.session, "reject a state restore");
      await member(caller, true);
      await inEnvironment(caller.workspaceId, input.environmentId, input.restoreId);
      try { return await recovery.reject(deps.db, { workspaceId: caller.workspaceId, id: input.restoreId, approverId: caller.principal.id }); }
      catch (error) { if (error instanceof recovery.StateRecoveryRecordError) throw new BrokerError("invalid_state", "The proposal was already decided."); throw error; }
    },
    /** Run an approved restore. Never deletes. Never retried automatically. */
    async execute(caller: RecoveryCaller, input: { environmentId: string; restoreId: string }): Promise<recovery.StateRestoreRecord> {
      requireHumanSession(caller.principal, caller.session, "run a state restore");
      await member(caller, true);
      const row = await inEnvironment(caller.workspaceId, input.environmentId, input.restoreId);
      if (row.status !== "approved") throw new BrokerError("approval_required", `This restore is ${row.status}; only an approved restore can run.`);
      const stored = await recovery.backendOf(deps.db, caller.workspaceId, row.id) as { config?: BackendConfig; region?: string } | null;
      if (!stored?.config || typeof stored.region !== "string") throw refused("The stored backend description is unavailable.");
      // Ownership, backend and connection are re-derived now, never trusted from the stored row alone.
      const t = await targetFor(caller.workspaceId, row.environmentId, row.connectionId);
      if (t.backendDigest !== row.backendDigest || backendDigestFor(stored.config, stored.region, row.stateKey) !== row.backendDigest || t.stateKey !== row.stateKey || t.projectId !== row.projectId)
        throw refused("The stored backend no longer matches its approved digest, or ownership is no longer proven.");
      const caps = assessBackend(t.backend);
      const correlation = `state-restore:${row.id}`;
      const pre = await withStore(t, caller, "observe", correlation, row.proposalDigest, s => s.probe());
      await recovery.recordProbe(deps.db, { workspaceId: caller.workspaceId, projectId: row.projectId, environmentId: row.environmentId, backendDigest: row.backendDigest, verdict: pre });
      const why = restoreRefusals(caps, pre);
      if (pre.currentVersionId !== row.currentVersionId) why.push("The current state changed after review; propose the restore again.");
      if (why.length) throw refused(`The restore was not run: ${why.join(" ")}`);
      let outcome: recovery.StateRestoreRecord | undefined;
      try {
        outcome = await withLease(deps.db, { scope: `env:${row.environmentId}`, holder: `state-restore:${row.id}`, workspaceId: caller.workspaceId, ttlMs: 120_000 }, async (_lease, signal) => {
          // The write session is minted only after the lease is held, and ends when the restore settles.
          return withStore(t, caller, "deploy", correlation, row.proposalDigest, async s => {
            await recovery.beginExecution(deps.db, caller.workspaceId, row.id);
            try {
              signal.throwIfAborted();
              const source = await s.readVersion(row.sourceVersionId);
              if (source.sha256 !== row.sourceSha256) throw new StateBackendError("source_changed", "The earlier version no longer matches its approved digest.");
              const again = await s.probe();
              if (again.currentVersionId !== row.currentVersionId || again.lockObject !== "absent") throw new StateBackendError("state_changed", "The state changed or was locked after review; nothing was written.");
              const current = await s.readCurrent();
              if (current.versionId !== row.currentVersionId || !current.etag) throw new StateBackendError("state_changed", "The state changed after review; nothing was written.");
              signal.throwIfAborted();
              const written = await s.writeRestored(source.bytes, { currentEtag: current.etag });
              const readback = await s.readCurrent();
              if (readback.versionId !== written.versionId || readback.sha256 !== row.sourceSha256)
                throw new StateBackendError("readback_mismatch", "The restored object did not read back as approved; inspect the state versions. Nothing was deleted.");
              return await recovery.complete(deps.db, caller.workspaceId, row.id, { restoredVersionId: written.versionId, readbackSha256: readback.sha256 });
            } catch (error) {
              const code = error instanceof StateBackendError ? error.code : "unconfirmed";
              await recovery.failUncertain(deps.db, caller.workspaceId, row.id, code).catch(() => undefined);
              throw error;
            }
          });
        });
      } catch (error) {
        // A lost lease, a refused session or a database fault after the CAS leaves the row recorded, never silently approved again.
        const now = await recovery.get(deps.db, caller.workspaceId, row.id).catch(() => null);
        if (now?.status === "executing") await recovery.failUncertain(deps.db, caller.workspaceId, row.id, "lease_lost").catch(() => undefined);
        if (error instanceof LeaseUnavailableError) throw new BrokerError("conflict", "Another operation holds this environment; nothing was changed. Try again when it finishes.");
        if (error instanceof StateBackendError) throw new BrokerError("invalid_state", error.message);
        if (error instanceof BrokerError) throw error;
        throw new BrokerError("conflict", "The restore could not be completed; it is recorded as uncertain and was not retried.");
      }
      return outcome!;
    },
  });
}
export type StateRecovery = ReturnType<typeof createStateRecovery>;
