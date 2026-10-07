/**
 * PROD-MACH-02: tenant-scoped Kubernetes guest bindings.
 *
 * One row per (workspace, connection, namespace, profile) records the Zenith-minted
 * ServiceAccount + namespaced Role/RoleBinding that serve guest (machine) sessions
 * for a `scoped_guest` Kubernetes connection. Rows hold NO credential: tokens are
 * minted per dispatch through TokenRequest and never stored. `status` is the
 * dispatch gate: only `active` rows may mint; connection revocation moves open rows
 * to `revoking` in the same transaction, and `revoked` is set once the cluster
 * objects are gone.
 */
export const migration0035K8sGuestBindings = {
  version: 35,
  name: "k8s_guest_bindings",
  sql: `
create table if not exists platform.k8s_guest_bindings (
  id                    text primary key,
  workspace_id          text not null,
  connection_id         text not null,
  namespace             text not null check (namespace ~ '^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$'),
  profile               text not null check (profile in ('read','exec')),
  object_name           text not null check (object_name ~ '^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$'),
  status                text not null check (status in ('provisioning','active','revoking','revoked')),
  sa_uid                text,
  issued_count          integer not null default 0 check (issued_count >= 0),
  last_issued_at        timestamptz,
  last_token_expires_at timestamptz,
  last_error            text check (last_error is null or last_error ~ '^[a-z_]{1,64}$'),
  created_at            timestamptz not null default clock_timestamp(),
  updated_at            timestamptz not null default clock_timestamp(),
  revoked_at            timestamptz,
  unique (workspace_id, connection_id, namespace, profile)
);
create index if not exists k8s_guest_bindings_connection on platform.k8s_guest_bindings(workspace_id, connection_id, status);
alter table platform.k8s_guest_bindings enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.k8s_guest_bindings from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    execute 'revoke all on table platform.k8s_guest_bindings from service_role';
    execute 'grant select,insert,update on table platform.k8s_guest_bindings to service_role';
  end if;
end
$$;
`,
} as const;
