# MAN-04: J11 Cilium chart pin seam

The accepted isolation/runtime implementation is being integrated from Wave 5 and J14. J11 owns only the chart pin in
`deploy/zenith-managed/cilium.env`. It begins empty with a visible TODO: a version/digest cannot be attested offline.
The resolver requires an explicit exact version, pulls the real official Helm archive, checks chart name/version through
`helm show chart`, hashes the archive bytes, and only then writes version, URL and SHA-256. Contract tests inject clearly
labelled offline bytes; they never claim that a chart booted or that two tenants were isolated.

Small join interface: `CILIUM_CHART_VERSION`, `CILIUM_CHART_SHA256` (64 lower-case hex, without prefix),
`CILIUM_CHART_URL=https://helm.cilium.io/cilium-<version>.tgz`. The Wave 5 installer must refuse empty/malformed pins,
download this URL, compare archive SHA-256 **before** `helm install`, and consume this exact archive. PLAN-100 also names
`scripts/isolation/cilium.env`; the assembler must make that seam read this owned file rather than copying a floating pin.

## Exact Mac commands

Prerequisites: Helm 3, kind, kubectl, Docker Desktop with 4 GiB, Node 22, and a version the verifier has checked against its
kind Kubernetes/kernel/ARM64 compatibility. No compatible version is asserted by this offline builder.

```bash
# Required verifier selection; empty values fail, never default to latest.
: "${CILIUM_VERSION:?Set an exact compatible X.Y.Z chart version}"
PIN_DIR="$(mktemp -d -t zenith-j11-cilium)"
helm pull cilium --repo https://helm.cilium.io --version "$CILIUM_VERSION" --destination "$PIN_DIR"
helm show chart "$PIN_DIR/cilium-$CILIUM_VERSION.tgz"
shasum -a 256 "$PIN_DIR/cilium-$CILIUM_VERSION.tgz"
ZENITH_RESOLVE_DEPLOY_PINS=1 node scripts/deploy/pin-digests.mjs --resolve --scope cilium --cilium-version "$CILIUM_VERSION"
set -a
source deploy/zenith-managed/cilium.env
set +a
curl --fail --location --proto '=https' --tlsv1.2 "$CILIUM_CHART_URL" -o "$PIN_DIR/cilium-$CILIUM_CHART_VERSION.tgz"
printf '%s  %s\n' "$CILIUM_CHART_SHA256" "$PIN_DIR/cilium-$CILIUM_CHART_VERSION.tgz" | shasum -a 256 --check
helm show chart "$PIN_DIR/cilium-$CILIUM_CHART_VERSION.tgz"
# Use only the verifier's positively owned kind context, already created with default CNI disabled.
: "${J11_KIND_CONTEXT:?Set the owned kind context}"
case "$J11_KIND_CONTEXT" in kind-zenith-j11-*) ;; *) exit 1 ;; esac
J11_KUBE_SERVER="$(kubectl --context "$J11_KIND_CONTEXT" config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
case "$J11_KUBE_SERVER" in https://127.0.0.1:*) ;; *) exit 1 ;; esac
helm --kube-context "$J11_KIND_CONTEXT" install cilium "$PIN_DIR/cilium-$CILIUM_CHART_VERSION.tgz" --namespace kube-system --set operator.replicas=1 --set hubble.enabled=false --set prometheus.enabled=false --wait --timeout 5m
kubectl --context "$J11_KIND_CONTEXT" -n kube-system rollout status daemonset/cilium --timeout=300s
kubectl --context "$J11_KIND_CONTEXT" -n kube-system rollout status deployment/cilium-operator --timeout=300s
kubectl --context "$J11_KIND_CONTEXT" get nodes
```

Lean profile: one control-plane kind node, one Cilium operator, Hubble/Prometheus disabled, no observability harness at
the same time; keep the existing PodSecurity/CNI/metadata/FQDN isolation tests intact. Initial chart pull/re-pull hashes
must match. Expected: exact archive installed, Cilium rolls out, owned node Ready. A different/corrupt archive must fail
before installation. The Wave 5 two-tenant suite must additionally prove route/storage/CNI/metadata/FQDN-egress/pod
security/quota/operator separation; J14 must execute the sandboxed runtime evaluation. Their test entry points are absent
from this base and require integration, so no substitute suite is invented. Full MAN-04 acceptance stays pending.

**Not run (needs resolved chart, Docker/kind and integrated Wave 5/J14 on Mac).** Live managed cluster acceptance is
deferred. No runtime, onboarding, tenant policy, migration or aggregate SQL changes; ledger status covers only J11's slice.
