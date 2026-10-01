# Platform acceptance

**No scenario has run live in this workstream.** Demo J runs end to end locally
through merged analysis, resource expansion and placement code. AWS SDK mocks,
fake REST/MCP servers and simulated sockets are contract tests, not cloud
success. A–I remain externally blocked as described below.

Run from the repository root. Dependencies are already installed; do not run
`npm install` or `npm ci` for this harness. Evidence defaults to
`<OS temp>/zenith-acceptance/<runId>/`, outside Git. `--out <parent>` overrides
the parent. The CLI never approves an operation; a person approves the exact
proposal in the browser. When policy allows unattended execution, the approval
criterion is **skipped**, and the verdict is incomplete.

## Commands and status

Dry run first. It prints exact actions and evaluates offline prerequisites,
without contacting a cloud. `--check-control-plane` also checks configured API
prerequisites; it does not execute a scenario. Without `--confirm-billable`, any
selection containing mutations automatically becomes a dry run. Cleanup CLI
dry runs are different: they read the cloud to inventory resources.

```powershell
npx tsx scripts/acceptance/aws-live.ts --scenario "A,B,C" --dry-run
npx tsx scripts/acceptance/aws-live.ts --scenario "A,B,C" --confirm-billable
npx tsx scripts/acceptance/aws-live.ts --scenario J
```

| Demo | Real-run command suffix after `npx tsx scripts/acceptance/aws-live.ts` | Status / external blockers |
|---|---|---|
| A autonomous AWS deploy | `--scenario A --confirm-billable` | No sandbox credentials; REST, execution activities and AWS drivers are composed, but the harness fixture source-upload/build/binding path is not live-verified; requires DNS zone for complete DNS/TLS evidence |
| B incident diagnosis | `--scenario "A,B" --confirm-billable` | A first; incident library exists, MCP investigator registration remains unavailable; breaks only run-tagged DB ingress |
| C approved remediation | `--scenario "A,B,C" --confirm-billable` | A/B first; live remediation/approval acceptance and a human approver; composed execution does not prove this journey |
| D external drift | `--scenario "A,D" --confirm-billable` | A first; observer/reconcile composition and tick exist, but live observation remains unverified; simulated drift fails |
| E crash recovery | `--scenario "A,E" --confirm-billable` | A first; configured Temporal and composed worker, dedicated controlled crash test; live lease/fence recovery unverified |
| F token revocation | `--scenario F` | Live API, disposable integration token and operator revocation; harness still skips runner/AWS connection phase, although zenith-runner is implemented |
| G Kubernetes | `--scenario G --confirm-billable` | No kube contexts here; opted-in kind/sandbox cluster, Kubernetes driver/runner, Node build path and run-labelled namespace support required |
| H MCP | `--scenario H --confirm-billable` | MCP v3 has fifteen tools; live harness adapter/role map, sandbox workspace, approval-required plan policy and separate human approver remain prerequisites |
| I managed provider | `--scenario I --confirm-billable` | Prerequisite fails deliberately: managed drivers are registered, but no live substrate, Node source/cleanup contract or default managed session is verified; hosted source contract is React+Vite |
| J multi-cloud planning | `--scenario J` | **Local only**; ten criteria through merged code, no cloud/API/Temporal; cross-cloud egress/latency, determinism, residency and impossible-budget refusal |

Quote comma-separated selections in PowerShell. Append `--dry-run` to any suffix to inspect it safely. Dependencies must complete
earlier in the **same** selection; no previous run is adopted. A with skipped
approval does not satisfy B–E's dependency. Set an approval-required sandbox
policy to exercise the full chain. H uses `infrastructure.plan`, a read-only
plan capability, so an unexpected policy allowance cannot deploy billable
resources; a missing approval gate fails H.

## Dedicated AWS sandbox setup

Use a disposable sandbox account owned by the operator, never an arbitrary
production account. Follow [deploy/aws](../../deploy/aws/README.md) to deploy
`zenith-connection.cfn.yaml`: exact issuer host/subject, optional `NameSuffix`
for multiple connections, and `Route53HostedZoneArns` containing the sandbox
zone ARN. Register the outputs in Zenith and verify the connection; supply its
id and workspace id below. The issuer must be public HTTPS for AWS OIDC.

The account **owner**, using their own ambient AWS profile, creates the one-time
marker in the chosen region:

```powershell
aws ssm put-parameter --region us-east-1 --name /zenith/live-sandbox --type String --value true
```

