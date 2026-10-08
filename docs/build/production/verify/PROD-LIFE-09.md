# PROD-LIFE-09 Isolated untrusted build provenance

Branch `prod/life-09-w2`. No SQL migration was needed (provenance is retained as `build` evidence, see 4), so the assigned migration version 23 was NOT consumed.

## 1. Summary of what was built

Audit of the existing build path (ws/build-* history, `codebuild-project.ts`, `codebuild-builds.ts`, `gcp/release/build.ts`, `azure/release/build.ts`, `execution/release.ts`). What already held: customer-account builds only (ADR-0016), a dedicated per-pipeline build identity on every provider, digest-addressed source, durable launch claims on AWS, digest-verified output, approved-source binding. What was missing and is now built:

| Gap found | Fix |
| --- | --- |
| No declared isolation profile; limits were scattered constants | `src/lib/execution/build-isolation.ts`: one profile per provider (identity, metadata, network, dependencies, filesystem, resources), `assertBuildIsolation`, `boundedTimeoutSec` |
| AWS Dockerfile `RUN` steps could reach instance metadata, the container credentials endpoint and the internet | `codebuild-isolation.ts` + `dockerBuildspec()`: first-position FORWARD chain installed in `pre_build` before the Dockerfile runs, rejects 169.254.169.254 and 169.254.170.2, allows replies, DNS and TCP 443 to the resolved allowlist (default package registries plus `spec.isolation.allowedHosts`), rejects the rest, aborts the build if the chain is not first |
| GCP: default machine and open egress, 3600 s ceiling | `build-api.ts`: fixed `E2_MEDIUM`, 100 GB disk, 1800 s cap, `requestedVerifyOption: VERIFIED`, optional private worker pool (`spec.isolation.workerPool`) |
| Azure: 3600 s run, default agent | `acr-task.ts`: 1800 s, 2 vCPU `agentConfiguration`, optional dedicated agent pool (`agentPoolName`) |
| No record of what the executed build actually carried | Each provider adapter reads the executed build back and returns a `BuildAttestation` (AWS `awsBuildAttestation`, GCP `attest`, Azure `attest`) on `BuildResult.attestation` |
| No provenance; the image digest was the only integrity fact | `src/lib/execution/build-provenance.ts`: in-toto Statement v1 with SLSA provenance v1 predicate (subject image digest; resolved dependencies source commit, source archive digest, Dockerfile digest, builder image; builder id, invocation id, observed isolation), signed as a compact JWS (`zenith-build-provenance+jwt`, EdDSA) with the existing control-plane key |
| No admission gate | `release.ts`: `recordBuildProvenance` (after a build) and `admitBuiltArtifacts` (start of `deployWorkloads`) |

Files changed or added (src):
- `src/lib/execution/build-isolation.ts` (new), `src/lib/execution/build-provenance.ts` (new)
- `src/lib/execution/release.ts`, `src/lib/execution/ports.ts` (`BuildResult.attestation`, `BuildProvenanceAuthority`, `ExecutionDeps.provenance`, `ExecutionDeps.buildIsolation`)
- `src/lib/resources/specs.ts` (`BuildPipelineSpec.isolation?: { allowedHosts?, workerPool? }`)
- `src/lib/providers/aws/drivers/compute/codebuild-isolation.ts` (new), `codebuild-project.ts`, `codebuild-builds.ts`
- `src/lib/providers/gcp/drivers/build/build-api.ts`, `src/lib/providers/gcp/release/build.ts`
- `src/lib/providers/azure/release/acr-task.ts`, `src/lib/providers/azure/release/build.ts`
- `src/lib/platform/release.ts` (AWS port forwards the attestation), `src/lib/platform/execution.ts` (composition: control-plane signer and pinned keys, `ZENITH_BUILD_ALLOW_OPEN_EGRESS`)

Source acquisition and GitHub binding code (LIFE-08) was not touched.

### How it is reached
`composeExecutionActivities` always sets `deps.provenance` (control-plane signer and `getControlVerificationKeys`) and `deps.buildIsolation`. `buildArtifacts` (every deploy with a git-sourced service) runs `recordBuildProvenance`; `deployWorkloads` runs `admitBuiltArtifacts` before it opens a provider session. There is no opt-in: a worker without a signer refuses built artifacts.

### Trust statement (honest)
The attestor is the control plane (`builder.version.attestor = zenith-control-plane-observed`). It signs facts the adapter read back from the provider after the build. The cloud builder does not co-sign. The signature protects the stored record from later edits and binds it to operation, service, image digest and the REVIEWED source snapshot; it does not make a compromised provider API truthful.

## 2. Acceptance mapping

Acceptance: "Build identity/network/filesystem/resources deny deployment credentials and metadata; dependency downloads controlled, artifacts have verified provenance."

