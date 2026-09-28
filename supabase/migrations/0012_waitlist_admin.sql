-- Exact-ID operator previews and an immutable admission audit. Apply after 0011.
-- All queue mutations and snapshots share the original FIFO advisory lock.
create table if not exists public.waitlist_admission_previews (
  id uuid primary key default gen_random_uuid(),
  actor_id text not null check (length(actor_id) between 1 and 200),
  mode text not null check (mode in ('selected', 'next', 'all')),
  entry_ids uuid[] not null,
  entry_count integer not null check (entry_count >= 0 and entry_count = cardinality(entry_ids)),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null
);

alter table public.waitlist_admission_batches
  drop constraint if exists waitlist_admission_batches_requested_count_check;
alter table public.waitlist_admission_batches
  add constraint waitlist_admission_batches_requested_count_check check (requested_count >= 0),
  add column if not exists preview_id uuid references public.waitlist_admission_previews(id),
  add column if not exists mode text not null default 'next' check (mode in ('selected', 'next', 'all'));
-- A preview is consumed even when another admission has already emptied it.
create unique index if not exists waitlist_admission_batches_preview_id
  on public.waitlist_admission_batches (preview_id) where preview_id is not null;
create index if not exists waitlist_admission_batches_created_at
  on public.waitlist_admission_batches (created_at desc, request_id desc);

alter table public.waitlist_admission_previews enable row level security;
revoke all on table public.waitlist_admission_previews from public, anon, authenticated, supabase_auth_admin;
grant select, insert, update, delete on table public.waitlist_admission_previews to service_role;

create or replace function public.zenith_waitlist_preview(
  p_mode text, p_actor_id text, p_count integer default null, p_entry_ids uuid[] default null
) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  captured_ids uuid[];
  snapshot public.waitlist_admission_previews%rowtype;
  result_entries jsonb;
  captured_at timestamptz;
begin
  if p_mode is null or p_mode not in ('selected', 'next', 'all')
     or p_actor_id is null or length(p_actor_id) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'Invalid waitlist preview request.';
  end if;
  if (p_mode = 'next' and (p_count is null or p_count not between 1 and 1000 or p_entry_ids is not null))
     or (p_mode = 'all' and (p_count is not null or p_entry_ids is not null))
     or (p_mode = 'selected' and (p_count is not null or p_entry_ids is null
       or cardinality(p_entry_ids) not between 1 and 1000 or array_ndims(p_entry_ids) <> 1)) then
    raise exception using errcode = '22023', message = 'Invalid waitlist preview selection.';
  end if;
  if p_mode = 'selected' and (
    select count(distinct selected.id) from unnest(p_entry_ids) as selected(id)
  ) <> cardinality(p_entry_ids) then
    raise exception using errcode = '22023', message = 'Selected waitlist IDs must be unique and non-null.';
  end if;

  perform pg_advisory_xact_lock(20260926, 9);
  if p_mode = 'selected' and exists (
    select 1 from unnest(p_entry_ids) as selected(id)
    where not exists (select 1 from public.waitlist_entries e where e.id = selected.id)
  ) then
    raise exception using errcode = '22023', message = 'A selected waitlist entry does not exist.';
  end if;

  select coalesce(array_agg(candidate.id order by candidate.position), '{}'::uuid[])
  into captured_ids from (
    select e.id, e.position from public.waitlist_entries e
    where e.status = 'queued' and (p_mode <> 'selected' or e.id = any(p_entry_ids))
    order by e.position limit case when p_mode = 'next' then p_count else null end
  ) candidate;

  captured_at := clock_timestamp();
  insert into public.waitlist_admission_previews (actor_id, mode, entry_ids, entry_count, created_at, expires_at)
  values (p_actor_id, p_mode, captured_ids, cardinality(captured_ids), captured_at, captured_at + interval '24 hours')
  returning * into snapshot;

  select coalesce(jsonb_agg(to_jsonb(entry) order by entry.position), '[]'::jsonb)
  into result_entries from (
    select e.* from public.waitlist_entries e where e.id = any(captured_ids)
    order by e.position limit 100
  ) entry;
  return jsonb_build_object('id', snapshot.id, 'mode', snapshot.mode,
    'count', snapshot.entry_count, 'entries', result_entries,
    'createdAt', snapshot.created_at, 'expiresAt', snapshot.expires_at);
