#!/usr/bin/env bash
# Run the Kubernetes full-lifecycle acceptance against a real cluster (PROD-LIFE-07).
#
#   scripts/k8s/lifecycle-acceptance.sh kind-calico     create kind+Calico, run, delete
#   scripts/k8s/lifecycle-acceptance.sh kind-existing   run against the cluster in $KUBECONFIG
#
# The managed-cluster form (EKS, GKE, AKS, OKE) is scripts/k8s/managed-acceptance.sh.
#
# What runs (tests/providers/kubernetes):
#   lifecycle-acceptance.test.ts  StatefulSet (ordered rollout, persistent data, retention,
#                                 rollback, scale), CronJob (schedule, concurrency, history,
#                                 failure readback), snapshot/restore or its refusal,
#                                 NetworkPolicy enforcement with real traffic, readback for
#                                 each kind, ownership-respecting teardown
#   kind.test.ts, release-kind.test.ts  the existing provider and release suites, on the
#                                 same cluster
#
# Evidence is written to $ZENITH_K8S_EVIDENCE_OUT (default: ./.data-k8s-evidence) as JSON:
# profile, server version, detected policy engine and one result per area. It contains no
# kubeconfig, token or server address.
#
# Environment:
#   ZENITH_K8S_KEEP=1                 keep the kind cluster after the run (kind-calico)
#   ZENITH_TEST_K8S_STORAGE_CLASS     storage class for claims (default: the cluster default)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
# shellcheck source=scripts/k8s/images.env
. "$here/images.env"
# shellcheck source=scripts/k8s/lib.sh
. "$here/lib.sh"

mode="${1:-}"
case "$mode" in
  kind-calico | kind-existing) ;;
  *) k8s_die "usage: lifecycle-acceptance.sh kind-calico|kind-existing" 2 ;;
esac
k8s_require npx kubectl

evidence_dir="${ZENITH_K8S_EVIDENCE_OUT:-$repo/.data-k8s-evidence}"
mkdir -p "$evidence_dir"

cleanup() {
  local code=$?
  if [ "$mode" = "kind-calico" ] && [ "${ZENITH_K8S_KEEP:-0}" != "1" ]; then
    "$here/kind-calico-down.sh" || echo "warning: kind-calico-down.sh failed; remove cluster $(k8s_cluster_name) by hand" >&2
  fi
  exit "$code"
}

if [ "$mode" = "kind-calico" ]; then
  trap cleanup EXIT
  export ZENITH_K8S_WORKDIR="${ZENITH_K8S_WORKDIR:-$(mktemp -d "${TMPDIR:-/tmp}/zenith-life07.XXXXXX")}"
  "$here/kind-calico-up.sh"
  export KUBECONFIG="$ZENITH_K8S_WORKDIR/kubeconfig"
  export ZENITH_TEST_K8S_PROFILE=kind-calico
else
  [ -n "${KUBECONFIG:-}" ] || k8s_die "kind-existing needs KUBECONFIG pointing at a disposable kind cluster" 2
  export ZENITH_TEST_K8S_PROFILE=kind-calico
fi

k8s_check_skew

export ZENITH_TEST_K8S_LIFECYCLE=1
export ZENITH_TEST_K8S_IMAGE="$ACCEPTANCE_IMAGE"
export ZENITH_TEST_K8S_EVIDENCE_OUT="$evidence_dir/lifecycle-evidence.json"
# The existing kind suites share the cluster and the digest-pinned image.
export ZENITH_TEST_KIND=1
export ZENITH_TEST_KIND_RELEASE_IMAGE="$ACCEPTANCE_IMAGE"

cd "$repo"
npx vitest run --maxWorkers=1 --reporter=default --reporter=json --outputFile.json="$evidence_dir/vitest-report.json" \
  tests/providers/kubernetes/lifecycle-acceptance.test.ts \
  tests/providers/kubernetes/kind.test.ts \
  tests/providers/kubernetes/release-kind.test.ts

echo "evidence: $evidence_dir"