| Clause | Implementation | Tests |
| --- | --- | --- |
| Separate least-privilege build identity, never the deploy role | Existing per-pipeline roles/SAs now ASSERTED at admission: AWS profile pattern `role/zenith-*-build` (a deploy role name is refused); GCP SA must equal the handle's pipeline SA; Azure runs carry no identity | `build-isolation.test.ts` (role pattern, dedicated, deployCredentials), `build-admission.test.ts` (non-build role refused) |
| Instance metadata blocked | AWS: guard rejects both metadata addresses for forwarded traffic and aborts if absent; GCP/Azure: platform cannot remove the endpoint, profile accepts only `build_identity_only` exposure | `build-isolation.test.ts` (guard text, ordering, tampered buildspec reported unrestricted) |
| Egress restricted to allowlisted registry/proxy set | AWS host firewall (see 1); GCP private pool `NO_PUBLIC_EGRESS` read back; Azure agent pool with `virtualNetworkSubnetResourceId` read back; otherwise `egress: unrestricted` and admission refuses unless `ZENITH_BUILD_ALLOW_OPEN_EGRESS=1` (recorded as `open_egress` on the statement) | `build-isolation.test.ts`, `build-provenance.test.ts` (exception must match current policy), `build-admission.test.ts` (refused, admitted under exception, revoked) |
| Dependency downloads controlled | Allowlist is the only reachable set (AWS default registries plus per-pipeline `allowedHosts`, validated as plain DNS names); `dependencies.downloads` must be `allowlisted` | `build-isolation.test.ts` (hostname injection refused) |
| Read-only source mount | AWS S3 object is GetObject-only and digest addressed (attested `read_only` only for S3 source without secondary sources); GCP object pinned by generation; Azure archive upload consumed once | `build-isolation.test.ts`, `build-admission.test.ts` (writable mount refused) |
| CPU/memory/time bounded | Profile limits: 1800 s, fixed compute class (AWS MEDIUM, GCP E2_MEDIUM, Azure 2 vCPU); adapters request them and the executed value is read back | `build-isolation.test.ts` (GCP timeout bound, `boundedTimeoutSec`), `build-admission.test.ts` (timeout refused) |
| Artifact provenance: source commit, builder identity, inputs digests | SLSA v1 statement, see 1 | `build-provenance.test.ts` |
| Signed with existing signing keys | `getControlSigner` (EdDSA control-plane key), header rules copied from capability grants and runbooks | `build-provenance.test.ts` (key pinning, header hygiene, typ confusion) |
| Verified before release admission | `admitBuiltArtifacts` re-verifies signature, re-derives every bound claim from the reviewed approved-source snapshot, re-runs the isolation profile on the signed observation | `build-admission.test.ts` (missing, swapped digest, edited, malformed, unpinned key, no signer) |

## 3. Verification commands (other machine)

```
npx vitest run tests/execution/build-isolation.test.ts tests/execution/build-provenance.test.ts tests/execution/build-admission.test.ts
npx vitest run tests/execution/release.test.ts tests/execution/journey.test.ts tests/execution/approved-source.test.ts
npx vitest run tests/providers/aws/drivers/compute/codebuild.test.ts tests/providers/gcp/release.test.ts tests/providers/gcp/build-gcp.test.ts tests/providers/azure/release.test.ts tests/providers/azure/build-digest.test.ts
npx vitest run tests/platform/release.test.ts tests/platform/release-multi.test.ts tests/platform/codebuild-launch-authority.test.ts tests/workflows
npx tsc --noEmit -p . && npx eslint src/lib/execution src/lib/providers tests/execution
```
Expected: all pass. No environment variable is needed; the signing key in tests is generated per test. Existing test edits that were required by this change: `tests/execution/release.test.ts` (build evidence rows are now 2: record plus provenance), `tests/providers/gcp/release.test.ts` and `tests/providers/azure/release.test.ts` (`waitForBuild` result now also carries `attestation`, matched with `toMatchObject`), `tests/execution/fakes/world.ts` and `fakes/release.ts` (provenance authority, compliant attestation), new `fakes/provenance.ts`.

Manual / live evidence not possible without clouds: the CodeBuild guard commands (iptables FORWARD behaviour with BuildKit), Cloud Build `requestedVerifyOption`, ACR `agentConfiguration` returned on a run, and `agentPools` GET shape. All are contract evidence only.

## 4. Known gaps, risks, and shared-file updates

New tables: none. New store functions: none. Workflow/gate wiring: none beyond the three new vitest files (add `tests/execution/build-isolation.test.ts`, `build-provenance.test.ts`, `build-admission.test.ts` to the production gate manifest if it enumerates paths). Provenance is stored as a `build` evidence row (digest from `provenanceEvidenceDigest`, summary `kind: "build.provenance"`, `jwsParts` = the three JWS segments because the evidence store refuses JWT-shaped strings). Operator env: `ZENITH_BUILD_ALLOW_OPEN_EGRESS=1` is the recorded exception; document it in the deploy runbook (do not edit DEPLOYING.md from here).

