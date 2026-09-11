/**
 * `hosted.hosted_jobs` — the Postgres twin of `authority/repos/jobs.ts`.
 *
 * The three properties this table is responsible for survive the translation
 * unchanged, and each one is a database fact rather than a code path:
 *
 *  - **Single flight** is the partial unique index
 *    `hosted_jobs_single_flight on (app_id) where status = 'running'`. A second
 *    concurrent claim for one app violates it, and `claim` turns that into the
 *    same `HostedError("conflict")` with the same message and the same
 *    `details.constraint` the SQLite repository raises. The only thing that
 *    changed is how the violation is recognised: SQLSTATE `23505` here,
 *    extended result codes 2067/1555 there.
 *  - **Leases** are `lease_until`, compared as text — which works because every
 *    timestamp is fixed-width ISO-8601 UTC on both stores. See the migration's
 *    header for why that column is not `timestamptz`.
 *  - **Fencing** is `fence_token`, incremented by every claim and named in the
 *    `where` of every subsequent write.
 *
 * `fence_token` is `bigint` in Postgres and arrives as a decimal string;
 * `readNumber` in `../rows.ts` is what turns it back into the `number` the
 * `HostedJob` contract types it as, refusing rather than rounding anything past
 * `Number.MAX_SAFE_INTEGER`.
 */
import { HostedError, type HostedJob, type JobKind, type JobStatus } from "@/lib/hosted/contracts";
import { nowIso } from "../../sql";
import type { JobsRepo } from "../../repos";
import type { Sql, TransactionSql } from "../client";
import { isUniqueViolation } from "../errors";
import {
  changeCount,
  readJson,
  readNumber,
  readOptionalJson,
  readOptionalText,
  readText,
  writeJson,
  writeOptional,
  writeOptionalJson,
  type PgRow,
} from "../rows";

