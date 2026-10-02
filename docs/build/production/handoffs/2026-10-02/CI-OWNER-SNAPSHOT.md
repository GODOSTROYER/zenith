# CI correction checkpoint

Worktree: `/Users/saivedanthava/.codex/zenith-production/worktrees/integrated-ci`
Branch/base: `ws/prod-integrated-ci`, `633d1e1`.
State: three source corrections prepared and frozen; no tests, compiler, services, commits or publication performed by this owner. All other work is paused at the user's request.

Remote run 36975762619 exposed four failures: missing packaged-acceptance documentation, two codec fixture exits, and one health fixture exit. Private verify log confirmed health line 64 expected exit 0 and received 1. Both startup mocks omitted the production `closeExecutionStore` export.

Owned paths and SHA-256:

- `docs/platform/operations/DEPLOYING.md`: `d5cb21f915f691376c305993e018d3ea102917cb2721b719087db81072936ee6`
- `tests/workflows/codec-wiring.test.ts`: `bfd48309b8fe887827ab2207666b47be9177c11538c461bcbdff7899520f2abc`
- `tests/workers/worker-health-wiring.test.ts`: `6e53f21e749e53576ddfc6e24ff49b7e6ae03e1e7ad1ba658a9546bd585a5e07`

Three-path freeze: `59839cc484f847d2c086625f2ae63d472018c1b24489223a410f9301a1f6d856`, SHA-256 of sorted path + NUL + hex content SHA-256 + newline records.

Fixtures now faithfully close the owned store and assert cleanup ordering on success and failure. Existing readiness, TLS, codec, exit and secret-sanitization assertions remain. The guide documents the explicit acceptance derivative and acceptance-only switch; production excludes the fixture client. No checker, production source, skips or timeouts changed.

Root verification remains: include the newly corrected health fixture alongside operator docs, codec wiring, worker and packaged-worker suites; complete full TypeScript/lint and required actual OpenTofu/Go checks; independently review, integrate and verify CI. These source corrections are not runtime acceptance.

The only separately authorized canonical change was documentation clarification: `docs/platform/operations/OBSERVATION-REPAIR.md` SHA-256 `0b8a8d6288c27a50dac3c1ff6a0e6c750b2c5711bf6e5bd9295469d41d7fdd32`. It admits native handler or the pure bounded AWS ECS recipe while retaining the unmerged adapter/remediation release blocker. Canonical executable source remains frozen for root integration.

No additional owner work or outside-path implementation is queued. Stop after this checkpoint; root finishes only the two authorized near-complete items.
