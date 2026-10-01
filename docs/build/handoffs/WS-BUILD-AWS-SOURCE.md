# WS-BUILD-AWS-SOURCE — AWS CodeBuild consumes the C3 source bundles

Workstream: WS-BUILD-AWS-SOURCE (orchestrator brief) — Branch ws/build-aws-source — worktree Z:/Projects/Spawned.ai/zenith-wt/ws-build-aws-source
Base: ws/integrate-w6 (WS-BUILD-SOURCE merged: src/lib/platform/source-bundle.ts uploads deterministic
tar.gz bundles under `zenith/<env>/<service>/<sha>.tar.gz`)

## Gaps (from WS-BUILD-SOURCE)
- AWS CodeBuild S3 sources accept a ZIP or a folder, not tar.gz
  (https://docs.aws.amazon.com/codebuild/latest/APIReference/API_ProjectSource.html). Choose the cleanest
  correct option: emit a deterministic ZIP for AWS (preferred: extend the bundle format per provider in
  source-bundle.ts, keeping tar.gz for GCP/Azure), or unpack in the buildspec — justify.
- src/lib/providers/aws/drivers/compute/codebuild-project.ts (~83, ~171, ~184, ~217) and codebuild-builds.ts
  (~66, ~82): align source-key validation, the per-project IAM read scope and object expiry with the
  `zenith/<env>/...` prefix; the build reads exactly the bundle key it was started with.
- deploy/aws/zenith-connection.cfn.yaml (~964) and deploy/aws/tofu-module/policies/deploy-data.json.tftpl (~123):
  environment-scoped upload/read permissions for source objects; regenerate with
  `npx tsx deploy/aws/tools/generate-tofu-policies.ts --write`.

## Owned paths
src/lib/platform/source-bundle.ts (format per provider only), src/lib/providers/aws/drivers/compute/codebuild-*.ts,
deploy/aws/zenith-connection.cfn.yaml + regenerated deploy/aws/tofu-module/policies/**, tests for these.

## Verification
- npx tsc --noEmit ; npx eslint <touched paths>
- npx vitest run --maxWorkers=2 tests/platform/source-bundle* tests/providers/aws/drivers/compute tests/credentials
