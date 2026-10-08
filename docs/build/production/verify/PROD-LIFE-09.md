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
