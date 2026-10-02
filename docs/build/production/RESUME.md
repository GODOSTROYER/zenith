# Production continuation

Source: `codex/wave8-integration-2026-10-02` at
`37be7340536ccb68ae4bb49294e8ab3799d1f01b`. Production staging:
`codex/production-2026-10-02`. Preserve descendants and local changes. Never
reset to the historical checkpoint or reapply completed wave-8 patches.

Read `ledger.json`, generated `REQUIREMENTS.md`, `../../LIMITATIONS.md`,
`../../platform/ACCEPTANCE.md` and the relevant source. Wave-8 test evidence is
in `../verification/2026-10-02-wave8.{md,json}`. It does not establish production
approval or remote CI success.

Current baseline CI run `36925770382` completed with 11 successful and three
failed jobs. Failures: stale Supabase platform ledger check, quoted PostgreSQL
suite labels, and skipped required Temporal/public-source scenarios. Old run
uploaded no JSON artifacts; downloaded logs are available on this Mac only.
Reproduce real-engine JSON and bind sanitized evidence to its actual commit.

Three isolated CI repair worktrees are under
`/Users/saivedanthava/.codex/zenith-production/worktrees`. Root independently
reviews and checks each patch before committing or merging. Root owns CI wiring
and the ledger. Only one heavy verification process may run on this 8 GB host.
Use serial Vitest. Runtime/security and packaged-worker followups can proceed
independently while remote CI runs, within this resource limit.

Current integration has canonical schema checks, 39 required PostgreSQL groups,
real replay/source flags, sanitized artifacts, exact runner expiry assertions
and aligned runtime admission. Root PostgreSQL rerun passed 1,324/1,324, zero
skips. Root fresh clean full Node/DOM suite passed 16,054/16,248, with 194
explicit skips. Canonical Temporal/platform/public-source rerun passed 861/861,
zero skips; all 37 required groups and the checker pass. OPA213 and Go race
226 top-level + 539 subtests pass, with three Linux-only skips on this Mac.
See `fresh-baseline-2026-10-02.md` for the exact reference and evidence limits.

Immediate next steps: push staging normally and observe every CI job. Then
verify/start the actual packaged worker harness on ARM64 and AMD64 serially.
The dependency candidate has a fresh zero-finding audit and eight real-package
checks; root full typecheck exposed two broad mock-type declarations incompatible
with Vitest4, now assigned for bounded fixes. Full-suite/build/Linux proof is
still pending; current root lock remains blocked by eight findings, no exceptions.
Installation configuration is staged separately; API startup requires the
existing narrow permission. AWS suffix propagation is being implemented in
`ws/prod-aws-suffix`; retain stack-first/live IAM permission blockers.

All new commits use Saivedant Hava `<saivedant169@gmail.com>` as author and
committer on this Mac. No history rewrite, force push or secret-scanning bypass.
No LocalStack or unrelated services. Isolated test dependencies and execution
worker startup are authorized by the production directive. Obtain a narrowly
scoped decision before starting the Zenith API/server where the existing
restriction applies. Live accounts/budgets, destructive retention, payment
accounts/terms and production signoff remain explicit operator decisions.

Update `ledger.json` as evidence changes, then run
`node scripts/build/production-ledger.mjs` and its `--check` mode. Preserve the
historical wave ledger; do not represent all 116 historical rows as production
completion. Missing live authorization remains a visible release blocker while
independent implementation continues.
