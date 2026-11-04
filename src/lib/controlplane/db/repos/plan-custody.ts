/**
 * Worker custody grants for encrypted plan artifacts (PROD-DUR-05). Database-only; every statement is
 * scoped by workspace_id. A grant never contains plan bytes: it records which worker identity may read which
 * immutable artifact for which fence, and the wrap proves the identity (see platform/plan-custody-crypto).
 * Every admission and every re-verification is audited in the append-only plan_custody_reads table,
 * including refusals. Tenant, fence, operation liveness, artifact integrity and expiry are re-evaluated on each call.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "@/lib/controlplane/types";
import { digest } from "@/lib/controlplane/digest";
import { executionHolder } from "@/lib/execution/platform";
import { assertFence } from "./leases";
import { captureArtifactAccess, type ArtifactAccess } from "./plan-artifacts";
import type { CustodyBinding, CustodyCrypto } from "@/lib/platform/plan-custody-crypto";

export const WORKER_IDENTITY = /^[A-Za-z0-9._-]{1,64}$/;

export type CustodyRefusal = "invalid_worker" | "fence_lost" | "operation_not_live" | "artifact_unavailable" | "artifact_expired"
  | "tenant_mismatch" | "worker_revoked" | "grant_missing" | "grant_expired" | "grant_integrity" | "grant_stale" | "unavailable";
export type CustodyPurpose = "admitted" | "inspect_verified" | "dispatch_verified";

export class PlanCustodyError extends Error {
  readonly code = "plan_custody_refused";
  readonly reason: CustodyRefusal;
  constructor(reason: CustodyRefusal) {
    super("Plan custody refused this worker; the reviewed artifact is not available to it.");
    this.reason = reason;
  }
}
const refuse = (reason: CustodyRefusal): never => { throw new PlanCustodyError(reason); };
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

interface ArtifactFacts {
  source_operation_id: string; manifest_digest: string; manifest: Record<string, unknown>; artifact_live: boolean; grant_expires: string;
}
async function recordRead(sql: Sql, input: { workspaceId: string; operationId: string; workerIdentity: string; manifestDigest?: string; outcome: "allowed" | "refused"; reason: string }): Promise<void> {
  await sql.query(
    `insert into platform.plan_custody_reads (id, workspace_id, operation_id, worker_identity, manifest_digest, outcome, reason)
     select $1, $2, $3, $4, $5, $6, $7 where $4 ~ '^[A-Za-z0-9._-]{1,64}$'`,
    [`pcr_${randomUUID()}`, input.workspaceId, input.operationId, input.workerIdentity, input.manifestDigest ?? null, input.outcome, input.reason]);
}

/**
 * Admit one worker identity to the artifact under the live fence. Idempotent for the same identity and fence.
 * Older fences for the operation are revoked: a worker that lost the lease can no longer pass verification.
 */
