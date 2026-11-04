# PROD-LIFE-12 Single owner per mutable field

## J13 concurrency follow-up, 8 October 2026

Acceptance remains: "Native operations, IaC and autoscalers have explicit field ownership and conflict detection; no competing writers."
Status: `implementation_complete_verification_pending`. The earlier receipts below are historical, not evidence for this patch.

### Implementation and acceptance mapping

- `src/lib/controlplane/db/migrations/0053_field_ownership_serialization.ts`: mandatory invoker triggers on `platform.resources` (insertion, deletion, identity/graph-fact updates) and `platform.ownership_transfers` (all mutations). Both acquire the same transaction advisory lock keyed by the workspace/environment JSON tuple. A moved resource locks both scopes in numeric key order; hash collisions only over-serialize. No new table, secret, role, dependency or privileged fallback. Published migrations and aggregates are unchanged.
- `src/lib/controlplane/db/repos/ownership-transfers.ts`: `lockForOperation` acquires that lock before reading the ownership graph. Existing `operations.claimForExecution` and `grants.insert` callers retain it until their final mutation commits, including fresh expiry predicates. A missing target on a modern schema returns an empty dependency list so the final execution-validity predicates still run after waiting; only historical schemas without the transfer relation keep that legacy null path. `guardFor` reads resource facts and transfers in one locked transaction. READ COMMITTED is required: a fixed snapshot after a lock wait is refused. Resource/transfer tuple locks are replaced by the coordinator to avoid inversions with BEFORE ROW update triggers. Transfer INSERT takes its operation/approval FK locks before the coordinator, preserving fence -> operation -> ownership -> cleanup admission order. It does not acquire those FK locks during revocation.
- Both graph reads now fetch 2,001 rows and refuse above the existing 2,000-resource admission bound. Truncation must not silently omit a newly inserted autoscaler or target.
- `tests/controlplane/ownership-serialization.test.ts`: 14 PGlite controls for committed new owners, separate autoscaler resources, direct resource fact updates, rollback, grant-time recheck, stale-isolation refusal, graph overflow, additive/idempotent migration registration, resource movement/deletion, and absent-target expiry after the coordinator. The expiry control injects a real SQL backdate at the wait boundary without fabricating results or a clock; it is explicitly a fault-injection contract. These are serialized engine checks, not independent-backend race proof.
- The same file has 18 gated real-PostgreSQL controls: three mutation types racing claim and grant (six); readback waits (three); dispatch winning first (three); resource tuple-lock inversion (one); writer rollback (one); absent-target expiry during a real coordinator wait (one); independent workspace/environment keys (one); operation FK lock order for direct transfer INSERT (one); actual schema43 -> 53 upgrade and unchanged old checksums (one). Waits are observed through `pg_blocking_pids`/`pg_locks`, with distinct backend PIDs. Native race handles disable transaction retries so a deadlock cannot be concealed by replay. Assertions check operation status, approval consumption, grant absence and the winning owner. No provider is contacted.
- Existing ownership registry, broker and approval/custody controls remain regression targets: `tests/ownership/field-ownership.test.ts`, `tests/capabilities/field-ownership-broker.test.ts`, `tests/capabilities/ownership-transfers.test.ts`, `tests/controlplane/ownership-transfers.test.ts`.

### Mac verification, lean profile

Run only against an owned disposable database, on the integrated candidate with migrations44-52 inserted. Node22 required; one Vitest worker and no file parallelism. No Temporal, kind, browser, Supabase stack or cloud service is needed for this race packet. PostgreSQL uses384MiB, one CPU and20 connections; the Node heap is1GiB. Stop other heavy workloads on the8GiB Mac.

The role stand-ins below prove PostgreSQL service-role ACLs/RLS boundaries, not Supabase Auth, browser authentication or the production transaction pooler. Test approval principals are fixture humans, not operated browser approvals.

