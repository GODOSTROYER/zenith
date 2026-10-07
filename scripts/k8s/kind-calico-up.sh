#!/usr/bin/env bash
# Create the disposable kind + Calico cluster for the PROD-LIFE-07 acceptance profile.
#
#   scripts/k8s/kind-calico-up.sh
#
# What it does, in order, and refuses at each step rather than improvising:
#   1. checks kind >= KIND_MIN_VERSION, docker and kubectl are present
#   2. refuses if a cluster of the same name exists (it never reuses or adopts one)
#   3. creates the cluster from kind-calico.config.yaml: pinned node image, default CNI off
#   4. downloads the Calico manifest from its release tag, refuses unless its sha256
#      equals CALICO_MANIFEST_SHA256, rewrites every image to its pinned digest and
#      refuses if any image reference is left without a digest
#   5. applies it (server-side), waits for the nodes, Calico and DNS
#
# The kubeconfig is written to a private temporary directory, never merged into
# ~/.kube/config. The last lines it prints are the exports the acceptance run needs.
# Remove everything with scripts/k8s/kind-calico-down.sh.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/k8s/images.env
. "$here/images.env"
# shellcheck source=scripts/k8s/lib.sh
. "$here/lib.sh"

name="$(k8s_cluster_name)"
k8s_require kind kubectl docker curl

kind_version="$(kind version | grep -o 'v[0-9][0-9.]*' | head -n1 | sed 's/^v//')"
[ -n "$kind_version" ] || k8s_die "could not read the kind version" 2
k8s_version_ge "$kind_version" "$KIND_MIN_VERSION" || k8s_die "kind $kind_version is older than the required $KIND_MIN_VERSION" 2

if kind get clusters 2>/dev/null | grep -qx "$name"; then
  k8s_die "a kind cluster named $name already exists; run scripts/k8s/kind-calico-down.sh first (this script never reuses a cluster)" 3
fi

workdir="${ZENITH_K8S_WORKDIR:-}"
if [ -z "$workdir" ]; then
  workdir="$(mktemp -d "${TMPDIR:-/tmp}/zenith-life07.XXXXXX")"
fi
mkdir -p "$workdir"
chmod 700 "$workdir"
: >"$workdir/zenith-life07.marker"
kubeconfig="$workdir/kubeconfig"
rm -f "$kubeconfig"

echo "creating kind cluster $name (node image pinned by digest)"
kind create cluster --name "$name" --config "$here/kind-calico.config.yaml" --kubeconfig "$kubeconfig" --wait 0s
chmod 600 "$kubeconfig"
export KUBECONFIG="$kubeconfig"

echo "fetching Calico $CALICO_VERSION and verifying its checksum"
manifest="$workdir/calico.yaml"
curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$manifest" "$CALICO_MANIFEST_URL"
actual="$(k8s_sha256 "$manifest")"
if [ "$actual" != "$CALICO_MANIFEST_SHA256" ]; then
  echo "calico manifest sha256 mismatch: expected $CALICO_MANIFEST_SHA256 got $actual" >&2
  echo "the cluster $name was created but Calico was NOT applied; remove it with scripts/k8s/kind-calico-down.sh" >&2
  exit 4
fi

pinned="$workdir/calico.pinned.yaml"
sed \
  -e "s|image: quay.io/calico/cni:${CALICO_VERSION}[[:space:]]*\$|image: ${CALICO_CNI_IMAGE}|" \
  -e "s|image: quay.io/calico/node:${CALICO_VERSION}[[:space:]]*\$|image: ${CALICO_NODE_IMAGE}|" \
  -e "s|image: quay.io/calico/kube-controllers:${CALICO_VERSION}[[:space:]]*\$|image: ${CALICO_KUBE_CONTROLLERS_IMAGE}|" \
  "$manifest" >"$pinned"
if grep -E '^[[:space:]]*image:' "$pinned" | grep -v '@sha256:' >/dev/null; then
  echo "refusing: the Calico manifest still names an image without a digest:" >&2
  grep -E '^[[:space:]]*image:' "$pinned" | grep -v '@sha256:' >&2
  exit 4
fi

echo "applying Calico"
kubectl apply --server-side --field-manager=zenith-life07 -f "$pinned"

echo "waiting for Calico, the nodes and DNS"
kubectl -n kube-system rollout status daemonset/calico-node --timeout=300s
kubectl -n kube-system rollout status deployment/calico-kube-controllers --timeout=300s
kubectl wait --for=condition=Ready node --all --timeout=300s
kubectl -n kube-system rollout status deployment/coredns --timeout=300s
k8s_check_skew

echo
echo "cluster $name is ready. For the acceptance run:"
echo "  export KUBECONFIG=$kubeconfig"
echo "  export ZENITH_K8S_WORKDIR=$workdir"
echo "  export ZENITH_TEST_K8S_PROFILE=kind-calico"
echo "  export ZENITH_TEST_K8S_LIFECYCLE=1"
echo "  export ZENITH_TEST_K8S_IMAGE=$ACCEPTANCE_IMAGE"
echo "Remove it with: ZENITH_K8S_WORKDIR=$workdir scripts/k8s/kind-calico-down.sh"
