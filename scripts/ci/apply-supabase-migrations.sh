#!/usr/bin/env bash
#
# Apply the committed supabase/migrations, in order, to the database named by
# SUPABASE_DB_URL. Written for the `postgres` job in .github/workflows/ci.yml,
# whose database is a disposable service container — never point it at a
# Supabase project.
#
# ## Why a script and not `supabase db push`
#
# The Supabase CLI wants a linked project and an access token. CI has neither,
# and the thing under test is the *SQL in this repository*, not the CLI. `psql`
# applying the files in order is the smallest thing that proves the schema
# the hosted authority checks for (`src/lib/hosted/authority/pg/index.ts:165-191`)
# can actually be built from what is committed.
#
# ## 0006 and 0007 — the `agent` schema
#
# The agent link flow (`supabase/migrations/0006_agent_link.sql`) and the agent
# control plane (`0007_agent_control.sql`) create one new schema, `agent`, with
# its own `agent.schema_migrations` ledger — deliberately not `hosted.*`, so an
# agent-link outage is not coupled to a hosted-apps migration
# (PLAN2/LINK-PROTOCOL.md §3.2). Both files are idempotent, both create the
# schema if absent and both repeat the `service_role` grant block, so either
# order applies and re-applying is a no-op. They are listed in numeric order
# anyway, because that is the order the operator runbook
# (`docs/HOSTED-POSTGRES.md` §9) tells a human to run them in.
#
# `agent` is **not** exposed to PostgREST on Supabase and nothing in this script
# exposes it here either: the agent journal and credential authority speak
# direct Postgres through `postgres.js`.
#
# ## Supabase role stand-ins
#
# `service_role`. The migrations include grant blocks naming it
# (0001:422-426, 0002:383-387, 0003:245-261, 0004:289-294) because on Supabase
# it is a real role that bypasses RLS. A bare PostgreSQL container has no such
# role, so `create role service_role` below is a **stand-in**: NOLOGIN with
# BYPASSRLS, as required by the SECURITY INVOKER sharing and waitlist functions.
# Contract tests use SET ROLE to verify privileges. No test authenticates as it.
#
# That matters for what the lane can and cannot prove:
#   - PROVES: every DDL statement applies, in order, from an empty database —
#     tables, partial unique indexes, CHECKs, identity columns, plpgsql
#     functions, and the migration ledger the runtime verifies.
#   - PROVES: the new product functions are executable as the stand-in service
#     role and inaccessible as the stand-in `anon`/`authenticated` roles.
#   - DOES NOT PROVE: a real Supabase project's role memberships, exposed API
#     schemas or PostgREST configuration. Tests open a superuser connection and
#     use SET ROLE; they do not authenticate through Supabase.
#
# `anon` and `authenticated` are also NOLOGIN stand-ins. The workspace sharing
# and waitlist migrations explicitly revoke their table/function privileges;
# the contract suites use SET ROLE to verify those application boundaries.
#
# No extensions are required. `gen_random_uuid()` in the waitlist migration is
# built into the PostgreSQL version used by this lane.
#
# Usage:  SUPABASE_DB_URL=postgresql://… bash scripts/ci/apply-supabase-migrations.sh
# Exit:   0 applied and verified, 1 anything else (with the reason on stderr).

set -euo pipefail

MIGRATION_DIR="supabase/migrations"

# The order is the contract: 0002 creates the `hosted` schema and the migration
# ledger, 0005 writes the ledger row the runtime's boot check reads. Listed
# explicitly rather than globbed so a new file cannot join the lane silently.
MIGRATIONS=(
  "0001_system_of_record.sql"
  "0002_hosted_authority.sql"
  "0003_hosted_app_data.sql"
  "0004_hosted_app_data_atomic.sql"
  "0005_pending_invite_uniqueness.sql"
  "0006_agent_link.sql"
  "0007_agent_control.sql"
  "0008_workspace_ownership.sql"
  "0009_waitlist.sql"
)

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  echo "::error::SUPABASE_DB_URL is not set, so there is nothing to apply migrations to." >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "::error::psql is not on PATH. Install postgresql-client before this step (ubuntu-latest ships it)." >&2
  exit 1
fi

# The URL carries a password. Everything this script prints uses the redacted
# form, and `set -x` is never turned on.
# Pure parameter expansion, so this depends on nothing but the shell: drop the
# scheme, then drop everything up to and including the last `@`, which is where
# the credential ends.
redacted() {
  local rest="${SUPABASE_DB_URL#*://}"
  printf 'postgres://%s' "${rest##*@}"
}

