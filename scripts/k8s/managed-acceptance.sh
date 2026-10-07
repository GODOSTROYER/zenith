#!/usr/bin/env bash
# Run the Kubernetes lifecycle acceptance against a supported MANAGED cluster
# (EKS, GKE, AKS or OKE). PROD-LIFE-07's live managed-cluster acceptance is deferred:
# this harness exists so that, when a cluster is available, running it is one command
# and its evidence is the same shape as the kind+Calico profile.
#
#   export KUBECONFIG=<private kubeconfig for the cluster>
#   export ZENITH_MANAGED_K8S_PROVIDER=eks|gke|aks|oke
#   export ZENITH_MANAGED_K8S_CONTEXT=<the exact current kubeconfig context name>
#   export ZENITH_MANAGED_K8S_CONFIRM=create-and-delete-namespaces
#   scripts/k8s/managed-acceptance.sh
#
# What it will and will not do:
#   - It never creates or deletes a cluster, node pool, load balancer or volume class.
#   - The tests create two namespaces named zenith-l7-<random> and zenith-l7n-<random> and
#     only work inside them. Persistent volumes bind through the cluster's own storage
#     class, so they cost what the cluster's volumes cost for a few minutes. Teardown
#     removes every Zenith-owned object; the two namespaces are deleted at the end.
#   - It refuses to run unless the current context is exactly ZENITH_MANAGED_K8S_CONTEXT
#     and the confirmation phrase is set, so a stray KUBECONFIG cannot aim it at the
#     wrong cluster. It refuses kind and local-desktop contexts (use lifecycle-acceptance.sh).
#
# Cluster prerequisites that decide which assertions are required:
#   NetworkPolicy enforcement   needs an enforcing engine: EKS with the VPC CNI network
#                               policy agent (or Calico/Cilium), GKE with Dataplane V2 or
#                               network policy enabled, AKS with Azure NPM/Calico/Cilium,
#                               OKE with Calico or Cilium installed. Set
#                               ZENITH_TEST_K8S_EXPECT_NETPOL=0 only to record a cluster
#                               that has none: enforcement is then reported as
#                               "not_expected", never as passed.
#   Volume snapshots            set ZENITH_TEST_K8S_EXPECT_SNAPSHOTS=1 when the CSI
#                               snapshot controller and a VolumeSnapshotClass are
#                               installed (the run then requires snapshot and restore to
#                               work), 0 when they are not (the run then requires the
#                               refusal), or leave it unset to accept and record either.
#   ZENITH_TEST_K8S_STORAGE_CLASS  claims use this class (default: the cluster default).
#   ZENITH_TEST_K8S_IMAGE       digest-pinned acceptance image; defaults to the pinned
#                               busybox in images.env. The cluster must be able to pull it.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
# shellcheck source=scripts/k8s/images.env
. "$here/images.env"
# shellcheck source=scripts/k8s/lib.sh
. "$here/lib.sh"

k8s_require npx kubectl

provider="${ZENITH_MANAGED_K8S_PROVIDER:-}"
case "$provider" in
  eks | gke | aks | oke) ;;
  *) k8s_die "set ZENITH_MANAGED_K8S_PROVIDER to eks, gke, aks or oke" 2 ;;
esac
[ -n "${KUBECONFIG:-}" ] || k8s_die "set KUBECONFIG to a private kubeconfig for the cluster" 2
[ -f "$KUBECONFIG" ] || k8s_die "KUBECONFIG does not name a file" 2
[ "${ZENITH_MANAGED_K8S_CONFIRM:-}" = "create-and-delete-namespaces" ] || k8s_die "set ZENITH_MANAGED_K8S_CONFIRM=create-and-delete-namespaces to confirm the run may create and delete its own namespaces" 2

expected_context="${ZENITH_MANAGED_K8S_CONTEXT:-}"
[ -n "$expected_context" ] || k8s_die "set ZENITH_MANAGED_K8S_CONTEXT to the exact context name you intend to use" 2
current_context="$(kubectl config current-context)"
[ "$current_context" = "$expected_context" ] || k8s_die "the current context is not ZENITH_MANAGED_K8S_CONTEXT; refusing to run" 3
case "$current_context" in
  kind-* | docker-desktop* | minikube* | rancher-desktop* | colima*) k8s_die "this looks like a local cluster; use scripts/k8s/lifecycle-acceptance.sh" 3 ;;
esac

k8s_check_skew

evidence_dir="${ZENITH_K8S_EVIDENCE_OUT:-$repo/.data-k8s-evidence}"
mkdir -p "$evidence_dir"

export ZENITH_TEST_K8S_LIFECYCLE=1
export ZENITH_TEST_K8S_PROFILE="managed:$provider"
export ZENITH_TEST_K8S_IMAGE="${ZENITH_TEST_K8S_IMAGE:-$ACCEPTANCE_IMAGE}"
export ZENITH_TEST_K8S_EVIDENCE_OUT="$evidence_dir/managed-$provider-evidence.json"
export ZENITH_MANAGED_K8S_CONTEXT="$expected_context"

cd "$repo"
npx vitest run --maxWorkers=1 --reporter=default --reporter=json --outputFile.json="$evidence_dir/managed-$provider-vitest-report.json" \
  tests/providers/kubernetes/lifecycle-acceptance.test.ts

echo "evidence: $evidence_dir"
