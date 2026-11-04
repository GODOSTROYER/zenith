/**
 * The append-only structured event log (spec section 37).
 *
 * Events are facts about what the control plane did; they carry a bounded,
 * redacted `data` summary and never secret values (literal secret shapes are
 * refused — see `secrets.ts`). `seq` is a global `bigint` identity: ordering
 * within one workspace is `seq`, and readers page with `afterSeq`.
 *
 * Reader caveat, stated honestly: an identity sequence is assigned at insert
 * time, not commit time, so a reader tailing `afterSeq` can in principle see
 * seq 11 before a slower concurrent writer commits seq 10 and then never
 * revisit it. Consumers that need a gap-free stream (the audit exporter) must
 * re-read a trailing window (e.g. the last 100 seq) on every poll; the event
 * `id` is unique, so re-reading is idempotent.
 */
import type { PlatformEvent, PlatformEventType, Principal, Sql } from "@/lib/controlplane/types";
import { ControlStoreError, requireText } from "../errors";
import { assertNoSecretValues } from "../secrets";
import { clampLimit, json, jsonOrNull, newId, opt } from "../sql";

interface EventRow {
  seq: number;
  id: string;
  ts: string;
  type: PlatformEventType;
  workspace_id: string;
  project_id: string | null;
  environment_id: string | null;
  resource_id: string | null;
  operation_id: string | null;
  correlation_id: string;
  causation_id: string | null;
  actor: Principal | null;
  data: Record<string, unknown>;
}

const COLUMNS = "seq, id, ts, type, workspace_id, project_id, environment_id, resource_id, operation_id, correlation_id, causation_id, actor, data";
const MAX_DATA_BYTES = 64 * 1024;
const TYPE_SHAPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

const toEvent = (row: EventRow): PlatformEvent => ({
  seq: row.seq,
  id: row.id,
  ts: row.ts,
  type: row.type,
  workspaceId: row.workspace_id,
  projectId: opt(row.project_id),
  environmentId: opt(row.environment_id),
  resourceId: opt(row.resource_id),
  operationId: opt(row.operation_id),
  correlationId: row.correlation_id,
  causationId: opt(row.causation_id),
  actor: opt(row.actor),
  data: row.data,
});

export interface AppendEventInput {
  /** default `evt_<uuid>`; supplying it makes the append idempotent */
  id?: string;
  type: PlatformEventType;
  workspaceId: string;
  projectId?: string;
  environmentId?: string;
  resourceId?: string;
  operationId?: string;
  correlationId: string;
  causationId?: string;
  actor?: Principal;
  /** redacted, bounded summary (max 64 KiB serialized) */
  data?: Record<string, unknown>;
}

/**
 * Append an event and return its `seq`. Re-appending the same `id` in the same
 * workspace is a no-op that returns the original `seq`; the same `id` in
 * another workspace is refused.
 */
export async function append(sql: Sql, input: AppendEventInput): Promise<number> {
  const workspaceId = requireText("workspaceId", input.workspaceId);
  const type = requireText("type", input.type, 128);
  if (!TYPE_SHAPE.test(type)) throw new ControlStoreError("invalid_input", "event type must look like `operation.started`.", { field: "type" });
  const data = input.data ?? {};
  const encoded = json(data);
  if (encoded.length > MAX_DATA_BYTES) throw new ControlStoreError("invalid_input", "event data is too large (max 64 KiB); store a digest and a summary.", { field: "data" });
  assertNoSecretValues(data, "data");
  const id = input.id ?? newId("evt");

  const inserted = await sql.query<{ seq: number }>(
    `insert into platform.events (id, type, workspace_id, project_id, environment_id, resource_id, operation_id,
                                  correlation_id, causation_id, actor, data)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text::jsonb, $11::text::jsonb)
     on conflict (id) do nothing
     returning seq`,
    [
      id,
      type,
      workspaceId,
      input.projectId ?? null,
      input.environmentId ?? null,
      input.resourceId ?? null,
      input.operationId ?? null,
      requireText("correlationId", input.correlationId),
      input.causationId ?? null,
      jsonOrNull(input.actor),
      encoded,
    ]
  );
  if (inserted.length > 0) return inserted[0].seq;
  const existing = await sql.query<{ seq: number }>("select seq from platform.events where id = $1 and workspace_id = $2", [id, workspaceId]);
  if (existing.length === 0) throw new ControlStoreError("conflict", "An event with this id already exists.", { id });
  return existing[0].seq;
}

export interface ListEventsFilter {
  operationId?: string;
  correlationId?: string;
  environmentId?: string;
  type?: string;
  /** exclusive lower bound; pass the last `seq` you saw */
  afterSeq?: number;
  /** default 100, max 1000 */
  limit?: number;
}

/** Events of one workspace in ascending `seq` order. */
export async function list(sql: Sql, workspaceId: string, filter: ListEventsFilter = {}): Promise<PlatformEvent[]> {
  const params: unknown[] = [requireText("workspaceId", workspaceId)];
  const where = ["workspace_id = $1"];
  const add = (clause: (n: number) => string, value: unknown): void => {
    params.push(value);
    where.push(clause(params.length));
  };
  if (filter.operationId) add((n) => `operation_id = $${n}`, filter.operationId);
  if (filter.correlationId) add((n) => `correlation_id = $${n}`, filter.correlationId);
  if (filter.environmentId) add((n) => `environment_id = $${n}`, filter.environmentId);
  if (filter.type) add((n) => `type = $${n}`, filter.type);
  if (filter.afterSeq !== undefined) {
    if (!Number.isSafeInteger(filter.afterSeq) || filter.afterSeq < 0) throw new ControlStoreError("invalid_input", "afterSeq must be a non-negative integer.");
    add((n) => `seq > $${n}::bigint`, filter.afterSeq);
  }
  params.push(clampLimit(filter.limit, 100, 1000));
  const rows = await sql.query<EventRow>(
    `select ${COLUMNS} from platform.events where ${where.join(" and ")} order by seq limit $${params.length}::bigint`,
    params
  );
  return rows.map(toEvent);
}
