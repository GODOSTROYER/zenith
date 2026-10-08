# W5-GAPS build and verifier handoff

Worktree: `prod6-w5-gaps`, base assembled `prod/compose` (`257b9ebe`). Changes remain uncommitted. No Git history, package/dependency files, published migration or SQL aggregate was changed. No cloud API was called, credential obtained, resource created, or money spent. Live cloud acceptance remains deferred. This PC provides code, PGlite and contract evidence; the Mac provides Docker, PostgreSQL, Temporal, kind and browser evidence.

## Acceptance and completed joins

| Gap | Implementation and evidence |
| --- | --- |
| MAN-06 with MAN-01/02 | Explicit provisional billing-plan to managed-capacity mapping. Tenant resolution reads the current workspace assignment, ignoring the operator tier when billing is managed. Unknown assignment/standing/quota fails closed before new work/credentials. Disabled remains the default and performs zero billing I/O; settings and billing API name the operator source. Assignment changes neither apply quotas nor stop/delete workloads. Dispatch standing is read every time, so suspension is immediate across processes; export/destroy exemptions remain. |
| Tier changes with existing isolation | Minimal join in `zenith-onboarding.ts`: verify the exact already-applied isolation bundle against its namespace's recorded capacity tier. Current billing still controls desired-plan capacity. This preserves read/teardown session admission after tier changes without changing quotas or provisioning isolation. The real kind test covers free/pro current assignment with the original starter bundle. First-deploy approval/isolation remains J14's work; isolated builds remain J6's work. |
| MIX Lambda | V2 `functions[]` is strict and emits a real experimental `function` node using the existing registered AWS driver. The reviewed S3 version, package SHA-256 and source digest are required even for hand-built graphs. OpenTofu publishes versions and outputs `qualified_arn`/`version`; observations and invocations verify actual `CodeSha256`. Invocation requires an immutable numeric version and validates `ExecutedVersion`. The fixture adapter uses SDK SigV4 and explicit scoped credential files, with no ambient credential chain or public endpoint fallback. Offline package/bind tools verify exact ZIP entries/source bytes; the Mac helper provisions only explicitly gated loopback LocalStack with runtime-generated fake credentials. |
| MIX fixture identity | `zenith.app.json` is deliberately an unbound Lambda template; invented digest strings never qualify as evidence. Bind actual immutable artifact metadata and the reviewed function's published ARN before parsing/planning. An artifact-only function plan may be deployed first; binding its actual output into the web manifest requires review of the resulting web plan. `zenith.app.container.json` preserves the separately labelled HTTP/container variant, and its traffic cost assertions name that variant explicitly. Caller IAM provisioning remains an explicit credential requirement, not a model decision. |
| OPS-04 to OPS-01 | `runRestore` retains database completion immediately after database integrity and epoch fencing. A separate authenticated readiness endpoint requires that named restore's current epoch, zero pending continuation items, current schema and application composition. The health CLI records the first observed successful readiness time, persists it before sink delivery, and retries idempotently. `database_restore` and `application_health` are separate append-only SLO samples. RTO is incident-to-application-health only; missing health or incident stays unmeasured. `/admin/slo` shows both milestones. Run the observer promptly: it cannot reconstruct an earlier unobserved readiness response. |
| OPS-07 with OPS-05 | Ordinary archive verification/restore uses only `enc:archive`. Explicit legacy restore requires operator privilege, original `enc:backup` purpose, the archive's recorded historical key fingerprint and a guarded audit reason. Only that purpose's decrypt material matching the specified fingerprint is considered; zero or multiple matches refuse. The operator API is authenticated/same-origin; the CLI is a trusted database-credential process. GCM/digest/tenant/readback checks stay intact. Attempts append actor, purpose, fingerprint, reason and verdict; secret-shaped reasons refuse and are not persisted. The admin page explains the requirement. |

