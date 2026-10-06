# Skipped-case closure, 6 October 2026

Current scope: tests and narrow fixes. Production features and all 78 acceptance criteria remain unchanged.

## Exact coverage

1,517 of 1,527 unique local baseline identities passed in successful processes. Original Linux CI baseline had 1,521 skips; local Darwin inventory adds six Linux file-guard cases. Counts below overlap; never sum them. This is a deduplicated union of actual runs, not one monolithic run.

[Exhaustive per-file counts and hashed case identities](../evidence/PROD-CI-08/2026-10-06-skip-closure.json) retain all 1,527 identities, report hashes, source hashes and failure history. Raw logs, expanded runtime case names and credentials stay private.

| Actual lane | Passed | Failed | Skipped | Evidence scope |
|---|---:|---:|---:|---|
| PostgreSQL | 379 | 0 | 0 | Actual PostgreSQL 16.15; 93 required identities |
| Fresh platform PostgreSQL | 3,034 | 0 | 8 | 1,124 strict requirements; 98 suites |
| PostgreSQL portability | 71 | 0 | 0 | Actual export/import and vault rewrap |
| OpenTofu | 3,934 | 0 | 0 | Real OpenTofu 1.12.5, including 18 database cases |
| Policy | 242 | 0 | 0 | Real OPA 1.19.1 |
| Temporal workflows | 1,275 | 0 | 0 | Stable source; 62 strict requirements |
| Workflow intents | 156 | 0 | 0 | 141 strict requirements |
| Reconciliation | 38 | 0 | 0 | Actual worker composition, fresh database |
| HTTP database/storage | 66 | 0 | 1 | Actual PostgREST and Storage; FileStore exclusion below |
| MySQL portability | 8 | 0 | 0 | Native ARM64 MySQL 8.4.11; export only |
| S3 portability | 11 | 0 | 0 | Genuine MinIO; production adapter export/import/readback |
| Temporal mTLS | 2 | 0 | 0 | Strict local trust, namespace and rejection controls |
| Extra opt-ins | 206 | 0 | 6 | Six Darwin exclusions executed separately on Linux |
| Linux FileRead guards | 6 | 0 | 0 | Native ARM64, fresh locked install, GNU tools |
| kind provider / release / guest | 6 / 1 / 48 | 0 | 0 | Local cluster; supplemental cleanup receipt below |
| Optional Go OpenTofu | 2 | 0 | 0 | Native Darwin ARM64, real OpenTofu |
| Native Windows ACL | 1 | 0 | 0 | Genuine hosted Windows x64; positive login and inherited-access refusals |
| Optional Go systemd | 1 | 0 | 0 | Genuine Linux AMD64 CI, real systemd/journal |

Most runtime tests use frozen source `1fb30b8d58d59b45a18f250a317f85344459b955`. Earlier PostgreSQL and portability evidence binds `743b953141d2250bda99ecde67cfa4fef586bf5e`; individual unchanged source hashes are retained. Changed Windows ACL source binds `27542b2b` and its actual native execution. Source inventory and strict receipts establish scope; newer commits are never inferred green from ancestry alone.

## Remaining ten identities