```bash
set -euo pipefail
node --version # must be v22.x
J13_CONTAINER="zenith-j13-$(openssl rand -hex 6)"
J13_PASSWORD="$(openssl rand -hex 24)"
docker run --detach --rm --name "$J13_CONTAINER" \
  --label zenith.acceptance=j13-ownership --memory=384m --cpus=1 \
  -p 127.0.0.1::5432 -e POSTGRES_DB=zenith_j13 \
  -e POSTGRES_PASSWORD="$J13_PASSWORD" \
  postgres:16.15 -c shared_buffers=32MB -c max_connections=20
cleanup_j13() {
  if [ "$(docker inspect -f '{{ index .Config.Labels "zenith.acceptance" }}' "$J13_CONTAINER" 2>/dev/null)" = j13-ownership ]; then
    docker rm --force "$J13_CONTAINER"
  fi
}
trap cleanup_j13 EXIT
for attempt in $(seq 1 60); do
  docker exec "$J13_CONTAINER" pg_isready -U postgres -d zenith_j13 && break
  sleep 1
done
docker exec "$J13_CONTAINER" pg_isready -U postgres -d zenith_j13
docker exec "$J13_CONTAINER" psql -U postgres -d zenith_j13 -v ON_ERROR_STOP=1 \
  -c 'create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;'
J13_PORT="$(docker port "$J13_CONTAINER" 5432/tcp | sed 's/.*://')"
export ZENITH_TEST_PLATFORM_PG_URL="postgres://postgres:${J13_PASSWORD}@127.0.0.1:${J13_PORT}/zenith_j13?sslmode=disable"
export NODE_OPTIONS=--max-old-space-size=1024
npx vitest run tests/controlplane/ownership-serialization.test.ts \
  tests/controlplane/ownership-transfers.test.ts \
  --no-file-parallelism --maxWorkers=1
npx vitest run tests/ownership/field-ownership.test.ts \
  tests/capabilities/field-ownership-broker.test.ts \
  tests/capabilities/ownership-transfers.test.ts \
  --no-file-parallelism --maxWorkers=1
cleanup_j13
trap - EXIT
unset ZENITH_TEST_PLATFORM_PG_URL J13_PASSWORD
```

Expected first command:39 passed /0 failed /0 skipped (14 embedded +18 new native +7 existing native). Counts for the integrated second command must be recorded from actual output, separately from the first command. Missing `ZENITH_TEST_PLATFORM_PG_URL` explicitly skips the25 native cases; never count those as passes. The scratch-database harness requires CREATEDB, creates random databases, and drops only its own databases in `finally`. The controller removes only its labelled owned container. This plain local PostgreSQL profile intentionally has no TLS/pooler claim. Re-run under the canonical private-CA/pooler verifier separately if that evidence is needed.

Additional integrated checks (separate serial commands, expected0 failures; counts must be recorded on the exact candidate). Execute these while the owned PostgreSQL container and `ZENITH_TEST_PLATFORM_PG_URL` from the controller block above are still active, before its `cleanup_j13`/`unset` lines, so native cases do not silently skip:

```bash
npx vitest run tests/controlplane/tenancy.test.ts tests/security/controlplane-sql-scoping.test.ts --no-file-parallelism --maxWorkers=1
npx vitest run tests/controlplane/migrations.test.ts --no-file-parallelism --maxWorkers=1
```

### Integration and remaining limits

