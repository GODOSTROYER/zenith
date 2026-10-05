/**
 * Staged connection credential rotation (PROD-LIFE-01). A rotation row holds a
 * non-secret CANDIDATE config for one provider connection. The live connection
 * keeps serving until a single compare-and-swap promotion replaces its config,
 * so rotation has no downtime window. At most one open rotation exists per
 * connection; promoted, aborted and superseded rows are the audit history.
 */
export const migration0022ConnectionRotations = {
  version: 22,
  name: "connection_rotations",
  sql: `
create table if not exists platform.connection_rotations (
  id                  text        not null primary key,
  workspace_id        text        not null,
  connection_id       text        not null,
  status              text        not null check (status in ('staged','verified','failed','promoted','aborted','superseded')),
  base_config_digest  text        not null check (base_config_digest ~ '^[0-9a-f]{64}$'),
  candidate_config    jsonb       not null,
  candidate_digest    text        not null check (candidate_digest ~ '^[0-9a-f]{64}$'),
  verification_detail text,
  verified_at         timestamptz,
  created_by          text        not null,
  created_at          timestamptz not null default clock_timestamp(),
  resolved_by         text,
  resolved_at         timestamptz,
  foreign key (workspace_id, connection_id) references platform.provider_connections (workspace_id, id),
  check ((status in ('promoted','aborted','superseded')) = (resolved_at is not null))
);
create unique index if not exists connection_rotations_open on platform.connection_rotations (workspace_id, connection_id) where status in ('staged','verified','failed');
create index if not exists connection_rotations_ws on platform.connection_rotations (workspace_id, connection_id, created_at desc);
alter table platform.connection_rotations enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.connection_rotations from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.connection_rotations from service_role;
    grant select,insert,update on table platform.connection_rotations to service_role;
  end if;
end
$$;
`,
} as const;
