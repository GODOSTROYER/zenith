/**
 * `hosted.releases` — the Postgres twin of `authority/repos/releases.ts`.
 *
 * A release is never rewritten in place; only its status and its stamps move,
 * and the durable *choice* of which release is live is not here at all — it is
 * `hosted.apps.active_release_id`, guarded by the fence. Every transition below
 * is therefore one conditional statement whose row count is the answer, never a
 * read followed by a write that assumes the read is still true.
 *
 * **`nextNumber` is the one place the translation is not literal.** SQLite
 * serialises writers, so `SELECT MAX(number) + 1` inside the caller's
 * transaction could not be overtaken. Postgres lets two transactions read the
 * same maximum and both insert it, and the `unique (app_id, number)` backstop
 * would then turn a perfectly ordinary second publish into a failure. So the
 * app row is locked with `for update` first: the lock is held to the end of the
 * caller's transaction, which makes the read-then-insert one serialised step
 * per app — exactly the guarantee SQLite gave for free, and with exactly the
 * same caveat the interface already states, that it is race-free only inside
 * `tx()`. An app that does not exist locks nothing and answers 1, as it does on
 * SQLite.
 *
 * `number` is `bigint` and arrives as a decimal string; `readNumber` in
 * `../rows.ts` is what turns it back into a `number`.
 */
import type { CandidateProbeResult, Release, ReleaseStatus, RuntimeId } from "@/lib/hosted/contracts";
import { nowIso } from "../../sql";
import type { ReleasesRepo } from "../../repos";
import type { Sql, TransactionSql } from "../client";
import {
  changeCount,
  readJson,
  readNumber,
  readOptionalJson,
  readOptionalText,
  readText,
  writeJson,
  writeOptional,
  type PgRow,
} from "../rows";

/** The one place a row of `releases` becomes a `Release`. */
function map(row: PgRow): Release {
  return {
    id: readText(row, "id"),
    appId: readText(row, "app_id"),
    number: readNumber(row, "number"),
    artifactDigest: readText(row, "artifact_digest"),
    schemaVersion: 1,
    jobId: readText(row, "job_id"),
    status: readText(row, "status") as ReleaseStatus,
    runtime: readText(row, "runtime") as RuntimeId,
    runtimeRef: readJson<Record<string, unknown>>(row, "runtime_ref"),
    probe: readOptionalJson<CandidateProbeResult>(row, "probe"),
    createdAt: readText(row, "created_at"),
    verifiedAt: readOptionalText(row, "verified_at"),
    activatedAt: readOptionalText(row, "activated_at"),
    supersededAt: readOptionalText(row, "superseded_at"),
    error: readOptionalText(row, "error"),
  };
}

/** Bind the `releases` repository to one connection or transaction. */
export function createPgReleasesRepo(sql: Sql | TransactionSql): ReleasesRepo {
  return {
    async insert(input) {
      const release: Release = {
        id: input.id,
        appId: input.appId,
        number: input.number,
        artifactDigest: input.artifactDigest,
        schemaVersion: 1,
        jobId: input.jobId,
        status: input.status ?? "candidate",
        runtime: input.runtime,
        runtimeRef: input.runtimeRef ?? {},
        createdAt: input.createdAt ?? nowIso(),
      };
      await sql`
        insert into hosted.releases
          (id, app_id, number, artifact_digest, schema_version, job_id, status, runtime, runtime_ref,
           probe, created_at, verified_at, activated_at, superseded_at, error)
        values
          (${release.id}, ${release.appId}, ${release.number}, ${release.artifactDigest}, 1,
           ${release.jobId}, ${release.status}, ${release.runtime}, ${writeJson(release.runtimeRef)},
           null, ${release.createdAt}, null, null, null, null)
      `;
      return release;
    },

    async get(id) {
      const rows = (await sql`
        select * from hosted.releases where id = ${id}
      `) as unknown as PgRow[];
      return rows.length === 1 ? map(rows[0]) : null;
    },

    async listByApp(appId, opts = {}) {
      const limit = Math.max(1, Math.trunc(opts.limit ?? 100));
      const rows = (await sql`
        select * from hosted.releases where app_id = ${appId} order by number desc limit ${limit}
      `) as unknown as PgRow[];
      return rows.map(map);
    },

    async nextNumber(appId) {
      // See the header. `for update` cannot be combined with an aggregate, so
      // the lock is taken on the app row first and the maximum read under it;
      // inside `tx()` the lock outlives both statements and the insert that
      // follows, which is what makes the number this hands back still free when
      // the caller uses it.
      await sql`select id from hosted.apps where id = ${appId} for update`;
      const rows = (await sql`
        select coalesce(max(number), 0) + 1 as next from hosted.releases where app_id = ${appId}
      `) as unknown as PgRow[];
      return rows.length === 1 ? readNumber(rows[0], "next") : 1;
    },

    async setStatus(id, status, stamps = {}) {
      const result = await sql`
        update hosted.releases set
          status = ${status},
          verified_at = coalesce(${writeOptional(stamps.verifiedAt)}::text, verified_at),
          activated_at = coalesce(${writeOptional(stamps.activatedAt)}::text, activated_at),
          superseded_at = coalesce(${writeOptional(stamps.supersededAt)}::text, superseded_at),
          error = coalesce(${writeOptional(stamps.error)}::text, error)
        where id = ${id}
      `;
      return changeCount(result) === 1;
    },

    async setProbe(id, probe) {
      const result = await sql`
        update hosted.releases set probe = ${writeJson(probe)} where id = ${id}
      `;
      return changeCount(result) === 1;
    },

    async setRuntimeRef(id, runtimeRef) {
      const result = await sql`
        update hosted.releases set runtime_ref = ${writeJson(runtimeRef)} where id = ${id}
      `;
      return changeCount(result) === 1;
    },

    async markSuperseded(appId, exceptId, now = nowIso()) {
      const result = await sql`
        update hosted.releases set status = 'superseded', superseded_at = ${now}
        where app_id = ${appId} and id <> ${exceptId} and status = 'active'
      `;
      return changeCount(result);
    },
  };
}
