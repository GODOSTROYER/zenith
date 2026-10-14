/**
 * Archive expiry (PROD-OPS-07, DEC-RETENTION archive expiry 2026-10-14).
 *
 * Archive objects of the two log classes expire `archiveExpireAfterDays` (default 365) after the NEWEST row they contain
 * (`last_recorded_at`), so logs live 30 days in the database and at most one year in total. This is the only place Zenith
 * deletes an archive object. The record row is never deleted: it keeps `expired_at`, `expired_by` and the outcome as the
 * append-only audit of what existed (the guard trigger allows setting them exactly once).
 *
 * Invariants, each enforced in code AND (where the database can) in the record's trigger:
 *   - Only behind the same apply gate as pruning (`retentionApplyGate`); otherwise nothing is deleted (dry run counts only).
 *   - Only archives of an expirable class (never the audit-evidence classes) with an expiry window for the workspace.
 *   - Only archives in the operator bucket, or in a tenant bucket whose workspace opted in (`tenantArchiveExpiry: "policy"`).
 *     A tenant bucket is otherwise governed by the customer's lifecycle rules and Zenith never touches it.
 *   - Only fully pruned archives (`completed_at` set and `pruned_rows >= row_count`): an archive that still has source rows
 *     awaiting a prune is never expired, so an expired archive is never the only copy of rows still to be pruned.
 *   - Never while an active legal hold overlaps the archive. The check runs under the holds advisory lock (hold creation
 *     takes the same lock), in the same transaction that deletes the object and records the expiry.
 *   - Delete the object, then record the expiry in the same transaction. If recording fails the transaction rolls back and the
 *     next tick finds the object already gone and records outcome `missing` (idempotent).
 *   - An archive whose contents cannot be read (wrong key, corrupt) is kept and reported, never deleted blind.
 */
import type { Sql } from "@/lib/controlplane/types";
import { keyIdOf } from "@/lib/hosted/backup/crypto";
import { archiveKey } from "./key";
import { readBack, type ArchiveTarget } from "./archive";
import { CLASS_SPECS, assertPrunableClass } from "./classes";
import { resolveDestination, type ResolveDeps } from "./destination";
import { resolveArchiveExpiry, type RetentionPolicy } from "./policy";
import {
  EXPIRY_ACTOR, EXPIRY_AGE_WHERE, FULLY_PRUNED, acquireHoldLock, archiveHeld, archivesDueForExpiry, expiryCounts, expiryParams, type ArchiveRecord,
} from "./store";

/** Deletions per call; archives examined per call is bounded by EXPIRY_PAGES pages of this size. */
export const EXPIRY_ARCHIVES_PER_TICK = 5;
export const EXPIRY_PAGES = 5;

export interface ExpiryContext {
  policy: RetentionPolicy;
  /** the apply gate is open (`retentionApplyGate(...).enabled`); false = report only */
  apply: boolean;
  deps: ResolveDeps;
  key?: Buffer;
  now?: Date;
  /** archives examined per call (default 5) */
  limit?: number;
}

export interface ExpiryResult {
  /** archive objects deleted (or found already gone) and recorded this call */
  expired: number;
  /** of those, the object was already gone */
  expiredMissing: number;
  /** archives due when the pass began: old enough, fully pruned, not expired */
  due: number;
  /** dry run only: of the archives examined, those that would be deleted by a live run */
  wouldExpire: number;
  /** due archives kept because an active legal hold overlaps them */
  heldBack: number;
  /** archives old enough whose rows are not all pruned yet, so they are kept */
  blockedUnpruned: number;
  /** due archives that could not be examined or deleted this call (destination, key, unreadable contents, storage error) */
  failed: number;
  note: string;
}

type One =
  | { status: "expired"; outcome: "deleted" | "missing" }
  | { status: "would_expire"; outcome: "deleted" | "missing" }
  | { status: "held" }
  | { status: "skipped"; reason: "destination_unavailable" | "key_unavailable" | "unreadable" | "delete_failed" | "changed" };

interface Footprint { times: string[]; refs: string[]; unknown: boolean; missing: boolean }

/** What the archive covers, from its sealed object: recorded times and resource refs of its rows. */
async function footprintOf(db: Sql, archive: ArchiveRecord, target: ArchiveTarget, key: Buffer): Promise<Footprint | "unreadable"> {
  let exists: Buffer | null;
  try { exists = await target.get(archive.objectKey); } catch { return "unreadable"; }
  if (!exists) return { times: [], refs: [], unknown: true, missing: true };
  let payload;
  try { payload = await readBack(target, key, archive.objectKey, archive.rowsDigest); } catch { return "unreadable"; }
  if (!payload || keyIdOf(key) !== archive.keyId || payload.workspaceId !== archive.workspaceId || payload.dataClass !== archive.dataClass) return "unreadable";
  const spec = CLASS_SPECS[assertPrunableClass(archive.dataClass)];
  const times = new Set<string>();
  const parents = new Set<string>();
  for (const row of payload.rows) {
    const t = row[spec.timeColumn];
    if (typeof t === "string") times.add(t);
    if (spec.parent) { const p = row[spec.parent.fk]; if (p !== undefined && p !== null) parents.add(String(p)); }
  }
  const refs = new Set<string>(parents);
  // resource refs a hold can name: the parent id (already in the row) and, via the parent, its operation id
  if (spec.parent && parents.size) {
    const ops = await db.query<{ ref: string | null }>(
      `select operation_id as ref from ${spec.parent.table} where workspace_id = $1 and id in (select jsonb_array_elements_text($2::text::jsonb))`,
      [archive.workspaceId, JSON.stringify([...parents])]);
    for (const o of ops) if (o.ref) refs.add(o.ref);
  }
  return { times: [...times], refs: [...refs], unknown: false, missing: false };
}

