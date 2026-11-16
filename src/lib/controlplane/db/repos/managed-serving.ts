/**
 * Custom-domain claims and scoped object-storage key records for the Zenith-managed platform (PROD-MAN-02/03).
 *
 * Every function filters on `workspace_id` in SQL; a foreign id is the same as a missing one. The only two system-level
 * functions are `listDomainsDue` and `listRevokePending`: they feed the durable renewal job across workspaces and return rows
 * that always carry their own workspace id, which the job passes back into the workspace-bound functions.
 *
 * No secret is stored here. A domain row holds the SHA-256 of the exact TXT value that proves ownership (the token itself is
 * shown once to the claimant), and a key row holds the vault REFERENCE of the credential, never its value.
 */
import type { Sql } from "@/lib/controlplane/types";
import { ControlStoreError, PlatformDbError, requireText } from "../errors";
import { clampLimit, newId, requireDigest } from "../sql";

const iso = (v: unknown): string => new Date(v as string).toISOString();
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

/* --------------------------------- domains -------------------------------- */

export const DOMAIN_STATUSES = ["pending", "verified", "lapsed", "revoked"] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];
export const DOMAIN_OUTCOMES = ["verified", "not_found", "mismatch", "uncertain"] as const;
export type DomainOutcome = (typeof DOMAIN_OUTCOMES)[number];

export interface ManagedDomain {
  id: string;
  workspaceId: string;
  environmentId: string;
  hostname: string;
  status: DomainStatus;
  challengeIssuedAt: string;
  verifiedAt: string | null;
  expiresAt: string | null;
  lastCheckedAt: string | null;
  lastOutcome: DomainOutcome | null;
  failureCount: number;
  lapsedAt: string | null;
  revokedAt: string | null;
  requestedBy: string;
  createdAt: string;
  updatedAt: string;
}

interface DomainRow {
  id: string; workspace_id: string; environment_id: string; hostname: string; status: DomainStatus; challenge_hash: string; challenge_issued_at: unknown;
  verified_at: unknown; expires_at: unknown; last_checked_at: unknown; last_outcome: DomainOutcome | null; failure_count: number; lapsed_at: unknown; revoked_at: unknown;
  revoked_by: string | null; requested_by: string; created_at: unknown; updated_at: unknown;
}
const DOMAIN_COLUMNS = "id, workspace_id, environment_id, hostname, status, challenge_hash, challenge_issued_at, verified_at, expires_at, last_checked_at, last_outcome, failure_count, lapsed_at, revoked_at, revoked_by, requested_by, created_at, updated_at";

const toDomain = (r: DomainRow): ManagedDomain => ({
  id: r.id, workspaceId: r.workspace_id, environmentId: r.environment_id, hostname: r.hostname, status: r.status, challengeIssuedAt: iso(r.challenge_issued_at),
  verifiedAt: isoOrNull(r.verified_at), expiresAt: isoOrNull(r.expires_at), lastCheckedAt: isoOrNull(r.last_checked_at), lastOutcome: r.last_outcome,
  failureCount: Number(r.failure_count), lapsedAt: isoOrNull(r.lapsed_at), revokedAt: isoOrNull(r.revoked_at), requestedBy: r.requested_by, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});

const HOSTNAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])$/;
const requireHostname = (v: unknown): string => {
  if (typeof v !== "string" || !HOSTNAME.test(v)) throw new ControlStoreError("invalid_input", "hostname must be a lowercase DNS name.", { field: "hostname" });
  return v;
};

export interface ClaimDomainInput {
  workspaceId: string;
  environmentId: string;
  hostname: string;
  /** SHA-256 hex of the exact TXT value the claimant must publish */
  challengeHash: string;
  requestedBy: string;
  /** most live (pending within the TTL, or verified) claims one environment may hold */
  maxLive: number;
  /** a pending claim older than this no longer counts toward `maxLive` */
  pendingTtlMs: number;
  now: Date;
}

export type ClaimDomainResult = { outcome: "created" | "reissued" | "already_verified"; domain: ManagedDomain };

