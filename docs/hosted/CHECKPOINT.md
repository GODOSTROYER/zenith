# Hosted Revision 2 — checkpoint

Date: 2026-09-07. Integrator: Codex. All five delegated audit workers use `gpt-6-astra` with high reasoning.

## Starting point and branch

- Baseline: `4231dda67fb5a0f57c4bd87117fa5af3c4c083de`, containing the completed Zenith application redesign.
- Parent: `8a974387c14f3f400e20f067190d2ec2c614345f`. The report's older reference is not a reset target.
- Working branch: `codex/zenith-hosted-r2`.
- Preparation commit: recorded in this branch's history and the handoff. No push, merge or deployment.
- Existing work, application data, active development server and authentication configuration are preserved.

## Missing normative input

The only supplied attachment is the implementation instruction `pasted-text.txt`. The referenced Revision 2 execution report is missing. No PDF was found in that attachment directory or repository; its path/link was requested from the user. Sections 01–25, P1–P10, A01–A09, D01–D09 and the page-47 addendum have **not** been read or mapped.

The provisional [requirements inventory](requirements.md) extracts 113 instruction groups, with machine-readable data in [requirements.json](requirements.json): 103 not started, eight blocked and two locally verified preparation requirements. Bounded progress is recorded without marking broad hosted requirements fulfilled. Null report mappings mean unknown, not covered. The [decision record](DECISIONS.md) separates current evidence, local corrections and unresolved security/provider contracts.

## Current wave

| Work | Owner | State |
| --- | --- | --- |
| Actual-checkout and control-state audit | Control audit worker | Complete; Navigator correction implemented and independently reviewed |
| App identity/session and sharing audit | Identity audit worker | Complete; provisional inventory validated |
| Cloudflare topology, bindings, egress and quota research | Runtime audit worker | Complete; offline/opt-in GET-only binding inspection harness implemented and independently reviewed; no live proof |
| Isolated build/artifact/release and E2B research | Build audit worker | Complete; no submitted-code execution |
| Fresh isolated baseline and CI | Independent verification worker | Complete; mandatory checks, safe Docker context, pinned actions and workflow validator implemented/reviewed |
| Disposable SQLite feasibility | Integrator; independent verification worker | Eight primitive checks pass on Node 24.19.0 / SQLite 3.53.3 and Node 22.23.2 / SQLite 3.51.3 |
| Shared authority/API/provider contracts | Integrator | Pending report and contract reconciliation |

Exact write assignments are in [OWNERSHIP.md](OWNERSHIP.md). No hosted product adapter, authority migration, app grant/session system, trusted broker or customer build has been integrated. No live provider, external email, customer-data operation or destructive restore was attempted.

## Fresh baseline evidence

Evidence directory: `Z:/Projects/Spawned.ai/orrery/.data-hosted-baseline-20260907/evidence/`. This is ignored local evidence, not a deployable artifact. `BASELINE.md` records commands, environment and log names.

