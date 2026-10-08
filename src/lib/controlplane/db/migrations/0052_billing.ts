/**
 * Separable metering and billing (PROD-MAN-06).
 *
 * Nothing here is read or written unless the install runs `ZENITH_BILLING=managed`; a BYOC or self-hosted install
 * carries the empty tables and never touches them. Plans are code (src/lib/billing/plans.ts, all provisional), so no
 * table holds a price list; invoices snapshot the lines they were priced with.
 *
 * Retention: nothing in these tables is ever deleted, by any code path or by trigger-refused SQL. Suspension is a state
 * change on `billing_accounts`; it removes no row anywhere in the platform.
 *
 *  - `billing_accounts`        one row per workspace that has been assigned a plan. `status` is the standing
 *                              (active | past_due | suspended); `suspension_reason` is why a suspended account is
 *                              suspended (nonpayment | operator). `version` advances by one per write.
 *  - `billing_account_events`  append-only audit of plan assignment, standing changes and tenant exports.
 *  - `billing_usage_events`    one row per (workspace, meter, source, period): the metered quantity read from a durable
 *                              record (or, for estimated meters, from a COST estimate). Re-collection updates the
 *                              quantity while the period is open; once an invoice exists for the period the row is
 *                              closed by trigger.
 *  - `billing_invoices`        one invoice per workspace and period. Lines/total/digest are immutable; only status,
 *                              provider ids and settlement fields move, and `paid` never moves again.
 *  - `billing_webhook_events`  one row per provider event id: the idempotency record. Holds the digest of the verified
 *                              payload and the outcome, never the payload.
 */
