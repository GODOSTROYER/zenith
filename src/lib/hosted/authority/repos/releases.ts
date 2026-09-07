/**
 * `releases` — the immutable record of one attempt to put an artifact in front
 * of users, and the history a rollback selects from.
 *
 * A release is never rewritten in place; only its status and its stamps move,
 * along the path `candidate → verified → active → superseded` (or `failed` /
 * `rolled_back`). The durable *choice* of which release is live is not here at
 * all — it is `apps.active_release_id`, guarded by the fence — so that reading
 * "what is serving" is one row and one column rather than a scan for whichever
 * release currently claims to be active.
 *
 * `nextNumber` is a read-then-write and is only race-free inside the caller's
 * transaction. Call it inside `tx()`; the `UNIQUE (app_id, number)` constraint
 * is the backstop if someone does not.
 *
 * Workstream W1 (hosted R3).
 */
import type { DatabaseSync } from "node:sqlite";
import type { CandidateProbeResult, Release, ReleaseStatus, RuntimeId } from "@/lib/hosted/contracts";
import {
  changeCount,
  nowIso,
  readJson,
  readNumber,
  readOptionalJson,
  readOptionalText,
  readText,
  statements,
  writeJson,
  writeOptional,
  type Prepare,
  type SqlRow,
} from "../sql";

/** What the caller supplies to record a candidate release. */
export interface NewRelease {
  id: string;
  appId: string;
  /** Per-app, 1-based. Take it from `nextNumber` inside the same transaction. */
  number: number;
  artifactDigest: string;
  jobId: string;
  runtime: RuntimeId;
  runtimeRef?: Record<string, unknown>;
  /** Defaults to `candidate`. */
  status?: ReleaseStatus;
  createdAt?: string;
}

/** Stamps `setStatus` may write alongside the status. */
export interface ReleaseStamps {
  verifiedAt?: string;
  activatedAt?: string;
  supersededAt?: string;
  error?: string;
  now?: string;
}

/** Reads and writes of the `releases` table. */
export interface ReleasesRepo {
  insert(input: NewRelease): Release;
  get(id: string): Release | null;
  listByApp(appId: string, opts?: { limit?: number }): Release[];
  /** The next per-app release number. Race-free only inside the caller's transaction. */
  nextNumber(appId: string): number;
  setStatus(id: string, status: ReleaseStatus, stamps?: ReleaseStamps): boolean;
  /** Record a candidate probe result. Verification status is set separately. */
  setProbe(id: string, probe: CandidateProbeResult): boolean;
  /**
   * Mark every currently active release of an app superseded except `exceptId`
   * — the tidy-up that follows a successful activation. Returns how many moved.
   */
  markSuperseded(appId: string, exceptId: string, now?: string): number;
}

const COLUMNS =
  "id, app_id, number, artifact_digest, schema_version, job_id, status, runtime, runtime_ref, " +
  "probe, created_at, verified_at, activated_at, superseded_at, error";

/** The one place a row of `releases` becomes a `Release`. */
function map(row: SqlRow): Release {
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

/** Bind the `releases` repository to one connection. */
export function createReleasesRepo(db: DatabaseSync): ReleasesRepo {
  const sql: Prepare = statements(db);

  return {
    insert(input) {
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
      sql(
        `INSERT INTO releases (${COLUMNS}) ` +
          "VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL)"
      ).run(
        release.id,
        release.appId,
        release.number,
        release.artifactDigest,
        release.jobId,
        release.status,
        release.runtime,
        writeJson(release.runtimeRef),
        release.createdAt
      );
      return release;
    },

    get(id) {
      const row = sql(`SELECT ${COLUMNS} FROM releases WHERE id = ?`).get(id);
      return row ? map(row) : null;
    },

    listByApp(appId, opts = {}) {
      const limit = Math.max(1, Math.trunc(opts.limit ?? 100));
      return sql(`SELECT ${COLUMNS} FROM releases WHERE app_id = ? ORDER BY number DESC LIMIT ?`)
        .all(appId, limit)
        .map(map);
    },

    nextNumber(appId) {
      const row = sql("SELECT COALESCE(MAX(number), 0) + 1 AS next FROM releases WHERE app_id = ?").get(
        appId
      );
      return row ? readNumber(row, "next") : 1;
    },

    setStatus(id, status, stamps = {}) {
      const result = sql(
        "UPDATE releases SET status = ?, verified_at = COALESCE(?, verified_at), " +
          "activated_at = COALESCE(?, activated_at), superseded_at = COALESCE(?, superseded_at), " +
          "error = COALESCE(?, error) WHERE id = ?"
      ).run(
        status,
        writeOptional(stamps.verifiedAt),
        writeOptional(stamps.activatedAt),
        writeOptional(stamps.supersededAt),
        writeOptional(stamps.error),
        id
      );
      return changeCount(result) === 1;
    },

    setProbe(id, probe) {
      const result = sql("UPDATE releases SET probe = ? WHERE id = ?").run(writeJson(probe), id);
      return changeCount(result) === 1;
    },

    markSuperseded(appId, exceptId, now = nowIso()) {
      const result = sql(
        "UPDATE releases SET status = 'superseded', superseded_at = ? " +
          "WHERE app_id = ? AND id <> ? AND status = 'active'"
      ).run(now, appId, exceptId);
      return changeCount(result);
    },
  };
}
