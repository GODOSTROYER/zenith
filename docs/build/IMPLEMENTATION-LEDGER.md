# Implementation ledger

Generated from `docs/build/ledger.json` by `node scripts/build/ledger.mjs` — edit the JSON, not this file.

- Program: Zenith agentic multi-cloud control plane
- Integration: branch `platform/integration`, worktree `zenith-wt/platform`
- Baseline: `c1049f6` (2026-09-30) — 298 files / 3697 passed / 147 skipped; typecheck clean; lint clean
- Orchestrator: Opus 5.5 (architecture, contracts, review, integration); workers: Sonnet 5.5, medium effort

States: planned → in_progress → review → integrated (or blocked).

| ID | Workstream | Wave | State | Depends on | Branch | Commit | Tests | Review | Notes |
|---|---|---|---|---|---|---|---|---|---|
| WS-FOUND | Contracts, ADRs, ledger, dependencies | 0 | done |  | platform/integration | e07669a |  | orchestrator |  |
| WS-RES | Resource model: Manifest V2, upgrade, graph expansion, drift v2 | 1 | in_progress | WS-FOUND | ws/res |  |  |  |  |
| WS-DB | Platform control store: executor, migrations, repositories, leases, idempotency, events | 1 | in_progress | WS-FOUND | ws/db |  |  |  |  |
| WS-POL | Policy engine: Rego, wasm bundle, evaluator, plan facts | 1 | in_progress | WS-FOUND | ws/pol |  |  |  |  |
| WS-CRED | Credential broker, OIDC issuer, AWS STS, customer bootstrap templates | 1 | in_progress | WS-FOUND | ws/cred |  |  |  |  |
| WS-TOFU | OpenTofu engine: workspace assembly, runner, plan normalization, digests, lockfiles | 1 | in_progress | WS-FOUND | ws/tofu |  |  |  |  |
| WS-GO | Go zenith-runner and zenithd | 1 | in_progress | WS-FOUND | ws/go |  |  |  |  |
| WS-PLACE | Cost engine v2, price catalog, placement solver | 1 | in_progress | WS-FOUND | ws/place |  |  |  |  |
| WS-OBS | Observability fabric: sandbox, CloudWatch, Prometheus, Loki | 1 | in_progress | WS-FOUND | ws/obs |  |  |  |  |
| WS-WF | Temporal workflows, worker, client, test environment | 1 | in_progress | WS-FOUND | ws/wf |  |  |  |  |
| WS-FIX | Fix baseline audit defects (engine rollback, approvals, journal, naming, docker runner) | 1 | in_progress | WS-FOUND | ws/fix |  |  |  |  |
| WS-ANALYZE | Repository analysis to requirements and proposed architecture | 1 | in_progress | WS-FOUND | ws/analyze |  |  |  |  |
| WS-AWS-NET | AWS drivers: VPC, subnets, IGW/NAT, security groups, ALB, Route53, ACM | 2 | planned | WS-RES, WS-TOFU, WS-CRED |  |  |  |  |  |
| WS-AWS-CMP | AWS drivers: ECS/Fargate, ECR, EC2/ASG, Lambda, EventBridge, CodeBuild | 2 | planned | WS-RES, WS-TOFU, WS-CRED |  |  |  |  |  |
| WS-AWS-DATA | AWS drivers: RDS, ElastiCache, S3, SQS, Secrets Manager, IAM, log groups | 2 | planned | WS-RES, WS-TOFU, WS-CRED |  |  |  |  |  |
| WS-CAP | Capability broker, approvals, grants, autonomy, REST /api/platform/v1 | 2 | planned | WS-DB, WS-POL |  |  |  |  |  |
| WS-RUNSRV | Runner/zenithd control-plane side and AWS-SDK-over-runner transport | 2 | planned | WS-DB, WS-GO |  |  |  |  |  |
| WS-MACH | Machine plane: SSM, Kubernetes exec, zenithd transport | 2 | planned | WS-RUNSRV, WS-CRED |  |  |  |  |  |
| WS-K8S | Kubernetes provider drivers (server-side apply, ownership) | 2 | planned | WS-RES, WS-CRED |  |  |  |  |  |
| WS-ACT | Workflow activities + AWS deploy journey + LocalStack acceptance + live harness | 3 | planned | WS-AWS-NET, WS-AWS-CMP, WS-AWS-DATA, WS-CAP, WS-WF |  |  |  |  |  |
| WS-INC | Incident engine and remediation workflow | 3 | planned | WS-OBS, WS-AWS-NET, WS-CAP |  |  |  |  |  |
| WS-REC | Reconciliation controller and persisted drift | 3 | planned | WS-DB, WS-AWS-NET |  |  |  |  |  |
| WS-MCP | MCP v3 semantic tools, CLI, SDK, connectors | 3 | planned | WS-CAP |  |  |  |  |  |
| WS-UI | UI: connections, plans/approvals, autonomy/policy, operations, incidents, resources | 3 | planned | WS-CAP, WS-DB |  |  |  |  |  |
| WS-GCP | GCP drivers (Cloud Run, GKE, Cloud SQL, GCS, Pub/Sub, LB, DNS, Secret Manager, Logging/Monitoring) | 4 | planned | WS-ACT |  |  |  |  |  |
| WS-AZURE | Azure drivers (Container Apps, AKS, Postgres Flexible, Blob, Service Bus, DNS, Key Vault, Monitor) | 4 | planned | WS-ACT |  |  |  |  |  |
| WS-OCI | OCI drivers through the same contracts | 4 | planned | WS-ACT |  |  |  |  |  |
| WS-ZM | Zenith-managed provider (provider=zenith) | 4 | planned | WS-K8S |  |  |  |  |  |
| WS-SEC | Threat model, tenant-isolation matrix, secret-leak and chaos tests | 4 | planned | WS-CAP, WS-ACT |  |  |  |  |  |
| WS-CI | CI gates: policy, tofu, Go, Temporal, platform Postgres, provider contracts | 4 | planned | WS-ACT |  |  |  |  |  |
| WS-DOCS | Operator docs, runbooks, capability matrix, acceptance evidence | 4 | planned | WS-ACT |  |  |  |  |  |

## External blockers

| ID | What | Blocks | Workaround |
|---|---|---|---|
| B-AWS-LIVE | No AWS sandbox account credentials on this machine | live AWS acceptance (Demos A-F on real AWS) | mocked-SDK contract tests + live harness scripts/acceptance/aws-live (LocalStack on hold per user, 2026-09-30) |
| B-GCP-AZ-OCI-LIVE | No GCP / Azure / OCI accounts | live verification of those providers | contract tests with recorded HTTP; live harness |
| B-TEMPORAL-CLOUD | No Temporal Cloud namespace | production workflow hosting | temporal server start-dev locally and in CI |
