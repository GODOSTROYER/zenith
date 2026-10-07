# shellcheck shell=bash
# Shared helpers for the Kubernetes lifecycle acceptance scripts. Sourced, never run.

k8s_die() {
  echo "error: $1" >&2
  exit "${2:-1}"
}

k8s_require() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || k8s_die "required tool not found: $tool" 2
  done
}

k8s_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# The only cluster names these scripts will create or delete. A fixed prefix means a
# typo or a stray environment variable can never aim a delete at someone's cluster.
k8s_cluster_name() {
  local name="${ZENITH_KIND_CLUSTER_NAME:-zenith-life07}"
  [[ "$name" =~ ^zenith-life07(-[a-z0-9]{1,20})?$ ]] || k8s_die "cluster name must be zenith-life07 or zenith-life07-<suffix> (got: $name)" 2
  printf '%s' "$name"
}

# k8s_version_ge A B: success when version A >= version B (dotted numerics).
k8s_version_ge() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

# Minor version numbers of the kubectl client and the API server of the current context.
k8s_minor_versions() {
  local json
  json="$(kubectl version -o json 2>/dev/null)" || k8s_die "kubectl could not reach the cluster" 3
  printf '%s' "$json" | grep -o '"minor": *"[0-9]*' | grep -o '[0-9]*$' | tr '\n' ' '
}

# kubectl supports a server within one minor version of the client either way.
k8s_check_skew() {
  local minors client server
  minors="$(k8s_minor_versions)"
  client="$(echo "$minors" | awk '{print $1}')"
  server="$(echo "$minors" | awk '{print $2}')"
  [ -n "$client" ] && [ -n "$server" ] || k8s_die "could not read kubectl client/server versions" 3
  local diff=$((client - server))
  [ "${diff#-}" -le 1 ] || k8s_die "kubectl 1.$client and API server 1.$server are outside the supported one-minor skew; use a matching kubectl" 3
}