This is an explicit disposable-account acknowledgement. Zenith's observe role
denies `ssm:GetParameter*`, so it cannot read or establish this gate. Bootstrap
uses the operator's ambient profile for STS identity and SSM marker only. The
same ambient handle is then used for independent verification, run-tag adoption,
out-of-band B/D changes and cleanup. Zenith's actions use its own broker/worker.

The harness checks declared account = STS account, marker = exactly `true`, an
explicit allowlisted region and confirmation before mutations. All mutating
steps that create AWS resources require an accepted cost estimate. Unknown or
over-budget costs are refused. Put an AWS Budgets alarm on the sandbox (for
example $25/month, email plus SNS notifications). Alarms are advisory; the
harness's estimate guard is not a spend cap. Do not let several operators share
an uncontrolled test worker.

## Configuration

All harness configuration is read in `scripts/acceptance/config.ts`.
Ambient AWS profile/credentials, Temporal configuration and helper PATH are
owned by their existing SDK/client/environment modules, not persisted in evidence.

| `ZENITH_LIVE_` suffix | Purpose / default |
|---|---|
| `AWS_ACCOUNT_ID` | Required 12-digit sandbox account; no default |
| `REGION` | Explicit region, or CLI `--region`; no default |
| `ALLOWED_REGIONS` | `us-east-1,us-east-2,us-west-2,eu-west-1,ap-south-1` |
| `MAX_MONTHLY_USD` | Monthly-rate guard, default 50 |
| `API_URL` | Control-plane HTTPS origin; HTTP allowed only for localhost |
| `API_TOKEN` | Secret integration token; sent only as a bearer header |
| `CONNECTION_ID` | Verified AWS sandbox connection |
| `WORKSPACE_ID` | Token's workspace, also in the state key |
| `DNS_ZONE` | Owned sandbox domain/Route53 zone for A's DNS/TLS checks |
| `STATE_BUCKET` | Default `zenith-state-<account>-<region>`; supply bootstrap output when using NameSuffix |
| `STATE_KMS_ARN` | Optional OpenTofu client-side state encryption key; distinct from the stack's SSE-KMS option |
| `APPROVAL_TIMEOUT_MS` | Default 1800000 (30 minutes) |
| `DEPLOY_TIMEOUT_MS` | Default 3600000 (60 minutes) |
| `WORKER_CONTROL` | E: `docker:<dedicated-container>`, `process:<pidfile>`, or `manual`; process restart requires its supervisor/operator, manual needs explicit confirmation |
| `KUBE_CONTEXT` | G: dedicated kubeconfig context |
| `KUBE_CONNECTION_ID` | G: verified cluster connection |
| `MCP_URL` | H: full HTTPS MCP endpoint, including path |
| `MCP_TOKEN` | H: secret bearer token; never printed |
| `MCP_TOOLS` | H: JSON role map with `inspect`, `propose`, `status`, optional `execute` |
| `MANAGED_API_URL` | I: managed control-plane origin; run I separately |
| `MANAGED_CONNECTION_ID` | I: verified managed sandbox connection |

Tokens must stay out of commands/evidence; set them through the operator's
private environment. `describeConfig` reports secrets only as set/unset.
External strings are data: HTTP/MCP responses and repository text are never
evaluated as shell commands or instructions.

For G, the operator explicitly labels the disposable cluster before running:

```powershell
kubectl --context <sandbox-context> label namespace kube-system zenith.io/live-sandbox=true
```

The run namespace must initially be absent. Zenith's Kubernetes driver must
create it as `<runId>` with `zenith.io/live-run=<runId>`; the harness verifies
the label independently. Namespace cleanup re-reads it, deletes with UID and
resource-version preconditions, and waits for namespace deletion. Kube credential helpers receive an allowlisted environment;
configure kubeconfig for the sandbox identity rather than relying on unrelated
ambient cloud credentials. The port-forward binds only loopback and is closed
in `finally`.

## Cost and evidence

The local snapshot estimate computed on this checkout for
`buildLiveManifest({runId:"zlive-202609301200-ab12", region:"us-east-1"})`
is **$97.22/month**, without a configured managed DNS zone. This exceeds the
default $50 guard; intentionally raise `ZENITH_LIVE_MAX_MONTHLY_USD`, for example
to 150, only after reviewing the plan. The plan's cost is checked again. NAT,
ALB and RDS are billed while present; a brief run may cost cents to dollars,
but the guard measures the **monthly rate**, not elapsed spend. E/D add a task.
Catalog rates are a static 2026-09-30 snapshot, partly weakly sourced; they are
estimates, not invoices. I's `zenith` prices are `internal_assumption`.

