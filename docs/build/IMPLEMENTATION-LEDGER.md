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
| WS-RES | Resource model: Manifest V2, upgrade, graph expansion, drift v2 | 1 | integrated | WS-FOUND | ws/res | 188db18 | 159 passed | orchestrator: merged 770e245 | specs.ts + native-types.ts pinned contracts |
| WS-DB | Platform control store: executor, migrations, repositories, leases, idempotency, events | 1 | in_progress | WS-FOUND | ws/db |  |  |  |  |
| WS-POL | Policy engine: Rego, wasm bundle, evaluator, plan facts | 1 | integrated | WS-FOUND | ws/pol | a080e24 | opa 205/205; vitest 215 | orchestrator: merged cb72738 | policy/dist sha e04961bb…; cross-OS wasm determinism unverified |
| WS-CRED | Credential broker, OIDC issuer, AWS STS, customer bootstrap templates | 1 | in_progress | WS-FOUND | ws/cred |  |  |  |  |
| WS-TOFU | OpenTofu engine: workspace assembly, runner, plan normalization, digests, lockfiles | 1 | integrated | WS-FOUND | ws/tofu | 5ac7f15 | 110 passed + 4 network-gated (4/4 when enabled) | orchestrator: merged deeb3bc | aws 6.66.0 pinned; fingerprintKey must be server-secret-derived in activities (follow-up) |
| WS-GO | Go zenith-runner and zenithd | 1 | in_progress | WS-FOUND | ws/go |  |  |  |  |
| WS-PLACE | Cost engine v2, price catalog, placement solver | 1 | integrated | WS-FOUND | ws/place | 15313bf | 114 + 2 integration (116) | orchestrator: merged; fixed spec-key mismatch 2a4690a | AWS/Azure/OCI prices mostly from official APIs; GCP partly third-party mirror; zenith tier is internal assumption |
| WS-OBS | Observability fabric: sandbox, CloudWatch, Prometheus, Loki | 1 | integrated | WS-FOUND | ws/obs | fd0c098 | 401 passed | orchestrator: merged | all sources contract-level; no trace/CloudTrail source; drivers must publish externalId + native ids |
| WS-WF | Temporal workflows, worker, client, test environment | 1 | in_progress | WS-FOUND | ws/wf |  |  |  |  |
| WS-FIX | Fix baseline audit defects (engine rollback, approvals, journal, naming, docker runner) | 1 | integrated | WS-FOUND | ws/fix | bbf2f0a | full suite 3784 passed on branch | orchestrator: merged 19e48b2 | LocalStack defect deferred; unapprove not wired to UI |
| WS-ANALYZE | Repository analysis to requirements and proposed architecture | 1 | in_progress | WS-FOUND | ws/analyze |  |  |  |  |
| WS-AWS-NET | AWS drivers: VPC, subnets, IGW/NAT, security groups, ALB, Route53, ACM | 2 | in_progress | WS-RES, WS-TOFU, WS-CRED | ws/aws-net |  |  |  |  |
| WS-AWS-CMP | AWS drivers: ECS/Fargate, ECR, EC2/ASG, Lambda, EventBridge, CodeBuild | 2 | in_progress | WS-RES, WS-TOFU, WS-CRED | ws/aws-cmp |  |  |  |  |
| WS-AWS-DATA | AWS drivers: RDS, ElastiCache, S3, SQS, Secrets Manager, IAM, log groups | 2 | in_progress | WS-RES, WS-TOFU, WS-CRED | ws/aws-data |  |  |  |  |
| WS-CAP | Capability broker, approvals, grants, autonomy, REST /api/platform/v1 | 2 | in_progress | WS-DB, WS-POL | ws/cap |  |  |  |  |
| WS-RUNSRV | Runner/zenithd control-plane side and AWS-SDK-over-runner transport | 2 | in_progress | WS-DB, WS-GO | ws/runsrv |  |  |  |  |
| WS-MACH | Machine plane: SSM, Kubernetes exec, zenithd transport | 2 | in_progress | WS-RUNSRV, WS-CRED | ws/mach |  |  |  |  |
| WS-K8S | Kubernetes provider drivers (server-side apply, ownership) | 2 | in_progress | WS-RES, WS-CRED | ws/k8s |  |  |  |  |
| WS-ACT | Workflow activities + AWS deploy journey + LocalStack acceptance + live harness | 3 | in_progress | WS-AWS-NET, WS-AWS-CMP, WS-AWS-DATA, WS-CAP, WS-WF | ws/act |  |  |  |  |
| WS-INC | Incident engine and remediation workflow | 3 | in_progress | WS-OBS, WS-AWS-NET, WS-CAP | ws/inc |  |  |  |  |
| WS-REC | Reconciliation controller and persisted drift | 3 | in_progress | WS-DB, WS-AWS-NET | ws/rec |  |  |  |  |
| WS-MCP | MCP v3 semantic tools, CLI, SDK, connectors | 3 | planned | WS-CAP |  |  |  |  |  |
| WS-UI | UI components: plans/approvals, operations, resources, drift, incidents, cost, autonomy, connections | 3 | in_progress | WS-CAP, WS-DB | ws/ui |  |  |  |  |
| WS-GCP | GCP drivers (Cloud Run, GKE, Cloud SQL, GCS, Pub/Sub, LB, DNS, Secret Manager, Logging/Monitoring) | 4 | in_progress | WS-ACT | ws/gcp |  |  |  |  |
| WS-AZURE | Azure drivers (Container Apps, AKS, Postgres Flexible, Blob, Service Bus, DNS, Key Vault, Monitor) | 4 | in_progress | WS-ACT | ws/azure |  |  |  |  |
| WS-OCI | OCI drivers through the same contracts | 4 | queued | WS-ACT |  |  |  |  |  |
| WS-ZM | Zenith-managed provider (provider=zenith) | 4 | planned | WS-K8S |  |  |  |  |  |
| WS-SEC | Threat model, tenant-isolation matrix, secret-leak and chaos tests | 4 | in_progress | WS-CAP, WS-ACT | ws/sec |  |  |  |  |
| WS-CI | CI gates: policy, tofu, Go, Temporal, platform Postgres, provider contracts | 4 | in_progress | WS-ACT | ws/ci |  |  |  |  |
| WS-DOCS | Operator docs, runbooks, capability matrix, acceptance evidence | 4 | planned | WS-ACT |  |  |  |  |  |

## External blockers

| ID | What | Blocks | Workaround |
|---|---|---|---|
| B-AWS-LIVE | No AWS sandbox account credentials on this machine | live AWS acceptance (Demos A-F on real AWS) | mocked-SDK contract tests + live harness scripts/acceptance/aws-live (LocalStack on hold per user, 2026-09-30) |
| B-GCP-AZ-OCI-LIVE | No GCP / Azure / OCI accounts | live verification of those providers | contract tests with recorded HTTP; live harness |
| B-TEMPORAL-CLOUD | No Temporal Cloud namespace | production workflow hosting | temporal server start-dev locally and in CI |
