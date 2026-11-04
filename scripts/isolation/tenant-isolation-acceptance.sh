#!/usr/bin/env bash
# Run the PROD-MAN-04 / PROD-MAN-05 tenant isolation acceptance against a real cluster.
#
#   scripts/isolation/tenant-isolation-acceptance.sh kind-calico     create kind + Calico, run, delete
#   scripts/isolation/tenant-isolation-acceptance.sh kind-cilium     create kind + Cilium, run, delete (needs scripts/isolation/cilium.env pins)
#   scripts/isolation/tenant-isolation-acceptance.sh kind-existing   run against the kind cluster in $KUBECONFIG
#
# kind-calico proves everything except hostname egress (Calico open source has no hostname policy; the suite
# records that check as skipped, never as passed). kind-cilium proves hostname egress as well. Both build the
# cluster with a kubelet podPidsLimit, which the PID-exhaustion check needs.
#
# Needs: kind, docker, kubectl, npx (Node 22); helm for kind-cilium. It creates only namespaces named
# zt-*, zenith-iso-* and (if absent) zenith-system, labelled zenith.dev/acceptance-run=<id>, plus two
# ClusterRoles and bindings with the same label, and removes them by that label. A cluster named
# zenith-life07-iso (or ZENITH_KIND_CLUSTER_NAME=zenith-life07-<suffix>) is created and deleted; nothing else is.
#
# Evidence: $ZENITH_ISOLATION_EVIDENCE_OUT (default ./.data-isolation-evidence) holds isolation-evidence.json
# (cluster, engine, one record per check, the measured latencies) and the vitest JSON report. No kubeconfig,
# token or server address is written.
#
# Environment:
#   ZENITH_K8S_KEEP=1                          keep the kind cluster after the run
#   ZENITH_TEST_ISOLATION_LATENCY_FACTOR       provisional bound factor on the victim's p95 (default 5)
#   ZENITH_TEST_ISOLATION_LATENCY_ABS_MS       provisional absolute allowance in ms (default 250)
#   ZENITH_TEST_ISOLATION_CONTROL=1            also measure an unbounded neighbour (recorded, not asserted)
#   ZENITH_TEST_ISOLATION_RUNTIME_CLASS        a RuntimeClass the cluster serves (kind has none; used on a gVisor/Kata node pool)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
# shellcheck source=scripts/k8s/images.env
. "$here/../k8s/images.env"
# shellcheck source=scripts/k8s/lib.sh
. "$here/../k8s/lib.sh"

mode="${1:-}"
case "$mode" in
  kind-calico | kind-cilium | kind-existing) ;;
  *) k8s_die "usage: tenant-isolation-acceptance.sh kind-calico|kind-cilium|kind-existing" 2 ;;
esac
k8s_require npx kubectl

export ZENITH_KIND_CLUSTER_NAME="${ZENITH_KIND_CLUSTER_NAME:-zenith-life07-iso}"
evidence_dir="${ZENITH_ISOLATION_EVIDENCE_OUT:-$repo/.data-isolation-evidence}"
mkdir -p "$evidence_dir"

cleanup() {
  local code=$?
  if [ "$mode" != "kind-existing" ] && [ "${ZENITH_K8S_KEEP:-0}" != "1" ]; then
    "$here/../k8s/kind-calico-down.sh" || echo "warning: kind-calico-down.sh failed; remove cluster $(k8s_cluster_name) by hand" >&2
  fi
  exit "$code"
}

case "$mode" in
  kind-calico)
    trap cleanup EXIT
    export ZENITH_K8S_WORKDIR="${ZENITH_K8S_WORKDIR:-$(mktemp -d "${TMPDIR:-/tmp}/zenith-life07.XXXXXX")}"
    ZENITH_KIND_CONFIG="$here/kind-isolation.config.yaml" "$here/../k8s/kind-calico-up.sh"
    export KUBECONFIG="$ZENITH_K8S_WORKDIR/kubeconfig"
    ;;
  kind-cilium)
    trap cleanup EXIT
    export ZENITH_K8S_WORKDIR="${ZENITH_K8S_WORKDIR:-$(mktemp -d "${TMPDIR:-/tmp}/zenith-life07.XXXXXX")}"
    "$here/kind-cilium-up.sh"
    export KUBECONFIG="$ZENITH_K8S_WORKDIR/kubeconfig"
    ;;
  kind-existing)
    [ -n "${KUBECONFIG:-}" ] || k8s_die "kind-existing needs KUBECONFIG pointing at a disposable kind cluster" 2
    ;;
esac

context="$(kubectl config current-context)"
[[ "$context" =~ ^kind-zenith-life07(-[a-z0-9]{1,20})?$ ]] || k8s_die "refusing: the current context is '$context'; this suite only runs against a kind cluster named zenith-life07*" 2
k8s_check_skew

export ZENITH_TEST_TENANT_ISOLATION=1
export ZENITH_TEST_ISOLATION_PROFILE="$mode"
export ZENITH_TEST_K8S_IMAGE="$ACCEPTANCE_IMAGE"
export ZENITH_TEST_ISOLATION_MUTATE_COREDNS=1
export ZENITH_TEST_ISOLATION_EVIDENCE_OUT="$evidence_dir/isolation-evidence.json"

cd "$repo"
npx vitest run --maxWorkers=1 --reporter=default --reporter=json --outputFile.json="$evidence_dir/vitest-report.json" \
  tests/isolation/tenant-isolation-acceptance.test.ts

echo "evidence: $evidence_dir"
