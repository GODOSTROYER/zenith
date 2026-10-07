/**
 * Producer output records of mixed-graph parent plans (PROD-MIX follow-up: the producer output reader).
 *
 * One row per (parent plan, reference, producer receipt): the typed output a SUCCEEDED producer child exposed to a
 * consumer, as read back through the producing partition's own brokered observe session. The row holds digests and
 * provenance only: the value digest, the producing child's receipt digest and operation id, the resource address and
 * output name, the read source and when it was observed. For a secret it holds the vault reference and its version
 * digest, never a value. Rows are append-only (no update, no delete): a second read of the same receipt must produce the
 * same value digest (the unique key plus the application check), so a changed value is a NEW receipt and therefore a new
 * review, never a silent overwrite.
 */
export const migration0042MixedOutputRecords = {
  version: 42,
  name: "mixed_output_records",
  sql: `
create table if not exists platform.mixed_output_records (
  workspace_id            text        not null,
  plan_id                 text        not null,
  reference_id            text        not null check (char_length(reference_id) between 1 and 200),
  receipt_digest          text        not null check (receipt_digest ~ '^[a-f0-9]{64}$'),
  producer_partition_id   text        not null,
  consumer_partition_id   text        not null,
  producer_operation_id   text        not null,
  producer_address        text        not null check (char_length(producer_address) between 1 and 300),
  producer_output         text        not null check (char_length(producer_output) between 1 and 512),
  value_type              text        not null check (value_type in ('string','number','boolean','resource_id','endpoint','secret_ref')),
  value_digest            text        not null check (value_digest ~ '^[a-f0-9]{64}$'),
  secret_ref              text        check (secret_ref ~ '^vault:[A-Za-z0-9_-]{1,128}/[A-Za-z0-9_-]{1,128}/[A-Za-z0-9_-]{1,128}$'),
  secret_version_digest   text        check (secret_version_digest ~ '^[a-f0-9]{64}$'),
  source                  text        not null check (source in ('observation','tofu_output')),
  source_digest           text        not null check (source_digest ~ '^[a-f0-9]{64}$'),
  observed_at             timestamptz not null,
  recorded_at             timestamptz not null default clock_timestamp(),
  primary key (workspace_id, plan_id, reference_id, receipt_digest),
  foreign key (workspace_id, plan_id) references platform.mixed_parent_plans (workspace_id, plan_id),
  foreign key (workspace_id, plan_id, producer_partition_id) references platform.mixed_child_plans (workspace_id, plan_id, partition_id),
  foreign key (workspace_id, plan_id, consumer_partition_id) references platform.mixed_child_plans (workspace_id, plan_id, partition_id),
  check ((value_type = 'secret_ref') = (secret_ref is not null)),
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