Additional joins: the billing settings navigation/section, billing read-model/API source fields, recovery health CLI dispatch and measurement sink, authenticated readiness route, separate SLO report/UI milestones, shared function spec and V2-only section detection, mixed cost graph, assigned migration registration, sensitive-data SQL discovery/classification, four additive contract gate files, and four explicitly unverified external gate groups. No new scheduler is needed: restore completion is event-driven and health observation is an explicit recovery command.

## Migration and SQL classification

Only new platform migration **58**, `0057_wave5_gaps.ts`, is appended to `migrations/index.ts`. It expands allowed SLO kinds/seconds units and adds nullable legacy key-purpose/fingerprint/reason audit columns. Existing rows, append-only triggers, RLS and grants remain. No tables or secret storage are added. `key_purpose` and `restore_key_id` are plaintext metadata; `legacy_reason` is guarded operator text. The inventory discovery regex now explicitly detects these columns and its test requires that detection.

`reportRestoreCompletion` and the readiness route intentionally read system recovery/SLO data; they accept no tenant row data. The former uses a per-restore transaction advisory lock for append-once evidence, and the latter binds the exact restore run id. Billing remains workspace-bound. Archive restore SQL remains bound to the archive's verified workspace. The pre-existing `managedServing.listRevokePending` static SQL audit classification failure is unrelated and its code/test are unchanged; see checks below. No exemption or assertion was removed to hide it.

Integration owns merging assigned sibling migrations 53-57 and regenerating aggregate 0026 after assembly. This isolated tree moves from 52 to assigned 58; no aggregate was emitted. The orchestrator owns shared ledger/limitations updates; suggested ledger notes appear below.

## Mac verification commands

Run from this worktree with Node 22, two workers and an owned disposable target. Each gated command must fail/refuse when enabled prerequisites are absent; a disabled skip is never acceptance.

```bash
export PATH="$HOME/.local/sdk/node22:$PATH"
# PGlite plus actual PostgreSQL lane where supported; URL is supplied securely in the environment.
ZENITH_TEST_PLATFORM_PG_URL="$OWNED_TEST_PG_URL" npx vitest run tests/billing/managed-tier.engine.test.ts tests/billing/billing.engine.test.ts tests/slo/slo.engine.test.ts --no-file-parallelism --maxWorkers=2
npx vitest run tests/retention/restore-destination.test.ts tests/retention/admin-routes.test.ts tests/security/sensitive-inventory.test.ts --no-file-parallelism --maxWorkers=2
# Actual CLI, generated original key, independent SQL readback. Own this disposable DB: retention scans its stores.
ZENITH_TEST_RETENTION_PG=1 ZENITH_TEST_PLATFORM_PG_URL="$OWNED_TEST_PG_URL" npx vitest run tests/retention/restore-destination.test.ts --testNamePattern "legacy archive CLI" --no-file-parallelism --maxWorkers=2
# Existing real clean-host dump/restore and Temporal rehearsal. Needs matching pg_dump/pg_restore and Temporal CLI.
ZENITH_TEST_RECOVERY_REQUIRED=1 ZENITH_TEST_PLATFORM_PG_URL="$OWNED_TEST_PG_URL" npx vitest run tests/ops/recovery-rehearsal.test.ts --no-file-parallelism --maxWorkers=2
# Existing isolated kind setup from the managed-onboarding verifier; test itself requires an owned kind-zenith-life07 context.
ZENITH_TEST_MANAGED_ONBOARDING=1 KUBECONFIG="$OWNED_KIND_KUBECONFIG" npx vitest run tests/isolation/managed-onboarding-readiness.test.ts --no-file-parallelism --maxWorkers=2
# Exact local package/source binding; no cloud and no Docker required.
ZENITH_TEST_MIXED_LAMBDA_PACKAGE=1 npx vitest run tests/acceptance/mixed-lambda-package.gated.test.ts --no-file-parallelism --maxWorkers=2
```