Things that may break first:
1. Existing AWS projects created before this change carry the old buildspec. Their executed buildspec is not the guarded one, so attestation reports `unrestricted` and release is REFUSED until the pipeline is re-applied (new buildspec) or the operator sets the exception. This is deliberate.
2. GCP and Azure builds without `spec.isolation.workerPool` report open egress and are refused unless the exception is set. Customers must provision a private pool / agent pool; Zenith does not create customer networks.
3. The AWS allowlist is IP based, resolved once per build; hosts on shared CDNs admit neighbours, DNS is open (covert channel), and a Dockerfile that requests BuildKit insecure entitlements would bypass FORWARD rules (not enabled by default). Metadata blocking covers forwarded traffic of Dockerfile steps only; the buildspec's own commands, and static-site builds (`npm run build` in the CodeBuild container, which are not released through this path), still see the build role credentials.
4. GCP/Azure metadata endpoints cannot be removed; the profile accepts only "exposes the build identity" and the identity is the per-pipeline least-privilege account.
5. Azure: the run record does not return its timeout; the 1800 s value is the one requested. `agentPools` GET uses the preview api-version the runs API uses. A VNet-bound pool is reported allowlisted because the customer's subnet NSG is the enforcement point.
6. `runAcrBuild` (azure `acr-build.ts`, exported helper, not on the release path) still requests a 3600 s run and is unchanged; it is unreachable from release.
7. OCI and Kubernetes have no profile and keep refusing source builds.
8. LIMITATIONS.md: add the items 1 to 5 above. Ledger evidence: `contract` and `local_engine` classes only; no live cloud evidence.

## 5. Suggested ledger implementationStatus

`implemented_contract: per-provider build isolation profile (AWS egress/metadata guard in buildspec, GCP private pool/machine/timeout, Azure agent pool/cpu/timeout), provider-read attestation, SLSA v1 provenance signed with the control-plane key, verified at release admission; live cloud evidence and customer private networking pending`

## 6. LIFE-08 handoff: build context directory and buildpack plans

- `BuildPipelineSpec.source` gained optional `contextDir` and `builder` (`dockerfile` | `buildpacks`). `contextDirOf` (`build-isolation.ts`) validates `contextDir` (relative, normalized, no `..`, `.` segments, backslash, absolute path, shell characters; max 200) and is called at build admission (`buildOne`) before any bundle is prepared, and again at release admission.
- Honored in isolated builds: AWS (buildspec `docker build ... '<dir>'`, recovered from the executed buildspec during attestation so a changed context is detected), GCP (Cloud Build step context argument). Azure ACR Tasks cannot select a subdirectory of an uploaded archive, so a non-root `contextDir` is REFUSED there with a stated reason.
- The context directory is bound into the signed provenance (`externalParameters.source.contextDir`) and re-checked at admission.
- Buildpack plans (`builder: "buildpacks"`) are refused at admission: "buildpack builds have no isolated builder; provide a Dockerfile". No isolated buildpack builder exists.
- NOT done here (LIFE-08 owns the archive and `ApprovedSourceSnapshot`): verifying that `contextDir` exists at the approved commit, that no symlink in it escapes the archive, and binding `contextDir` into the approved snapshot/recipe digest. The recipe digest already covers the pipeline spec, so changing `contextDir` invalidates a reviewed plan.
- Tests: `build-isolation.test.ts` (`build context directory and builder admission`), `build-provenance.test.ts` (different context refused).

## J6 isolated builder addendum (2026-10-08)

Owned implementation: src/lib/providers/kubernetes/build/{config,render,admission,port,artifact,index}.ts;
deploy/zenith-managed/build/{builder.go,builder_test.go,proxy.py,Dockerfile.builder,Dockerfile.proxy,Dockerfile.fixture,fixture-app.c,resolve-images.sh,render.ts,README.md};
tests/providers/kubernetes/build/{contracts,kind}.test.ts. No platform migrations.

Acceptance mapping:
- Identity/metadata/filesystem/resources: tokenless UID1000 userns Job, read-only
  root/source, bounded scratch/deadline/cgroups; trusted actual denial probes.
- Network/dependencies: default-deny, no build DNS, separate exact host/IP/port
  proxy; all policies inspected because Kubernetes permissions are additive.
- Provenance: digest readback of OCI index/platform/attestation/SLSA statement,
  then the existing signed LIFE-09 statement and admission. Generated test keys,
  altered bytes, wrong builder, revoked key and substituted source tested.
- Render/policy tests: contracts.test.ts. Operated isolation and source release:
  kind.test.ts, explicitly gated and not counted as a pass when disabled.

### Required assembly joins (outside J6 ownership)

1. src/lib/platform/release.ts: import createZenithBuildPort from
   @/lib/providers/kubernetes/build rather than ./zenith-managed-build.
   Keep the durable startBuildOnce wrapper and authority/approval ordering.
2. Managed build configuration/session/RBAC must read the configured proxy
   namespace baseline and RuntimeClass as well as the build namespace. Read-only
   namespace access must be explicit; tenant workload sessions remain separate.
3. Kubernetes: add provider key/profile and SLSA provider enum to
   execution/build-isolation.ts, build-provenance.ts and source-snapshot.ts;
   extend the approved-source custody/upload branch in platform/source-bundle.ts
   and select the new build port in platform/release-k8s.ts. Replace the explicit
   pre-launch and completion refusals in the owned port ONLY when that full join
   exists. Never label a Kubernetes result as provider zenith.
   The published approved_source_snapshots CHECK admits aws/gcp/azure and the wave-5 managed-source migration adds zenith, but not kubernetes. Assign a new additive migration to widen only that provider CHECK, retaining archive-format and immutable-custody conditions. No number was assigned to J6 and no migration was edited.
