# AWS live acceptance: owner runbook

DEC-CLOUD is **unapproved**. No live cloud call or spend was performed by this job. This packet builds the AWS provider-fixture layer and a narrow `ProductScenarioPort` join for the concurrently assembled Wave 5 release journeys. It never promotes a ledger state or release flag.

## What this source can prove

`scripts/acceptance/aws-live.ts --plan` prints every SDK command, IAM action, exact request input, resource scope and maximum attempt count, with a plan SHA-256 and provisional cost. It does not resolve credentials, construct an SDK client or contact a control plane. Existing A-J planning and local J remain reachable with `--scenario`; legacy real AWS journeys explicitly refuse until their clients join the exact production permission envelope. Their authority/quiescence cleanup refusals are preserved.

Live provider fixtures create one private encrypted S3 bucket and nonce object, a bounded IAM nonce-function role, one ARM64 128MiB Lambda echo function, an **empty** ECS cluster, a private encrypted 20GiB PostgreSQL RDS instance and a disposable reserved `.invalid` Route53 zone/TXT record. They independently read ownership and provider state; Lambda invokes real code and S3 compares real object bytes. Empty ECS cluster state is not a running application. RDS configuration is not SQL traffic or restore proof. Reserved-zone readback is not public DNS, domain ownership, ACME or TLS evidence.

Every ledger row requiring `live_sandbox` is included with its acceptance text and AWS fixture dependencies. Full MIX, MAN, OPS and REL journeys need Wave 5's real release integration (including GCP/Azure and managed Kubernetes where required). `ProductScenarioPort.verify` is the small join contract in `scripts/acceptance/live/contracts.ts`; this CLI intentionally has no injected implementation. It must run the product's normal quotas -> authority/intent -> semantics/authorization -> custody -> effect ledger -> provider path, use human browser approvals, prove real independent traffic/readback, and settle accepted operations before teardown. Extending its calls requires extending the deterministic plan and obtaining a new permission approval. Neither fixture success nor an interface implementation that simply returns `complete: true` is acceptable verification.

Current live CLI success for the fixtures ends with **exit 3 / incomplete**, 6 provider checks, 6 cleanup checks and 27 pending product requirements. The dispatch final gate therefore remains red until that join is integrated and verified. This is a stated integration gap, not an alternate product execution path. Commercial/retention/signoff rows do not become approved through an AWS run.

## Before any live run, after the owner's DEC-CLOUD decision

