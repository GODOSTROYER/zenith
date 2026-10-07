/**
 * Durable state and ledger of mixed-graph parent runs (PROD-MIX-03/04).
 *
 * Every function names the workspace and filters on it: a run of another tenant is `null` /
 * `not_found`, exactly as a missing one. Writes are compare-and-set on `version`; the state row
 * and its ledger event are written in one transaction, so a ledger entry never exists without the
 * state it describes (and vice versa). Event data holds ids and digests only.
 *
 * `listDue` is system maintenance across tenants (the housekeeping sweep): it returns the
 * workspace-qualified keys of runs whose deadline has passed, never run content; each run is then
 * read and written through the tenant-filtered functions below.
 */
import type { Sql } from "@/lib/controlplane/types";
import { ControlStoreError, requireText } from "../errors";
import { clampLimit, json } from "../sql";

export interface MixedRunRow {
  workspaceId: string;
  parentOperationId: string;
  environmentId: string;
  parentDigest: string;
  desiredDigest: string;
  state: unknown;
  stateDigest: string;
  version: number;
  open: boolean;
  nextDeadlineAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MixedRunEventRow {
  seq: number;
  kind: string;
  childId?: string;
  event: unknown;
  stateDigest: string;
  createdAt: string;
}

export interface MixedRunWrite {
  workspaceId: string;
  parentOperationId: string;
  environmentId: string;
  parentDigest: string;
  desiredDigest: string;
  state: unknown;
  stateDigest: string;
  open: boolean;
  nextDeadlineAt: string | null;
  event: { seq: number; kind: string; childId?: string; data: unknown };
}

interface Row {
  workspace_id: string; parent_operation_id: string; environment_id: string; parent_digest: string; desired_digest: string; state: unknown; state_digest: string;
  version: number; open: boolean; next_deadline_at: string | null; created_at: string; updated_at: string;
}
const COLUMNS = "workspace_id, parent_operation_id, environment_id, parent_digest, desired_digest, state, state_digest, version, open, next_deadline_at, created_at, updated_at";
const parse = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : value);
const toRow = (r: Row): MixedRunRow => ({
  workspaceId: r.workspace_id, parentOperationId: r.parent_operation_id, environmentId: r.environment_id, parentDigest: r.parent_digest, desiredDigest: r.desired_digest,
  state: parse(r.state), stateDigest: r.state_digest, version: Number(r.version), open: r.open,
  ...(r.next_deadline_at ? { nextDeadlineAt: new Date(r.next_deadline_at).toISOString() } : {}),
  createdAt: String(r.created_at), updatedAt: String(r.updated_at),
});

export async function get(sql: Sql, workspaceId: string, parentOperationId: string): Promise<MixedRunRow | null> {
  const rows = await sql.query<Row>(`select ${COLUMNS} from platform.mixed_runs where workspace_id = $1 and parent_operation_id = $2`,
    [requireText("workspaceId", workspaceId), requireText("parentOperationId", parentOperationId)]);
  return rows.length ? toRow(rows[0]) : null;
}

/** Insert the first state (version 1) and its `run_created` event atomically. A second create for the parent conflicts. */
export async function create(sql: Sql, input: MixedRunWrite): Promise<MixedRunRow> {
  const ws = requireText("workspaceId", input.workspaceId);
  return sql.tx(async (tx) => {
    const rows = await tx.query<Row>(
      `insert into platform.mixed_runs (workspace_id, parent_operation_id, environment_id, parent_digest, desired_digest, state, state_digest, open, next_deadline_at)
       values ($1,$2,$3,$4,$5,$6::text::jsonb,$7,$8,$9) on conflict (workspace_id, parent_operation_id) do nothing returning ${COLUMNS}`,
      [ws, requireText("parentOperationId", input.parentOperationId), requireText("environmentId", input.environmentId), input.parentDigest, input.desiredDigest,
        json(input.state), input.stateDigest, input.open, input.nextDeadlineAt]);
    if (!rows.length) throw new ControlStoreError("conflict", "A mixed run already exists for this parent operation.", { id: input.parentOperationId });
    await appendEvent(tx, ws, input.parentOperationId, input.stateDigest, input.event);
    return toRow(rows[0]);
  });
}

/** Compare-and-set write of the next state plus its ledger event. */
export async function save(sql: Sql, input: MixedRunWrite & { expectedVersion: number }): Promise<MixedRunRow> {
  const ws = requireText("workspaceId", input.workspaceId);
  const parent = requireText("parentOperationId", input.parentOperationId);
  return sql.tx(async (tx) => {
    const rows = await tx.query<Row>(
      `update platform.mixed_runs set parent_digest = $4, state = $5::text::jsonb, state_digest = $6, open = $7, next_deadline_at = $8, version = version + 1, updated_at = clock_timestamp()
       where workspace_id = $1 and parent_operation_id = $2 and version = $3 returning ${COLUMNS}`,
      [ws, parent, input.expectedVersion, input.parentDigest, json(input.state), input.stateDigest, input.open, input.nextDeadlineAt]);
    if (!rows.length) {
      const existing = await get(tx, ws, parent);
      if (!existing) throw new ControlStoreError("not_found", "Mixed run not found.", { id: parent });
      throw new ControlStoreError("conflict", "The mixed run changed concurrently.", { id: parent, currentVersion: existing.version });
    }
    await appendEvent(tx, ws, parent, input.stateDigest, input.event);
    return toRow(rows[0]);
  });
}

async function appendEvent(tx: Sql, workspaceId: string, parentOperationId: string, stateDigest: string, event: MixedRunWrite["event"]): Promise<void> {
  await tx.query(
    `insert into platform.mixed_run_events (workspace_id, parent_operation_id, seq, kind, child_id, event, state_digest) values ($1,$2,$3,$4,$5,$6::text::jsonb,$7)`,
    [workspaceId, parentOperationId, event.seq, event.kind, event.childId ?? null, json(event.data), stateDigest]);
}

export async function listEvents(sql: Sql, workspaceId: string, parentOperationId: string, limit = 200): Promise<MixedRunEventRow[]> {
  const rows = await sql.query<{ seq: number; kind: string; child_id: string | null; event: unknown; state_digest: string; created_at: string }>(
    `select seq, kind, child_id, event, state_digest, created_at from platform.mixed_run_events where workspace_id = $1 and parent_operation_id = $2 order by seq limit $3`,
    [requireText("workspaceId", workspaceId), requireText("parentOperationId", parentOperationId), clampLimit(limit, 200, 1000)]);
  return rows.map((r) => ({ seq: Number(r.seq), kind: r.kind, ...(r.child_id ? { childId: r.child_id } : {}), event: parse(r.event), stateDigest: r.state_digest, createdAt: String(r.created_at) }));
}

/** System maintenance: keys of open runs whose deadline is at or before `now`. Never returns run content. */
export async function listDue(sql: Sql, now: Date, limit = 50): Promise<{ workspaceId: string; parentOperationId: string }[]> {
  const rows = await sql.query<{ workspace_id: string; parent_operation_id: string }>(
    `select workspace_id, parent_operation_id from platform.mixed_runs where open and next_deadline_at is not null and next_deadline_at <= $1::timestamptz
     order by next_deadline_at, workspace_id, parent_operation_id limit $2`, [now.toISOString(), clampLimit(limit, 50, 500)]);
  return rows.map((r) => ({ workspaceId: r.workspace_id, parentOperationId: r.parent_operation_id }));
}