async function expireOne(db: Sql, archive: ArchiveRecord, ctx: ExpiryContext, key: Buffer | null, params: ReturnType<typeof expiryParams>): Promise<One> {
  const dest = await resolveDestination(db, archive.workspaceId, ctx.deps, { destinationId: archive.destinationId });
  if (!dest.ok) return { status: "skipped", reason: "destination_unavailable" };
  const target = dest.destination.target;
  if (!key) return { status: "skipped", reason: "key_unavailable" };
  const footprint = await footprintOf(db, archive, target, key);
  if (footprint === "unreadable") return { status: "skipped", reason: "unreadable" };
  const outcome: "deleted" | "missing" = footprint.missing ? "missing" : "deleted";
  if (!ctx.apply) {
    // Report only: the hold check is still real so the dry run counts what the live run would do.
    return (await archiveHeld(db, archive, footprint)) ? { status: "held" } : { status: "would_expire", outcome };
  }
  try {
    return await db.tx(async (tx): Promise<One> => {
      await acquireHoldLock(tx);
      // Re-check everything under the lock: still unexpired, still old enough for THIS workspace's window, still fully pruned.
      const still = await tx.query<{ id: string }>(
        `select a.id from platform.retention_archives a where a.id = $5 and a.workspace_id = $6 and ${EXPIRY_AGE_WHERE} and ${FULLY_PRUNED} for update`,
        [...params, archive.id, archive.workspaceId]);
      if (!still.length) return { status: "skipped", reason: "changed" };
      if (await archiveHeld(tx, archive, footprint)) return { status: "held" };
      if (!footprint.missing) await target.delete(archive.objectKey);
      const set = await tx.query<{ id: string }>(
        `update platform.retention_archives set expired_at = clock_timestamp(), expired_by = $3, expiry_outcome = $4
          where id = $1 and workspace_id = $2 and expired_at is null returning id`,
        [archive.id, archive.workspaceId, EXPIRY_ACTOR, outcome]);
      if (!set.length) throw new Error("expiry was not recorded");
      return { status: "expired", outcome };
    });
  } catch {
    return { status: "skipped", reason: "delete_failed" };
  }
}

/**
 * One bounded expiry step. With the gate closed it only reports (`due`, `heldBack`, `blockedUnpruned`) and deletes nothing.
 */
export async function expireArchives(db: Sql, ctx: ExpiryContext): Promise<ExpiryResult> {
  const now = ctx.now ?? new Date();
  const params = expiryParams(ctx.policy, now);
  const out: ExpiryResult = { expired: 0, expiredMissing: 0, due: 0, wouldExpire: 0, heldBack: 0, blockedUnpruned: 0, failed: 0, note: "" };
  const counts = await expiryCounts(db, params);
  out.blockedUnpruned = counts.blockedUnpruned;
  out.due = counts.due;
  if (counts.due === 0) return out;
  let key: Buffer | null = null;
  try { key = ctx.key ?? archiveKey(); } catch { out.note = "ZENITH_BACKUP_KEY is not usable, so archives due for expiry cannot be checked against legal holds and are kept."; }
  const limit = Math.max(1, Math.trunc(ctx.limit ?? EXPIRY_ARCHIVES_PER_TICK));
  let cursor: { ts: string; id: string } | undefined;
  for (let page = 0; page < EXPIRY_PAGES && out.expired < limit; page++) {
    const batch = await archivesDueForExpiry(db, params, limit, cursor);
    if (!batch.length) break;
    for (const archive of batch) {
      cursor = { ts: archive.lastRecordedAt, id: archive.id };
      if (out.expired >= limit) break;
      // Defence in depth: the SQL already restricts to a window; re-resolve it so a policy/code mismatch can never expire early.
      if (resolveArchiveExpiry(ctx.policy, archive.workspaceId, archive.dataClass) === null) continue;
      const r = await expireOne(db, archive, ctx, key, params);
      if (r.status === "expired") { out.expired++; if (r.outcome === "missing") out.expiredMissing++; }
      else if (r.status === "would_expire") out.wouldExpire++;
      else if (r.status === "held") out.heldBack++;
      else if (r.status === "skipped" && r.reason !== "changed") out.failed++;
    }
    if (batch.length < limit) break;
  }
  return out;
}
