/**
 * Durable key custody records (PROD-OPS-05; migration 42).
 *
 * Two tables, both non-secret:
 *  - `platform.key_custody_keys`: system-level key facts (purpose-bound id, role, source variable name,
 *    first/last seen, planned and actual retirement). Nothing tenant-owned; keyed by (purpose, key id).
 *  - `platform.key_rewrap_jobs`: workspace-owned durable re-wrap jobs (cursor and counts only). Every
 *    function that takes a workspace filters on `workspace_id`; the only cross-workspace functions are the
 *    scheduler's `claimRewrapJob` and the operator's `listRewrapJobs` without a workspace, both system work
 *    whose rows each carry their workspace and are processed under it.
 *
 * Time is the database clock. Error codes are a fixed vocabulary; no ref, value or error text is stored.
 */
import { ControlStoreError, requireText } from "@/lib/controlplane/db/errors";
import { newId } from "@/lib/controlplane/db/sql";
import type { Sql } from "@/lib/controlplane/types";
import type { KeyDescriptor } from "./registry";
import { isKeyPurpose, type KeyPurpose, type KeyRole } from "./purposes";

export interface StoredKey {
  purpose: KeyPurpose;
  keyId: string;
  role: KeyRole;
  source: string;
  firstSeenAt: string;
  lastSeenAt: string;
  retireAfter: string | null;
  retiredAt: string | null;
  retiredBy: string | null;
}

interface KeyRow {
  purpose: KeyPurpose; key_id: string; role: KeyRole; source: string; first_seen_at: string; last_seen_at: string;
  retire_after: string | null; retired_at: string | null; retired_by: string | null;
}
const KEY_COLUMNS = "purpose, key_id, role, source, first_seen_at::text as first_seen_at, last_seen_at::text as last_seen_at, retire_after::text as retire_after, retired_at::text as retired_at, retired_by";
const toKey = (r: KeyRow): StoredKey => ({
  purpose: r.purpose, keyId: r.key_id, role: r.role, source: r.source, firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at,
  retireAfter: r.retire_after, retiredAt: r.retired_at, retiredBy: r.retired_by,
});

/** Record that these keys are configured now. First-seen is set once; role and last-seen follow the configuration. */
export async function recordKeys(db: Sql, descriptors: readonly KeyDescriptor[]): Promise<number> {
  let written = 0;
  await db.tx(async (tx) => {
    for (const d of descriptors) {
      if (!isKeyPurpose(d.purpose)) throw new ControlStoreError("invalid_input", "Unknown key purpose.");
      await tx.query(
        `insert into platform.key_custody_keys (purpose, key_id, role, source) values ($1, $2, $3, $4)
         on conflict (purpose, key_id) do update set role = excluded.role, source = excluded.source, last_seen_at = clock_timestamp(), retired_at = null, retired_by = null`,
        [d.purpose, d.keyId, d.role, d.source]);
      written++;
    }
  });
  return written;
}

export async function listKeys(db: Sql): Promise<StoredKey[]> {
  return (await db.query<KeyRow>(`select ${KEY_COLUMNS} from platform.key_custody_keys order by purpose, first_seen_at, key_id`)).map(toKey);
}

/** Plan (or clear, with null) the date after which a non-current key should be removed. A current key cannot be given one. */
export async function setRetireAfter(db: Sql, input: { purpose: string; keyId: string; retireAfter: string | null }): Promise<boolean> {
  if (!isKeyPurpose(input.purpose)) throw new ControlStoreError("invalid_input", "Unknown key purpose.");
  const keyId = requireText("keyId", input.keyId, 200);
  if (input.retireAfter !== null && Number.isNaN(Date.parse(input.retireAfter))) throw new ControlStoreError("invalid_input", "retireAfter must be an ISO 8601 date.");
  const rows = await db.query(
    `update platform.key_custody_keys set retire_after = $3::timestamptz
     where purpose = $1 and key_id = $2 and role <> 'current' returning key_id`,
    [input.purpose, keyId, input.retireAfter]);
  return rows.length === 1;
}

