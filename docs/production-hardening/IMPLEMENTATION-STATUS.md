# Production-hardening implementation status

This document is the integration record for the draft hardening PR. It is not
a claim that Zenith is production-ready in every backend.

## Implemented in this branch

| Change | Commit | Evidence |
|---|---|---|
| Reject malformed or non-finite agent integration grant expiries | `f42d2e4923d28385cb8b2b060b19365afea58ed6` (cherry-picked as `50b37f5`) | 15 OAuth tests, typecheck, targeted lint pass |
| Record the architecture gate, topology, migration rules, work graph, and deployment matrix | `d8cf2af93e895312914f3de47131e15af6b2a3fb` | Reviewed against current source and Sol gate output |
| Fence agent-operation finalization against operation expiry, durable OAuth grants, and application authority | `5455a52` (on top of `6bc2e21`) | Coordinator/journal, membership, grant, account-delete, and hosted access tests pass; supported single-writer mutation paths share the gate |
| Store alert signing keys and credential-bearing HTTP targets as encrypted secret references with compensating rotation | `5455a52` (on top of `90a8a87`) | Alert delivery, outbox, bootstrap-redaction, audit masking, rollback, tamper-read, and workspace-isolation tests pass; legacy plaintext delivery fails closed |
| Bind webhook delivery to the validated DNS address and scope async tenant writes | `5455a52` (on top of `9274b0f`, `fa67fa9`) | Address-pinning, redirect, bounded-response, async body-binding, and tenant-column tests pass |

The initial blanket mixed-store guard was implemented experimentally and then
reverted after independent review showed it would reject the repository's
documented `ZENITH_STORE=postgres` plus `ZENITH_HOSTED_STORE=sqlite` mode. The
current branch intentionally preserves the existing independent selectors.

## Verification

- Focused hardening suite (serial, no file parallelism): **282/282 passed** across 20 alert, action, secret, hosted-access, agent-control, redaction, and async-repository files.
- Final regression set after independent review: **57/57 passed** across alert delivery, account deletion, agent-control coordinator, and async-repository tests.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `git diff --check`: passed.
- `npm run build`: compiled successfully; Next emitted the existing `module.createRequire failed parsing argument` warnings for hosted build recipe imports.
- `npm run test:contract`: 36 executed, 15 skipped.
- Companion plugin `npm run verify`: 141 tests passed, 2 platform skips; typecheck, build, contracts, and integrity checks passed.

## Partial / release blockers

- Alert webhook SSRF protection: **address-binding slice implemented; live gate
  remains open**. The input policy rejects non-HTTPS,
  loopback/private/link-local/reserved destinations; delivery pins the selected
  DNS address through `https.request`, refuses redirects, and bounds response
  bodies. No live metadata probing was performed. Legacy plaintext rows require
  `ZENITH_SECRET_KEY` for migration and are not deliverable while the key is
  unavailable.
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
  awaited PostgREST paths and tenant-scoped writes now bind the body tenant;
  secret backend access still uses the blocking bridge and remaining callers
  must be audited before hosted concurrency is production-safe.
- Agent-control finalization fence: **bounded slice implemented**. Durable grant
  revocation, operation expiry, application membership/app-role digests, and
  account/grant/member mutation paths are fenced by the single-writer gate;
  PostgreSQL agent-control writes remain refused and distributed authority is
  not claimed.
- PostgreSQL agent-control writes remain explicitly refused by
  `docs/AGENT-CONTROL.md`.

## Release envelope

The branch is suitable only as a **draft** application PR for review of the
tested hardening slices and architecture record. It does not authorize
production cutover, destructive migration, secret rotation, package
publishing, or enabling PostgreSQL agent-control writes. Legacy secret
migration, the remaining synchronous secret path, installer-bound provenance,
E2B live egress/teardown, UI behavior, live webhook probing, and hosted
migration evidence remain open. Preserving independent selectors does not
prove cross-authority atomicity or that either backend is durable under every
hosted failure.

The companion plugin provenance work is tracked in the draft PR
`GODOSTROYER/Zenith-plugins#6`. It is intentionally not a production approval
for the plugin installer until verification is enforced at that consumption
boundary.

## Rollback

Revert the implementation commit and the documentation commits as a
normal Git revert, or merge only the individual fix commit required by the
release owner. No database migration or production data transformation is
introduced by this branch.
