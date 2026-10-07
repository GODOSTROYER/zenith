/**
 * Resumable MCP streams and durable client cancellation (PROD-UX-02).
 *
 *  - mcp_streams: one row per streamed (SSE) MCP request, bound to the
 *    workspace and to a digest of the authenticated principal (credential id,
 *    subject, workspace). A reconnect with Last-Event-ID is served only to the
 *    same principal; anyone else sees the same "not found" as an unknown id.
 *    `cancel_requested_at` is the durable form of notifications/cancelled, so
 *    a cancel that lands on a different serverless instance still reaches the
 *    in-flight request.
 *  - mcp_stream_events: the ordered JSON-RPC messages of one stream, replayed
 *    after Last-Event-ID. Rows expire with their stream (cascade) and are
 *    bounded per stream by the repository.
 */
export const migration0036McpStreams = {
  version: 36,
  name: "mcp_streams",
  sql: `
create table if not exists platform.mcp_streams (
  id                  text primary key check (id ~ '^[0-9a-f]{32}$'),
  workspace_id        text not null,
  principal_key       text not null check (principal_key ~ '^[0-9a-f]{64}$'),
  request_id          text not null check (char_length(request_id) between 1 and 200),
  protocol_version    text not null check (char_length(protocol_version) between 1 and 40),
  status              text not null check (status in ('open','completed','cancelled')),
  cancel_requested_at timestamptz,
  created_at          timestamptz not null default clock_timestamp(),
  expires_at          timestamptz not null
);
create index if not exists mcp_streams_request on platform.mcp_streams(workspace_id, principal_key, request_id, created_at desc);
create index if not exists mcp_streams_expiry on platform.mcp_streams(workspace_id, expires_at);
create table if not exists platform.mcp_stream_events (
  stream_id    text not null references platform.mcp_streams(id) on delete cascade,
  workspace_id text not null,
  seq          integer not null check (seq > 0),
  payload      jsonb not null,
  created_at   timestamptz not null default clock_timestamp(),
  primary key (stream_id, seq)
);
alter table platform.mcp_streams enable row level security;
alter table platform.mcp_stream_events enable row level security;
do $$
declare r text; t text;
begin
  foreach t in array array['mcp_streams','mcp_stream_events'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists(select 1 from pg_roles where rolname=r) then
        execute format('revoke all on table platform.%I from %I',t,r);
      end if;
    end loop;
    if exists(select 1 from pg_roles where rolname='service_role') then
      execute format('revoke all on table platform.%I from service_role',t);
      execute format('grant select,insert,update,delete on table platform.%I to service_role',t);
    end if;
  end loop;
end
$$;
`,
} as const;