end;
$$;

create or replace function public.zenith_waitlist_admit_preview(
  p_preview_id uuid, p_actor_id text, p_request_id text
) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  previous public.waitlist_admission_batches%rowtype;
  snapshot public.waitlist_admission_previews%rowtype;
  result jsonb;
  admitted_time timestamptz;
begin
  if p_preview_id is null or p_actor_id is null or length(p_actor_id) not between 1 and 200
     or p_request_id is null or length(p_request_id) not between 1 and 128 then
    raise exception using errcode = '22023', message = 'Invalid waitlist admission request.';
  end if;
  perform pg_advisory_xact_lock(20260926, 9);
  select * into previous from public.waitlist_admission_batches where request_id = p_request_id;
  if found then
    if previous.preview_id is distinct from p_preview_id or previous.actor_id <> p_actor_id then
      raise exception using errcode = 'ZW409', message = 'Waitlist request ID was already used for another admission.';
    end if;
    -- A completed request remains replayable after its preview expires.
    return jsonb_build_object('count', jsonb_array_length(previous.entries), 'requestId', p_request_id);
  end if;

  select * into snapshot from public.waitlist_admission_previews where id = p_preview_id;
  if not found or snapshot.actor_id <> p_actor_id then
    raise exception using errcode = 'ZW409', message = 'Waitlist preview is unavailable for this operator.';
  end if;
  if exists (select 1 from public.waitlist_admission_batches where preview_id = p_preview_id) then
    raise exception using errcode = 'ZW409', message = 'Waitlist preview has already been applied.';
  end if;
  if snapshot.expires_at <= clock_timestamp() then
    raise exception using errcode = 'ZW410', message = 'Waitlist preview has expired. Create a new preview.';
  end if;

  admitted_time := clock_timestamp();
  with updated as (
    update public.waitlist_entries e
    set status = 'admitted', admitted_at = admitted_time, admitted_by = p_actor_id
    where e.id = any(snapshot.entry_ids) and e.status = 'queued'
    returning e.*
  )
  select coalesce(jsonb_agg(to_jsonb(u) order by u.position), '[]'::jsonb) into result from updated u;

  insert into public.waitlist_admission_batches (request_id, requested_count, actor_id, entries, preview_id, mode)
  values (p_request_id, snapshot.entry_count, p_actor_id, result, snapshot.id, snapshot.mode);
  -- Keep unbounded profile data in the audit table, never in the response.
  return jsonb_build_object('count', jsonb_array_length(result), 'requestId', p_request_id);
end;
$$;

-- Retain the legacy FIFO contract, but never replay a preview admission through
-- the old RPC even if its count and actor happen to match.
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
  perform pg_advisory_xact_lock(20260926, 9);
  select * into previous from public.waitlist_admission_batches where request_id = p_request_id;
  if found then
    if previous.preview_id is not null or previous.mode <> 'next'
       or previous.requested_count <> p_count or previous.actor_id <> p_actor_id then
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
  select coalesce(jsonb_agg(to_jsonb(u) order by u.position), '[]'::jsonb) into result from updated u;

  insert into public.waitlist_admission_batches (request_id, requested_count, actor_id, entries)
  values (p_request_id, p_count, p_actor_id, result);
  return result;
end;
$$;

create or replace function public.zenith_waitlist_history(p_limit integer default 50)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Invalid waitlist history limit.';
  end if;
  return jsonb_build_object('batches', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'requestId', batch.request_id, 'actorId', batch.actor_id,
      'requestedCount', batch.requested_count, 'admittedCount', jsonb_array_length(batch.entries),
      'createdAt', batch.created_at, 'mode', batch.mode
    ) order by batch.created_at desc, batch.request_id desc), '[]'::jsonb)
    from (select * from public.waitlist_admission_batches
      order by created_at desc, request_id desc limit p_limit) batch
  ));