- Migration53 is deliberately registered after43 in this worktree. Insert wave-5 migrations44-52 before53; do not renumber53. Integration owns the new aggregate, emitter metadata and migration/gate/version inventories (including contiguous migration assertions). Do not run the unchanged aggregate equality/version gate on this pre-integration tree and report it as green.
- No new table or exported store function: no new sensitive-data/tenancy classification. Existing tenant-scoped `guardFor` and `lockForOperation` remain swept. Trigger functions are security invoker, use a fixed `pg_catalog` search path and do not change RLS/grants. Source and SQL locks use identical database-side JSONB key construction.
- The structural migration classifier considers53 expand-only; admission safety still requires draining pre53 dispatch binaries before activating this guarantee. Old admissions do not take the new coordinator and cannot prove absence of competing insertions. Apply migration53 transactionally, then use only coordinated dispatch binaries; perform the real upgrade/race controls before acceptance. Live migration/zero-downtime acceptance is not inferred.
- Environment locks serialize native admission with committed ownership mutations, not remote provider execution. A mutation that follows a completed grant cannot retract that grant or an already-issued cloud call. Existing IaC default warning and unowned-target permission baseline remain; modern absence now retains the final execution-validity checks, but is not positive proof of universal no-competing-writers. Other IaC/native/provider dispatch seams remain outside this J13 ownership allocation.
- Multi-environment/multi-row writer transactions can still require whole-transaction deadlock retry (the executor already does this); no provider call is inside these retriable SQL transactions.
- Ledger state stays `in_progress`, with `implementationStatus=implementation_complete_verification_pending` and a short J13 note. Existing evidence is preserved; this job adds no fabricated native receipt and marks nothing verified.
- Native PostgreSQL, Docker, transaction pooler, Temporal, kind, browser and live cloud checks were not run on this Windows builder. The Mac commands above are required follow-up. No old expectation, assertion or environment gate was weakened or removed.

### Windows builder commands and results

All PowerShell shells prepend `C:\Users\user\.local\sdk\node22` to PATH. Tests explicitly unset `ZENITH_TEST_PLATFORM_PG_URL` to keep this machine on the authorized embedded/contract lane. Commands are targeted, not the whole suite. Counts overlap across attempts; do not sum them.

1. `npx vitest run tests/controlplane/ownership-serialization.test.ts tests/ownership/field-ownership.test.ts tests/capabilities/ownership-transfers.test.ts tests/capabilities/field-ownership-broker.test.ts tests/controlplane/ownership-transfers.test.ts --no-file-parallelism --maxWorkers=2`: **60 passed /0 failed /23 skipped**, exit0,124.34s. Initial implementation before the added movement/deletion, native FK-order and absent-target expiry controls/fix. Native skips were16 new +7 existing.
2. `npx vitest run tests/controlplane/ownership-serialization.test.ts tests/security/controlplane-sql-scoping.test.ts --no-file-parallelism --maxWorkers=2`: **16 passed /2 failed /17 skipped**, exit1,157.12s. Ownership alone: **13 passed /0 failed /17 skipped**, before the absent-target expiry fix. SQL scoping:3 passed /2 failed /0 skipped; both failures were the unchanged20-second test timeout (source-callsite scan46.062s, interpolation audit54.454s). No assertion mismatch was reported. No test budget or assertion was changed.
3. `npx vitest run tests/security/controlplane-sql-scoping.test.ts --no-file-parallelism --maxWorkers=2`: **4 passed /1 failed /0 skipped**, exit1,31.61s. Default-budget retry; the callsite scan passed. The interpolation audit timed out again at29.233s against20 seconds. This audit still requires a successful Mac rerun; do not call it passed. Its expensive existing AST mutation probes are outside J13's owned files.
4. `npx eslint src/lib/controlplane/db/repos/ownership-transfers.ts src/lib/controlplane/db/migrations/0053_field_ownership_serialization.ts src/lib/controlplane/db/migrations/index.ts tests/controlplane/ownership-serialization.test.ts`: run four times, all exit0, **0 errors /0 warnings /0 skipped**. The fourth run covers the final source and tests after the expiry and fixture typing fixes.
5. `bash Z:/Projects/Spawned.ai/zenith-wt/.resume/codex/tsc-serial.sh`: first attempt **exit1,2 TS2739 diagnostics**, both new test fixtures missing required `region`, `dependsOn`, `labels`, `origin` fields. Fixed by providing the actual complete node shape; no assertion or expectation changed. Second invocation after that fix: **exit0,0 diagnostics**, on the final source. No direct whole-repo `tsc` invocation; the wrapper owns the shared lock and Node22 heap setting. Typecheck has no test pass/fail/skip counts.
6. `git diff --check`: run three times, all exit0, **0 whitespace errors**. Read-only Git inspection (`git status --short`, `git log --oneline -10`, `git diff --stat`, `git diff --numstat`, `git diff -- src/lib/controlplane/db/repos/ownership-transfers.ts docs/build/production/ledger.json`) succeeded. `node --version` returned22.23.3. The JSON parse/read check confirmed LIFE-12 stays `in_progress`, verification pending, with all five prior evidence entries preserved. These inspection commands have no test pass/fail/skip counts.
7. `npx vitest run tests/controlplane/ownership-serialization.test.ts tests/capabilities/ownership-transfers.test.ts tests/capabilities/field-ownership-broker.test.ts --no-file-parallelism --maxWorkers=2`: **33 passed /0 failed /18 skipped**, exit0,151.68s, after the absent-target expiry fix. Includes all14 embedded ownership controls and the existing broker regressions. Skips are all18 gated new native controls. No existing expectation changed.
8. `npx vitest run tests/controlplane/ownership-serialization.test.ts --no-file-parallelism --maxWorkers=2`: **14 passed /0 failed /18 skipped**, exit0,76.98s, after completing the resource fixture node shapes. This is the final ownership test source. Native cases remain unrun.

