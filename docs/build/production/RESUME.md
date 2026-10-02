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

Immediate next steps: verify real PG16 migration apply/reapply and contracts;
verify actual Temporal replay; integrate canonical manifest and sanitized
artifacts; push staging normally; observe every job before claiming CI green.
Then continue actual worker-image startup and the remaining product requirements.

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
