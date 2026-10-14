/**
 * Control-store access for retention (PROD-OPS-07): the eligibility SQL, legal holds, archive records and the
 * dry-run preview.
 *
 * Tenancy classification (tests/controlplane/tenancy.test.ts conventions):
 *   createHold / releaseHold / listHolds(workspaceId)          WORKSPACE-BOUND: every statement filters on workspace_id
 *   listHolds() without a workspace, listArchives(), preview*   SYSTEM reads for the operator surface: rows carry their
 *                                                               workspace id; counts and row ids only, never payloads
 *   archiveWatermark / recordArchive / archivesToPrune /
 *   markPruned                                                 WORKSPACE-BOUND by (workspace_id, data_class)
 *   classSql / pruneSql                                        statement builders over the fixed class registry
 *
 * Every table name interpolated here comes from `CLASS_SPECS` (checked by `assertPrunableClass`), never from input.
 * Deliberately NOT exported from `controlplane/db/repos`; callers pass the platform `Sql` explicitly.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "@/lib/controlplane/types";
import { ControlStoreError, requireText } from "@/lib/controlplane/db/errors";
import {
  CLASS_SPECS, NEVER_PRUNABLE, RETENTION_CLASSES, TERMINAL_STATUSES, assertPrunableClass, isRetentionClass, type RetentionClass,
} from "./classes";
import { AUDIT_EVIDENCE_CLASSES, resolveArchiveExpiry, resolveWindow, tenantArchiveExpiryOptIn, type RetentionPolicy } from "./policy";

/* ------------------------------ statement builders ------------------------------ */

export interface ClassSql {
  from: string;
  /** the row belongs to a settled parent (always true for classes without a parent) */
  cold: string;
  /** a legal hold covers the row */
  held: string;
  /** the row is not the newest of its group (always true for classes without keep-latest) */
  notLatest: string;
  time: string;
  idType: "bigint" | "text";
}

export function classSql(cls: RetentionClass): ClassSql {
  assertPrunableClass(cls);
  const spec = CLASS_SPECS[cls];
  const time = `l.${spec.timeColumn}`;
  const from = `${spec.table} l` + (spec.parent ? ` left join ${spec.parent.table} p on p.workspace_id = l.workspace_id and p.id = l.${spec.parent.fk}` : "");
  const cold = spec.parent ? `p.status in ${TERMINAL_STATUSES}` : "true";
  const held = `exists (select 1 from platform.legal_holds h where h.workspace_id = l.workspace_id and h.released_at is null
    and (h.data_class is null or h.data_class = '${cls}')
    and (h.resource_ref is null or h.resource_ref in (${spec.resourceExprs.join(", ")}))
    and (h.time_from is null or ${time} >= h.time_from) and (h.time_to is null or ${time} <= h.time_to))`;
  const notLatest = spec.keepLatestBy
    ? `exists (select 1 from ${spec.table} n where n.workspace_id = l.workspace_id and n.${spec.keepLatestBy.column} = l.${spec.keepLatestBy.column} and (n.${spec.keepLatestBy.orderColumn}, n.id) > (l.${spec.keepLatestBy.orderColumn}, l.id))`
    : "true";
  return { from, cold, held, notLatest, time, idType: spec.idType };
}

/**
 * The hold predicate for a PARENT row (alias `t`: platform.runner_jobs or platform.machine_requests) of a log class, for
 * the payload minimizer. It mirrors `classSql(cls).held` through the parent: the class's resource expressions with the
 * log row's foreign key replaced by the parent id, and the hold's time range tested against the parent's `settled_at`.
 */
export function parentHeldSql(cls: "runner_job_logs" | "machine_request_logs"): string {
  assertPrunableClass(cls);
  const spec = CLASS_SPECS[cls];
  if (!spec.parent) throw new Error(`${cls} has no parent table.`);
  const exprs = spec.resourceExprs.map((e) => (e === `l.${spec.parent!.fk}` ? "t.id" : e.replace(/^p\./, "t.")));
  return `exists (select 1 from platform.legal_holds h where h.workspace_id = t.workspace_id and h.released_at is null
    and (h.data_class is null or h.data_class = '${cls}')
    and (h.resource_ref is null or h.resource_ref in (${exprs.join(", ")}))
    and (h.time_from is null or t.settled_at >= h.time_from) and (h.time_to is null or t.settled_at <= h.time_to))`;
}

