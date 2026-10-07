# PROD-LIFE-07 verify notes: Kubernetes full lifecycle acceptance

Built on branch `prod/life-07-w3` from `c9a942d6`. Nothing here was executed: no vitest, no kind, no cluster.
The only checks run on the building machine were `npx tsc --noEmit -p .` and `npx eslint` on every changed
file, both clean. Every test below was written to run on the verifying machine and desk-checked against the
code and the fake API's behaviour; read "Known gaps" for what is most likely to need a fix first.

Live managed-cluster acceptance (EKS, GKE, AKS, OKE) is deferred by the user. The harness for it is built and
refuses to run without explicit confirmation; it has not been run against any cluster.

## 1. What was built

Audit first. The Kubernetes provider (`src/lib/providers/kubernetes`) already rendered Deployment, a dev-tier
postgres/redis StatefulSet (one fixed replica, a separate PVC), CronJob with fixed policy, PVC and a
default-deny-ingress NetworkPolicy; it applied by server-side apply, rolled back Deployments, tore an
environment down (`teardown.ts`, wired into `execution/destroy.ts`), and released digest images
(`release/workloads.ts`, `platform/release-k8s.ts`). Gaps found:

- no StatefulSet a user could declare (claim templates, ordered rollout, retention), no rollback or scale for one
- CronJob policy hard-coded, and its health reported `unknown` forever (the object cannot say if a run succeeded)
- NetworkPolicy: ingress default-deny only, no egress isolation, and no way to learn whether a CNI enforces it
- no snapshot or restore of persistent data
- teardown could not see VolumeSnapshots; PVCs a StatefulSet makes from claim templates would have had no
  ownership marks
- `execution/destroy.ts` refused every destroy on a cluster without cert-manager, external-dns or Gateway CRDs
  (teardown reports `Certificate/ns/*` as `skipped` when the kind is not served, and the review blocked on any skip)
- the only real-cluster proof was the opt-in kind suite, whose own header says it proves no NetworkPolicy enforcement

### New and changed source

| File | Change |
|---|---|
| `src/lib/resources/native-k8s-workloads.ts` (new) | strict zod schemas for the native `k8s:StatefulSet` and `k8s:CronJob` shapes |
| `src/lib/resources/native-registry.ts` | registers both for provider `kubernetes` only (the managed `zenith` provider has none and refuses them) |
| `src/lib/providers/kubernetes/renderers/stateful.ts` (new) | renders the native StatefulSet (+ headless Service) and CronJob; expectations for observe |
| `src/lib/providers/kubernetes/renderers/workload.ts` | CronJob rendering through one `buildCronJob`; `CronPolicy` (concurrency, history limits, deadline, time zone, backoff, TTL) with validation; Jobs carry the ownership selector |
| `src/lib/providers/kubernetes/render.ts` | `provider_native` renderer (registered shapes only) |
| `src/lib/providers/kubernetes/renderers/network.ts` | opt-in default-deny egress + DNS allow per namespace; matching egress allow per firewall; native StatefulSet is a valid firewall target |
| `src/lib/providers/kubernetes/rollout.ts` | StatefulSet rollout evaluation honours `partition` and `minReadySeconds`; `rollbackStatefulSet` via ControllerRevisions |
| `src/lib/providers/kubernetes/ops.ts` | `service.scale` and `deployment.rollback` for native StatefulSets (dev-tier databases refuse); scale-down that deletes claims needs `acknowledgeDataLoss` |
| `src/lib/providers/kubernetes/snapshots.ts` (new) | `database.snapshot` / `database.restore` through CSI VolumeSnapshots, with explicit refusals; teardown helper |
| `src/lib/providers/kubernetes/cni.ts` (new) | names the NetworkPolicy engine from node agents; never says "not enforcing" |
| `src/lib/providers/kubernetes/immutability.ts` (new) + `apply.ts` | refuses a change to StatefulSet claim templates, selector, serviceName, podManagementPolicy before anything in the batch is applied |
| `src/lib/providers/kubernetes/drivers/readback.ts` (new), `drivers/runtime.ts` | StatefulSet: ordered readiness, revision convergence, every claim Bound/Pending/Lost/missing; CronJob: reads the Jobs it created |
| `src/lib/providers/kubernetes/drivers/workload/{statefulset,cronjob}.ts`, `storage/persistentvolumeclaim.ts`, `network/networkpolicy.ts` | driver attributes, checks and operations for all of the above |
| `src/lib/providers/kubernetes/teardown.ts` | owned VolumeSnapshots follow the stateful rule (retained or deleted, deleted first) |
| `src/lib/providers/kubernetes/client.ts`, `types.ts`, `renderers/common.ts`, `index.ts` | read-only kinds (Job, ControllerRevision, DaemonSet, PersistentVolume), snapshot kinds, `dns` render option, native namespace, exports |
| `src/lib/execution/destroy.ts` | a skipped wildcard ref for an unserved CRD kind (Certificate, DNSEndpoint, HTTPRoute) no longer blocks a destroy review; any other skip still does; VolumeSnapshot counts as stateful in the plan |
| `src/lib/resources/{specs,manifest-v2,expand-context,expand-topology,expand}.ts` | `providerConfig.kubernetes.egress` and `.cronJob` reach the namespace node and cron jobs |
| `scripts/k8s/` (new) | `images.env` (all pins), `kind-calico.config.yaml`, `kind-calico-up.sh`, `kind-calico-down.sh`, `lifecycle-acceptance.sh`, `managed-acceptance.sh`, `lib.sh` |

