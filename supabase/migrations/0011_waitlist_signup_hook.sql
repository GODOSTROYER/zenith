-- Install the hook before enabling it in Supabase Auth configuration.
-- Applying this migration alone does not change account creation behavior.
-- It checks NEW users only: existing accounts and sessions remain untouched.

create or replace function public.zenith_before_user_created(event jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  candidate_email text;
begin
  -- Use Auth's user.email, never user_metadata, claimed creation time or role.
  -- Every call is a proposed NEW user; grandfathering happens only when the
  -- application later checks an existing canonical auth.users record.
  if jsonb_typeof(event -> 'user' -> 'email') = 'string' then
    candidate_email := lower(btrim(event -> 'user' ->> 'email'));
  end if;

  if candidate_email is not null and candidate_email <> '' and exists (
    select 1 from public.waitlist_entries
    where email = candidate_email and status = 'admitted'
  ) then
    return '{}'::jsonb;
  end if;

  -- This stable marker lets the application display the waitlist route.
  -- Queued and absent addresses receive exactly the same public error.
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'ZENITH_WAITLIST_REQUIRED: Join the Zenith waitlist before signing in.'
  ));
end;
$$;

-- Auth can read only the columns required by the admission decision. The
-- policy exposes admitted rows only; profile answers and queued emails remain
-- unavailable to this role. Browser and service-role API callers cannot invoke
-- the hook. Keep it SECURITY INVOKER instead of granting postgres privileges.
grant usage on schema public to supabase_auth_admin;
grant select (email, status) on public.waitlist_entries to supabase_auth_admin;
drop policy if exists waitlist_auth_read_admitted on public.waitlist_entries;
create policy waitlist_auth_read_admitted on public.waitlist_entries
  for select to supabase_auth_admin using (status = 'admitted');

revoke all on function public.zenith_before_user_created(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.zenith_before_user_created(jsonb)
  to supabase_auth_admin;

notify pgrst, 'reload schema';