/**
 * Create a pending claim, or re-issue the challenge of the caller's own pending claim. A hostname that is verified for another
 * workspace is a `conflict` that says nothing about who holds it.
 */
export async function claimDomain(sql: Sql, input: ClaimDomainInput): Promise<ClaimDomainResult> {
  const workspaceId = requireText("workspaceId", input.workspaceId);
  const environmentId = requireText("environmentId", input.environmentId);
  const hostname = requireHostname(input.hostname);
  const challengeHash = requireDigest("challengeHash", input.challengeHash);
  const requestedBy = requireText("requestedBy", input.requestedBy, 200);
  if (!Number.isInteger(input.maxLive) || input.maxLive < 1 || input.maxLive > 1000) throw new ControlStoreError("invalid_input", "maxLive is out of range.", { field: "maxLive" });
  return sql.tx(async (tx) => {
    const foreign = await tx.query<{ n: number }>(
      "select 1 as n from platform.managed_domains where hostname = $1 and status = 'verified' and workspace_id <> $2 limit 1", [hostname, workspaceId]);
    if (foreign[0]) throw new ControlStoreError("conflict", "That hostname is not available to claim.");
    const own = await tx.query<DomainRow>(
      `select ${DOMAIN_COLUMNS} from platform.managed_domains where workspace_id = $1 and environment_id = $2 and hostname = $3 and status in ('pending','verified') for update`,
      [workspaceId, environmentId, hostname]);
    if (own[0]?.status === "verified") return { outcome: "already_verified" as const, domain: toDomain(own[0]) };
    if (own[0]) {
      const updated = await tx.query<DomainRow>(
        `update platform.managed_domains set challenge_hash = $4, challenge_issued_at = $5::timestamptz, requested_by = $6, last_outcome = null, updated_at = clock_timestamp()
          where workspace_id = $1 and id = $2 and status = 'pending' and environment_id = $3 returning ${DOMAIN_COLUMNS}`,
        [workspaceId, own[0].id, environmentId, challengeHash, input.now.toISOString(), requestedBy]);
      return { outcome: "reissued" as const, domain: toDomain(updated[0]) };
    }
    const live = await tx.query<{ n: string | number }>(
      `select count(*) as n from platform.managed_domains where workspace_id = $1 and environment_id = $2
         and (status = 'verified' or (status = 'pending' and challenge_issued_at > $3::timestamptz - ($4::bigint * interval '1 millisecond')))`,
      [workspaceId, environmentId, input.now.toISOString(), Math.trunc(input.pendingTtlMs)]);
    if (Number(live[0]?.n ?? 0) >= input.maxLive) throw new ControlStoreError("value_out_of_range", `This environment already holds ${input.maxLive} custom domain claims.`);
    const inserted = await tx.query<DomainRow>(
      `insert into platform.managed_domains (id, workspace_id, environment_id, hostname, status, challenge_hash, challenge_issued_at, requested_by)
       values ($1,$2,$3,$4,'pending',$5,$6::timestamptz,$7) returning ${DOMAIN_COLUMNS}`,
      [newId("dom"), workspaceId, environmentId, hostname, challengeHash, input.now.toISOString(), requestedBy]);
    return { outcome: "created" as const, domain: toDomain(inserted[0]) };
  });
}

/** The row plus its challenge hash, for the verifier only. The hash never leaves the service layer. */
export async function getDomainForVerification(sql: Sql, workspaceId: string, id: string): Promise<(ManagedDomain & { challengeHash: string }) | null> {
  const rows = await sql.query<DomainRow>(`select ${DOMAIN_COLUMNS} from platform.managed_domains where workspace_id = $1 and id = $2`, [requireText("workspaceId", workspaceId), requireText("id", id)]);
  return rows[0] ? { ...toDomain(rows[0]), challengeHash: rows[0].challenge_hash } : null;
}