For LocalStack use a **dedicated disposable** instance with S3, IAM and Lambda and its local Docker runtime. Existing project compose only enables S3/SQS and cannot run this Lambda harness. This command uses the repository's existing LocalStack major version; record the actually pulled image digest in verifier evidence. These commands are Mac-only and were not run here:

```bash
docker run --rm --name zenith-w5-gaps-lambda -p 127.0.0.1:4566:4566 \
  -e SERVICES=s3,iam,lambda -v /var/run/docker.sock:/var/run/docker.sock localstack/localstack:4
# In another shell, from the repository, use a new directory for every run.
node scripts/acceptance/mixed/package-lambda.mjs .data/w5-lambda-run
ZENITH_TEST_MIXED_LAMBDA=1 ENRICHER_LAMBDA_ENDPOINT=http://127.0.0.1:4566 \
  node scripts/acceptance/mixed/localstack-lambda.mjs .data/w5-lambda-run .data/w5-lambda-run/binding.json
node scripts/acceptance/mixed/bind-lambda.mjs .data/w5-lambda-run .data/w5-lambda-run/binding.json .data/w5-lambda-run/zenith.app.json
export ENRICHER_LAMBDA_ARN="$(node -p "require('./.data/w5-lambda-run/binding.json').functionArn")"
export ENRICHER_LAMBDA_SHA256="$(node -p "require('./.data/w5-lambda-run/binding.json').sha256")"
export ENRICHER_LAMBDA_CREDENTIAL_FILE="$PWD/.data/w5-lambda-run/local-credentials.json"
export ENRICHER_LAMBDA_ENDPOINT=http://127.0.0.1:4566
export ENRICHER_TIMEOUT_MS=30000
ZENITH_TEST_MIXED_LAMBDA=1 npx vitest run tests/acceptance/mixed-lambda.gated.test.ts --no-file-parallelism --maxWorkers=2
# Standalone actual web -> Lambda traffic; STORE=memory is local evidence only.
STORE=memory ENRICHER_MODE=lambda ZENITH_MIXED_LOCALSTACK=1 node fixtures/mixed-app/web/server.mjs
```

The endpoint test checks the actual provider answer against the fixture checksum. Record package/source digests, S3 object version, published function version, observed code hash and test result. The standalone web route proves Lambda participation; it does not claim real Azure PostgreSQL or GCP compute. Dispose the owned LocalStack instance through its owner after the run. The helper cannot access a non-loopback endpoint and has no live provisioning path.

Deferred live AWS: **do not run until separately authorized**. Use the approved artifact-only plan/normal credentials and approvals to obtain the exact numeric published ARN and digest, then an external private file containing unexpired scoped temporary IAM credentials. Never put credential bytes in the manifest, CLI, report or repository. The gate invokes customer code but provisions nothing:

```bash
# Approved target ARN/digest and ENRICHER_LAMBDA_CREDENTIAL_FILE are supplied externally.
unset ENRICHER_LAMBDA_ENDPOINT
ZENITH_LIVE_AWS_LAMBDA=1 npx vitest run tests/acceptance/mixed-lambda.gated.test.ts --no-file-parallelism --maxWorkers=2
```

After a real clean-host restore, resolve continuation items and reopen the application according to `docs/platform/operations/RESTORE-RUNBOOK.md`. Start health observation promptly against the restored app and database. An actual connection URL and bearer secret are externally supplied via environment/private file:

```bash
npm run ops:recovery -- health --report /backups/w5-restore-report.json \
  --readiness-url http://127.0.0.1:3000/api/internal/recovery/readiness \
  --token-file /secure/w5-restored-cron-token --target-url-env RESTORE_TARGET_URL --actor verifier --timeout-seconds 900
# Same command again must preserve the first timestamp and create no duplicate samples.
psql "$RESTORE_TARGET_URL" -c "select kind,value,measured_at,details from platform.slo_measurements where source='recovery-drill' and details->>'reference'='YOUR_RESTORE_RUN_ID' order by recorded_at,id"
```

