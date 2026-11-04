/** Signed revocation receipts and installation fences; requires migration 9. */
export const migration0010GithubDeliveries = {
  version: 10,
  name: "github_deliveries",
  sql: `
-- Old callbacks have no signed-event fence. Integration must refuse their
-- OAuth transition/consumption until a new browser intent is authorized.
alter table platform.github_install_intents add column if not exists app_id text
  check (app_id ~ '^[1-9][0-9]{0,15}$');
alter table platform.github_install_intents add column if not exists installation_generation bigint
  check (installation_generation >= 0);
create table if not exists platform.github_webhook_installation_epochs (
  app_id text not null check (app_id ~ '^[1-9][0-9]{0,15}$'),
  installation_id bigint not null check (installation_id > 0),
  generation bigint not null default 0 check (generation >= 0),
  primary key (app_id, installation_id)
);
create table if not exists platform.github_webhook_deliveries (
  app_id text not null check (app_id ~ '^[1-9][0-9]{0,15}$'),
  delivery_id text not null check (delivery_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  body_sha256 text not null check (body_sha256 ~ '^[a-f0-9]{64}$'),
  event text not null,
  action text not null,
  installation_id bigint not null check (installation_id > 0),
  repository_ids bigint[] not null,
  revoked_count integer not null default 0 check (revoked_count >= 0),
  replayed boolean not null default false,
  received_at timestamptz not null default clock_timestamp(),
  primary key (app_id, delivery_id),
  check ((event = 'installation' and action in ('deleted', 'suspend') and cardinality(repository_ids) = 0)
    or (event = 'installation_repositories' and action = 'removed' and cardinality(repository_ids) between 1 and 1000)),
  check (0 < all(repository_ids))
);
-- Signed body replay may change the unsigned delivery GUID. The installation
-- epoch lock serializes digest checks; aliases retain their own durable receipt.
create index if not exists github_webhook_deliveries_body
  on platform.github_webhook_deliveries (app_id, body_sha256);
alter table platform.github_webhook_installation_epochs enable row level security;
alter table platform.github_webhook_deliveries enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table platform.github_webhook_installation_epochs, platform.github_webhook_deliveries from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update on table platform.github_webhook_installation_epochs, platform.github_webhook_deliveries to service_role;
  end if;
end
$$;
`,
} as const;
