# WS-BUILD-MULTI — builds and image rollout for GCP and Azure (AWS already works)

Workstream: WS-BUILD-MULTI (new; orchestrator brief) — Branch ws/build-multi — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-build-multi
Base: platform/integration

## Situation
The execution activities' release ports (build, workloads, migrations, sourceBundle) are composed in
src/lib/platform/release.ts for AWS only (CodeBuild + ECR digest pinning + ECS deployImage +
waitForServiceSteady + one-off migration task). For GCP and Azure:
- GCP drivers deploy Cloud Run services; built artifacts need resolving to a digest before compile
  (WS-GCP follow-up: `ArtifactSpec.built.digest`); no Cloud Build port exists.
- Azure has `runAcrBuild` (src/lib/providers/azure/acr-build.ts) and Container Apps revisions
  (`service.restart`), but nothing composes them into the release ports; built artifacts deploy
  `<registry>/<service>:latest` today.

## Objective
Release ports for gcp and azure with the same guarantees as AWS: build from the source bundle in the
customer's account, pin the pushed image by digest, roll the workload to that digest, wait for it to
be healthy, run `release.migrate` as a one-off job, never `:latest` in a deployed spec.
- GCP: Cloud Build (source in a customer bucket) → Artifact Registry digest → Cloud Run revision
  update to the digest → wait ready; migrations as a Cloud Run job execution.
- Azure: ACR Tasks (`runAcrBuild`) → digest → Container App revision with the digest → wait healthy;
  migrations as a Container Apps job execution.
- Selection by the environment's provider in the release composition.

## Owned paths
NEW src/lib/platform/release-gcp.ts, release-azure.ts and a provider switch in
src/lib/platform/release.ts (AWS behaviour unchanged) ; NEW provider helpers under
src/lib/providers/gcp/release/** and src/lib/providers/azure/release/** (reuse acr-build.ts) ;
tests/platform/release-*.test.ts, tests/providers/gcp/release*, tests/providers/azure/release* (new).
Do NOT edit src/lib/platform/{broker,app,execution}.ts (other jobs) except the one-line wiring of the
release switch in execution.ts if unavoidable (say so).

## Verification
- npx tsc --noEmit ; npx eslint src/lib/platform/release*.ts src/lib/providers/gcp src/lib/providers/azure tests/platform tests/providers/gcp tests/providers/azure
- npx vitest run --maxWorkers=2 tests/platform tests/providers/gcp tests/providers/azure
