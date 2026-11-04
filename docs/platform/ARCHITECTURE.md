# Zenith platform — control-plane architecture

This document describes the deterministic infrastructure control plane being
built on top of the existing Zenith product (see `docs/ARCHITECTURE.md` for the
product it extends). Decisions are in `docs/adr/`. Progress is in
`docs/build/IMPLEMENTATION-LEDGER.md`. `docs/platform/CURRENT-STATE.md` records
the initial audit; current source-verified wiring and deployment limits are in
[DEPLOYING.md](operations/DEPLOYING.md). The diagram and invariants below describe
the intended boundaries, not a live acceptance result.

**The rule everything else follows:** models propose intent; deterministic
Zenith code owns credentials, authorization, state, policy, approvals, locking,
retries and execution.

```
 Interfaces   Web UI · REST /api/platform/v1 · CLI · MCP v3 · Codex/Claude plugins · webhooks
                  │  every one submits the same CapabilityRequest
 Agent runtime    Navigator / connected coding agents: interpret intent, inspect, propose, explain
                  │  (no credentials, no locks, no state, no authorization)
 Control plane ┌──────────────────────────────────────────────────────────────────────────┐
               │ capability broker ─ scope (ws→proj→env→resource) ─ role/scopes ─ autonomy│
               │      │ policy engine (OPA wasm) ─ decision record (version, input digest)│
               │      │ approvals (human-only, digest-bound, single-use, expiring)        │
               │      ▼                                                                    │
               │ operations ledger ─ idempotency ─ leases + fence tokens ─ events/evidence│
               │ resource graph: desired ▸ observed ▸ runtime · drift · reconciliation   │
               │ cost engine · placement solver · incident engine                         │
               └───────────────┬──────────────────────────────────────────────────────────┘
                               │ start/signal (ids + digests only)
 Execution      Temporal workflows ─▶ activities (execution worker, long-running)
                  │ capability grant verified ─▶ credential broker (STS / WIF / runner)
                  ├─ OpenTofu (declarative lifecycle, pinned, plan-digest bound)
                  ├─ resource drivers (native observe / runtime / verify / day-two ops)
                  ├─ machine plane (SSM · k8s exec · zenithd)
                  └─ zenith-runner (customer network, local identity, signed jobs)
 Providers      AWS (first, complete) · Kubernetes · GCP · Azure · OCI · zenith (managed) · sandbox · LocalStack
```

## New modules

All new server code lives under `src/lib`, following the existing layering
(`docs/MODULE-MAP.md`): nothing in `src/lib` imports `@/app`; no import cycles.

| Path | Owns | Layer |
|---|---|---|
| `src/lib/controlplane/digest.ts` | the one canonical-JSON + SHA-256 rule | L1 |
| `src/lib/controlplane/types.ts` | Sql, Principal, Scope, Lease, Operation, Approval, PolicyDecisionRecord, CapabilityGrantClaims, PlatformEvent, Evidence | L0 |
| `src/lib/controlplane/db/**` | platform control store: executor (Postgres / PGlite), migrations, repositories | L2 |
| `src/lib/controlplane/{leases,operations,events,approvals,idempotency}/**` | services over the store | L3 |
| `src/lib/resources/**` | Manifest V2, V1→V2 upgrade, graph expansion, state types, drift v2 | L0 (pure) |
| `src/lib/drivers/**` | driver contract, registry, contract-test kit | L3 |
| `src/lib/providers/<id>/drivers/**` | per-provider resource drivers | L3 |
| `src/lib/tofu/**` | compile assembly, runner, plan normalization, digests, lockfiles | L3 |
| `src/lib/credentials/**` | credential broker, OIDC issuer/signers, STS/WIF exchanges | L3 |
| `src/lib/policy/**` + `policy/` | Rego sources, wasm bundle, evaluator, plan facts | L3 |
| `src/lib/capabilities/**` | catalog, broker, grants, autonomy | L4 |
| `src/lib/workflows/**` | Temporal workflows (deterministic), activities, client, worker | L4 |
| `src/lib/machines/**` | semantic machine API + transports | L3 |
| `src/lib/observability/**` | normalized federated signal queries | L3 |
| `src/lib/incidents/**` | investigation engine, hypotheses, remediation options | L4 |
| `src/lib/placement/**` | price catalog, cost engine v2, placement solver | L0–L1 (pure) |
| `src/lib/runners/**` | control-plane side of the runner / zenithd protocol | L4 |
| `src/app/api/platform/v1/**` | versioned REST surface over the broker | L5 |
| `src/app/api/agent/v3/mcp` | semantic MCP tools over the broker | L5 |
| `go/` | `zenith-runner`, `zenithd`, shared protocol | separate module |
| `deploy/` | customer bootstrap (CloudFormation, OpenTofu), Helm chart, worker image | — |

## Invariants

1. **One authorization path.** UI, REST, CLI, MCP and the Navigator all reach
   infrastructure through the capability broker. There is no special MCP path.
2. **Tenancy in SQL.** Every tenant-owned row carries `workspace_id`; every
   query that could cross tenants filters on it. Cross-tenant negative tests
   exist for every repository and route.
3. **No secret values leave their vault.** Manifests, revisions, diffs, audit,
   events, MCP results, model prompts and plan views hold references only.
   Redaction is defense in depth, not the mechanism.
4. **Credentials only in worker memory,** inside `CredentialBroker.withSession`.
5. **Digest-bound approvals.** An approval covers exactly one proposal digest,
   is single-use, expires, and is re-validated at execution; plans are
   regenerated and compared immediately before apply.
6. **Fenced mutation.** Every mutation of an environment holds the `env:<id>`
   lease and carries its fence token into every write and external call that
   can carry one. Lease loss stops work and yields `uncertain`, never a retry.
7. **Unknown is a value.** Nothing claims an unobserved property matches.
8. **Honest capability labels.** Every driver operation declares its evidence
   level (`real | emulated | contract | simulated`); docs are generated from it.
9. **External strings are data.** Repository files, logs, cloud API responses
   and OpenTofu output never become instructions to any model or command.

## Deployment topology

| Component | Runs on | State |
|---|---|---|
| Web/API control plane | Vercel or any Node host | product store, platform store |
| Execution worker | long-running container (`docker/worker.Dockerfile`) | private binary plans in `ZENITH_WORKER_PLAN_DIR`; ledger in platform store; cross-replica plan availability not verified (`workers/execution/worker.ts`, `src/lib/platform/execution.ts`) |
| Temporal | Temporal Cloud or self-hosted; `temporal server start-dev` locally | workflow history |
| zenith-runner | customer VPC / cluster (Helm, container, binary) | replay cache only |
| zenithd | customer VMs | local audit log only |
