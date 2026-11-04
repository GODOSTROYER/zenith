# WS-AWS-MORE — the AWS native types still in NOT_YET_IMPLEMENTED

Workstream: WS-AWS-MORE (new; orchestrator brief) — Branch ws/aws-more — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-aws-more
Base: platform/integration

## Situation
src/lib/providers/aws/drivers/index.ts lists `NOT_YET_IMPLEMENTED`: `aws:sns_topic` (pubsub),
`aws:eks_cluster` (kubernetes_cluster), `aws:ebs_volume` (volume). Read the shared helpers
(src/lib/providers/aws/drivers/shared/**: names, tags, errors, observe, verify, refs/locals publishing,
security-group ownership, FragmentBuilder) and an existing driver of each group first.

## Objective
1. `aws:sns_topic` — KMS-encrypted topic, tag-based observe, publish grant support in the IAM grant
   table (src/lib/providers/aws/drivers/data/iam-grants.ts — exact ARNs, no wildcards), subscription of
   SQS queues when the graph binds them.
2. `aws:ebs_volume` — encrypted gp3 volume in the node's AZ, deletionPolicy → prevent_destroy,
   attachment only when the graph names an instance.
3. `aws:eks_cluster` — private endpoint (or restricted public CIDRs), secrets encryption with KMS,
   managed node group in private subnets, IRSA/Pod Identity enabled, control-plane logging, the
   cluster's security group via shared/security-group.ts; publishes the attributes the Kubernetes
   provider needs to build a session (endpoint, CA, OIDC issuer) as locals.
Remove them from NOT_YET_IMPLEMENTED; register in `awsDrivers`.

## Owned paths
NEW files only under src/lib/providers/aws/drivers/messaging/**, storage/**, eks/** (or similar new
directories) ; the registration lines in src/lib/providers/aws/drivers/index.ts ; additive rows in
data/iam-grants.ts for sns publish ; tests in NEW files under tests/providers/aws/drivers/<group>/ .
WS-DRIVER-FIX is editing existing AWS driver files (ec2, lambda, rds, scheduled task, static site) and
the contract test — do not touch those files; if the generic contract test needs a change for your
drivers, describe it in your report.

## Verification
- npx tsc --noEmit ; npx eslint src/lib/providers/aws tests/providers/aws
- npx vitest run --maxWorkers=2 tests/providers/aws
- ZENITH_TEST_TOFU_NETWORK=1 npx vitest run --maxWorkers=2 <your new test files> (say if tofu cannot run)
