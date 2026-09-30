# Current capability vs target — baseline 2026-09-30

Baseline commit: `c1049f6` (origin/master). Verified on this machine the same
day: `tsc --noEmit` clean, `eslint .` clean, `vitest run` 298 files / 3,697
tests passed, 147 skipped, 105 s.

This is the audit the platform build started from. It is kept as history;
`docs/platform/CAPABILITY-MATRIX.md` is the living answer.

## What exists and is preserved

| Area | Today | Keep because |
|---|---|---|
| Manifest | V1: services, resources (5 kinds), routes, bindings; zod-validated; revisions immutable | every surface already shares it |
| Action registry | `runAction`: validate → plan → role/autonomy check → execute → audit; process-local idempotency | the single mutation path for product state |
| Engine | durable per-deployment state machine, one step at a time, `activeDeploymentId` lease (no expiry, no fence), resume on boot/cron, no retry | runs sandbox + LocalStack; UI timeline depends on its records |
| Providers | sandbox (simulated), LocalStack (real S3/SQS only), AWS Preview (HCL export, no apply, no AWS call), k8s/gcp/azure planned | honest labels; HCL export is the no-lock-in bundle |
| Drift | pure compare of deployed manifest vs `observe()`; real only on LocalStack S3/SQS; never persisted | the diff semantics carry over |
| Product store | file (single process) or Postgres via PostgREST snapshots, version-guarded flush, no cross-table tx | system of record for workspaces/projects/revisions |
| Hosted authority | SQLite / direct Postgres with real transactions, jobs with fence tokens, outbox | second product |
| Agent control | MCP v1 reader (13 tools) + v2 control (11 tools) at `/api/agent/v2/mcp`; digest-bound browser approvals; single-use claims; fenced Postgres claims; `uncertain` reconciliation; `za_` credentials with device link | the approval model is sound and reused |
| Secrets | AES-256-GCM `vault:` refs, one server key, no KMS | refs-only manifests |
| CI | verify, postgres (migrations + contract lanes), hosted, agent, build, docker | extended, not replaced |

## Gaps against the Goal Condition

| Target | Baseline |
|---|---|
| Desired / observed / runtime state | desired only; observed transient; runtime nonexistent (logs/health simulated for every provider) |
| Resource drivers | none — monolithic adapters, 5-kind closed enum |
| Real AWS execution | none; no STS, no SDK beyond S3/SQS, no OpenTofu invocation; exported HCL uses the default VPC and public task IPs |
| OpenTofu | text generation only; never `validate`d |
| Credential broker | none; `CloudConnection` has no role/external id; AWS preflight passes with warnings |
| Capability broker | none; six coarse integration scopes; action ids exposed 1:1 |
| Policy engine | scattered checks; no decision records |
| Autonomy | install-global Navigator dial; agent path ignores it |
| Durable workflows | 250 ms ticker / 20 s cron passes; no long-running step model |
| Leases / fencing | env lease without expiry or fence; journal fence only for agent claims |
| Durable idempotency | process-local 10-minute window |
| Machine plane | none (`ops.restartService` is simulated) |
| Observability | synthetic logs/health; no CloudWatch/k8s/Prometheus |
| Incident engine | `incident_bundle` without probes |
| Placement / cost | static 5-kind price table; no NAT, IPv4, LB, egress; no placement |
| Kubernetes / GCP / Azure / OCI | planned stubs that throw |
| Managed provider | hosted-apps subsystem serves static React apps; not a provider |
| Runner / zenithd | none; no Go in repo |

## Defects found by the audit (to fix as part of the build)

1. `deploy.rollback` / `deploy.promote` skip the stateful-deletion block that `deploy.apply` enforces. (fixed on ws/fix)
2. A cancelled/superseded rollback leaves the origin deployment `rolling_back` forever. (fixed on ws/fix)
3. LocalStack's verify step is a sleep; its simulated outputs are labelled `simulated:false`. (deferred: LocalStack on hold)
4. No cross-instance step claim in the engine; `rt.signal` is ignored by adapters.
5. `deploy.approve` has no requester/approver separation. (fixed on ws/fix)
6. Agent journal: no un-approve path; `uncertain` operations never reach the review queue; the Postgres finalize does not check `lease_until`. (fixed on ws/fix; the un-approve is a journal method only, with no browser route or screen control yet)
7. Exported AWS target-group names are not truncated to 32 characters. (fixed on ws/fix)
8. `writeSettings` on the Postgres store is last-writer-wins. (fixed on ws/fix)
9. Docker build runner timeout kills the CLI, not the container. (fixed on ws/fix)
