/**
 * Resumable MCP streams and durable cancellation (PROD-UX-02). Storage only:
 * which principal may open, resume or cancel a stream is decided by
 * `src/lib/agent-access/v3/stream.ts` from the authenticated identity.
 *
 * Tenancy: every function filters on `workspace_id` in SQL AND (where it acts
 * for a caller) on the principal digest, so a foreign workspace, a foreign
 * principal and an unknown stream id are indistinguishable (`readStreamEvents`
 * returns null).
 */
import type { Sql } from "@/lib/controlplane/types";
import { ControlStoreError, requireText } from "../errors";
import { clampLimit, HEX64, json } from "../sql";

export const MCP_STREAM_TTL_SECONDS = 900;
export const MCP_STREAM_MAX_EVENTS = 256;
const STREAM_ID = /^[0-9a-f]{32}$/;

function streamId(value: unknown): string {
  if (typeof value !== "string" || !STREAM_ID.test(value)) throw new ControlStoreError("invalid_input", "streamId must be 32 lowercase hex characters.", { field: "streamId" });
  return value;
}
function principalKey(value: unknown): string {
  if (typeof value !== "string" || !HEX64.test(value)) throw new ControlStoreError("invalid_input", "principalKey must be a sha256 hex digest.", { field: "principalKey" });
  return value;
}

export interface OpenStreamInput {
  workspaceId: string;
  streamId: string;
  principalKey: string;
  requestId: string;
  protocolVersion: string;
  ttlSeconds?: number;
}

/** Open a stream. Expired streams of this workspace are removed in the same transaction. */
export async function openStream(sql: Sql, input: OpenStreamInput): Promise<void> {
  const ws = requireText("workspaceId", input.workspaceId);
  const ttl = Math.max(30, Math.min(3600, Math.trunc(input.ttlSeconds ?? MCP_STREAM_TTL_SECONDS)));
  await sql.tx(async (tx) => {
    await tx.query("delete from platform.mcp_streams where workspace_id=$1 and expires_at < clock_timestamp()", [ws]);
    await tx.query(
      `insert into platform.mcp_streams (id, workspace_id, principal_key, request_id, protocol_version, status, expires_at)
       values ($1,$2,$3,$4,$5,'open', clock_timestamp() + ($6::bigint * interval '1 second'))
       on conflict (id) do nothing`,
      [streamId(input.streamId), ws, principalKey(input.principalKey), requireText("requestId", input.requestId, 200), requireText("protocolVersion", input.protocolVersion, 40), ttl]
    );
  });
}

export interface AppendStreamEventInput {
  workspaceId: string;
  streamId: string;
  principalKey: string;
  payload: unknown;
}

/**
 * Append the next event and return its sequence number. Refused (conflict)
 * when the stream is unknown, foreign, expired or at its bounded size, so a
 * stream can never grow without limit. Callers append one stream serially.
 */
export async function appendStreamEvent(sql: Sql, input: AppendStreamEventInput): Promise<number> {
  const ws = requireText("workspaceId", input.workspaceId);
  const rows = await sql.query<{ seq: number | string }>(
    `insert into platform.mcp_stream_events (stream_id, workspace_id, seq, payload)
     select s.id, s.workspace_id,
            coalesce((select max(e.seq) from platform.mcp_stream_events e where e.stream_id=s.id and e.workspace_id=s.workspace_id),0)+1,
            $5::text::jsonb
     from platform.mcp_streams s
     where s.workspace_id=$1 and s.id=$2 and s.principal_key=$3 and s.expires_at > clock_timestamp()
       and (select count(*) from platform.mcp_stream_events c where c.stream_id=s.id and c.workspace_id=s.workspace_id) < $4
     returning seq`,
    [ws, streamId(input.streamId), principalKey(input.principalKey), MCP_STREAM_MAX_EVENTS, json(input.payload)]
  );
  if (!rows.length) throw new ControlStoreError("conflict", "The stream is unknown, expired or full.");
  return Number(rows[0].seq);
}