export async function admit(sql: Sql, access: ArtifactAccess, workerIdentity: string, crypto: CustodyCrypto): Promise<void> {
  access = captureArtifactAccess(access);
  const c = access.custody;
  let manifestDigest: string | undefined;
  try {
    await sql.tx(async (tx) => {
      if (!WORKER_IDENTITY.test(workerIdentity)) refuse("invalid_worker");
      try { await assertFence(tx, access.lease.scope, access.lease.fenceToken); } catch { refuse("fence_lost"); }
      const ownedLease = await tx.query("select scope from platform.leases where scope=$1 and workspace_id=$2 and holder=$3 and fence_token=$4::bigint and expires_at > clock_timestamp() and released_at is null",
        [access.lease.scope, c.workspaceId, access.lease.holder, access.lease.fenceToken]);
      if (!ownedLease.length) refuse("fence_lost");
      const live = await tx.query(`select id from platform.operations where workspace_id=$1 and id=$2 and project_id=$3 and environment_id=$4 and status='running'
        and expires_at > clock_timestamp() and lease_until > clock_timestamp() and lease_holder=$5 and lease_scope=$6 and fence_token=$7::bigint for update`,
        [c.workspaceId, c.operationId, c.projectId, c.environmentId, executionHolder(c.operationId), access.lease.scope, access.lease.fenceToken]);
      if (!live.length) refuse("operation_not_live");
      const facts = (await tx.query<ArtifactFacts>(`select a.operation_id as source_operation_id, a.manifest_digest, a.manifest, a.expires_at > clock_timestamp() as artifact_live,
          to_char(least(a.expires_at, clock_timestamp() + interval '15 minutes') at time zone 'UTC', ${ISO}) as grant_expires
        from platform.plan_artifacts a
        where a.workspace_id=$1 and a.plan_digest=$3 and a.operation_id=coalesce(
          (select x.source_operation_id from platform.plan_artifact_associations x where x.workspace_id=$1 and x.operation_id=$2 and x.expires_at > clock_timestamp()), $2)`,
        [c.workspaceId, c.operationId, access.planDigest]))[0];
      if (!facts) refuse("artifact_unavailable");
      const f = facts!;
      manifestDigest = f.manifest_digest;
      if (f.manifest_digest !== digest(f.manifest)) refuse("artifact_unavailable");
      if (f.manifest.workspaceId !== c.workspaceId || f.manifest.projectId !== c.projectId || f.manifest.environmentId !== c.environmentId) refuse("tenant_mismatch");
      if (!f.artifact_live) refuse("artifact_expired");
      const blocked = await tx.query("select 1 as blocked from platform.plan_custody_grants where workspace_id=$1 and worker_identity=$2 and revoke_reason='worker_revoked' and revoked_at is not null limit 1",
        [c.workspaceId, workerIdentity]);
      if (blocked.length) refuse("worker_revoked");
      await tx.query(`update platform.plan_custody_grants set revoked_at=clock_timestamp(), revoke_reason='superseded_fence'
        where workspace_id=$1 and operation_id=$2 and fence_token < $3::bigint and revoked_at is null`, [c.workspaceId, c.operationId, access.lease.fenceToken]);
      const binding: CustodyBinding = { workspaceId: c.workspaceId, operationId: c.operationId, sourceOperationId: f.source_operation_id,
        manifestDigest: f.manifest_digest, workerIdentity, fenceToken: access.lease.fenceToken, expiresAt: f.grant_expires };
      const existing = (await tx.query<{ revoked: boolean; live: boolean; expires: string; manifest_digest: string; token_digest: string; wrap_iv: string; wrap_tag: string; wrap_ciphertext: string; source_operation_id: string }>(
        `select revoked_at is not null as revoked, expires_at > clock_timestamp() as live, to_char(expires_at at time zone 'UTC', ${ISO}) as expires,
           manifest_digest, token_digest, wrap_iv, wrap_tag, wrap_ciphertext, source_operation_id
         from platform.plan_custody_grants where workspace_id=$1 and operation_id=$2 and worker_identity=$3 and fence_token=$4::bigint for update`,
        [c.workspaceId, c.operationId, workerIdentity, access.lease.fenceToken]))[0];
      if (existing) {
        if (existing.revoked) refuse("worker_revoked");
        const stored: CustodyBinding = { ...binding, sourceOperationId: existing.source_operation_id, manifestDigest: existing.manifest_digest, expiresAt: existing.expires };
        const opens = crypto.opens(stored, { tokenDigest: existing.token_digest, iv: existing.wrap_iv, authTag: existing.wrap_tag, ciphertext: existing.wrap_ciphertext });
        if (opens && existing.live && existing.manifest_digest === f.manifest_digest) {
          await recordRead(tx, { workspaceId: c.workspaceId, operationId: c.operationId, workerIdentity, manifestDigest: f.manifest_digest, outcome: "allowed", reason: "admitted" });
          return;
        }
        if (opens && existing.manifest_digest !== f.manifest_digest) refuse("grant_stale");
        if (!opens) refuse("grant_integrity");
        // An expired but authentic grant is renewed in place under the same live fence.
        const wrap = crypto.wrap(binding);
        await tx.query(`update platform.plan_custody_grants set token_digest=$5, wrap_iv=$6, wrap_tag=$7, wrap_ciphertext=$8, expires_at=$9::timestamptz
          where workspace_id=$1 and operation_id=$2 and worker_identity=$3 and fence_token=$4::bigint and revoked_at is null`,
          [c.workspaceId, c.operationId, workerIdentity, access.lease.fenceToken, wrap.tokenDigest, wrap.iv, wrap.authTag, wrap.ciphertext, f.grant_expires]);
      } else {
        const wrap = crypto.wrap(binding);
        await tx.query(`insert into platform.plan_custody_grants
          (workspace_id, operation_id, worker_identity, fence_token, source_operation_id, manifest_digest, token_digest, wrap_iv, wrap_tag, wrap_ciphertext, expires_at)
          values ($1,$2,$3,$4::bigint,$5,$6,$7,$8,$9,$10,$11::timestamptz)`,
          [c.workspaceId, c.operationId, workerIdentity, access.lease.fenceToken, f.source_operation_id, f.manifest_digest, wrap.tokenDigest, wrap.iv, wrap.authTag, wrap.ciphertext, f.grant_expires]);
      }
      await recordRead(tx, { workspaceId: c.workspaceId, operationId: c.operationId, workerIdentity, manifestDigest: f.manifest_digest, outcome: "allowed", reason: "admitted" });
    });
  } catch (error) {
    const reason: CustodyRefusal = error instanceof PlanCustodyError ? error.reason : "unavailable";
    await recordRead(sql, { workspaceId: c.workspaceId, operationId: c.operationId, workerIdentity, manifestDigest, outcome: "refused", reason }).catch(() => undefined);
    throw error instanceof PlanCustodyError ? error : new PlanCustodyError("unavailable");
  }
}