/**
 * The only DELETE this module issues. Parameters: $1 workspace, $2 JSON array of row ids from a verified archive,
 * $3 now, $4 prune days. Re-checks every invariant at delete time: settled parent, not the latest of its group, no
 * hold, old enough, and listed in the verified manifest.
 */
export function pruneSql(cls: RetentionClass): string {
  const s = classSql(cls);
  const spec = CLASS_SPECS[cls];
  const using = spec.parent ? ` using ${spec.parent.table} p` : "";
  const join = spec.parent ? `p.workspace_id = l.workspace_id and p.id = l.${spec.parent.fk} and ` : "";
  return `delete from ${spec.table} l${using}
    where ${join}l.workspace_id = $1
      and l.id in (select x::${s.idType} from jsonb_array_elements_text($2::text::jsonb) x)
      and ${s.cold} and ${s.time} < $3::timestamptz - make_interval(days => $4::int)
      and ${s.notLatest} and not ${s.held}
    returning l.id::text as id`;
}

/* ------------------------------------ holds ------------------------------------- */

export interface LegalHold {
  id: string;
  workspaceId: string;
  dataClass: RetentionClass | null;
  resourceRef: string | null;
  timeFrom: string | null;
  timeTo: string | null;
  reason: string;
  createdBy: string;
  createdAt: string;
  releasedAt: string | null;
  releasedBy: string | null;
  releaseReason: string | null;
}

interface HoldRow {
  id: string; workspace_id: string; data_class: RetentionClass | null; resource_ref: string | null; time_from: unknown; time_to: unknown;
  reason: string; created_by: string; created_at: unknown; released_at: unknown; released_by: string | null; release_reason: string | null;
}
const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const HOLD_COLUMNS = "id, workspace_id, data_class, resource_ref, time_from, time_to, reason, created_by, created_at, released_at, released_by, release_reason";
const toHold = (r: HoldRow): LegalHold => ({
  id: r.id, workspaceId: r.workspace_id, dataClass: r.data_class, resourceRef: r.resource_ref, timeFrom: iso(r.time_from), timeTo: iso(r.time_to),
  reason: r.reason, createdBy: r.created_by, createdAt: iso(r.created_at)!, releasedAt: iso(r.released_at), releasedBy: r.released_by, releaseReason: r.release_reason,
});

/** Serializes hold changes against prune transactions so a hold created mid-prune is either seen or waits. */
const HOLD_LOCK = "select pg_advisory_xact_lock(hashtext('zenith.retention.holds'))";
export const acquireHoldLock = (tx: Sql): Promise<unknown> => tx.query(HOLD_LOCK);

export interface CreateHoldInput {
  workspaceId: string;
  dataClass?: string | null;
  resourceRef?: string | null;
  timeFrom?: string | null;
  timeTo?: string | null;
  reason: string;
  actor: string;
}

function parseTime(field: string, value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new ControlStoreError("invalid_input", `${field} must be an ISO time.`, { field });
  return new Date(t).toISOString();
}

