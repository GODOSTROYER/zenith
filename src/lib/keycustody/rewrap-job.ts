/**
 * The durable `key-rewrap` critical job (PROD-OPS-05).
 *
 * Runs inside the critical-maintenance Temporal schedule (and, as a fallback trigger, the cron path), under the
 * same fenced `critical-job:key-rewrap` lease and run record as every other critical job. Each tick it:
 *
 *  1. records the configured key ids/roles in `platform.key_custody_keys` (first-seen = key age), and counts
 *     separation violations and overdue retirements for the job's health counts;
 *  2. works the oldest open re-wrap job (`platform.key_rewrap_jobs`, queued by the operator CLI): bounded
 *     batches under write locks, a durable keyset cursor, counts only. A restart resumes from the cursor.
 *
 * Only vault rows are re-wrapped here (`enc:vault`, in `public.secrets` on the Postgres product store). The file
 * store needs the quiesced operator CLI and is `blocked`; plan custody owns re-wrap of its own rows; Temporal
 * history is immutable and is covered by keeping decrypt-only keys, not re-wrapping. Nothing here ever logs or
 * stores refs, values, key ids of rows or error text.
 */
import type { Sql } from "@/lib/controlplane/types";
import { vaultCipherFromEnv } from "@/lib/secrets";
import { postgresVaultRewrapStore } from "@/lib/secrets/pg-rewrap";
import { rewrapVaultStep, VaultRewrapStepError } from "@/lib/secrets/rewrap";
import { buildKeyReport } from "./diagnostics";
import { productSql } from "./product-db";
import { KeyRing, type EnvSource } from "./registry";
import { advanceRewrapJob, claimRewrapJob, finishRewrapJob, listKeys, recordKeys, rewrapBacklog, type RewrapJob } from "./store";

export interface KeyRewrapOptions {
  env?: EnvSource;
  now?: Date;
  /** wall-clock budget for the whole pass; default 15 s */
  budgetMs?: number;
  batchSize?: number;
  maxBatches?: number;
  signal?: AbortSignal;
  /** the product database; default `productSql` (undefined means the file store) */
  product?: () => Promise<Sql | undefined>;
}

export interface KeyRewrapResult {
  /** keys recorded this tick */
  keys: number;
  /** error-level separation findings and configuration errors */
  violations: number;
  /** non-current keys past their retirement date and still configured */
  overdue: number;
  /** non-current keys with no retirement date */
  unscheduled: number;
  pending: number;
  batches: number;
  rewrapped: number;
  completed: number;
  failed: number;
  blocked: number;
  /** a transient store error left the job running for the next tick */
  retry: number;
}

export const REWRAP_BATCH_SIZE = 100;
export const REWRAP_MAX_BATCHES_PER_TICK = 20;

export async function keyRewrapPass(db: Sql, options: KeyRewrapOptions = {}): Promise<KeyRewrapResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const deadline = Date.now() + (options.budgetMs ?? 15_000);
  const out: KeyRewrapResult = { keys: 0, violations: 0, overdue: 0, unscheduled: 0, pending: 0, batches: 0, rewrapped: 0, completed: 0, failed: 0, blocked: 0, retry: 0 };

  // 1. Key records and health counts. A bad configuration is reported, never thrown: the other jobs must keep running.
  const ring = KeyRing.fromEnv(env);
  try {
    out.keys = await recordKeys(db, ring.descriptors());
    const report = buildKeyReport(ring, await listKeys(db), now);
    out.violations = report.violations.filter((v) => v.severity === "error").length;
    out.overdue = report.entries.filter((e) => e.retirement === "overdue").length;
    out.unscheduled = report.entries.filter((e) => e.retirement === "unscheduled").length;
  } catch { out.retry++; }

  // 2. Re-wrap jobs, oldest first, within the budget.
  const maxBatches = options.maxBatches ?? REWRAP_MAX_BATCHES_PER_TICK;
  let batchesLeft = maxBatches;
  while (batchesLeft > 0 && Date.now() < deadline && !options.signal?.aborted) {
    const job = await claimRewrapJob(db);
    if (!job) break;
    const used = await work(db, job, { env, ring, options, deadline, batchesLeft, out });
    // A transient store error (negative) stops this tick; the job resumes next tick.
    if (used < 0) break;
    batchesLeft -= Math.max(1, used);
  }
  try { out.pending = (await rewrapBacklog(db)).pending; } catch { /* health count only */ }
  return out;
}

/** Batches used; negative when a transient error should end the tick. */
async function work(db: Sql, job: RewrapJob, ctx: { env: EnvSource; ring: KeyRing; options: KeyRewrapOptions; deadline: number; batchesLeft: number; out: KeyRewrapResult }): Promise<number> {
  const { env, ring, options, out } = ctx;
  const fail = async (status: "failed" | "blocked", errorCode: "file_store_requires_cli" | "key_unavailable" | "rewrap_failed" | "unreadable_row"): Promise<number> => {
    await finishRewrapJob(db, { workspaceId: job.workspaceId, id: job.id, status, errorCode });
    out[status]++;
    return 0;
  };

  let product: Sql | undefined;
  try { product = await (options.product ?? (() => productSql(db, env)))(); }
  catch { out.retry++; return -1; }
  if (!product) return fail("blocked", "file_store_requires_cli");

  let cipher: ReturnType<typeof vaultCipherFromEnv>;
  let targetKeyId: string;
  try {
    cipher = vaultCipherFromEnv(env);
    targetKeyId = ring.descriptors("enc:vault").find((d) => d.role === "current")?.keyId ?? job.targetKeyId;
  } catch { return fail("failed", "key_unavailable"); }

  const store = postgresVaultRewrapStore(product);
  let cursor = job.cursorRef;
  let batches = 0;
  try {
    while (batches < ctx.batchesLeft && Date.now() < ctx.deadline && !options.signal?.aborted) {
      const step = await rewrapVaultStep(store, { workspaceId: job.workspaceId, after: cursor, cipher, batchSize: options.batchSize ?? REWRAP_BATCH_SIZE });
      batches++;
      out.batches++;
      out.rewrapped += step.rewrapped;
      cursor = step.after;
      if (step.done) {
        await advanceRewrapJob(db, { workspaceId: job.workspaceId, id: job.id, cursorRef: cursor, targetKeyId, inspected: 0, rewrapped: 0, unchanged: 0, batches: 0 });
        await finishRewrapJob(db, { workspaceId: job.workspaceId, id: job.id, status: "completed" });
        out.completed++;
        return batches;
      }
      await advanceRewrapJob(db, { workspaceId: job.workspaceId, id: job.id, cursorRef: cursor, targetKeyId, inspected: step.inspected, rewrapped: step.rewrapped, unchanged: step.unchanged, batches: 1 });
    }
  } catch (error) {
    // A row that opens under no retained key is deterministic: stop and say so (nothing in that batch was written).
    if (error instanceof VaultRewrapStepError && error.code === "unreadable_row") { await fail("failed", "unreadable_row"); return batches; }
    // Anything else may be a transient database error: the job stays running and resumes from its durable cursor.
    // The operator CLI's `rewrap-status` shows a running job whose updated_at stops advancing.
    out.retry++;
    return -1;
  }
  return batches;
}
