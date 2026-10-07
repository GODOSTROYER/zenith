# Mixed-cloud recovery, connectivity and economics

For whoever runs, recovers or pays for an application that spans clouds (PROD-MIX-05, PROD-MIX-06, PROD-MIX-07).
Status of every claim below: the mechanisms are built and contract or local-engine tested; **no live cloud run has been
performed or approved**. Live acceptance is gated (`ZENITH_LIVE_MIXED=1`), needs a person-approved scope manifest and is
deferred. Nothing in this document is evidence of a live recovery.

## 1. What a mixed run promises, and what it never does

A mixed run is not a transaction. `summarizeRun` returns the constants `atomicity: "none"` and
`automaticCompensation: "never"`. Children that finished stay applied and are reported in
`appliedWithoutRunCompletion`; nothing is rolled back and nothing is destroyed automatically. Teardown is a proposal in
reverse dependency order that a person releases step by step against an approved destroy operation
(`POST /api/platform/v1/operations/:id/mixed-run/teardown`, browser only).

## 2. Cross-cloud connectivity (PROD-MIX-05)

Whatever crosses a partition boundary needs a declared, assessed and approved path. Declare it in the `connectivity` field of
`POST /api/platform/v1/mixed/plans` (module `src/lib/execution/mixed/connectivity.ts`).

**The default is a protected endpoint**, one per cross-partition dependency, never inferred:

| Binding | What is checked |
| --- | --- |
| Network | Each partition declares its private CIDRs and its public egress addresses. A CIDR with host bits set is refused rather than widened. Overlapping private space between partitions is noted as tolerated only when no VPN routes it; it is refused for an opted-in VPN pair. |
| DNS | A fully qualified lowercase name (no IP literal, no wildcard), `dns.name` equal to the host dialled, at least one approved target (public, never private), a time to live of at most 3600 seconds. |
| TLS | Client certificates required (mutual TLS), minimum version 1.2 or 1.3, the host in the certificate names, the server public key pinned (SHA-256), the client CA bundle digest recorded. A database endpoint may not rely on a wildcard name. |
| Identity | The client certificate identity is bound to the consumer partition's connection identity digest. |
| Secrets | Key and certificate are `vault:` references only. Anything that looks like key material is refused without echoing it. |
| Allowlist | Only the consumer partition's own declared egress. A database admits single hosts (/32 or /128); a service admits no range broader than /24. The whole internet, a private range, an empty list or an address outside the consumer's egress is refused. A database is never silently public. |

**A VPN is an opt-in module** (`vpn.optIn: true`): disjoint address space, links inside the declared networks, keys as vault
references. Links without the explicit opt-in are refused.

The assessed declaration is stored on the plan, its digest is part of the plan id and of the approved proposal input, and every
integrity check re-assesses it. The approver sees a line naming the connectivity digest; approving the parent approves exactly
those endpoints. A changed endpoint changes the plan id, so an old approval cannot be reused.

Live probes of a deployed run: `tests/live/mixed-connectivity.live.test.ts` (read only; DNS targets, pinned TLS with the client
certificate, mutual TLS required, TLS 1.1 refused, and allowlist denial from a machine you declare outside the allowlist). A
complete proof needs one run from an allowlisted machine and one from outside it; each run lists what it could not check.

## 3. The reference app and its live acceptance (PROD-MIX-06)

`fixtures/mixed-app`: a web tier (GCP compute), an enricher (AWS; the manifest has no `function` service kind and AWS Lambda is an
experimental driver unreachable from manifests, so the justified equivalent is an AWS-hosted HTTP service with a Lambda-shaped
handler), PostgreSQL (Azure). `zenith.app.json` uses `nodePlacement` and `release.migrate`. `spec.json` is the shared contract.

`npx tsx scripts/acceptance/mixed/live-run.ts` (gated) runs: scope and gates, budget admission, plan evidence, connectivity probes,
traffic, independent readback, teardown check. The readback reads PostgreSQL directly with its own read-only credential file, checks
the host suffix, recomputes price and checksum itself, and treats uncertain writes as neither pass nor fail. Every run carries a run
id (`zlive-<yyyymmddhhmm>-<4 chars>`), the `zenith:live-run` tag and a TTL.