export async function createHold(sql: Sql, input: CreateHoldInput): Promise<LegalHold> {
  const workspaceId = requireText("workspaceId", input.workspaceId, 128);
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(workspaceId)) throw new ControlStoreError("invalid_input", "workspaceId is invalid.", { field: "workspaceId" });
  const reason = requireText("reason", input.reason, 500);
  const actor = requireText("actor", input.actor, 128);
  const dataClass = input.dataClass ?? null;
  if (dataClass !== null && !isRetentionClass(dataClass)) throw new ControlStoreError("invalid_input", `dataClass must be one of ${RETENTION_CLASSES.join(", ")}.`, { field: "dataClass" });
  const resourceRef = input.resourceRef ? requireText("resourceRef", input.resourceRef, 200) : null;
  const timeFrom = parseTime("timeFrom", input.timeFrom);
  const timeTo = parseTime("timeTo", input.timeTo);
  if (timeFrom && timeTo && timeTo < timeFrom) throw new ControlStoreError("invalid_input", "timeTo must not be before timeFrom.", { field: "timeTo" });
  return sql.tx(async (tx) => {
    await acquireHoldLock(tx);
    const rows = await tx.query<HoldRow>(
      `insert into platform.legal_holds (id, workspace_id, data_class, resource_ref, time_from, time_to, reason, created_by)
       values ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8) returning ${HOLD_COLUMNS}`,
      [`hold_${randomUUID()}`, workspaceId, dataClass, resourceRef, timeFrom, timeTo, reason, actor]);
    return toHold(rows[0]);
  });
}

export async function releaseHold(sql: Sql, input: { id: string; workspaceId?: string; actor: string; reason?: string }): Promise<LegalHold> {
  const id = requireText("id", input.id, 128);
  const actor = requireText("actor", input.actor, 128);
  const reason = (input.reason ?? "").trim().slice(0, 500) || null;
  return sql.tx(async (tx) => {
    await acquireHoldLock(tx);
    const rows = await tx.query<HoldRow>(
      `update platform.legal_holds set released_at = clock_timestamp(), released_by = $2, release_reason = $3
        where id = $1 and released_at is null and ($4::text is null or workspace_id = $4::text) returning ${HOLD_COLUMNS}`,
      [id, actor, reason, input.workspaceId ?? null]);
    if (!rows.length) throw new ControlStoreError("not_found", "No active legal hold with that id.", { field: "id" });
    return toHold(rows[0]);
  });
}

export async function listHolds(sql: Sql, options: { workspaceId?: string; activeOnly?: boolean; limit?: number } = {}): Promise<LegalHold[]> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500);
  const rows = await sql.query<HoldRow>(
    `select ${HOLD_COLUMNS} from platform.legal_holds
      where ($1::text is null or workspace_id = $1::text) and ($2::boolean = false or released_at is null)
      order by created_at desc, id limit $3::int`,
    [options.workspaceId ?? null, options.activeOnly ?? false, limit]);
  return rows.map(toHold);
}

/* --------------------------------- archive records ------------------------------- */

export interface ArchiveRecord {
  id: string;
  workspaceId: string;
  dataClass: RetentionClass;
  objectKey: string;
  rowsDigest: string;
  rowCount: number;
  firstRowId: string;
  lastRowId: string;
  lastRecordedAt: string;
  keyId: string;
  destinationId: string | null;
  destinationLabel: string;
  policyDigest: string;
  verifiedAt: string;
  prunedRows: number;
  completedAt: string | null;
  /** when Zenith deleted the archive object (the record stays); null while the object is kept */
  expiredAt: string | null;
  expiredBy: string | null;
  /** 'deleted' = Zenith removed the object, 'missing' = it was already gone */
  expiryOutcome: "deleted" | "missing" | null;
}

interface ArchiveRow {
  id: string; workspace_id: string; data_class: RetentionClass; object_key: string; rows_digest: string; row_count: number;
  first_row_id: string; last_row_id: string; last_recorded_at: string; key_id: string; destination_id: string | null; destination_label: string; policy_digest: string; verified_at: unknown;
  pruned_rows: number; completed_at: unknown; expired_at: unknown; expired_by: string | null; expiry_outcome: "deleted" | "missing" | null;
}
const ARCHIVE_COLUMNS = "id, workspace_id, data_class, object_key, rows_digest, row_count, first_row_id, last_row_id, last_recorded_at::text as last_recorded_at, key_id, destination_id, destination_label, policy_digest, verified_at, pruned_rows, completed_at, expired_at, expired_by, expiry_outcome";
const toArchive = (r: ArchiveRow): ArchiveRecord => ({
  id: r.id, workspaceId: r.workspace_id, dataClass: r.data_class, objectKey: r.object_key, rowsDigest: r.rows_digest, rowCount: Number(r.row_count),
  firstRowId: r.first_row_id, lastRowId: r.last_row_id, lastRecordedAt: r.last_recorded_at, keyId: r.key_id, destinationId: r.destination_id, destinationLabel: r.destination_label, policyDigest: r.policy_digest,
  verifiedAt: iso(r.verified_at)!, prunedRows: Number(r.pruned_rows), completedAt: iso(r.completed_at),
  expiredAt: iso(r.expired_at), expiredBy: r.expired_by ?? null, expiryOutcome: r.expiry_outcome ?? null,
});

