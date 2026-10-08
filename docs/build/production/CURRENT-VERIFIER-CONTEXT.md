# Current verifier progress for the building machine, 8 October 2026

This is progress context, not a restart instruction or a claim of completed production acceptance. Branch: `codex/production-2026-10-02`. Published/tested baseline: `a4c933ecb75d4dd46bba3a027e127df8a3b67257`. This documentation successor does not integrate the isolated LIFE-12 repair.

## Latest results

- [x] Exact baseline CI inspected: **20 successful jobs, zero failed jobs**, across runs 37737802473, 37737802420 and 37737802406. [Per-job report](verification/CI-2026-10-08-a4c933ec.md).
- [x] Remote unit run: **21,826 passed / 0 failed / 1,637 skipped**. Required canonical PostgreSQL, workflows, policy, OpenTofu, intent and reconciliation identities passed. Genuine native Linux ARM64 and AMD64 packaged workers each passed **22/0/0**; architectures remain separate.
- [x] Full native Mac unit attempt executed: **21,848 passed / 1 failed / 1,614 skipped**. Sole failure: installation Compose validation could not find Docker CLI in the private test PATH. This failed whole-run receipt remains failed.
- [x] Corrected private tool environment, then reran the entire installation test file: **62 passed / 0 failed / 0 skipped**, 2.84 seconds. Real Docker CLI and Compose configuration validation; no Docker daemon or containers started. Source/end binding and owned cleanup passed. This focused success does not replace the failed full run.
- [x] Real native PostgreSQL ownership joins executed: **10 passed / 1 failed / 0 skipped**. New test exposed a grant issued after its ownership snapshot became stale. Original failure and cleanup receipt preserved.
- [x] Bounded LIFE-12 snapshot-CAS repair drafted and independently reviewed; affected lint and diff checks passed. **17 actual PostgreSQL scenarios prepared, not yet rerun.** No repair commit or root integration yet.
- [x] Native bootstrap previously passed **86/0/0**, including actual OpenTofu initialization/validation. Native agent browser previously passed **44/0/0**, with a declared identity-provider double; this is not default Supabase operator accessibility.

Counts overlap and must not be summed. Green CI does not mean zero skipped tests or a completed default application journey. Ledger remains **11 verified / 48 in progress / 19 planned**, all 78 requirements retained and all four release states false. Requirement verification is 14.1% by row count, not an implementation completion estimate.

## Work happening now

| Owner | Current work | Acceptance still required |
|---|---|---|
| Verifier lead | Serial real-engine execution, source integration, full-gate/CI review, evidence and documentation | Actual 17-case PostgreSQL rerun; tenancy/SQL-scoping checks; coherent compiler and combined gate |
| Provider repair lane | Four-path LIFE-12 security candidate and exact-source 17-case runner | Root execution and integration; no worker self-approval |
| Independent review lane | Security candidate, custody/source bindings and runnable startup preparation | Review each changed executable packet before startup |
| Default-stack preparation lane | Genuine five-service Supabase, verified TLS pooler, native API/worker composition | Corrected executable packet now awaits independent review of PostgreSQL STARTTLS, ownership custody and continuous resource admission; no startup verdict yet |

LIFE-12 owned candidate paths: `src/lib/controlplane/db/repos/ownership-transfers.ts`, `src/lib/controlplane/db/repos/grants.ts`, `tests/controlplane/ownership-transfers.test.ts`, `tests/controlplane/tenancy.test.ts`. Candidate remains in isolated `codex/verify-life12-joins-20261008`; private receipts/runners are not assumed to exist on another machine. The guard compares the ownership inventory again in the final grant SQL statement. It does **not** serialize every competing writer, revoke existing grants or undo an accepted external call. LIFE-12 remains open; comprehensive writer coordination and preissued-grant policy remain builder follow-ups.

## Remaining coverage within this verifier task

- [ ] Execute and review the 17-case LIFE-12 PostgreSQL candidate; preserve failure evidence; integrate only accepted, actually tested source.
- [ ] Rerun the coherent full native test/gate set with the corrected Docker tool environment. Preserve strict mandatory-case, failure, skip and zero-test detection.
- [ ] Complete current-source reduced-resource default installation/readiness, genuine Supabase roles/migrations and verified TLS. Installer topology deviations must stay explicit.
- [ ] UX-01: two genuine operator identities, real Chrome, exact approval/reapproval, progress/cancellation/uncertainty and axe WCAG 2.1 AA at 1280 and 375 pixels. Profile-local CA import and TLS negative controls remain unexecuted.
- [ ] OBS-04: actual default scheduling effects, health, fallback deferral, restart catch-up and no overlap. Current source has eight maintenance jobs plus reconciliation; historical seven-job wording must not hide current jobs.
- [ ] MACH-03 and OBS-02: default signed runbook delivery and already-wired scoped telemetry. Report missing builder behavior rather than introducing a competing engine.
- [ ] MACH-04: genuine Linux systemd install/register/revoke/rotate/signed update/rollback with health deadline and owned cleanup.
- [ ] Required evidence for LIFE-01, LIFE-08, LIFE-09, LIFE-10, LIFE-11, LIFE-12, MACH-05, UX-03 and COST-03, including the existing join tests, publisher trust, egress refusal/override and release/migration/rollback refusal controls.
- [ ] Final coherent installation, migration, compiler/lint/generated artifacts, dependency audit, real PostgreSQL/Temporal/OpenTofu/OPA, Go race/interoperability, kind provider/release/guest, packaged-worker and authorized browser/API/MCP gates. Report native versus emulated architecture honestly.
- [ ] Update ledger evidence/state, RESULTS, sanitized per-ID evidence, VERIFY-QUEUE results, builder blockers and PROGRESS. Pull without rebase before same-branch pushes; inspect every CI job on each new SHA.

## Resource and authority boundaries

Latest user decision sets continuous local disk floor to **12 GB = 12,000,000,000 bytes**. Earlier 22 GiB guards remain historical evidence. The original packaged-worker 18 GiB prerequisite is a separate gate constraint and any deviation must be reported. One heavy local workload at a time on the 8 GiB Mac; parallel source/review work continues. Docker settings currently 4 GiB memory/4 GiB swap, VirtioFS and Resource Saver off. Remove only positively owned disposable resources, never global-prune or touch unrelated containers/data.

Local disposable default startup is authorized on this Mac only. Live clouds/spend, real DNS, private GitHub App, retention/business decisions and production sign-off remain unauthorized blockers. No mocks used to close those gates. No wave-3 feature implementation within this task. Builder-owned DUR, OBS-01, PKG-04/05, MACH-02/06, UX-02, LIFE-03..07, COST-01/02 and MIX/MAN/OPS/REL work remains with the building machine.

Commit author and committer: Arnav Bule <arnav.bule05@gmail.com>; no history rewrite, force-push or trailer. Earlier identities/history preserved. This update publishes progress only; unexecuted candidates stay unexecuted.
