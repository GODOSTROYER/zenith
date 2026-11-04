#!/usr/bin/env bash
#
# Bring the disposable `platform-postgres` lane database forward with the
# platform control store's OWN migrator, then require it to report "current".
# Written for the `platform-postgres` job in .github/workflows/ci.yml.
#
# ## Why this is separate from apply-supabase-migrations.sh
#
# `apply-supabase-migrations.sh` replays the committed `supabase/migrations`
# with psql, for the `postgres` job. The platform control store (ADR-0002) has a
# migrator of its own — `scripts/platform/migrate.ts`, which is also how a real
# database is brought forward, because the application never runs DDL itself.
# The lane should exercise THAT path, not a psql replay of the SQL it emits, so
# this script calls the migrator and nothing else. It deliberately does not edit
# apply-supabase-migrations.sh: that script's migration manifest is pinned by
# tests/ci/release-gates.test.ts and is owned by the workstream that adds each
# migration.
#
# ## What it proves, and what it does not
#
#   - PROVES: the platform migrations apply to an empty PostgreSQL, through the
#     production migrator, and a second `--status` call reports the ledger as
#     current (no pending, none tampered).
#   - DOES NOT PROVE: anything about Supabase's role graph, PostgREST exposure
#     or pooler behaviour. The target here is a bare Postgres container; the
#     migrations' `service_role` grants are conditional on that role existing
#     and do not run on it.
#
# ## Safety
#
# The target URL must be loopback. This script exists for a service container
# that is created, used and destroyed inside one CI job; pointing it at a
# Supabase project would run migrations against somebody's data. The password in
# the URL is a throwaway (see ci.yml) — the check below is what makes putting it
# in an argv acceptable — and this script never prints the URL.
#
# Usage:  ZENITH_TEST_PLATFORM_PG_URL=postgresql://…@127.0.0.1:5432/db bash scripts/ci/apply-platform-migrations.sh
# Exit:   0 applied and current, 1 anything else (with the reason on stderr).

set -euo pipefail

MIGRATOR="scripts/platform/migrate.ts"

if [ -z "${ZENITH_TEST_PLATFORM_PG_URL:-}" ]; then
  echo "::error::ZENITH_TEST_PLATFORM_PG_URL is not set, so there is no lane database to migrate." >&2
  exit 1
fi

# Host of the URL, by parameter expansion only: drop the scheme, drop everything
# up to and including the last `@` (the credential), then cut at the first
# character that ends a host. An IPv6 literal is bracketed and has colons of its
# own, so it is cut at the closing bracket instead.
rest="${ZENITH_TEST_PLATFORM_PG_URL#*://}"
hostport="${rest##*@}"
case "$hostport" in
  "["*) host="${hostport%%]*}]" ;;
  *) host="${hostport%%[:/?]*}" ;;
esac

case "$host" in
  127.0.0.1 | localhost | "[::1]") ;;
  *)
    echo "::error::Refusing to migrate '${host}': this script only targets a loopback lane database, never a shared or hosted one." >&2
    exit 1
    ;;
esac

# Two libpq URL features would let a loopback-looking URL reach somewhere else:
# a comma-separated host list (`@127.0.0.1,db.example.com/…`) and a `?host=…`
# query parameter, which overrides the host in the authority. The lane URL has
# neither, so neither is allowed.
case "$hostport" in
  *\?* | *,*)
    echo "::error::Refusing to migrate: the lane database URL must be a single host with no query parameters." >&2
    exit 1
    ;;
esac

if [ ! -f "$MIGRATOR" ]; then
  echo "::error::${MIGRATOR} does not exist, so there is nothing to apply the platform migrations with." >&2
  exit 1
fi

echo "Applying platform migrations to ${host} with ${MIGRATOR}"
npx tsx "$MIGRATOR" --url "$ZENITH_TEST_PLATFORM_PG_URL"

# `--status` exits 1 unless the ledger is current, so a migrator that printed
# success but left something pending still fails the lane here.
echo "Verifying the ledger is current"
npx tsx "$MIGRATOR" --url "$ZENITH_TEST_PLATFORM_PG_URL" --status

echo "Platform control store migrated and current."