export const migration0052Billing = {
  version: 52,
  name: "billing",
  sql: `
create table if not exists platform.billing_accounts (
  workspace_id       text        not null primary key,
  plan_id            text        not null check (plan_id ~ '^[a-z0-9_]{1,64}$'),
  status             text        not null default 'active' check (status in ('active','past_due','suspended')),
  suspension_reason  text        check (suspension_reason in ('nonpayment','operator')),
  past_due_since     timestamptz,
  suspended_at       timestamptz,
  stripe_customer_id text        check (stripe_customer_id ~ '^[A-Za-z0-9_]{1,100}$'),
  assigned_by        text        not null check (length(assigned_by) between 1 and 200),
  version            integer     not null default 1 check (version >= 1),
  created_at         timestamptz not null default clock_timestamp(),
  updated_at         timestamptz not null default clock_timestamp(),
  check ((status = 'suspended') = (suspension_reason is not null and suspended_at is not null)),
  check (status = 'suspended' or (suspension_reason is null and suspended_at is null))
);

create or replace function platform.billing_accounts_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Billing accounts are retained' using errcode = '23514';
  end if;
  if new.workspace_id <> old.workspace_id or new.created_at <> old.created_at or new.version <> old.version + 1 then
    raise exception 'Billing account identity is immutable and version advances by one' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists billing_accounts_guard on platform.billing_accounts;
create trigger billing_accounts_guard before update or delete on platform.billing_accounts
for each row execute function platform.billing_accounts_guard();

create table if not exists platform.billing_account_events (
  seq          bigint generated always as identity primary key,
  workspace_id text        not null,
  kind         text        not null check (kind in ('plan_assigned','past_due','suspended','reinstated','payment_received','export_requested')),
  actor        text        not null check (length(actor) between 1 and 200),
  reason       text        check (reason is null or length(reason) <= 300),
  detail       jsonb       not null default '{}'::jsonb check (octet_length(detail::text) <= 16384),
  at           timestamptz not null default clock_timestamp()
);
create index if not exists billing_account_events_ws on platform.billing_account_events (workspace_id, seq desc);

create or replace function platform.billing_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'Billing records are append-only' using errcode = '23514';
end
$$;
drop trigger if exists billing_account_events_immutable on platform.billing_account_events;
create trigger billing_account_events_immutable before update or delete on platform.billing_account_events
for each row execute function platform.billing_append_only();

create table if not exists platform.billing_invoices (
  id                  text        not null primary key,
  workspace_id        text        not null,
  period              text        not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  plan_id             text        not null check (plan_id ~ '^[a-z0-9_]{1,64}$'),
  plan_provisional    boolean     not null,
  currency            text        not null check (currency = 'usd'),
  lines               jsonb       not null check (jsonb_typeof(lines) = 'array' and octet_length(lines::text) <= 262144),
  subtotal_cents      bigint      not null check (subtotal_cents >= 0),
  digest              text        not null check (digest ~ '^[0-9a-f]{64}$'),
  status              text        not null default 'draft' check (status in ('draft','open','paid','failed','void','no_charge')),
  stripe_invoice_id   text        check (stripe_invoice_id ~ '^[A-Za-z0-9_]{1,100}$'),
  stripe_customer_id  text        check (stripe_customer_id ~ '^[A-Za-z0-9_]{1,100}$'),
  attempts            integer     not null default 0 check (attempts >= 0),
  due_at              timestamptz,
  paid_at             timestamptz,
  amount_paid_cents   bigint      check (amount_paid_cents is null or amount_paid_cents >= 0),
  last_event_created  bigint      not null default 0,
  last_error          text        check (last_error is null or length(last_error) <= 300),
  version             integer     not null default 1 check (version >= 1),
  created_at          timestamptz not null default clock_timestamp(),
  updated_at          timestamptz not null default clock_timestamp(),
  unique (workspace_id, id),
  unique (workspace_id, period),
  unique (stripe_invoice_id),
  check ((status = 'paid') = (paid_at is not null)),
  check (status in ('draft','no_charge','void') or stripe_invoice_id is not null)
);
create index if not exists billing_invoices_standing on platform.billing_invoices (workspace_id, status, due_at) where status in ('open','failed');

create or replace function platform.billing_invoices_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Invoices are retained' using errcode = '23514';
  end if;
  if (new.id, new.workspace_id, new.period, new.plan_id, new.plan_provisional, new.currency, new.lines, new.subtotal_cents, new.digest, new.created_at)
     is distinct from
     (old.id, old.workspace_id, old.period, old.plan_id, old.plan_provisional, old.currency, old.lines, old.subtotal_cents, old.digest, old.created_at)
     or new.version <> old.version + 1 then
    raise exception 'Invoice content is immutable and version advances by one' using errcode = '23514';
  end if;
  if old.status = 'paid' and new.status <> 'paid' then
    raise exception 'A paid invoice does not change status' using errcode = '23514';
  end if;
  if old.status in ('void','no_charge') and new.status <> old.status then
    raise exception 'A closed invoice does not change status' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists billing_invoices_guard on platform.billing_invoices;
create trigger billing_invoices_guard before update or delete on platform.billing_invoices
for each row execute function platform.billing_invoices_guard();

create table if not exists platform.billing_usage_events (
  id           text          not null primary key,
  workspace_id text          not null,
  meter        text          not null check (meter in ('managed_resource_hours','build_minutes','storage_gb_month','operations_executed','egress_gb_estimated')),
  source_id    text          not null check (length(source_id) between 1 and 300),
  period       text          not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  quantity     numeric(20,6) not null check (quantity >= 0),
  unit         text          not null check (length(unit) between 1 and 40),
  estimated    boolean       not null default false,
  detail       jsonb         not null default '{}'::jsonb check (octet_length(detail::text) <= 4096),
  observed_at  timestamptz   not null default clock_timestamp(),
  unique (workspace_id, meter, source_id, period)
);
create index if not exists billing_usage_events_ws_period on platform.billing_usage_events (workspace_id, period, meter);

create or replace function platform.billing_usage_events_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Usage records are retained' using errcode = '23514';
  end if;
  if exists (select 1 from platform.billing_invoices i where i.workspace_id = new.workspace_id and i.period = new.period and i.status <> 'void') then
    raise exception 'Usage for an invoiced period is closed' using errcode = '23514';
  end if;
  if TG_OP = 'UPDATE' and (new.id, new.workspace_id, new.meter, new.source_id, new.period) is distinct from (old.id, old.workspace_id, old.meter, old.source_id, old.period) then
    raise exception 'Usage record identity is immutable' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists billing_usage_events_guard on platform.billing_usage_events;
create trigger billing_usage_events_guard before insert or update or delete on platform.billing_usage_events
for each row execute function platform.billing_usage_events_guard();

create table if not exists platform.billing_webhook_events (
  stripe_event_id text        not null primary key check (stripe_event_id ~ '^[A-Za-z0-9_]{1,100}$'),
  event_type      text        not null check (length(event_type) between 1 and 120),
  workspace_id    text,
  payload_sha256  text        not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  stripe_created  bigint      not null,
  outcome         text        not null default 'received' check (outcome in ('received','applied','ignored','unmatched','rejected','amount_mismatch')),
  received_at     timestamptz not null default clock_timestamp()
);

create or replace function platform.billing_webhook_events_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Webhook events are retained' using errcode = '23514';
  end if;
  if old.outcome <> 'received' or (new.stripe_event_id, new.event_type, new.payload_sha256, new.stripe_created, new.received_at)
     is distinct from (old.stripe_event_id, old.event_type, old.payload_sha256, old.stripe_created, old.received_at) then
    raise exception 'A recorded webhook event is final' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists billing_webhook_events_guard on platform.billing_webhook_events;
create trigger billing_webhook_events_guard before update or delete on platform.billing_webhook_events
for each row execute function platform.billing_webhook_events_guard();

alter table platform.billing_accounts enable row level security;
alter table platform.billing_account_events enable row level security;
alter table platform.billing_invoices enable row level security;
alter table platform.billing_usage_events enable row level security;
alter table platform.billing_webhook_events enable row level security;
do $$
declare r text;
declare t text;
begin
  foreach t in array array['billing_accounts','billing_account_events','billing_invoices','billing_usage_events','billing_webhook_events'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists(select 1 from pg_roles where rolname=r) then
        execute format('revoke all on table platform.%I from %I',t,r);
      end if;
    end loop;
    if exists(select 1 from pg_roles where rolname='service_role') then
      execute format('revoke all on table platform.%I from service_role',t);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant select,insert,update on table platform.billing_accounts to service_role;
    grant select,insert on table platform.billing_account_events to service_role;
    grant select,insert,update on table platform.billing_invoices to service_role;
    grant select,insert,update on table platform.billing_usage_events to service_role;
    grant select,insert,update on table platform.billing_webhook_events to service_role;
  end if;
end
$$;
`,
} as const;