### How a user reaches it

- A manifest V2 `native[]` entry of type `k8s:StatefulSet` or `k8s:CronJob` (customer Kubernetes clusters).
- `providerConfig.kubernetes.egress: "default-deny"` isolates a namespace's egress too; `providerConfig.kubernetes.cronJob`
  sets the policy of every cron service.
- Day-two operations go through the existing capability executor, which finds a driver operation by capability name:
  `service.scale`, `deployment.rollback`, `database.snapshot`, `database.restore` on `k8s:StatefulSet`;
  `database.snapshot`, `database.restore` on `k8s:PersistentVolumeClaim`. No new capability names, no new policy.
  `database.snapshot` also works on the dev-tier postgres/redis StatefulSet (it has a PVC); scale and rollback do not
  (they refuse with `unsupported`).
- Readback is the existing observe / runtime / verify path, so reconcile and post-apply verification pick it up.
- Teardown is the existing `infrastructure.destroy` path.
- NOT wired, and not introduced here: a default workflow stage that applies a `kubernetes`-provider environment.
  `execution/apply.ts` runs OpenTofu and the Kubernetes drivers declare `compile: false`; the only apply callers
  are `release/workloads.ts` (digest images) and the library entry points the kind suites use. The acceptance
  suite drives `renderGraph` + `serverSideApply`, exactly like `kind.test.ts`. This predates PROD-LIFE-07 and
  belongs with PROD-MAN-01 / the direct-provider apply work; nothing was fabricated to hide it.

### Honest limits stated in code and here

- Snapshots are crash-consistent, not atomic across claims, and only attempted when the CRDs, a CSI-backed bound claim
  and a matching VolumeSnapshotClass exist; otherwise `snapshots_unsupported` with the missing piece. No file-copy fallback.
- Restore never overwrites: it creates a new claim for an ordinal that is not running; a live claim means scale down and
  delete it deliberately first.
- LIFE-11 export: raw PVC data still has no mover and `data.export` still refuses it (`src/lib/portability` untouched,
  per the area rules). The in-cluster protection of that data is the snapshot operation. No integration with the
  engine-level exports was made because none applies to opaque volumes.
- NetworkPolicy enforcement is a cluster property. Detection is evidence only; the proof is the traffic test.
- Rolling back a StatefulSet restores the pod template, never the volumes.
- Guest credentials (MACH-02): that worker owns them concurrently and no interface exists in this tree, so nothing was
  consumed or changed. The Kubernetes build port still refuses source builds (unchanged). The existing kind guest
  controls (48 in the f36/f582 receipts) remain a separate cohort.

