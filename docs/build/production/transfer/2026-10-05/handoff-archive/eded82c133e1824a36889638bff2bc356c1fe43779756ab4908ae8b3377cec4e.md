# WS-COMPOSE implementation handoff — 2026-10-01

All changes are in the working tree on `ws/compose`, based on `e5c1518`.
No commits, dependency installation, package changes, LocalStack changes, or live cloud calls were made.
Evidence from this workstream is **contract**, with real composition, stores, policy/approval/grant handling,
native SDK-backed reads, and Temporal workers; AWS responses and OpenTofu are mocked in the deployment tests.

## Files added

| File | Purpose |
| --- | --- |
| `src/lib/platform/credentials.ts` | Platform AWS broker, runner transport and credential-event sink; scoped GCP/Azure OIDC sessions and in-memory Kubernetes vault resolution. |
| `src/lib/platform/drivers.ts` | Idempotent registration of all provider groups, with only the dedicated Zenith provider registered as `zenith`. |
| `src/lib/platform/broker.ts` | Execution adapter for current policy evaluation, immutable reviewed-plan binding, current human approvals, and scoped, fenced grants. |
| `src/lib/platform/driver-lookup.ts` | Resolve AWS published references through the compiler's existing locals to compile the complete service/database/TLS graph. |
| `src/lib/platform/release.ts` | Native CodeBuild build/recovery, ECS image and steady-state helpers, and scoped one-off migration tasks. |
| `src/lib/platform/reconcile.ts` | Authorized observation and repair proposal/startDayTwo ports. |
| `src/lib/platform/scopes.ts` | Resolve platform repair resource IDs through the owning product workspace/project/environment chain. |
| `src/lib/platform/execution.ts` | Compose real execution ports; mandatory HKDF fingerprint key; register validated environments for reconciliation; compose reconcileObserve. |
| `src/lib/platform/app.ts` | Guarded, once-per-process app wiring and transactional runner/machine reaping with owning operations marked uncertain. |
| `workers/execution/startup.ts` | Fail-fast validation of explicit Temporal/store configuration, secret/signing keys and current DB schema, with sanitized diagnostics. |
| `tests/platform/aws-cloud.ts` | SDK mocks for the complete AWS graph; unhandled calls reject. |
| `tests/platform/deploy-e2e.test.ts` | Three Temporal deployment scenarios plus six direct composition/store/security cases. |
| `tests/platform/composition.test.ts` | Eleven registration, key derivation, startup, app guard and provider-session cases. |
| `tests/platform/release.test.ts` | Eight build, pinned-image, migration and steady-state cases. |
| `tests/platform/WS-COMPOSE-HANDOFF.md` | This review and verification record. |

## Files changed

| File | Change |
| --- | --- |
| `src/lib/workflows/activities/index.ts` | Production factory delegates to composition; old stubs survive only in the explicit test factory. |
| `workers/execution/worker.ts` | Open/validate the platform store, compose activities and app ports, supply activity heartbeat/cancellation, and fail clearly before polling. |
| `src/lib/server/boot.ts` | Invoke guarded app composition once. |
| `.github/workflows/tick.yml` | Add the existing reconcile route to tick passes. |
| `src/lib/server/cron.ts` | Minimal requested reaper hook in cron/local slow passes and guarded platform boot helper. Unconfigured hosts skip platform imports. |
| `src/app/api/internal/tick/reconcile/route.ts` | One authenticated boot call via its already allowed cron import boundary; this route bypasses legacy boot. |
| `src/lib/runners/service.ts` | Narrow the reaper/event helper's required runtime type to store/events; behavior unchanged, reaping does not require a signer/sealer. |
| `tests/workflows/config.test.ts` | Change only the stub-factory import for existing isolated worker tests. |
| `tests/workflows/sandbox.test.ts` | Change only the stub-factory import for existing isolated worker tests. |

The last four rows other than cron are the small additive changes outside the listed owned paths.
Cron was explicitly requested by the handoff. No existing test assertions were weakened.

## Contracts and implementation choices

- Cloud credentials, workload tokens and Kubernetes vault values stay inside session callbacks. Events,
  workflow history and grant metadata contain identifiers and decisions, never credential material.
- Browser-session human approval remains mandatory. Model approval is rejected. The worker rechecks
  current approver roles, proposal binding, expiry and separation of duties before issuing grants.
- A concrete plan requiring approval must match the immutable reviewed proposal. A changed/unreviewed
  plan requires a new proposal and human approval; the adapter never silently updates approval binding.
- The fingerprint key is HKDF-SHA256 over the 32-byte `ZENITH_SECRET_KEY`, with empty salt and info
  `zenith.tofu.plan.fingerprint.v1`. The public default is never used, even with injected fake OpenTofu.
