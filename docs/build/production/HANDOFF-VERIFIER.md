# Handoff to the verifying agent (5 October 2026)

You are the verifying agent on the machine that has Docker, PostgreSQL, Temporal, kind, Go, OpenTofu and OPA configured. The building machine has no working Docker, so it only builds; you run every test and gate. This file is your scope contract. [VERIFY-QUEUE.md](VERIFY-QUEUE.md) and `verify/<ID>.md` hold the commands; this file says what you own, what "done" means, and exactly what to hand back.

## 1. Starting point

- Repository `GODOSTROYER/zenith`, branch `codex/production-2026-10-02`.
- Verify the commit that contains this file (the branch tip when you pull). Wave 1 starts at `8031ce0d`, wave 2 at `41f965b1`; both sit on handoff `76a0652`.
- Pull with `git pull --ff-only`. If that fails, stop and report; never reset or force.
- Nothing on this branch since `76a0652` has been executed. Only `tsc --noEmit`, eslint, Go build/vet and the generator `--check` scripts were run.

## 2. In scope: 20 requirements, in this order

| # | Requirement(s) | Runbook | Notes |
|---|---|---|---|
| 0 | Environment | [verify/PROD-CI-REPAIR.md](verify/PROD-CI-REPAIR.md) §3 | Run `transfer/2026-10-05/verify.py`, `npm ci` on Node 22.16+ (<23), then typecheck and lint. |
| 1 | PROD-CI-05, CI-08, CI-09 | [verify/PROD-CI-REPAIR.md](verify/PROD-CI-REPAIR.md) | **Blocks everything else.** Covers native100 (`cleanup-writer-barriers`), platform-postgres (1113 requirements), PG80, workflow58, guest127, worker22, Go race, OPA, kind, and packaged workers on both architectures. |
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