/** The (recorded time, id) of the newest archived row of a workspace and class, or null before the first archive. */
export async function archiveWatermark(sql: Sql, workspaceId: string, cls: RetentionClass): Promise<{ ts: string; id: string } | null> {
  assertPrunableClass(cls);
  const rows = await sql.query<{ ts: string; id: string }>(
    `select last_recorded_at::text as ts, last_row_id as id from platform.retention_archives
      where workspace_id = $1 and data_class = $2 order by last_recorded_at desc, created_at desc limit 1`, [workspaceId, cls]);
  return rows[0] ?? null;
}

export interface NewArchive {
  workspaceId: string; dataClass: RetentionClass; objectKey: string; rowsDigest: string; rowCount: number;
  firstRowId: string; lastRowId: string; lastRecordedAt: string; keyId: string; policyDigest: string;
  destinationId?: string | null; destinationLabel?: string;
}

/** Insert the record of an archive that was read back and digest-verified. Idempotent on the object key. */
export async function recordArchive(sql: Sql, a: NewArchive): Promise<ArchiveRecord> {
  assertPrunableClass(a.dataClass);
  const rows = await sql.query<ArchiveRow>(
    `insert into platform.retention_archives (id, workspace_id, data_class, object_key, rows_digest, row_count, first_row_id, last_row_id, last_recorded_at, key_id, policy_digest, destination_id, destination_label, next_prune_check_at)
     values ($1, $2, $3, $4, $5, $6::int, $7, $8, $9::text::timestamptz, $10, $11, $12, $13, clock_timestamp())
     on conflict (workspace_id, data_class, object_key) do update set key_id = platform.retention_archives.key_id
     returning ${ARCHIVE_COLUMNS}`,
    [`arc_${randomUUID()}`, a.workspaceId, a.dataClass, a.objectKey, a.rowsDigest, a.rowCount, a.firstRowId, a.lastRowId, a.lastRecordedAt, a.keyId, a.policyDigest, a.destinationId ?? null, a.destinationLabel ?? "operator storage"]);
  return toArchive(rows[0]);
}

export async function listArchives(sql: Sql, options: { workspaceId?: string; limit?: number } = {}): Promise<ArchiveRecord[]> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
  const rows = await sql.query<ArchiveRow>(
    `select ${ARCHIVE_COLUMNS} from platform.retention_archives where ($1::text is null or workspace_id = $1::text) order by created_at desc, id limit $2::int`,
    [options.workspaceId ?? null, limit]);
  return rows.map(toArchive);
}

export async function getArchive(sql: Sql, id: string, workspaceId?: string): Promise<ArchiveRecord | null> {
  const rows = await sql.query<ArchiveRow>(`select ${ARCHIVE_COLUMNS} from platform.retention_archives where id = $1 and ($2::text is null or workspace_id = $2::text)`, [id, workspaceId ?? null]);
  return rows[0] ? toArchive(rows[0]) : null;
}

/** Verified archives that still have source rows to examine, due for a prune check. Expired archives (object deleted) are never examined. */
export async function archivesToPrune(sql: Sql, limit: number): Promise<ArchiveRecord[]> {
  const rows = await sql.query<ArchiveRow>(
    `select ${ARCHIVE_COLUMNS} from platform.retention_archives
      where completed_at is null and expired_at is null and (next_prune_check_at is null or next_prune_check_at <= clock_timestamp())
      order by next_prune_check_at nulls first, created_at limit $1::int`, [Math.min(Math.max(Math.trunc(limit), 1), 100)]);
  return rows.map(toArchive);
}