Read-only `Get-Content`/`rg` inspection covered PREAMBLE (all addenda), PLAN-100 LIFE-12/J13/decisions, the verifier handoff, acceptance ledger, ownership registry/facts/guards, claim/grant/approval/resource repositories, migration/migrator/compatibility code, test harness and SQL-scoping checks. Some exploratory lookups named nonexistent `capability-grants.ts`, `migrate.ts`, `0043_mcp_stream_replay_index.ts`, or `ledger.schema.json`, and two PowerShell wildcard paths were rejected by `rg`; the actual `grants.ts`, `migrator.ts`, `0043_mcp_stream_events_tenant_index.ts`, and directory searches were then read successfully. These were lookup failures, not test results. No dependency install, Git mutation, engine service, cloud API or live credential use occurred.

Long typecheck-wait diagnostics: `Get-Item` read the shared lock timestamps; no lock was changed by the agent. `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` was denied by sandbox permissions (a diagnostic failure, not a compiler result). `Get-Process` exposed no useful compiler identity. Raw wrapper inspection found0 CRLF line endings. `bash -c 'export PATH="/c/Users/user/.local/sdk/node22:$PATH"; printf "%s\n" "$SHELLOPTS"; node --version; pwd'` exited0 and confirmed Node22.23.3 and the correct worktree. These diagnostics have no test counts and did not bypass the serialized wrapper.

## 1. What was built
New pure module `src/lib/ownership/` (one door `@/lib/ownership`):
- `types.ts`, `paths.ts`: owners (`iac | native-op | autoscaler | provider-managed`), rules, transfers, writes, conflicts.
- `registry.ts`: `FieldOwnershipRegistry` (resource type + field path -> owner; registration refuses two rules claiming one field), default rules that mirror existing behaviour (ECS/K8s/Azure replicas -> autoscaler when attached, release image -> native-op for built artifacts, EC2 `ami` and Azure flexible-server zones -> provider-managed, SSM parameter value -> native-op), exact digest-bound `OwnershipTransfer` handling (`transferDigest`, `transferRequest`).
- `facts.ts`: autoscaled / release-managed facts derived from the compiled graph (`spec.autoscaling`, native HPA / app-autoscaling nodes).
- `conflicts.ts`: `evaluateWrite` (allowed | transfer_required | refused), `checkNativeOperation` / `assertNativeOperationAllowed` (service.scale, deployment.deploy/rollback, drift.repair), `checkPlanFieldOwnership` / `assertPlanFieldOwnership` over a NormalizedPlan.
- `drift.ts`: `classifyDrift` (unauthorized_change | native_divergence | expected_variance) and `applyFieldOwnership` (drops autoscaler/provider variance, marks native-op-owned drift non-repairable).
- `lifecycle.ts`: `ignoreChangesFor`, `lifecycleIgnoreChanges`, `mergeIgnoreChanges`.

Typed API for PROD-COST-03: `resolveFieldOwner`, `evaluateWrite`, `FieldOwnershipRegistry`, `transferRequest`, `factsForNode`/`factsByAddress`, `FieldConflict`, `OwnershipTransfer`.

