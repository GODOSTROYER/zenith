-- Zenith agent access — the whole-workspace grant and workspace-level
-- operations (PLAN3 §2a, §2b).
--
-- Three additive changes to the `agent` schema that 0006 and 0007 created:
--
--   1. `agent_credentials.all_projects` — a flag, not a `*` sentinel in
--      `project_ids`. A sentinel fails every identifier check and would match
--      an `includes()` by accident; a boolean is read only by `grantsProject`.
--      A whole-workspace credential stores `project_ids = '[]'` and no
--      environment narrowing, and both rules are CHECKs here, not only in the
--      parser.
--   2. `agent_link_codes.protocol_version` and two unverified hints. The
--      approval page offers the whole-workspace option only at protocol >= 2,
--      because a v1 client rejects an empty `projectIds` at exchange and would
--      burn the single-use token.
--   3. `agent_operations.project_id` becomes nullable: a workspace-level
--      operation (project.create, connection.*, workspace.rename, …) has no
--      project. The document still carries the full target.
--
-- **Rollback.** Every added column has a default the old build never reads, and
-- the old build writes rows that satisfy the new CHECKs (it always stores at
-- least one project and `all_projects` defaults to false). Reverting the
-- application is therefore enough. Restore `project_id not null` only if
--   select count(*) from agent.agent_operations where project_id is null;
-- is 0, and restore the old length check only if no row has all_projects.
--
-- Idempotent throughout: `add column if not exists`, the constraint swap is
-- guarded by name, `drop not null` on a nullable column is a no-op, and the
-- ledger insert is `on conflict do nothing`. Applied by hand by the operator
-- (docs/HOSTED-POSTGRES.md §9.4); nothing in the application ever runs DDL.

create schema if not exists agent;

/* --------------------------- agent_credentials ----------------------------- */

alter table agent.agent_credentials
  add column if not exists all_projects boolean not null default false;

-- 0006 declared `check (jsonb_array_length(project_ids) between 1 and 100)`
-- without a name, so PostgreSQL named it. Find it by definition, drop it, and
-- add the relaxed, named replacement — in one statement, so no moment exists
-- where the table has no bound on `project_ids`.
do $$
declare
  c record;
begin
  for c in
    select con.conname
      from pg_constraint con
     where con.conrelid = 'agent.agent_credentials'::regclass
       and con.contype = 'c'
       and con.conname not in ('agent_credentials_project_scope', 'agent_credentials_scope_env')
       and pg_get_constraintdef(con.oid) ilike '%jsonb_array_length(project_ids)%'
  loop
    execute format('alter table agent.agent_credentials drop constraint %I', c.conname);
  end loop;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'agent.agent_credentials'::regclass
       and conname = 'agent_credentials_project_scope'
  ) then
    alter table agent.agent_credentials
      add constraint agent_credentials_project_scope
      check (jsonb_array_length(project_ids) <= 100
             and (all_projects or jsonb_array_length(project_ids) >= 1));
  end if;

  -- Environment narrowing is only meaningful under an explicit project list.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'agent.agent_credentials'::regclass
       and conname = 'agent_credentials_scope_env'
  ) then
    alter table agent.agent_credentials
      add constraint agent_credentials_scope_env
      check (not all_projects or environment_ids is null);
  end if;
end
$$;

/* ---------------------------- agent_link_codes ----------------------------- */

alter table agent.agent_link_codes
  add column if not exists protocol_version    integer not null default 1,
  add column if not exists workspace_hint      text,
  add column if not exists workspace_name_hint text
    check (char_length(workspace_name_hint) <= 60);

/* ---------------------------- agent_operations ----------------------------- */

-- A workspace-level target has no project.
alter table agent.agent_operations alter column project_id drop not null;

/* --------------------------------- grants ---------------------------------- */

-- Repeated from 0006/0007 so this file is complete on its own. No new table is
-- created here, so nothing needs RLS enabling; the existing tables keep it.
grant usage on schema agent to service_role;
grant select, insert, update, delete on all tables in schema agent to service_role;
grant usage, select, update on all sequences in schema agent to service_role;
alter default privileges in schema agent grant select, insert, update, delete on tables to service_role;
alter default privileges in schema agent grant usage, select, update on sequences to service_role;

/* ------------------------------- seed version ------------------------------ */

-- 0006 records version 1, 0007 version 2; this file records version 3.
insert into agent.schema_migrations (version, name, applied_at) values
  (3, 'agent-workspace-scope-v1', '2026-01-01T00:00:00.000Z')
on conflict (version) do nothing;