export async function markPruned(sql: Sql, id: string, workspaceId: string, deleted: number, remaining: number, recheckMs: number): Promise<void> {
  await sql.query(
    `update platform.retention_archives
        set pruned_rows = pruned_rows + $3::int,
            completed_at = case when $4::int = 0 then clock_timestamp() else null end,
            next_prune_check_at = clock_timestamp() + ($5::bigint * interval '1 millisecond')
      where id = $1 and workspace_id = $2`,
    [id, workspaceId, deleted, remaining, recheckMs]);
}

export async function deferArchive(sql: Sql, id: string, workspaceId: string, recheckMs: number): Promise<void> {
  await sql.query(
    "update platform.retention_archives set next_prune_check_at = clock_timestamp() + ($3::bigint * interval '1 millisecond') where id = $1 and workspace_id = $2 and completed_at is null",
    [id, workspaceId, recheckMs]);
}

/* --------------------------------- archive expiry --------------------------------- */

/** The principal recorded in `expired_by`: the scheduled retention job, never a person. */
export const EXPIRY_ACTOR = "system:data-retention";

/** The classes whose archives Zenith may expire: every class that is not audit evidence. */
export const EXPIRABLE_CLASSES: readonly RetentionClass[] = Object.freeze(RETENTION_CLASSES.filter((c) => !AUDIT_EVIDENCE_CLASSES.includes(c)));
const EXPIRABLE_SQL = EXPIRABLE_CLASSES.map((c) => `'${c}'`).join(", ");

/** Statement parameters of the expiry scan: $1 now, $2 class default days (JSON), $3 per-workspace days (JSON), $4 opted-in tenant workspaces (JSON array). */
export type ExpiryParams = [now: string, classDays: string, workspaceDays: string, optedIn: string];

export function expiryParams(policy: RetentionPolicy, now: Date): ExpiryParams {
  const classDays: Record<string, number | null> = {};
  for (const cls of EXPIRABLE_CLASSES) classDays[cls] = resolveArchiveExpiry({ classes: policy.classes, workspaces: {} }, "", cls);
  const workspaceDays: Record<string, Record<string, number | null>> = {};
  const optedIn: string[] = [];
  for (const ws of Object.keys(policy.workspaces)) {
    workspaceDays[ws] = {};
    for (const cls of EXPIRABLE_CLASSES) if (policy.workspaces[ws]?.[cls] && "archiveExpireAfterDays" in policy.workspaces[ws][cls]!) workspaceDays[ws][cls] = resolveArchiveExpiry(policy, ws, cls);
    if (tenantArchiveExpiryOptIn(policy, ws)) optedIn.push(ws);
  }
  return [now.toISOString(), JSON.stringify(classDays), JSON.stringify(workspaceDays), JSON.stringify(optedIn)];
}

/**
 * Archives (alias `a`) that are old enough to expire under the policy: an expirable class with an expiry window for the
 * workspace, the newest row older than that window, not yet expired, and stored in the operator bucket (or a tenant bucket
 * whose workspace opted in). Fully pruned is a separate test (`FULLY_PRUNED`) so unpruned ones can be counted.
 */
export const EXPIRY_AGE_WHERE = `a.expired_at is null and a.data_class in (${EXPIRABLE_SQL})
  and (a.destination_id is null or a.workspace_id in (select jsonb_array_elements_text($4::text::jsonb)))
  and a.last_recorded_at < $1::timestamptz - make_interval(days => case
        when jsonb_exists(coalesce($3::text::jsonb -> a.workspace_id, '{}'::jsonb), a.data_class) then ($3::text::jsonb -> a.workspace_id ->> a.data_class)::int
        else ($2::text::jsonb ->> a.data_class)::int end)`;
/** Every archived row has been removed from the source, so the archive is no longer the only copy of rows that still await a prune. */
export const FULLY_PRUNED = "a.completed_at is not null and a.pruned_rows >= a.row_count";