export interface ReadStreamEventsInput {
  workspaceId: string;
  principalKey: string;
  streamId: string;
  afterSeq: number;
  limit?: number;
}

export interface StreamEventRow {
  seq: number;
  payload: unknown;
}

/** Events after `afterSeq`, or null when this principal has no such unexpired stream. */
export async function readStreamEvents(sql: Sql, input: ReadStreamEventsInput): Promise<StreamEventRow[] | null> {
  const ws = requireText("workspaceId", input.workspaceId);
  const id = streamId(input.streamId);
  const key = principalKey(input.principalKey);
  const owned = await sql.query<{ id: string }>(
    "select id from platform.mcp_streams where workspace_id=$1 and id=$2 and principal_key=$3 and expires_at > clock_timestamp()",
    [ws, id, key]
  );
  if (!owned.length) return null;
  const after = Math.max(0, Math.trunc(Number.isFinite(input.afterSeq) ? input.afterSeq : 0));
  const rows = await sql.query<{ seq: number | string; payload: unknown }>(
    "select seq, payload from platform.mcp_stream_events where workspace_id=$1 and stream_id=$2 and seq > $3 order by seq limit $4",
    [ws, id, after, clampLimit(input.limit, MCP_STREAM_MAX_EVENTS, MCP_STREAM_MAX_EVENTS)]
  );
  return rows.map((r) => ({ seq: Number(r.seq), payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload }));
}

/** Mark this principal's open stream for a JSON-RPC request id as cancel-requested. Returns how many streams changed. */
export async function requestStreamCancel(sql: Sql, input: { workspaceId: string; principalKey: string; requestId: string }): Promise<number> {
  const ws = requireText("workspaceId", input.workspaceId);
  const rows = await sql.query<{ id: string }>(
    `update platform.mcp_streams set cancel_requested_at=clock_timestamp()
     where workspace_id=$1 and principal_key=$2 and request_id=$3 and status='open' and cancel_requested_at is null and expires_at > clock_timestamp()
     returning id`,
    [ws, principalKey(input.principalKey), requireText("requestId", input.requestId, 200)]
  );
  return rows.length;
}

/** Has a cancel been requested for this stream? Unknown or foreign streams answer false. */
export async function streamCancelRequested(sql: Sql, input: { workspaceId: string; streamId: string }): Promise<boolean> {
  const ws = requireText("workspaceId", input.workspaceId);
  const rows = await sql.query<{ id: string }>(
    "select id from platform.mcp_streams where workspace_id=$1 and id=$2 and cancel_requested_at is not null",
    [ws, streamId(input.streamId)]
  );
  return rows.length > 0;
}

/** Record the terminal state. A stream that already finished keeps its state. */
export async function finishStream(sql: Sql, input: { workspaceId: string; streamId: string; status: "completed" | "cancelled" }): Promise<void> {
  const ws = requireText("workspaceId", input.workspaceId);
  if (input.status !== "completed" && input.status !== "cancelled") throw new ControlStoreError("invalid_input", "status must be completed or cancelled.", { field: "status" });
  await sql.query("update platform.mcp_streams set status=$3 where workspace_id=$1 and id=$2 and status='open'", [ws, streamId(input.streamId), input.status]);
}

/** The lifecycle state of this principal's unexpired stream, or null when there is none. */
export async function streamStatus(sql: Sql, input: { workspaceId: string; principalKey: string; streamId: string }): Promise<"open" | "completed" | "cancelled" | null> {
  const ws = requireText("workspaceId", input.workspaceId);
  const rows = await sql.query<{ status: "open" | "completed" | "cancelled" }>(
    "select status from platform.mcp_streams where workspace_id=$1 and id=$2 and principal_key=$3 and expires_at > clock_timestamp()",
    [ws, streamId(input.streamId), principalKey(input.principalKey)]
  );
  return rows.length ? rows[0].status : null;
}
