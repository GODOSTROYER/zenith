# Acceptance cleanup, unresolved mutation safety

This source packet fixes a P1 harness race. Previously, a lost proposal response
left no tracked operation, terminal projections permitted a destructive sweep,
and the follow-up cleanup CLI bypassed settlement. The current clients provide
no complete dispatch inventory or writer barrier that could prove cleanup safe.

The harness now writes a strict run/account/region unresolved marker before each
mutating scenario step, capability proposal and execute-mode action. Creation
uses exclusive private-file writes; existing markers are revalidated rather than
overwritten. A lost response or environment-inventory rewrite cannot clear it.
This local, untrusted marker can only block. Its absence cannot authorize cleanup,
and this slice makes no fsync or power-loss durability claim.

External finalizers may request cancellation and observe operation/workflow
state, but always refuse resuming hooks, worker restart and destructive sweep.
Terminal status, late success, Temporal completion and cancellation acknowledgement
are diagnostic. Local observation-only runs finalize without hooks or a sweep.
Cleanup execute requests retain scoped read-only discovery and always return
not-ok, even with an empty tag index, missing/legacy/unreadable/rewritten state,
a different output directory or disabled OpenTofu. Dry-run discovery remains
available. There is no clearance bit, callback, timeout or administrative override.

The existing low-level ownership/dependency handlers and destroy-plan guards are
preserved; their modeled checks do not provide invocation authority. The copied
historical refusal design was audited against current preimages before adaptation:
all 12 original paths exactly matched its base, while current root60 and the
independently reviewed human Kubernetes bridge correction remain dependencies.
The historical 79-pass/1-fail receipt stays failed. This packet additionally
refuses settlement with empty IDs, skips all local-only finalizer callbacks and
refuses successful execute reporting for zero discovered runs.

Tests use synthetic control-plane/Temporal replies, local files and mocked AWS
SDK calls. They cover lost dispatch/cancel replies, late/terminal/stale projections,
malformed/foreign tracking, restarted contexts with fresh evidence recorders,
pre-dispatch persistence refusal, execute action versus read-only planning,
refused restart/adoption/destroy/deletion/DNS, tag/name/account refusals, empty
execute discovery and successful local observation without external callbacks.
No live account, browser, native quiescence, successful cleanup or restored-data
acceptance is claimed. Compiler, lint and all tests are unrun by the author.

Root verification: use pinned Node22 with maxWorkers1 for the five changed
`tests/acceptance/{lifecycle,runner,cleanup,safety,scenario-live}.test.ts` files,
then the existing acceptance/network OpenTofu controls and scoped compiler/lint.
Independent source review and actual root execution are required before integration.

Outside-owned implementation prerequisites: server-owned exhaustive run/environment
intent inventory checked by the existing broker/workflow/runner/credential dispatch
gates; a current shared-writer barrier; exact non-delivery or accepted receipts
plus independent provider terminal readback for every possible attempt; and a fresh
separately authorized teardown with exact ownership and independent gone checks.
Scenario-time tag adoption also lacks immediate ARN-account/ownership rereads and
cannot obtain atomic ownership from a tagging index. Backup/export/import and
independently restored-data acceptance remain separate PROD-LIFE-11 work. This
refusal safety slice does not close that criterion or successful cleanup acceptance.