Integrations (edited files):
- `src/lib/capabilities/broker.ts` + `types.ts`: optional `ProposeContext.fieldOwnership` guard; propose and check throw `BrokerError("conflict")` with `details.reason = "field_ownership_conflict"` before anything is persisted.
- `src/lib/execution/plan.ts` (`inspectDeployDeletions`): plan-time refusal (StepFailedError) of IaC updates to non-iac fields.
- `src/lib/reconcile/core.ts`, `src/lib/execution/verify.ts`: drift reports pass through `applyFieldOwnership`.
- `src/lib/providers/aws/drivers/compute/ecs-service-compile.ts`: `lifecycle.ignore_changes = ["desired_count"]` only when an autoscaler is attached (no output change otherwise).

## 2. Acceptance mapping
"Native operations, IaC and autoscalers have explicit field ownership and conflict detection; no competing writers."
- Explicit ownership: registry + default rules -> `tests/ownership/field-ownership.test.ts` (registry, facts).
- Native operation conflicts: `tests/ownership/field-ownership.test.ts` (native operation enforcement), `tests/capabilities/field-ownership-broker.test.ts` (both stores).
- IaC conflicts: plan enforcement block in `tests/ownership/field-ownership.test.ts`.
- Autoscaler: facts, drift and lifecycle blocks; `tests/providers/aws/drivers/compute/ecs-ownership-lifecycle.test.ts`.
- Drift uses ownership: drift classification block.
- No competing writers via transfers: exact, digest-bound, expiring, from-owner-checked transfers (registry block).

## 3. Verification commands
- `npx vitest run tests/ownership tests/capabilities/field-ownership-broker.test.ts tests/providers/aws/drivers/compute/ecs-ownership-lifecycle.test.ts` (all pass; broker test uses the existing PGlite harness, no extra env).
- Regression: `npx vitest run tests/capabilities tests/reconcile tests/resources tests/providers/aws/drivers/compute tests/execution` should be unchanged.
- `npx tsc --noEmit -p .`: only pre-existing errors in `src/lib/tofu/engine.ts` and `tests/ci/platform-coverage.test.ts` (not touched by this work).

