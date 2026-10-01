# WS-AWS-BOUNDARY-MORE — scheduled jobs and EC2 machines work under the workload boundary

Workstream: WS-AWS-BOUNDARY-MORE (orchestrator brief) — Branch ws/aws-boundary-more — worktree Z:/Projects/Spawned.ai/zenith-wt/ws-aws-boundary-more
Base: ws/integrate-w6 (staging: WS-AWS-BUILD-BOUNDARY merged — read its pattern first)

## Situation
WS-AWS-BUILD-BOUNDARY gave build roles (`role/zenith-*-build`, naming constants in src/lib/credentials/aws/naming.ts, truncation-safe
suffix in codebuild-project.ts ~188) principal-conditioned boundary statements, and added a local boundary evaluator
(tests/credentials/workload-boundary.ts, tests/providers/aws/drivers/compute/{boundary-fixtures.ts,workload-boundary.test.ts}).
Its coverage sweep found two more role families whose role policies ask for actions `ZenithWorkloadBoundary` blocks, so they would
fail with AccessDenied in a live account:
1. **Scheduled jobs** (src/lib/providers/aws/drivers/compute/ecs-scheduled-task.ts ~66, role `${name}-events`): `ecs:RunTask` on its
   task definition and `iam:PassRole` for the task's execution/task roles.
2. **EC2 machines** (src/lib/providers/aws/drivers/compute/ec2-instance.ts ~84, role `${name}-ec2`): the SSM agent's core actions
   (AmazonSSMManagedInstanceCore v2: ssm:UpdateInstanceInformation, ssm:ListAssociations, ssm:ListInstanceAssociations,
   ssm:DescribeAssociation, ssm:GetDocument, ssm:DescribeDocument, ssm:GetManifest, ssm:PutInventory, ssm:PutComplianceItems,
   ssm:PutConfigurePackageResult, ssm:UpdateAssociationStatus, ssm:UpdateInstanceAssociationStatus,
   ssm:GetDeployablePatchSnapshotForInstance; ssmmessages:{Create,Open}{Control,Data}Channel; ec2messages:*Message/GetEndpoint/SendReply).
   The machine plane's AWS transport (SSM Run Command) depends on the agent registering, so this blocks machine operations.
   Also `ssm:GetParameter(s)` is limited to `parameter/zenith/*` — decide whether the agent needs anything else (it should not).

## Do
1. Same approach as the build statements: reserved, truncation-safe role suffixes (`-events`, `-ec2`) exported from naming.ts and used
   by the drivers; boundary statements conditioned on `ArnLike aws:PrincipalArn role/zenith-*-events` / `role/zenith-*-ec2`.
   - Scheduled jobs: `ecs:RunTask` limited to `task-definition/zenith-*` in this account with `ecs:cluster` condition to zenith clusters
     if supported; `iam:PassRole` limited to `role/zenith-*` with `iam:PassedToService` = `ecs-tasks.amazonaws.com`.
   - EC2: the SSM core actions above (most require Resource "*"; cite the Service Authorization Reference for each action's
     resource/condition support and scope wherever AWS allows, e.g. `ssm:UpdateInstanceInformation` on `instance/*` with
     `aws:ResourceTag/zenith:managed`).
   Keep every new grant principal-conditioned so app workload roles gain nothing.
2. Mirror in deploy/aws/tofu-module (main.tf + policies/workload-boundary.json.tftpl via `npx tsx deploy/aws/tools/generate-tofu-policies.ts --write`).
3. Tests with the existing evaluator: every action in the scheduled-job and EC2 role policies is allowed for its principal; no other
   role family (identity, exec, fn, build, a service literally named `web-events` / `web-ec2`) gains them; partitions aws/aws-cn/aws-us-gov.
4. Report any other driver role family that is still blocked (do not widen for it; list it).
5. deploy/aws/README.md + docs/platform/operations/AWS-SETUP.md boundary sections.

## Owned paths
deploy/aws/** , src/lib/credentials/aws/naming.ts , src/lib/providers/aws/drivers/compute/{ecs-scheduled-task,ec2-instance}.ts ,
src/lib/providers/aws/drivers/compute/support/** , tests/credentials/** , tests/providers/aws/drivers/compute/** ,
docs/platform/operations/AWS-SETUP.md (boundary section only).

## Verification
- `npx tsc --noEmit` (at most twice) ; `npx eslint <touched TS paths>`
- `npx vitest run --maxWorkers=1 tests/credentials tests/providers/aws/drivers/compute`
- `npx tsx deploy/aws/tools/generate-tofu-policies.ts --check`; real tofu validate is network-gated — say if not run.