- AWS registers the three existing group arrays directly; no AWS aggregate driver file was created.
  Zenith uses `src/lib/providers/zenith`, not the alternate Kubernetes managed-driver registry.
- The merged compiler's recursive primary-resource resolver cannot handle the complete AWS secondary
  references/cycles. The composition lookup emits the existing canonical local references instead;
  the full web/postgres/TLS graph and definitions are checked by the direct deployment test.
- The base has no exported one-off migration task helper. The composition adapter uses the native ECS
  locate/task helpers plus scoped RunTask/DescribeTasks, owned task/network/tag checks, a stable client
  token and observed container exit codes. Missing/timeout results stay unknown.
- Pinned manifest images are applied by OpenTofu. The subsequent deploy-image step accepts only the
  same digest and performs no duplicate ECS mutation. Built workloads use the native deployment helper.
- Validated platform environments are registered for the reconcile scheduler. Repair resource IDs
  resolve through both platform ownership and the product scope chain.
- Reaping expires jobs, marks running owning operations uncertain, and appends events in one transaction.
  Expired/uncertain jobs are never redispatched by composition.

## Verification

The final full suite has three environment-blocked process-termination failures; all composition
regressions found in the first full run were fixed. Logs named in the tables are under
`C:\Users\user\AppData\Local\Temp` and are local diagnostic artifacts, not committed files.
Counts are tests, unless a row explicitly says files/diagnostics. A dash is zero/not applicable.

### Current checks

| Command | Passed | Failed | Skipped | Detail |
| --- | ---: | ---: | ---: | --- |
| `npx tsc --noEmit` | 1 check | 0 | — | Whole repo; zero diagnostics. |
| `npx eslint src/lib/platform workers/execution src/lib/workflows/activities src/lib/server tests/platform` | 1 check | 0 | — | Zero errors and warnings. |
| `npx eslint src/app/api/internal/tick/reconcile/route.ts src/lib/runners/service.ts tests/workflows/config.test.ts tests/workflows/sandbox.test.ts` | 1 check | 0 | — | Also check every additive edit outside the owned paths; zero errors and warnings. |
| `ZENITH_COMPOSE_TEMPORAL_MODE=time-skipping; npx vitest run tests/platform tests/workflows tests/execution tests/capabilities --maxWorkers=4` | 787 | 0 | 87 | 33 files passed, one skipped; `zenith-compose-focused-serial.log`. |
| `ZENITH_COMPOSE_TEMPORAL_MODE=time-skipping; npx vitest run tests/platform/deploy-e2e.test.ts` | 9 | 0 | 0 | All three actual Temporal scenarios ran; `zenith-compose-temporal.log`. |
| `npx vitest run tests/reconcile/boundary.test.ts tests/engine/postgres-scheduler.test.ts tests/api/internal-tick.test.ts tests/tofu/process.test.ts --maxWorkers=2` | 32 | 3 | 0 | Actual matching files: boundary, scheduler, process. `internal-tick.test.ts` does not exist; the correct cron file was separately run below. `zenith-compose-regressions.log`. |
| `npx vitest run tests/api/internal-cron.test.ts` | 27 | 0 | 0 | Correct cron route/auth suite; `zenith-compose-cron.log`. |
| `ZENITH_COMPOSE_TEMPORAL_MODE=time-skipping; npx vitest run --maxWorkers=4` | 10727 | 3 | 336 | Final run: `zenith-compose-full-final.log`; 547 files passed, one failed, fourteen skipped (562 total). All 28 platform tests passed. Only the three sandbox-blocked Windows process-termination tests failed. |
| `git diff --check` | 1 check | 0 | — | No whitespace errors. |

### Earlier verification attempts (including failures)

These attempts preceded fixture corrections, startup tests and release tests. Counts therefore differ
from the final suites. No failing assertion was removed to obtain a pass.