/** The oldest archives that may expire now, after an optional (last_recorded_at, id) cursor so held archives cannot starve the rest. Bounded; oldest first. */
export async function archivesDueForExpiry(sql: Sql, params: ExpiryParams, limit: number, after?: { ts: string; id: string }): Promise<ArchiveRecord[]> {
  const rows = await sql.query<ArchiveRow>(
    `select ${ARCHIVE_COLUMNS.split(", ").map((c) => (c.includes(" as ") ? c.replace(/^([a-z_]+)/, "a.$1") : `a.${c}`)).join(", ")}
       from platform.retention_archives a where ${EXPIRY_AGE_WHERE} and ${FULLY_PRUNED}
        and ($5::text::timestamptz is null or (a.last_recorded_at, a.id) > ($5::text::timestamptz, $6::text))
      order by a.last_recorded_at, a.id limit $7::int`,
    [...params, after?.ts ?? null, after?.id ?? null, Math.min(Math.max(Math.trunc(limit), 1), 100)]);
  return rows.map(toArchive);
}

export interface ExpiryCounts { due: number; blockedUnpruned: number }

/** Counts for the job result and the dry run: archives due now, and archives old enough but not fully pruned yet. */
export async function expiryCounts(sql: Sql, params: ExpiryParams): Promise<ExpiryCounts> {
  const r = await sql.query<{ due: number; unpruned: number }>(
    `select (count(*) filter (where ${FULLY_PRUNED}))::int as due, (count(*) filter (where not (${FULLY_PRUNED})))::int as unpruned
       from platform.retention_archives a where ${EXPIRY_AGE_WHERE}`, params);
  return { due: Number(r[0]?.due ?? 0), blockedUnpruned: Number(r[0]?.unpruned ?? 0) };
}

/**
 * Does an active legal hold overlap this archive? Same predicate shapes as row holds: workspace-wide, data_class,
 * resource_ref and a time range. Overlap: the hold's range intersects the archive's [first, last] recorded time or is open
 * ended, and its resource_ref is null or matches a row of the archive. $1 workspace, $2 class, $3 JSON array of the
 * archive rows' recorded times (empty when unknown), $4 the archive's last_recorded_at, $5 true when the contents are
 * unknown (then a resource-scoped hold is conservatively treated as matching), $6 JSON array of the rows' resource refs.
 */
export const ARCHIVE_HOLD_SQL = `select exists (
  select 1 from platform.legal_holds h, (select min(t::timestamptz) as lo from jsonb_array_elements_text($3::text::jsonb) t) b
   where h.workspace_id = $1 and h.released_at is null
     and (h.data_class is null or h.data_class = $2)
     and (h.time_from is null or h.time_from <= $4::text::timestamptz)
     and (h.time_to is null or b.lo is null or h.time_to >= b.lo)
     and ($5::boolean or h.resource_ref is null or h.resource_ref in (select jsonb_array_elements_text($6::text::jsonb)))) as held`;

export async function archiveHeld(sql: Sql, a: Pick<ArchiveRecord, "workspaceId" | "dataClass" | "lastRecordedAt">, footprint: { times: readonly string[]; refs: readonly string[]; unknown: boolean }): Promise<boolean> {
  const r = await sql.query<{ held: boolean }>(ARCHIVE_HOLD_SQL, [a.workspaceId, a.dataClass, JSON.stringify(footprint.times), a.lastRecordedAt, footprint.unknown, JSON.stringify(footprint.refs)]);
  return r[0]?.held === true;
}

export interface ClassExpiryOverview {
  class: RetentionClass;
  archives: number;
  /** object deleted by Zenith, or found already gone, with the record kept */
  expired: number;
  expiredMissing: number;
  /** fully pruned, old enough, not expired (includes the held ones) */
  due: number;
  /** of those, archives a legal hold may cover (checked against the contents at expiry) */
  heldBack: number;
  /** old enough but rows still await pruning, so the archive is kept */
  blockedUnpruned: number;
  /** archives in a tenant-owned bucket whose workspace did not opt in: the customer's bucket lifecycle governs */
  customerControlled: number;
}

