-- Optional waitlist profile answers; retains every entry, position and admission.
-- Apply after 0009 and before deploying the expanded public intake.
-- The original join RPC remains available for older application instances.
alter table public.waitlist_entries
  add column if not exists name text not null default '',
  add column if not exists features jsonb not null default '[]'::jsonb;

alter table public.waitlist_entries
  drop constraint if exists waitlist_entries_occupation_check,
  drop constraint if exists waitlist_entries_use_case_check;
alter table public.waitlist_entries
  add constraint waitlist_entries_occupation_check check (length(btrim(occupation)) <= 120),
  add constraint waitlist_entries_use_case_check check (length(btrim(use_case)) <= 2000);

-- Validates JSON item types and lengths without weakening the table boundary.
create or replace function public.zenith_waitlist_features_valid(p_features jsonb)
returns boolean language plpgsql immutable security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_features is null or jsonb_typeof(p_features) <> 'array' then return false; end if;
  if jsonb_array_length(p_features) > 12 then return false; end if;
  return not exists (
    select 1 from jsonb_array_elements(p_features) as item(value)
    where jsonb_typeof(value) <> 'string'
      or length(btrim(value #>> '{}')) not between 1 and 120
  );
end;
$$;

alter table public.waitlist_entries
  drop constraint if exists waitlist_entries_name_check,
  drop constraint if exists waitlist_entries_features_check;
alter table public.waitlist_entries
  add constraint waitlist_entries_name_check check (length(btrim(name)) <= 120),
  add constraint waitlist_entries_features_check check (public.zenith_waitlist_features_valid(features));

create or replace function public.zenith_waitlist_join_profile(
  p_email text, p_name text default '', p_occupation text default '',
  p_features jsonb default '[]'::jsonb, p_use_case text default ''
) returns void
language plpgsql security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(20260926, 9);
  insert into public.waitlist_entries (email, name, occupation, features, use_case)
  values (lower(btrim(p_email)), btrim(p_name), btrim(p_occupation), p_features, btrim(p_use_case))
  on conflict (email) do nothing;
end;
$$;

revoke all on function public.zenith_waitlist_features_valid(jsonb),
  public.zenith_waitlist_join_profile(text, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.zenith_waitlist_features_valid(jsonb),
  public.zenith_waitlist_join_profile(text, text, text, jsonb, text)
  to service_role;

notify pgrst, 'reload schema';
