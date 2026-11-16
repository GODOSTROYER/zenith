/**
 * Producer output records of mixed-graph parent plans (PROD-MIX follow-up).
 *
 * One row per (parent plan, reference): the typed output the producing child exposed to a consumer, captured by the producer's own
 * apply activity while its broker grant was live (`tofu output -json`), or read back from the producer's own observation. The
 * row holds provenance (producing child operation, resource address, output name, source, source digest, observation time),
 * the value digest and, for a NON-SECRET output, the value itself in `value` (stored as {"v": <string|number|boolean>}, bounded). For a
 * secret it holds only the vault reference and its version digest and NO value: the check constraints make a secret row with a
 * value, or a plain row without one, impossible. Rows are append-only (no update, no delete): a re-capture of the same reference
 * must carry the same value digest, so a changed value is a new plan and therefore a new review, never a silent overwrite.
 */
export const migration0044MixedOutputRecords = {
  version: 44,
  name: "mixed_output_records",
  sql: `
create table if not exists platform.mixed_output_records (
  workspace_id            text        not null,
  plan_id                 text        not null,
  reference_id            text        not null check (char_length(reference_id) between 1 and 200),
  producer_partition_id   text        not null,
  consumer_partition_id   text        not null,
  producer_operation_id   text        not null,
  producer_address        text        not null check (char_length(producer_address) between 1 and 300),
  producer_output         text        not null check (char_length(producer_output) between 1 and 512),
  value_type              text        not null check (value_type in ('string','number','boolean','resource_id','endpoint','secret_ref')),
  value_digest            text        not null check (value_digest ~ '^[a-f0-9]{64}$'),
  value                   jsonb       check (value is null or (jsonb_typeof(value) = 'object' and coalesce(jsonb_typeof(value->'v') in ('string','number','boolean'), false) and octet_length(value::text) <= 4096)),
  secret_ref              text        check (secret_ref ~ '^vault:[A-Za-z0-9_-]{1,128}/[A-Za-z0-9_-]{1,128}/[A-Za-z0-9_-]{1,128}$'),
  secret_version_digest   text        check (secret_version_digest ~ '^[a-f0-9]{64}$'),
  source                  text        not null check (source in ('observation','tofu_output')),
  source_digest           text        not null check (source_digest ~ '^[a-f0-9]{64}$'),
  observed_at             timestamptz not null,
  recorded_at             timestamptz not null default clock_timestamp(),
  primary key (workspace_id, plan_id, reference_id),
  foreign key (workspace_id, plan_id) references platform.mixed_parent_plans (workspace_id, plan_id),
  foreign key (workspace_id, plan_id, producer_partition_id) references platform.mixed_child_plans (workspace_id, plan_id, partition_id),
  foreign key (workspace_id, plan_id, consumer_partition_id) references platform.mixed_child_plans (workspace_id, plan_id, partition_id),
  check ((value_type = 'secret_ref') = (secret_ref is not null)),
  check ((value_type = 'secret_ref') = (value is null)),
  check ((secret_ref is null) = (secret_version_digest is null))
);
create index if not exists mixed_output_records_plan on platform.mixed_output_records (workspace_id, plan_id, recorded_at);

create or replace function platform.mixed_output_records_immutable() returns trigger language plpgsql as $$
begin
  raise exception using errcode = '23514', message = 'Mixed output records are append-only';
end $$;
drop trigger if exists mixed_output_records_immutable on platform.mixed_output_records;
create trigger mixed_output_records_immutable before update or delete on platform.mixed_output_records
  for each row execute function platform.mixed_output_records_immutable();

alter table platform.mixed_output_records enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.mixed_output_records from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.mixed_output_records from service_role;
    grant select,insert on table platform.mixed_output_records to service_role;
  end if;
end
$$;
`,
} as const;
