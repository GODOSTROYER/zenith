# WS-AWS-BUILD-BOUNDARY — the workload permissions boundary lets build roles (and only build roles) push images and publish sites

Workstream: WS-AWS-BUILD-BOUNDARY (orchestrator brief) — Branch ws/aws-build-boundary — worktree Z:/Projects/Spawned.ai/zenith-wt/ws-aws-build-boundary
Base: ws/integrate-w6 (staging: WS-BUILD-AWS-SOURCE merged — CodeBuild takes ZIP source bundles)

## Situation
Every role Zenith creates carries `ZenithWorkloadBoundary` (deploy/aws/zenith-connection.cfn.yaml ~225, mirrored in
deploy/aws/tofu-module/main.tf). Effective permissions = role policy ∩ boundary. The CodeBuild service role from
src/lib/providers/aws/drivers/compute/codebuild-project.ts (~182–215) asks for actions the boundary does not allow, so a
live build would fail with AccessDenied:
- ECR push to its own `zenith-*` repository: `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`,
  `ecr:PutImage`, `ecr:DescribeImages` (the boundary only has pull: BatchCheckLayerAvailability/GetDownloadUrlForLayer/BatchGetImage).
- `s3:GetObjectVersion` on the source bundle (boundary has s3:GetObject only).
- static-site publish: `cloudfront:CreateInvalidation` on the site distribution (absent from the boundary).
- check the build log group too: role writes `/aws/codebuild/<projectName>`; the boundary's WorkloadLogs allows
  `/zenith/*` and `/aws/*/zenith-*` — confirm `projectName` (cloudName(ctx.namePrefix, `${name}-build`)) always matches,
  or fix the pattern.

## Do
1. Add boundary statement(s) that grant these ONLY to Zenith build roles, never to app workloads (an app workload must not
   be able to overwrite its own images or invalidate CDN caches). Use a condition that the boundary can evaluate, e.g.
   `ArnLike aws:PrincipalArn arn:${Partition}:iam::${AccountId}:role/<the build-role naming pattern>` — derive the exact
   pattern from cloudName()/namePrefix and make the driver and the boundary share ONE exported constant/regex so they cannot drift.
   Resources stay narrow: ECR `repository/zenith-*` in this account; S3 `zenith-*/*` objects; CloudFront distributions in this
   account (add `aws:ResourceTag/zenith:managed` = "true" only if CloudFront supports that condition key for
   CreateInvalidation — check the AWS Service Authorization Reference and cite it in a comment; if not supported, rely on the
   principal condition plus the role policy's exact distribution ARN).
2. Mirror the change byte-for-byte in deploy/aws/tofu-module/main.tf (and regenerate policies with
   `npx tsx deploy/aws/tools/generate-tofu-policies.ts --write` if templates are affected). Keep the "Do not edit; Zenith cannot"
   property: the deploy role must still be unable to modify the boundary.
3. Tests: tests/credentials/bootstrap-templates.test.ts (CFN ↔ tofu-module parity, the new statement exists, it is principal-
   conditioned, an app-workload role ARN does NOT match the pattern, a build role ARN does); a driver test in
   tests/providers/aws/drivers/compute/codebuild.test.ts proving every action in the build role policy is allowed by the
   boundary for a build-role principal (evaluate statements locally — a small matcher over Action/Resource/ArnLike is fine).
   Do the same coverage check for the other drivers that set `permissions_boundary` if cheap (ecs-task, lambda-function,
   ec2-instance): list any action the boundary blocks in your final report rather than widening the boundary for them.
4. Update deploy/aws/README.md (boundary section) and docs that describe the boundary.

## Owned paths
deploy/aws/** , src/lib/providers/aws/drivers/compute/codebuild-project.ts , src/lib/providers/aws/drivers/compute/support/** ,
src/lib/credentials/aws/** (only if a shared constant lives there) , tests/credentials/** , tests/providers/aws/drivers/compute/** ,
docs/platform/** (boundary mentions only).

## Verification
- `npx tsc --noEmit` (at most twice) ; `npx eslint <touched TS paths>`
- `npx vitest run --maxWorkers=1 tests/credentials tests/providers/aws/drivers/compute tests/providers/aws/drivers/index.test.ts`
- `npx tsx deploy/aws/tools/generate-tofu-policies.ts --check` (or --write then git diff) ; real `tofu validate` of the module is
  network-gated — if you cannot run tofu, say so; the orchestrator runs it.