const MAYBE_HELD = `exists (select 1 from platform.legal_holds h where h.workspace_id = a.workspace_id and h.released_at is null
   and (h.data_class is null or h.data_class = a.data_class) and (h.time_from is null or h.time_from <= a.last_recorded_at))`;

export async function expiryOverview(sql: Sql, policy: RetentionPolicy, now: Date): Promise<ClassExpiryOverview[]> {
  const params = expiryParams(policy, now);
  const out: ClassExpiryOverview[] = [];
  for (const cls of RETENTION_CLASSES) {
    const base = await sql.query<{ n: number; e: number; m: number; t: number }>(
      `select count(*)::int as n, (count(*) filter (where a.expired_at is not null))::int as e, (count(*) filter (where a.expiry_outcome = 'missing'))::int as m,
              (count(*) filter (where a.expired_at is null and a.destination_id is not null and not (a.workspace_id in (select jsonb_array_elements_text($1::text::jsonb)))))::int as t
         from platform.retention_archives a where a.data_class = $2`, [params[3], cls]);
    let due = 0, held = 0, unpruned = 0;
    if (EXPIRABLE_CLASSES.includes(cls)) {
      const r = await sql.query<{ due: number; held: number; unpruned: number }>(
        `select (count(*) filter (where ${FULLY_PRUNED}))::int as due, (count(*) filter (where ${FULLY_PRUNED} and ${MAYBE_HELD}))::int as held,
                (count(*) filter (where not (${FULLY_PRUNED})))::int as unpruned
           from platform.retention_archives a where ${EXPIRY_AGE_WHERE} and a.data_class = $5`, [...params, cls]);
      due = Number(r[0]?.due ?? 0); held = Number(r[0]?.held ?? 0); unpruned = Number(r[0]?.unpruned ?? 0);
    }
    out.push({ class: cls, archives: Number(base[0]?.n ?? 0), expired: Number(base[0]?.e ?? 0), expiredMissing: Number(base[0]?.m ?? 0), due, heldBack: held, blockedUnpruned: unpruned, customerControlled: Number(base[0]?.t ?? 0) });
  }
  return out;
}

/* ------------------------------------ preview ------------------------------------ */

export interface WorkspacePreview {
  workspaceId: string;
  archiveAfterDays: number | null;
  pruneAfterDays: number | null;
  totalRows: number;
  archiveEligible: number;
  pruneEligible: number;
  pruneWaitingForArchive: number;
  keptAsLatest: number;
  heldRows: number;
}

export interface ClassPreview {
  class: RetentionClass;
  label: string;
  description: string;
  totals: Omit<WorkspacePreview, "workspaceId" | "archiveAfterDays" | "pruneAfterDays">;
  archivedRows: number;
  /** rows removed from the source after a verified archive, across all archives of the class */
  prunedRows: number;
  workspaces: WorkspacePreview[];
  /** a bounded sample of rows that the policy would prune once archived (ids and times only) */
  samplePrune: { workspaceId: string; rowId: string; recordedAt: string }[];
  /** more workspaces exist than the bounded list shows */
  truncated: boolean;
}

export interface RetentionPreview {
  generatedAt: string;
  /** nothing in this preview changed anything */
  dryRun: true;
  classes: ClassPreview[];
  neverPrunable: { table: string; reason: string }[];
}

export const PREVIEW_WORKSPACE_LIMIT = 100;
const SAMPLE_LIMIT = 10;

