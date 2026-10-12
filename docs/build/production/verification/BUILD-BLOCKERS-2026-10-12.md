# Builder-facing blockers — source 685fb836 R5, 12 October 2026

- Exact-source full core and CI are terminal PASS within scope. Eight workflow jobs are conditional skips. Verify log capture is complete; current exact-source CI is not blocked. The remaining issue is the historical CI07 handoff dependency only.
- J4 cleanup R4 completed with 19 resources removed, zero owned resources remaining, and two forced stops. Its receipt has `acceptedRunReceipt:false`; independent terminal review passed (JSON SHA-256 `a65dbf65c748e78ae2d0f17a061a1599a5b0c27f7c08e4aeb1c121df6bfcf75e`). Cleanup R3's pre-deletion refusal remains preserved. This does not establish graceful shutdown or fresh J4 acceptance.
- Focused J4 diagnostic (10/10) and static TypeScript/ESLint (2/2) proofs have independent terminal reviews, but both are candidate-only and `acceptedRunReceipt:false`. The three reviewed diagnostic files are integrated into the current worktree. A fresh source freeze and coherent acceptance run for that updated tree are still pending.
- Native role R4 failed during bootstrap (0 passed, 100 pending, 2 failed suites). Seed roles without `NOINHERIT` are deterministically invalid; the precise inner initializer exception is unproven. Separate recovery receipt/review records the owned PostgreSQL fixture removed and sticky lock cleared at closeout. Corrected canonical-role R5 remains unexecuted.
- Native ARM64 witness remains image-build-only; invocation and J2 acceptance are pending.
- Workflow CI total is 1,559 passed / 75 files / 113 groups. The 28-file / 547-case detail is a partial breakdown. Do not replace the total or add overlapping CI lane counts.
- Keep ledger at 10 verified / 66 in progress / 2 planned; 78 requirement IDs; all release flags false. No milestone promotion.

### Historical source snapshots retained below

The following preexisting CFB and earlier-source sections are retained as historical records. Their old “current” headings and next steps describe those dated snapshots, not the 685fb836 status above.

# Builder-facing blockers, 12 October 2026

Fresh source verification is pending after integration of the reviewed diagnostic and fixture shutdown fixes. CFB core and CI are green; full scenario acceptance is still open.

- J4: earlier default machine-schedules attempt failed after initial natural jobs; exact API/billing boundary cause remains unproven. The old stack is fully removed. Use a new database/epoch/namespace and the fixed-code private diagnostic on the fresh run; do not reuse mutated state.
- J1/J2: continuation, real Chrome dual-user TOTP/MFA, second-person approval, axe at1280/375, and native kind acceptance remain pending behind fresh J4 and witness receipts.
- MACH-03/MACH-04 and later recovery/driver scenarios need actual owned authenticated fixtures; focused mocks or CI do not replace these journeys.
- PKG-04: current Docker VM is7.75GiB versus12GiB prerequisite. Protected builder restart remains unapproved; preserve the gate.
- COST-03: actual gap-free168-hour trusted meter window cannot be manufactured or compressed.
- LIFE-10 managed PostgreSQL password readback and MACH-02 token-lifetime acceptance need builder implementation/evidence. Historical MinIO marker provenance is unresolved.
- Live cloud, spend, real DNS, private GitHub App/source, business/security exceptions and production signoff remain outside authorization.

Owned cleanup completed with19 resources removed/zero remaining; two forced stops are recorded. AirPlay remains temporarily off for remaining port5000 tests; restore the original on setting after those tests. No CA trust has been added. Keep release flags false and ledger10/66/2. Retain original failures and their exact source bindings.
