# Default approved source runtime gate, 2026-10-04

This delta makes the accepted default owning source runtime persistence scenario mandatory in the canonical `platform-postgres` lane. It adds the runtime test file to the execution command, sets `ZENITH_TEST_APPROVED_SOURCE_RUNTIME_REQUIRED=1`, and declares the exact PostgreSQL suite and case independently of source discovery.

The required suite is `default approved source runtime owning persistence [postgres]`. Its required case is `default single-pool owning runtime captures, retains and verifies the same immutable row across an independent pool`.

Required admission refuses a missing normalized `ZENITH_TEST_PLATFORM_PG_URL` and a registered platform schema older than 13 before local model hooks or either PostgreSQL pool can open. The existing PostgreSQL setup still checks canonical schema13 and opens two independent pools with `max: 1`. All 12 original and 14 direct-constructor model cases and the complete existing persistence scenario remain unchanged. Source HTTP is modeled in that persistence scenario. This gate does not establish live GitHub, browser, provider or cloud acceptance.

The gate keeps all 60 previous approved-source named cases, their ordered names and five group checksums. It adds one literal runtime case and its own one-case checksum, producing 61 source requirements. The existing report refusal matrices now cover the runtime case as well as the previous groups: missing file or case, failed, skipped, pending, todo, PGlite or a different modeled suite, deleted source, malformed or duplicate evidence and inconsistent counts. The source-deletion scratch fixtures now create the three directories required by canonical PostgreSQL discovery before deleting the focal file. Every previous test name and assertion is retained.

The owned paths are:

- `scripts/ci/gate-manifest.mjs`
- `tests/ci/gate-manifest.test.ts`
- `tests/platform/approved-source-runtime.test.ts`
- `docs/build/handoffs/DEFAULT-SOURCE-RUNTIME-GATE-20261004.md`

The patch is an exact four-path delta against the root-prepared dependency tree at base commit `5f0d874616b05376f5eb89b93a0a50f4013fb444`. The three existing owned files were saved and hashed before editing. All 42 other prepared source paths must remain byte-identical to the preparation receipt. The real index, branch and commit remain unchanged.

Read-only prerequisites are the independently source-accepted approved-source revision2 packet, schema13 registry and gate revision1 packet, and default source runtime revision2 packet. Their preparation receipt is `/Users/saivedanthava/.codex/zenith-production/logs/runtime-gate-completion-prepared-20261004.json`. They remain prerequisites rather than committed or runtime-accepted work. The unchanged `node_modules` symlink supplies locked dependencies and provides no fresh-install evidence.

Frozen evidence is saved under `/Users/saivedanthava/.codex/zenith-production/logs/runtime-gate-completion-20261004/revision1`. `BASELINE.json` records the before hashes and base hashes; `FROZEN-SOURCE.json` records final owned hashes, the exact private-index prepared and candidate trees, patch hash, read-only integrity, manifest and verification status. `VERIFICATION-COMMANDS.json` records bounded checks without connection values or secrets.

Only source and static integrity work is authorized for this packet now. Targeted tests require the root's explicit shared slot permission. No compiler, lint, installation, Docker, database, server, whole-suite, Temporal, OpenTofu, provider or cloud acceptance has run for this delta. No commit is created. Static contract evidence and synthetic reports cannot close production requirements.

Root follow-ups are independent source review; permitted targeted gate and model tests; missing-PostgreSQL admission refusal; actual two-pool PostgreSQL persistence; strict canonical lane evidence bound to current source, environment and execution; canonical migration, emitted SQL and role checks; compiler and lint; and the separate Temporal replay, original-byte OpenTofu, browser, current-package, live GitHub, cloud and cleanup acceptance. `PROD-CI-05`, `PROD-CI-08`, `PROD-DUR-03`, `PROD-LIFE-08` and `PROD-PKG-02` remain open until their required runtime and integration evidence passes. Nothing outside these four owned paths is changed by this delta.
