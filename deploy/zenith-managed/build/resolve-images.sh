#!/usr/bin/env bash
# Verifier-only: records actual registry digests. The implementation agent never runs this.
set -euo pipefail
for name in GO_TAG BUILDKIT_TAG PYTHON_TAG COMPILER_TAG; do
  value="${!name:-}"
  [[ -n "$value" ]] || { echo "set $name to a reviewed image tag" >&2; exit 2; }
  raw="$(docker buildx imagetools inspect "$value" --raw)"
  digest="$(printf '%s' "$raw" | jq -er '[.manifests[]? | select(.platform.os=="linux" and .platform.architecture=="arm64")] | if length == 1 then .[0].digest else error("requires exactly one ARM64 manifest") end')"
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "$name has no unambiguous ARM64 manifest" >&2; exit 2; }
  printf '%s_IMAGE=%s@%s\n' "${name%_TAG}" "${value%%@*}" "$digest"
done