/** The one place a row of `hosted_jobs` becomes a `HostedJob`. */
function map(row: PgRow): HostedJob {
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

/** Word for word what the SQLite repository raises, so a route reads one answer. */
const singleFlight = (appId: string): HostedError =>
  new HostedError(
    "conflict",
    "Another job is already running for this app, so a second one was not started. Hosted apps run one operation at a time.",
    {
      fix: "Wait for the running job to finish — GET /api/hosted/apps/<id>/jobs/<jobId> shows its phase — or cancel it, then start this one again.",
      details: { appId, constraint: "hosted_jobs_single_flight" },
    }
  );

/** Bind the `hosted_jobs` repository to one connection or transaction. */
export function createPgJobsRepo(sql: Sql | TransactionSql): JobsRepo {
  const byId = async (id: string): Promise<HostedJob | null> => {
    const rows = (await sql`
      select * from hosted.hosted_jobs where id = ${id}
    `) as unknown as PgRow[];
    return rows.length === 1 ? map(rows[0]) : null;
  };

  return {
    async insert(input) {
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
      await sql`
        insert into hosted.hosted_jobs
          (id, kind, workspace_id, app_id, actor, intent_hash, status, phase, phase_data, attempts,
           lease_owner, lease_until, fence_token, result, error, created_at, updated_at, finished_at)
        values
          (${job.id}, ${job.kind}, ${job.workspaceId}, ${job.appId}, ${job.actor}, ${job.intentHash},
           'queued', ${job.phase}, ${writeJson(job.phaseData)}, 0,
           null, null, 0, null, null, ${job.createdAt}, ${job.updatedAt}, null)
      `;
      return job;
    },

    get: byId,

    async listByApp(appId, opts = {}) {
      const limit = Math.max(1, Math.trunc(opts.limit ?? 100));
      const rows = (await sql`
        select * from hosted.hosted_jobs
        where app_id = ${appId}
        order by created_at desc, id
        limit ${limit}
      `) as unknown as PgRow[];
      return rows.map(map);
    },

    async runningFor(appId) {
      const rows = (await sql`
        select * from hosted.hosted_jobs where app_id = ${appId} and status = 'running'
      `) as unknown as PgRow[];
      return rows.length === 1 ? map(rows[0]) : null;
    },

    async countRunning() {
      const rows = (await sql`
        select count(*) as running from hosted.hosted_jobs where status = 'running'
      `) as unknown as PgRow[];
      return rows.length === 1 ? readNumber(rows[0], "running") : 0;
    },

    async claim(id, owner, leaseMs, now = nowIso()) {
      const until = nowIso(Date.parse(now) + leaseMs);
      // Read first, on purpose. A UNIQUE failure below aborts the enclosing
      // Postgres transaction, and nothing can be read on an aborted transaction
      // — so the app id the refusal names has to be in hand *before* the
      // statement that might fail, not looked up after it.
      const before = await byId(id);
      if (!before || before.status !== "queued") return null;
      let rows: PgRow[];
      try {
        rows = (await sql`
          update hosted.hosted_jobs set
            status = 'running',
            lease_owner = ${owner},
            lease_until = ${until},
            fence_token = fence_token + 1,
            attempts = attempts + 1,
            updated_at = ${now}
          where id = ${id} and status = 'queued'
          returning *
        `) as unknown as PgRow[];
      } catch (err) {
        // The single-flight index is the only uniqueness this statement can
        // violate, so a UNIQUE failure here means exactly one thing.
        if (isUniqueViolation(err)) throw singleFlight(before.appId);
        throw err;
      }
      if (rows.length !== 1) return null;
      const job = map(rows[0]);
      return { job, fence: job.fenceToken };
    },

    async advance(id, fence, phase, phaseData, now = nowIso()) {
      const result = await sql`
        update hosted.hosted_jobs set
          phase = ${phase},
          phase_data = coalesce(${writeOptionalJson(phaseData)}, phase_data),
          updated_at = ${now}
        where id = ${id} and fence_token = ${fence} and status = 'running'
      `;
      return changeCount(result) === 1;
    },

    async setPhaseData(id, phaseData, now = nowIso()) {
      const result = await sql`
        update hosted.hosted_jobs set phase_data = ${writeJson(phaseData)}, updated_at = ${now}
        where id = ${id} and status = 'queued'
      `;
      return changeCount(result) === 1;
    },

    async renewLease(id, fence, until, now = nowIso()) {
      const result = await sql`
        update hosted.hosted_jobs set lease_until = ${until}, updated_at = ${now}
        where id = ${id} and fence_token = ${fence} and status = 'running'
      `;
      return changeCount(result) === 1;
    },

    async finish(id, fence, result, now = nowIso()) {
      const changed = await sql`
        update hosted.hosted_jobs set
          status = 'succeeded',
          result = ${writeOptionalJson(result)},
          finished_at = ${now},
          updated_at = ${now},
          lease_owner = null,
          lease_until = null
        where id = ${id} and fence_token = ${fence} and status = 'running'
      `;
      return changeCount(changed) === 1;
    },

    async fail(id, fence, error, now = nowIso()) {
      const changed = await sql`
        update hosted.hosted_jobs set
          status = 'failed',
          error = ${error},
          finished_at = ${now},
          updated_at = ${now},
          lease_owner = null,
          lease_until = null
        where id = ${id} and fence_token = ${fence} and status = 'running'
      `;
      return changeCount(changed) === 1;
    },

    async cancel(id, reason, now = nowIso()) {
      const changed = await sql`
        update hosted.hosted_jobs set
          status = 'cancelled',
          error = coalesce(${writeOptional(reason)}, error),
          finished_at = ${now},
          updated_at = ${now},
          lease_owner = null,
          lease_until = null
        where id = ${id} and status in ('queued', 'running')
      `;
      return changeCount(changed) === 1;
    },

    async reclaimExpired(now = nowIso()) {
      const changed = await sql`
        update hosted.hosted_jobs set
          status = 'queued', lease_owner = null, lease_until = null, updated_at = ${now}
        where status = 'running' and lease_until is not null and lease_until <= ${now}
      `;
      return changeCount(changed);
    },

    async queued(limit = 50) {
      const rows = (await sql`
        select id, app_id from hosted.hosted_jobs
        where status = 'queued'
        order by created_at, id
        limit ${Math.max(1, Math.trunc(limit))}
      `) as unknown as PgRow[];
      return rows.map((row) => ({ id: readText(row, "id"), appId: readText(row, "app_id") }));
    },
  };
}
