#!/usr/bin/env bash
# Delete the cluster kind-calico-up.sh created, and only that cluster.
#
#   ZENITH_K8S_WORKDIR=<dir printed by up> scripts/k8s/kind-calico-down.sh
#
# The cluster name is validated against the fixed zenith-life07 prefix before anything
# is deleted. The work directory (kubeconfig, Calico manifest) is removed only if it
# contains the marker file kind-calico-up.sh wrote, so a mistyped path cannot remove
# an unrelated directory.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/k8s/lib.sh
. "$here/lib.sh"

name="$(k8s_cluster_name)"
k8s_require kind

if kind get clusters 2>/dev/null | grep -qx "$name"; then
  echo "deleting kind cluster $name"
  kind delete cluster --name "$name"
else
  echo "no kind cluster named $name"
fi

workdir="${ZENITH_K8S_WORKDIR:-}"
if [ -n "$workdir" ]; then
  if [ -f "$workdir/zenith-life07.marker" ]; then
    rm -rf -- "$workdir"
    echo "removed $workdir"
  else
    echo "left $workdir alone: it has no zenith-life07.marker" >&2
  fi
fi
