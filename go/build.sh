#!/usr/bin/env bash
# Build zenith-runner and zenithd as static Linux binaries for amd64 and arm64.
#
#   ./build.sh [VERSION]            build everything into ./dist
#   ./build.sh test                 go vet + go test
#   VERSION defaults to `git describe`, or 0.0.0-dev when git is unavailable.
#   TARGETS="linux/amd64" ./build.sh    restrict the platforms
#
# The binaries are built with CGO_ENABLED=0 (fully static), -trimpath (no
# build-host paths) and -s -w (no symbol tables). Version and commit are
# injected with -ldflags -X so `zenith-runner version` reports them.
set -euo pipefail
cd "$(dirname "$0")"

MOD="github.com/GODOSTROYER/zenith/go"

if [[ "${1:-}" == "test" ]]; then
  go vet ./...
  exec go test -count=1 ./...
fi

VERSION="${1:-$(git describe --tags --always --dirty 2>/dev/null || echo 0.0.0-dev)}"
COMMIT="$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
TARGETS="${TARGETS:-linux/amd64 linux/arm64}"
OUT="${OUT:-dist}"

LDFLAGS="-s -w -X ${MOD}/internal/version.Version=${VERSION} -X ${MOD}/internal/version.Commit=${COMMIT}"

rm -rf "${OUT}"
for target in ${TARGETS}; do
  os="${target%/*}"
  arch="${target#*/}"
  dir="${OUT}/${os}-${arch}"
  mkdir -p "${dir}"
  for cmd in zenith-runner zenithd; do
    echo "building ${cmd} ${VERSION} for ${os}/${arch}"
    CGO_ENABLED=0 GOOS="${os}" GOARCH="${arch}" \
      go build -trimpath -ldflags "${LDFLAGS}" -o "${dir}/${cmd}" "./cmd/${cmd}"
  done
done

# Checksums next to the binaries so an installer can verify what it downloads.
(cd "${OUT}" && find . -type f -name 'zenith*' ! -name '*.sha256' -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
echo "done: ${OUT}/ (SHA256SUMS written)"
