/**
 * The `data-retention` critical job (PROD-OPS-07): one bounded pass over the configured retention policy.
 *
 * DEC-RETENTION is pending, so with no configuration this does nothing (every default window is "retain forever").
 * With a policy it ARCHIVES (copies to object storage, verified by readback; the source is untouched). It PRUNES
 * only when `retentionApplyGate` is open (ZENITH_RETENTION_APPLY=1 AND the policy carries a DEC-RETENTION approval),
 * and then only rows of a verified archive. Runs on the durable critical-maintenance schedule under the
 * `critical-job:data-retention` lease (the operator CLI scripts/data-retention.ts uses the same lease and record).
 * Counts only leave this module.
 */
import type { Sql } from "@/lib/controlplane/types";
import { RETENTION_CLASSES } from "./classes";
import { loadRetentionPolicy, resolveWindow, retentionApplyGate, widestScan, type PolicyLoad } from "./policy";
import { archiveBatch, archiveTargetFromEnv, pruneArchive, type ArchiveTarget } from "./archive";
import { archivesToPrune, classSql, deferArchive } from "./store";

export const RETENTION_WORKSPACES_PER_CLASS = 10;
export const RETENTION_BATCHES_PER_TICK = 5;

export interface RetentionOptions {
  env?: Readonly<Record<string, string | undefined>>;
  now?: Date;
  /** inject a loaded policy (tests); otherwise loaded from the environment */
  load?: PolicyLoad;
  target?: ArchiveTarget;
  key?: Buffer;
  batchRows?: number;
  recheckMs?: number;
  /** archive batches per tick (default 5) */
  maxBatches?: number;
  /** archives examined for pruning per tick (default 5) */
  maxPrunes?: number;
}

export interface RetentionResult {
  /** 1 when a policy with at least one window is in force */
  policyActive: number;
  /** 1 when the configured policy was invalid and everything is retained */
  policyInvalid: number;
  archiveBatches: number;
  archivedRows: number;
  prunedRows: number;
  /** archive steps that failed (write, readback or digest) and will be retried */
  archiveFailed: number;
  /** archives whose object could not be re-verified at prune time; nothing was deleted for them */
  pruneSkipped: number;
  /** true only when the delete gate was open this tick; otherwise archiving (if any) is copy-only */
  applied: boolean;
  /** why nothing was archived or deleted, when that is a configuration matter */
  note: string;
}

export async function retentionPass(db: Sql, options: RetentionOptions = {}): Promise<RetentionResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const load = options.load ?? loadRetentionPolicy(env);
  const gate = retentionApplyGate(env, load);
  const out: RetentionResult = { policyActive: 0, policyInvalid: load.ok ? 0 : 1, archiveBatches: 0, archivedRows: 0, prunedRows: 0, archiveFailed: 0, pruneSkipped: 0, applied: gate.enabled, note: gate.reason };
  if (!load.ok) return out;
  const policy = load.policy;
  const classesInUse = RETENTION_CLASSES.filter((c) => widestScan(policy, c, "archiveAfterDays") !== null);
  if (classesInUse.length === 0) { out.note = "No retention windows are configured: everything is retained."; return out; }
  out.policyActive = 1;
  let target = options.target;
  if (!target) {
    const choice = archiveTargetFromEnv(env);
    if (!choice.ok) { out.note = `${choice.reason} Nothing is archived or deleted.`; return out; }
    target = choice.target;
  }
  const ctx = { target, key: options.key, now, policy, batchRows: options.batchRows };

  let budget = options.maxBatches ?? RETENTION_BATCHES_PER_TICK;
  for (const cls of classesInUse) {
    const s = classSql(cls);
    // Each workspace is judged by its own window: a per-workspace override (including null = retain forever) wins over the
    // class default, and rows already covered by an archive are not candidates, so nothing starves the queue.
    const defaultDays = policy.classes[cls]?.archiveAfterDays ?? null;
    const overrides: Record<string, number | null> = {};
    for (const ws of Object.keys(policy.workspaces)) overrides[ws] = resolveWindow(policy, ws, cls).archiveAfterDays;
    const candidates = await db.query<{ workspace_id: string }>(
      `select l.workspace_id from ${s.from}
        where ${s.cold}
          and ${s.time} < $1::timestamptz - make_interval(days => case when jsonb_exists($3::jsonb, l.workspace_id) then ($3::jsonb ->> l.workspace_id)::int else $2::int end)
          and not exists (select 1 from platform.retention_archives a where a.workspace_id = l.workspace_id and a.data_class = '${cls}'
                           and (a.last_recorded_at, a.last_row_id::${s.idType}) >= (${s.time}, l.id))
        group by l.workspace_id order by min(${s.time}) limit $4::int`,
      [now.toISOString(), defaultDays, JSON.stringify(overrides), RETENTION_WORKSPACES_PER_CLASS]);
    for (const { workspace_id: ws } of candidates) {
      if (budget <= 0) break;
      const w = resolveWindow(policy, ws, cls);
      if (w.archiveAfterDays === null) continue;
      const r = await archiveBatch(db, ws, cls, w.archiveAfterDays, ctx);
      if (r.status === "archived") { budget--; out.archiveBatches++; out.archivedRows += r.rows; }
      else if (r.status === "failed") { budget--; out.archiveFailed++; if (r.reason === "key_unavailable") { out.note = "ZENITH_BACKUP_KEY is not usable, so archives cannot be sealed."; return out; } }
    }
  }

  if (gate.enabled) {
    for (const archive of await archivesToPrune(db, options.maxPrunes ?? RETENTION_BATCHES_PER_TICK)) {
      const w = resolveWindow(policy, archive.workspaceId, archive.dataClass);
      const recheck = options.recheckMs ?? 3_600_000;
      if (w.pruneAfterDays === null) { await deferArchive(db, archive.id, archive.workspaceId, recheck); continue; }
      const r = await pruneArchive(db, archive, w.pruneAfterDays, true, { target, key: options.key, now }, recheck);
      if (r.status === "pruned") out.prunedRows += r.deleted;
      else { out.pruneSkipped++; await deferArchive(db, archive.id, archive.workspaceId, recheck); }
    }
  }
  return out;
}
