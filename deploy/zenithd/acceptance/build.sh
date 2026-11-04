#!/usr/bin/env bash
set -euo pipefail
export PATH="/c/Users/user/.local/sdk/node22:$PATH"
export GOTOOLCHAIN=local GOMAXPROCS=2 CGO_ENABLED=0 GOOS=linux
: "${ZENITH_UPDATE_FIXTURE_OUT:?Set an owned output directory outside the checkout}"
case "$(uname -m)" in arm64|aarch64) export GOARCH=arm64;; x86_64) export GOARCH=amd64;; *) exit 1;; esac
mkdir -p "$ZENITH_UPDATE_FIXTURE_OUT"
cd "$(dirname "$0")/../../../go"
mod=github.com/GODOSTROYER/zenith/go
source=$(git rev-parse HEAD)
for version in 1.0.0 1.1.0; do
  go build -p 2 -trimpath -ldflags "-X $mod/internal/version.Version=$version -X $mod/internal/version.Commit=$source" \
    -o "$ZENITH_UPDATE_FIXTURE_OUT/zenithd-$version" ./cmd/zenithd
done
go test -p 2 -c -o "$ZENITH_UPDATE_FIXTURE_OUT/update-systemd.test" ./internal/runner/update
printf '%s\n' "$source" > "$ZENITH_UPDATE_FIXTURE_OUT/source-sha"
git diff --binary > "$ZENITH_UPDATE_FIXTURE_OUT/source-working-tree.patch"
python3 - "$ZENITH_UPDATE_FIXTURE_OUT/source-inputs.sha256" <<'PY'
import hashlib, pathlib, sys
sources = sorted(p for p in pathlib.Path('.').rglob('*') if p.is_file() and (p.suffix == '.go' or p.name in ('go.mod', 'go.sum')))
pathlib.Path(sys.argv[1]).write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.as_posix() + '\n' for p in sources))
PY
printf '%s\n' 'Built fixtures; no Linux/systemd tests have run.'