4. RuntimeClass, reviewed node-local seccomp/AppArmor profiles, user namespaces,
   process sandbox/proc mounts and admission must be operable on the verifier.
   This job does not install or invent a host runtime/security policy.
5. Add both owned vitest files to the production gate inventory. No store/table,
   sensitive-data classification is needed for the owned managed controller. The native Kubernetes custody CHECK join above requires a separately assigned additive migration.
6. Set ZENITH_RELEASE_MIN_PROVENANCE=attested. Built artifacts already have an
   attested floor and createBuiltAdmissionVerifier is registered by default.
7. Old 50-build-namespace.yaml is not the isolated baseline. Do not install its
   DNS policy beside this one. Render this baseline instead in a disposable cluster.

### Exact Mac commands and prerequisites

Run on the frozen assembly commit after joins. Node 22, native ARM64, Docker
4 GiB, one kind node and one build at a time. Quota permits only two pods (probe
then build); requests are 256 MiB per Job, 32 MiB proxy and 64 MiB fixture.
Limits are bounds, not reservations. No concurrent full default stack rehearsal.

First start the existing enforcing-CNI kind environment:
```bash
export ZENITH_KIND_CLUSTER_NAME=zenith-j6
export ZENITH_K8S_WORKDIR="$(mktemp -d)"
bash scripts/k8s/kind-calico-up.sh
export KUBECONFIG="$ZENITH_K8S_WORKDIR/kubeconfig"
```
The chosen node/runtime must actually support hostUsers:false, nested rootless
UID mappings, proc isolation, cgroup v2 and the configured Localhost profiles.
Install a reviewed runtime/profile configuration before testing. Stock runtimes
that cannot satisfy these requirements are BLOCKED, never a pass. Do not use
Unconfined, privileged pods, disabled process sandbox or lowered tests as fixes.

Resolve the operator-reviewed toolchain tags to real ARM64 manifest digests:
```bash
export GO_TAG=golang:1.24-alpine
export BUILDKIT_TAG=moby/buildkit:rootless
export PYTHON_TAG=python:3.13-alpine
export COMPILER_TAG=gcc:14
bash deploy/zenith-managed/build/resolve-images.sh > "$ZENITH_K8S_WORKDIR/images.env"
. "$ZENITH_K8S_WORKDIR/images.env"
: "${ZENITH_J6_REGISTRY:?set the owned registry reachable from Mac, kind nodes and proxy}"
docker build --platform linux/arm64 -f deploy/zenith-managed/build/Dockerfile.builder --build-arg GO_IMAGE="$GO_IMAGE" --build-arg BUILDKIT_IMAGE="$BUILDKIT_IMAGE" -t "$ZENITH_J6_REGISTRY/j6-builder:verifier" .
docker build --platform linux/arm64 -f deploy/zenith-managed/build/Dockerfile.proxy --build-arg PYTHON_IMAGE="$PYTHON_IMAGE" -t "$ZENITH_J6_REGISTRY/j6-proxy:verifier" .
docker build --platform linux/arm64 -f deploy/zenith-managed/build/Dockerfile.fixture --build-arg COMPILER_IMAGE="$COMPILER_IMAGE" -t zenith-j6-fixture:verifier .
docker push "$ZENITH_J6_REGISTRY/j6-builder:verifier"
docker push "$ZENITH_J6_REGISTRY/j6-proxy:verifier"
docker buildx imagetools inspect "$ZENITH_J6_REGISTRY/j6-builder:verifier"
docker buildx imagetools inspect "$ZENITH_J6_REGISTRY/j6-proxy:verifier"
container="$(docker create zenith-j6-fixture:verifier)"
docker cp "$container:/app" "$ZENITH_K8S_WORKDIR/app"
docker rm "$container"
export ZENITH_J6_FIXTURE_BINARY="$ZENITH_K8S_WORKDIR/app"
```
Record the displayed **actual** digests in the configuration file; none is
invented here. For the builder/proxy use the linux/arm64 child manifest digest when an index is displayed, so the running imageID matches; for a single-platform manifest use its displayed digest. The toolchain resolver rejects missing or ambiguous ARM64 selections. Registry TLS is validated by the control plane. Basic exact-host
dockerconfig auth is supported; bearer-challenge registry auth refuses and needs
an owned adapter. HTTP is an explicitly configured disposable-registry setting.

