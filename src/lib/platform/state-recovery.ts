/**
 * State backend capability proof and human-approved restore (PROD-DUR-06).
 *
 * Models and integrations may PROPOSE a restore; only a person in a browser can approve the exact proposal digest, and
 * only a person in a browser can run it. Execution:
 *  - re-derives ownership: the backend digest must equal one recorded by a plan artifact of the SAME tenant and environment,
 *    and the state key must live under that tenant's own prefix, so another tenant's state is unreachable;
 *  - re-probes the live backend: bucket versioning proven enabled, no state lock held, encryption present, and the current
 *    version still equals the one the human reviewed;
 *  - runs under the environment lease, so Zenith's own apply/destroy cannot interleave;
 *  - writes the approved earlier version as a NEW current version (compare-and-set) and reads it back to prove its digest.
 * No path in this module deletes an object, a version or a lock. A write that cannot be confirmed is recorded as
 * failed_uncertain and is never retried automatically. AWS S3, GCS, Azure Blob and OCI Object Storage have restore adapters; http and local are refused
 * with a plain reason, and a PostgreSQL state backend is refused because it has no object versions.
 */
import { createHash } from "node:crypto";
import type { Principal, Sql } from "@/lib/controlplane/types";
import type { ProviderConnection } from "@/lib/credentials/types";
import type { BrowserSessionProof } from "@/lib/capabilities/types";
import type { RoleResolver } from "@/lib/capabilities/ports";
import { BrokerError, notFound } from "@/lib/capabilities/errors";
import { requireHumanSession } from "@/lib/capabilities/internal";
import { backendFile, type BackendConfig } from "@/lib/tofu/backend-config";
import { backendForConnection } from "@/lib/tofu/backends";
import { stableJson } from "@/lib/tofu/stable";
import { assessBackend, assertBackendAdmissible, restoreRefusals, type BackendCapabilities, type BackendProbeVerdict } from "@/lib/tofu/backend-capabilities";
import { StateBackendError, type StateBackendStore, type StateObjectVersion } from "@/lib/tofu/state-backend-s3";
import { openStateStore } from "@/lib/tofu/state-backend-open";
import { TofuWorkspaceError } from "@/lib/tofu/workspace-error";
import * as recovery from "@/lib/controlplane/db/repos/state-backend-recovery";
import { withLease, LeaseUnavailableError } from "@/lib/controlplane/leases";
import { isVaultRef } from "@/lib/secrets/refs";

export interface RecoveryCaller { principal: Principal; workspaceId: string; session?: BrowserSessionProof }
export interface StateRecoveryDeps {
  readonly db: Sql;
  readonly roles: RoleResolver;
  readonly connection: (workspaceId: string, connectionId: string) => Promise<ProviderConnection | null>;
  readonly secret: (workspaceId: string, ref: string) => Promise<string | undefined>;
  /** Receives the raw tenant vault secret and parses it per provider. Defaults to the AWS, GCS, Azure and OCI adapters. */
  readonly openStore?: (backend: BackendConfig, region: string, stateKey: string, rawSecret: string) => Promise<StateBackendStore>;
}
export interface StateBackendView {
  environmentId: string; backendKind: string; backendDigest: string; stateKey: string;
  capabilities: BackendCapabilities; probe?: { id: string; createdAt: string; verdict: BackendProbeVerdict };
  restores: recovery.StateRestoreRecord[]; evidence: "contract";
}
interface Target { backend: BackendConfig; region: string; stateKey: string; backendDigest: string; projectId: string }

const ID = /^[A-Za-z0-9_-]{1,200}$/;
const refused = (message: string, fix?: string): BrokerError => new BrokerError("invalid_state", message, fix);

/** Digest of the serialized backend file exactly as the plan artifact manifest records it. */
export function backendDigestFor(backend: BackendConfig, region: string, stateKey: string): string {
  const file = backendFile(backend, region, stateKey).file;
  return createHash("sha256").update(stableJson([{ path: "backend.tf.json", content: stableJson(file) }])).digest("hex");
}

