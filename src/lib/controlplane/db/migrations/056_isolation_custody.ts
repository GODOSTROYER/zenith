/** Expand-only, direct-object isolation custody; no change to the OpenTofu artifact contract. */
export const migration0056IsolationCustody = {
  version: 56,
  name: "isolation_custody",
  sql: `
create table if not exists platform.isolation_plan_custody (
  workspace_id text not null,
  operation_id text not null,
  plan_digest text not null check (plan_digest ~ '^[a-f0-9]{64}$'),
  artifact_digest text not null check (artifact_digest ~ '^[a-f0-9]{64}$'),
  iv text not null,
  auth_tag text not null,
  ciphertext text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, operation_id, plan_digest),
  foreign key (workspace_id, operation_id) references platform.operations(workspace_id, id)
);
create or replace function platform.isolation_custody_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'Isolation plan custody is write-once' using errcode = '23514';
end
$$;
drop trigger if exists isolation_custody_immutable on platform.isolation_plan_custody;
create trigger isolation_custody_immutable before update or delete on platform.isolation_plan_custody
for each row execute function platform.isolation_custody_immutable();
alter table platform.isolation_plan_custody enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.isolation_plan_custody from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant select,insert on table platform.isolation_plan_custody to service_role;
  end if;
end
$$;
`,
} as const;