/** Re-prove the identity, tenant, fence, manifest integrity and expiry. Called before every artifact read and again before dispatch. */
export async function verify(sql: Sql, access: ArtifactAccess, workerIdentity: string, crypto: CustodyCrypto, purpose: CustodyPurpose): Promise<void> {
  access = captureArtifactAccess(access);
  const c = access.custody;
  let manifestDigest: string | undefined;
  try {
    if (!WORKER_IDENTITY.test(workerIdentity)) refuse("invalid_worker");
    const row = (await sql.query<{ revoked: boolean; live: boolean; expires: string; source_operation_id: string; manifest_digest: string; token_digest: string;
      wrap_iv: string; wrap_tag: string; wrap_ciphertext: string; current_digest: string | null; artifact_live: boolean | null; manifest: Record<string, unknown> | null; operation_live: boolean }>(
      `select g.revoked_at is not null as revoked, g.expires_at > clock_timestamp() as live, to_char(g.expires_at at time zone 'UTC', ${ISO}) as expires,
         g.source_operation_id, g.manifest_digest, g.token_digest, g.wrap_iv, g.wrap_tag, g.wrap_ciphertext,
         a.manifest_digest as current_digest, a.expires_at > clock_timestamp() as artifact_live, a.manifest,
         exists (select 1 from platform.operations o where o.workspace_id=g.workspace_id and o.id=g.operation_id and o.status='running'
           and o.expires_at > clock_timestamp() and o.lease_until > clock_timestamp() and o.lease_holder=$5 and o.lease_scope=$6 and o.fence_token=g.fence_token
           and exists (select 1 from platform.leases l where l.scope=o.lease_scope and l.workspace_id=g.workspace_id and l.fence_token=g.fence_token
             and l.expires_at > clock_timestamp() and l.released_at is null)) as operation_live
       from platform.plan_custody_grants g
       left join platform.plan_artifacts a on a.workspace_id=g.workspace_id and a.operation_id=g.source_operation_id and a.plan_digest=$7
       where g.workspace_id=$1 and g.operation_id=$2 and g.worker_identity=$3 and g.fence_token=$4::bigint`,
      [c.workspaceId, c.operationId, workerIdentity, access.lease.fenceToken, executionHolder(c.operationId), access.lease.scope, access.planDigest]))[0];
    if (!row) refuse("grant_missing");
    const g = row!;
    manifestDigest = g.manifest_digest;
    if (g.revoked) refuse("worker_revoked");
    if (!g.live) refuse("grant_expired");
    if (!g.operation_live) refuse("operation_not_live");
    if (g.current_digest === null || g.manifest === null) refuse("artifact_unavailable");
    if (!g.artifact_live) refuse("artifact_expired");
    if (g.current_digest !== g.manifest_digest || g.current_digest !== digest(g.manifest)) refuse("grant_stale");
    if (g.manifest!.workspaceId !== c.workspaceId || g.manifest!.environmentId !== c.environmentId || g.manifest!.projectId !== c.projectId) refuse("tenant_mismatch");
    const binding: CustodyBinding = { workspaceId: c.workspaceId, operationId: c.operationId, sourceOperationId: g.source_operation_id,
      manifestDigest: g.manifest_digest, workerIdentity, fenceToken: access.lease.fenceToken, expiresAt: g.expires };
    if (!crypto.opens(binding, { tokenDigest: g.token_digest, iv: g.wrap_iv, authTag: g.wrap_tag, ciphertext: g.wrap_ciphertext })) refuse("grant_integrity");
    await recordRead(sql, { workspaceId: c.workspaceId, operationId: c.operationId, workerIdentity, manifestDigest, outcome: "allowed", reason: purpose });
  } catch (error) {
    const reason: CustodyRefusal = error instanceof PlanCustodyError ? error.reason : "unavailable";
    await recordRead(sql, { workspaceId: c.workspaceId, operationId: c.operationId, workerIdentity, manifestDigest, outcome: "refused", reason }).catch(() => undefined);
    throw error instanceof PlanCustodyError ? error : new PlanCustodyError("unavailable");
  }
}

