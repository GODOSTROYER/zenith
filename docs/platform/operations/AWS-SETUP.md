# Connecting an AWS account

For the person who owns the AWS account. Zenith never asks for an access key: it
proves who it is with a short-lived signed token (OpenID Connect) and AWS hands it
temporary credentials for one operation. This page explains what that gives
Zenith, what it does not, and how to take it back. **The commands and the
parameter tables are in [`deploy/aws/README.md`](../../../deploy/aws/README.md);
this page does not repeat them.**

Written against branch `ws/docs` at commit `fd2ce9f` (2026-09-30).

**Status, stated up front.** The bootstrap template and module, the broker and the
issuer are built and tested without an AWS account. **Nothing has been applied to
a real account and no real token has been exchanged with real STS.** The IAM
policies are written from the AWS documentation; expect that a first real
deployment may hit an `AccessDenied` that needs one more statement. The
deny-by-default posture makes that the safe direction. The Zenith-side step of
entering your role ARNs has no screen or route on this branch yet; see
[What is not built](#what-is-not-built).

## What you run, and what it creates

You run one thing in your account, either as CloudFormation
(`deploy/aws/zenith-connection.cfn.yaml`) or as the equivalent OpenTofu module
(`deploy/aws/tofu-module/`). Both create the same resources. Steps and
parameters: [deploy/aws/README.md, Option A and B](../../../deploy/aws/README.md#option-a--cloudformation).

| Resource | What it is for |
|---|---|
| An IAM OIDC provider | Lets AWS verify Zenith's tokens (client id `sts.amazonaws.com`). One exists per issuer URL per account. |
| `ZenithObserveRole` | Read-only inspection. |
| `ZenithDeployRole` | The only role that changes things, and only things it is allowed to see as Zenith's. |
| `ZenithWorkloadBoundary` | A permission boundary every IAM role Zenith creates must carry. |
| A state bucket, `zenith-state-<account>-<region>` | OpenTofu state and build artifacts. Yours, and kept if you delete the stack. |
| `zenith-codebuild` role | Lets image builds run in **your** account, pushing only to `zenith-*` ECR repositories. |

There are no IAM users, access keys, passwords or secrets in any of it.

Zenith shows you two values when you start the connection, which you paste into
the parameters unchanged: the **issuer host** (for example
`app.example.com/api/oidc`, no scheme) and the **subject**
(`zenith:ws:<workspace>:conn:<connection>`). The trust policy compares the subject
**exactly**: only a token for that one workspace and connection can assume your
roles, and wildcards are refused. The issuer must be reachable on public HTTPS,
because AWS fetches its discovery document and key set itself.

## What Zenith can do in your account

Everything below is what the shipped policies grant, read from
`zenith-connection.cfn.yaml` and the deploy README; none of it has been exercised
against a live account.

### Observe (`ZenithObserveRole`)

Describe, list and get across the services Zenith manages (ECS, ECR, load
balancers, EC2 and networking, RDS, ElastiCache, SQS, Route 53, ACM, CloudWatch
metrics and logs, SSM describe-only, Secrets Manager describe and list only,
CodeBuild, Lambda configuration, EventBridge, Auto Scaling), tag lookups, and read
of `zenith-*` buckets, `zenith-*` IAM roles and the state bucket (OpenTofu plans
read state). This role is used for read capabilities and for the plan step.

### Deploy (`ZenithDeployRole`)

Create, change and delete **only** resources that carry the tag
`zenith:managed=true` or are named `zenith-*`. In detail, by policy:

| Area | What is allowed |
|---|---|
| Network | VPC, subnets, route tables, gateways, security groups, endpoints, launch templates, instances: create only with `zenith:managed=true` in the request; change or delete only what already carries it |
| Load balancing | ALB / NLB, target groups, listeners, rules, auto scaling groups named `zenith-*` |
| Compute | ECS clusters, services and tasks, ECR repositories, Lambda functions, EventBridge rules and CodeBuild projects, all `zenith-*` |
| Data | RDS, ElastiCache, S3 buckets, SQS queues and Secrets Manager **containers** (create, update, delete, tag), all `zenith-*` |
| Edge | Log groups and alarms named `zenith-*`, ACM certificates tagged `zenith:managed`, DNS record changes **only in the hosted zones you list** (an empty list means no DNS write access at all) |
| State | Read and write objects in the state bucket |
| IAM | Create, change and delete roles named `zenith-*` **only with the permission boundary attached**; attach only `zenith-*` policies plus three AWS task and execution policies; `iam:PassRole` only to `zenith-*` roles for ECS tasks, CodeBuild and Lambda |

### How narrow a session is

Each operation gets its own session, not the role's full reach:

- **Short-lived.** The token Zenith presents lives two minutes and is used once;
  the resulting AWS session lasts 15 minutes by default and at most one hour
  (`DEFAULT_SESSION_SEC`, `MAX_SESSION_SEC` in `src/lib/credentials/aws/broker.ts`).
  The credentials exist in worker memory for one callback and are then
  invalidated; they are never stored, logged or returned.
- **Narrowed per capability.** For observation, log reads, service restart and
  scale, and database snapshots the broker adds an inline session policy that
  can only *remove* permissions from the role. Infrastructure apply and destroy
  get no session policy: a Terraform apply touches too many services to list in
  the 2,048-character limit, so the tag- and name-conditioned deploy role and the
  permission boundary are the control there
  ([session-policy.ts](../../../src/lib/credentials/aws/session-policy.ts) is explicit about this).
- **Tagged and named.** Every session carries the tags `zenith:workspace`,
  `zenith:operation` and `zenith:capability`, and the role session name is
  `zenith-<first 24 characters of the operation id>`, so a CloudTrail event can be
  traced to one Zenith operation. (How CloudTrail displays the tags was not
  checked.)

## What Zenith cannot do

As written in the template's explicit denies and its absence of grants:

- **Read secret values.** `secretsmanager:GetSecretValue` and `ssm:GetParameter*`
  are explicitly denied in the observe policy, which is attached to both the
  observe and the deploy role. The deploy role manages secret *containers* and
  never their values.
- **Create or change identities outside its fence.** It cannot create IAM users,
  access keys or login profiles, cannot touch OIDC or SAML providers, Organizations
  or the Account APIs, and cannot create a role without the permission boundary.
- **Change itself.** It cannot modify `ZenithDeploy*`, `ZenithObserve*`,
  `zenith-codebuild*` or the boundary, and cannot remove a permission boundary.
- **Touch the state bucket's security.** It can read and write state objects; it
  cannot delete or reconfigure the bucket or delete object versions.
- **Reach resources that do not follow the convention.** A resource that is not
  named `zenith-*` or tagged `zenith:managed=true` is simply outside its reach.
- **Write DNS outside the zones you listed.**
- **Run commands on your machines or containers.** The template grants no
  `ssm:SendCommand` and no `ecs:ExecuteCommand`, so the machine-plane transports
  are not enabled by it. The command-execution capabilities (`machine.exec`,
  `container.exec`) are a separate, critical-risk class that policy denies in
  production by default ([POLICY.md](POLICY.md)).

Known limits of what IAM can express, from the template (not hidden): task
definition registration accepts only `Resource: "*"` in IAM, so Zenith can add
revisions to task definition families it can name but cannot change a running
service of yours (`UpdateService` is name- and boundary-scoped);
`ec2:RunInstances` on public AMIs has no tag to condition on, so the call fails
unless the instance, volumes and network interfaces are tagged
`zenith:managed=true`; `logs:GetQueryResults`, `StopQuery` and `DescribeQueries`
accept only `*`. EC2 instance profiles, application auto scaling and SSM
Parameter Store writes are **not** enabled.

One overlap to know about: name patterns end in `-` or `/`, so two environment ids
where one is a hyphen-delimited prefix of the other (`prod` and `prod-eu`) overlap
in name-based patterns. The exact-match `zenith:environment` tag is the precise
boundary where the AWS service supports it. Fixed-width ids (UUIDs) cannot overlap.

## What Zenith stores about your account

Only non-secret identifiers: account id, region, the two role ARNs, the state
bucket name, optionally a KMS key ARN, the boundary and CodeBuild role ARNs
(`AwsConnectionConfig` in `src/lib/credentials/types.ts`, persisted in
`platform.provider_connections`). The store refuses a connection config that has
a member named like a secret (`secretAccessKey`, `password`, `token`, `apiKey`...)
or a value that looks like key material. Stealing Zenith's database yields no
cloud credential; the trust anchor is Zenith's OIDC signing key, which is why
production uses a KMS-backed one ([RECOVERY.md](RECOVERY.md#6-key-rotation)).

## Verifying the connection

You give Zenith the stack outputs: **account id, region, observe role ARN, deploy
role ARN, state bucket name** (and, for the OpenTofu module, the boundary and
CodeBuild role outputs). Zenith verifies by assuming the observe role and calling
`sts:GetCallerIdentity`; the account id must match. Until that passes the
connection stays `pending_verification` and nothing runs. That check is
`AwsCredentialBroker.verifyConnection`.

If assuming the role is denied, work through
[Troubleshooting `AccessDenied` on assume](../../../deploy/aws/README.md#troubleshooting-accessdenied-on-assume)
in the deploy README: the OIDC provider for exactly that issuer URL, the exact
subject, the audience `sts.amazonaws.com`, the two public endpoints returning
JSON without a login redirect, `sts:TagSession` still in the trust policy, and the
CloudTrail `AssumeRoleWithWebIdentity` event.

## Revoking Zenith

Fastest to slowest; each takes effect for **new** sessions immediately. A session
Zenith already holds lasts at most its 15 minute to one hour lifetime. The
step-by-step is in [deploy/aws/README.md, Revoke Zenith](../../../deploy/aws/README.md#revoke-zenith);
in short:

1. **Delete the OIDC provider.** Nothing can federate in any more. If other Zenith
   connections in this account share the provider they stop too.
2. **Delete the stack** (or `tofu destroy`): the roles, policies and, if the stack
   created it, the OIDC provider go. **The state bucket is kept.**
3. **Narrow instead of revoke:** redeploy with `EnvironmentTagValue` set to one
   environment and an empty `Route53HostedZoneArns`.

What survives revocation: the resources Zenith created (tagged
`zenith:managed=true`) are **yours** and keep running, and so does the state
bucket. Find everything Zenith made with
`aws resourcegroupstaggingapi get-resources --tag-filters Key=zenith:managed,Values=true`.
The exported OpenTofu in the product (`docs/LIMITATIONS.md`, AWS Preview) is real,
applyable IaC if you want to carry on without Zenith.

## What is not built

- **The Zenith side of "Finish in Zenith".** Entering the outputs, seeing
  `pending_verification` turn to `verified`, and choosing which environments use
  the connection need the REST surface (`/api/platform/v1`) and the UI, which are
  in progress. The building blocks exist: `platform.provider_connections`,
  `AwsCredentialBroker.verifyConnection`, and the OIDC endpoints.
- **Anything beyond AWS.** GCP, Azure, OCI and Kubernetes connections are in
  progress; `ProviderConnection` has types for them, but nothing is documented or
  verified.
- **Real deploys.** The worker's activities are stubs
  ([DEPLOYING.md](DEPLOYING.md#status-what-actually-runs-on-this-branch)), so a
  connected account cannot yet be changed by Zenith through the platform path.
- **Runner mode.** Jobs executed by a customer-side runner with local identity
  (credentials never leave your network) are designed
  ([RUNNER-PROTOCOL.md](../RUNNER-PROTOCOL.md)) and in progress.
