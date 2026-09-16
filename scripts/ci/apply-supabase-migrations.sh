#!/usr/bin/env bash
#
# Apply supabase/migrations/0001…0007, in order, to the database named by
# SUPABASE_DB_URL. Written for the `postgres` job in .github/workflows/ci.yml,
# whose database is a disposable service container — never point it at a
# Supabase project.
#
# ## Why a script and not `supabase db push`
#
# The Supabase CLI wants a linked project and an access token. CI has neither,
# and the thing under test is the *SQL in this repository*, not the CLI. `psql`
# applying the seven files in order is the smallest thing that proves the schema
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
# ## The one Supabase-only thing these files need
#
# `service_role`. Every migration ends in a grant block naming it
# (0001:422-426, 0002:383-387, 0003:245-261, 0004:289-294) because on Supabase
# it is a real role that bypasses RLS. A bare PostgreSQL container has no such
# role, so `create role service_role` below is a **stand-in**: NOLOGIN, no
# BYPASSRLS, granted nothing this script does not grant it. It exists so the
# grant statements parse and apply; nothing in the test run authenticates as it.
#
# That matters for what the lane can and cannot prove:
#   - PROVES: every DDL statement applies, in order, from an empty database —
#     tables, partial unique indexes, CHECKs, identity columns, plpgsql
#     functions, and the migration ledger the runtime verifies.
#   - DOES NOT PROVE: that a real `service_role` connection is correctly
#     privileged, or that RLS refuses `anon`/`authenticated`. The tests connect
#     as the container superuser, which bypasses RLS the way Supabase's
#     `service_role` does — the same reachability, a different reason for it.
#     Anything about Supabase's own role graph is BLOCKED without a project.
#
# `anon` and `authenticated` are deliberately NOT created: no statement in any
# of the five files grants them anything (they appear only in comments), so
# inventing them here would be inventing surface area.
#
# No extensions are required — `grep -n "create extension" supabase/migrations/`
# is empty, and nothing calls `gen_random_uuid()`; ids are minted in TypeScript.
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
until psql "$SUPABASE_DB_URL" --quiet --no-align --tuples-only --command 'select 1' >/dev/null 2>&1; do
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
psql "$SUPABASE_DB_URL" --quiet --set ON_ERROR_STOP=1 <<'SQL'
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    -- NOLOGIN and no BYPASSRLS on purpose: this role is here so the grant
    -- blocks in the migrations apply, not so anything can connect as it.
    create role service_role nologin noinherit;
  end if;
end
$$;
SQL
echo "service_role stand-in present."

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
  psql "$SUPABASE_DB_URL" \
    --quiet \
    --single-transaction \
    --set ON_ERROR_STOP=1 \
    --file "$path"
done

# --- verify what actually landed --------------------------------------------
#
# Three facts, because "psql exited 0" only says the statements parsed:
#   1. the ledger holds exactly versions 1,2,3 with the names the runtime
#      expects (src/lib/hosted/authority/schema.ts:334-336);
#   2. the partial unique index the boot check probes for exists;
#   3. both schemas hold tables.
echo "--- verification"
ledger="$(psql "$SUPABASE_DB_URL" --no-align --tuples-only --set ON_ERROR_STOP=1 \
  --command "select string_agg(version || ':' || name, ', ' order by version) from hosted.schema_migrations")"
echo "hosted.schema_migrations = ${ledger}"
if [ "$ledger" != "1:control-authority-v1, 2:invite-delivery-transport-none, 3:one-pending-invite-per-app-email" ]; then
  echo "::error::The migration ledger is not what src/lib/hosted/authority/schema.ts expects; the authority will refuse to boot." >&2
  exit 1
fi

index_def="$(psql "$SUPABASE_DB_URL" --no-align --tuples-only --set ON_ERROR_STOP=1 \
  --command "select coalesce(indexdef, '') from pg_indexes where schemaname = 'hosted' and indexname = 'app_invites_pending_email'")"
if [ -z "$index_def" ]; then
  echo "::error::hosted.app_invites_pending_email is missing; migration 0005 did not apply." >&2
  exit 1
fi
echo "app_invites_pending_email = ${index_def}"

counts="$(psql "$SUPABASE_DB_URL" --no-align --tuples-only --set ON_ERROR_STOP=1 \
  --command "select schemaname || '=' || count(*) from pg_tables where schemaname in ('public','hosted','agent') group by schemaname order by schemaname")"
echo "tables: $(echo "$counts" | tr '\n' ' ')"

# --- the agent schema (0006, 0007) ------------------------------------------
#
# Same three questions as above, asked of the schema the agent link flow and
# the agent control plane live in. The ledger is checked by exact string for
# the same reason `hosted.schema_migrations` is: `pgAgentJournal()` and
# `pgCredentialAuthority()` refuse every read and write until both rows are
# present, so a lane that applied the DDL but not the ledger row would fail
# later, with a less useful message.
agent_ledger="$(psql "$SUPABASE_DB_URL" --no-align --tuples-only --set ON_ERROR_STOP=1 \
  --command "select string_agg(version || ':' || name, ', ' order by version) from agent.schema_migrations")"
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
present="$(psql "$SUPABASE_DB_URL" --no-align --tuples-only --set ON_ERROR_STOP=1 \
  --command "select indexname from pg_indexes where schemaname = 'agent' order by 1")"
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
# Supabase's own role graph is correct. Nothing here connects as it.
agent_usage="$(psql "$SUPABASE_DB_URL" --no-align --tuples-only --set ON_ERROR_STOP=1 \
  --command "select has_schema_privilege('service_role','agent','USAGE')")"
if [ "$agent_usage" != "t" ]; then
  echo "::error::service_role has no USAGE on schema agent; the grant block at the tail of 0006/0007 did not apply." >&2
  exit 1
fi
echo "service_role USAGE on schema agent = ${agent_usage}"

# RLS on with no policies is the `hosted` rule, repeated for `agent`. A table
# that reached production with RLS off would be readable by `anon` the moment
# somebody exposed the schema to the Data API by mistake.
unprotected="$(psql "$SUPABASE_DB_URL" --no-align --tuples-only --set ON_ERROR_STOP=1 \
  --command "select string_agg(relname, ', ' order by relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'agent' and c.relkind = 'r' and not c.relrowsecurity")"
if [ -n "$unprotected" ]; then
  echo "::error::row level security is off on agent.{${unprotected}}; every table in the agent schema must enable it." >&2
  exit 1
fi
echo "row level security enabled on every table in schema agent."

echo "Migrations 0001-0007 applied and verified."
