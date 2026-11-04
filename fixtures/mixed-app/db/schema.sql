-- Reference mixed app schema (Azure Database for PostgreSQL). Applied by the web service's release hook.
-- No secrets, no data. `client_key` is unique so a retried write is idempotent.
create table if not exists orders (
  id bigserial primary key,
  client_key text not null unique,
  sku text not null,
  qty integer not null check (qty between 1 and 20),
  price_cents integer not null check (price_cents >= 0),
  checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
  web_provider text not null,
  enricher_provider text not null,
  created_at timestamptz not null default now()
);
create index if not exists orders_client_key_prefix on orders (client_key text_pattern_ops);
