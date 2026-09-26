-- Workspace ownership and invitations are serialized on the workspace row.
-- The service-role API supplies the verified session identity; browser roles
-- cannot execute this function or bypass the existing deny-by-default RLS.

alter table public.workspaces add column if not exists owner_id text;
-- Equality on this indexed column handles mixed-case legacy addresses without
-- treating valid address characters (%, _, *) as pattern wildcards.
alter table public.members add column if not exists email_normalized text
  generated always as (lower(email)) stored;
create index if not exists members_email_normalized_idx on public.members (email_normalized);
alter table public.invites add column if not exists expires_at timestamptz;
alter table public.invites add column if not exists revoked_at timestamptz;

-- Existing real administrators keep control. The fallback matches the file
-- store's deterministic ownership rule, excluding seeded placeholder users.
update public.workspaces w
set owner_id = coalesce(
  (select m.id from public.members m
   where m.workspace_id = w.id and m.id = w.data->>'ownerId' and m.role = 'admin'
     and lower(btrim(m.email)) not in ('', 'you@local', 'you@kepler.dev')),
  (select m.id from public.members m
   where m.workspace_id = w.id and m.role = 'admin'
     and lower(btrim(m.email)) not in ('', 'you@local', 'you@kepler.dev')
   order by m.id limit 1)
)
where w.owner_id is null;

-- Old invitations were unbounded. Give their recipients one migration-time
-- grace week; every new invitation receives a fresh explicit seven-day expiry.
update public.invites set expires_at = now() + interval '7 days' where expires_at is null;
update public.invites set email = lower(btrim(email));
-- Preserve duplicate history while retaining just the newest pending offer.
with ranked as (
  select id, row_number() over (
    partition by workspace_id, lower(email) order by created_at desc nulls last, id desc
  ) as position
  from public.invites where accepted_at is null and revoked_at is null
)
update public.invites i set revoked_at = now()
from ranked r where i.id = r.id and r.position > 1;

create unique index if not exists workspace_invites_pending_email
  on public.invites (workspace_id, lower(email))
  where accepted_at is null and revoked_at is null;