Expect database completion before application completion and RTO equal to application timestamp minus incident timestamp. Before health is observed, RTO/application samples must be absent. Unauthenticated readiness must be 401, a foreign/old epoch or unresolved continuation must be 503. A successful database restore alone must never pass an application RTO target. The explicit native legacy gate above builds an archived-and-pruned fixture with a runtime-generated original key, runs the real CLI, and independently reads tenant rows and audit metadata from PostgreSQL. It proves implicit guessing refuses, explicit purpose/fingerprint restores, and replay changes no rows. The PGlite test additionally refuses missing privilege, wrong fingerprints and secret-shaped reasons. None of those local PGlite results are a native PostgreSQL CLI result.

Browser gate uses a real owned local Zenith server, configured cron secret/current platform schema, an authenticated operator browser state file and existing project. No mocked routes or saved traces:

```bash
ZENITH_TEST_W5_GAPS_UI=1 ZENITH_W5_GAPS_BASE_URL=http://127.0.0.1:3000 \
  ZENITH_W5_GAPS_PROJECT_SLUG=YOUR_PROJECT_SLUG \
  ZENITH_W5_GAPS_STORAGE_STATE_FILE=/secure/w5-operator-browser-state.json \
  ZENITH_TEST_BROWSER_BIN=/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  npx vitest run tests/acceptance/w5-gaps-ui.gated.test.ts --no-file-parallelism --maxWorkers=2
```

Run once with billing disabled/operator tier and once with a managed assignment; verify the actual billing API agrees with settings. The same harness checks both SLO milestones, legacy restore guidance and readiness's bearer requirement.

## Windows build evidence and commands

Every shell prepends `C:\Users\user\.local\sdk\node22` to PATH. No install/CI/package operation was run. Whole-repo typecheck is only the serialized script. Exact targeted checks and counts (attempts are retained rather than replacing failures with later successes):

| Command | Result |
| --- | --- |
| `npx vitest run tests/resources/function-manifest.test.ts tests/acceptance/mixed-lambda.test.ts tests/providers/aws/drivers/compute/lambda-ec2.test.ts tests/slo/restore-sink.test.ts tests/ops/recovery-manifest.test.ts --no-file-parallelism --maxWorkers=2` | 5 files passed; 76 passed, 0 failed, 0 skipped. Later strengthened published-version/RTO checks are rerun separately. |
| `npx vitest run tests/billing/managed-tier.engine.test.ts tests/billing/billing.engine.test.ts tests/billing/billing-routes.test.ts tests/slo/slo.engine.test.ts tests/retention/restore-destination.test.ts tests/ops/recovery-health.test.ts tests/platform/zenith-managed-composition.test.ts --no-file-parallelism --maxWorkers=2` | 5 files passed, 2 failed; 124 passed, 2 failed, 0 skipped. Historical archive fingerprint mismatch fixed; existing fresh-PGlite SLO test timed out at its unchanged 20-second limit. Both engine files passed on the next targeted run. |
| `npx vitest run tests/security/controlplane-sql-scoping.test.ts tests/resources/function-manifest.test.ts tests/providers/aws/drivers/compute/lambda-ec2.test.ts tests/acceptance/mixed-lambda.gated.test.ts tests/ops/recovery-health.test.ts tests/acceptance/mixed-traffic.test.ts --no-file-parallelism --maxWorkers=2` | 4 files passed, 1 failed, 1 skipped; 85 passed, 2 failed, 1 skipped. Existing `managedServing.listRevokePending` classification failure and existing SQL-composer test timeout. Real Lambda gate skipped, not accepted. |
| `npx vitest run tests/retention/restore-destination.test.ts tests/slo/slo.engine.test.ts tests/billing/billing-unit.test.ts tests/retention/admin-routes.test.ts tests/security/sensitive-inventory.test.ts tests/ci/gate-manifest.test.ts --no-file-parallelism --maxWorkers=2` | 4 files passed, 2 failed; 363 passed, 4 failed, 0 skipped. Retention/SLO engines passed. New-column discovery and additive gate count corrected. Two unchanged gate report-model cases timed out at 20 seconds under shared load. |
| `bash Z:/Projects/Spawned.ai/zenith-wt/.resume/codex/tsc-serial.sh` | Attempt 1 failed: 8 type diagnostics. Attempt 2 failed: 1 JS optional callback diagnostic. Fixed without changing assertions. Final attempt recorded below. |
| `npx eslint --no-warn-ignored $changed` (exact selectors below) | Three runs exited 0, no lint findings. |
| `git -c core.safecrlf=false diff --check` | Initial check exited 0; final check recorded below. |