end;
$$;

-- Remove the former unbounded overload when applying this migration again.
drop function if exists public.zenith_waitlist_history_detail(text);

-- Slice saved rows before returning them. Profiles remain immutable in the audit
-- even if a source entry changes afterward; response size stays bounded.
create or replace function public.zenith_waitlist_history_detail(
  p_request_id text, p_offset integer default 0, p_limit integer default 100
) returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  batch public.waitlist_admission_batches%rowtype;
  total_count integer;
  page_entries jsonb;
begin
  if p_request_id is null or length(p_request_id) not between 1 and 128
     or p_offset is null or p_offset < 0
     or p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Invalid waitlist history request.';
  end if;
  select * into batch from public.waitlist_admission_batches where request_id = p_request_id;
  if not found then return null; end if;
  total_count := jsonb_array_length(batch.entries);
  select coalesce(jsonb_agg(batch.entries -> item.idx::integer order by item.idx), '[]'::jsonb)
  into page_entries
  from generate_series(p_offset::bigint,
    least(total_count::bigint - 1, p_offset::bigint + p_limit - 1)) as item(idx);
  return jsonb_build_object('batch', jsonb_build_object(
    'requestId', batch.request_id, 'actorId', batch.actor_id,
    'requestedCount', batch.requested_count, 'admittedCount', total_count,
    'createdAt', batch.created_at, 'mode', batch.mode
  ), 'entries', page_entries,
    'nextOffset', case when p_offset::bigint + p_limit < total_count
      then p_offset::bigint + p_limit else null end);
end;
$$;

create or replace function public.zenith_waitlist_list_filtered(
  p_status text default null, p_after bigint default 0,
  p_limit integer default 100, p_query text default ''
) returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  query text := lower(btrim(p_query));
begin
  if p_limit is null or p_limit not between 1 and 200
     or p_after is null or p_after < 0 or p_after > 9007199254740991
     or (p_status is not null and p_status not in ('queued', 'admitted'))
     or p_query is null or length(query) > 254 then
    raise exception using errcode = '22023', message = 'Invalid waitlist page.';
  end if;
  return (
    with filtered as materialized (
      select e.* from public.waitlist_entries e
      where (p_status is null or e.status = p_status) and (
        query = '' or strpos(lower(e.email), query) > 0 or strpos(lower(e.name), query) > 0
        or strpos(lower(e.occupation), query) > 0 or strpos(lower(e.use_case), query) > 0
        or exists (select 1 from jsonb_array_elements_text(e.features) as feature(value)
          where strpos(lower(feature.value), query) > 0)
      )
    ), candidates as materialized (
      select * from filtered where position > p_after order by position limit p_limit + 1
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
      'total', totals.total, 'queued', totals.queued, 'admitted', totals.admitted,
      'matched', (select count(*) from filtered),
      'nextCursor', case when (select count(*) from candidates) > p_limit
        then (select max(position) from page) else null end
    ) from totals
  );
end;
$$;

revoke all on function public.zenith_waitlist_preview(text, text, integer, uuid[]),
  public.zenith_waitlist_admit_preview(uuid, text, text),
  public.zenith_waitlist_admit(integer, text, text),
  public.zenith_waitlist_history(integer),
  public.zenith_waitlist_history_detail(text, integer, integer),
  public.zenith_waitlist_list_filtered(text, bigint, integer, text)
  from public, anon, authenticated, supabase_auth_admin;
grant execute on function public.zenith_waitlist_preview(text, text, integer, uuid[]),
  public.zenith_waitlist_admit_preview(uuid, text, text),
  public.zenith_waitlist_admit(integer, text, text),
  public.zenith_waitlist_history(integer),
  public.zenith_waitlist_history_detail(text, integer, integer),
  public.zenith_waitlist_list_filtered(text, bigint, integer, text)
  to service_role;

notify pgrst, 'reload schema';