Native Windows passed on `27542b2bb9ab401fb3233980755c6458119fc0cf`, run [37440573585](https://github.com/GODOSTROYER/zenith/actions/runs/37440573585): one original leaf passed, zero failed, zero executed skips; 15 filtered siblings excluded. Genuine Windows x64 checks cover successful private login/load, both original inherited Everyone ReadAndExecute fixture proofs, production unsafe-config refusal and login exit 2. Native cleanup complete. Node 22.23.3; exact Windows build and PowerShell version were not exported. [Sanitized native acceptance receipt](../evidence/PROD-CI-08/2026-10-06-native-windows-27542b2b.json). Strict artifact SHA-256 `dbbfac6d8f4bc2c8a32e77e81d223026db5581a4bb9a9366d34629321f85c116`.

- **Private GitHub App: one unavailable.** Genuine authorized App installation, private repository binding, pinned revision and secure key-file configuration are absent from checked handoffs. Public archives, personal tokens and mocks cannot substitute. Configure through secure local files; never put secrets in chat.
- **Backend-inapplicable: nine.** Eight memory/PGlite late-effect scenarios require SQL immutability or genuine blocked writers; one FileStore audit case requires PostgreSQL deduplication. Nine originals map to seven distinct actual PostgreSQL counterparts, all passed in successful processes. Original variants retain skips; no fake passes or skip waiver.

## Preserved failures and fixture corrections

Windows predecessors failed at original 3-second fixture proof or bounded 15-second prerequisite. Latest failed stage run `37438718637` on `0fc3fe9f` reached entry but not first Get-Acl completion; all three checked environment keys were present. Production refusal was not reached. Independently reviewed direct .NET Framework ACL API correction preserves exact owner SID checks, all explicit/inherited foreign-Allow refusal, owner-only writes and unchanged deadlines. Fresh native pass verifies correction; specific cmdlet discovery/autoload cause remains unmeasured. All predecessor failures remain retained.


Initial platform run: 2,979 passed / 6 failed / 57 skipped. Missing canonical agent schema blocked membership/OAuth cases. Agent migrations corrected fixture; a reused-database rerun then produced 3,032 / 2 / 8 because fixed IDs survived the first attempt. Fresh owned database plus canonical platform and agent migrations produced 3,034 / 0 / 8. Both failures remain archived.

Portability initially produced 69 / 2 / 0 against a plaintext disposable PostgreSQL endpoint. Explicit fixture URL transport configuration produced 71 / 0 / 0; production TLS defaults unchanged. Initial HTTP proxy was unavailable during testing, producing 11 / 5 / 14; fixture lifetime correction produced 66 / 0 / 1.

Initial workflow process passed 1,275 tests but failed source binding after checkout changed during execution. Stable detached checkout rerun passed all 1,275 and 62 strict identities; first receipt remains invalid for promotion.

mTLS initializer failed before tests because copied host-owned files were chmodded before CHOWN-only ownership transfer. Ownership-first initialization passed both genuine SDK transports without extra capabilities or disabled trust. Linux source transfer initially failed against read-only rootfs; verified archive streaming through owned writable volume passed six actual cases. Original failures and separate positive cleanup settlement receipts remain.

kind test bodies passed 6 / 1 / 48, but original helper exited 1 after root removed an owned image captured in its baseline. Original image restored; separate supplemental receipt proved resource absence, original image restoration and kubeconfig cleanup. Original helper failure remains; test-body successes and eventual cleanup are distinct facts.

MySQL proves export and table coverage, not restore/readback. Local kind and mTLS do not establish cloud, managed CNI or external tenant acceptance.

## Cleanup and next step

All positively identified disposable containers, volumes, networks and images were removed after actual absence checks. Unrelated Optuna image and baseline resources preserved; no global prune. Disk free reached 27 GiB after cleanup.

All 1,517 runnable baseline identities passed through real supported fixtures. Nine inapplicable original variants and one private-App prerequisite remain explicit. Observe every job on final pushed checkpoint before reporting CI green; source `27542b2b` native skipped-platform and both native packaged-worker jobs passed, while full main CI was still running when this report was prepared. Private App access remains required; backend-inapplicable originals remain explicit. Four production release flags stay false.

## Builder handoff

Implementation changes in this continuation are limited to native platform verification and Windows ACL checks. Full production program remains open; this checkpoint does not authorize live clouds, default server startup, retention changes or production promotion.

1. Fetch `codex/production-2026-10-02`; preserve newer commits and local work. Check ancestry of runtime `27542b2bb9ab401fb3233980755c6458119fc0cf` rather than resetting.
2. Inspect all three workflow families on exact fetched SHA: main CI (16 jobs), native packaged workers (2), native skipped platforms (2). Pending/cancelled jobs are not passed. Fetch strict sanitized artifacts; retain source and cleanup bindings.
3. Private App prerequisite: configure existing authorized private repository/installation through secure local configuration. Required names: `ZENITH_TEST_SOURCE_GITHUB_APP`, `ZENITH_TEST_SOURCE_REF` (40-character approved revision), `ZENITH_TEST_SOURCE_GITHUB_BINDING`, `ZENITH_GITHUB_APP_ID`, `ZENITH_GITHUB_APP_PRIVATE_KEY_FILE`. Keep key and token values out of chat/logs. Execute original `tests/sources/github-live.test.ts`; no public-source/PAT/mock substitute.
4. Retain nine backend exclusions; PostgreSQL equivalents already executed. Do not force impossible memory/PGlite/FileStore guarantees or turn variants into fabricated passes.
5. Continue existing `HANDOFF-VERIFIER.md` and production requirements for product work only when requested. All 78 acceptance criteria and four false release flags are preserved. Detailed earlier source-bound failures remain historical evidence, not reopened defects after verified successors.

Owned Docker fixtures are gone. Full tests require rebuilding those fixtures, not relying on hidden warmed services. Reuse exact strict gates and tool versions above; check available memory/disk before rebuilding. Private raw logs are not automatically available on another machine; committed sanitized coverage and native receipts retain source/artifact hashes and all baseline case identities.