Evidence includes `events.jsonl`, `evidence.json`, `summary.json`, `summary.md`,
and AWS `cleanup.json`. Timings, operation ids, digests, HTTP probes and log
queries are recorded with redaction before truncation. `run-state.json` records
created environment ids immediately for recovery. No secret values belong in
any artifact. A leak detected in a raw MCP tool result fails the criterion even
though the stored result is redacted.

Each check says `live`, `local`, or `simulated`; skipped checks have a reason and
no execution mode. Any skip makes a real run incomplete. A thrown step is failed,
and its later steps/criteria are skipped. CLI success requires verdict passed
and applicable cleanup successful. J's report lists cross-cloud egress and
added latency; its solver and written-back graph differ in cost because the
graphs differ, and that difference is reported rather than asserted equal.

## Cleanup

```powershell
npx tsx scripts/acceptance/cleanup.ts --run-id <runId> --region us-east-1
npx tsx scripts/acceptance/cleanup.ts --run-id <runId> --region us-east-1 --execute
npx tsx scripts/acceptance/cleanup.ts --older-than 6 --region us-east-1 --execute
```

Supply the same `--out <parent>` to load a run's saved environment ids, state
bucket and DNS records. `--report <file>` writes a separate JSON report;
`--no-tofu` explicitly bypasses the state destroy path. Age comes from the UTC
run id `zlive-<yyyymmddhhmm>-<rand4>`, not creation dates from the tagging index.
Invalid tag values are reported and ignored. A scan covers the chosen region
and us-east-1 for global resources; scan another allowed region separately.

Cleanup adopts only recorded environment ids with exact matching environment
tags and no other run's tag. It plans OpenTofu destroy against saved state, checks
each resource's current run tag (or its explicitly allowlisted untaggable child
type), then applies only a fully accepted destroy plan. Native fallback deletes
ECS services, ALB/listeners, target groups, databases/cache, storage/logs/images
and network dependencies in order, re-reading tags before each resource. RDS
final snapshots are skipped only for run-tagged disposable databases. The
bootstrap state bucket is retained. Recorded run-named DNS records are handled
separately because records cannot be tagged.

Every real CLI run attempts cleanup in `finally` and finalizes evidence. A
crashed worker is restored first. Run-scoped operations are cancelled if still
active and must reach a terminal state before destructive hooks or the tag
sweep. If they cannot be observed/stopped, destructive cleanup is refused,
reported loudly and left for the operator after stopping the worker. This
avoids creating new resources while a sweep deletes old ones. Once operations
are quiescent, a failing hook does not prevent the AWS sweep.
Failure/refusal/unsupported resources or remaining tagged
resources, or a resource absent from the immediate tag recheck, produce a loud
warning and nonzero exit. An absent index entry is unverified, not proof of
deletion. Tagging is eventually
consistent: repeat a sweep after index lag settles. Untagged resources are not
discoverable by this harness; use sandbox inventory/billing as a cross-check.

Integration gaps: WS-ACT should allowlist extra run tags at resource creation
instead of relying on after-the-fact adoption; WS-TOFU should expose destroy;
the source-upload/build path must resolve the analysed fixture repository;
G needs namespace labels/UID-safe teardown; I needs Node support, a managed
session/substrate and cleanup API. Driver registration has landed. These harness
limits are separate from composition (`src/lib/platform`) and are not a claim
that its worker, driver registry, MCP or reconcile tick is absent.

Some harness diagnostics still say "unmerged" for code that now exists
(`scripts/acceptance/scenarios/f-credential-revocation.ts`,
`scripts/acceptance/scenarios/h-mcp.ts`,
`scripts/acceptance/scenarios/i-managed-provider.ts`). Their owners need to
update those diagnostics and prerequisite contracts. This docs workstream does
not change the harness or claim a previously skipped/blocked scenario passed.

## Verification without a cloud

```powershell
npx tsc --noEmit --incremental false
npx eslint scripts/acceptance tests/acceptance fixtures/acceptance-app
npx vitest run tests/acceptance
npx tsx scripts/acceptance/aws-live.ts --scenario J
```

`--incremental false` avoids writing the repository's generated tsbuildinfo
outside this workstream's owned paths. Tests use SDK mocks/fake servers, real
loopback Node processes, and local OpenTofu when executable. The real-tofu test
is skipped when `tofuOnPath()` cannot execute the binary. On this Windows sandbox
the installed binary is access denied. Set `ZENITH_TEST_NETWORK=1` only where
outbound TCP is permitted to run the non-routable database timeout test;
restricted networking can fail immediately, and is not a timeout success.
Docker, kind, Temporal and real AWS tests were not run in this continuation.