TARGET="$(redacted)"
echo "Applying ${#MIGRATIONS[@]} migrations to ${TARGET}"

# --- wait for the service container -----------------------------------------
#
# The job's `services:` health check already gates the step, but a container
# that has just reported healthy can still refuse the first connection while it
# finishes its own bootstrap. Bounded: 30 attempts, one second apart.
attempt=0
# Keep the connection argument last: Windows psql stops option parsing at the
# first positional argument, while GNU builds also accept trailing options.
until psql --quiet --no-align --tuples-only --command 'select 1' "$SUPABASE_DB_URL" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "::error::${TARGET} did not accept a connection after 30 attempts." >&2
    exit 1
  fi
  sleep 1
done
echo "Connected after ${attempt} retr$([ "$attempt" -eq 1 ] && echo y || echo ies)."

# --- the service_role stand-in ----------------------------------------------
#
# Idempotent, so re-running the script against the same container is a no-op.
psql --quiet --set ON_ERROR_STOP=1 "$SUPABASE_DB_URL" <<'SQL'
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;
-- Re-running against the same disposable CI cluster upgrades an older stand-in.
alter role service_role bypassrls;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
end
$$;
SQL
echo "service_role, anon and authenticated stand-ins present."

# --- apply, each file in its own transaction --------------------------------
#
# --single-transaction matters for 0005: its comment states that the index and
# the ledger insert must succeed or fail together, so that a duplicate legacy
# row cannot leave a ledger row claiming an index that is not there.
for file in "${MIGRATIONS[@]}"; do
  path="${MIGRATION_DIR}/${file}"
  if [ ! -f "$path" ]; then
    echo "::error::${path} does not exist. The migration set this script applies is out of date." >&2
    exit 1
  fi
  echo "--- ${file}"
  psql \
    --quiet \
    --single-transaction \
    --set ON_ERROR_STOP=1 \
    --file "$path" \
    "$SUPABASE_DB_URL"
done

# --- verify what actually landed --------------------------------------------
#
# Three facts, because "psql exited 0" only says the statements parsed:
#   1. the ledger holds exactly versions 1,2,3 with the names the runtime
#      expects (src/lib/hosted/authority/schema.ts:334-336);
#   2. the partial unique index the boot check probes for exists;
#   3. both schemas hold tables.
echo "--- verification"
ledger="$(psql --no-align --tuples-only --set ON_ERROR_STOP=1 \
  --command "select string_agg(version || ':' || name, ', ' order by version) from hosted.schema_migrations" "$SUPABASE_DB_URL")"
echo "hosted.schema_migrations = ${ledger}"
if [ "$ledger" != "1:control-authority-v1, 2:invite-delivery-transport-none, 3:one-pending-invite-per-app-email" ]; then
  echo "::error::The migration ledger is not what src/lib/hosted/authority/schema.ts expects; the authority will refuse to boot." >&2
  exit 1
fi

index_def="$(psql --no-align --tuples-only --set ON_ERROR_STOP=1 \
  --command "select coalesce(indexdef, '') from pg_indexes where schemaname = 'hosted' and indexname = 'app_invites_pending_email'" "$SUPABASE_DB_URL")"
if [ -z "$index_def" ]; then
  echo "::error::hosted.app_invites_pending_email is missing; migration 0005 did not apply." >&2
  exit 1
fi
echo "app_invites_pending_email = ${index_def}"

counts="$(psql --no-align --tuples-only --set ON_ERROR_STOP=1 \
  --command "select schemaname || '=' || count(*) from pg_tables where schemaname in ('public','hosted','agent') group by schemaname order by schemaname" "$SUPABASE_DB_URL")"
echo "tables: $(echo "$counts" | tr '\n' ' ')"

# --- the agent schema (0006, 0007) ------------------------------------------
#
# Same three questions as above, asked of the schema the agent link flow and
# the agent control plane live in. The ledger is checked by exact string for
# the same reason `hosted.schema_migrations` is: `pgAgentJournal()` and
# `pgCredentialAuthority()` refuse every read and write until both rows are
# present, so a lane that applied the DDL but not the ledger row would fail
# later, with a less useful message.
agent_ledger="$(psql --no-align --tuples-only --set ON_ERROR_STOP=1 \
  --command "select string_agg(version || ':' || name, ', ' order by version) from agent.schema_migrations" "$SUPABASE_DB_URL")"