export async function previewRetention(sql: Sql, policy: RetentionPolicy, now: Date = new Date()): Promise<RetentionPreview> {
  const nowIso = now.toISOString();
  const classes: ClassPreview[] = [];
  for (const cls of RETENTION_CLASSES) {
    const s = classSql(cls);
    const spec = CLASS_SPECS[cls];
    const wsRows = await sql.query<{ workspace_id: string }>(
      `select workspace_id from ${spec.table} group by workspace_id order by workspace_id limit $1::int`, [PREVIEW_WORKSPACE_LIMIT + 1]);
    const truncated = wsRows.length > PREVIEW_WORKSPACE_LIMIT;
    const workspaces: WorkspacePreview[] = [];
    const samplePrune: ClassPreview["samplePrune"] = [];
    for (const { workspace_id: ws } of wsRows.slice(0, PREVIEW_WORKSPACE_LIMIT)) {
      const w = resolveWindow(policy, ws, cls);
      const wm = await archiveWatermark(sql, ws, cls);
      // $1 workspace, $2 now, $3 archive days, $4 prune days, $5/$6 archive watermark (null before the first archive)
      const afterWm = `($5::text::timestamptz is null or (${s.time}, l.id) > ($5::text::timestamptz, $6::${s.idType}))`;
      const oldFor = (n: number) => `${s.time} < $2::timestamptz - make_interval(days => $${n}::int)`;
      const pruneBase = `$4::int is not null and ${s.cold} and ${oldFor(4)} and ${s.notLatest} and not ${s.held}`;
      const rows = await sql.query<Record<string, number>>(
        `select count(*)::int as total,
           (count(*) filter (where $3::int is not null and ${s.cold} and ${oldFor(3)} and ${afterWm}))::int as archive_eligible,
           (count(*) filter (where ${pruneBase} and not ${afterWm}))::int as prune_eligible,
           (count(*) filter (where ${pruneBase} and ${afterWm}))::int as prune_waiting,
           (count(*) filter (where $4::int is not null and ${s.cold} and ${oldFor(4)} and not ${s.notLatest}))::int as kept_latest,
           (count(*) filter (where ${s.held} and ${s.cold} and (($3::int is not null and ${oldFor(3)}) or ($4::int is not null and ${oldFor(4)}))))::int as held
         from ${s.from} where l.workspace_id = $1`,
        [ws, nowIso, w.archiveAfterDays, w.pruneAfterDays, wm?.ts ?? null, wm?.id ?? null]);
      const r = rows[0];
      workspaces.push({
        workspaceId: ws, archiveAfterDays: w.archiveAfterDays, pruneAfterDays: w.pruneAfterDays, totalRows: Number(r.total),
        archiveEligible: Number(r.archive_eligible), pruneEligible: Number(r.prune_eligible), pruneWaitingForArchive: Number(r.prune_waiting),
        keptAsLatest: Number(r.kept_latest), heldRows: Number(r.held),
      });
      if (Number(r.prune_eligible) > 0 && samplePrune.length < SAMPLE_LIMIT) {
        const sample = await sql.query<{ id: string; ts: string }>(
          `select l.id::text as id, ${s.time}::text as ts from ${s.from} where l.workspace_id = $1 and ${pruneBase.replaceAll("$4", "$3")} and not ${afterWm.replaceAll("$5", "$4").replaceAll("$6", "$5")}
            order by ${s.time}, l.id limit $6::int`,
          [ws, nowIso, w.pruneAfterDays, wm?.ts ?? null, wm?.id ?? null, SAMPLE_LIMIT - samplePrune.length]);
        for (const x of sample) samplePrune.push({ workspaceId: ws, rowId: x.id, recordedAt: x.ts });
      }
    }
    const sum = (key: keyof ClassPreview["totals"]) => workspaces.reduce((n, w) => n + w[key], 0);
    const archived = await sql.query<{ n: number; p: number }>("select coalesce(sum(row_count), 0)::int as n, coalesce(sum(pruned_rows), 0)::int as p from platform.retention_archives where data_class = $1", [cls]);
    classes.push({
      class: cls, label: spec.label, description: spec.description,
      totals: { totalRows: sum("totalRows"), archiveEligible: sum("archiveEligible"), pruneEligible: sum("pruneEligible"), pruneWaitingForArchive: sum("pruneWaitingForArchive"), keptAsLatest: sum("keptAsLatest"), heldRows: sum("heldRows") },
      archivedRows: Number(archived[0]?.n ?? 0), prunedRows: Number(archived[0]?.p ?? 0), workspaces, samplePrune, truncated,
    });
  }
  return { generatedAt: nowIso, dryRun: true, classes, neverPrunable: Object.entries(NEVER_PRUNABLE).map(([table, reason]) => ({ table, reason })) };
}
