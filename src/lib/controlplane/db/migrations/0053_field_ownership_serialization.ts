/**
 * Serialize the entire environment ownership graph with native dispatch.
 * Transaction locks work through a transaction pooler and cover absent rows.
 * Dispatch uses ordinary reads after the lock, not resource/transfer row locks:
 * an UPDATE owns its tuple before a BEFORE ROW trigger can acquire this lock.
 */
export const migration0053FieldOwnershipSerialization = {
  version: 53,
  name: "field_ownership_serialization",
  sql: `
create or replace function platform.serialize_field_ownership() returns trigger
language plpgsql set search_path=pg_catalog as $$
declare
  old_key bigint;
  new_key bigint;
begin
  -- INSERT foreign-key locks precede the environment coordinator, just as
  -- native admission takes its operation lock before that coordinator.
  if TG_TABLE_NAME='ownership_transfers' and TG_OP='INSERT' then
    perform id from platform.operations where workspace_id=new.workspace_id and id=new.operation_id for key share;
    if not found then raise exception 'Ownership transfer operation is unavailable' using errcode='23514'; end if;
    perform id from platform.approvals where workspace_id=new.workspace_id and id=new.approval_id for key share;
    if not found then raise exception 'Ownership transfer approval is unavailable' using errcode='23514'; end if;
  end if;
  if TG_OP<>'INSERT' then
    old_key:=hashtextextended('zenith:field-ownership:' || jsonb_build_array(old.workspace_id,old.environment_id)::text,0);
  end if;
  if TG_OP<>'DELETE' then
    new_key:=hashtextextended('zenith:field-ownership:' || jsonb_build_array(new.workspace_id,new.environment_id)::text,0);
  end if;
  -- A resource moved between environments locks both scopes in key order.
  -- A hash collision only causes extra serialization, never missing exclusion.
  perform pg_advisory_xact_lock(least(old_key,new_key));
  if old_key is not null and new_key is not null and old_key<>new_key then
    perform pg_advisory_xact_lock(greatest(old_key,new_key));
  end if;
  if TG_OP='DELETE' then return old; end if;
  return new;
end
$$;
create or replace trigger field_ownership_resource_serialization
before insert or delete or update of id,workspace_id,environment_id,address,kind,native_type,spec on platform.resources
for each row execute function platform.serialize_field_ownership();
create or replace trigger field_ownership_transfer_serialization
before insert or update or delete on platform.ownership_transfers
for each row execute function platform.serialize_field_ownership();
`,
} as const;
