#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$repo"
exec node node_modules/tsx/dist/cli.mjs scripts/acceptance/live/managed/cli.ts --profile release "$@"