## 2. Acceptance mapping

| Clause | Implementation | Tests |
|---|---|---|
| Default build / guest credentials | not in this worker's scope (MACH-02 owns guest credentials; build port refusal unchanged) | none new; existing `tests/machines/kubernetes-kind.test.ts` untouched |
| StatefulSets: PVC templates | `renderers/stateful.ts` (claim templates carry ownership marks, no spec digest) | `lifecycle-render.test.ts` "native k8s:StatefulSet"; `lifecycle-contract.test.ts` "native StatefulSet apply"; acceptance "rolls out ordered..." |
| StatefulSets: ordered rollout | `podManagementPolicy`, explicit `partition`, `evaluateRollout` partition/minReady, readback `ordinal_gap` / `revision_not_converged` | contract: `evaluateRollout` staged cases, "StatefulSet readback"; acceptance: ordinal 1 created after ordinal 0 Ready, update replaces highest ordinal first |
| StatefulSets: rollback | `rollbackStatefulSet` + `deployment.rollback` | contract "deployment.rollback on a StatefulSet"; acceptance rollback to revision 1 with data unchanged |
| StatefulSets: scale | `service.scale` incl. data-loss acknowledgement | contract "service.scale on a StatefulSet"; acceptance scale 2 to 3 to 1 to 2 |
| StatefulSets: immutable fields | `immutability.ts` in apply preflight | contract "immutable StatefulSet fields" |
| CronJobs: concurrency policy, history limits | `CronPolicy`, native `k8s:CronJob`, `providerConfig.kubernetes.cronJob` | render "CronJob policy"; resources "providerConfig.kubernetes"; acceptance Forbid never overlaps (`maxActive` is 1, a `JobAlreadyActive` event is seen), history limit prunes |
| CronJobs: readback | `cronJobReadback` | contract "CronJob readback"; acceptance failing run reads unhealthy |
| Persistent data lifecycle: retention | `persistentVolumeClaimRetentionPolicy` rendered out loud, `Delete` needs `acknowledgeDataLoss` (schema and scale op) | render "refuses a Delete retention policy..."; contract scale tests |
| Persistent data lifecycle: survive | | acceptance "keeps data across pod replacement", retained claims reused after scale down |
| Persistent data lifecycle: snapshot/restore, refusal | `snapshots.ts` | contract "database.snapshot", "database.restore" (all refusal codes); acceptance "snapshots and restores where the cluster can, and refuses where it cannot" |
| Persistent data lifecycle: teardown | `teardown.ts`, `destroy.ts` | contract "persistent data and environment teardown"; `destroy-providers.test.ts` unserved-CRD case; acceptance "tears down only what this run owns" |
| Real CNI NetworkPolicy | default-deny ingress + egress, DNS allow, per-firewall egress allow; kind + Calico profile | render "NetworkPolicy generation"; acceptance "admits exactly the declared path..." (control run, then allow, then three denials) |
| Readiness/readback per kind | StatefulSet, CronJob, NetworkPolicy (engine), PVC (existing Bound check), Namespace (existing) | contract readback groups; acceptance verify calls |
| Teardown respects ownership | owned-only deletion, foreign PVC/snapshot never touched | contract "never touches a claim or snapshot it does not own"; acceptance foreign claim survives |
| Kind cluster config + script, images pinned by digest, no new npm deps | `scripts/k8s/*` | `lifecycle-profile.test.ts` (pins, config, safety rails) |
| Supported managed-cluster acceptance | `scripts/k8s/managed-acceptance.sh` + the same suite with profile `managed:<provider>` | not run (deferred); `lifecycle-profile.test.ts` checks its refusals |

## 3. Verification commands for the other machine

Node 22 (`export PATH=".../node22:$PATH"`), repo root. All fast, no cluster:

