-- Keep the existing hook enabled. Google may establish identity for the
-- waitlist; all other new, unadmitted account creation remains blocked.
-- Deploy with ZENITH_WAITLIST_GATE_ENABLED=1 and keep the existing cutoff fixed.
-- No users, workspaces, memberships or admission records are changed here.

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

  -- Google establishes identity so the callback can prefill the waitlist.
  -- This is NOT product admission: the application checks the canonical user
  -- and admitted email before provisioning, invitations, pages or API access.
  -- app_metadata is supplied by Auth, never the caller's user_metadata.
  if candidate_email is not null and candidate_email <> ''
     and event -> 'user' -> 'app_metadata' ->> 'provider' = 'google' then
    return '{}'::jsonb;
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

-- Preserve the hook's invoker security and Auth-only execution boundary.
revoke all on function public.zenith_before_user_created(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.zenith_before_user_created(jsonb)
  to supabase_auth_admin;
notify pgrst, 'reload schema';