export function createStateRecovery(deps: StateRecoveryDeps) {
  const open = deps.openStore ?? openStateStore;

  async function member(caller: RecoveryCaller, writer: boolean) {
    const access = await deps.roles.resolve(caller.principal, caller.workspaceId);
    if (access.role === "none") throw notFound();
    if (writer && access.role === "viewer") throw new BrokerError("role_insufficient", "A viewer cannot propose or decide a state restore.", "Ask an editor or admin.");
    return access;
  }
  async function target(workspaceId: string, environmentId: string, connectionId: string): Promise<Target> {
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
    return { backend: chosen.backend, region, stateKey: chosen.stateKey, backendDigest, projectId: owner.projectId };
  }
  async function store(workspaceId: string, credentialsRef: string, t: { backend: BackendConfig; region: string; stateKey: string }): Promise<StateBackendStore> {
    if (!isVaultRef(credentialsRef)) throw new BrokerError("invalid_request", "credentialsRef must be a vault reference.");
    const raw = await deps.secret(workspaceId, credentialsRef);
    if (raw === undefined) throw refused("The credentials secret was not found in this workspace.");
    try { return await open(t.backend, t.region, t.stateKey, raw); }
    catch (error) {
      if (error instanceof StateBackendError) throw refused(error.message);
      throw refused("The state backend could not be opened with the supplied credentials.");
    }
  }

  /** A restore id from another environment or tenant is the same 404 as a missing one, checked before any action. */
  async function inEnvironment(workspaceId: string, environmentId: string, restoreId: string): Promise<recovery.StateRestoreRecord> {
    if (!ID.test(environmentId) || !ID.test(restoreId)) throw notFound();
    const row = await recovery.get(deps.db, workspaceId, restoreId);
    if (!row || row.environmentId !== environmentId) throw notFound();
    return row;
  }

  return Object.freeze({
    /** Static matrix, last live probe and restore history. Reads nothing from the backend. */
    async describe(caller: RecoveryCaller, environmentId: string, connectionId: string): Promise<StateBackendView> {
      await member(caller, false);
      const t = await target(caller.workspaceId, environmentId, connectionId);
      const probe = await recovery.latestProbe(deps.db, caller.workspaceId, environmentId, t.backendDigest);
      await recovery.expireStale(deps.db, caller.workspaceId);
      return { environmentId, backendKind: t.backend.kind, backendDigest: t.backendDigest, stateKey: t.stateKey, capabilities: assessBackend(t.backend),
        ...(probe ? { probe } : {}), restores: await recovery.list(deps.db, caller.workspaceId, environmentId, 50), evidence: "contract" };
    },
    /** Live probe. Read-only against the backend; the verdict is stored as immutable evidence. */
    async probe(caller: RecoveryCaller, input: { environmentId: string; connectionId: string; credentialsRef: string }): Promise<{ verdict: BackendProbeVerdict; refusals: string[] }> {
      await member(caller, true);
      const t = await target(caller.workspaceId, input.environmentId, input.connectionId);
      const verdict = await (await store(caller.workspaceId, input.credentialsRef, t)).probe();
      await recovery.recordProbe(deps.db, { workspaceId: caller.workspaceId, projectId: t.projectId, environmentId: input.environmentId, backendDigest: t.backendDigest, verdict });
      return { verdict, refusals: restoreRefusals(assessBackend(t.backend), verdict) };
    },
    async versions(caller: RecoveryCaller, input: { environmentId: string; connectionId: string; credentialsRef: string }): Promise<StateObjectVersion[]> {
      await member(caller, true);
      const t = await target(caller.workspaceId, input.environmentId, input.connectionId);
      return (await store(caller.workspaceId, input.credentialsRef, t)).listVersions(50);
    },
    /** Bind the exact effect: the earlier version's digest and the current version at review time. Writes nothing to the backend. */
    async propose(caller: RecoveryCaller, input: { environmentId: string; connectionId: string; credentialsRef: string; sourceVersionId: string }): Promise<recovery.StateRestoreRecord> {
      await member(caller, true);
      const t = await target(caller.workspaceId, input.environmentId, input.connectionId);
      const caps = assessBackend(t.backend);
      const s = await store(caller.workspaceId, input.credentialsRef, t);
      const probe = await s.probe();
      await recovery.recordProbe(deps.db, { workspaceId: caller.workspaceId, projectId: t.projectId, environmentId: input.environmentId, backendDigest: t.backendDigest, verdict: probe });
      const why = restoreRefusals(caps, probe);
      if (why.length) throw refused(`A restore cannot be proposed: ${why.join(" ")}`);
      let source;
      try { source = await s.readVersion(input.sourceVersionId); } catch { throw refused("The requested state version could not be read."); }
      if (source.versionId !== input.sourceVersionId || probe.currentVersionId === input.sourceVersionId) throw refused("The requested version is unavailable or is already current.");
      return recovery.propose(deps.db, { workspaceId: caller.workspaceId, projectId: t.projectId, environmentId: input.environmentId, backendDigest: t.backendDigest,
        backend: { config: t.backend, region: t.region }, stateKey: t.stateKey, sourceVersionId: source.versionId, sourceSha256: source.sha256,
        currentVersionId: probe.currentVersionId!, credentialsRef: input.credentialsRef, requestedBy: { kind: caller.principal.kind, id: caller.principal.id } });
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
      const restoreId = row.id;
      if (row.status !== "approved") throw new BrokerError("approval_required", `This restore is ${row.status}; only an approved restore can run.`);
      const stored = await recovery.backendOf(deps.db, caller.workspaceId, restoreId) as { config?: BackendConfig; region?: string } | null;
      if (!stored?.config || typeof stored.region !== "string") throw refused("The stored backend description is unavailable.");
      const config = stored.config, region = stored.region;
      // Ownership and effect are re-derived, never trusted from the stored row alone.
      if (backendDigestFor(config, region, row.stateKey) !== row.backendDigest) throw refused("The stored backend no longer matches its approved digest.");
      const owner = await recovery.provenOwner(deps.db, caller.workspaceId, row.environmentId, row.backendDigest);
      if (!owner || owner.projectId !== row.projectId || !row.stateKey.startsWith(`zenith/${caller.workspaceId}/${row.environmentId}/`)) throw refused("Ownership of this state is no longer proven.");
      const s = await store(caller.workspaceId, row.credentialsRef, { backend: config, region, stateKey: row.stateKey });
      const caps = assessBackend(config);
      const pre = await s.probe();
      await recovery.recordProbe(deps.db, { workspaceId: caller.workspaceId, projectId: row.projectId, environmentId: row.environmentId, backendDigest: row.backendDigest, verdict: pre });
      const why = restoreRefusals(caps, pre);
      if (pre.currentVersionId !== row.currentVersionId) why.push("The current state changed after review; propose the restore again.");
      if (why.length) throw refused(`The restore was not run: ${why.join(" ")}`);
      let outcome: recovery.StateRestoreRecord | undefined;
      try {
        outcome = await withLease(deps.db, { scope: `env:${row.environmentId}`, holder: `state-restore:${row.id}`, workspaceId: caller.workspaceId, ttlMs: 120_000 }, async (_lease, signal) => {
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
      } catch (error) {
        // A lost lease or database fault after the CAS leaves the row recorded, never silently approved again.
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
