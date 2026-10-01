# Connect an AWS account to Zenith (keyless)

Zenith never asks for an access key. It proves who it is with a short-lived
signed token (OpenID Connect) and AWS hands it temporary credentials for one
operation. This folder is everything you run in your account to allow that:

| File | What it is |
|---|---|
| `zenith-connection.cfn.yaml` | CloudFormation template (the reference) |
| `tofu-module/` | Equivalent OpenTofu/Terraform module (policies are generated from the template) |

Both create the same things:

| Resource | Purpose |
|---|---|
| IAM OIDC provider | lets AWS verify Zenith's tokens (client id `sts.amazonaws.com`) |
| `ZenithObserveRole` | **read-only** inspection: describe / list / get. Cannot read secret values. |
| `ZenithDeployRole` | changes **only** resources tagged `zenith:managed=true` or named `zenith-*`; creates IAM roles **only** with the permission boundary attached; cannot modify itself |
| `ZenithWorkloadBoundary` | permission boundary every role Zenith creates must carry (denies IAM, Organizations and the state bucket) |
| state bucket `zenith-state-<account>-<region>` | OpenTofu state + build artifacts: versioned, private, encrypted, TLS-only, **kept if you delete the stack** |
| `zenith-codebuild` role | image builds run in *your* account; pushes only to `zenith-*` ECR repositories |

There are no IAM users, no access keys, no passwords and no secrets in any of it.

## Before you start

Zenith shows you two values when you start the connection:

* **issuer host**, e.g. `app.tryzenith.cloud/api/oidc` (no `https://`)
* **subject**, e.g. `zenith:ws:<workspace>:conn:<connection>` — the *exact* token
  subject Zenith will present. Only a token with this subject can assume your roles.

Requirements: the issuer must be reachable on public HTTPS (AWS fetches
`<issuer>/.well-known/openid-configuration` and the key set itself); you need
permission to create IAM roles/policies, an OIDC provider and an S3 bucket.

## Option A — CloudFormation

Console: *CloudFormation → Create stack → Upload a template file*, choose
`zenith-connection.cfn.yaml`, fill in the parameters below, tick
"I acknowledge that AWS CloudFormation might create IAM resources with custom
names", create.

CLI:

```bash
aws cloudformation deploy \
  --template-file deploy/aws/zenith-connection.cfn.yaml \
  --stack-name zenith-connection \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
      ZenithIssuerHost=app.tryzenith.cloud/api/oidc \
      ZenithOidcSubject=zenith:ws:WORKSPACE_ID:conn:CONNECTION_ID

aws cloudformation describe-stacks --stack-name zenith-connection \
  --query 'Stacks[0].Outputs' --output table
```

| Parameter | Default | Notes |
|---|---|---|
| `ZenithIssuerHost` | — | issuer without scheme |
| `ZenithOidcSubject` | — | exact subject from Zenith (wildcards are rejected) |
| `CreateOidcProvider` | `yes` | `no` if the provider for this issuer already exists in the account (one per issuer URL) |
| `EnvironmentTagValue` | `*` | `*` = any Zenith environment; an exact environment id confines the deploy role to `zenith:environment=<id>` |
| `Route53HostedZoneArns` | empty | zones Zenith may change DNS records in, as ARNs. **Empty = no DNS write access at all.** |
| `StateBucketKmsKeyArn` | empty | optional customer-managed key for the state bucket (SSE-KMS); empty = AES256 |
| `NameSuffix` | empty | e.g. `-team-a`, so several Zenith connections can live in one account |
| `ZenithPrincipalArn` + `ExternalId` | empty | only for a Zenith control plane that itself runs on AWS (`sts:AssumeRole` + ExternalId instead of OIDC) |

## Option B — OpenTofu / Terraform

```hcl
module "zenith" {
  source = "./deploy/aws/tofu-module"

  zenith_issuer_host  = "app.tryzenith.cloud/api/oidc"
  zenith_oidc_subject = "zenith:ws:WORKSPACE_ID:conn:CONNECTION_ID"

  # route53_hosted_zone_arns = ["arn:aws:route53:::hostedzone/Z123EXAMPLE"]
  # environment_tag_value    = "env_id"
}

output "zenith" {
  value = {
    observe_role_arn = module.zenith.observe_role_arn
    deploy_role_arn  = module.zenith.deploy_role_arn
    state_bucket     = module.zenith.state_bucket_name
    account_id       = module.zenith.account_id
  }
}
```

