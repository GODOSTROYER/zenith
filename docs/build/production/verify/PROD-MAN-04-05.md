# PROD-MAN-04 and PROD-MAN-05 verify notes: two untrusted tenants, resource isolation under load

Built on branch `prod/man-04-05-w5` from `c02c097e`. **Nothing here was executed**: no vitest, no kind, no
cluster, no docker. The only checks run on the building machine were `npx tsc --noEmit -p .` and `npx eslint` on
every changed source and test file, both clean. Every test below was written to run on the verifying machine and
desk-checked against the code; read "Known gaps" for what is most likely to need a fix first.

Live managed-cluster acceptance is deferred by the user. MAN-01 (substrate) and MAN-02/03 (serving) are built
concurrently, so isolation is built as policy and configuration generators plus tests over the existing
primitives (LIFE-07 NetworkPolicy and CNI detection, MACH-02 scoped credentials) and the joins are described, not
wired.

## 1. What was built

Audit first. `src/lib/providers/zenith` already rendered the per-tenant baseline (restricted Pod Security
namespace, default-deny NetworkPolicy, allow-platform policy with a private/link-local exclusion on the only
public rule, ResourceQuota, LimitRange, `zenith-tenant` ServiceAccount with no token) and an isolation gate. Gaps
this work closes:

- no hostname egress allowlist (a NetworkPolicy matches addresses)
- no RuntimeClass hook and no rule about where or how a tenant pod runs (runtime class, priority, node pinning,
  tolerations)
- the namespace quota requires ephemeral-storage requests and limits but the LimitRange gave no default, so a pod
  that named none was refused, and disk exhaustion had no per-container ceiling
- one cluster-wide operator ClusterRole that reads Secrets in every tenant namespace; the application's
  namespace allowlist was the only separation
- no proof by traffic, by request or under load; no sandbox runtime evaluation against a threat model