Create "$ZENITH_K8S_WORKDIR/build.json" using ConfigSchema: namespace,
builderImage@sha256, runtimeClass, seccompProfile, appArmorProfile, proxy
{namespace,ip,port,image@sha256,destinations:[{host,ip,port,tls}]}, optional
pushSecret, timeoutSec. The IPs/port must be the actual proxy Service and owned
registry/mirror endpoints. Both namespaces must be dedicated to this harness.
The file contains references/configuration only, no credentials.
```bash
export ZENITH_ISOLATED_BUILD_CONFIG="$(cat "$ZENITH_K8S_WORKDIR/build.json")"
npx tsx deploy/zenith-managed/build/render.ts "$ZENITH_K8S_WORKDIR/build.json" > "$ZENITH_K8S_WORKDIR/baseline.json"
kubectl apply -f "$ZENITH_K8S_WORKDIR/baseline.json"
kubectl -n zenith-build-proxy rollout status deployment/zenith-build-proxy --timeout=120s
go test -json deploy/zenith-managed/build/builder.go deploy/zenith-managed/build/builder_test.go
npx vitest run tests/providers/kubernetes/build/contracts.test.ts tests/execution/build-provenance.test.ts tests/execution/build-release-joins.test.ts --no-file-parallelism --maxWorkers=2
```
Use J1's real disposable product store and platform vault provisioning. Create
a real managed environment with ID env-j6-* through the normal product path;
export ZENITH_J6_WORKSPACE_ID and ZENITH_J6_ENVIRONMENT_ID to those recorded
IDs. Export the managed substrate/vault/database variables from that operated
fixture, including the same build namespace/image. No in-memory product lookup,
credential resolver, session factory or provider port may be injected.
```bash
export ZENITH_RELEASE_MIN_PROVENANCE=attested
export ZENITH_TEST_ISOLATED_BUILD_KIND=1
npx vitest run tests/providers/kubernetes/build/kind.test.ts --no-file-parallelism --maxWorkers=2
```
Expected: one real kind journey passes: fresh isolation probe receipt, actual
source push and OCI provenance readback, ready non-root Deployment, successful
one-off command Job and independent HTTP body zenith-j6-source-release.
The fixture command proves Job execution; it does not perform a SQL migration. SQL expand/contract and migration-pause acceptance remain in the LIFE-10/J2 lane.
Runtime/profile installation is explicit and uses reviewed files supplied by the verifier:
```bash
: "${ZENITH_J6_SECCOMP_PROFILE_FILE:?reviewed node seccomp profile}"
: "${ZENITH_J6_APPARMOR_PROFILE_FILE:?reviewed AppArmor profile named zenith-build}"
: "${ZENITH_J6_RUNTIMECLASS_MANIFEST:?reviewed manifest for an installed userns-capable handler}"
for node in $(kind get nodes --name "$ZENITH_KIND_CLUSTER_NAME"); do
  docker exec "$node" mkdir -p /var/lib/kubelet/seccomp
  docker cp "$ZENITH_J6_SECCOMP_PROFILE_FILE" "$node:/var/lib/kubelet/seccomp/zenith-build.json"
  docker cp "$ZENITH_J6_APPARMOR_PROFILE_FILE" "$node:/etc/apparmor.d/zenith-build"
  docker exec "$node" apparmor_parser -r /etc/apparmor.d/zenith-build
done
kubectl apply -f "$ZENITH_J6_RUNTIMECLASS_MANIFEST"
```
Run those installation commands before the enabled acceptance invocation.
Missing kernel support, AppArmor loader, reviewed profiles or runtime handler is
BLOCKED provisioning. No profiles or runtime installation are fabricated here.

A missing assembly join, real product fixture or runtime/profile is a failure
or BLOCKED prerequisite, never an accepted fake. Default API/human approval,
Temporal migration-pause, progressive rollout/rollback/data restore acceptance
remains in the LIFE-10/J1/J2 lanes; this adapter harness does not replace them.
Cleanup only the disposable harness cluster after inspecting evidence:
```bash
bash scripts/k8s/kind-calico-down.sh
```

Status: implementation_complete_verification_pending. Runtime/profile
provisioning, default-port joins and operated acceptance remain explicit.

## J6 Step 2 (authoritative, 2026-10-08)

Default Kubernetes and zenith-managed source builds now select the isolated builder. The old
assembly refusal is replaced by per-environment `ZENITH_ISOLATED_BUILD_PROFILES` custody.
No deployment credential fallback exists. Migration 59 adds only Kubernetes to the immutable
approved-source provider CHECK; 44-52 and aggregate 0026 remain unchanged. The default
approved-source runtime, source uploader, native registry/pipeline graph admission, signed
provenance provider and DUR-B reviewed semantics are joined. The reviewed provenance component
includes the entire tenant build profile: cluster/CA, both vault references, pinned images,
registry repository, runtime file digest, node allocation policy and proxy destinations.
Profile changes require another plan/review and are checked again before source upload/launch.

Controller and verifier credentials must be separately provisioned. Controller can read/create
Jobs and immutable source Secrets only in its build namespace; it cannot exec pods or write
workloads/RBAC. Verifier has cluster-wide read-only node/pod and binding/role readback, no Secrets
or mutations. Runtime verifies effective API identities, all applicable bindings/role contents,
complete permissions and explicit denied deployment access. Build Jobs have no API token.

Build nodes must have both protected tenant/profile labels, Ready status and both dedicated
NoSchedule/NoExecute taints. Unapproved nonterminal workloads cause refusal. Only named,
reviewed kube-system DaemonSets are permitted alongside owned build Jobs. Admission uses the
scheduler, then binds the probe node and its UID/allocation digest; replacement or moved custody
refuses completion/release. Baseline policies, actual proxy image, RuntimeClass, actual build
pod/image and all 14 fresh denial probes are checked before Dockerfile execution. Provenance
bytes are read and verified from the registry before the existing control-plane signature and
release admission. Failures remain user-visible StepFailedError reasons, never a privileged retry.

