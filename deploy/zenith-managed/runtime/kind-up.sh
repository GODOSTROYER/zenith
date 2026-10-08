#!/usr/bin/env bash
# Offline, pinned, single-node Cilium + gVisor profile for the Mac verifier.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
. "$repo/scripts/k8s/images.env"
. "$repo/scripts/k8s/lib.sh"
# J11 owns the Cilium pin. Explicit verifier inputs override that integration file.
if [ -f "$repo/deploy/zenith-managed/cilium.env" ]; then
  saved_version="${ZENITH_CILIUM_CHART_VERSION:-}"
  saved_sha="${ZENITH_CILIUM_CHART_SHA256:-}"
  . "$repo/deploy/zenith-managed/cilium.env"
  export ZENITH_CILIUM_CHART_VERSION="${saved_version:-${ZENITH_CILIUM_CHART_VERSION:-}}"
  export ZENITH_CILIUM_CHART_SHA256="${saved_sha:-${ZENITH_CILIUM_CHART_SHA256:-}}"
fi
k8s_require node npx kind docker kubectl helm bzip2
: "${ZENITH_CILIUM_CHART_ARCHIVE:?supply the locally downloaded pinned Cilium chart}"
: "${ZENITH_CILIUM_CHART_VERSION:?supply J11's released chart version}"
: "${ZENITH_CILIUM_CHART_SHA256:?supply J11's reviewed chart SHA-256}"
: "${ZENITH_GVISOR_ARCHIVE:?supply the complete publisher gVisor tar.bz2 for Linux aarch64 on the Mac}"
: "${ZENITH_GVISOR_SHA256:?supply its publisher SHA-256}"
: "${ZENITH_GVISOR_RELEASE:?supply the exact publisher point release, YYYYMMDD.N}"
[[ "$ZENITH_CILIUM_CHART_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || k8s_die "invalid Cilium version" 2
[[ "$ZENITH_CILIUM_CHART_SHA256" =~ ^[a-f0-9]{64}$ ]] || k8s_die "invalid Cilium checksum" 2
[[ "$ZENITH_GVISOR_SHA256" =~ ^[a-f0-9]{64}$ ]] || k8s_die "invalid gVisor checksum" 2
[[ "$ZENITH_GVISOR_RELEASE" =~ ^[0-9]{8}\.[0-9]+$ ]] || k8s_die "invalid gVisor point release" 2
[ "$(k8s_sha256 "$ZENITH_CILIUM_CHART_ARCHIVE")" = "$ZENITH_CILIUM_CHART_SHA256" ] || k8s_die "Cilium checksum mismatch" 4
[ "$(k8s_sha256 "$ZENITH_GVISOR_ARCHIVE")" = "$ZENITH_GVISOR_SHA256" ] || k8s_die "gVisor checksum mismatch" 4
export ZENITH_KIND_CLUSTER_NAME="${ZENITH_KIND_CLUSTER_NAME:-zenith-life07-j14}"
name="$(k8s_cluster_name)"
if kind get clusters | grep -qx "$name"; then k8s_die "cluster already exists; never reuse or adopt it" 3; fi
export ZENITH_K8S_WORKDIR="${ZENITH_K8S_WORKDIR:-$(mktemp -d "${TMPDIR:-/tmp}/zenith-j14.XXXXXX")}"
[ ! -e "$ZENITH_K8S_WORKDIR/zenith-j14.marker" ] || k8s_die "installation directory already owned; use a fresh directory" 3
mkdir -p "$ZENITH_K8S_WORKDIR"
chmod 700 "$ZENITH_K8S_WORKDIR"
export KUBECONFIG="$ZENITH_K8S_WORKDIR/kubeconfig"
[ ! -e "$KUBECONFIG" ] || k8s_die "refusing to overwrite a kubeconfig" 3
printf '%s\n' "$name" > "$ZENITH_K8S_WORKDIR/zenith-j14.marker"
# The existing cleanup script additionally requires its own ownership marker.
touch "$ZENITH_K8S_WORKDIR/zenith-life07.marker"
kind create cluster --name "$name" --image "$KIND_NODE_IMAGE" --config "$here/kind-lean.yaml" --kubeconfig "$KUBECONFIG" --wait 0s
chmod 600 "$KUBECONFIG"
values=(--namespace kube-system --set ipam.mode=kubernetes --set operator.replicas=1 --set kubeProxyReplacement=false --set hubble.enabled=false --set image.pullPolicy=IfNotPresent --set resources.requests.cpu=50m --set resources.requests.memory=256Mi --set operator.resources.requests.cpu=50m --set operator.resources.requests.memory=64Mi)
helm show chart "$ZENITH_CILIUM_CHART_ARCHIVE" | grep -qx "version: $ZENITH_CILIUM_CHART_VERSION" || k8s_die "chart version differs from reviewed pin" 4
helm template cilium "$ZENITH_CILIUM_CHART_ARCHIVE" "${values[@]}" > "$ZENITH_K8S_WORKDIR/cilium.rendered.yaml"
if ! grep -E '^[[:space:]]*image:' "$ZENITH_K8S_WORKDIR/cilium.rendered.yaml" >/dev/null || grep -E '^[[:space:]]*image:' "$ZENITH_K8S_WORKDIR/cilium.rendered.yaml" | grep -v '@sha256:' >/dev/null; then
  k8s_die "Cilium rendering contains no images or an unpinned image" 4
fi
helm install cilium "$ZENITH_CILIUM_CHART_ARCHIVE" "${values[@]}" --wait --timeout 10m
kubectl wait --for=condition=Ready node --all --timeout=300s
kubectl -n kube-system rollout status deployment/coredns --timeout=300s
cd "$repo"
ZENITH_TEST_GVISOR_INSTALL=1 npx tsx "$here/setup-kind.ts"
echo "Runtime installed. Keep KUBECONFIG=$KUBECONFIG and ZENITH_K8S_WORKDIR=$ZENITH_K8S_WORKDIR for verification and cleanup."
