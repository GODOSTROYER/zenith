# PROD-LIFE-03 verification: AWS family migration and suffixes (wave 4)

Branch `prod/life-03-w4`, base c9a942d6. No platform migration was needed (version 37 unused). Nothing here runs a cloud API, OpenTofu or a test; the verifying machine does that.

## 1. What was built

Audit result first. Already present and reused unchanged: the bootstrap suffix flows from the saved connection (`bootstrapNameSuffix`) through `awsBootstrapContextForConnection` into `CompileContext.awsBootstrap`, `DriverContext.awsBootstrap`, `trustedAwsBoundaryArn`, every role-creating driver (`iam-role`, `ecs-task`, `lambda-function`, `codebuild-project`, `ec2-instance`, `ecs-scheduled-task`, `eks-cluster`, `vpc-compile`), the plan/destroy/readback paths and the native preflight (`src/lib/credentials/aws/bootstrap-preflight.ts`, wired through `src/lib/platform/credentials.ts` and `src/lib/execution/aws-bootstrap-preflight.ts`). The audit found no driver that bypasses the suffix. What was missing, and is now built:

New library modules (`src/lib/credentials/aws/`, all re-exported from `index.ts`):
- `partition.ts`: `aws`, `aws-cn`, `aws-us-gov` ARN builders, strict region to partition, a reviewed service-principal table (China uses `.com.cn` for EC2 only), same-partition assertions. Contract-level only.
- `limits.ts`: explicit refusals (`AwsLimitError`, fixed messages, no input echo) for environment id, suffix, role name versus the 64-character IAM limit with reserved family suffix, policy names (128), state bucket name (63, longest region assumed), hosted zone count and shape, and the preflight inventory capacity under the 2,048-character session policy. Owns the hosted-zone constants: 20 inline, 40 per overflow policy, 2 overflow policies, 100 maximum (the deploy role keeps 8 base managed policies, IAM default quota is 10).
- `policy-budget.ts`: compact-size metric, `readPolicyBudget`, `assertBoundaryFits` (boundaries cannot be split, explicit refusal), and `planManagedPolicySplit` (deterministic first-fit-decreasing, whole statements only, order-stable, refuses an unfittable statement or more policies than the role quota).
- `least-privilege.ts` and `compiler-actions.ts`: the diff engine and the catalogue of write actions per Terraform resource type the drivers emit (68 types, pinned equal to a source scan) plus runtime actions (state backend, source objects, builds, scheduled tasks).

