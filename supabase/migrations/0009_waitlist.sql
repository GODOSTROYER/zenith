-- Independent waitlist storage, accessed through the existing Supabase admin
-- client. These public-schema RPCs are executable only by service_role. RLS and
-- explicit ACLs also deny direct table/sequence access to browser identities.
-- Apply before enabling the waitlist on a Postgres-backed installation.

create table if not exists public.waitlist_entries (
  id uuid primary key default gen_random_uuid(),
  email text not null unique
    check (email = lower(btrim(email)) and length(email) between 3 and 254
      and email !~ '[[:space:]]' and email ~ '^[^@]+@[^@]+\.[^@]+$'),
  occupation text not null check (length(btrim(occupation)) between 1 and 120),
  use_case text not null check (length(btrim(use_case)) between 1 and 2000),
  position bigint generated always as identity unique not null
    check (position between 1 and 9007199254740991),
  status text not null default 'queued' check (status in ('queued', 'admitted')),
  created_at timestamptz not null default clock_timestamp(),
  admitted_at timestamptz,
  admitted_by text,
  check (
    (status = 'queued' and admitted_at is null and admitted_by is null)
    or (status = 'admitted' and admitted_at is not null and admitted_by is not null)
  )
);

create index if not exists waitlist_entries_status_position
  on public.waitlist_entries (status, position);

-- Persist the exact response, including empty batches, so retries cannot admit
-- more people after a lost response. Never expire successful idempotency keys.
create table if not exists public.waitlist_admission_batches (
  request_id text primary key check (length(request_id) between 1 and 128),
  requested_count integer not null check (requested_count between 1 and 1000),
  actor_id text not null check (length(actor_id) between 1 and 200),
  entries jsonb not null check (jsonb_typeof(entries) = 'array'),
  created_at timestamptz not null default clock_timestamp()
);

create table if not exists public.waitlist_rate_limits (
  key text primary key check (length(key) between 1 and 256),
  hits integer not null check (hits > 0),
  expires_at timestamptz not null
);

create index if not exists waitlist_rate_limits_expiry
  on public.waitlist_rate_limits (expires_at);

alter table public.waitlist_entries enable row level security;
alter table public.waitlist_admission_batches enable row level security;
alter table public.waitlist_rate_limits enable row level security;

revoke all on table public.waitlist_entries, public.waitlist_admission_batches,
  public.waitlist_rate_limits from public, anon, authenticated;
revoke all on sequence public.waitlist_entries_position_seq from public, anon, authenticated;
grant select, insert, update, delete on table public.waitlist_entries,
  public.waitlist_admission_batches, public.waitlist_rate_limits to service_role;
grant usage, select on sequence public.waitlist_entries_position_seq to service_role;

create or replace function public.zenith_waitlist_join(
  p_email text, p_occupation text, p_use_case text
) returns void
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  -- Assign identity positions under the same lock as admission. A transaction
  -- cannot reserve an earlier sequence value and commit after a later join.
  perform pg_advisory_xact_lock(20260926, 9);
  insert into public.waitlist_entries (email, occupation, use_case)
  values (lower(btrim(p_email)), btrim(p_occupation), btrim(p_use_case))
  on conflict (email) do nothing;
end;
$$;

create or replace function public.zenith_waitlist_list(
  p_status text default null, p_after bigint default 0, p_limit integer default 50
) returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 200
     or p_after is null or p_after < 0 or p_after > 9007199254740991
     or (p_status is not null and p_status not in ('queued', 'admitted')) then
    raise exception using errcode = '22023', message = 'Invalid waitlist page.';
  end if;

  -- One statement gives both the bounded page and counts the same snapshot.
  return (
    with candidates as materialized (
      select e.* from public.waitlist_entries e
      where e.position > p_after and (p_status is null or e.status = p_status)
      order by e.position limit p_limit + 1
    ), page as (
      select * from candidates order by position limit p_limit
    ), totals as (
      select count(*) as total,
        count(*) filter (where status = 'queued') as queued,
        count(*) filter (where status = 'admitted') as admitted
      from public.waitlist_entries
    )
    select jsonb_build_object(
      'entries', (select coalesce(jsonb_agg(to_jsonb(p) order by p.position), '[]'::jsonb) from page p),
      'total', totals.total,
      'queued', totals.queued,
      'admitted', totals.admitted,
      'nextCursor', case when (select count(*) from candidates) > p_limit
        then (select max(position) from page) else null end
    ) from totals
  );
