# Production-hardening implementation status

This document is the integration record for the draft hardening PR. It is not
a claim that Zenith is production-ready in every backend.

## Implemented in this branch

| Change | Commit | Evidence |
|---|---|---|
| Reject malformed or non-finite agent integration grant expiries | `f42d2e4923d28385cb8b2b060b19365afea58ed6` (cherry-picked as `50b37f5`) | 15 OAuth tests, typecheck, targeted lint pass |
| Record the architecture gate, topology, migration rules, work graph, and deployment matrix | `d8cf2af93e895312914f3de47131e15af6b2a3fb` | Reviewed against current source and Sol gate output |

The initial blanket mixed-store guard was implemented experimentally and then
reverted after independent review showed it would reject the repository's
documented `ZENITH_STORE=postgres` plus `ZENITH_HOSTED_STORE=sqlite` mode. The
current branch intentionally preserves the existing independent selectors.

## Verification

- `npx vitest run tests/hosted/config.test.ts tests/agent-control-oauth.test.ts --no-file-parallelism`: 23/23 passed on the final branch (15 OAuth, 8 hosted-config; the hosted config suite is unchanged after reverting the compatibility regression).
- `npm run typecheck`: passed.
- Targeted ESLint over changed files: passed.
- `git diff --check`: passed.
- Baseline before integration: application typecheck passed; companion plugin
  `npm run verify` passed with 130 tests passed and 2 skipped.

## Not implemented / release blockers

- Alert webhook SSRF protection and secret-reference migration: reproduced,
  but no complete tested slice was produced. Existing alert tests passed
  28/28; this is not evidence of SSRF safety.
- Publisher-authenticated plugin provenance: not implemented. Existing hashes
  are not signatures and no trusted verifier was available in the worker
  environment. No plugin PR is opened for an empty branch.
- E2B frozen dependency/egress policy: not implemented. Existing isolated E2B
  tests passed 16; live provider behavior remains unverified.
- UI routing/accessibility/polling changes: not implemented. Browser service
  and the current jsdom setup blocked a verified change.
- `sync-rest` async replacement: not implemented. The current blocking bridge
  remains and must not be described as production-safe for high-concurrency
  hosted request paths.
- PostgreSQL agent-control writes remain explicitly refused by
  `docs/AGENT-CONTROL.md`.

## Release envelope

The branch is suitable only as a **draft** application PR for review of the
one narrow fix and the architecture record. It does not authorize production
cutover, destructive migration, secret rotation, package publishing, or
enabling PostgreSQL agent-control writes. Preserving independent selectors
does not prove cross-authority atomicity or that either backend is durable
under every hosted failure.

## Rollback

Revert the implementation commit and the documentation commits as a
normal Git revert, or merge only the individual fix commit required by the
release owner. No database migration or production data transformation is
introduced by this branch.
