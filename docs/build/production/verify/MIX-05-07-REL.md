# PROD-MIX-05, PROD-MIX-06, PROD-MIX-07, PROD-REL-01, PROD-REL-02, PROD-REL-04: verification notes

Built only; nothing here was executed. Typecheck (`npx tsc --noEmit -p .`, Node 22.23.3) and eslint on every changed file were the only checks run. Another machine runs every test below. Branch `prod/harness-rel-w5`, base `c02c097e` (waves 1 to 4). **No platform migration was needed** (version 52 was reserved and is unused); no new table, no new store function, no new dependency.

Live cloud acceptance, its budgets and its fault injection are **not approved and were never run**. Every live harness here is gated, enforces the scope manifest and reports a skip as a skip; no test in this change calls a real cloud.

## 1. What was built

### PROD-MIX-05 Protected cross-cloud connectivity

| File | Purpose |
| --- | --- |
| `src/lib/execution/mixed/connectivity.ts` | The declaration (`ConnectivityDeclaration`: partition networks, protected endpoints, opt-in VPN), exact IPv4/IPv6 CIDR arithmetic (overlap, containment, private ranges, host-bit refusal), `assessConnectivity` (every problem returned, never throws for a bad declaration), `defaultProtectedEndpoints` (the default: one mutual-TLS endpoint per cross-partition dependency, allowlist exactly the consumer's declared egress), digest, approver text. |
| `src/lib/execution/mixed/types.ts`, `parent-plan.ts` | Additive optional `MixedParentPlan.connectivity`, `MixedParentProposalInput.connectivityDigest`, `BuildParentPlanInput.connectivity`. A declaration is assessed when the plan is built (unsafe or incomplete: `plan_refused` naming only the code), re-assessed in `assertParentPlanIntegrity`, bound into `parentPlanIdFor` and into the approved proposal input. Without a declaration the plan id and proposal input are byte-identical to before. |
| `src/lib/execution/mixed/service.ts`, `details.ts` | `planMixed` passes `connectivity` through; `mixedProposalDetails` tells the approver that approving also approves the connectivity digest. |
| `src/app/api/platform/v1/mixed/plans/route.ts`, `[id]/route.ts` | POST body accepts a strict zod `connectivity`; plan summary shows `connectivity: { digest, endpoints, vpn } \| null`; the plan view exposes the approved endpoints (hosts, ports, DNS targets, pins, allowlists; no vault references or identity digests) for the live probe. |
| `scripts/acceptance/mixed/connectivity-probe.ts`, `tests/live/mixed-connectivity.live.test.ts` | Gated live probes (DNS, pinned TLS with the client certificate, mutual TLS required, TLS 1.1 refused, allowlist denial from a declared outside machine). Probes a vantage point cannot establish are `applicable: false` and listed in `notChecked`, never counted. |

### PROD-MIX-06 Real mixed application traffic

| File | Purpose |
| --- | --- |
| `fixtures/mixed-app/` | The small reference app: `web/` (GCP compute), `enricher/` (AWS; Lambda-shaped handler behind an HTTP wrapper), `db/schema.sql` (Azure PostgreSQL), `spec.json`, `zenith.app.json` (manifest v2, `nodePlacement`, `release.migrate`), README. Database URL and TLS material come from FILES; the in-memory store needs `STORE=memory`. |
| `scripts/acceptance/mixed/traffic.ts` | Deterministic traffic generator (`<runId>-<n>` client keys, replay for idempotency, outcome classes acknowledged / rejected / uncertain). |
| `scripts/acceptance/mixed/readback.ts` | Independent checker: reads PostgreSQL directly (read-only, own credential FILE), checks host suffix, recomputes price and checksum itself, rejects a non-direct channel, finds phantoms and duplicates, reports uncertain writes either way. |
| `scripts/acceptance/mixed/live-run.ts` | Gated live harness (`ZENITH_LIVE_MIXED=1`, credential FILE references, explicit `ZENITH_LIVE_MIXED_BUDGET_USD`, TTL, run id and tags): scope and gates, budget admission (control-plane economics report, per-provider scope budgets), plan evidence, connectivity probes, traffic, readback, teardown check. Fails closed, checkpoints, resumes. It does not create cloud resources; "auto-teardown" is a deadline and a check (exit 3 once overdue), destroy stays a person-approved operation. |

### PROD-MIX-07 Mixed-cloud recovery and economics

| File | Purpose |
| --- | --- |
| `scripts/acceptance/mixed/failure-scenarios.ts` | Four scenarios (outage mid-chain, revoked partition connection, blackholed timeout, expiry with partial apply) over the real `applyRunEvent`/`summarizeRun` and the real `reverifyAuthority`. Simulation, labelled as such. |
| `scripts/acceptance/mixed/fault-proxy.ts` | Real TCP fault proxy (pass / blackhole / reset), loopback by default, one target. |
| `scripts/acceptance/mixed/live-recovery.ts` | Gated live drill: base, fault, heal with independent readbacks. Fault is exactly one of `blackhole` (client path through the proxy, reversible) or `revoke_connection` (control-plane API, irreversible, id confirmed twice). |
| `src/lib/execution/mixed/economics.ts`, `.../plans/[id]/economics/route.ts`, `bearer-paths.ts` | Estimate-only report: dated-catalog total including each cross-cloud transfer (`estimateGraphCost`, `listCrossBoundaryTransfers`), approximate latency per cross-partition edge, residency per partition, never zero for an unpriced graph, never a cap. REST `GET /api/platform/v1/mixed/plans/:id/economics` (bearer-capable read). |
| `scripts/acceptance/mixed/cost-report.ts` | Same report for the reference app's manifest (`npm run mixed:cost`). |
| `docs/platform/operations/MIXED-RECOVERY.md` (+ README row) | Connectivity model, the live harnesses, recovery runbook per scenario, economics, scope manifest. |

### PROD-REL-01 / PROD-REL-02 / PROD-REL-04

| File | Purpose |
| --- | --- |
| `scripts/release/scenarios.ts` | Data: 19 scenarios (the 16 required plus mixed recovery, mixed economics and release governance; protected connectivity is a lane of dns-tls) mapped to the vitest lanes and gated live harnesses that exist. |
| `scripts/release/acceptance-orchestrator.ts` | `list`, `check`, `run [--only] [--include-live]`: runs local lanes with vitest (one worker), records passed / passed_with_skips / no_tests / failed, defers live lanes unless `--include-live` AND an approved scope AND the harness gates; status vocabulary never says "passed" for a scenario (`verified_live` only when the live lane passed). Resumable. |
| `scripts/release/dossier.ts` | Reads `ledger.json`, `evidence/**`, `verify/*.md`; one row per requirement (implementation, tests named and present, environments, commits, evidence by required level). Unperformed or pending levels are shown as such; `verified` only when the ledger says so AND every required level has an entry; skips and failures flagged; ledger `releaseStatus` copied, never changed. |
| `docs/build/production/permissions.json`, `scripts/release/scope.ts`, `permissions-cli.ts` | The machine-readable scope manifest (approved budgets, disposable-resource rules, per-harness grants, forbidden actions), shipped **unapproved** with PROVISIONAL budget proposals. `approve` needs a terminal and the typed digest; any later edit makes the approval stale. `Scope.authorize` enforces grants, forbidden actions, run id, disposable name and tag, TTL, per-run, per-provider and total budgets with a cumulative ledger. |
| `scripts/release/checkpoint.ts` | Atomic JSON checkpoints: steps, decisions, exact next commands (refused if they carry a secret value), `unattendedClaims: false`, in-progress step becomes `interrupted` on resume, resume refused under a changed scope. |
| Wiring | `aws-live.ts` (grant before any cloud call, budget clamped to the approved per-run budget), `cleanup.ts` entry via `cleanup-cli.ts` `scopeGate` (unit tests keep driving `runCleanupCli` without a gate), `aws-iam-permissions-cli.ts` `createPort`, and `scopeSkipReason` in the azure, non-AWS DNS, billing and mixed live suites. `tests/release/live-scope-coverage.test.ts` fails when a file that reads a `ZENITH_LIVE_*` gate is neither wired, covered by a named enforcer nor exempted in the manifest. |
| `package.json` | Scripts `mixed:cost`, `mixed:live`, `mixed:recovery`, `release:acceptance`, `release:dossier`, `release:permissions`. |

## 2. Acceptance mapping

| Requirement and clause | Implementation | Tests |
| --- | --- | --- |
| MIX-05 network, DNS, TLS, identity and secret bindings | `assessConnectivity` rules (CIDR, allowlist inside the consumer's egress, DNS name/targets/TTL, TLS version/names/pin/client CA, identity digest, vault references only) | `tests/execution/mixed/connectivity.test.ts` (one assertion per problem code), `tests/acceptance/mixed-connectivity-probe.test.ts` |
| MIX-05 overlap handling | `cidrsOverlap`; refused for an opted-in VPN pair, noted as tolerated otherwise; private allowlist entries refused | same |
| MIX-05 private connectivity or explicitly approved protected endpoints | protected endpoint default; VPN only with `optIn`; declaration digest in the plan id and approved proposal input; approver text | same, plus "binding the declaration into the plan and its approval" |
| MIX-05 databases never silently public | database endpoints: mutual TLS, host routes only, no wildcard name, never `0.0.0.0/0`, private or outside-egress entries | same ("a database is never silently public") |
| MIX-05 live proof | gated probes with vantage points, never counted when skipped | `tests/live/mixed-connectivity.live.test.ts` (skipped without `ZENITH_LIVE_MIXED=1`) |
| MIX-06 GCP compute + Azure PostgreSQL + AWS function (or equivalent) serve actual traffic | `fixtures/mixed-app` (AWS tier is a container service with a Lambda-shaped handler: the manifest has no function service kind) | `tests/acceptance/mixed-traffic.test.ts` (real fixture servers on loopback, manifest parses and places GCP / AWS / Azure) |
| MIX-06 independently checked readback | `readback.ts`: direct database channel, own implementation, host check | same ("the independent readback verdict") |
| MIX-06 gated live harness, credential FILE refs, explicit budget cap, auto-teardown with run-id tags and TTL | `live-run.ts` | `tests/acceptance/mixed-live-run.test.ts` (contract level with fakes: refusal without scope, budget cap and per-provider budgets, fail closed, resume, overdue teardown) |
| MIX-07 transfer, latency and residency costs | `economics.ts` over COST-01/02 | `tests/execution/mixed/economics.test.ts` |
| MIX-07 one-provider failure recovery demonstrated | failure scenarios (simulation) and the live drill (deferred) | `tests/acceptance/mixed-failure-scenarios.test.ts`, `tests/acceptance/mixed-live-recovery.test.ts` (real TCP blackhole, drill phases, revoke path with a faked control plane) |
| MIX-07 full acceptance harness exists without live accounts | `live-run.ts`, `live-recovery.ts`, probes, orchestrator | all of the above |
| REL-01 end-to-end evidence scenarios | `scenarios.ts`, `acceptance-orchestrator.ts` | `tests/release/acceptance-scenarios.test.ts`, `tests/release/orchestrator.test.ts` |
| REL-02 requirement to evidence dossier, unperformed items visible | `dossier.ts` | `tests/release/dossier.test.ts` (synthetic ledgers and the real ledger) |
| REL-04 approved budgets, disposable only, forbidden actions, enforced before acting | `permissions.json`, `scope.ts`, wiring | `tests/release/scope.test.ts`, `tests/release/live-scope-coverage.test.ts` |
| REL-04 resumable checkpoints, exact next commands, no unattended claims | `checkpoint.ts` | `tests/release/checkpoint.test.ts`, resume cases in `tests/release/orchestrator.test.ts` and `tests/acceptance/mixed-live-run.test.ts` |

## 3. Verification commands (other machine)

Node 22, repository root.

```
npx vitest run tests/release tests/execution/mixed tests/acceptance/mixed-traffic.test.ts tests/acceptance/mixed-live-run.test.ts tests/acceptance/mixed-failure-scenarios.test.ts tests/acceptance/mixed-live-recovery.test.ts tests/acceptance/mixed-connectivity-probe.test.ts tests/live
# verified behaviour that must stay green (plan id, proposal input, cleanup, live gates, route classification, docs):
npx vitest run tests/execution/mixed-partitions.test.ts tests/execution/mixed-orchestration.test.ts tests/controlplane/mixed-parent-plans.test.ts tests/acceptance tests/providers/azure/live.test.ts tests/cost tests/middleware/platform-bearer.test.ts tests/docs/operator-docs.test.ts tests/placement
npx tsc --noEmit -p . && npx eslint scripts/release scripts/acceptance src/lib/execution/mixed src/app/api/platform/v1/mixed tests/release tests/acceptance tests/execution/mixed tests/live fixtures/mixed-app
npx tsx scripts/release/acceptance-orchestrator.ts check
npx tsx scripts/release/dossier.ts --out dossier.md --json dossier.json
npx tsx scripts/acceptance/mixed/cost-report.ts --residency us
npx tsx scripts/release/permissions-cli.ts check        # expected to FAIL until a person approves the scope
```

Expected: every test passes; skipped only the gated live suites (`tests/live/mixed-connectivity.live.test.ts` live describe, and the existing live suites), each printing its reason, never counted as passed. `permissions-cli.ts check` exits 1 with `not_approved`; `cost-report.ts` exits 0 and prints "ESTIMATE, not an invoice and not a billing cap" (if it prints "Not priced", the catalog lacks a price for one placed node: say so, do not patch the test). `acceptance-orchestrator.ts run` (not required here) takes a long time: one vitest process per lane.

Live (all deferred, run only by the user): `ZENITH_LIVE_MIXED=1 ... npx tsx scripts/acceptance/mixed/live-run.ts` after `permissions-cli.ts approve`; `ZENITH_LIVE_MIXED=1 ZENITH_LIVE_MIXED_RECOVERY=1 ZENITH_LIVE_MIXED_FAULT=blackhole ... live-recovery.ts`; `npx vitest run tests/live/mixed-connectivity.live.test.ts` with its references. Variable lists are in each file's header and `MIXED-RECOVERY.md`.

## 4. Known gaps, things that may break first, shared-file updates

**Gaps (stated, not hidden).**
- Zenith does not provision the declared mutual-TLS termination, allowlists, DNS records or VPNs: the connectivity declaration is assessed, bound into the approval and probed, but the deployment must implement it (the node compilers do not yet emit these resources). `compilerReferenceCoverage` for typed values is unchanged.
- `planMixed` (the REST and service entry) now refuses, with `plan_refused` / `missing_connectivity`, any plan whose partitions depend on each other and that carries no connectivity declaration; the default cannot be derived without host names, key pins, vault references and egress addresses. `buildParentPlan` itself stays pure and unchanged, so plans with no cross-partition dependency keep `connectivity: null`.
- The allowlist is static: a changed NAT or function egress address is not detected. Live probes see the endpoint from one vantage point at one moment; a complete proof needs one run from inside and one from outside the allowlist.
- `live-run.ts` creates no resources (the deployment is the person-driven MIX-01/02 flow); teardown is a deadline and a check, not a destroy. AWS leftovers still need `cleanup.ts --run-id` (which refuses execution without native quiescence authority).
- The failure scenarios are a simulation over the real reducer. The blackhole drill blackholes the CLIENT path through a local proxy, not a provider-side route; the revocation drill is irreversible and was not run.
- Justified equivalent for "AWS functions": the AWS tier is a container service with a Lambda-shaped handler, because manifest services have no function kind and the `aws:lambda_function` driver is experimental and unreachable from manifests (specs.ts does not expand function nodes). It serves the same stateless enrich-and-checksum role over the same protected endpoint.
- `permissions.json` budgets are PROVISIONAL proposals and the file is unapproved. Approval is a file edit pinned by a digest; it cannot stop an operator who edits and re-approves, nor a harness that never calls it (the coverage test is the guard). The `ZENITH_TEST_*` external lanes (Temporal mTLS, GitHub App) have their own gates in `scripts/ci/gate-manifest.mjs` and are outside this manifest.
- The dossier reports what the ledger and evidence files record; it does not check that a recorded result is true.
- `cleanup-cli.ts` enforces the scope through a `scopeGate` parameter that only the program entry (`cleanup.ts`) supplies, so unit tests keep their modeled clients.

**May break first.**
1. `tsc` on `tests/acceptance/mixed-traffic.test.ts` and `mixed-live-recovery.test.ts`: they import the fixture's plain `.mjs` (allowJs, inferred types); `env` objects are cast to `NodeJS.ProcessEnv` because the repository augments it with a required `NODE_ENV`.
2. `tests/execution/mixed/economics.test.ts` and the cost report assume the bundled catalog prices container services (GCP `us-central1`, AWS `us-east-1`), PostgreSQL (Azure `eastus`) and cross-cloud internet egress; a catalog refresh that drops one makes the report say "Not priced", and the test names the reason.
3. `tests/acceptance/mixed-live-recovery.test.ts` uses real loopback sockets and a 1.5 second client timeout per blackholed request (four requests, concurrency four); a very slow host may need a longer timeout.
4. `tests/release/dossier.test.ts` reads the real ledger and verify directory; a verify document that names a test file that does not exist is flagged on its row (this change's own document names only existing files).
5. Plan summaries now carry `connectivity: null`; any test that asserts the exact summary object of `POST /api/platform/v1/mixed/plans` needs that key.
6. `tests/middleware/platform-bearer.test.ts` classifies every route file: the new `mixed/plans/[id]/economics` route is added to `bearer-paths.ts` (GET, bearer-capable).

**Shared-file updates the orchestrator must make.**
- Migrations inventory: none. Tenancy classification and `src/lib/sensitivedata/inventory.ts`: no new table or store function.
- Gate manifest and platform coverage (unit lane, no postgres): `tests/release/*.test.ts` (scope, checkpoint, acceptance-scenarios, orchestrator, dossier, live-scope-coverage), `tests/execution/mixed/connectivity.test.ts`, `tests/execution/mixed/economics.test.ts`, `tests/acceptance/mixed-traffic.test.ts`, `mixed-live-run.test.ts`, `mixed-failure-scenarios.test.ts`, `mixed-live-recovery.test.ts`, `mixed-connectivity-probe.test.ts`; skipped live suite `tests/live/mixed-connectivity.live.test.ts`. Add the live harness commands as external acceptance entries (never counted as passed when skipped).
- Route inventory: one new route file `src/app/api/platform/v1/mixed/plans/[id]/economics/route.ts`.
- LIMITATIONS: protected endpoints are declared, approval-bound and probed but not provisioned by Zenith; plans without a declaration remain valid; failure scenarios are simulation, the live drill and live traffic are deferred; the scope manifest is unapproved with provisional budgets; live harnesses create nothing themselves.
- Ledger: attach this document as the verification note of the six requirements and the six test lists above as `testPaths`.

## 5. Suggested ledger implementationStatus

- PROD-MIX-05: `protected_endpoint_default_with_cidr_overlap_dns_tls_identity_secret_bindings_and_opt_in_vpn_assessed_and_approval_bound_built_contract_tests_pending_provisioning_of_the_declared_network_and_gated_live_probes_deferred`
- PROD-MIX-06: `reference_mixed_app_traffic_generator_and_independent_readback_built_local_engine_tests_pending_gated_live_harness_deferred_by_user`
- PROD-MIX-07: `failure_scenarios_over_real_state_machine_fault_proxy_recovery_runbook_and_transfer_latency_residency_cost_report_built_simulation_and_local_tests_pending_live_drill_deferred_by_user`
- PROD-REL-01: `end_to_end_acceptance_orchestrator_mapping_nineteen_scenarios_to_existing_lanes_and_gated_live_harnesses_built_contract_tests_pending_run_and_live_lanes_deferred`
- PROD-REL-02: `requirement_to_evidence_dossier_generator_built_unperformed_and_pending_levels_shown_never_passed_contract_tests_pending`
- PROD-REL-04: `scope_permission_manifest_unapproved_with_provisional_budgets_enforced_by_live_harness_entry_points_and_resumable_checkpoints_built_contract_tests_pending_person_approval`
