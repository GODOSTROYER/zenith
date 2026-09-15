# Production-hardening implementation status

This document is the integration record for the draft hardening PR. It is not
a claim that Zenith is production-ready in every backend.

## Implemented in this branch

| Change | Commit | Evidence |
|---|---|---|
| Reject malformed or non-finite agent integration grant expiries | `f42d2e4923d28385cb8b2b060b19365afea58ed6` (cherry-picked as `50b37f5`) | 15 OAuth tests, typecheck, targeted lint pass |
| Record the architecture gate, topology, migration rules, work graph, and deployment matrix | `d8cf2af93e895312914f3de47131e15af6b2a3fb` | Reviewed against current source and Sol gate output |
| Fence agent-operation finalization against operation expiry and the durable OAuth grant snapshot | `2d2786c` (integrated as `6bc2e21`) | Agent-control coordinator/journal tests and typecheck pass; application-authority race remains partial |
| Store alert signing keys and credential-bearing HTTP targets as encrypted secret references | `9274b0f` plus follow-up working-tree changes | Alert delivery, outbox, bootstrap-redaction, and workspace-isolation tests pass; legacy plaintext delivery fails closed |
| Add HTTPS/private-address/redirect/response-size validation and asynchronous audit/event repository paths | `9274b0f`, `fa67fa9` | Targeted alert and hosted-storage tests pass; actual webhook connection binding and secret backend async path remain open |

The initial blanket mixed-store guard was implemented experimentally and then
reverted after independent review showed it would reject the repository's
documented `ZENITH_STORE=postgres` plus `ZENITH_HOSTED_STORE=sqlite` mode. The
current branch intentionally preserves the existing independent selectors.

## Verification

- Focused hardening suite (serial, no file parallelism): **137/137 passed** across alert delivery/outbox/redaction/isolation, agent-control coordinator/journal/OAuth, and async-repository suites.
- `npm run typecheck`: passed.
- Targeted ESLint over changed files: passed.
- `git diff --check`: passed.
- `npm run build`: passed; Next emitted the existing `module.createRequire failed parsing argument` warnings for hosted build recipe imports.
- `npm run test:contract`: 36 executed, 15 skipped.
- Companion plugin `npm run verify`: 141 tests passed, 2 platform skips; plugin/backend contract check passed.

## Partial / release blockers

- Alert webhook SSRF protection: **partial**. The input policy rejects non-HTTPS,
  loopback/private/link-local/reserved destinations, redirects are disabled,
  response bodies are bounded, and new/legacy channel credentials use secret
  references. The delivery path still validates DNS and then calls fetch on the
  original hostname, so DNS rebinding/TOCTOU is not closed. This remains a high
  severity release blocker. Legacy plaintext rows require `ZENITH_SECRET_KEY`
  for migration and are not deliverable while the key is unavailable.
- Publisher-authenticated plugin provenance: **partial**. The companion plugin
  now has an external Ed25519 envelope, trust allowlist, artifact binding, and
  fail-closed verification tests. The consuming installer/marketplace execution
  boundary has not yet been wired to require verification, so unsigned or
  untrusted releases are not yet blocked in production.
- E2B frozen dependency/egress policy: not implemented. Existing isolated E2B
  tests passed 16; live provider behavior remains unverified.
- UI routing/accessibility/polling changes: not implemented. Browser service
  and the current jsdom setup blocked a verified change.
- `sync-rest` async replacement: **partial**. Audit/event repository access uses
  awaited PostgREST paths, but secret backend access still uses the blocking
  bridge and the remaining callers must be audited before hosted concurrency
  is production-safe.
- Agent-control finalization fence: **partial**. Durable grant revocation and
  operation expiry are checked in the journal transaction; application
  membership/authorization state is still checked outside that transaction.
- PostgreSQL agent-control writes remain explicitly refused by
  `docs/AGENT-CONTROL.md`.

## Release envelope

The branch is suitable only as a **draft** application PR for review of the
tested hardening slices and architecture record. It does not authorize
production cutover, destructive migration, secret rotation, package
publishing, or enabling PostgreSQL agent-control writes. Webhook DNS binding,
the remaining synchronous secret path, installer-bound provenance, E2B live
egress/teardown, UI behavior, and hosted migration evidence remain open.
Preserving independent selectors does not prove cross-authority atomicity or
that either backend is durable under every hosted failure.

## Rollback

Revert the implementation commit and the documentation commits as a
normal Git revert, or merge only the individual fix commit required by the
release owner. No database migration or production data transformation is
introduced by this branch.