Latest functional rerun:

`npx vitest run tests/security/sensitive-inventory.test.ts tests/retention/restore-destination.test.ts tests/retention/admin-routes.test.ts tests/ops/recovery-manifest.test.ts tests/ops/recovery-health.test.ts tests/acceptance/mixed-lambda.test.ts tests/acceptance/mixed-lambda.gated.test.ts tests/acceptance/mixed-lambda-package.gated.test.ts tests/acceptance/w5-gaps-ui.gated.test.ts tests/billing/managed-tier.engine.test.ts tests/billing/billing.engine.test.ts tests/resources/function-manifest.test.ts --no-file-parallelism --maxWorkers=2`

Result: **9 files passed, 3 skipped; 128 passed, 0 failed, 3 skipped**. Real Lambda, ZIP CLI and browser gates were skipped, never accepted. The native legacy CLI case is registered only with its explicit PostgreSQL gate and was not run on this PC. Third serialized typecheck exited 0 with zero diagnostics; a final typecheck follows the native CLI join. Second ESLint run exited 0 with no findings; its changed-file selection used both `-c core.safecrlf=false` and `-c core.autocrlf=false`. `node --version` was `v22.23.3`. A read-only `git diff --exit-code -- src/lib/controlplane/db/repos/managed-serving.ts tests/security/controlplane-sql-scoping.test.ts` exited 0, confirming the reported baseline SQL classification source and assertion are unchanged. Final gate/type/lint results follow below. Read-only `git status`, `git log --oneline -10`, `rg` searches and source/document reads were also performed. No Git mutation was attempted.

## Final check results

- Serialized typecheck: attempt 4 exited **0**, zero diagnostics, after the native CLI join. Attempts 1/2 failed with 8/1 diagnostics; attempts 3/4 passed with zero.
- ESLint: all **3** changed-file runs exited **0**, zero findings. Final `git -c core.safecrlf=false diff --check` passed; every invocation of that check exited 0.
- `npx vitest run tests/retention/restore-destination.test.ts --no-file-parallelism --maxWorkers=2`: **1 file passed; 12 passed, 0 failed, 0 skipped** after adding the native backend/CLI gate. The PostgreSQL CLI case was not registered with its gate disabled and was not run.
- `npx vitest run tests/ci/gate-manifest.test.ts --testNamePattern 'declares mTLS prerequisites|retains every branch test|exposes deleted discovery sources|retains every literal hardening requirement' --no-file-parallelism --maxWorkers=2`: **1 file failed; 3 passed, 1 failed, 293 filtered/skipped**. Both changed gate inventory assertions passed; the previous source-deletion case passed. The unchanged incident/ownership source-deletion model still exceeded its unchanged 20-second timeout (23.569 seconds observed). This is a focused selection, not a passed whole-file gate.

Exact lint selectors (initial run, then final two runs):

