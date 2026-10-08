/**
 * Managed serving records (PROD-MAN-02 / PROD-MAN-03).
 *
 *   managed_domains       a tenant's claim over a custom hostname for the Zenith-managed platform, with the DNS TXT challenge
 *                         (stored only as a SHA-256 of the exact TXT value, never the token), the proof state and its renewal
 *                         clock. A verified hostname is globally unique: two workspaces can never both serve one host.
 *   managed_storage_keys  one row per scoped object-storage credential issued for an environment's object store. Only
 *                         non-secret facts live here (principal name, access key id, the bucket prefix it is confined to and
 *                         the vault reference its secret was written under); the secret itself is only ever in the vault.
 *
 * Both tables are tenant-owned (workspace_id on every row, every repository statement filters on it) with RLS on and no
 * policies; the service role is the only grantee.
 */
export const migration0050ManagedServing = {
  version: 50,
  name: "managed_serving",
  sql: `
create table if not exists platform.managed_domains (
  id                  text        not null primary key,
  workspace_id        text        not null check (char_length(workspace_id) between 1 and 128),
  environment_id      text        not null check (char_length(environment_id) between 1 and 128),
  hostname            text        not null check (hostname ~ '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])$'),
  status              text        not null default 'pending' check (status in ('pending','verified','lapsed','revoked')),
  challenge_hash      text        not null check (challenge_hash ~ '^[0-9a-f]{64}$'),
  challenge_issued_at timestamptz not null default clock_timestamp(),
  verified_at         timestamptz,
  expires_at          timestamptz,
  last_checked_at     timestamptz,
  last_outcome        text        check (last_outcome is null or last_outcome in ('verified','not_found','mismatch','uncertain')),
  failure_count       integer     not null default 0 check (failure_count >= 0),
  lapsed_at           timestamptz,
  revoked_at          timestamptz,
  revoked_by          text        check (revoked_by is null or char_length(revoked_by) between 1 and 200),
  requested_by        text        not null check (char_length(requested_by) between 1 and 200),
  created_at          timestamptz not null default clock_timestamp(),
  updated_at          timestamptz not null default clock_timestamp(),
  unique (workspace_id, id),
  check (status <> 'verified' or (verified_at is not null and expires_at is not null)),
  check (status <> 'lapsed' or lapsed_at is not null),
  check (status <> 'revoked' or revoked_at is not null)
);
-- a hostname is served for at most one workspace at a time, whoever asks
create unique index if not exists managed_domains_verified_host on platform.managed_domains (hostname) where status = 'verified';
-- one live claim per environment and hostname (a re-claim of a pending row re-issues its challenge)
create unique index if not exists managed_domains_live_claim on platform.managed_domains (workspace_id, environment_id, hostname) where status in ('pending','verified');
create index if not exists managed_domains_env on platform.managed_domains (workspace_id, environment_id, created_at desc);
create index if not exists managed_domains_due on platform.managed_domains (expires_at) where status = 'verified';

create table if not exists platform.managed_storage_keys (
  id             text        not null primary key,
  workspace_id   text        not null check (char_length(workspace_id) between 1 and 128),
  environment_id text        not null check (char_length(environment_id) between 1 and 128),
  address        text        not null check (char_length(address) between 1 and 500),
  bucket         text        not null check (char_length(bucket) between 3 and 63),
  prefix         text        not null check (char_length(prefix) between 2 and 500 and right(prefix, 1) = '/'),
  policy_digest  text        not null check (policy_digest ~ '^[0-9a-f]{64}$'),
  principal_name text        not null check (char_length(principal_name) between 1 and 64),
  access_key_id  text        not null check (char_length(access_key_id) between 1 and 128),
  secret_ref     text        not null check (char_length(secret_ref) between 7 and 306 and secret_ref ~ '^vault:[A-Za-z0-9._/-]+$'),
  status         text        not null default 'active' check (status in ('active','revoke_pending','revoked')),
  created_at     timestamptz not null default clock_timestamp(),
  superseded_at  timestamptz,
  revoked_at     timestamptz,
  unique (workspace_id, id),
  check (status <> 'revoked' or revoked_at is not null)
);
create unique index if not exists managed_storage_keys_active on platform.managed_storage_keys (workspace_id, environment_id, address) where status = 'active';
create index if not exists managed_storage_keys_env on platform.managed_storage_keys (workspace_id, environment_id, created_at desc);
create index if not exists managed_storage_keys_pending on platform.managed_storage_keys (created_at) where status = 'revoke_pending';

alter table platform.managed_domains enable row level security;
alter table platform.managed_storage_keys enable row level security;
do $$
declare r text; t text;
begin
  foreach t in array array['managed_domains','managed_storage_keys'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists(select 1 from pg_roles where rolname=r) then
        execute format('revoke all on table platform.%I from %I',t,r);
      end if;
    end loop;
    if exists(select 1 from pg_roles where rolname='service_role') then
      execute format('revoke all on table platform.%I from service_role',t);
      execute format('grant select,insert,update on table platform.%I to service_role',t);
    end if;
  end loop;
end
$$;
`,
} as const;
