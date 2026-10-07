## Incoming builder CI stop, 7 October 2026

Merged newer builder source `c02c097e79de032e9414c104183961329e834c77`, preserving62 incoming commits and source80 verifier history. Current builder CI: **14 jobs passed /6 failed**; prior80bb7352 green result remains historical. CI08/09 reopened; ledger **10 verified /49 in progress /19 planned**, recomputed across78 rows. All criteria and four false release flags retained. [Every current job, counts and causes](verification/CI-2026-10-07-c02c097e.md), [stop and next work](verification/RESULTS-2026-10.md#incoming-builder-ci-stop-2026-10-07).

Default Mac acceptance also remains resource-blocked. Docker4GiB/swap4GiB settings retained, idle backend stopped, disk23.1GiB. Schema now41 with23 SQL files, six saved worker/package/schema bindings changed; old21-file migration wrapper and source80 standalone build cannot verify current bytes. OBS02 endpoint wiring now exists; actual default acceptance remains open. No builder-owned code or published migration edited. New checkpoint CI is pending until exact pushed SHA is inspected.

Earlier entries retain their exact historical source scope.

## Mac bootstrap and disk-floor checkpoint, 7 October 2026

Source `80bb7352765ba83655a191b9b34d7e10827475ec`: all20 CI jobs inspected terminal success. Unit19,622 passed /0 failed /1,532 skipped; lane counts overlap. Actual reduced-profile five-service Supabase startup passed twice; two verified HTTPS health probes passed. Fresh native standalone build passed in194.7s. Both stacks subsequently crossed continuous22GiB disk floor and were stopped/cleaned. Zero full default acceptance cases; no requirement promotion.

Docker now4GiB memory/4GiB swap, VirtioFS, Resource Saver off; full4GiB stack untested. Five owned Supabase images and owned network removed; baseline resources preserved. Current disk23.1GiB, cached images absent; additional pull/startup/swap headroom required before heavy work. Ledger **12 verified /38 in progress /28 planned**, recomputed across78 rows; all four release flags false. [Exact bootstrap and remaining gates](verification/RESULTS-2026-10.md#mac-bootstrap-and-storage-2026-10-07), [20 CI jobs](verification/CI-2026-10-07-80bb7352.md), [safe resume](verification/RESUME-REDUCED-RESOURCE-2026-10-07.md).

Earlier entries retain historical scope.

## Latest reduced-resource verifier handoff, 7 October 2026

Docker6GiB/swap4GiB applied on this Mac; owned resources cleaned. Six serial leaf lanes and actual PostgreSQL/Temporal/OpenTofu/reader/Go supplements passed within their scopes; default Supabase startup crossed22GiB floor before tests. Current heavy work resource-blocked; no default acceptance promotion. Fresh pulledc9 dependency audit/install/compiler/lint/ledger passed, CI20/20 inspected. Local730 source, c9 checks and publication-source CI remain separate. Ledger12 verified/38 in progress/28 planned; all78 criteria/four false release states unchanged. Latest human identity Arnav Bule author+committer. [Exact safe continuation](verification/RESUME-REDUCED-RESOURCE-2026-10-07.md), [counts/failures/skips](verification/RESULTS-2026-10.md#reduced-resource-verification-7-october-2026), [c9 jobs](verification/CI-2026-10-07-c9a942d6.md).

Earlier entries preserve historical scope and permissions.

## Coherent verifier result, 7 October 2026

Tested published `d6965d75eb9522527c7a91b06cf8f490f6531d20`: all20 CI jobs completed successfully, with no fresh job-status anomaly. Unit **19,622 passed / 0 failed / 1,532 skipped**. Real PostgreSQL **3,034/0/8**, all1,124 required; workflows **1,275/0/0**, all62; PG **379/0/0**, all93. Native packaged AMD64 and ARM64 each **22/0/0**, no emulation, all cleanup flags. Complete dependency audit zero known findings, no exception. [Fresh job/skip report](verification/CI-2026-10-07-d6965d75.md). Counts overlap and are not summed.

Fresh root transport rerun on that same source: DNS/socket/TLS **27/0/0**, portability regressions **45/0/0**, MySQL **15/0/0**. Contract, protocol-fixture and real-engine scopes are distinct; these are not87 engine or cloud acceptances. Both parent exits0; independent report/case/source/cleanup review accepted. Four setup failures remain recorded, each0 tests, all recovered; corrections only addressed Docker profile representation, mount ordering and exact Docker Desktop binary mapping. No product assertion/gate/TLS weakening. [Transport evidence](evidence/PROD-LIFE-11/2026-10-07-coherent-transports-d6965d75.json).

Ledger **12 verified / 38 in progress / 28 planned**, all78 criteria and four false release flags retained. MySQL DNS-hostname TLS remains explicitly unsupported; wider adoption/backup/decommission, installed-agent update/rollback and default operated journey remain incomplete. Default API/server startup, live cloud/DNS/private GitHub App and retention/business/sign-off decisions remain blocked. Maintenance draft NOT_READY, never run. This evidence-only publication retains the tested source SHA; inspect its successor CI independently. Author/committer Arnav Bule; normal same-branch push after pull --no-rebase. [Results and next steps](verification/RESULTS-2026-10.md#coherent-verifier-source-2026-10-07).

Earlier entries retain their original scope.

## Verifier continuation, 7 October 2026

Published repair baseline `f582e1934a42283d316cf7c4fc65673cf948eccd` finished all three CI runs successfully: main16 job success conclusions, native workers2 and native platform2. Unit **19,609 passed / 0 failed / 1,532 skipped**. AMD64 and ARM64 each executed **22 native controls / 0 failed / 0 skipped**, with all six cleanup flags. One GitHub ledger-job status field remains inconsistent with its success conclusion/completion timestamp and terminal parent run; retained literally. [Every job and skip accounting](verification/CI-2026-10-07-f582e193.md).

Root fresh local gates on that source: workflows **1,275/0/0** (62 required), PostgreSQL **379/0/0** (93 required), corrected platform **3,034/0/8** (1,124 required, including native100), kind provider **6/0/0**, release **1/0/0**, guest **48/0/0**. All owned cleanup confirmed. Prior fixture failures remain recorded; no assertion or gate weakened. Counts overlap and are not summed.

Integrated test commits `b685ed83` and `d3e710d29957a35ad19eeb5c7192723af6f4c6ec` add default build-egress and generated-key publisher-trust controls. Root combined **88/0/0**, compiler/lint passed. These test additions and this documentation checkpoint still need their fresh exact-source CI. A private TLS fixture successor is undergoing source review/binding before a fresh coherent native transport rerun; old50 transport receipts are not relabeled.

CI07/08/09 close on the inspected f582 source: **12 verified / 38 in progress / 28 planned**, all78 requirements and four false release flags preserved. LIFE12/MACH04 broader acceptance remains open; no new security defect was reproduced by that evidence review. Default API/server startup, live clouds/DNS/private GitHub App and retention/business/sign-off decisions remain blocked. Identity: author and committer **Arnav Bule <arnav.bule05@gmail.com>**, per latest human instruction. Normal same-branch pushes only, preceded by `git pull --no-rebase`. See [results and precise next work](verification/RESULTS-2026-10.md#verifier-repair-checkpoint-2026-10-07).

Earlier entries below are historical and retain their original source scope.

## Security stop, 6 October 2026

Verifier stopped under HANDOFF-VERIFIER §7 after independently confirming current LIFE11 destination-custody defect: DNS addresses are checked, then PostgreSQL/MySQL/S3 transports independently resolve original hostname. Required repair spans actual transports, TLS hostname identity and reconnect/retry behavior; existing preflight tests cannot prove containment. No exploit or secret disclosure was executed or claimed. Report-only checkpoint follows group1–2 publication `adb6fb42`; no product fix or requirement promotion. Ledger **9 verified / 41 in progress / 28 planned**, all78 criteria and four false release flags preserved.

Executed before stop: fresh install/compiler/lint/migrations passed; canonical workflows **1275/0/0**, required62; focused runbook/telemetry contracts **113/0/0**; ownership controls **65/0/0**. Counts overlap and are not summed. Plugin233 result remains an independently reviewed local candidate, not root-integrated evidence. Default maintenance drafts were never run. Owned PG container/network/volume removed; unrelated resources preserved; disk26GiB free. [Finding and stop record](verification/RESULTS-2026-10.md#security-stop-prod-life-11-2026-10-06); [precise handoff](verification/VERIFIER-SECURITY-STOP-2026-10-06.md).

Current dependency blocker: sharp0.35.4 / GHSA-wq5f-xc86-pv6w; group1–2 supply-chain job failed with1 finding. CI07/08/09 reopened; no upgrade or exception applied. Primary advisory lists patched0.35.5, within current Next declared range; disposition/provenance/runtime checks remain open. [Dependency receipt](evidence/PROD-CI-07/2026-10-06-sharp-advisory-adb6fb42.json).

Earlier notes retain their original source scope.

## Verifier continuation, group 1–2, 6 October 2026

Tested `ec18bb9c8973787ab16123040d00d7be1407eb08`: fresh installation, compiler, lint and fresh product/platform/agent migrations passed. Full canonical workflows62: **1,275 passed / 0 failed / 0 skipped**, all62 mandatory identities executed. Fresh runbook/telemetry contracts: **113 passed / 0 failed / 0 skipped** across6 files. Counts overlap with other evidence and are not summed. Default maintenance worker effects/health/fallback proof remains in progress; registered runbook delivery and complete default scoped telemetry remain blocked or incomplete. Ledger: **12 verified / 38 in progress / 28 planned**, all78 requirements preserved, all four release flags false.

New author and committer: **Arnav Bule <arnav.bule05@gmail.com>**, per latest human instruction. Existing Saivedant commits remain unchanged. Before every push: `git pull --no-rebase`, merge newer building-machine work, never force. Wave3 source/harnesses remain building-machine owned. Disk free25GiB before next workload; preserve18GiB packaged-worker minimum. Default product API/server startup and external acceptance are not authorized by worker permission. [Group evidence and prerequisites](verification/RESULTS-2026-10.md#verifier-group-1-2-2026-10-06).

Earlier checkpoint notes below are historical, with their original source scope.

## Integrated test checkpoint, 6 October 2026

6 October human instruction authorizes only the current source-map-js patch and bounded licensed OPA formatter precision security repair for GHSA-68fv-2mgg-jv7q and GHSA-hp3w-g68c-fv3c. This overrides the earlier dependency-upgrade exclusion for these findings only. General upgrades, force updates, gate weakening, fake identities and self-approved exceptions remain unauthorized; broader product/feature/live work remains outside verifier scope.

Earlier checkpoint notes below retain their original source scope.

## Current checkpoint, 6 October 2026

Publishedc5f4bd53 is terminal: main15 success/1 supply-chain failure and native2 success; unit19484/0/1519, actual guest152/systemd15/both cleanups passed. Current ledger9 verified/41 in progress/28 planned; CI07/08/09 remain reopened for three dependency findings. No lock upgrade or security exception is applied. Local integrated7c86ad44 has focused scheduling10/0/0, JOIN8 and reader15, but complete workflows62 and fresh whole-candidate CI remain pending. Follow the fixed20 order below and the current [queue](VERIFY-QUEUE.md); older notes are history. All78 criteria and four false release flags are retained.

# Handoff to the verifying agent (5 October 2026)

You are the verifying agent on the machine that has Docker, PostgreSQL, Temporal, kind, Go, OpenTofu and OPA configured. The building machine has no working Docker, so it only builds; you run every test and gate. This file is your scope contract. [VERIFY-QUEUE.md](VERIFY-QUEUE.md) and `verify/<ID>.md` hold the commands; this file says what you own, what "done" means, and exactly what to hand back.

## 1. Starting point

- Repository `GODOSTROYER/zenith`, branch `codex/production-2026-10-02`.
- Verify the commit that contains this file (the branch tip when you pull). Wave 1 starts at `8031ce0d`, wave 2 at `41f965b1`; both sit on handoff `76a0652`.
- Pull with `git pull --ff-only`. If that fails, stop and report; never reset or force.
- Historical building-machine handoff had no runtime execution since `76a0652`. Current verifier execution and remaining gaps are recorded in [RESULTS-2026-10.md](verification/RESULTS-2026-10.md); preserve their exact source scope.

## 2. In scope: 20 requirements, in this order

| # | Requirement(s) | Runbook | Notes |
|---|---|---|---|
| 0 | Environment | [verify/PROD-CI-REPAIR.md](verify/PROD-CI-REPAIR.md) §3 | Run `transfer/2026-10-05/verify.py`, `npm ci` on supported Node 22.22.2+ (<23); verifier pins22.23.3/npm10.9.9, then typecheck and lint. |
| 1 | PROD-CI-05, CI-08, CI-09 | [verify/PROD-CI-REPAIR.md](verify/PROD-CI-REPAIR.md) | **Blocks everything else.** Covers native100 (`cleanup-writer-barriers`), platform-postgres (1124 requirements), PG80, workflow60, guest152, worker22, Go race, OPA, kind, and packaged workers on both architectures. |
| 2 | PROD-MACH-01 | [verify/PROD-MACH-01.md](verify/PROD-MACH-01.md) | Wave 1 |
| 3 | PROD-MACH-03 | [verify/PROD-MACH-03.md](verify/PROD-MACH-03.md) | Wave 1 |
| 4 | PROD-OBS-02 | [verify/PROD-OBS-02.md](verify/PROD-OBS-02.md) | Wave 1 |
| 5 | PROD-OBS-03 | [verify/PROD-OBS-03.md](verify/PROD-OBS-03.md) | Wave 1 |
| 6 | PROD-LIFE-02 | [verify/PROD-LIFE-02.md](verify/PROD-LIFE-02.md) | Wave 1 |
| 7 | PROD-LIFE-12 | [verify/PROD-LIFE-12.md](verify/PROD-LIFE-12.md) | Wave 1 |
| 8 | PROD-COST-03 | [verify/PROD-COST-03.md](verify/PROD-COST-03.md) | Wave 1 |
| 9 | Wave 2 join tests | VERIFY-QUEUE.md, "Wave 2 assembly gap" | **Write these tests first**, then run them with wave 2. |
| 10 | PROD-OBS-04 | [verify/PROD-OBS-04.md](verify/PROD-OBS-04.md) | Wave 2 |
| 11 | PROD-LIFE-01 | [verify/PROD-LIFE-01.md](verify/PROD-LIFE-01.md) | Wave 2 |
| 12 | PROD-LIFE-08 | [verify/PROD-LIFE-08.md](verify/PROD-LIFE-08.md) | Wave 2 |
| 13 | PROD-LIFE-09 | [verify/PROD-LIFE-09.md](verify/PROD-LIFE-09.md) | Wave 2 |
| 14 | PROD-LIFE-10 | [verify/PROD-LIFE-10.md](verify/PROD-LIFE-10.md) | Wave 2 |
| 15 | PROD-LIFE-11 | [verify/PROD-LIFE-11.md](verify/PROD-LIFE-11.md) | Wave 2 |
| 16 | PROD-MACH-04 | [verify/PROD-MACH-04.md](verify/PROD-MACH-04.md) | Wave 2 |
| 17 | PROD-MACH-05 | [verify/PROD-MACH-05.md](verify/PROD-MACH-05.md) | Wave 2 |
| 18 | PROD-UX-01 | [verify/PROD-UX-01.md](verify/PROD-UX-01.md) | Wave 2 |
| 19 | PROD-UX-03 | [verify/PROD-UX-03.md](verify/PROD-UX-03.md) | Wave 2 |
| 20 | Final | push, then CI | Push and inspect **every** job of the CI and Native packaged workers runs on the exact pushed SHA. |

Each runbook has an acceptance mapping, commands, environment variables, expected results and known risks. VERIFY-QUEUE.md lists the risks found across all of them.

## 3. Out of scope

Do not do any of these; report them as needed instead.

- Building new features or any other requirement. The building machine owns wave 3: OBS-01, all DUR-*, MACH-02/06, LIFE-03..07, PKG-04/05, UX-02, COST-01/02, and the MIX/MAN/OPS/REL work.
- Live cloud accounts, budgets, regions, the GitHub `live-sandbox` environment, commercial or retention decisions, production sign-off.
- Release states: `implementationComplete`, `sandboxVerified`, `pilotReady` and `productionApproved` all stay `false`.
- Refactors, dependency upgrades, or format-only churn.

## 4. What you may change

- **Allowed:** any source, test, gate or doc change needed to make an in-scope requirement genuinely pass. Keep fixes minimal and at the narrowest responsible layer.
- **Allowed:** writing missing tests, including the wave-2 join tests.
- **Allowed:** fixing wrong test expectations. Each one must be justified against the requirement's acceptance text and the verify doc; never just to go green.
- **Forbidden:** weakening, skipping or deleting assertions, gates, zero-test or skip checks, strict exit codes or acceptance counts. Lowering the required native100 identities (exactly 100) is forbidden too.
- **Forbidden:** editing published migrations. That covers `supabase/migrations/0001`–`0020` and the platform migration files 1–27 once their snapshot is published. A schema fix ships as a **new** platform migration (28+) plus a new `0021_platform_core.sql` snapshot via `npx tsx scripts/platform/emit-sql.ts`, with the inventories updated the same way the wave-2 assembly commit did it.
- **Forbidden:** force-push, history rewrite, secret-scanning bypass, committing credentials or raw logs that contain secrets, global Docker prune, or touching containers you did not create.

Verifier identity override, explicitly confirmed by the user on 5 October 2026: author and committer both `Saivedant Hava <saivedant169@gmail.com>`, committing from the user's Mac. This overrides the imported Arnav Bule instruction. Preserve historical commits. No `Co-Authored-By` trailer, no em dashes in commit messages.

## 5. Definition of done per requirement

A requirement moves to `state: "verified"` in `ledger.json` only when **every** level in its `requiredEvidence` is met, on one coherent commit, with results inspected (not inferred). Otherwise:

| Outcome | `state` | `implementationStatus` |
|---|---|---|
| All required evidence met | `verified` | `verified_<shortsha>` |
| Contract and local levels pass, but a level needs live or operational resources | `in_progress` | `local_verified_<levels>_pending_<missing levels>` |
| Failures you fixed, but not yet re-run green | `in_progress` | `fixes_committed_rerun_pending` |
| Failures you could not fix | `in_progress` | `verification_failed_<short reason>` |
| Not attempted | unchanged | unchanged |

Pending, failed and skipped results are never reported as passed. Counts from overlapping lanes are never summed.

## 6. What you must give back

Everything goes back by normal push to `codex/production-2026-10-02`. The building machine fetches and merges it.

1. **Commits.** One or more fix commits per requirement, with messages prefixed by the requirement ID, e.g. `PROD-OBS-03: fix stability lease ordering`.
2. **`ledger.json` evidence.** For each requirement you ran, append one object per evidence level to its `evidence` array, in the existing schema. Fields: `level` (one of the ledger's `evidenceLevels`), `commit` (full SHA tested), `result` (exact counts, e.g. `"100 passed / 0 failed / 0 skipped"`), `command`, `environment` (Node, Go, PG, Temporal, tofu, OPA, kind and Docker versions, plus native or emulated arch), `logs` (repo-relative path under `docs/build/production/evidence/`, or `"not retained"`), and `runId` and `url` for `remote_ci`. Update `state` and `implementationStatus` per §5. Then run `node scripts/build/production-ledger.mjs --check`; it must pass.
3. **`docs/build/production/verification/RESULTS-2026-10.md`** (new file), with one section per requirement:
   - the commit tested, and each command with its pass/fail/skip counts;
   - what failed, the root cause, and the fix commit SHA;
   - remaining gaps, and anything you believe is wrong in the implementation but did not fix, with `file:line`.
4. **Sanitized evidence** under `docs/build/production/evidence/<ID>/`: vitest JSON reports, `go test -json` summaries and gate reports. Strip secrets, tokens, connection strings and absolute home paths. Raw logs that cannot be sanitized stay local and are listed as "not retained".
5. **VERIFY-QUEUE.md "Results" section.** One line per requirement: ID, status, tested SHA, RESULTS anchor.
6. **CI report.** For the final pushed SHA: run IDs and every job's conclusion, with failures explained in RESULTS. Native AMD64 and emulated runs are reported separately. Pending is not passed.
7. **Blockers for the building machine.** List in RESULTS anything that needs a design change, new code outside your minimal-fix remit, a decision from the user, or a live resource, so it can be scheduled into wave 3.
8. **`PROGRESS.md`.** Add a dated entry at the top with ledger counts recomputed from `ledger.json`.

## 7. Stop and report (do not push past these)

- `git pull --ff-only` fails, or the transfer `verify.py` fails.
- A fix would need a forbidden change from §4.
- A failure looks like a security or tenancy defect (cross-tenant read or write, approval forgery, credential leak to a model-visible path, privileged fallback). Fix it if it is narrow; otherwise stop, describe it in RESULTS and push only that report.
- The host lacks resources for a gate. The packaged worker gate needs at least 18 GiB free; do not waive it. Report it rather than run partially and call it passed.

## 8. Order of pushes

Push after step 1 (CI repair) is done, whatever the result, so the building machine sees the base status early. After that, push at least after wave 1 and after wave 2, and keep each push coherent: ledger, RESULTS and evidence must match the commit pushed.