### Exact Mac preparation and commands

This replaces the historical one-node/shared-build-namespace setup above. Run one environment
and one build at a time. Use two kind nodes so product workloads/proxy/DB/Temporal never run on
the dedicated build node. Keep Docker at 4 GiB: reserve about 2 GiB for the worker node, 768 MiB
for control plane and 256 MiB each for disposable DB/Temporal; run Next and the execution worker
on the Mac host with `NODE_OPTIONS=--max-old-space-size=512`. The small fixtures need no package
installation during a source build. CPU/memory limits stay intact; a real OOM is a failed check.

Prerequisites: Node 22; kind/kubectl/Docker; enforcing CNI; operator-reviewed userns-capable
runtime handler, seccomp and AppArmor files supported by the Linux Docker VM. A missing kernel,
handler or reviewed file is BLOCKED provisioning, never PASS. Reuse J1's real isolated product,
local signing keys and encrypted vault configuration in a private env file. No mock product,
credential resolver, provider port or simulated approval is accepted.

```bash
umask 077
export ZENITH_KIND_CLUSTER_NAME=zenith-j6
export ZENITH_K8S_WORKDIR="$(mktemp -d)"
# Preserve the repository's real digest-pinned node image; add an isolated worker.
cp scripts/k8s/kind-calico.config.yaml "$ZENITH_K8S_WORKDIR/kind.yaml"
node --input-type=module -e 'import fs from "node:fs"; import yaml from "js-yaml"; const p=process.argv[1]; const c=yaml.load(fs.readFileSync(p,"utf8")); c.nodes.push({role:"worker",image:c.nodes[0].image}); fs.writeFileSync(p,yaml.dump(c));' "$ZENITH_K8S_WORKDIR/kind.yaml"
export ZENITH_KIND_CONFIG="$ZENITH_K8S_WORKDIR/kind.yaml"
bash scripts/k8s/kind-calico-up.sh
export KUBECONFIG="$ZENITH_K8S_WORKDIR/kubeconfig"
export ZENITH_J6_BUILD_NODE="$ZENITH_KIND_CLUSTER_NAME-worker"
# Allow ordinary fixtures on the control plane. Build workloads still require protected worker labels.
if kubectl get node "$ZENITH_KIND_CLUSTER_NAME-control-plane" -o jsonpath='{.spec.taints}' | grep -q node-role.kubernetes.io/control-plane; then
  kubectl taint nodes "$ZENITH_KIND_CLUSTER_NAME-control-plane" node-role.kubernetes.io/control-plane:NoSchedule-
fi
```

Use the digest resolver/build/push commands above. Supply a nonsecret `profile.input.json` with
workspaceId, environmentId, provider (`zenith` or `kubernetes`), matching deployment server/CA,
credentialRef, verifierCredentialRef, registryRepositoryRoot (native: `<registry>/<tenant-key>`)
and full ConfigSchema config. Derive the key with
`npx tsx -e 'import {buildTenantKey} from "./src/lib/providers/kubernetes/build"; console.log(buildTenantKey({workspaceId:process.env.ZENITH_J6_WORKSPACE_ID!,environmentId:process.env.ZENITH_J6_ENVIRONMENT_ID!}));'`.
Use namespace `zb-<key>`, proxy.namespace `zp-<key>`, nodeIsolation.tenant `<key>`, reviewed
systemDaemonSets `["calico-node","kube-proxy"]` only if those are the actual installed DaemonSets.
Use actual proxy service/registry IPs, exact host/port allowlist and digest-pinned images.
An initial 64-hex profileDigest placeholder is replaced by the offline review helper.