/** Revoke every unrevoked grant a worker identity holds in one workspace. Revocation is permanent for that identity there. */
export async function revokeWorker(sql: Sql, workspaceId: string, workerIdentity: string): Promise<number> {
  if (!WORKER_IDENTITY.test(workerIdentity)) return 0;
  const rows = await sql.query<{ n: string }>(
    `with revoked as (
       update platform.plan_custody_grants set revoked_at=coalesce(revoked_at, clock_timestamp()), revoke_reason='worker_revoked'
       where workspace_id=$1 and worker_identity=$2 returning 1)
     select count(*)::text as n from revoked`, [workspaceId, workerIdentity]);
  return Number(rows[0]?.n ?? 0);
}

export interface CustodyReadReceipt { id: string; workerIdentity: string; manifestDigest: string | null; outcome: "allowed" | "refused"; reason: string; createdAt: string }
/** Bounded audit read for operators and tests; carries identities and digests only. */
export async function listReads(sql: Sql, workspaceId: string, operationId: string, limit = 100): Promise<CustodyReadReceipt[]> {
  const rows = await sql.query<{ id: string; worker_identity: string; manifest_digest: string | null; outcome: "allowed" | "refused"; reason: string; created_at: string }>(
    `select id, worker_identity, manifest_digest, outcome, reason, created_at from platform.plan_custody_reads
     where workspace_id=$1 and operation_id=$2 order by created_at, id limit $3`, [workspaceId, operationId, Math.min(Math.max(1, limit), 500)]);
  return rows.map(r => ({ id: r.id, workerIdentity: r.worker_identity, manifestDigest: r.manifest_digest, outcome: r.outcome, reason: r.reason, createdAt: String(r.created_at) }));
}