Requires OpenTofu/Terraform ≥ 1.6 and the AWS provider ≥ 6.0. Variable names mirror
the CloudFormation parameters (`snake_case`).

## Finish in Zenith

Give Zenith the outputs: **account id, region, observe role ARN, deploy role ARN,
state bucket name**. Zenith verifies the connection by assuming the observe role
and calling `sts:GetCallerIdentity`; it must return your account id. Until that
check passes the connection stays `pending_verification` and nothing runs.

## Conventions Zenith relies on

Everything Zenith creates is named `zenith-<environment>-…` and tagged
`zenith:managed=true` and `zenith:environment=<environment>`. The deploy role and
the per-operation session policies both key off those. A resource that does not
follow the convention is simply outside Zenith's reach — which is the safe
failure. (Name patterns end in a `-` or `/`; environment ids that are
hyphen-delimited prefixes of one another, like `prod` and `prod-eu`, overlap in
name-based patterns. Fixed-width ids cannot. The exact-match `zenith:environment`
tag is the precise boundary where the AWS service supports it.)

## What each permission is for

Permissions are split across managed policies because IAM caps one managed policy
at 6,144 characters. Read-only actions are unconditioned (most Describe/List APIs
have no resource-level permissions); **every mutating action is conditioned on the
`zenith:managed` tag or a `zenith-*` name**, except the two documented exceptions
below.

| Policy | Attached to | Grants |
|---|---|---|
| `ZenithObservePolicy` | observe + deploy | Describe/List/Get across ec2, ecs, ecr, elbv2, rds, elasticache, sqs, route53, acm, cloudwatch, logs, ssm (Describe only), secretsmanager (`DescribeSecret`/`ListSecrets` only), codebuild, lambda (config, no code), events, autoscaling; `tag:GetResources`; read of `zenith-*` buckets and `zenith-*` IAM roles/policies; read of the state bucket (OpenTofu plans read state). **Explicitly denies** `secretsmanager:GetSecretValue` and `ssm:GetParameter*`. |
| `ZenithDeployNetwork` | deploy | VPC, subnets, route tables, gateways, security groups, endpoints, launch templates, instances: create only **with** `zenith:managed=true` in the request; change/delete only resources already carrying it. Denies creating children in an untagged VPC. |
| `ZenithDeployBalancing` | deploy | ALB/NLB, target groups, listeners, rules, auto scaling groups named `zenith-*` |
| `ZenithDeployCompute` | deploy | ECS clusters/services/tasks, ECR repositories, Lambda functions, EventBridge rules, CodeBuild projects — all `zenith-*` |
| `ZenithDeployData` | deploy | RDS, ElastiCache, S3 buckets, SQS queues, Secrets Manager **containers** (create/update/delete/tag — **never** values) named `zenith-*` |
| `ZenithDeployEdge` | deploy | log groups and alarms named `zenith-*`, ACM certificates tagged `zenith:managed`, DNS record changes **only in zones you list** |
| `ZenithDeployState` | deploy | read/write objects in the state bucket; **denies** deleting or reconfiguring the bucket and deleting object versions |
| `ZenithDeployIam` | deploy | `iam:CreateRole` / `Put|Attach|Detach|DeleteRolePolicy` / `DeleteRole` on `role/zenith-*` **only with the boundary attached**; attach only `zenith-*` policies plus three AWS task/lambda execution policies; `iam:PassRole` only to `zenith-*` roles for `ecs-tasks`, `codebuild`, `lambda`; service-linked roles for ecs/elbv2/autoscaling/rds/elasticache. **Denies**: changing `ZenithDeploy*`/`ZenithObserve*`/`zenith-codebuild*` roles and policies or the boundary, removing any permission boundary, creating users/access keys/login profiles, touching OIDC/SAML providers, Organizations, Account. |
| `ZenithWorkloadBoundary` | roles Zenith creates | logs, ECR pull, `zenith-*` buckets and queues, secret **reads** for injection into the workload's own secrets, KMS via those services, VPC ENIs. Denies `iam:*`, `organizations:*`, `account:*` and the state bucket. |