/** The operator attests the key is no longer configured anywhere. A key still current refuses. */
export async function markRetired(db: Sql, input: { purpose: string; keyId: string; by: string }): Promise<boolean> {
  if (!isKeyPurpose(input.purpose)) throw new ControlStoreError("invalid_input", "Unknown key purpose.");
  const rows = await db.query(
    `update platform.key_custody_keys set retired_at = clock_timestamp(), retired_by = $3
     where purpose = $1 and key_id = $2 and role <> 'current' and retired_at is null returning key_id`,
    [input.purpose, requireText("keyId", input.keyId, 200), requireText("by", input.by, 200)]);
  return rows.length === 1;
}

/* ------------------------------- rewrap jobs ------------------------------- */

export type RewrapStatus = "pending" | "running" | "completed" | "failed" | "blocked" | "cancelled";
export type RewrapBlockCode = "file_store_requires_cli" | "product_store_unavailable" | "key_unavailable" | "rewrap_failed" | "unreadable_row";

export interface RewrapJob {
  id: string;
  workspaceId: string;
  purpose: "enc:vault";
  targetKeyId: string;
  status: RewrapStatus;
  cursorRef: string;
  inspected: number;
  rewrapped: number;
  unchanged: number;
  batches: number;
  errorCode: string | null;
  requestedBy: string;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
}

interface JobRow {
  id: string; workspace_id: string; purpose: "enc:vault"; target_key_id: string; status: RewrapStatus; cursor_ref: string;
  inspected: number; rewrapped: number; unchanged: number; batches: number; error_code: string | null; requested_by: string;
  created_at: string; started_at: string | null; updated_at: string; finished_at: string | null;
}
const JOB_COLUMNS = "id, workspace_id, purpose, target_key_id, status, cursor_ref, inspected, rewrapped, unchanged, batches, error_code, requested_by, created_at::text as created_at, started_at::text as started_at, updated_at::text as updated_at, finished_at::text as finished_at";
const toJob = (r: JobRow): RewrapJob => ({
  id: r.id, workspaceId: r.workspace_id, purpose: r.purpose, targetKeyId: r.target_key_id, status: r.status, cursorRef: r.cursor_ref,
  inspected: r.inspected, rewrapped: r.rewrapped, unchanged: r.unchanged, batches: r.batches, errorCode: r.error_code, requestedBy: r.requested_by,
  createdAt: r.created_at, startedAt: r.started_at, updatedAt: r.updated_at, finishedAt: r.finished_at,
});
const WORKSPACE = /^[A-Za-z0-9_-]{1,128}$/;
function workspace(value: string): string {
  if (!WORKSPACE.test(value)) throw new ControlStoreError("invalid_input", "A valid workspace id is required.");
  return value;
}

/** Idempotent: an already-open job for the workspace is returned instead of creating a second. */
export async function enqueueRewrapJob(db: Sql, input: { workspaceId: string; targetKeyId: string; requestedBy: string }): Promise<{ job: RewrapJob; created: boolean }> {
  const workspaceId = workspace(input.workspaceId);
  const targetKeyId = requireText("targetKeyId", input.targetKeyId, 200);
  const requestedBy = requireText("requestedBy", input.requestedBy, 200);
  return db.tx(async (tx) => {
    const inserted = await tx.query<JobRow>(
      `insert into platform.key_rewrap_jobs (id, workspace_id, purpose, target_key_id, requested_by) values ($1, $2, 'enc:vault', $3, $4)
       on conflict (workspace_id, purpose) where status in ('pending','running') do nothing returning ${JOB_COLUMNS}`,
      [newId("krw"), workspaceId, targetKeyId, requestedBy]);
    if (inserted[0]) return { job: toJob(inserted[0]), created: true };
    const open = await tx.query<JobRow>(
      `select ${JOB_COLUMNS} from platform.key_rewrap_jobs where workspace_id = $1 and purpose = 'enc:vault' and status in ('pending','running') limit 1`, [workspaceId]);
    if (!open[0]) throw new ControlStoreError("conflict", "The re-wrap job could not be created; retry.");
    return { job: toJob(open[0]), created: false };
  });
}