1. Use a new disposable commercial AWS account with no customer/production resources. Approve account, region, availability zones, monthly alarm budget, per-run USD ceiling and provisional regional cost assumptions. The harness cannot approve these decisions.
2. Apply `deploy/live-sandbox/aws/main.tf` as the accountable account owner, never through the live acceptance role. It creates GitHub OIDC trust, a one-hour execution role with an action-ceiling boundary and scoped identity policy, a deny-all Lambda workload boundary, `/zenith/live-sandbox=true`, a monthly budget alarm and two private DB subnets with a security group permitting no ingress. There is no NAT, EKS, ALB or paid VPC endpoint in the lean fixture profile.
3. Configure GitHub's `live-sandbox` environment with required reviewers, prevent self-review, and restrict deployment branches to protected branches/an explicit allowlist. The trust subject is exactly `repo:GODOSTROYER/zenith:environment:live-sandbox`, audience `sts.amazonaws.com`. These protections are external GitHub settings; YAML alone cannot enforce them. See [AWS's GitHub OIDC guidance](https://docs.aws.amazon.com/hi_in/IAM/latest/UserGuide/id_roles_create_for-idp_oidc.html).
4. Set environment variables `LIVE_SANDBOX_AWS_ROLE_ARN`, `LIVE_SANDBOX_AWS_ACCOUNT_ID`, `LIVE_SANDBOX_AWS_REGION`, `LIVE_SANDBOX_AWS_DB_SUBNET_GROUP`, `LIVE_SANDBOX_AWS_DB_SECURITY_GROUP`. Use bootstrap outputs; the role name is `ZenithLiveAcceptance`.
5. Freeze and commit the integrated source. Generate the exact plan below with a fresh run ID and bootstrap outputs. Store its approved `permissionsProposal` in an external `permissions.json`, filling `approvedBy`, `approvedAt`, `expiresAt`, `sourceCommit` (that exact clean candidate SHA), budget and duration. Leave all unrelated Wave 5 root permission fields intact. The additive `awsLive` schema is defined in `contracts.ts`; the example is deliberately unapproved. Set protected environment variable `LIVE_SANDBOX_AWS_PERMISSIONS_JSON` to this approved non-secret document for a dispatch. Do not commit a permission's own source SHA into the source it hashes.

Integration with the assembled Wave 5 root scope: approve a separate copy of the strict root manifest using `scripts/release/permissions-cli.ts approve`, and supply its absolute path as `ZENITH_LIVE_SCOPE_FILE`. Keep `awsLive` in the separate file named by `ZENITH_LIVE_AWS_PERMISSIONS`; adding it to the root document would invalidate the root schema and approval digest. Both approvals must permit the same run, AWS actions, TTL and cost ceiling. The production CLI and pre-OIDC preflight enforce both envelopes before credentials are resolved. Store the approved root JSON in the protected environment variable `LIVE_SANDBOX_SCOPE_JSON` for dispatch. Recovery still requires current root approval for owned teardown; an expired AWS envelope alone cannot bypass it.

## Exact commands on the Mac

Node must be 22; OpenTofu must be 1.12.5. Export `ZENITH_NODE22_BIN` to the verifier's actual Node 22 directory. No Docker is needed for the provider fixtures. Use one workload at a time on the 8GB ARM64 Mac; when verifying the Wave 5 product stack, use its reduced-resource profile and keep Docker at 4GiB. Do not start a second PostgreSQL/Temporal/kind stack for these fixtures.

```bash
export PATH="$ZENITH_NODE22_BIN:$PATH"
node --version
actionlint .github/workflows/live-acceptance.yml
tofu -chdir=deploy/live-sandbox/aws init -backend=false
tofu -chdir=deploy/live-sandbox/aws fmt -check
tofu -chdir=deploy/live-sandbox/aws validate
npx vitest run tests/acceptance/aws-production.test.ts tests/ci/release-gates.test.ts --no-file-parallelism --maxWorkers=1
```

`init` downloads the pinned AWS provider; `validate` and `fmt` do not authorize a cloud plan/apply. Preserve the resulting provider lockfile for integration review. This builder could not execute the installed OpenTofu binary (Windows access denied); syntax/provider validation is unperformed. No bootstrap application is claimed.

After DEC-CLOUD, owner-only bootstrap, with the values approved in that decision:

```bash
export PATH="$ZENITH_NODE22_BIN:$PATH"
tofu -chdir=deploy/live-sandbox/aws plan \
  -var="account_id=$AWS_SANDBOX_ACCOUNT_ID" -var="region=$AWS_SANDBOX_REGION" \
  -var="budget_usd=$AWS_SANDBOX_MONTHLY_BUDGET_USD" -var="alert_email=$AWS_SANDBOX_ALERT_EMAIL" \
  -var="availability_zones=$AWS_SANDBOX_AZS_JSON" -var='dec_cloud_approved=true' \
  -out=approved-bootstrap.tfplan
tofu -chdir=deploy/live-sandbox/aws apply approved-bootstrap.tfplan
tofu -chdir=deploy/live-sandbox/aws output
```

Then generate a **credential-free** exact plan (use a fresh valid UTC run ID):

```bash
export PATH="$ZENITH_NODE22_BIN:$PATH"
npx tsx scripts/acceptance/aws-live.ts --plan \
  --account "$AWS_SANDBOX_ACCOUNT_ID" --region "$AWS_SANDBOX_REGION" \
  --run-id "$AWS_ACCEPTANCE_RUN_ID" --minutes 15 \
  --db-subnet-group "$AWS_SANDBOX_DB_SUBNET_GROUP" \
  --db-security-group "$AWS_SANDBOX_DB_SECURITY_GROUP" --out "$AWS_ACCEPTANCE_PLAN_DIR"
```

Inspect `plan.json`, approve the exact plan hash/calls/cost/clean source, then either dispatch the workflow or invoke the CLI once:

```bash
export PATH="$ZENITH_NODE22_BIN:$PATH"
ZENITH_LIVE_AWS=1 \
ZENITH_LIVE_AWS_ACCOUNT_ID="$AWS_SANDBOX_ACCOUNT_ID" \
ZENITH_LIVE_REGION="$AWS_SANDBOX_REGION" \
ZENITH_LIVE_AWS_RUN_ID="$AWS_ACCEPTANCE_RUN_ID" \
ZENITH_LIVE_AWS_DB_SUBNET_GROUP="$AWS_SANDBOX_DB_SUBNET_GROUP" \
ZENITH_LIVE_AWS_DB_SECURITY_GROUP="$AWS_SANDBOX_DB_SECURITY_GROUP" \
ZENITH_LIVE_AWS_BUDGET_USD="$AWS_ACCEPTANCE_BUDGET_USD" \
ZENITH_LIVE_AWS_PERMISSIONS="$AWS_ACCEPTANCE_PERMISSIONS_FILE" \
ZENITH_LIVE_SCOPE_FILE="$AWS_ACCEPTANCE_SCOPE_FILE" \
ZENITH_LIVE_AWS_SESSION_FILE="$AWS_ACCEPTANCE_SESSION_FILE" \
ZENITH_LIVE_AWS_OUT="$AWS_ACCEPTANCE_EVIDENCE_DIR" \
npx tsx scripts/acceptance/aws-live.ts
```

The session FILE is an owner-issued **short-lived** JSON session with `accessKeyId`, `secretAccessKey`, `sessionToken`, and `expiration` with 46..60 minutes remaining to cover execution plus cleanup; provide only its absolute path. Never place its contents in code, commands, logs or evidence. Local environment credentials, profiles, IMDS, credential processes and endpoint overrides cannot supply a fallback. GitHub dispatch uses the pinned official OIDC action and its protected environment's one-hour session; no stored access key is configured.

Equivalent dispatch after external environment approval:

```bash
gh workflow run live-acceptance.yml --ref "$AWS_ACCEPTANCE_APPROVED_REF" \
  -f run_id="$AWS_ACCEPTANCE_RUN_ID" -f budget_usd="$AWS_ACCEPTANCE_BUDGET_USD"
```

The full fixture test is separate, real and gated. It expects exit 3/incomplete for this source, then independently inspects 6 actual fixture checks, 6 teardown checks, zero failed checks and 27 pending product rows. It cannot certify those product rows. Do not run both CLI and test for the same run ID:

```bash
export PATH="$ZENITH_NODE22_BIN:$PATH"
# With all live variables above exported for a NEW approved run:
ZENITH_LIVE_AWS=1 npx vitest run tests/acceptance/aws-production.live.test.ts --no-file-parallelism --maxWorkers=1
```

Without the flag this test is skipped, never live evidence. With the flag and missing prerequisites it fails. The separate existing IAM boundary-family acceptance remains the LIFE-03 check; use the exact gated commands in `verify/PROD-LIFE-03.md`. This fixture role is not a replacement for Zenith's deploy role.

## Budget, cleanup and evidence limits

The hard admission ceiling reserves the canonical fixed topology, maximum attempts, a 5..20 minute execution window and a 2USD cleanup reserve before **any** AWS call. It refuses an altered self-consistent cost/topology as well as unknown/unplanned calls, changed inputs, missing per-call permission, exhausted attempt counts and expired mutation permission. Before billable creation it atomically claims `/zenith/live-runs/<runId>` using Standard-tier PutParameter with Overwrite=false and independently reads it. This account-side receipt prevents replay from a new directory or another machine. The execution role cannot overwrite/delete the receipt. The bootstrap uses the documented StringEquals condition for ssm:Overwrite; see [AWS Parameter Store condition guidance](https://docs.aws.amazon.com/systems-manager/latest/userguide/parameter-store-policy-conditions.html). Non-billing receipts are intentionally retained for replay prevention, tagged with purpose live-acceptance-receipt, and excluded from workload leak discovery; deletion requires a separate accountable retention decision. Cleanup is limited to already approved teardown/read inventory, can use the original approval after its expiry, and has a 25-minute observation deadline. It cannot create new resources or claim another run in recovery mode. SDK retries are disabled; every attempt is counted and journaled before dispatch.

The 6.45USD default estimate is a conservative **provisional allowance**, not a price quotation or billing measurement. The owner must validate rates before approving it. Budget alarms are delayed billing notifications, not an account spend kill switch. AWS acknowledges billing/notification delay in [its budget guidance](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html). No system can guarantee a dollar cap or successful teardown if AWS/runner/storage is unavailable. If a truly unconditional account cap or teardown guarantee is an acceptance requirement, this lane must remain blocked on that owner decision rather than claiming one.

Every resource is named by run ID and carries `zenith:live-run`, `zenith:managed`, `zenith:purpose`. Before mutation the harness checks caller account and exact execution role, the sandbox opt-in marker, private bootstrap DB network, old tagged leaks and native presence of every planned name. Before deletion it checks all three ownership tags, deletes dependents before their prerequisites and polls each provider's native absence. A Lambda deletion failure blocks IAM role deletion. Access denied, malformed state, exhausted counters and timeouts are never interpreted as absence.

S3 and Route53 cannot both create and tag atomically in these APIs. If creation succeeds but tagging/journal persistence fails, the harness refuses to delete an untagged resource and reports a leak. An owner must resolve that positively identified orphan. Route53 creation and zone tagging/deletion cannot be restricted by resource tags in IAM: [the service authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_route53.html) documents its supported resource conditions. That account-level permission is confined to this disposable account; record mutations only allow reserved TXT names. Never use this role in an account containing unrelated DNS zones. The role cannot edit its own policies, mint access keys, fetch secret values or remove its boundaries.

The RDS-managed credential is never retrieved; [RDS deletes its managed secret with the DB](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-secrets-manager.html). The harness persists only its scoped ARN and independently checks secret absence using DescribeSecret, never GetSecretValue. ECS/RDS service-linked roles and bootstrap network/marker/policies/budget remain account bootstrap objects, not per-run leaks. The bootstrap owner precreates those service-linked roles (or proves both already exist and sets create_service_linked_roles=false); the runner cannot create them. The owner removes bootstrap infrastructure separately after all per-run resources are absent. No production data, snapshot or retention policy is deleted by this harness.

`finally` attempts teardown on partial failure, SIGINT and SIGTERM. Workflow recovery continues after a failed harness step, uploads the sanitized journal/packet, then a final hard gate checks both original acceptance and recovery outcomes. Runner loss, forced cancellation or a hard job timeout cannot execute an in-process finalizer. Download the journal and resume the exact approved source manually; no unattended-work or guaranteed-cloud-cleanup claim is made:

```bash
export PATH="$ZENITH_NODE22_BIN:$PATH"
ZENITH_LIVE_AWS=1 ZENITH_LIVE_AWS_BUDGET_USD="$AWS_ACCEPTANCE_BUDGET_USD" \
ZENITH_LIVE_SCOPE_FILE="$AWS_ACCEPTANCE_SCOPE_FILE" \
ZENITH_LIVE_AWS_SESSION_FILE="$AWS_ACCEPTANCE_SESSION_FILE" \
npx tsx scripts/acceptance/aws-live.ts --permissions "$AWS_ACCEPTANCE_PERMISSIONS_FILE" \
  --cleanup "$AWS_ACCEPTANCE_JOURNAL_FILE"
```

Cleanup preserves counters, plan/permission/source bindings and earlier failures. Exhausted counters require a newly reviewed recovery envelope; they cannot be reset by rerunning. A closed journal requires no calls. Atomic `journal.json` stores only intended families, bounded counters, a DNS resource identity and scoped managed-secret ARN, never raw AWS responses, secret values, tokens or plan state. `evidence.json` contains timestamps, source commit, plan/permission hashes, check scopes, cleanup result, visible pending rows and no false release promotion. Only the actual SDK transport can set live provenance; modeled transports cannot emit live requirement evidence even when a check claims success. Only complete independently verified product checks can produce ledger-shaped `live_sandbox` entries; fixture-only checks never do. The packet hash allows reviewers to bind the sanitized evidence artifact.
