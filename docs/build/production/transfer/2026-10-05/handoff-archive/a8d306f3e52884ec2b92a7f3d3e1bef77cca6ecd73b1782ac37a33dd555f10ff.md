# Acceptance cleanup under uncertain mutations

Requirements: PROD-DUR-07 and ownership-safe teardown portion of PROD-LIFE-11. Partial implementation work; no live proof or complete requirement claim.

Worker: existing gpt-6.1-sol HIGH thread pushed_baseline_evidence. Worktree `/Users/saivedanthava/.codex/zenith-production/worktrees/acceptance-cleanup`, branch `ws/prod-acceptance-cleanup`, base verified `a14e57f`. Root reviews and verifies; worker source-only, no tests/compiler/install/services/Docker/cloud reads/commit/push.

Demonstrated defect: `settleRunOperations` treats terminal projections including uncertain/cancelled as sufficient to precede destructive cleanup. Cancellation and fences do not undo an accepted provider call. Follow-up cleanup CLI can bypass run-operation settlement. Audit actual call sites, persist run-scoped unresolved mutation blockers before dispatch, recheck authoritative recovery evidence, and refuse destructive cleanup when no proved quiescence authority exists. Keep read-only discovery available. Do not invent proof APIs, accept caller booleans, blindly replay, or add destructive automatic compensation. Check existing workflow description/receipt contracts before treating all successful operations indefinitely blocked; operation status alone is insufficient. Preserve account, region, ownership and run-tag boundaries.

Owned paths:

- `scripts/acceptance/{lifecycle,runner,run-state,cleanup,cleanup-cli,types,aws-live}.ts`
- `tests/acceptance/{lifecycle,runner,cleanup,safety,scenario-live}.test.ts`
- `docs/platform/ACCEPTANCE.md`, bounded cleanup guidance only

List other paths as follow-ups; do not edit them. `aws-live.ts` ownership was narrowly expanded to close its finalizer/recovery-hook bypass. No changes to the durable-plan worker paths or canonical gate manifest.

Author regressions for uncertain/late-success/cancelled/lost-cancellation response/stale reread/read failure/foreign resources/no operation IDs and follow-up CLI bypass. Root independently runs typecheck, affected lint, touched Vitest with one worker, real OpenTofu and Go, then independent source review before integration. Build fake provider keys at runtime; no secret values in code, state, logs, errors, URLs or tests. Report exact frozen inventory, failed evidence and limitations.

Current checkpoint:12owned paths frozen at diffSHA256 `78b50f4510bf67c9cc02eceebe246ec61762ea17e1ba0f6c0066d1aa308e16b2`. Source-only, no runtime validation. Execute always refuses while authoritative resolution is missing. Preserve this snapshot unmerged; worker audits smallest legitimate success contract without edits. Adoption immediate ownership/account reread remains follow-up.

Root partial diagnostic:lint passed,79P/1F/0S, including real networkOpenTofu. Go did not run after failedfixture; compiler not run in this partialdiagnostic. Failure reuses finalized EvidenceRecorder; source-only correction assigned. Runtime proof does not supply missing cleanup authority.

Required success contract:complete durable predispatch intent inventory, current shared writer barrier, exact non-delivery evidence or accepted execution receipts plus provider terminal readback, then separately authorized ownership-bound teardown and independent gone verification. Existing acceptance interfaces cannot establish these facts. Backend/workflow/provider/runner dependencies overlap active broker/artifact paths and require separate owned work; preserve source snapshot unmerged. Immediate adoption account/ownership rereads still leave tagging race without shared writer authority.