end;
$$;

create or replace function public.zenith_waitlist_admit(
  p_count integer, p_actor_id text, p_request_id text
) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  previous public.waitlist_admission_batches%rowtype;
  result jsonb;
  admitted_time timestamptz;
begin
  if p_count is null or p_count < 1 or p_count > 1000
     or p_actor_id is null or length(p_actor_id) not between 1 and 200
     or p_request_id is null or length(p_request_id) not between 1 and 128 then
    raise exception using errcode = '22023', message = 'Invalid waitlist admission request.';
  end if;

  -- Global serialization is intentional: concurrent batches always take the
  -- oldest queued positions, without SKIP LOCKED admitting later people first.
  perform pg_advisory_xact_lock(20260926, 9);
  select * into previous from public.waitlist_admission_batches
    where request_id = p_request_id;
  if found then
    if previous.requested_count <> p_count or previous.actor_id <> p_actor_id then
      raise exception using errcode = 'ZW409', message = 'Waitlist request ID was already used for another admission.';
    end if;
    return previous.entries;
  end if;

  admitted_time := clock_timestamp();
  with candidates as (
    select id from public.waitlist_entries
    where status = 'queued' order by position limit p_count for update
  ), updated as (
    update public.waitlist_entries e
    set status = 'admitted', admitted_at = admitted_time, admitted_by = p_actor_id
    where e.id in (select id from candidates)
    returning e.*
  )
  select coalesce(jsonb_agg(to_jsonb(u) order by u.position), '[]'::jsonb)
    into result from updated u;

  insert into public.waitlist_admission_batches (request_id, requested_count, actor_id, entries)
    values (p_request_id, p_count, p_actor_id, result);
  return result;
end;
$$;

create or replace function public.zenith_waitlist_admitted(p_email text)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $$
  select exists (
    select 1 from public.waitlist_entries
    where email = lower(btrim(p_email)) and status = 'admitted'
  );
$$;

create or replace function public.zenith_waitlist_rate_limit(
  p_key text, p_limit integer, p_window_seconds integer
) returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  checked_at timestamptz := clock_timestamp();
  window_expires timestamptz;
  new_hits integer;
  allowed boolean;
begin
  if p_key is null or length(p_key) not between 1 and 256
     or p_limit is null or p_limit not between 1 and 1000000
     or p_window_seconds is null or p_window_seconds not between 1 and 86400 then
    raise exception using errcode = '22023', message = 'Invalid waitlist rate limit.';
  end if;
  window_expires := to_timestamp(
    (floor(extract(epoch from checked_at) / p_window_seconds) + 1) * p_window_seconds
  );

  insert into public.waitlist_rate_limits as r (key, hits, expires_at)
  values (p_key, 1, window_expires)
  on conflict (key) do update set
    hits = case when r.expires_at <= checked_at then 1 else r.hits + 1 end,
    expires_at = case when r.expires_at <= checked_at then window_expires else r.expires_at end
  where r.expires_at <= checked_at or r.hits < p_limit
  returning hits into new_hits;
  allowed := found;

  -- Acquire the caller's key before cleanup; otherwise parallel requests could
  -- delete one another's expired keys and then deadlock while inserting them.
  -- Cleanup itself is bounded and skips locks held by other intake requests.
  delete from public.waitlist_rate_limits
  where key in (
    select key from public.waitlist_rate_limits
    where expires_at <= checked_at
    order by expires_at limit 100 for update skip locked
  );
  return allowed;
end;
$$;

-- Revoke named roles as well as PUBLIC: Supabase projects can configure default
-- privileges that grant functions or tables directly to browser identities.
revoke all on function public.zenith_waitlist_join(text, text, text),
  public.zenith_waitlist_list(text, bigint, integer),
  public.zenith_waitlist_admit(integer, text, text),
  public.zenith_waitlist_admitted(text),
  public.zenith_waitlist_rate_limit(text, integer, integer)
  from public, anon, authenticated;

grant execute on function public.zenith_waitlist_join(text, text, text),
  public.zenith_waitlist_list(text, bigint, integer),
  public.zenith_waitlist_admit(integer, text, text),
  public.zenith_waitlist_admitted(text),
  public.zenith_waitlist_rate_limit(text, integer, integer)
  to service_role;

notify pgrst, 'reload schema';