```
npx tsc --noEmit -p .
npx eslint src/lib/providers/kubernetes src/lib/resources src/lib/execution/destroy.ts tests/providers/kubernetes tests/resources/native-k8s-workloads.test.ts
npx vitest run --maxWorkers=1 \
  tests/providers/kubernetes \
  tests/providers/zenith \
  tests/resources \
  tests/execution/destroy-providers.test.ts tests/execution/destroy.test.ts \
  tests/ownership tests/incidents tests/capabilities
```

Expected: all pass. `lifecycle-acceptance.test.ts`, `kind.test.ts` and `release-kind.test.ts` are gated and report as
skipped in this run (3 gated files; the lifecycle file declares 9 gated cases). New files:
`lifecycle-render.test.ts`, `lifecycle-contract.test.ts`, `lifecycle-profile.test.ts`, `lifecycle-support.ts`
(helper), `tests/resources/native-k8s-workloads.test.ts`. Changed: `ops.test.ts` (one assertion, see section 4),
`fake-api.ts` (additive), `destroy-providers.test.ts` (one added case).

Real-cluster acceptance (needs docker, kind >= 0.33, kubectl within one minor of 1.37, network to docker.io and quay.io):

```
scripts/k8s/lifecycle-acceptance.sh kind-calico
```

This creates `zenith-life07`, installs Calico after verifying the manifest sha256 and rewriting its images to the
pinned digests, runs `lifecycle-acceptance.test.ts` plus the existing `kind.test.ts` and `release-kind.test.ts`
(the latter two with `ZENITH_TEST_KIND_RELEASE_IMAGE` set to the pinned busybox), writes
`.data-k8s-evidence/lifecycle-evidence.json` and `vitest-report.json`, and deletes the cluster and its work directory
(`ZENITH_K8S_KEEP=1` keeps it). Expected: every case passes with no skips; the evidence file has `profile: kind-calico`,
`networkPolicy.enforcement: "proven_by_traffic"`, `snapshots.supported: false` with `snapshot_crds_missing`
(kind has no CSI snapshotter), and `teardown.deletedOnlyOwned: true`. Budget about 15 to 25 minutes (the CronJob case
waits on real minute boundaries for roughly 8 minutes).

Cleanup check after the run: `kind get clusters` lists no `zenith-life07*`; no `zenith-l7-*` namespace exists
(the cluster is gone anyway). If a run was interrupted, `ZENITH_K8S_WORKDIR=<dir> scripts/k8s/kind-calico-down.sh`.

Managed (deferred, for when a cluster exists): see the header of `scripts/k8s/managed-acceptance.sh`. It needs
`KUBECONFIG`, `ZENITH_MANAGED_K8S_PROVIDER`, `ZENITH_MANAGED_K8S_CONTEXT` (must equal the current context),
`ZENITH_MANAGED_K8S_CONFIRM=create-and-delete-namespaces`, and optionally `ZENITH_TEST_K8S_EXPECT_NETPOL`,
`ZENITH_TEST_K8S_EXPECT_SNAPSHOTS`, `ZENITH_TEST_K8S_STORAGE_CLASS`. It never creates a cluster.

## 4. Known gaps, what may break first, behaviour changes

Most likely to need a fix on first run (all untested here):

1. `lifecycle-contract.test.ts` leans on new fake-API modelling (ControllerRevisions, StatefulSet scale subresource,
   snapshot groups, PersistentVolume). If the fake's strategic merge differs from my reading, expect failures in the
   rollback and snapshot groups first. The fake changes are additive; the pre-existing suites should be unaffected,
   but `tests/providers/kubernetes/*` should be run whole to prove it.
2. `lifecycle-acceptance.test.ts`: `echo | nc -w 3 kubernetes.default.svc 443` as the API-server egress probe depends on
   busybox `nc` exiting 0 after connecting; the control run is designed to fail loudly if it does not. PVC protection can
   hold claims during teardown, which the test handles by repeating the review. Calico may need a few seconds to program
   rules; denial probes retry up to 180 s and only then fail.
3. The CronJob case needs a controller that emits `JobAlreadyActive` (all supported Kubernetes versions do) and takes
   real wall-clock time.
