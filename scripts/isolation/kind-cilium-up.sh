#!/usr/bin/env bash
# Create the disposable kind + Cilium cluster for the hostname-egress half of the PROD-MAN-04 acceptance.
#
#   scripts/isolation/kind-cilium-up.sh
#
# Same rails as scripts/k8s/kind-calico-up.sh and the same cluster-name rule (zenith-life07[-suffix]), so
# scripts/k8s/kind-calico-down.sh removes what this creates:
#   1. checks kind, docker, kubectl, helm and curl are present; kind >= KIND_MIN_VERSION
#   2. refuses unless ZENITH_CILIUM_CHART_VERSION and ZENITH_CILIUM_CHART_SHA256 are set (scripts/isolation/cilium.env)
#   3. refuses if a cluster of the same name exists (it never reuses or adopts one)
#   4. creates the cluster from kind-isolation.config.yaml: pinned node image, default CNI off, podPidsLimit set
#   5. downloads the chart, refuses a checksum mismatch, refuses a render that names an image without a digest
#   6. installs it and waits for the nodes, Cilium and DNS
#
# The kubeconfig is written to a private temporary directory, never merged into ~/.kube/config.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/k8s/images.env
. "$here/../k8s/images.env"
# The file holds deliberately empty defaults; a value already in the environment wins over them.
env_chart_version="${ZENITH_CILIUM_CHART_VERSION:-}"
env_chart_sha256="${ZENITH_CILIUM_CHART_SHA256:-}"
# shellcheck source=scripts/isolation/cilium.env
. "$here/cilium.env"
ZENITH_CILIUM_CHART_VERSION="${env_chart_version:-${ZENITH_CILIUM_CHART_VERSION:-}}"
ZENITH_CILIUM_CHART_SHA256="${env_chart_sha256:-${ZENITH_CILIUM_CHART_SHA256:-}}"
# shellcheck source=scripts/k8s/lib.sh
. "$here/../k8s/lib.sh"

: "${ZENITH_CILIUM_CHART_VERSION:?set ZENITH_CILIUM_CHART_VERSION (see scripts/isolation/cilium.env); it is deliberately not guessed}"
: "${ZENITH_CILIUM_CHART_SHA256:?set ZENITH_CILIUM_CHART_SHA256 (see scripts/isolation/cilium.env); it is deliberately not guessed}"
[[ "$ZENITH_CILIUM_CHART_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || k8s_die "ZENITH_CILIUM_CHART_VERSION must look like 1.2.3" 2
[[ "$ZENITH_CILIUM_CHART_SHA256" =~ ^[a-f0-9]{64}$ ]] || k8s_die "ZENITH_CILIUM_CHART_SHA256 must be 64 lowercase hex characters" 2

name="$(k8s_cluster_name)"
k8s_require kind kubectl docker curl helm

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

echo "creating kind cluster $name (node image pinned by digest, podPidsLimit set)"
kind create cluster --name "$name" --config "$here/kind-isolation.config.yaml" --kubeconfig "$kubeconfig" --wait 0s
chmod 600 "$kubeconfig"
export KUBECONFIG="$kubeconfig"

chart="$workdir/cilium-$ZENITH_CILIUM_CHART_VERSION.tgz"
echo "fetching Cilium chart $ZENITH_CILIUM_CHART_VERSION and verifying its checksum"
curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$chart" "https://helm.cilium.io/cilium-$ZENITH_CILIUM_CHART_VERSION.tgz"
actual="$(k8s_sha256 "$chart")"
if [ "$actual" != "$ZENITH_CILIUM_CHART_SHA256" ]; then
  echo "cilium chart sha256 mismatch: expected $ZENITH_CILIUM_CHART_SHA256 got $actual" >&2
  echo "the cluster $name was created but Cilium was NOT installed; remove it with scripts/k8s/kind-calico-down.sh" >&2
  exit 4
fi

values=(--namespace kube-system --set ipam.mode=kubernetes --set operator.replicas=1 --set kubeProxyReplacement=false --set hubble.enabled=false --set image.pullPolicy=IfNotPresent)
rendered="$workdir/cilium.rendered.yaml"
helm template cilium "$chart" "${values[@]}" >"$rendered"
if grep -E '^[[:space:]]*image:' "$rendered" | grep -v '@sha256:' >/dev/null; then
  echo "refusing: the rendered chart still names an image without a digest:" >&2
  grep -E '^[[:space:]]*image:' "$rendered" | grep -v '@sha256:' >&2
  exit 4
fi

echo "installing Cilium"
helm install cilium "$chart" "${values[@]}" --wait --timeout 10m

echo "waiting for the nodes and DNS"
kubectl wait --for=condition=Ready node --all --timeout=300s
kubectl -n kube-system rollout status daemonset/cilium --timeout=300s
kubectl -n kube-system rollout status deployment/coredns --timeout=300s
k8s_check_skew

echo
echo "cluster $name is ready. For the acceptance run:"
echo "  export KUBECONFIG=$kubeconfig"
echo "  export ZENITH_K8S_WORKDIR=$workdir"
echo "Remove it with: ZENITH_K8S_WORKDIR=$workdir scripts/k8s/kind-calico-down.sh"
