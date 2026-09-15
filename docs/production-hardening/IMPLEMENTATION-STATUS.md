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
| Widen secret-backed request/provider paths and cold readers to async PostgREST, and add explicit alert-secret migration | `b96459b` + `856ee9a` + current async-reader slice | Async secret route/actions/provider/alert delivery, project payload, deploy planning, provider verification, and secret-consumer tests pass; `npm run migrate:alert-secrets -- --dry-run` is safe by default and `--apply` requires an explicit operator action |
| Require a pinned E2B template with no runtime package installation | current hardening slice | E2B selection rejects aliases/tags, requires a bare template ID plus SHA-256 attestation, verifies the provider-resolved ID and image attestation before upload, and checks the pinned toolchain; isolated runner tests pass 19/19 |
| Enforce plugin provenance at the runtime consumption boundary | `951bdb9` in `GODOSTROYER/Zenith-plugins#6` | Plugin verify passes 144 tests/2 skips; the generated runtime fails closed at activation unless the trusted launcher supplies the signed Ed25519 gate |
| Fence every hosted app-grant insertion path, including direct grants and invitation acceptance | post-review hardening (this commit) | Grant services now enter the same re-entrant mutation gate as account deletion, role changes, and revocation; hosted access and agent-control regression tests pass |

The initial blanket mixed-store guard was implemented experimentally and then
reverted after independent review showed it would reject the repository's
documented `ZENITH_STORE=postgres` plus `ZENITH_HOSTED_STORE=sqlite` mode. The
current branch intentionally preserves the existing independent selectors.

## Verification

- Focused hardening suite (serial, no file parallelism): **282/282 passed** across 20 alert, action, secret, hosted-access, agent-control, redaction, and async-repository files.
- Final regression set after independent review: **57/57 passed** across alert delivery, account deletion, agent-control coordinator, and async-repository tests.
- Resumed async/E2B/UI bundle: **96/96 passed** across alert delivery, recipe-local/E2B runners, secret contract, client stream/poll fallback, and workbench controls; the prior E2B isolated suite was **17/17 passed** before the attestation gate was added.
- Hosted acceptance: **22/22 checks passed** through publish, invite, browser-facing gateway, conflict, backup, revoke, restore, and post-restore denial.
- Hosted browser gate: **passed** with `/usr/bin/chromium-browser` through `playwright-core`; 24/24 journey checks passed at 1280px and 375px with no uncaught/page errors.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `git diff --check`: passed.
- `npm run build`: compiled successfully; Next emitted the existing `module.createRequire failed parsing argument` warnings for hosted build recipe imports.
- `npm run test:contract`: 36 executed, 15 skipped.
- Companion plugin `npm run verify`: **144 tests passed, 2 platform skips**; typecheck, build, contracts, and integrity checks passed.
- Post-review regression bundle: **116 tests passed** across agent control, account
  deletion, hosted access, alert delivery/outbox, redaction, and async repository
  boundaries; `npm run typecheck`, `npm run lint`, and `git diff --check` passed.
- Async boundary and E2B attestation regression bundle: **25 files / 364 tests
  passed**; E2B isolated runner suite **19/19 passed**. Async action audit writes
  and alert migration persistence are covered; the remaining synchronous bridge
  is compatibility-only.

## Partial / release blockers

- Alert webhook SSRF protection: **address-binding slice implemented; live gate
  remains open**. The input policy rejects non-HTTPS,
  loopback/private/link-local/reserved destinations; delivery pins the selected
  DNS address through `https.request`, refuses redirects, and bounds response
  bodies. No live metadata probing was performed. Legacy plaintext rows require
  `ZENITH_SECRET_KEY` for migration and are not deliverable while the key is
  unavailable.
- Publisher-authenticated plugin provenance: **runtime gate implemented; release
  activation still external**. The generated package checks the signed Ed25519
  envelope and exact package bytes before MCP/control startup when the trusted
  launcher supplies `ZENITH_REQUIRE_PROVENANCE=1` plus absolute manifest/trust
  paths. A publisher key, installer wiring, and marketplace live install are
  not available in this workspace.
- E2B frozen dependency/egress policy: **local policy implemented; live gate
  open**. E2B now refuses aliases/tags and missing template attestations,
  verifies the resolved template ID and SHA-256 attestation before upload,
  performs no package installation, checks pinned recipe versions, disables
  sandbox internet access, and always tears down the sandbox. Provider-side
  egress, controller access, terms, and live teardown remain unverified.
- UI routing/accessibility/polling: **source and browser gates passed**. Stream
  fallback, polling/backoff, route switching, workbench controls, keyboard
  interaction, reload persistence, conflict preservation, revocation denial,
  desktop/mobile rendering, and console/page-error checks are covered by the
  resumed bundle and the real Chromium journey.
- `sync-rest` async replacement: **request/worker paths widened; compatibility
  bridge remains**. Secret route/actions/provider/alert delivery, project
  payloads, deploy planning, provider verification, secret consumers, and
  action audit writes use awaited backend APIs. The synchronous `Store` contract
  and legacy history delegates still use the bridge by design.
- Agent-control finalization fence: **bounded slice implemented**. Durable grant
  revocation, operation expiry, application membership/app-role digests, and
  account/grant/member/direct-grant/invitation-acceptance mutation paths are
  fenced by the single-writer gate; PostgreSQL agent-control writes remain
  refused and distributed authority is not claimed.
- PostgreSQL agent-control writes remain explicitly refused by
  `docs/AGENT-CONTROL.md`.

## Release envelope

The branch is suitable only as a **draft** application PR for review of the
tested hardening slices and architecture record. It does not authorize
production cutover, destructive migration, secret rotation, package
publishing, or enabling PostgreSQL agent-control writes. Live legacy-secret
migration against a representative Postgres database, the remaining
audit/history synchronous bridge, publisher-key/installer activation, E2B live
egress/teardown, live webhook probing, and hosted migration evidence remain
open. Preserving independent selectors does not
prove cross-authority atomicity or that either backend is durable under every
hosted failure.

The companion plugin provenance work is tracked in the draft PR
`GODOSTROYER/Zenith-plugins#6`. Its runtime gate is implemented, but it is not
production approval until a trusted installer supplies the external publisher
manifest/trust configuration and a live marketplace installation is verified.

## Rollback

Revert the implementation commit and the documentation commits as a
normal Git revert, or merge only the individual fix commit required by the
release owner. No database migration or production data transformation is
introduced by this branch.