echo "agent.schema_migrations = ${agent_ledger}"
if [ "$agent_ledger" != "1:agent-link-v1, 2:agent-control-v1" ]; then
  echo "::error::agent.schema_migrations is not 1:agent-link-v1, 2:agent-control-v1; the agent journal and credential authority will refuse every request." >&2
  exit 1
fi

# The ten named indexes of docs/HOSTED-POSTGRES.md §9 step 3. A subset check,
# not an equality one: the primary keys and the two UNIQUE constraints create
# their own system-named indexes beside these, and pinning that list would make
# this script fail on a rename PostgreSQL chose.
AGENT_INDEXES=(
  agent_credentials_live
  agent_credentials_subject
  agent_link_codes_expiry
  agent_operation_events_op
  agent_operations_leased
  agent_operations_pending_expiry
  agent_operations_review
  agent_operations_scope
  agent_rate_limits_bucket
  agent_uploads_workspace
)
present="$(psql --no-align --tuples-only --set ON_ERROR_STOP=1 \
  --command "select indexname from pg_indexes where schemaname = 'agent' order by 1" "$SUPABASE_DB_URL")"
echo "agent indexes: $(echo "$present" | tr '\n' ' ')"
for index in "${AGENT_INDEXES[@]}"; do
  if ! printf '%s\n' "$present" | grep -qx -- "$index"; then
    echo "::error::agent.${index} is missing; 0006/0007 did not apply the index the runbook names." >&2
    exit 1
  fi
done

# The grant block at the tail of each file, which is the one Supabase-only
# thing these migrations need. On the container `service_role` is the NOLOGIN
# stand-in created above, so this proves the statement applied — not that
# Supabase's own role graph is correct. Nothing here authenticates as it.
agent_usage="$(psql --no-align --tuples-only --set ON_ERROR_STOP=1 \
  --command "select has_schema_privilege('service_role','agent','USAGE')" "$SUPABASE_DB_URL")"
if [ "$agent_usage" != "t" ]; then
  echo "::error::service_role has no USAGE on schema agent; the grant block at the tail of 0006/0007 did not apply." >&2
  exit 1
fi
echo "service_role USAGE on schema agent = ${agent_usage}"

# RLS on with no policies is the `hosted` rule, repeated for `agent`. A table
# that reached production with RLS off would be readable by `anon` the moment
# somebody exposed the schema to the Data API by mistake.
unprotected="$(psql --no-align --tuples-only --set ON_ERROR_STOP=1 \
  --command "select string_agg(relname, ', ' order by relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'agent' and c.relkind = 'r' and not c.relrowsecurity" "$SUPABASE_DB_URL")"
if [ -n "$unprotected" ]; then
  echo "::error::row level security is off on agent.{${unprotected}}; every table in the agent schema must enable it." >&2
  exit 1
fi
echo "row level security enabled on every table in schema agent."

# Verify the new public RPC boundary independently of the TypeScript tests.
psql --quiet --set ON_ERROR_STOP=1 "$SUPABASE_DB_URL" <<'SQL'
do $$
declare
  signature text;
  routine regprocedure;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'workspaces' and column_name = 'owner_id'
  ) or to_regclass('public.workspace_invites_pending_email') is null then
    raise exception 'Workspace ownership columns or pending-invitation index are missing';
  end if;

  foreach signature in array array[
    'public.zenith_workspace_sharing(text,text,text,text,text,text,text,text,text,text)',
    'public.zenith_waitlist_join(text,text,text)',
    'public.zenith_waitlist_list(text,bigint,integer)',
    'public.zenith_waitlist_admit(integer,text,text)',
    'public.zenith_waitlist_admitted(text)',
    'public.zenith_waitlist_rate_limit(text,integer,integer)'
  ] loop
    routine := to_regprocedure(signature);
    if routine is null then
      raise exception 'Product RPC % is missing', signature;
    end if;
    if not has_function_privilege('service_role', routine, 'EXECUTE')
       or has_function_privilege('anon', routine, 'EXECUTE')
       or has_function_privilege('authenticated', routine, 'EXECUTE') then
      raise exception 'Product RPC % does not have a service-role-only execution boundary', signature;
    end if;
  end loop;

  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
        and c.relname in ('waitlist_entries', 'waitlist_admission_batches', 'waitlist_rate_limits')) <> 3 then
    raise exception 'Waitlist tables are missing or row level security is disabled';
  end if;
end
$$;
SQL
echo "Workspace ownership and waitlist RPC privileges and schema verified."

echo "All ${#MIGRATIONS[@]} committed migrations applied and verified."
