/**
 * Postgres `ReleaseStore` (PROD-LIFE-10). Every statement filters on `workspace_id`. A transition
 * is a compare-and-set on `version` plus an event row in the SAME transaction. Values are `$n`
 * parameters; the only text interpolated into SQL is the fixed column list below.
 *
 * Deliberately NOT added to `repos/index.ts` (the shared registry), like the runbook store: it is
 * constructed by `createPlatformReleaseStore(db)` in the composition root.
 */
import type { NewRun, ReleaseStore, TransitionInput } from "@/lib/release-safety/store";
import type { MigrationApproval, ReleaseEvent, ReleaseRun } from "@/lib/release-safety/types";
import type { Sql } from "@/lib/controlplane/types";
import { clampLimit, json, jsonOrNull, textArray } from "../sql";

type Row = Record<string, unknown>;
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const parse = <T>(v: unknown): T => (typeof v === "string" ? (JSON.parse(v) as T) : (v as T));
const isUnique = (e: unknown): boolean => typeof e === "object" && e !== null && ((e as { code?: unknown }).code === "23505" || /duplicate key|unique constraint/i.test(String((e as { message?: unknown }).message)));

const COLS = "id, workspace_id, project_id, environment_id, operation_id, revision_id, requested_by, service_address, kind, state, image_uri, image_digest, source_digest, previous_digest, restores_run_id, provenance, migration, rollout, readback, reason, version, created_at, updated_at";