4. `renderers/stateful.ts` passes `spec.config` (already parsed, with defaults) back through the same zod schema; defaults
   are idempotent by construction but this is the place to look if a native node fails to render after expansion.

Behaviour changes to verified contracts (each deliberate):

- `k8s:StatefulSet` driver now offers `service.scale`, `deployment.rollback`, `database.snapshot`, `database.restore`.
  `tests/providers/kubernetes/ops.test.ts` asserted `service.scale` was undefined; it now asserts the dev-tier database
  refuses it with `unsupported`.
- CronJob rendering adds `jobTemplate.metadata.labels`; observe now compares `concurrencyPolicy`, history limits (defaults
  match what was always rendered). Cron runtime now lists Jobs once the CronJob has a `lastScheduleTime`; a never-scheduled
  CronJob still reads `unknown` with signal `never_scheduled` (the existing contract).
- `evaluateRollout` for StatefulSets: with `partition > 0` it is complete when ordinals at or above the partition are
  updated; partition 0 behaviour is unchanged.
- `execution/destroy.ts`: unserved-CRD wildcard skips no longer block the destroy review, final apply summary or absence
  verification. `teardown.ts`'s own report still lists them as `skipped` (its tests are unchanged).
- NetworkPolicy runtime now exists (engine reading); an `enforcing_cni` check appears only when an enforcing engine was
  detected. No check is ever added as `unknown` or `false` for enforcement.

Limits that remain:

- Egress default-deny blocks everything not declared, including calls to external services; there is no rule kind for
  external egress yet.
- Detection of the policy engine reads DaemonSets in `kube-system` and `calico-system` through the namespace guard, so it
  reports `cni_unreadable` unless the connection allowlist includes them.
- Only customer Kubernetes clusters: the managed Zenith substrate keeps refusing StatefulSets (`providers/zenith/isolation.ts`)
  and has no registration for the native types.
- Growing a claim in place is not implemented (claim templates are immutable; the apply refusal says so).
- The acceptance proves one cluster per run. A kind pass says nothing about a managed cloud's storage classes, CNI
  choice or load balancers; the managed run is the only evidence for those and has not happened.
- Supported-version window: PVC retention policy needs Kubernetes 1.32 or newer; on older clusters the field is dropped and
  observe reports the mismatch.

## 5. Shared-file updates for the orchestrator

- No platform migration, table or store function: migration number 38 was not used. Nothing for `tenancy.test.ts`,
  `controlplane-sql-scoping`, `emit.ts`, supabase or `apply-supabase-migrations.sh`.
- `scripts/ci/gate-manifest.mjs`: add the four new vitest files above to the unit lane (and the profile test if the
  manifest enumerates files); add a local-kind lane entry for `scripts/k8s/lifecycle-acceptance.sh kind-calico` next to the
  existing kind55 cohort. The lifecycle suite adds gated cases; update the kind cohort identity and counts when its first
  receipt exists. Do not sum its counts with the f36/f582 provider 6 / release 1 / guest 48 receipts.
- Mark `scripts/k8s/*.sh` executable (`git update-index --chmod=+x` was applied in the commit; confirm the mode survived).
- `docs/LIMITATIONS.md`: replace "StatefulSet/CronJob/CNI ... remains open" language with the limits in section 4; the
  statements that "real StatefulSet releases and enforced NetworkPolicy behavior are unverified" stay true until the first
  kind+Calico receipt exists.
- `docs/build/production/REQUIREMENTS.md` / ledger: see the suggested status.

## 6. Suggested ledger implementationStatus

`source_complete_local_acceptance_pending`: native StatefulSet/CronJob rendering, ordered rollout/rollback/scale, retention,
snapshot/restore with refusals, default-deny egress/ingress generation, engine detection, owned teardown and the pinned
kind+Calico and managed harnesses are built and covered by contract and static tests; no real-cluster run has happened for
any of it, managed-cluster acceptance is deferred by the user, and the default workflow apply stage for `kubernetes`
environments is not part of this requirement's code.