/** System scheduler only: take the oldest open job (pending or interrupted running). Every later call uses the returned workspace. */
export async function claimRewrapJob(db: Sql): Promise<RewrapJob | null> {
  const rows = await db.query<JobRow>(
    `update platform.key_rewrap_jobs set status = 'running', started_at = coalesce(started_at, clock_timestamp()), updated_at = clock_timestamp()
     where id = (select id from platform.key_rewrap_jobs where status in ('pending','running') order by created_at, id limit 1 for update skip locked)
     returning ${JOB_COLUMNS}`);
  return rows[0] ? toJob(rows[0]) : null;
}

export async function advanceRewrapJob(db: Sql, input: { workspaceId: string; id: string; cursorRef: string; targetKeyId: string; inspected: number; rewrapped: number; unchanged: number; batches: number }): Promise<boolean> {
  const rows = await db.query(
    `update platform.key_rewrap_jobs set cursor_ref = $3, target_key_id = $4, inspected = inspected + $5, rewrapped = rewrapped + $6, unchanged = unchanged + $7,
       batches = batches + $8, updated_at = clock_timestamp()
     where workspace_id = $1 and id = $2 and status = 'running' returning id`,
    [workspace(input.workspaceId), requireText("id", input.id), input.cursorRef, input.targetKeyId, input.inspected, input.rewrapped, input.unchanged, input.batches]);
  return rows.length === 1;
}

export async function finishRewrapJob(db: Sql, input: { workspaceId: string; id: string; status: "completed" | "failed" | "blocked" | "cancelled"; errorCode?: RewrapBlockCode }): Promise<RewrapJob | null> {
  const rows = await db.query<JobRow>(
    `update platform.key_rewrap_jobs set status = $3, error_code = $4, finished_at = clock_timestamp(), updated_at = clock_timestamp()
     where workspace_id = $1 and id = $2 and status in ('pending','running') returning ${JOB_COLUMNS}`,
    [workspace(input.workspaceId), requireText("id", input.id), input.status, input.errorCode ?? null]);
  return rows[0] ? toJob(rows[0]) : null;
}

export async function getRewrapJob(db: Sql, workspaceId: string, id: string): Promise<RewrapJob | null> {
  const rows = await db.query<JobRow>(`select ${JOB_COLUMNS} from platform.key_rewrap_jobs where workspace_id = $1 and id = $2`, [workspace(workspaceId), requireText("id", id)]);
  return rows[0] ? toJob(rows[0]) : null;
}

/** With a workspace: that workspace's jobs. Without: the operator's system view across workspaces. */
export async function listRewrapJobs(db: Sql, options: { workspaceId?: string; limit?: number } = {}): Promise<RewrapJob[]> {
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 50)));
  const rows = options.workspaceId !== undefined
    ? await db.query<JobRow>(`select ${JOB_COLUMNS} from platform.key_rewrap_jobs where workspace_id = $1 order by created_at desc, id desc limit $2`, [workspace(options.workspaceId), limit])
    : await db.query<JobRow>(`select ${JOB_COLUMNS} from platform.key_rewrap_jobs order by created_at desc, id desc limit $1`, [limit]);
  return rows.map(toJob);
}

/** Open job counts for health reporting. */
export async function rewrapBacklog(db: Sql): Promise<{ pending: number; running: number }> {
  const rows = await db.query<{ status: string; n: number }>(`select status, count(*)::int as n from platform.key_rewrap_jobs where status in ('pending','running') group by status`);
  const n = (s: string): number => rows.find((r) => r.status === s)?.n ?? 0;
  return { pending: n("pending"), running: n("running") };
}
