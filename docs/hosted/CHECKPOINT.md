# Hosted — checkpoint log

Newest revision first. Nothing below is deleted when a revision supersedes it;
superseded statements are marked historical in place.

## Revision 3 — 2026-09-07 (Claude integrator)

### Outcome (integrator, end of the Revision 3 build, source `08e5bfa` + this commit)

Every workstream W0–W11 landed on `zenith/hosted-r3`. Final verification on
Windows 11 / Node 24.19.0 / SQLite 3.53.3:

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | 0 errors |
| `npx eslint .` | clean |
| `npx vitest run` (whole suite) | **205 files, 2,153 tests passed** (baseline 119 / 1,216) |
| `npx vitest run tests/hosted` | 77 files, 930 tests passed |
| `npx vitest run tests/hosted/acceptance tests/ci` | 13 files, 124 tests passed — all twelve gates, no `DEFECT` markers |
| `npx tsx scripts/hosted-acceptance.ts` | PASS, 22 checks |
| `npx tsx scripts/hosted-browser.ts` | 24/24 steps in Chrome 152 (desktop + 375 px) |
| `npm run smoke`, `npm run gimbal:verify` | pass |
| `npx next build` (Turbopack, dev server stopped) | pass; one cosmetic warning (`createRequire` runtime argument in `src/lib/hosted/build/recipe.ts`) |
| GitHub Actions run [34135885031](https://github.com/GODOSTROYER/zenith/actions/runs/34135885031) at `bbd1487` | **verify, build, docker and the new `hosted` job all passed** on ubuntu-latest / Node 22, including the real-Chrome gate 12. The first run (`0448322`) failed on two non-hermetic tests and a Docker type-check; fixed in `bbd1487`. |

Register rows by outcome (details in `ACCEPTANCE-R3.md`, `PLAN-R3.md` §1):

- **Closed with executable evidence on the local runtime:** G01, G03, G04, G05,
  G07, G08, G09, G10, G11 (delivery to SMTP-acceptance only), G12, G13
  (against an injected identity authority), G14, G15 (CSP/CSRF/credential
  stripping; egress is `not_enforced` locally and says so), G16, G17, G18,
  G19, G20 (estimates), G21, G22 (filesystem target; S3 with a client double),
  G23, G24, G28, G29, G30, G31, G32 (local twelve-gate suite), G42, G43, G44.
- **Real code path, gated on an input this machine does not have:** G02
  (Cloudflare runtime: `ZENITH_CF_*`), G06 (E2B / Docker runners: `E2B_API_KEY`
  or a daemon), G25 (scoped provider tokens), G27 (S3 target live), G33 (a host
  with a persistent volume; runbook written), G34 (provider decision record
  written, accounts not chosen).
- **Founder / commercial, templates only:** G26, G35, G36, G37, G38, G39, G40,
  G41, G45 — every value `unknown`, nothing fabricated.

Two operational notes. (1) `next build` shares `.next` with `next dev` in this
Next version; building while the dev server runs breaks the dev server — stop
it first (the runbook says so). (2) The development server on :3400 was
restarted by the integrator after that mistake; it must be started again with
`npm run dev` after this session ends.

**Gates unchanged:** supervised real-data hosted pilot — **no-go** until a
live runtime, an isolated build service, off-host recovery storage and an
identity-provider round trip have been exercised on a real host; commercial
rollout — **no-go**. The local journey is proven; the hosted one is ready to
be proven.

Baseline: `ffb2753` (the Gimbal full-quality commit). Working branch:
`zenith/hosted-r3`. Plan: [PLAN-R3.md](PLAN-R3.md). Shared contracts:
[CONTRACTS-R3.md](CONTRACTS-R3.md). Normative input: the 45-row gap register
and the full gap analysis of 2026-09-07.

### Normative input — the Revision 2 blocker is resolved, with one caveat

The "[Missing normative input](#missing-normative-input)" section further down
is **historical**. The Codex session of 2026-09-07 received the 47-page YC W27
execution plan, SHA-256
`00f43faa7c7fccfcf1caf29d8bb5fc4859b1be61020e2d46d9686c5d347c8159`, read all
47 pages and produced the gap analysis and the 45-row register that Revision 3
works from.

The caveat is exact and matters for every page number in this repository: **the
Claude session that wrote the Revision 3 documents did not receive that PDF.**
The file attached to it was an unrelated handwritten answer booklet, SHA-256
`aad69f82…`. So every page mapping in [PLAN-R3.md](PLAN-R3.md),
[requirements.md](requirements.md) and [requirements.json](requirements.json)
is **inherited from the gap analysis, not re-read**. A page reference is a
pointer into that analysis, not an independent citation. `ATT-BASE-02` stays
`blocked` for that reason.

### Fresh baseline recorded in this session

Recorded by the integrator on this machine at `ffb2753`, before the Revision 3
workstreams began. Windows, Node 24.19.0.

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| Full vitest run | Passed: **119 files, 1,216 tests** |
| `node:sqlite` under Next 15.5 turbopack dev | Loads; `DatabaseSync` usable in the dev server process (SQLite 3.53.3 on Node 24.19.0) |
| Build toolchain pinned in `package.json` | `vite@7.3.6`, `@vitejs/plugin-react@5.1.4`, `e2b@2.46.1` |

Two limits on that table. The vitest and typecheck numbers are the
integrator's; W11 re-ran only `tests/importers` (2 files, 14 tests, passing
before and after its wording change) and re-read the pinned versions directly
from `package.json`. And a `node:sqlite` load under the dev server is a
feasibility observation, not the authority: no application state has been
migrated, and the crash, busy-writer and reopen contract in
[CONTRACTS-R3.md](CONTRACTS-R3.md) is W1's to prove.