export async function getDomain(sql: Sql, workspaceId: string, id: string): Promise<ManagedDomain | null> {
  const rows = await sql.query<DomainRow>(`select ${DOMAIN_COLUMNS} from platform.managed_domains where workspace_id = $1 and id = $2`, [requireText("workspaceId", workspaceId), requireText("id", id)]);
  return rows[0] ? toDomain(rows[0]) : null;
}

export async function listDomains(sql: Sql, workspaceId: string, environmentId: string, opts: { limit?: number } = {}): Promise<ManagedDomain[]> {
  const rows = await sql.query<DomainRow>(
    `select ${DOMAIN_COLUMNS} from platform.managed_domains where workspace_id = $1 and environment_id = $2 order by created_at desc, id limit $3`,
    [requireText("workspaceId", workspaceId), requireText("environmentId", environmentId), clampLimit(opts.limit, 100, 200)]);
  return rows.map(toDomain);
}

/**
 * The hostnames an environment may serve right now: status verified AND not past its proof expiry plus grace (so a stopped
 * renewal job can never keep a host served forever). Sorted for byte-stable rendering.
 */
export async function verifiedHostnames(sql: Sql, workspaceId: string, environmentId: string, opts: { now: Date; graceMs: number }): Promise<string[]> {
  const rows = await sql.query<{ hostname: string }>(
    `select hostname from platform.managed_domains where workspace_id = $1 and environment_id = $2 and status = 'verified'
        and expires_at + ($4::bigint * interval '1 millisecond') > $3::timestamptz order by hostname`,
    [requireText("workspaceId", workspaceId), requireText("environmentId", environmentId), opts.now.toISOString(), Math.trunc(opts.graceMs)]);
  return rows.map((r) => r.hostname);
}

export interface DomainTransition {
  /** the status the row must still have; a concurrent change makes this a no-op returning null */
  expect: DomainStatus;
  status: DomainStatus;
  outcome: DomainOutcome;
  checkedAt: Date;
  verifiedAt?: Date | null;
  expiresAt?: Date | null;
  failureCount: number;
  lapsedAt?: Date | null;
}

/** Apply one verification observation. Guarded on the expected status; a lost race returns null (the next pass re-derives). */
export async function applyDomainTransition(sql: Sql, workspaceId: string, id: string, t: DomainTransition): Promise<ManagedDomain | null> {
  if (!DOMAIN_STATUSES.includes(t.status) || !DOMAIN_STATUSES.includes(t.expect)) throw new ControlStoreError("invalid_input", "Unknown domain status.", { field: "status" });
  if (!DOMAIN_OUTCOMES.includes(t.outcome)) throw new ControlStoreError("invalid_input", "Unknown domain outcome.", { field: "outcome" });
  try {
    const rows = await sql.query<DomainRow>(
      `update platform.managed_domains set status = $4, last_outcome = $5, last_checked_at = $6::timestamptz, failure_count = $7,
              verified_at = case when $8::boolean then $9::timestamptz else verified_at end,
              expires_at = case when $8::boolean then $10::timestamptz else expires_at end,
              lapsed_at = case when $4 = 'lapsed' then coalesce($11::timestamptz, $6::timestamptz) else lapsed_at end,
              updated_at = clock_timestamp()
        where workspace_id = $1 and id = $2 and status = $3 returning ${DOMAIN_COLUMNS}`,
      [requireText("workspaceId", workspaceId), requireText("id", id), t.expect, t.status, t.outcome, t.checkedAt.toISOString(), Math.max(0, Math.trunc(t.failureCount)),
       t.verifiedAt !== undefined, t.verifiedAt ? t.verifiedAt.toISOString() : null, t.expiresAt ? t.expiresAt.toISOString() : null, t.lapsedAt ? t.lapsedAt.toISOString() : null]);
    return rows[0] ? toDomain(rows[0]) : null;
  } catch (error) {
    // the global unique index on verified hostnames: another workspace proved it first
    if (error instanceof PlatformDbError && error.isUniqueViolation) throw new ControlStoreError("conflict", "That hostname is not available to claim.");
    throw error;
  }
}