Wiring (reachable, no opt-in hooks):
- `src/lib/execution/compile.ts`: `compileGraph` runs `assertAwsBootstrapLimits` for the saved connection and environment before any driver compiles; refusal is a `StepFailedError` with the fixed message.
- `src/lib/actions/defs/connection-aws.ts` (`connection.createAws`): the same limit check at registration, as a field issue on `bootstrapNameSuffix`.
- `src/lib/providers/aws/drivers/data/iam-role.ts` and `compute/support/tf.ts` (`assumeRoleJson`, now with an optional context) plus the five compute drivers: trust principals are rendered through the partition table. Commercial output is byte-identical to before; only non-commercial regions or contexts differ. Runtime registration stays commercial-only (the existing refusal in `awsBootstrapContextForConnection` is untouched and re-tested).
- OpenTofu module (`deploy/aws/tofu-module/main.tf`, `variables.tf`): hosted zones beyond 20 split automatically into `ZenithDeployEdgeDns<N><suffix>` policies of 40, attached to the deploy role; variable validation refuses more than 100 zones and duplicates. With 20 or fewer zones the rendered policies are identical to before. `tests/bootstrap.tftest.hcl` has three new runs (overflow, over-limit, duplicate).
- `deploy/aws/tools/generate-tofu-policies.ts`: size budgets now use the shared constants, the guard evaluates 20 maximum-length zones per partition, adds the overflow policy check, `policyBudgetReport()` and a `--report` flag, and its refusal for an over-budget deploy policy states the deterministic split it would need. Boundaries refuse as unsplittable.
- `deploy/aws/tools/least-privilege-diff.ts` (+ `least-privilege-baseline.json`): offline CLI (`--json`, `--check`, `--write-baseline`) comparing the CloudFormation-evaluated deploy policies with the compiler's needed actions. Nothing is widened by it.
- Live harness (commercial partition only, gated): `scripts/acceptance/aws-iam-permissions.ts` and `aws-iam-permissions-cli.ts`. Requires `ZENITH_LIVE_AWS_IAM=1`, a credentials FILE reference (`ZENITH_LIVE_AWS_CREDENTIALS_FILE`, path only, never read or printed here), matching account, an `aws` partition role ARN. Read-only APIs only (STS identity, IAM readback of the deploy role's attached policies, policy simulator). Exit codes: 0 passed, 1 failed, 2 refused, 3 skipped (a skip is never a pass).
- `deploy/aws/README.md`: hosted zone limits documented.

## 2. Acceptance mapping

Ledger clause: "Stack-first boundaries and bootstrap suffix propagate into connection/compiler/role selection; maximum names/partitions/zones fit IAM and actual permissions independently verified without widening privilege."

| Clause part | Implementation | Tests |
| --- | --- | --- |
| Suffix propagation connection to compiler to role selection | pre-existing chain (audited), plus limit refusal in `compile.ts` and `connection-aws.ts` | `tests/execution/aws-bootstrap-context.test.ts` (existing), `tests/credentials/aws/bootstrap-context.test.ts` (existing), `tests/execution/aws-limits-compile.test.ts` (new) |
| Stack-first preflight | pre-existing `preflightAwsBootstrap`; capacity of its session policy now stated exactly | `tests/credentials/aws/limits.test.ts` (capacity equals the real `awsBootstrapPreflightSessionPolicy` boundary), `tests/credentials/aws/bootstrap-preflight.test.ts` (existing) |
| Maximum names | `limits.ts` role/policy/bucket/environment limits | `limits.test.ts` compiles every managed AWS driver at a 64-character environment id and asserts every role name is at most 64, starts `zenith-`, ends in a reserved family suffix |
| Maximum partitions | `partition.ts`, partition-aware trust principals | `tests/credentials/aws/partition.test.ts` (three partitions, boundaries, ARNs, principals, sovereign runtime still refused). Contract-level; sovereign live acceptance deferred |
| Maximum zones | `limits.ts` constants, tofu module overflow, generator budget | `limits.test.ts` (plan chunks, 100 accepted and 101 refused, DeployEdge with 20 and an overflow policy with 40 maximum-length ARNs fit 6,144 in every partition, main.tf and variables.tf literals pinned to the constants), tofu tests |
| Policy size budgeting and split | `policy-budget.ts`, generator refusal with split plan, automatic split for zones in tofu | `tests/credentials/aws/policy-budget.test.ts` |
| Least privilege, no widening | `least-privilege*.ts`, CLI, baseline | `tests/credentials/aws/least-privilege.test.ts`: catalogue equals scanned driver types and covers compiled production and staging fixtures; no new missing action and no new unused sensitive grant versus the baseline; engine unit tests |
| Independent verification against actual permissions | live harness | `tests/acceptance/aws-iam-live.test.ts`: contract-level gating, probe table and modeled-port orchestration always run; the LIVE block is skipped unless `ZENITH_LIVE_AWS_IAM=1` |

## 3. Verification commands (other machine)

Node 22. From the repo root:

```
npx vitest run tests/credentials/aws tests/credentials/bootstrap-templates.test.ts tests/credentials/session-policy.test.ts tests/execution/aws-limits-compile.test.ts tests/execution/aws-bootstrap-context.test.ts tests/acceptance/aws-iam-live.test.ts tests/providers/aws/drivers tests/providers/aws/identity
npx tsx deploy/aws/tools/generate-tofu-policies.ts --check
npx tsx deploy/aws/tools/generate-tofu-policies.ts --report
npx tsx deploy/aws/tools/least-privilege-diff.ts --check
cd deploy/aws/tofu-module && tofu init -backend=false && tofu test
```

Expected: all pass; the live block of `aws-iam-live.test.ts` reports as skipped. `--check` for the generator reports no drift (no generated template changed: `main.tf` consumes the same files; only the guard and report changed). `least-privilege-diff --check` exits 0 with 9 known missing actions (all denied by design) and no unused sensitive grants. If its count differs, run it without `--check` to see the actual lists, then `--write-baseline` only after review. The baseline was regenerated by the repo's own tool.

Live (deferred by the user, run only by the account owner in a disposable sandbox):

```
ZENITH_LIVE_AWS_IAM=1 ZENITH_LIVE_AWS_ACCOUNT_ID=<id> ZENITH_LIVE_REGION=us-east-1 \
ZENITH_LIVE_AWS_DEPLOY_ROLE_ARN=arn:aws:iam::<id>:role/ZenithDeployRole<suffix> ZENITH_LIVE_AWS_NAME_SUFFIX=<suffix> \
ZENITH_LIVE_AWS_CREDENTIALS_FILE=/abs/path/to/shared-credentials \
npx tsx scripts/acceptance/aws-iam-permissions-cli.ts --out ./evidence
```

## 4. Known gaps and things that may break first

- Follow-up applied (least-privilege findings acted on, source of truth `deploy/aws/zenith-connection.cfn.yaml`, tofu templates regenerated with the repo generator): granted, scoped by name prefix, tags and partition ARNs like neighbouring statements: `ec2:CreateFlowLogs/DeleteFlowLogs` (tagged VPC, tagged flow log; DeployNetwork), instance-profile create/tag (request tags) and manage (`instance-profile/zenith-*`), ElastiCache user and user-group create (request tag) and manage (`user:zenith-*`, `usergroup:zenith-*`) (DeployBalancing), tagged CloudFront distributions (`CreateDistributionWithTags`, update, delete, tag; origin access controls have no tag or name scoping and are a documented exception in the bootstrap test) and `kms:ScheduleKeyDeletion` only for keys tagged `zenith:managed` and the environment scope (DeployEdge). Deletion is only scheduled; the destructive-approval gating stays in the execution path. No policy exceeded its budget, so no split was needed (worst case aws-us-gov stays below 6,144 per `--report`).
- Kept denied by design, now baseline status `denied_by_design`: the five OIDC provider actions (explicit `DenyPrincipalCreation` retained) and the four `ssm:` parameter write actions. The deploy role must never write SSM parameters (existing bootstrap test), so the `aws_ssm_parameter` image pointer the ECS task driver emits cannot be applied through it; the owner must change that driver. I did not grant these.
- Removed the seven `iam:*Policy*` authoring grants (`CreatePolicy`, `CreatePolicyVersion`, `DeletePolicy`, `DeletePolicyVersion`, `SetDefaultPolicyVersion`, `TagPolicy`, `UntagPolicy`): no compiler, runtime, readback, cleanup or bootstrap caller (grep of src, scripts and tests found none; the explicit Deny of changes to `policy/Zenith*` stays). `kms:CreateGrant` is kept: the existing `KmsGrantToAwsResources` statement (conditioned on `kms:GrantIsForAWSResource` and tags) is needed by EKS, RDS, ElastiCache and EBS encryption with a Zenith-tagged key; the catalogue now lists it for those resource types, so it is no longer an unused sensitive grant.
- Baseline regenerated with `least-privilege-diff.ts --write-baseline`: 9 known missing (all `denied_by_design`), 0 allowed unused sensitive. `--check` exits 0.
- The static policies cannot auto-split: the deploy role has no spare managed-policy slot under the default quota. The generator refuses with a split plan instead. Only hosted zones split automatically.
- The CloudFormation template cannot overflow zones (limit 20 there; IAM refuses larger).
- Tofu changes (`main.tf`, `variables.tf`, new test runs) were not executed. Check first: `tofu test` run `hosted_zones_overflow_into_extra_policies` (`merge` of the jsondecoded optional statement) and the two `expect_failures` runs.
- The service-principal table follows AWS documentation, not live verification; sovereign behavior is contract-level only. Region to partition for isolated partitions (`us-iso*`) refuses.
- `tests/credentials/aws/limits.test.ts` compiles every managed driver at a 64-character environment prefix; a driver that needs unusual fixtures could throw, which would be a fixture issue to adjust.
- The generator guard now evaluates 20 maximum-length zones instead of 2; DeployEdge headroom was estimated, not measured.
- "Zones" was interpreted as Route 53 hosted zones (the only per-connection list that grows an IAM policy). Availability zone counts are not an IAM-size concern and are not limited here.

Shared-file updates for the orchestrator (not touched by this branch): gate manifest should register the new test files (`tests/credentials/aws/{partition,limits,policy-budget,least-privilege}.test.ts`, `tests/execution/aws-limits-compile.test.ts`, `tests/acceptance/aws-iam-live.test.ts` with its live block skipped by design, which a no-skip lane may need a named waiver for), the least-privilege `--check` command and the tofu test; LIMITATIONS: sovereign partitions contract-level only, live IAM acceptance pending, the gap list above. No migrations, tables, store functions or workflow wiring.

Verified-behaviour note: no verified behavior was intentionally changed. `assumeRoleJson`, `trustPrincipalFor` and `expectedIamAttributes` keep exact commercial output.

## 5. Suggested ledger implementationStatus

`source_complete_contract_verified_live_iam_acceptance_pending`: suffix chain audited, limits/partition/split/diff built and wired, gated commercial live harness built; live IAM acceptance deferred and sovereign partitions contract-level only.