| File | Change |
|---|---|
| `src/lib/providers/zenith/isolation-profile.ts` (new) | `IsolationProfile` (fqdn engine, platform hostnames, runtime class, operator credential prefix), hostname rule validation (`checkFqdnRule`, `normalizeFqdnRules`), `effectiveFqdns` which REFUSES a hostname request when the engine cannot enforce it, `METADATA_ENDPOINT_CIDRS` |
| `src/lib/providers/zenith/isolation-bundle.ts` (new) | `renderIsolationBundle`: CiliumNetworkPolicy (DNS through the proxy, `toFQDNs` on TCP 443, `egressDeny` over metadata and link-local), system-priority ResourceQuota, per-tenant operator access (ServiceAccount, Role, RoleBinding, by-name namespace ClusterRole and binding); `validateIsolationBundle` / `collectIsolationBundleViolations` / `validateOperatorAccess`; `analyzeOperatorSeparation` (cross-tenant static RBAC analysis); `bundleObjects` (apply order) |
| `src/lib/providers/zenith/substrate.ts` | optional `isolation` profile read from four new variables; `substrateConnectionConfig` resolves `<prefix>/<tenant namespace>` as the session credential when the prefix is set |
| `src/lib/providers/zenith/tenancy.ts` | in hostname mode the baseline renders no "public addresses on 443" rule (DNS and managed DB only); `tenancyMetadata` exported so bundle objects carry identical ownership marks. With no isolation profile the output is byte-identical |
| `src/lib/providers/zenith/isolation.ts` | gate rules `runtime_class` (exactly the mandated class, none when none is mandated), `priority_class`, `node_name`, `tolerations` (wildcard) |
| `src/lib/providers/zenith/render.ts` | stamps the mandated `runtimeClassName` on every tenant pod (`withPodDefaults`), accepts `egressFqdns`, returns and validates `result.isolation` |
| `src/lib/providers/zenith/plans.ts` | ephemeral-storage default, request and ceiling per tier in the LimitRange (see "Behaviour changes") |
| `docs/platform/MANAGED-PLATFORM.md` | four new variables in the pinned table, pointer paragraph |
| `docs/platform/TENANT-ISOLATION.md` (new) | threat model, claim/mechanism/proof matrix, hostname egress limits per CNI, sandbox runtime evaluation (runc, user namespaces, gVisor, Kata/Firecracker, dedicated pools), resource isolation and what is not bounded, operator separation, joins, checklist |
| `deploy/zenith-managed/optional/` (new) | RuntimeClass examples, bootstrap RBAC (placeholder, not in the kustomization), kubelet `podPidsLimit` fragment |
| `scripts/isolation/` (new) | `tenant-isolation-acceptance.sh` (kind-calico, kind-cilium, kind-existing), `kind-isolation.config.yaml` (pinned node image, podPidsLimit 256), `kind-cilium-up.sh`, `cilium.env` (deliberately empty pins), `render-tenant-bundle.ts` (prints a tenant's bundle for the bootstrap identity) |
| `scripts/k8s/kind-calico-up.sh` | one line: `--config "${ZENITH_KIND_CONFIG:-...}"` so the isolation config can be used; default unchanged |
| `tests/isolation/` (new) | `tenant-isolation-acceptance.test.ts` (gated, real cluster), `support.ts` (kubectl helpers), `isolation-profile.test.ts` (static checks, always runs) |
| `tests/providers/zenith/isolation-bundle.test.ts` (new) | generator, gate, separation and wiring tests with no cluster |

### How it is reached

- `renderZenithEnvironment` (the managed provider's real render) now stamps the sandbox class, applies the new gate
  rules, and returns `isolation` (the validated bundle). `apply.ts` is unchanged: it still applies `baseline` and
  `workloads` only.
- `substrateConnectionConfig` (used when a session is opened for a tenant) uses the per-tenant credential
  reference when `ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX` is set.
- The bundle reaches a cluster through `scripts/isolation/render-tenant-bundle.ts` and the acceptance suite, both
  using the bootstrap identity or the admin kubeconfig. **The control plane's own apply path (`apply.ts` of the managed provider) does not apply it; the provisioner in section 8 does.** The original reason stands: the Kubernetes provider's apply set (`KIND_INFO`) has no Cilium kinds and its RBAC validator accepts
  only exact-name workload-identity Roles; widening it would change prune and teardown behaviour that other
  waves verified. The join is MAN-01's apply path calling `bundleObjects(result.isolation)` with the bootstrap
  identity. Until then a Cilium substrate renders a baseline with no public egress and the CiliumNetworkPolicy must
  be applied out of band, or tenants have DNS and nothing else (fail closed); the render notes say so.

## 2. Acceptance mapping

PROD-MAN-04: "Two tenants prove route/storage/CNI/metadata/FQDN-egress/pod security/quota/operator separation;
sandboxed or stronger runtime evaluated against threat model."

| Clause | Implementation | Unit test (no cluster) | Live test (gated, not run) |
|---|---|---|---|
| route | managed suffix rewrite, gate rules `route_hostname` and `route_parent`, operator cannot write HTTPRoute or patch the other namespace | `isolation-bundle.test.ts` "route hijack at the gate", "route hijack through the renderer" | `operator_separation` can-i matrix (httproutes in B, namespace patch of B); Gateway API attachment itself is NOT exercised (CRDs absent on kind) |
| storage | no token, claims namespaced, hostPath refused, object prefixes non-overlapping | `isolation-bundle.test.ts` "storage separation"; `isolation.test.ts` volume rules | "a pod in A that names B's claim never gets B's volume"; workload token reads nothing; hostPath refused at admission |
| CNI | default-deny both directions, ingress from gateway namespace only | `tenancy.test.ts` | cross-tenant probes both ways by IP and by name, same-namespace unlabelled probe, gateway and labelled-client controls; engine must be detected or the suite fails |
| metadata | public rule excludes `169.254.0.0/16` and private ranges; Cilium deny over metadata | `isolation-bundle.test.ts`, `tenancy.test.ts` | a real listener on `169.254.169.254:443` is unreachable while a real listener on a public-looking address is reachable (calico profile), kubelet and API server unreachable |
| FQDN egress | Cilium `toFQDNs` bundle; refusal on engines that cannot enforce | `isolation-bundle.test.ts` "hostname egress", FQDN rule table, substrate fail-closed cases | `hostname_egress`: allowlisted, wildcard, unlisted, name-resolving-to-metadata (kind-cilium only; recorded as skipped on calico, never passed) |
| pod security | namespace `restricted`, gate, placement rules | `isolation.test.ts`, `isolation-bundle.test.ts` "pod placement gate" | twelve adversarial pods refused by the API server, control admitted, system-priority pod refused by quota |
| quota | ResourceQuota, LimitRange, priority quota | `isolation-bundle.test.ts` "resource limits", "priority quota" | ceilings, third pod past CPU quota, secrets past 20, LB, NodePort, PVC on free plan |
| operator separation | per-tenant ServiceAccount, Role, by-name ClusterRole, credential prefix | `isolation-bundle.test.ts` "operator separation" (12 mutations, static analysis, shared identity) | can-i matrix (22 refusals plus control grants) and real tokens |
| sandbox runtime evaluated | `TENANT-ISOLATION.md` section 5; hook `ZENITH_MANAGED_RUNTIME_CLASS`, gate rule | wiring tests (stamp, mismatch refused, none mandated refused) | runs a pod under `ZENITH_TEST_ISOLATION_RUNTIME_CLASS` when set; skipped on kind |

PROD-MAN-05: "noisy-neighbor/resource-exhaustion tests prove bounded tenant impact; namespaces alone do not establish
isolation."

| Clause | Implementation | Test |
|---|---|---|
| CPU, memory, disk, PID exhaustion bounded | LimitRange + quota (ephemeral-storage added), CFS, OOM kill, kubelet eviction, `podPidsLimit` (kind config sets it) | live `noisy neighbour`: CPU hog held to 0.4 core x1.3, memory hog `OOMKilled`, disk hog `Evicted` with an ephemeral message, 3000 fork attempts held at or below 1024 processes |
| other tenant's latency within a bound | victim B served through the gateway namespace path | baseline vs loaded p95, zero dropped requests, no restart, nodes Ready; bound `max(p95 x 5, p95 + 250 ms)` **provisional** |
| namespaces alone are not isolation | every control is named with its enforcer; optional unbounded control (`ZENITH_TEST_ISOLATION_CONTROL=1`) records the unprotected neighbour | recorded, not asserted |

## 3. Verification commands

No cluster needed (run these first; they are the normal-suite tests):

```
npx vitest run tests/providers/zenith tests/isolation/isolation-profile.test.ts tests/providers/kubernetes/lifecycle-profile.test.ts
```

Expected: all pass; `tests/isolation/tenant-isolation-acceptance.test.ts` is listed as skipped with its reason
(it is not part of this command because it is gated, but `npx vitest run tests/isolation` shows it skipped).
`tests/providers/zenith/substrate.test.ts` includes the pinned variable-list check: it now expects the four new
variables in `SUBSTRATE_ENV_VARS` and in `MANAGED-PLATFORM.md`.

Live, kind (needs kind >= the pin in `scripts/k8s/images.env`, docker, kubectl, Node 22; helm for cilium):

```
scripts/isolation/tenant-isolation-acceptance.sh kind-calico
# hostname egress: set the Cilium pins in the environment, read from the publisher by you
ZENITH_CILIUM_CHART_VERSION=<released chart version> \
ZENITH_CILIUM_CHART_SHA256=<sha256 of cilium-<version>.tgz you downloaded> \
  scripts/isolation/tenant-isolation-acceptance.sh kind-cilium
```

Expected on kind-calico: every `it` passes except the hostname-egress test, which is **skipped** (engine is not
Cilium) and the sandbox-runtime and unbounded-control tests, also skipped. On kind-cilium the hostname test runs.
Evidence: `.data-isolation-evidence/isolation-evidence.json` (cluster version, engine, one record per area,
measured baseline and loaded latency, burner CPU, PID counts, the disk eviction message) and
`vitest-report.json`. Runtime: roughly 15 to 25 minutes (the disk eviction waits for the kubelet).

Tuning knobs, never to be loosened silently: `ZENITH_TEST_ISOLATION_LATENCY_FACTOR` (5),
`ZENITH_TEST_ISOLATION_LATENCY_ABS_MS` (250), `ZENITH_TEST_ISOLATION_PIDS_MAX` (1024). Record any change in the
evidence notes.

Operator script (no cluster): `ZENITH_MANAGED_*=... npx tsx scripts/isolation/render-tenant-bundle.ts --workspace-id ws_1
--environment-id env_1 --workspace-slug acme --environment-slug prod --plan starter --fqdn api.example.com` prints a
validated List; exit 3 names the violated rule.

## 4. Behaviour changes to verified code

- `plans.ts`: every tier's LimitRange container `default`, `defaultRequest` and `max` gain `ephemeral-storage`
  (default 512Mi, request 64Mi, max 1Gi free, 4Gi starter, 10Gi pro). Before this a pod that named no
  ephemeral-storage was refused by the namespace quota. Rendered LimitRange bytes change, so export bundle digests
  change; `tenancy.test.ts` compares `container.max` to `PLAN_LIMITS` and still holds.
- `tenancy.ts` / `isolation.ts` / `render.ts`: with no isolation variables set the baseline is unchanged, but the
  gate now also refuses `priorityClassName`, `nodeName` and wildcard tolerations on a tenant pod (a rendered
  workload that set one would now be refused; no existing renderer sets them), and `renderZenithEnvironment`
  results gain an `isolation` field.
- `scripts/k8s/kind-calico-up.sh`: honours `ZENITH_KIND_CONFIG`; default behaviour unchanged.

## 5. Known gaps and things that may break first

1. **Nothing has run.** Expect small fixes in the live suite on first contact: busybox applet behaviour
   (`sleep 0.040`, `awk` printf width 1048576, `wget -S` output), the exact admission message wording, kind CPU and
   disk characteristics, and timing of kubelet eviction. The static and generator tests are the more reliable half.
2. **Metadata proof depends on a fixture**: a privileged hostNetwork DaemonSet adds `169.254.169.254`,
   `203.0.113.10` and `203.0.113.11` to each node's loopback and serves HTTP on 443. If the CNI or kind networking
   does not deliver pod traffic to a node-local link-local address, the "public control is reachable" assertion
   fails first and the metadata check would prove nothing; the suite fails rather than passing.
3. **Hostname egress is proven only on kind-cilium and needs two pins this build did not guess.** `cilium.env`
   is empty on purpose; the script refuses until the verifier supplies a chart version and its sha256. The
   hostname test patches CoreDNS in kube-system (kind only, guarded by the context check and an env flag) to publish
   test names and restores it afterward. The Cilium behaviours asserted (deny beats allow for a name that resolves to
   metadata; per-tenant FQDN cache separation) are the most likely thing to differ by Cilium version: a failure there
   is a finding, not necessarily a test bug.
4. **The provisioner (section 8) is built but nobody calls it yet**: MAN-01 does at the join. Until then setting
   `ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX` makes sessions look up credentials nobody has stored; leave it unset until
   onboarding provisions them. With it unset the render notes say
   operator separation is not active.
5. **Route attachment is not exercised live** (no Gateway API CRDs on kind): route hijack is proven at the gate and by
   RBAC refusals only.
6. **Sandbox runtime is evaluated, not installed or tested**: kind has none. The recommendation in
   `TENANT-ISOLATION.md` is provisional and vendor-specific facts (which managed Kubernetes offers which runtime)
   are explicitly to be confirmed at selection time.
7. **Not bounded and documented as such**: disk IOPS and bandwidth, network bandwidth, shared CoreDNS load, inodes,
   conntrack, CPU cache and memory bandwidth. A passing noisy-neighbour test at kind scale is not a capacity claim.
8. **Bounds are provisional**: latency factor and allowance, the PID ceiling, quota numbers.
9. kind exercises a single kernel shared by every pod, which is the point; it cannot show cross-node behaviour at scale.
10. The bootstrap RBAC example is a placeholder and was not exercised; `escalate` and `bind` make it the most
    powerful identity on the platform (stated in the file and the doc).

## 6. Shared-file updates the assembler must make

- `scripts/ci/gate-manifest.mjs`: add `tests/providers/zenith/isolation-bundle.test.ts` and
  `tests/isolation/isolation-profile.test.ts` to the always-run lane; add
  `tests/isolation/tenant-isolation-acceptance.test.ts` as a gated lane (`ZENITH_TEST_TENANT_ISOLATION=1`, kind
  required) alongside the LIFE-07 acceptance lane, with `scripts/isolation/tenant-isolation-acceptance.sh` as its entry.
- `docs/platform/operations/DEPLOYING.md`: the managed-platform variable table (near the "Managed database" row)
  should list `ZENITH_MANAGED_FQDN_ENGINE`, `ZENITH_MANAGED_EGRESS_FQDNS`, `ZENITH_MANAGED_RUNTIME_CLASS`,
  `ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX`.
- `docs/LIMITATIONS.md`: managed isolation now has a hostname engine and sandbox hook but no sandbox installed, no
  bundle apply in the executor, no token minting; no live run.
- `docs/build/production/ledger.json` / `PROGRESS.md`: statuses below.
- Migrations: **none** (no new table, no store function, no workflow or gate wiring beyond the gate-manifest lanes).
  `src/lib/sensitivedata/inventory.ts`: no change (no new table).
- `tests/docs/operator-docs.test.ts` pins strings in `MANAGED-PLATFORM.md`; the edit there only added table rows and
  appended to one paragraph, but check that paragraph's pinned text still matches ("What is not isolated").

## 7. Suggested ledger implementationStatus

PROD-MAN-04: `generators_and_gate_built_live_unrun` - hostname egress (Cilium), sandbox RuntimeClass hook and gate,
placement rules, per-tenant operator access with static separation analysis, and a two-adversarial-tenant kind
acceptance suite are built and unit tested at the generator level; the suite has not run; bundle apply in the
control plane executor, token minting, Gateway API attachment proof and any sandbox installation are not built.

PROD-MAN-05: `limits_and_load_test_built_live_unrun` - ephemeral-storage limits added, PID, CPU, memory and disk
bounds and a victim-latency load test are written for kind; not run; latency bound provisional; IOPS, bandwidth and
shared-service load are documented as unbounded.

## 8. Follow-up: the bundle is applied by the product (same branch)

Coordinator request: the isolation bundle must be applied by the product, not only by a script; per-tenant tokens must
reuse the MACH-02 minter.

### Built

| Piece | File |
|---|---|
| Platform apply set of the Kubernetes provider: ClusterRole, ClusterRoleBinding, CiliumNetworkPolicy, plus Role/RoleBinding that are not exact-name, accepted only with a `platform` vet; ResourceQuota, LimitRange, ServiceAccount, NetworkPolicy, Namespace were already in the set. `KIND_INFO` / `APPLY_ORDER` are unchanged on purpose (prune, teardown and observe iterate them and would start listing cluster RBAC and a CRD on every cluster). | `src/lib/providers/kubernetes/platform-kinds.ts`, `apply.ts` (`ApplyOptions.platform`) |
| `provisionTenantIsolation`: `createTenantIsolationProvisioner` with `plan`, `apply`, `provision`, `rotateCredential` | `src/lib/execution/tenant-isolation.ts` |
| The interface MAN-01 calls, the error type, the request digest for the onboarding operation's proposal | `src/lib/providers/zenith/onboarding.ts` |
| MACH-02 minter reuse: the TokenRequest half of `mintGuestCredential` factored into `requestVerifiedToken` (clamp 600..3600 s, audience-bound request, claims checked against ServiceAccount name and UID); `mintGuestCredential` now calls it, no behaviour change; the operator token uses the same function and the same `GuestClusterPort` (`ensureServiceAccount` for the UID, `requestToken`) | `src/lib/providers/kubernetes/guest.ts` |
| Effect family `isolation_apply` (the ledger needs the family in its CHECK) | migration `0050_tenant_isolation_effects.ts` (version 50), `effects/types.ts`, `effects/view.ts` |
| Operator ClusterRole renamed `zop-ns-<namespace>` (the old name exceeded 63 characters, which the provider's DNS-label rule refuses) | `isolation-bundle.ts` |
| Contract fake gains ClusterRole, ClusterRoleBinding and the cilium.io/v2 group | `tests/providers/kubernetes/fake-api.ts` |
| Tests | `tests/execution/tenant-isolation.test.ts` |

### The interface MAN-01 calls (`TenantIsolationProvisioner`)

```
plan(request)                       -> { planDigest, bundleDigest, namespace, objects[{kind,namespace,name,action}], notes }
apply(request, approvedPlanDigest)  -> { planDigest, bundleDigest, namespace, applied, verified, credential:{ref,expiresAt}, deduplicated }
provision(request)                  -> plan, then apply under the current approval (refuses unless that approval is bound to this digest)
rotateCredential(request)           -> { ref, expiresAt }   re-reads the bundle from the cluster, mints, stores; applies nothing
request = { tenant, substrate, operationId, lease:{scope,fenceToken}, egressFqdns?, withManagedDatabase?, audiences?, tokenTtlSec? }
```

Dependencies MAN-01 supplies when it builds the provisioner (`TenantIsolationDeps`): the execution `Runtime` (leases,
broker `approvalStatus`, `effects` ledger, emit, evidence), `openBootstrapSession` (a session for the BOOTSTRAP identity
with an allowlist of exactly the tenant namespace and `zenith-system`), `storeOperatorCredential` (a vault write under
`<ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX>/<tenant namespace>`; the token is only ever given to it), and optionally
`openOperatorProbe` (SelfSubjectAccessReview as the minted token; supplied means the minted identity must hold its own
namespace and be refused nine other checks, or onboarding fails).

Fail closed: onboarding is complete only when `apply`/`provision` returns. Any `TenantIsolationError` (codes:
`not_configured`, `invalid_request`, `admission_refused`, `plan_failed`, `plan_changed`, `approval_required`,
`lease_lost`, `effect_unresolved`, `apply_failed`, `verify_failed`, `credential_failed`) means the tenant is not
onboarded and must not receive a session. A substrate with no per-tenant credential prefix is refused (`not_configured`).

Guard order: OPS-02 `assertDispatchAdmitted` -> lease fence (DUR-A) -> recomputed plan digest and the current approval
bound to it (DUR-B stand-in) -> digest-exact vet of the batch (DUR-C stand-in) -> `isolation_apply` effect recorded
before the call (DUR-D) -> server-side apply -> readback of every object -> token mint -> optional live probe -> sink.

Joins MAN-01 must make: create the onboarding operation through the normal propose/approval path with
`isolationRequestDigest(request)` in its proposal input; call plan in the plan step and apply in the apply step;
schedule `rotateCredential`; supply the three ports above. DUR-B's executable-semantics record and DUR-C's plan-file
custody are tied to an environment deploy's ExecContext and are NOT recorded for an onboarding operation; the approval
bound to the plan digest and the digest-exact vet stand in. Add them if MAN-01's operation type has the context.

### Verification

```
npx vitest run tests/execution/tenant-isolation.test.ts tests/providers/zenith tests/providers/kubernetes tests/effects tests/machines/scoped-guest-session.test.ts tests/providers/kubernetes/guest.test.ts
```
The provisioner suite runs on PGlite (and PostgreSQL with `ZENITH_TEST_PLATFORM_PG_URL`) for the real ledger; the API is the
contract fake, so it proves wiring, ordering, refusals and the readback logic, not RBAC or Cilium behaviour. The
kind suite (`scripts/isolation/tenant-isolation-acceptance.sh`) is unchanged and still the cluster evidence; it applies the
bundle with kubectl, not through the provisioner. `cilium.env` is still empty for the verifier.

### Behaviour changes and risks

- `apply.ts`: preflight asserts the namespace guard for any object that names a namespace (before: any kind except
  Namespace); identical for every existing kind. `platform` unset leaves every path as it was.
- `guest.ts`: `mintGuestCredential` refactor only; `guest.test.ts` and `scoped-guest-session.test.ts` should be re-run.
- `fake-api.ts` gained groups; tests that count served groups (none known) would notice.
- Migration 50 drops and re-adds the family CHECK; the assembler renumbers it into the contiguous sequence. The
  family list is pinned by `EFFECT_FAMILIES`; tests that enumerate families need the new member.
- A verify failure after a successful apply puts the effect in `conflict`; resolving it is an operator action (existing
  effect resolution flow) and a retry meanwhile returns `effect_unresolved`.
- The plan evidence is written as a `tofu_plan` row with a minimal summary (engine `tenant-isolation`); if MAN-01's policy
  path expects the full plan summary shape it needs an adapter.
- Shared files for the assembler: gate-manifest (add `tests/execution/tenant-isolation.test.ts`), migrations inventory (50,
  no new table, no RLS change), `tests/controlplane/migrations.test.ts` (new version), LIMITATIONS (provisioner built,
  not called, not run against a cluster; DUR-B semantics and DUR-C custody not recorded for onboarding).
- Updated ledger status: PROD-MAN-04 `provisioner_and_generators_built_live_unrun`.