CI and Docker still declare Node 22; this local Node 24 run does not certify
them. The Revision 2 evidence directory
`.data-hosted-baseline-20260907/evidence/` remains the record for the earlier
baseline and is not superseded by these numbers.

### Revision 3 workstreams

Assignment and exclusive paths are [PLAN-R3.md](PLAN-R3.md) §2; this table is
the status view. **In progress** means the workstream is running against those
paths in this wave — it is not a claim that any requirement is implemented,
and no `requirements.json` status was changed by it.

| WS | Agent | Wave | Status |
| --- | --- | --- | --- |
| W0 | integrator (plan, contracts, env/boot/middleware wiring, `package.json`) | 0 | In progress |
| W1 | authority (`src/lib/hosted/authority/**`) | 1 | In progress |
| W2 | build (`source/**`, `build/**`, `artifacts/**`, `fixtures/hosted/**`) | 1 | In progress |
| W3 | broker (`src/lib/hosted/data/**`) | 1 | In progress |
| W4 | tracker-app (`fixtures/tracker-app/**`) | 1 | In progress |
| W11 | docs (this file, DECISIONS, requirements, runbook/providers/threat model/lifecycle/operator access, `evidence/**`, importer wording) | 1 | In progress |
| W5 | access (`src/lib/hosted/access/**`, grants/invites/launch/session routes) | 2 | In progress |
| W6 | gateway (`gateway/**`, `runtime/**`, `src/app/hosted-gateway/**`, `workers/**`) | 2 | In progress |
| W7 | release (`release/**`, hosted actions, publish/rollback/suspend routes) | 2 | In progress |
| W8 | ops (`backup/export/quota/usage/events/health`, `scripts/hosted/**`) | 2 | In progress |
| W9 | ux (`src/app/(product)/apps/**`, `src/components/apps/**`) | 2 | In progress |
| W10 | verify (`tests/hosted/acceptance/**`, `scripts/hosted-acceptance.ts`, CI job) | 3 | In progress |

Dependency order: W0 → {W1, W2, W3, W4, W11} → {W5, W6, W7, W8, W9} → W10 →
integration. At the time this section was written the repository contained
`src/lib/hosted/config.ts` and `src/lib/hosted/contracts/**` only; every other
hosted module is being written concurrently and is not evidence until it lands
with its tests.

### What remains blocked after this wave

Copied from [PLAN-R3.md](PLAN-R3.md) §4, unchanged:

- Live Cloudflare/D1 execution.
- E2B or Docker isolated builds.
- External email delivery.
- A real control host with a persistent volume.
- Off-host S3 outside LocalStack.
- Customer discovery, activation, payment.
- Independent security assessment, legal commitments and the YC packet.

Each has a real code path or a filled-in template whose only missing input is
named in [PROVIDERS.md](PROVIDERS.md) and [evidence/](evidence/).

### Revision 3 documentation produced by W11

| File | Purpose | Register rows |
| --- | --- | --- |
| [RUNBOOK-DEPLOY.md](RUNBOOK-DEPLOY.md) | Target topology, env, reverse proxy, fail-closed behaviour, backup/restore outline | G33 |
| [PROVIDERS.md](PROVIDERS.md) | Capability → variables → verified/unverified → approval → cost decision record | G34 |
| [THREAT-MODEL.md](THREAT-MODEL.md) | Threat family → control → proving test → residual risk | page-47 families, G15, G25, G26, G35 |
| [DATA-LIFECYCLE.md](DATA-LIFECYCLE.md) | Provider/region/exposure map, retention, deletion, export, subprocessors | G27, G36 |
| [OPERATOR-ACCESS.md](OPERATOR-ACCESS.md) | MFA, least privilege, scoped credentials, support logging, compromise drill | G26 |
| [evidence/](evidence/) | Nine unfilled templates: discovery, activation, payment, capacity, YC claims, release governance, security review, privacy, acceptance record | G35–G41, G45, G32 |

Every value in those documents that is not verifiable from this repository is
written `unknown` or `not verified`. Provider costs carry an "unverified"
label unless the gap analysis cites a dated official source.

### Release gates, Revision 3

Unchanged from Revision 2 and restated so no reader has to infer it:
**supervised real-data hosted pilot: no-go. Commercial hosted rollout: no-go.**
Zero of the twelve integrated hosted acceptance gates have been demonstrated.
Documentation, contracts and plans are not capabilities.

---

## Revision 2 — 2026-09-07 (Codex integrator; preserved below)

Date: 2026-09-07. Integrator: Codex. All five delegated audit workers use `gpt-6-astra` with high reasoning.

## Starting point and branch

- Baseline: `4231dda67fb5a0f57c4bd87117fa5af3c4c083de`, containing the completed Zenith application redesign.
- Parent: `8a974387c14f3f400e20f067190d2ec2c614345f`. The report's older reference is not a reset target.
- Working branch: `codex/zenith-hosted-r2`.
- Preparation commit: recorded in this branch's history and the handoff. No push, merge or deployment.
- Existing work, application data, active development server and authentication configuration are preserved.

## Missing normative input

> **Historical (superseded 2026-09-07, Revision 3).** The report was supplied to
> the Codex session that produced the gap analysis; see "Normative input" at the
> top of this file for what was and was not read, and by whom. The paragraph
> below is kept as written at the time.

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
