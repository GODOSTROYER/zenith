/**
 * `hosted_jobs` — durable operations with leases, fence tokens and single
 * flight per app.
 *
 * Three properties this table is responsible for:
 *
 *  - **Single flight.** A partial unique index on `(app_id) WHERE status =
 *    'running'` means the second concurrent publish for one app fails in
 *    SQLite, not in a code path someone can forget to call. `claim` turns that
 *    into a `conflict` a route can answer with.
 *  - **Leases.** A claim writes `lease_until`. A worker that dies leaves the
 *    lease behind; `reclaimExpired` puts the job back on the queue once the
 *    lease is past, which is the only way a stuck job ever moves again.
 *  - **Fencing.** Every claim increments `fence_token`, and every subsequent
 *    write is conditioned on the token the claimant holds. A worker that was
 *    asleep while its lease expired and the job was re-claimed gets `false`
 *    from `advance`/`finish`/`fail` instead of overwriting the new owner's
 *    work. The same token guards activation (`apps.setActiveRelease`).
 *
 * Workstream W1 (hosted R3).
 */
import type { DatabaseSync } from "node:sqlite";
import { HostedError, type HostedJob, type JobKind, type JobStatus, type Subject } from "@/lib/hosted/contracts";
import {
  changeCount,
  isUniqueViolation,
  nowIso,
  readJson,
  readNumber,
  readOptionalJson,
  readOptionalText,
  readText,
  statements,
  writeJson,
  writeOptional,
  writeOptionalJson,
  type Prepare,
  type SqlRow,
} from "../sql";

/** What the caller supplies to queue a job. Prefer `admitJob`, which adds idempotency. */
export interface NewJob {
  /** The client's UUID. Two calls with this id are the same operation. */
  id: string;
  kind: JobKind;
  workspaceId: string;
  appId: string;
  actor: Subject;
  /** SHA-256 hex over the canonical intent — see `hashIntent` in `../jobs.ts`. */
  intentHash: string;
  /** Defaults to `"queued"`. */
  phase?: string;
  phaseData?: Record<string, unknown>;
  createdAt?: string;
}

/** A job and the fence token the claimant now holds. */
export interface ClaimedJob {
  job: HostedJob;
  fence: number;
}

/** Reads and writes of the `hosted_jobs` table. */
export interface JobsRepo {
  insert(input: NewJob): HostedJob;
  get(id: string): HostedJob | null;
  listByApp(appId: string, opts?: { limit?: number }): HostedJob[];
  /** The job currently running for an app, or null. */
  runningFor(appId: string): HostedJob | null;
  /** How many jobs are running install-wide — the pilot build-slot limit reads this. */
  countRunning(): number;
  /**
   * Take a queued job: status becomes `running`, the lease is set and the fence
   * token increments. Null when the job is missing or not queued. Throws
   * `HostedError("conflict")` when another job is already running for the app —
   * the single-flight index, surfaced.
   */
  claim(id: string, owner: string, leaseMs: number, now?: string): ClaimedJob | null;
  /** Record progress. False when the fence is stale or the job is no longer running. */
  advance(id: string, fence: number, phase: string, phaseData?: Record<string, unknown>, now?: string): boolean;
  finish(id: string, fence: number, result?: Record<string, unknown>, now?: string): boolean;
  fail(id: string, fence: number, error: string, now?: string): boolean;
  /** Cancel a job that has not finished. No fence: an operator outranks a worker. */
  cancel(id: string, reason?: string, now?: string): boolean;
  /** Put every running job whose lease has passed back on the queue. Returns how many moved. */
  reclaimExpired(now?: string): number;
}

const COLUMNS =
  "id, kind, workspace_id, app_id, actor, intent_hash, status, phase, phase_data, attempts, " +
  "lease_owner, lease_until, fence_token, result, error, created_at, updated_at, finished_at";

/** The one place a row of `hosted_jobs` becomes a `HostedJob`. */
function map(row: SqlRow): HostedJob {
  return {
    id: readText(row, "id"),
    kind: readText(row, "kind") as JobKind,
    workspaceId: readText(row, "workspace_id"),
    appId: readText(row, "app_id"),
    actor: readText(row, "actor"),
    intentHash: readText(row, "intent_hash"),
    status: readText(row, "status") as JobStatus,
    phase: readText(row, "phase"),
    phaseData: readJson<Record<string, unknown>>(row, "phase_data"),
    attempts: readNumber(row, "attempts"),
    leaseOwner: readOptionalText(row, "lease_owner"),
    leaseUntil: readOptionalText(row, "lease_until"),
    fenceToken: readNumber(row, "fence_token"),
    result: readOptionalJson<Record<string, unknown>>(row, "result"),
    error: readOptionalText(row, "error"),
    createdAt: readText(row, "created_at"),
    updatedAt: readText(row, "updated_at"),
    finishedAt: readOptionalText(row, "finished_at"),
  };
}

const singleFlight = (appId: string): HostedError =>
  new HostedError(
    "conflict",
    "Another job is already running for this app, so a second one was not started. Hosted apps run one operation at a time.",
    {
      fix: "Wait for the running job to finish — GET /api/hosted/apps/<id>/jobs/<jobId> shows its phase — or cancel it, then start this one again.",
      details: { appId, constraint: "hosted_jobs_single_flight" },
    }
  );