```bash
: "${ZENITH_J6_SECCOMP_PROFILE_FILE:?reviewed node seccomp JSON}"
: "${ZENITH_J6_APPARMOR_PROFILE_FILE:?reviewed AppArmor file named zenith-build}"
: "${ZENITH_J6_RUNTIMECLASS_MANIFEST:?reviewed RuntimeClass JSON for installed handler}"
npx tsx deploy/zenith-managed/build/review-profile.ts "$ZENITH_K8S_WORKDIR/profile.input.json" "$ZENITH_J6_SECCOMP_PROFILE_FILE" "$ZENITH_J6_APPARMOR_PROFILE_FILE" "$ZENITH_J6_RUNTIMECLASS_MANIFEST" "$ZENITH_K8S_WORKDIR/profile.json"
export ZENITH_J6_TENANT_KEY="$(node -p 'require(process.argv[1]).config.nodeIsolation.tenant' "$ZENITH_K8S_WORKDIR/profile.json")"
export ZENITH_J6_PROFILE_DIGEST="$(node -p 'require(process.argv[1]).config.nodeIsolation.profileDigest' "$ZENITH_K8S_WORKDIR/profile.json")"
# These filenames must match config.seccompProfile/appArmorProfile exactly.
docker exec "$ZENITH_J6_BUILD_NODE" mkdir -p /var/lib/kubelet/seccomp
docker cp "$ZENITH_J6_SECCOMP_PROFILE_FILE" "$ZENITH_J6_BUILD_NODE:/var/lib/kubelet/seccomp/zenith-build.json"
docker cp "$ZENITH_J6_APPARMOR_PROFILE_FILE" "$ZENITH_J6_BUILD_NODE:/etc/apparmor.d/zenith-build"
docker exec "$ZENITH_J6_BUILD_NODE" apparmor_parser -r /etc/apparmor.d/zenith-build
kubectl apply -f "$ZENITH_J6_RUNTIMECLASS_MANIFEST"
kubectl taint node "$ZENITH_J6_BUILD_NODE" "zenith.dev/build-tenant=$ZENITH_J6_TENANT_KEY:NoSchedule" "zenith.dev/build-tenant=$ZENITH_J6_TENANT_KEY:NoExecute"
kubectl drain "$ZENITH_J6_BUILD_NODE" --ignore-daemonsets --delete-emptydir-data
kubectl label node "$ZENITH_J6_BUILD_NODE" "zenith.node-restriction.kubernetes.io/build-tenant=$ZENITH_J6_TENANT_KEY" "zenith.node-restriction.kubernetes.io/build-profile=${ZENITH_J6_PROFILE_DIGEST:0:63}"
kubectl uncordon "$ZENITH_J6_BUILD_NODE"
node -e 'const fs=require("node:fs");fs.writeFileSync(process.argv[2],JSON.stringify(require(process.argv[1]).config));' "$ZENITH_K8S_WORKDIR/profile.json" "$ZENITH_K8S_WORKDIR/build.json"
npx tsx deploy/zenith-managed/build/render.ts "$ZENITH_K8S_WORKDIR/build.json" > "$ZENITH_K8S_WORKDIR/baseline.json"
kubectl apply -f "$ZENITH_K8S_WORKDIR/baseline.json"
kubectl -n "zp-$ZENITH_J6_TENANT_KEY" rollout status deployment/zenith-build-proxy --timeout=120s
kubectl -n "zb-$ZENITH_J6_TENANT_KEY" create token zenith-build-controller --duration=1h > "$ZENITH_K8S_WORKDIR/controller.token"
kubectl -n "zp-$ZENITH_J6_TENANT_KEY" create token zenith-build-verifier --duration=1h > "$ZENITH_K8S_WORKDIR/verifier.token"
# Zenith platform scope by default. Native: set this to the owning workspace for these two seed commands only.
export ZENITH_J6_CUSTODY_SCOPE="${ZENITH_MANAGED_VAULT_SCOPE:-zenith-platform}"
export ZENITH_J6_CONTROLLER_REF="$(node -p 'require(process.argv[1]).credentialRef' "$ZENITH_K8S_WORKDIR/profile.json")"
export ZENITH_J6_VERIFIER_REF="$(node -p 'require(process.argv[1]).verifierCredentialRef' "$ZENITH_K8S_WORKDIR/profile.json")"
ZENITH_MANAGED_VAULT_SCOPE="$ZENITH_J6_CUSTODY_SCOPE" npx tsx --env-file-if-exists=.env.local scripts/managed/seed-platform-vault.ts --ref "$ZENITH_J6_CONTROLLER_REF" --file "$ZENITH_K8S_WORKDIR/controller.token"
ZENITH_MANAGED_VAULT_SCOPE="$ZENITH_J6_CUSTODY_SCOPE" npx tsx --env-file-if-exists=.env.local scripts/managed/seed-platform-vault.ts --ref "$ZENITH_J6_VERIFIER_REF" --file "$ZENITH_K8S_WORKDIR/verifier.token"
export ZENITH_ISOLATED_BUILD_PROFILES="[$(cat "$ZENITH_K8S_WORKDIR/profile.json")]"
export ZENITH_RELEASE_MIN_PROVENANCE=attested
export ZENITH_TEST_ISOLATED_BUILD_KIND=1
npx vitest run tests/providers/kubernetes/build/kind.test.ts --no-file-parallelism --maxWorkers=2
```

Set custody scope to `ZENITH_J6_WORKSPACE_ID` for native Kubernetes. Do not alter the worker's
managed platform scope. Seed with the same real vault key/store as the product. Token expiry
fails closed; renew the same separately scoped identities for longer rehearsals. Provision a
push Secret with the owning repository's credential if registry auth is required; never mount
the controller/verifier credential in a builder or use the deployment identity for that Secret.

Expected kind result: one real adapter journey passes with actual fresh probes, source execution,
OCI provenance verification, readiness and serving digest/HTTP readback. The component fixture's
one-off command remains a command check; the separate operated LIFE-10 harness below verifies SQL.
For denial probes, revoke one precondition at a time (node protected label/taint, an extra policy,
wrong credential/binding, proxy destination or runtime profile), run again with a fresh disposable
environment, and require an explicit refusal before the source Job. Keep the captured refusal and
actual Jobs for review; restoring a precondition requires another reviewed profile when it changes.

### Real PostgreSQL and whole default release

Assembly must merge migrations 53-58 from their assigned jobs before the contiguous migration
inventory gate. J6 registers 59 without placeholders or edits to published SQL/aggregate snapshots.
Drain old writers before explicitly admitting registered contract migrations on the disposable DB.