/** Revoke a live or lapsed claim. Terminal: a revoked row is never verified again; a new claim is a new row. */
export async function revokeDomain(sql: Sql, workspaceId: string, id: string, by: string, now: Date): Promise<ManagedDomain | null> {
  const rows = await sql.query<DomainRow>(
    `update platform.managed_domains set status = 'revoked', revoked_at = $3::timestamptz, revoked_by = $4, updated_at = clock_timestamp()
      where workspace_id = $1 and id = $2 and status in ('pending','verified','lapsed') returning ${DOMAIN_COLUMNS}`,
    [requireText("workspaceId", workspaceId), requireText("id", id), now.toISOString(), requireText("by", by, 200)]);
  return rows[0] ? toDomain(rows[0]) : null;
}

export interface DueDomain extends ManagedDomain { challengeHash: string }

/**
 * SYSTEM-LEVEL. Verified claims whose proof expires within `windowMs` (or already has), oldest expiry first. Used only by the
 * durable renewal job; each row carries its workspace id.
 */
export async function listDomainsDue(sql: Sql, input: { now: Date; windowMs: number; limit?: number }): Promise<DueDomain[]> {
  const rows = await sql.query<DomainRow>(
    `select ${DOMAIN_COLUMNS} from platform.managed_domains where status = 'verified' and expires_at <= $1::timestamptz + ($2::bigint * interval '1 millisecond')
      order by expires_at, id limit $3`,
    [input.now.toISOString(), Math.trunc(input.windowMs), clampLimit(input.limit, 50, 200)]);
  return rows.map((r) => ({ ...toDomain(r), challengeHash: r.challenge_hash }));
}

/* ------------------------------ storage keys ------------------------------ */

export const STORAGE_KEY_STATUSES = ["active", "revoke_pending", "revoked"] as const;
export type StorageKeyStatus = (typeof STORAGE_KEY_STATUSES)[number];

export interface ManagedStorageKey {
  id: string;
  workspaceId: string;
  environmentId: string;
  address: string;
  bucket: string;
  prefix: string;
  policyDigest: string;
  principalName: string;
  accessKeyId: string;
  secretRef: string;
  status: StorageKeyStatus;
  createdAt: string;
  supersededAt: string | null;
  revokedAt: string | null;
}

interface KeyRow {
  id: string; workspace_id: string; environment_id: string; address: string; bucket: string; prefix: string; policy_digest: string; principal_name: string;
  access_key_id: string; secret_ref: string; status: StorageKeyStatus; created_at: unknown; superseded_at: unknown; revoked_at: unknown;
}
const KEY_COLUMNS = "id, workspace_id, environment_id, address, bucket, prefix, policy_digest, principal_name, access_key_id, secret_ref, status, created_at, superseded_at, revoked_at";
const toKey = (r: KeyRow): ManagedStorageKey => ({
  id: r.id, workspaceId: r.workspace_id, environmentId: r.environment_id, address: r.address, bucket: r.bucket, prefix: r.prefix, policyDigest: r.policy_digest,
  principalName: r.principal_name, accessKeyId: r.access_key_id, secretRef: r.secret_ref, status: r.status, createdAt: iso(r.created_at), supersededAt: isoOrNull(r.superseded_at), revokedAt: isoOrNull(r.revoked_at),
});

export interface RecordStorageKeyInput {
  workspaceId: string;
  environmentId: string;
  address: string;
  bucket: string;
  prefix: string;
  policyDigest: string;
  principalName: string;
  accessKeyId: string;
  secretRef: string;
}