/** Bind the `hosted_jobs` repository to one connection. */
export function createJobsRepo(db: DatabaseSync): JobsRepo {
  const sql: Prepare = statements(db);

  const byId = (id: string): HostedJob | null => {
    const row = sql(`SELECT ${COLUMNS} FROM hosted_jobs WHERE id = ?`).get(id);
    return row ? map(row) : null;
  };

  return {
    insert(input) {
      const at = input.createdAt ?? nowIso();
      const job: HostedJob = {
        id: input.id,
        kind: input.kind,
        workspaceId: input.workspaceId,
        appId: input.appId,
        actor: input.actor,
        intentHash: input.intentHash,
        status: "queued",
        phase: input.phase ?? "queued",
        phaseData: input.phaseData ?? {},
        attempts: 0,
        fenceToken: 0,
        createdAt: at,
        updatedAt: at,
      };
      sql(
        `INSERT INTO hosted_jobs (${COLUMNS}) ` +
          "VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, 0, NULL, NULL, 0, NULL, NULL, ?, ?, NULL)"
      ).run(
        job.id,
        job.kind,
        job.workspaceId,
        job.appId,
        job.actor,
        job.intentHash,
        job.phase,
        writeJson(job.phaseData),
        job.createdAt,
        job.updatedAt
      );
      return job;
    },

    get: byId,

    listByApp(appId, opts = {}) {
      const limit = Math.max(1, Math.trunc(opts.limit ?? 100));
      return sql(
        `SELECT ${COLUMNS} FROM hosted_jobs WHERE app_id = ? ORDER BY created_at DESC, id LIMIT ?`
      )
        .all(appId, limit)
        .map(map);
    },

    runningFor(appId) {
      const row = sql(`SELECT ${COLUMNS} FROM hosted_jobs WHERE app_id = ? AND status = 'running'`).get(
        appId
      );
      return row ? map(row) : null;
    },

    countRunning() {
      const row = sql("SELECT COUNT(*) AS running FROM hosted_jobs WHERE status = 'running'").get();
      return row ? readNumber(row, "running") : 0;
    },

    claim(id, owner, leaseMs, now = nowIso()) {
      const until = nowIso(Date.parse(now) + leaseMs);
      let rows: SqlRow[];
      try {
        rows = sql(
          "UPDATE hosted_jobs SET status = 'running', lease_owner = ?, lease_until = ?, " +
            "fence_token = fence_token + 1, attempts = attempts + 1, updated_at = ? " +
            "WHERE id = ? AND status = 'queued' " +
            `RETURNING ${COLUMNS}`
        ).all(owner, until, now, id);
      } catch (err) {
        // The single-flight index is the only uniqueness this statement can
        // violate, so a UNIQUE failure here means exactly one thing.
        if (isUniqueViolation(err)) {
          const job = byId(id);
          throw singleFlight(job?.appId ?? id);
        }
        throw err;
      }
      if (rows.length !== 1) return null;
      const job = map(rows[0]);
      return { job, fence: job.fenceToken };
    },

    advance(id, fence, phase, phaseData, now = nowIso()) {
      const result = sql(
        "UPDATE hosted_jobs SET phase = ?, phase_data = COALESCE(?, phase_data), updated_at = ? " +
          "WHERE id = ? AND fence_token = ? AND status = 'running'"
      ).run(phase, writeOptionalJson(phaseData), now, id, fence);
      return changeCount(result) === 1;
    },

    finish(id, fence, result, now = nowIso()) {
      const changed = sql(
        "UPDATE hosted_jobs SET status = 'succeeded', result = ?, finished_at = ?, updated_at = ?, " +
          "lease_owner = NULL, lease_until = NULL WHERE id = ? AND fence_token = ? AND status = 'running'"
      ).run(writeOptionalJson(result), now, now, id, fence);
      return changeCount(changed) === 1;
    },

    fail(id, fence, error, now = nowIso()) {
      const changed = sql(
        "UPDATE hosted_jobs SET status = 'failed', error = ?, finished_at = ?, updated_at = ?, " +
          "lease_owner = NULL, lease_until = NULL WHERE id = ? AND fence_token = ? AND status = 'running'"
      ).run(error, now, now, id, fence);
      return changeCount(changed) === 1;
    },

    cancel(id, reason, now = nowIso()) {
      const changed = sql(
        "UPDATE hosted_jobs SET status = 'cancelled', error = COALESCE(?, error), finished_at = ?, " +
          "updated_at = ?, lease_owner = NULL, lease_until = NULL " +
          "WHERE id = ? AND status IN ('queued', 'running')"
      ).run(writeOptional(reason), now, now, id);
      return changeCount(changed) === 1;
    },

    reclaimExpired(now = nowIso()) {
      const changed = sql(
        "UPDATE hosted_jobs SET status = 'queued', lease_owner = NULL, lease_until = NULL, updated_at = ? " +
          "WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until <= ?"
      ).run(now, now);
      return changeCount(changed);
    },
  };
}