```powershell
$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH
$changed = @(git -c core.autocrlf=false diff --name-only; git ls-files --others --exclude-standard) | Where-Object { $_ -match '\.(ts|tsx|mjs)$' }
npx eslint --no-warn-ignored $changed
$changed = @(git -c core.safecrlf=false -c core.autocrlf=false diff --name-only; git ls-files --others --exclude-standard) | Where-Object { $_ -match '\.(ts|tsx|mjs)$' }
npx eslint --no-warn-ignored $changed
```

Read-only manifest count check exited 0 (78 contract files, 12 external files, 11 external groups):

```powershell
node --input-type=module -e 'import { EXTERNAL_ACCEPTANCE, WAVE5_CONTRACT_FILES, WAVE5_EXTERNAL_FILES } from "./scripts/ci/gate-manifest.mjs"; console.log(JSON.stringify({contractFiles:WAVE5_CONTRACT_FILES.length,externalFiles:WAVE5_EXTERNAL_FILES.length,externalGroups:EXTERNAL_ACCEPTANCE.length}));'
```

Remaining checks: LocalStack Lambda, actual ZIP CLI, real PostgreSQL CLI, clean-host PostgreSQL/Temporal recovery, kind tier-change readiness, real browser UI, and all live clouds are **not run (need the stated Mac/infrastructure prerequisites; live clouds remain deferred)**. No test deadline, assertion, gate or existing exemption was weakened. The pre-existing SQL scoping classification finding remains for assembler/owner review. A full clean static gate result is not claimed.

Mac static guard rerun (no infrastructure gate needed; preserve existing assertions/timeouts):

```bash
npx vitest run tests/security/controlplane-sql-scoping.test.ts tests/ci/gate-manifest.test.ts --no-file-parallelism --maxWorkers=2
```

## Requirement-driven expectation updates

- Billing outage test now expects 503 refusal instead of admission based on stale active standing; export/destroy assertions remain. This follows the explicit fail-closed requirement.
- Lambda HCL assertions now require `publish=true`, immutable S3 version and actual package hash; SDK fixtures return the required reviewed code hash and exact executed published version. No failure/ownership guard was removed.
- Recovery arithmetic expects incident-to-application-health, with an explicit observed health timestamp, instead of incident-to-database completion. Restore sink expects separate database/application fields and requires restore start; database completion is valid without an incident time, while RTO is not.
- Local container cost/traffic assertions explicitly use the preserved container manifest; the default fixture is now Lambda.
- Provisional pricing's test plan supplies its new managed-tier field. Additive gate inventory counts become 78 contract files (74 plus four) and 12 external files (nine plus three), with 11 explicit external groups (seven plus four). Every prior literal case, release blocker and source-existence check is retained. Inventory tests additionally require the three new audit columns to be discovered.

## Suggested assembler ledger notes

Keep status `in_progress` until the Mac/live acceptance appropriate to each requirement is recorded. Suggested notes:

- MAN-06/MAN-01/02: billing-to-capacity join implemented with PGlite fail-closed and tier-change tests; disabled operator source shown; real kind upgrade/downgrade readiness pending. MAN-07 suspension preserves read/export/destroy and running data; hosted/payment acceptance deferred.
- MIX Lambda: manifest function + digest/source/version binding + authenticated immutable-version invocation implemented; contract tests passed; exact ZIP CLI, LocalStack and live Lambda gates unverified here. Existing container fixture remains explicitly labelled; no three-cloud Lambda proof claimed.
- OPS-01/04: distinct database/application completion samples and authenticated readiness observer implemented; RTO uses observed health only; PGlite/report/observer contracts passed. Real restore + application readiness sequence pending Mac.
- OPS-07/05: explicit privileged `enc:backup` legacy restore implemented with actor/purpose/fingerprint/reason audit and refusal tests; real PostgreSQL operator CLI verification pending Mac.

Deviations: none in assigned migration/dependency/Git/cloud boundaries. Minimal onboarding, settings, SLO UI, gate and inventory joins are included as requested. J14/J6 first-deploy isolation/build custody were not implemented. The unrelated existing SQL scoping classification finding is reported for the owning assembler; no guard was weakened.