## 3b. Follow-up: persisted transfers, plan-time transfers, default-on broker guard
- Migration: platform migration 18 `ownership_transfers` (`src/lib/controlplane/db/migrations/0018_ownership_transfers.ts`, registered in `migrations/index.ts`; checksum `d19177da5b80a5bde2ea6b51d232f288d7123546d7aca483d216d710bd769e7a`). Table `platform.ownership_transfers`: workspace/project/environment, address, resource type, field path, from/to owner, transfer digest, `operation_id` + `approval_id` (FK to the approving human approval), `proposal_digest` (the immutable proposal), approved/expires/revoked columns, RLS on with no policies, append-only trigger (only one-way revocation), service_role select/insert + update(revoked_at, revoked_by) only (also in the emitter's hardening block). prod/compose was merged first. Platform 17 is MACH-03's; the supabase aggregate for this change is `supabase/migrations/0020_platform_core.sql` (EMITTED_FILE bumped). It was generated WITHOUT migration 17 in the tree: after merging MACH-03, re-run `npx tsx scripts/platform/emit-sql.ts`, and adjust the 0019/0020 file names, inventory rows and counts if MACH-03 took a different supabase number.
- Store: `src/lib/controlplane/db/repos/ownership-transfers.ts` (namespace `ownershipTransfers`, in repos index and bindRepos): `recordForApprovedOperation`, `listActive`, `revoke`, `guardFor`. Transfers are created ONLY by `approvals.record`, in the same transaction that moves an operation to approved: a human user approval of the exact proposal digest, for the transfers stored in `proposal.broker.ownershipTransfers` (digests recomputed, never trusted). Models cannot create them; they can only request one (`input.requestOwnershipTransfer = true`), which forces a require_approval outcome and shows the exact transfer to the approver.
- Plan-time: the `execution/plan.ts` inspector loads `resources.activeOwnershipTransfers` (optional ResourcesPort method, implemented in `execution/platform.ts`; fakes without it get none). Non-iac updates pass only with a matching unrevoked transfer. Defaults: a field with no rule is owned by iac, so ordinary updates are never refused; only fields with an explicit autoscaler, native-op or provider-managed owner are enforced.
- Broker default-on: `BrokerStore.fieldOwnership?` (implemented by `PlatformBrokerStore`, tenant-scoped in SQL). `propose` and `check` call it after policy evaluation (so only an authorized principal learns anything) for service.scale, deployment.deploy/rollback and drift.repair. REST, MCP, bridge and reconciler all go through the broker, so all are covered. An explicit `ctx.fieldOwnership` still wins. A store-supplied guard is lenient in exactly one case, to keep existing day-two journeys working: a native op on a field only the manifest owns by default proceeds with an approver-visible warning (the next apply may revert it). Autoscaler, provider, release and transferred fields are refused either way.
- Tests: `tests/capabilities/ownership-transfers.test.ts` (pglite and postgres lanes), `tests/ownership/field-ownership.test.ts` (includes "does not refuse ordinary iac-owned updates" and "allows a non-iac update only with a matching unrevoked transfer"), tenancy classification in `tests/controlplane/tenancy.test.ts`.
- Inventories I updated: `scripts/ci/apply-supabase-migrations.sh` (adds 0020), `docs/platform/operations/DEPLOYING.md` (count 17, highest 18, row 18, aggregate 0020), `tests/controlplane/migrations.test.ts` (version 18 name and checksum), `tests/ci/platform-coverage.test.ts` (committed file list). Tenancy classification (SWEPT, with foreign-workspace attempts): `ownershipTransfers.listActive`, `.guardFor`, `.revoke`, `.recordForApprovedOperation`. The sql-scoping test is static discovery; every query filters `workspace_id`.
- Verify: `ZENITH_TEST_PLATFORM_PG_URL=... npx vitest run tests/capabilities/ownership-transfers.test.ts tests/controlplane/tenancy.test.ts tests/controlplane/migrations.test.ts tests/security/controlplane-sql-scoping.test.ts tests/ci/platform-coverage.test.ts tests/docs/operator-docs.test.ts tests/ownership`.

## 4. Known gaps and orchestrator follow-ups
- Revocation has a store function but no REST/UI route yet; ownership is rechecked at propose time only (not again at claim).
- Only ECS compile consumes `ignoreChangesFor`; Azure/GCP/EC2 keep their hard-coded `ignore_changes`, which a test asserts match the registry. `spec.autoscaling` is not yet a manifest field; the autoscaled fact also comes from native HPA / `aws:appautoscaling_target` nodes.
- Rules are seeded for ECS, K8s, Azure Container Apps, GCP Cloud Run, EC2, Azure flexible servers and SSM parameters only.
- No tests were run locally (build-only rule).
- Shared files edited as instructed (see 3b).

## 5. Suggested ledger implementationStatus
`field_ownership_registry_plan_and_proposal_enforcement_drift_classification_ignore_changes_contract_only_transfer_persistence_pending`


## Wave 6 final integration

Status remains `implementation_complete_verification_pending`. Node 22 only. Execute sequentially with Docker Desktop 4 GiB and one kind node; stop each heavy profile before starting another. Live acceptance stays deferred until separate owner approval.

```bash
node scripts/ci/wave6-gates.mjs --requirement PROD-LIFE-12 --print > /tmp/zenith-wave6-PROD-LIFE-12.commands.json
```

This prints the exact argv for each contract batch and required engine case, its gate names, private prerequisites, and its strict report-validation command. Set only the gates for the selected lane after preparing its owned fixture; a skip cannot satisfy that lane. Run each `argv` sequentially and then its `verify` argv. [Final integration setup and results](FINAL-INTEGRATION.md), [canonical inventory](../../../../scripts/ci/wave6-gates.json), [owner live runbook](../LIVE-ACCEPTANCE.md).
