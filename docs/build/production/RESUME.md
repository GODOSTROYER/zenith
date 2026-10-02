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

Pushed run `36956453026` at `f36a98482d1379ae42b723d8fb6ebbc83deafa32`
finished with 13 successful jobs and one cancelled verification job. GitHub
confirmed the 15-minute job timeout; all three original failures now pass.
Five sanitized artifacts lost their command observations during later
validation. See `ci-36956453026.md`; remote CI is not green.

Execution receipts `6eb9a1c` are integrated by `63dcf0d`; root336affected
checks, fulltypecheck/lint/Go pass. CI wiring `2b2b056` is independently
verified by493CI/configurationchecks plusmandatoryaudit0 andledgerchecks.
Actualcommandorigins are immutable; CI uploads only validated scalar receipt
fields inside sanitized JSON. No raw receipt sidecars are uploaded. Remote
environment-binding compatibility remains unproved.

Pushed run `36961474315` at `ef67f47` completed with nine successful and five
failed jobs. All five engine commands passed without skips and retain observed
exit0 receipts; later validators rejected only the effective environment hash.
All other bindings matched. Full unit job15950P0F384S, build, Docker and the
mandatory zero-finding audit passed. See `ci-36961474315.md`. Measure the
changing runner key before excluding any additional transport metadata.

Immediate next steps: review and verify private environment diagnostics,
push normally, diagnose measured drift and observe every new CI job. The
first fresh native ARM64 worker image built and passed three startup refusals
and migrations1through6, but actual readiness failed. Owned resources were
deleted. Repair Temporal volume ownership/readiness, rerun ARM64, then AMD64
serially. Preserve native versus emulated evidence. Candidate worktree:
`/Users/saivedanthava/.codex/zenith-production/worktrees/worker-startup`.
Dependency remediation `d8e457fd5add185cc9df13f8bee38076e1c1d53f` is
integrated by `0f8cabb1c3abf061708f9c1a32b713d96329bf07`. Root verified
502 focused checks, full typecheck/lint/Go, 16,062 full-suite passes with 194
explicit skips, real Temporal861/861, production build and a zero-finding
complete locked audit. Fresh Linux CI installation and mandatory audit now
pass. Historical advisory reconciliation and real SMTP/TLS acceptance remain
unproved. No exceptions are granted.
Installation configuration `a9fea8968d41e4639d4c2566eb238cec74ef957a` is
integrated by `d697c4ef63b2ed64bd02e129315c2a35ae6a2829`. Root62contract
tests and both real Compose config parses pass; no services started. API
startup and dedicated AWS sandbox details were requested; both remain pending.
AWS suffix propagation root checks883P0F2gatedS, fulltypecheck/lint/Go and
fresh platformPostgres1324P0F0S pass; remaining real deletion/kind checks and
integration pending. Retain stack-first/live IAM permission blockers.
`ws/prod-start-uncertainty` repairs actual Temporal error classification and
competing product projections; durable outbox/recovery remains separate work.

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