/** Make this key the environment's active key for the address; a previous active key becomes `revoke_pending` in the same transaction. */
export async function recordStorageKey(sql: Sql, input: RecordStorageKeyInput): Promise<{ key: ManagedStorageKey; superseded?: ManagedStorageKey }> {
  const workspaceId = requireText("workspaceId", input.workspaceId);
  const environmentId = requireText("environmentId", input.environmentId);
  const address = requireText("address", input.address, 500);
  return sql.tx(async (tx) => {
    const old = await tx.query<KeyRow>(
      `update platform.managed_storage_keys set status = 'revoke_pending', superseded_at = clock_timestamp()
        where workspace_id = $1 and environment_id = $2 and address = $3 and status = 'active' returning ${KEY_COLUMNS}`, [workspaceId, environmentId, address]);
    const rows = await tx.query<KeyRow>(
      `insert into platform.managed_storage_keys (id, workspace_id, environment_id, address, bucket, prefix, policy_digest, principal_name, access_key_id, secret_ref)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning ${KEY_COLUMNS}`,
      [newId("msk"), workspaceId, environmentId, address, requireText("bucket", input.bucket, 63), requireText("prefix", input.prefix, 500), requireDigest("policyDigest", input.policyDigest),
       requireText("principalName", input.principalName, 64), requireText("accessKeyId", input.accessKeyId, 128), requireText("secretRef", input.secretRef, 400)]);
    return { key: toKey(rows[0]), ...(old[0] ? { superseded: toKey(old[0]) } : {}) };
  });
}

export async function activeStorageKey(sql: Sql, workspaceId: string, environmentId: string, address: string): Promise<ManagedStorageKey | null> {
  const rows = await sql.query<KeyRow>(
    `select ${KEY_COLUMNS} from platform.managed_storage_keys where workspace_id = $1 and environment_id = $2 and address = $3 and status = 'active'`,
    [requireText("workspaceId", workspaceId), requireText("environmentId", environmentId), requireText("address", address, 500)]);
  return rows[0] ? toKey(rows[0]) : null;
}

export async function listStorageKeys(sql: Sql, workspaceId: string, environmentId: string, opts: { limit?: number } = {}): Promise<ManagedStorageKey[]> {
  const rows = await sql.query<KeyRow>(
    `select ${KEY_COLUMNS} from platform.managed_storage_keys where workspace_id = $1 and environment_id = $2 order by created_at desc, id limit $3`,
    [requireText("workspaceId", workspaceId), requireText("environmentId", environmentId), clampLimit(opts.limit, 50, 200)]);
  return rows.map(toKey);
}

/** Settle a superseded or retired key after the provider confirmed the revocation. */
export async function markStorageKeyRevoked(sql: Sql, workspaceId: string, id: string, now: Date): Promise<ManagedStorageKey | null> {
  const rows = await sql.query<KeyRow>(
    `update platform.managed_storage_keys set status = 'revoked', revoked_at = $3::timestamptz
      where workspace_id = $1 and id = $2 and status in ('active','revoke_pending') returning ${KEY_COLUMNS}`,
    [requireText("workspaceId", workspaceId), requireText("id", id), now.toISOString()]);
  return rows[0] ? toKey(rows[0]) : null;
}

/** Retire the active key for an address (the object store was removed): it needs provider revocation too. */
export async function retireStorageKey(sql: Sql, workspaceId: string, environmentId: string, address: string): Promise<ManagedStorageKey | null> {
  const rows = await sql.query<KeyRow>(
    `update platform.managed_storage_keys set status = 'revoke_pending', superseded_at = clock_timestamp()
      where workspace_id = $1 and environment_id = $2 and address = $3 and status = 'active' returning ${KEY_COLUMNS}`,
    [requireText("workspaceId", workspaceId), requireText("environmentId", environmentId), requireText("address", address, 500)]);
  return rows[0] ? toKey(rows[0]) : null;
}

/** SYSTEM-LEVEL. Keys whose provider-side revocation is still owed, oldest first. Used by the durable job. */
export async function listRevokePending(sql: Sql, input: { limit?: number } = {}): Promise<ManagedStorageKey[]> {
  const rows = await sql.query<KeyRow>(`select ${KEY_COLUMNS} from platform.managed_storage_keys where status = 'revoke_pending' order by created_at, id limit $1`, [clampLimit(input.limit, 50, 200)]);
  return rows.map(toKey);
}