### Known limits (not hidden)

* `ecs:RegisterTaskDefinition` / `DeregisterTaskDefinition` accept only `Resource: "*"`
  in IAM. Zenith can add revisions to task-definition families it can name but cannot
  change a running service of yours (`UpdateService` is name- and boundary-scoped).
* `ec2:RunInstances` on public AMIs has no tag to condition on; the call still fails
  unless the instance, volumes and network interfaces are tagged `zenith:managed=true`.
* `logs:GetQueryResults` / `StopQuery` / `DescribeQueries` accept only `Resource: "*"`
  (they are read-only and need an unguessable query id).
* EC2 instance profiles, application auto scaling and SSM Parameter Store writes are
  **not** enabled. Add them deliberately if you need them (see "Extending").
* Session-time narrowing per capability (`src/lib/credentials/aws/session-policy.ts`)
  can only remove permissions from these roles, never add any.

## Revoke Zenith

Fastest to slowest; all take effect for *new* sessions immediately (a session
Zenith already holds lasts at most 15 minutes–1 hour):

1. **Delete the OIDC provider** (`IAM → Identity providers`, or
   `aws iam delete-open-id-connect-provider --open-id-connect-provider-arn …`).
   Nothing can federate in any more. If other Zenith connections in this account
   share the provider, they stop too.
2. **Delete the stack** (`aws cloudformation delete-stack --stack-name zenith-connection`)
   or `tofu destroy`. Roles, policies and (if the stack created it) the OIDC provider
   go. The state bucket is **retained**: your infrastructure state is not deleted
   implicitly. Empty and delete it yourself when you are done with it.
3. **Narrow instead of revoke:** redeploy with `EnvironmentTagValue=<one environment>`
   and an empty `Route53HostedZoneArns`.
4. Resources Zenith created (tagged `zenith:managed=true`) are yours and keep running
   after revocation; find them with the Resource Groups Tagging API
   (`aws resourcegroupstaggingapi get-resources --tag-filters Key=zenith:managed,Values=true`).

## Troubleshooting `AccessDenied` on assume

Check, in order: the OIDC provider exists for **exactly** the issuer URL
(`https://<ZenithIssuerHost>`); the subject you pasted equals what Zenith shows
(the trust policy compares it exactly); the audience is `sts.amazonaws.com`;
`https://<issuer>/.well-known/openid-configuration` and `…/jwks` return JSON without
a login redirect; the role trust policy still contains `sts:TagSession` (Zenith adds
session tags to the token); CloudTrail's `AssumeRoleWithWebIdentity` event shows the
reason.

## Extending

Add statements to the relevant `Deploy*` policy in `zenith-connection.cfn.yaml`
(the OpenTofu policy templates are regenerated from it:
`npx tsx deploy/aws/tools/generate-tofu-policies.ts --write`), keep every mutating
action tag- or name-conditioned, and run `npx vitest run tests/credentials` — the
static checks fail if a mutation is unconditioned, a policy passes IAM size limits, or
the two artifacts drift.

## What was verified, and what was not

Verified here, without an AWS account:

* the template parses and passes `cfn-lint` with no findings (including IAM action-name
  validation), and the static tests evaluate it for three parameter sets (OIDC only,
  everything on, AssumeRole only);
* the tests assert: no `Action: "*"` on `Resource: "*"`, every mutating deploy action
  is tag/name-conditioned, IAM role creation requires the boundary, self-modification
  is denied, secrets values are unreadable, size limits hold (each managed policy ≤ 6,144
  characters, trust ≤ 2,048), and the broker's per-capability session policies stay
  inside what these roles grant;
* the OpenTofu module passes `tofu validate` and `tofu test` against a **mocked** AWS
  provider (plan-level: renders every policy, checks trust conditions and options).

**Not verified: a real deployment.** Nothing here has been applied to a real AWS
account or exchanged with real STS. IAM condition-key behaviour (for example
`iam:PermissionsBoundary` on `AttachRolePolicy`, tag conditions on individual
services) is written from the AWS documentation and needs the first real connection
to confirm. Expect that a first `tofu apply` by Zenith may hit an `AccessDenied` that
needs one more statement; the deny-by-default posture makes that the safe direction.
