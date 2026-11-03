/**
 * Native postgres.js JSONB parameters used to encode serialized JSON a second
 * time. Recover only that known encoding, without guessing missing budget data
 * or touching immutable source/approval records. Invalid legacy rows stop the
 * migration atomically and must be repaired from authoritative evidence.
 *
 * This is a contract migration: older writers produce values rejected by the
 * validated guards. Drain them before explicitly admitting version 62.
 */
export const migration0062CodingAgentJsonbShapes = {
  version: 62,
  name: "coding_agent_jsonb_shapes",
  sql: `
do $coding_agent_jsonb_shapes$
declare
  existing record;
  repaired jsonb;
  candidate jsonb;
  field text;
  spend numeric;
  changed boolean;
begin
  -- Cumulative Supabase snapshots replay historical DDL. The validated guards
  -- prevent recurrence, so a recorded repair must not relock/rescan every run.
  if exists(select 1 from platform.schema_migrations where version=62) then return; end if;
  for existing in select id,source,limits,usage,checkpoint,result from platform.coding_agent_runs for update loop
    repaired := jsonb_build_object('source',existing.source,'limits',existing.limits,'usage',existing.usage,'checkpoint',existing.checkpoint,'result',existing.result);
    changed := false;
    foreach field in array array['source','limits','usage','checkpoint','result'] loop
      if field='result' and existing.result is null then continue; end if;
      candidate := repaired->field;
      if jsonb_typeof(candidate)='string' then
        begin
          candidate := (candidate #>> '{}')::jsonb;
        exception when invalid_text_representation then
          raise exception using errcode='23514', constraint='coding_agent_runs_jsonb_objects_check', message=format('Coding-agent runs contain malformed legacy %s JSON; repair retained records before retrying migration 62.',field);
        end;
        changed := true;
      end if;
      if jsonb_typeof(candidate) is distinct from 'object' then
        raise exception using errcode='23514', constraint='coding_agent_runs_jsonb_objects_check', message=format('Coding-agent runs require an object for %s; migration 62 will not discard or invent retained data.',field);
      end if;
      repaired := jsonb_set(repaired,array[field],candidate);
    end loop;
    foreach field in array array['limits','usage'] loop
      candidate := repaired->field->'spendMicroUsd';
      if jsonb_typeof(candidate) is distinct from 'number' then
        raise exception using errcode='23514', constraint='coding_agent_runs_spend_metadata_check', message=format('Coding-agent runs contain missing or invalid %s.spendMicroUsd; migration 62 will not assume a zero budget.',field);
      end if;
      spend := (candidate #>> '{}')::numeric;
      if spend<0 or spend>9007199254740991 or spend<>trunc(spend) then
        raise exception using errcode='23514', constraint='coding_agent_runs_spend_metadata_check', message=format('Coding-agent runs require nonnegative safe integer %s.spendMicroUsd before migration 62.',field);
      end if;
    end loop;
    if changed then
      update platform.coding_agent_runs set
        source=repaired->'source',limits=repaired->'limits',usage=repaired->'usage',checkpoint=repaired->'checkpoint',
        result=case when existing.result is null then null else repaired->'result' end
      where id=existing.id;
    end if;
  end loop;
  if not exists(select 1 from pg_constraint where conrelid='platform.coding_agent_runs'::regclass and conname='coding_agent_runs_jsonb_objects_check') then
    alter table platform.coding_agent_runs add constraint coding_agent_runs_jsonb_objects_check check (
      jsonb_typeof(source)='object' and jsonb_typeof(limits)='object' and jsonb_typeof(usage)='object' and jsonb_typeof(checkpoint)='object'
      and (result is null or jsonb_typeof(result)='object')
    );
  end if;
  if not exists(select 1 from pg_constraint where conrelid='platform.coding_agent_runs'::regclass and conname='coding_agent_runs_spend_metadata_check') then
    alter table platform.coding_agent_runs add constraint coding_agent_runs_spend_metadata_check check (
      case when jsonb_typeof(limits->'spendMicroUsd')='number' then
        (limits->>'spendMicroUsd')::numeric between 0 and 9007199254740991
        and (limits->>'spendMicroUsd')::numeric=trunc((limits->>'spendMicroUsd')::numeric)
      else false end
      and case when jsonb_typeof(usage->'spendMicroUsd')='number' then
        (usage->>'spendMicroUsd')::numeric between 0 and 9007199254740991
        and (usage->>'spendMicroUsd')::numeric=trunc((usage->>'spendMicroUsd')::numeric)
      else false end
    );
  end if;
end
$coding_agent_jsonb_shapes$;
`,
} as const;