Conditions: Windows, Node 24.19.0, npm 11.6.0; existing installed dependencies; isolated archived checkout and separate test data. CI/Docker use Node 22, which this local run does not certify.

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm test` in original source tree with isolated test data | Passed: 114 files, 1,080 tests |
| `npm run smoke` in isolated checkout | Passed: Sandbox happy path, intentional failure and rollback |
| `npm run gimbal:verify` | Passed |
| `npm run build` in isolated checkout | Passed: Next 15.5.24 production build |
| Docker | Blocked: client exists, daemon pipe unavailable; no image build/run |
| Hosted live/provider/browser journey | Not implemented or run |

The first archive-only test run had one CRLF fixture mismatch caused by Git archive's line-ending conversion. The original HEAD/worktree fixture matched; its targeted test and the full original-source suite passed. The failed run and resolution are retained, with no weakened assertion or normalized fixture used to hide it. Provider/email tests use doubles; smoke is simulated. A build success is not hosted release proof.

## Implemented corrections and final verification

**Navigator:** `src/lib/navigator/server-actions.ts` binds create/execute/cancel to the selected workspace and exact project/run IDs. Configured-auth signed-out callers are refused; local demo behavior remains. Planning rechecks after asynchronous model work; execution checks current membership and required role before each new step, and withholds the returned run from a caller removed during execution. The already-admitted step may finish. Existing claim-driven membership bootstrap remains unchanged and is still a hosted migration concern.

The final regression tests on archived baseline `4231dda` produced **25 failures / 27 passes**; the candidate passes all **52** cases. Broader Navigator, role and membership tests passed **227/227**. Evidence: `navigator-baseline-result.json` in the evidence directory; source tests in `tests/navigator/server-actions.test.ts` and `tests/navigator/executor.test.ts`. Authentication/model/provider calls were mocked. A separate Astra reviewer found no concrete surviving bypass or regression within this patch's scope.

**CI:** `.github/workflows/ci.yml` now fails on verification, Next build and Docker build failures, includes Gimbal verification, restricts token permissions, disables retained checkout credentials and pins reviewed action commits. `.dockerignore` excludes all `.data-*`, service metadata and root/nested environment files. Actionlint 1.7.12 is checksum-pinned and mandatory. Running the full validator uncovered the pre-existing invalid job-level `runner.temp` reference; it now uses `github.workspace/.data-ci`. The original fails validation and the final workflow passes. Eight CI policy tests pass. GitHub branch protection and an actual GitHub Actions run were not inspected/executed.

**Feasibility tools:** `scripts/hosted-spike/cloudflare-preflight.ts` defaults to offline validation; its explicit live mode can only issue eight fixed-origin metadata GETs. Eighty-four synthetic adversarial tests pass. No live credentials or Cloudflare calls were used. `sqlite-feasibility.ts` runs real file-backed primitive checks in a fresh temporary directory and removes only its known scratch files. It verifies WAL/FULL settings, foreign keys, transaction rollback/visibility, busy writers, fresh revocation reads, online backup and reopen. It is not the application authority, a migration or a crash/power-loss/recovery drill. Both tools were independently reviewed; a connection-cleanup edge case in the SQLite probe was corrected before final verification.

Final commands from the repository root, with logs under the evidence directory:

| Check | Actual result | Log |
| --- | --- | --- |
| `node node_modules/vitest/vitest.mjs run` | **118 files, 1,211 tests passed** | `final-test.log` |
| `node node_modules/typescript/bin/tsc --noEmit --incremental false` | Passed | `final-typecheck.log` |
| `npm run lint` | Passed | `final-lint.log` |
| Pinned actionlint against `.github/workflows/ci.yml` | Passed; original workflow failed as expected | `CI-HARDENING.md` names exact command/logs |
| `npm run build` in isolated snapshot with final source overlays | Passed; `/` remains static | `final-build.log`, `final-snapshot-overlays.txt` |
| SQLite probe under portable Node 22.23.2 | Eight checks passed, scratch removed | `sqlite-feasibility-node22.json`, `sqlite-node22-verification.json` |
| SQLite probe under installed Node 24.19.0 | Eight checks passed, scratch removed | `sqlite-feasibility.json`, `SQLITE-REVIEW.md` |

The final build reused the baseline snapshot, copied final changed source/config/tests explicitly, set `ORRERY_DATA` to its isolated `.data-final-build`, and kept the developer's `.next` untouched. Its parent-lockfile tracing warning is the same isolation characteristic recorded at baseline, not Docker verification. Baseline smoke/Gimbal checks remain applicable; those scripts/assets were unchanged. Full tests use doubles for provider/email behavior. No hosted browser acceptance journey was run.

The portable Node 22 ZIP and actionlint binaries were downloaded only into ignored scratch space and checked against their official release SHA-256 checksums before extraction. No dependency/lockfile, global runtime, PATH or production configuration changed. Current Docker read-only verification still fails because the Docker Desktop Linux engine pipe is unavailable.

## Using and undoing this preparation branch

No hosted database migration or application configuration change is required for these corrections. The two standalone probe commands and explicit read-only operator prerequisites are in [the probe README](../../scripts/hosted-spike/README.md). Neither tool is imported by the product. The new token variable is CLI-only and unnecessary for offline checks.

This branch is for review, not a hosted deployment. There is no new production deployment to roll back and no data to restore. Keep this feature branch to preserve the work; any later code rollback must be reviewed because reverting the Navigator correction reintroduces its admission gaps. Do not reset/clean the checkout or restore application data to undo source-only changes. Hosted configuration, deployment, activation and recovery procedures remain unimplemented pending the contract/provider work below.

## Next implementation wave after the report arrives

1. Read every report page, table and diagram; resolve instruction/report conflicts and complete the P1–P10/A01–A09/D01–D09 requirement mapping.
2. Agree the shared hosted contract, error/event vocabulary, source/reference-app fixture, dependency DAG, authority migration boundary and exact ownership. Resolve runtime/driver, domains, artifact/backup providers and strict storage-quota semantics with evidence.
3. Extend the preliminary metadata/SQLite probes into the complete bounded feasibility harness. Without approved credentials, keep live gates blocked and implement executable local contracts/adapters without a production fake-success fallback.
4. Integrate the running publish → invite → durable write → concurrent edit → revoke slice, then recovery/limits/adversarial evidence. Migrate permission readers and writers together.

Do not run submitted install/build code on the developer/control/CI management host. Do not provision billable infrastructure, change DNS, send real invitations or restore in place without the required authorization. These restrictions do not block ordinary reversible repository changes.

## Release gates

**Local existing application and preparation corrections:** verified under the conditions above. The hosted authority/runtime/core journey is not implemented.

**Supervised real-data hosted pilot: no-go. Commercial hosted rollout: no-go.** The requested integrated private application journey and recovery/security evidence remain incomplete. Independent-agent review is not external security assessment; customer/payment/return targets remain unverified business facts.