```bash
export ZENITH_PLATFORM_DB=postgres
export ZENITH_PLATFORM_DB_URL="$ZENITH_TEST_PLATFORM_PG_URL"
export ZENITH_ALLOW_CONTRACT_MIGRATIONS=42,49,59
npx tsx --env-file-if-exists=.env.local scripts/platform/migrate.ts
npx tsx --env-file-if-exists=.env.local scripts/platform/migrate.ts --status
ZENITH_TEST_J6_SOURCE_PG=1 npx vitest run tests/providers/kubernetes/build/schema.test.ts --no-file-parallelism --maxWorkers=2
```

Expected: 15 schema/compatibility tests pass with 0 skipped, including real PostgreSQL native
custody, original provider preservation, rejected malformed format and immutable update/delete.
Use a disposable database; immutable custody records are retained until that database is removed.
Additional assigned migrations may need their own documented explicit admission; never add an
unregistered version just to make migration application pass.

Use J1's real product/DB/Temporal configuration. Start the host processes in three terminals with
that same private env and the profile above (Temporal dev server is a local verifier only):

```bash
temporal server start-dev --ip 127.0.0.1 --port 7233 --namespace default --headless
NODE_OPTIONS=--max-old-space-size=512 npm run dev -- --hostname 127.0.0.1
NODE_OPTIONS=--max-old-space-size=512 npm run worker
```

Create a real git-source service in the product with a manifest release.migrate command
`["/app","migrate"]`, service `j6`, class `expand`. Use `release-fixture/{app.c,migration.sql}` and
Dockerfile.template as the owned GitHub fixture. Resolve compiler and PostgreSQL ARM64 digests
with `docker buildx imagetools inspect gcc:14` and `docker buildx imagetools inspect postgres:16-alpine`;
set both ARG defaults in the reviewed Dockerfile to the actual pinned image refs before
committing that fixture through the operator's normal repository path. Its only RUN compiles C;
no dependencies are downloaded. Allow just the owned image mirror/registry hosts through the
build proxy. Connect the service to an actual disposable Postgres and bind `PGHOST`, `PGPORT`,
`PGDATABASE`, `PGUSER`, and `PGPASSWORD` through the normal service config/vault refs. No literal
password is in the fixture. Publish the reviewed fixture before planning, capture its approved
source snapshot, require human approval in the environment policy and approve through the real review route, and let the default Temporal worker
complete the operation. The harness neither creates nor bypasses approvals or provider ports.

Forward the actual workload service to localhost:18080 and its database to localhost:15432,
using J1's recorded namespace/service identifiers. Export those real local readback endpoints:

```bash
: "${ZENITH_J6_WORKLOAD_NAMESPACE:?recorded product namespace}"
: "${ZENITH_J6_WORKLOAD_SERVICE:?actual rendered service name}"
: "${ZENITH_J6_DATABASE_SERVICE:?actual disposable application DB service}"
kubectl -n "$ZENITH_J6_WORKLOAD_NAMESPACE" port-forward "service/$ZENITH_J6_WORKLOAD_SERVICE" 18080:8080
# Separate terminal:
kubectl -n "$ZENITH_J6_WORKLOAD_NAMESPACE" port-forward "service/$ZENITH_J6_DATABASE_SERVICE" 15432:5432
# Verification terminal, same local public verification keys and owning DB:
export ZENITH_J6_HTTP_URL=http://127.0.0.1:18080/
: "${ZENITH_J6_APPLICATION_PG_URL:?actual localhost:15432 application DB connection}"
: "${ZENITH_J6_OPERATION_ID:?operation created and approved through the real product}"
ZENITH_TEST_J6_OPERATED_RELEASE=1 npx vitest run tests/providers/kubernetes/build/operated-release.test.ts --no-file-parallelism --maxWorkers=2
```

Expected: one real reviewed default operation succeeds; immutable source and signed provenance
verify against owning public keys; release events show attested admission before deploy, migration
before cutover, readiness and digest readback; independently queried application SQL contains the
fixture marker and HTTP serves that marker. Requires root-context source (`contextDir: "."`) and
one service. Progressive rollout, destructive migration review, rollback and separate data-restore
contracts continue to use the existing LIFE-10 suites; this lane does not replace those checks.
All Mac checks above are **not run here (needs Docker/kind, real PG, Temporal and product/browser)**.
Ledger remains implementation_complete_verification_pending.


## Wave 6 final integration

Status remains `implementation_complete_verification_pending`. Node 22 only. Execute sequentially with Docker Desktop 4 GiB and one kind node; stop each heavy profile before starting another. Live acceptance stays deferred until separate owner approval.

```bash
node scripts/ci/wave6-gates.mjs --requirement PROD-LIFE-09 --print > /tmp/zenith-wave6-PROD-LIFE-09.commands.json
```

This prints the exact argv for each contract batch and required engine case, its gate names, private prerequisites, and its strict report-validation command. Set only the gates for the selected lane after preparing its owned fixture; a skip cannot satisfy that lane. Run each `argv` sequentially and then its `verify` argv. [Final integration setup and results](FINAL-INTEGRATION.md), [canonical inventory](../../../../scripts/ci/wave6-gates.json), [owner live runbook](../LIVE-ACCEPTANCE.md).