const runOf = (r: Row): ReleaseRun => ({
  id: r.id as string,
  workspaceId: r.workspace_id as string,
  ...(r.project_id ? { projectId: r.project_id as string } : {}),
  environmentId: r.environment_id as string,
  operationId: r.operation_id as string,
  ...(r.revision_id ? { revisionId: r.revision_id as string } : {}),
  requestedBy: r.requested_by as string,
  serviceAddress: r.service_address as string,
  kind: r.kind as ReleaseRun["kind"],
  state: r.state as ReleaseRun["state"],
  imageUri: r.image_uri as string,
  imageDigest: r.image_digest as string,
  ...(r.source_digest ? { sourceDigest: r.source_digest as string } : {}),
  ...(r.previous_digest ? { previousDigest: r.previous_digest as string } : {}),
  ...(r.restores_run_id ? { restoresRunId: r.restores_run_id as string } : {}),
  provenance: parse(r.provenance),
  migration: parse(r.migration),
  rollout: parse(r.rollout),
  ...(r.readback ? { readback: parse(r.readback) } : {}),
  ...(r.reason ? { reason: r.reason as string } : {}),
  version: Number(r.version),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

const approvalOf = (r: Row): MigrationApproval => ({
  id: r.id as string,
  workspaceId: r.workspace_id as string,
  runId: r.run_id as string,
  bindingDigest: r.binding_digest as string,
  class: r.class as MigrationApproval["class"],
  approvedBy: r.approved_by as string,
  requestedBy: r.requested_by as string,
  approvedAt: iso(r.approved_at),
  expiresAt: iso(r.expires_at),
  ...(r.consumed_at ? { consumedAt: iso(r.consumed_at) } : {}),
});

async function appendEvent(tx: Sql, ws: string, runId: string, from: string | null, to: string, detail: string, actor: string): Promise<void> {
  await tx.query(
    "insert into platform.release_events(workspace_id, run_id, seq, from_state, to_state, detail, actor) select $1,$2, coalesce(max(seq),0)+1, $3,$4,$5,$6 from platform.release_events where workspace_id=$1 and run_id=$2",
    [ws, runId, from, to, detail.slice(0, 600), actor.slice(0, 200)]
  );
}

export function createPlatformReleaseStore(db: Sql): ReleaseStore {
  return {
    async insertRun(run: NewRun) {
      try {
        return await db.tx(async (tx) => {
          const rows = await tx.query<Row>(
            `insert into platform.release_runs(id, workspace_id, project_id, environment_id, operation_id, revision_id, requested_by, service_address, kind, state, image_uri, image_digest, source_digest, previous_digest, restores_run_id, provenance, migration, rollout, reason)
             values ($1,$2,$3,$4,$5,$18,$6,$7,$8,'planned',$9,$10,$11,$12,$13,$14::text::jsonb,$15::text::jsonb,$16::text::jsonb,$17) returning ${COLS}`,
            [run.id, run.workspaceId, run.projectId ?? null, run.environmentId, run.operationId, run.requestedBy, run.serviceAddress, run.kind, run.imageUri, run.imageDigest, run.sourceDigest ?? null, run.previousDigest ?? null, run.restoresRunId ?? null, json(run.provenance), json(run.migration), json(run.rollout), run.reason ?? null, run.revisionId ?? null]
          );
          await appendEvent(tx, run.workspaceId, run.id, null, "planned", "release run planned", "system");
          return { run: runOf(rows[0]), created: true };
        });
      } catch (e) {
        if (!isUnique(e)) throw e;
        const rows = await db.query<Row>(`select ${COLS} from platform.release_runs where workspace_id=$1 and operation_id=$2 and service_address=$3 and kind=$4`, [run.workspaceId, run.operationId, run.serviceAddress, run.kind]);
        if (!rows[0]) throw e;
        return { run: runOf(rows[0]), created: false };
      }
    },
    async getRun(ws, id) {
      const rows = await db.query<Row>(`select ${COLS} from platform.release_runs where workspace_id=$1 and id=$2`, [ws, id]);
      return rows[0] ? runOf(rows[0]) : null;
    },
    async findRun(ws, operationId, serviceAddress, kind) {
      const rows = await db.query<Row>(`select ${COLS} from platform.release_runs where workspace_id=$1 and operation_id=$2 and service_address=$3 and kind=$4`, [ws, operationId, serviceAddress, kind]);
      return rows[0] ? runOf(rows[0]) : null;
    },
    async listRuns(ws, f) {
      const rows = await db.query<Row>(
        `select ${COLS} from platform.release_runs where workspace_id=$1 and ($2::text is null or environment_id=$2) and ($3::text is null or service_address=$3) and ($4::text is null or operation_id=$4) and ($5::text[] is null or state = any($5::text[])) and ($7::text is null or revision_id=$7) order by created_at desc, id desc limit $6`,
        [ws, f.environmentId ?? null, f.serviceAddress ?? null, f.operationId ?? null, f.states ? textArray(f.states) : null, clampLimit(f.limit, 100, 200), f.revisionId ?? null]
      );
      return rows.map(runOf);
    },
    async transition(input: TransitionInput) {
      const p = input.patch ?? {};
      return db.tx(async (tx) => {
        const before = await tx.query<Row>("select state from platform.release_runs where workspace_id=$1 and id=$2 and version=$3 for update", [input.workspaceId, input.id, input.expectVersion]);
        if (!before[0]) return null;
        const rows = await tx.query<Row>(
          `update platform.release_runs set state=$4, version=version+1, updated_at=clock_timestamp(),
             image_uri=coalesce($5, image_uri), provenance=coalesce($6::text::jsonb, provenance), migration=coalesce($7::text::jsonb, migration), rollout=coalesce($8::text::jsonb, rollout),
             readback=coalesce($9::text::jsonb, readback), reason=coalesce($10, reason), previous_digest=coalesce($11, previous_digest), restores_run_id=coalesce($12, restores_run_id)
           where workspace_id=$1 and id=$2 and version=$3 returning ${COLS}`,
          [input.workspaceId, input.id, input.expectVersion, input.to, p.imageUri ?? null, jsonOrNull(p.provenance), jsonOrNull(p.migration), jsonOrNull(p.rollout), jsonOrNull(p.readback), p.reason ?? null, p.previousDigest ?? null, p.restoresRunId ?? null]
        );
        if (!rows[0]) return null;
        await appendEvent(tx, input.workspaceId, input.id, before[0].state as string, input.to, input.detail, input.actor);
        return runOf(rows[0]);
      });
    },
    async listEvents(ws, runId) {
      const rows = await db.query<Row>("select run_id, seq, from_state, to_state, detail, actor, created_at from platform.release_events where workspace_id=$1 and run_id=$2 order by seq asc limit 500", [ws, runId]);
      return rows.map((r): ReleaseEvent => ({ runId: r.run_id as string, seq: Number(r.seq), from: (r.from_state as ReleaseEvent["from"]) ?? null, to: r.to_state as ReleaseEvent["to"], detail: r.detail as string, actor: r.actor as string, at: iso(r.created_at) }));
    },
    async insertApproval(a) {
      try {
        const rows = await db.query<Row>(
          "insert into platform.release_migration_approvals(id, workspace_id, run_id, binding_digest, class, approved_by, requested_by, approved_at, expires_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *",
          [a.id, a.workspaceId, a.runId, a.bindingDigest, a.class, a.approvedBy, a.requestedBy, a.approvedAt, a.expiresAt]
        );
        return { approval: approvalOf(rows[0]), created: true };
      } catch (e) {
        if (!isUnique(e)) throw e;
        const rows = await db.query<Row>("select * from platform.release_migration_approvals where workspace_id=$1 and run_id=$2 and binding_digest=$3", [a.workspaceId, a.runId, a.bindingDigest]);
        if (!rows[0]) throw e;
        return { approval: approvalOf(rows[0]), created: false };
      }
    },
    async findUsableApproval(ws, bindingDigest, now) {
      const rows = await db.query<Row>(
        "select * from platform.release_migration_approvals where workspace_id=$1 and binding_digest=$2 and consumed_at is null and expires_at > $3 order by approved_at desc limit 1",
        [ws, bindingDigest, now.toISOString()]
      );
      return rows[0] ? approvalOf(rows[0]) : null;
    },
    async consumeApproval(ws, id, now) {
      const rows = await db.query<Row>("update platform.release_migration_approvals set consumed_at=$3 where workspace_id=$1 and id=$2 and consumed_at is null and expires_at > $3 returning id", [ws, id, now.toISOString()]);
      return rows.length === 1;
    },
  };
}
