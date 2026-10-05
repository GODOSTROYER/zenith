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