Suggested commit: `fix(production): close wave 5 billing lambda and recovery gaps`

## Files changed or added

66 files; exact inventory:

- `docs/build/production/verify/W5-GAPS.md`
- `docs/platform/MANAGED-PLATFORM.md`
- `docs/platform/operations/RESTORE-RUNBOOK.md`
- `fixtures/mixed-app/README.md`
- `fixtures/mixed-app/web/lambda.mjs`
- `fixtures/mixed-app/web/server.mjs`
- `fixtures/mixed-app/zenith.app.container.json`
- `fixtures/mixed-app/zenith.app.json`
- `scripts/acceptance/mixed/bind-lambda.mjs`
- `scripts/acceptance/mixed/cost-report.ts`
- `scripts/acceptance/mixed/localstack-lambda.mjs`
- `scripts/acceptance/mixed/package-lambda.mjs`
- `scripts/ci/gate-manifest.mjs`
- `scripts/ops/recovery.ts`
- `scripts/retention-archive.ts`
- `src/app/(product)/p/[slug]/settings/billing.tsx`
- `src/app/(product)/p/[slug]/settings/page.tsx`
- `src/app/admin/retention/page.tsx`
- `src/app/admin/slo/page.tsx`
- `src/app/api/admin/ops/retention/archives/[id]/restore/route.ts`
- `src/app/api/internal/recovery/readiness/route.ts`
- `src/app/api/platform/v1/billing/route.ts`
- `src/lib/billing/admission.ts`
- `src/lib/billing/plans.ts`
- `src/lib/billing/service.ts`
- `src/lib/controlplane/db/migrations/0057_wave5_gaps.ts`
- `src/lib/controlplane/db/migrations/index.ts`
- `src/lib/ops/errors.ts`
- `src/lib/ops/recovery/health.ts`
- `src/lib/ops/recovery/report.ts`
- `src/lib/ops/recovery/restore.ts`
- `src/lib/platform/zenith-managed.ts`
- `src/lib/platform/zenith-onboarding.ts`
- `src/lib/providers/aws/drivers/compute/lambda-function.ts`
- `src/lib/providers/aws/drivers/compute/types.ts`
- `src/lib/resources/expand.ts`
- `src/lib/resources/manifest-v2.ts`
- `src/lib/resources/specs.ts`
- `src/lib/resources/upgrade.ts`
- `src/lib/retention/key.ts`
- `src/lib/retention/restore.ts`
- `src/lib/sensitivedata/inventory.ts`
- `src/lib/slo/recovery.ts`
- `src/lib/slo/report.ts`
- `src/lib/slo/restore-sink.ts`
- `src/lib/slo/store.ts`
- `tests/acceptance/mixed-lambda-package.gated.test.ts`
- `tests/acceptance/mixed-lambda.gated.test.ts`
- `tests/acceptance/mixed-lambda.test.ts`
- `tests/acceptance/mixed-traffic.test.ts`
- `tests/acceptance/w5-gaps-ui.gated.test.ts`
- `tests/billing/billing-unit.test.ts`
- `tests/billing/billing.engine.test.ts`
- `tests/billing/managed-tier.engine.test.ts`
- `tests/ci/gate-manifest.test.ts`
- `tests/isolation/managed-onboarding-readiness.test.ts`
- `tests/ops/recovery-health.test.ts`
- `tests/ops/recovery-manifest.test.ts`
- `tests/providers/aws/drivers/compute/fixtures.ts`
- `tests/providers/aws/drivers/compute/lambda-ec2.test.ts`
- `tests/resources/function-manifest.test.ts`
- `tests/retention/admin-routes.test.ts`
- `tests/retention/restore-destination.test.ts`
- `tests/security/sensitive-inventory.test.ts`
- `tests/slo/restore-sink.test.ts`
- `tests/slo/slo.engine.test.ts`