"Auto-teardown" is a deadline and a check, not a destroy: `teardown-check` reports `torn_down | pending_human_approval | in_progress
| not_proposed | needs_attention` from the control plane's own ledger and the run exits 3 once the TTL passed without `torn_down`.
Destroying stays a person-approved operation; tagged AWS leftovers go through `cleanup-cli.ts --run-id <id>`.

## 4. Failure scenarios and recovery runbook (PROD-MIX-07)

Scenarios in `scripts/acceptance/mixed/failure-scenarios.ts` run the real reducer (simulation); the live drill is
`scripts/acceptance/mixed/live-recovery.ts` (blackhole through a local fault proxy, or revocation of one partition connection).

Common first steps for every scenario below:

1. **confirm-blast-radius**: `GET /api/platform/v1/operations/:id/mixed-run`. Read `summary.completed`, `failed`, `indeterminate`,
   `blocked`, `appliedWithoutRunCompletion` and `nextSteps`. Applied children are still applied.
2. Do not retry anything whose `effects` are `possible`; reconcile first.

### Provider outage while a child is running (`outage_mid_chain`)

The child is `outage`, effects `possible`, reconciliation required; its dependents are `blocked` with the child as root cause.
- **reconcile-indeterminate-child**: look at the provider for what the child created (read-only). Record the outcome as a
  `reconciled` event (`no_effects` or `effects_present`) with the evidence digest.
- **retry-after-reconcile**: only then `retry`; dependents unblock when the child succeeds.

### A child never answers (`blackhole_timeout`)

After the child timeout the child is `timed_out`, effects `possible`. A late receipt is evidence it finished and is accepted as such.
Otherwise reconcile and retry as above.

### A partition's connection is revoked (`revoked_partition_connection`)

The control plane re-verifies each child's connection before it starts; a revoked connection refuses that child, changes nothing and
leaves earlier children applied. The running application's data plane is independent of the control plane and keeps serving.
- **rebind-connection-and-replan**: create and verify a replacement connection, then plan again. A revoked connection never works
  again; the old plan is not resumed.
- **resume-after-new-approval**: a person approves the new plan; completed children are not re-applied.

### The approval expires with some children applied (`expiry_with_partial_apply`)

New starts stop; in-flight children are not withdrawn. Either **replan-and-reapprove**, or **propose-teardown-for-approval**
(section 1).

### The live drill

Blackhole: writes during the fault must be `uncertain`, never acknowledged; nothing acknowledged may be lost; after healing writes
are acknowledged again. Revocation: needs `ZENITH_LIVE_MIXED_REVOKE_CONNECTION_ID` and `ZENITH_LIVE_MIXED_CONFIRM_REVOKE` set to the
same id, is irreversible, and only counts as passed when the revocation reads back and the application kept serving.
An uncertain write may exist in the database; compare before resending (client keys make resends idempotent).

## 5. Economics (PROD-MIX-07)

`GET /api/platform/v1/mixed/plans/:id/economics?egressGb=&interComponentFraction=&residency=eu,us&latencyBudgetMs=` and
`npx tsx scripts/acceptance/mixed/cost-report.ts` report the dated-catalog monthly total **including each cross-cloud and
cross-region transfer** (billed on the sending side), approximate edge latency and residency of every partition. It reuses the
cost engine (`estimateGraphCost`, `listCrossBoundaryTransfers`) and the latency tables. Honest limits: list prices, not an invoice
and not a billing cap; transfer volume is an assumption; latency is a coarse table, not a measurement; residency tags are matching
conveniences, not legal advice. A graph the catalog cannot price says so and is never shown as free. Actual spend is a separate,
gated read (`docs/platform/operations/COST.md`).

## 6. Scope manifest and checkpoints (PROD-REL-04)

`docs/build/production/permissions.json` lists approved budgets, disposable-resource rules, per-harness grants and forbidden
actions (purchases, terms, accounts, production resources, unrelated services, secret bypass, protected branches, history
rewrites, untagged deletes). It ships **unapproved**: every live harness refuses until a person runs
`npx tsx scripts/release/permissions-cli.ts approve --by <name>` in a terminal and types back the digest. Editing anything after
approval makes the approval stale. Long runs write `checkpoint.json` (steps, decisions, exact next commands); a resumed run never
repeats a passed step, treats a step that was running as interrupted, and refuses a changed scope. Checkpoints claim no unattended
work.