create or replace function public.zenith_workspace_sharing(
  p_operation text,
  p_workspace_id text,
  p_actor_id text,
  p_actor_email text,
  p_actor_name text,
  p_member_id text default null,
  p_role text default null,
  p_invite_id text default null,
  p_email text default null,
  p_new_invite_id text default null
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_workspace public.workspaces%rowtype;
  v_actor public.members%rowtype;
  v_target public.members%rowtype;
  v_invite public.invites%rowtype;
  v_owner_id text;
  v_email text;
  v_now timestamptz := clock_timestamp();
  v_result jsonb := '{}'::jsonb;
begin
  if p_operation is null or p_operation not in (
    'change-role', 'remove-member', 'leave', 'transfer', 'invite', 'revoke', 'resend', 'accept'
  ) or nullif(p_actor_id, '') is null or nullif(p_actor_email, '') is null then
    raise exception using errcode = 'PT400', message = 'Invalid workspace sharing request.';
  end if;

  if p_workspace_id is null and p_invite_id is not null then
    select i.workspace_id into p_workspace_id from public.invites i where i.id = p_invite_id;
  end if;

  -- This is the common lock for every change, including acceptance. A request
  -- waiting behind a transfer re-reads the new owner and roles after the lock.
  select * into v_workspace from public.workspaces where id = p_workspace_id for update;
  if not found then
    raise exception using errcode = 'PT404', message = 'Workspace was not found.';
  end if;
  v_now := clock_timestamp();

  if v_workspace.owner_id is null then
    select m.id into v_owner_id from public.members m
    where m.workspace_id = p_workspace_id and m.role = 'admin'
      and lower(btrim(m.email)) not in ('', 'you@local', 'you@kepler.dev')
    order by m.id limit 1;
    if v_owner_id is not null then
      update public.workspaces set owner_id = v_owner_id, version = version + 1, updated_at = v_now
      where id = p_workspace_id returning * into v_workspace;
    end if;
  end if;

  select * into v_actor from public.members
  where workspace_id = p_workspace_id and id = p_actor_id;

  if p_operation <> 'accept' and v_actor.id is null then
    raise exception using errcode = 'PT403', message = 'You are not a member of this workspace.';
  end if;
  if p_operation not in ('accept', 'leave') and v_actor.role <> 'admin' then
    raise exception using errcode = 'PT403', message = 'Workspace administrator access is required.';
  end if;

  if p_operation in ('change-role', 'remove-member', 'leave', 'transfer') then
    if p_operation = 'leave' then p_member_id := p_actor_id; end if;
    select * into v_target from public.members
    where workspace_id = p_workspace_id and id = p_member_id for update;
    if not found then
      raise exception using errcode = 'PT404', message = 'Workspace member was not found.';
    end if;

    if p_operation = 'transfer' then
      if v_workspace.owner_id is distinct from p_actor_id then
        raise exception using errcode = 'PT403', message = 'Only the workspace owner can transfer ownership.';
      end if;
      if lower(btrim(v_target.email)) in ('', 'you@local', 'you@kepler.dev') then
        raise exception using errcode = 'PT400', message = 'Ownership requires a real workspace member.';
      end if;
      update public.members set role = 'admin', version = version + 1, updated_at = v_now
      where workspace_id = p_workspace_id and id = p_member_id returning * into v_target;
      update public.workspaces set owner_id = p_member_id, version = version + 1, updated_at = v_now
      where id = p_workspace_id returning * into v_workspace;
      v_result := jsonb_build_object('member', to_jsonb(v_target));
    else
      if p_operation = 'change-role' and (p_role is null or p_role not in ('admin', 'editor', 'viewer')) then
        raise exception using errcode = 'PT400', message = 'Choose admin, editor, or viewer access.';
      end if;
      if v_target.id = v_workspace.owner_id and (p_operation <> 'change-role' or p_role <> 'admin') then
        raise exception using errcode = 'PT409', message = 'Transfer ownership before removing or demoting the owner.';
      end if;
      if p_operation <> 'leave' and (v_target.role = 'admin' or p_role = 'admin')
        and v_workspace.owner_id is distinct from p_actor_id then
        raise exception using errcode = 'PT403', message = 'Only the workspace owner can manage administrators.';
      end if;
      if v_target.role = 'admin' and (p_operation <> 'change-role' or p_role <> 'admin')
        and not exists (select 1 from public.members
          where workspace_id = p_workspace_id and id <> v_target.id and role = 'admin') then
        raise exception using errcode = 'PT409', message = 'A workspace must retain an administrator.';
      end if;
      if p_operation = 'change-role' then
        update public.members set role = p_role, version = version + 1, updated_at = v_now
        where workspace_id = p_workspace_id and id = p_member_id returning * into v_target;
        v_result := jsonb_build_object('member', to_jsonb(v_target));
      else
        delete from public.members where workspace_id = p_workspace_id and id = p_member_id;
        -- A still-pending offer predating membership must not undo removal.
        update public.invites set revoked_at = v_now, version = version + 1, updated_at = v_now
        where workspace_id = p_workspace_id and lower(email) = lower(v_target.email)
          and accepted_at is null and revoked_at is null;
        v_result := jsonb_build_object('removed', to_jsonb(v_target));
      end if;
    end if;

  elsif p_operation = 'invite' then
    v_email := lower(btrim(p_email));
    if v_email is null or length(v_email) > 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      or p_role is null or p_role not in ('admin', 'editor', 'viewer')
      or nullif(p_new_invite_id, '') is null then
      raise exception using errcode = 'PT400', message = 'A valid email address and workspace role are required.';
    end if;
    if p_role = 'admin' and v_workspace.owner_id is distinct from p_actor_id then
      raise exception using errcode = 'PT403', message = 'Only the workspace owner can invite administrators.';
    end if;
    if exists (select 1 from public.members where workspace_id = p_workspace_id and lower(email) = v_email) then
      raise exception using errcode = 'PT409', message = 'This person is already a workspace member.';
    end if;
    update public.invites set revoked_at = v_now, version = version + 1, updated_at = v_now
    where workspace_id = p_workspace_id and lower(email) = v_email
      and accepted_at is null and revoked_at is null and expires_at <= v_now;
    if exists (select 1 from public.invites where workspace_id = p_workspace_id and lower(email) = v_email
      and accepted_at is null and revoked_at is null) then
      raise exception using errcode = 'PT409', message = 'A pending invitation already exists for this email.';
    end if;
    insert into public.invites (id, workspace_id, email, role, created_at, expires_at, data)
    values (p_new_invite_id, p_workspace_id, v_email, p_role, v_now, v_now + interval '7 days',
      jsonb_build_object('createdBy', p_actor_id)) returning * into v_invite;
    v_result := jsonb_build_object('invite', to_jsonb(v_invite));

  else
    select * into v_invite from public.invites
    where id = p_invite_id and workspace_id = p_workspace_id for update;
    if not found then
      raise exception using errcode = 'PT404', message = 'Workspace invitation was not found.';
    end if;
    if p_operation = 'accept' then
      if lower(v_invite.email) <> lower(btrim(p_actor_email)) then
        raise exception using errcode = 'PT403', message = 'Sign in with the email address this invitation names.';
      end if;
      if v_invite.revoked_at is not null then
        raise exception using errcode = 'PT410', message = 'This invitation has been revoked.';
      end if;
      if v_invite.accepted_at is not null then
        if v_actor.id is null then
          raise exception using errcode = 'PT410', message = 'This invitation has already been accepted.';
        end if;
        return jsonb_build_object('workspace', to_jsonb(v_workspace), 'member', to_jsonb(v_actor), 'invite', to_jsonb(v_invite));
      end if;
      if v_invite.expires_at is null or v_invite.expires_at <= v_now then
        raise exception using errcode = 'PT410', message = 'This invitation has expired. Ask an administrator to resend it.';
      end if;
      if v_invite.role not in ('admin', 'editor', 'viewer') then
        raise exception using errcode = 'PT409', message = 'This invitation has an invalid workspace role.';
      end if;
      -- An offer cannot promote an already-admitted user after their role was
      -- changed. The current member record always wins over the older offer.
      if v_actor.id is null then
        if exists (select 1 from public.members where workspace_id = p_workspace_id
          and lower(email) = lower(btrim(p_actor_email))) then
          raise exception using errcode = 'PT409', message = 'This email already belongs to a workspace member.';
        end if;
        insert into public.members (id, workspace_id, email, role, data)
        values (p_actor_id, p_workspace_id, lower(btrim(p_actor_email)), v_invite.role,
          jsonb_build_object('name', p_actor_name)) returning * into v_actor;
      end if;
      update public.invites set accepted_at = v_now, version = version + 1, updated_at = v_now
      where id = p_invite_id returning * into v_invite;
      v_result := jsonb_build_object('member', to_jsonb(v_actor), 'invite', to_jsonb(v_invite));
    else
      if v_invite.role = 'admin' and v_workspace.owner_id is distinct from p_actor_id then
        raise exception using errcode = 'PT403', message = 'Only the workspace owner can manage administrator invitations.';
      end if;
      if v_invite.accepted_at is not null then
        raise exception using errcode = 'PT409', message = 'This invitation has already been accepted.';
      end if;
      if p_operation = 'revoke' then
        update public.invites set revoked_at = coalesce(revoked_at, v_now), version = version + 1, updated_at = v_now
        where id = p_invite_id returning * into v_invite;
      else
        if v_invite.revoked_at is not null then
          raise exception using errcode = 'PT410', message = 'Create a new invitation instead of resending a revoked invitation.';
        end if;
        if exists (select 1 from public.members where workspace_id = p_workspace_id and lower(email) = lower(v_invite.email)) then
          raise exception using errcode = 'PT409', message = 'This person is already a workspace member.';
        end if;
        update public.invites set expires_at = v_now + interval '7 days', version = version + 1, updated_at = v_now
        where id = p_invite_id returning * into v_invite;
      end if;
      v_result := jsonb_build_object('invite', to_jsonb(v_invite));
    end if;
  end if;

  insert into public.audit_events (id, workspace_id, ts, actor_type, action_id, result, data)
  values (gen_random_uuid()::text, p_workspace_id, v_now, 'user', 'workspace.' || p_operation, 'ok',
    jsonb_build_object(
      'actor', jsonb_build_object('type', 'user', 'id', p_actor_id, 'name', p_actor_name),
      'input', jsonb_strip_nulls(jsonb_build_object('memberId', p_member_id,
        'inviteId', coalesce(v_invite.id, p_invite_id), 'role', p_role)),
      'summary', coalesce(p_actor_name, 'A member') || ' updated workspace access (' || p_operation || ').'
    ));

  -- Unlike snapshot notification writes, the mutation and this monotonic feed
  -- increment commit in the same transaction.
  insert into public.workspace_versions (workspace_id, version, touched_projects, updated_at)
  values (p_workspace_id, 1, '[]'::jsonb, v_now)
  on conflict (workspace_id) do update
    set version = public.workspace_versions.version + 1, touched_projects = '[]'::jsonb, updated_at = v_now;
  return v_result || jsonb_build_object('workspace', to_jsonb(v_workspace));
end;
$$;

revoke all on function public.zenith_workspace_sharing(text, text, text, text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.zenith_workspace_sharing(text, text, text, text, text, text, text, text, text, text)
  to service_role;