| Command / attempt | Passed | Failed | Skipped | Log / disposition |
| --- | ---: | ---: | ---: | --- |
| `npx vitest run tests/platform/deploy-e2e.test.ts` (first) | 0 | 3 | 0 | `zenith-compose-e2e.log` |
| Same (second) | 0 | 3 | 0 | `zenith-compose-e2e-2.log` |
| Same (third) | 0 | 0 | 3 | `zenith-compose-e2e-3.log`; default local CLI unavailable. |
| Same (fourth) | 2 | 1 | 3 | `zenith-compose-e2e-4.log` |
| Same, `ZENITH_TEST_TEMPORAL_CLI` set to installed WinGet binary | 2 | 1 | 3 | `zenith-compose-e2e-5.log`; binary ACL prevents execution. |
| Same (sixth) | 2 | 1 | 3 | `zenith-compose-e2e-6.log`; mock graph inputs corrected. |
| `npx vitest run tests/platform/deploy-e2e.test.ts -t 'runs the complete deploy activity chain'` (first) | 0 | 1 | 5 | `zenith-compose-diagnosis.log` |
| Same (second) | 0 | 1 | 5 | `zenith-compose-diagnosis-2.log` |
| Same (third) | 0 | 1 | 5 | `zenith-compose-chain.log`; safe prober transport was then explicitly mocked to avoid network. |
| `npx vitest run tests/platform/deploy-e2e.test.ts` (seventh) | 3 | 0 | 3 | `zenith-compose-e2e-7.log` |
| `npx vitest run tests/platform` (first) | 12 | 1 | 3 | `zenith-compose-platform.log`; GCP STS fixture assertions corrected to JSON camelCase. |
| `npx vitest run tests/platform/composition.test.ts` | 9 | 1 | 0 | `zenith-compose-composition-2.log`; same fixture correction. |
| `npx vitest run tests/platform` (second) | 16 | 0 | 3 | `zenith-compose-platform-2.log` |
| `npx vitest run tests/platform/release.test.ts` (first) | 7 | 1 | 0 | `zenith-compose-release.log`; added the missing ListTasks mock response. |
| Same (second) | 8 | 0 | 0 | `zenith-compose-release-2.log` |
| `npx vitest run tests/platform tests/workflows tests/execution tests/capabilities` (first) | 776 | 0 | 90 | `zenith-compose-focused.log` |
| Same, `ZENITH_COMPOSE_TEMPORAL_MODE=time-skipping` (while full suite also running) | 786 | 1 | 87 | `zenith-compose-focused-final.log`; existing 60ms lease-renewal timing assertion observed two renewals instead of three under load. Reduced-concurrency rerun above passed unchanged. |
| `ZENITH_COMPOSE_TEMPORAL_MODE=time-skipping; npx vitest run --maxWorkers=4` (first) | 10724 | 6 | 336 | `zenith-compose-full.log`: three composition regressions subsequently fixed, plus the three Windows process failures below. 545 files passed, three failed, fourteen skipped. |

Earlier `npx tsc --noEmit` attempts reported respectively 3, 14 and 3 diagnostics while composition
and test fixtures were being implemented; these were corrected and subsequent whole-repo runs had
zero diagnostics. The first eslint invocation failed because `tests/platform` did not yet exist;
subsequent invocations had zero errors/warnings. `git diff --check` passed.

## Environment limits and remaining integration prerequisites

- The installed WinGet Temporal CLI exists but its executable cannot be read/executed in this sandbox.
  Network downloads are denied. The new tests retain the requested installed-local-CLI path by default
  and gate downloads behind `ZENITH_TEST_TEMPORAL_DOWNLOAD=1`. For this run,
  `ZENITH_COMPOSE_TEMPORAL_MODE=time-skipping` explicitly selected the existing cached Temporal SDK
  test-server executable. This runs actual Temporal workers/history on a random port, never 7233;
  it is the deviation needed to execute all three end-to-end scenarios here.
- Three existing `tests/tofu/process.test.ts` tests time out: timeout handling, process-tree termination,
  and AbortSignal cancellation. A diagnostic spawning an owned Node child confirmed that Windows
  `taskkill /pid <owned-child-pid> /T /F` exits 1 with `Access denied`. This sandbox forbids the
  termination operation. No process-engine implementation/test or timeout was changed to hide this.
- Live-cloud, external Postgres, Docker/kind and other environment-gated integration suites remain
  skipped. This work makes no live evidence claim. AWS SDK calls and HTTP health/TLS responses in the
  contract deployment test are mocked; the OpenTofu port is fake.
- Non-AWS connection identity verification is not implemented by the existing shared broker interface;
  composition returns an explicit unsuccessful verification rather than marking a connection verified.
  Existing verified GCP/Azure/Kubernetes connections can obtain scoped sessions. OCI is explicitly
  refused as runner-only because no OCI ProviderSession transport exists at this base.
- The merged execution engine currently supports the AWS S3 backend. Registered non-AWS drivers and
  sessions do not imply a tested non-AWS deployment workflow; unsupported paths still refuse clearly.
- Git-source acquisition has no existing SourceBundlePort implementation at this base. Composition
  permits explicit `ports.sourceBundle` injection; the default worker supports pinned-image manifests
  and refuses unconfigured source acquisition. No unauthenticated fetch or invented source is used.
- Orchestrator still needs to review, commit and integrate these working-tree changes. This sandbox
  cannot write `.git` and no such operation was attempted.
