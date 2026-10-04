# Combined regression corrections, October 4, 2026

This packet addresses source regressions found by root's combined unit run
(`17870` passed, `10` failed, `559` skipped). That failed run remains evidence;
these edits have not been executed or accepted as runtime proof.

The saved-plan coverage check now expects all eleven currently registered
PostgreSQL handoff scenarios in their existing manifest order. Exact equality,
native backend requirements, source titles and lane inclusion checks remain.
The canonical manifest and every handoff test are unchanged.

The operator documentation checks now follow the default owning approved-source
runtime, its fixed GitHub connector and guarded Azure reader. Existing archive,
checksum, upload, launch receipt and storage audience checks remain. Additional
source assertions retain the verified connection and owned storage association.
`docs/platform/operations/DEPLOYING.md` keeps its first twelve migration rows
unchanged and appends registered migration 13, `approved_source_snapshots`, with
SQL SHA-256 `eb513c01d41b1f7fbc680715b86699147374d9786aa3e17e355897388ff26e95`.
The checksum uses the exact migration SQL text, including its boundary newlines.
No migration implementation or recorded database ledger is changed.

`operations.acquireExecutionLease` now owns the existing lease lock, live row
read, same-holder renewal or acquisition, and native operation binding in one
transaction. The adapter retains its original input snapshot, plain acquisition
branch and refusal mapping. The repository also detaches its input for direct
repository callers. `bindExecutionLease` remains unchanged: lease then operation
locking, current workspace, environment, workflow claim, proposal digest and
live holder/fence checks still govern the initial null pair or identical pair.
Binding failure still rejects the enclosing acquisition transaction. Same-worker
acknowledgement recovery keeps its fence; ordinary and reconcile reacquisition
still use the original incrementing lease repository. No approval is consumed
by acquisition or binding.

Both repository functions are individually classified as writes in the existing
tenancy completeness check. Their positive and foreign-workspace provenance
remains the same mandatory 24-case native first-source suite. No sweep,
exemption, native case or SQL boundary guard is weakened.

Root should use pinned Node 22.23.3 for the compiler and scoped lint, then execute
the focused regression checks serially:

```sh
node node_modules/vitest/vitest.mjs run tests/ci/platform-coverage.test.ts tests/docs/operator-docs.test.ts tests/execution/ledger-approval.test.ts --no-file-parallelism --maxWorkers=1
```

With root's disposable PostgreSQL 16.15 URL already exported through
`ZENITH_TEST_PLATFORM_PG_URL` and canonical schema 13 applied, execute:

```sh
ZENITH_TEST_FIRST_SOURCE_LEASE_REQUIRED=1 node node_modules/vitest/vitest.mjs run tests/controlplane/first-source-lease-binding.test.ts tests/controlplane/tenancy.test.ts --no-file-parallelism --maxWorkers=1
```

The mandatory suite is `first source worker lease binding [postgres]`. Its
24 names, required flag, actual PostgreSQL checks and independent connection
controls are unchanged. No new native suite or gate registration is introduced.
Root retains canonical lane, real OpenTofu, Temporal, API/browser and release
acceptance. The existing broader failures and blocked permissions remain open
until their owning checks execute. This packet makes no cloud or browser claim.

The frozen packet includes only the seven approved paths and static before/after
preservation evidence. Author work ran no project imports, tests, compiler,
lint, services, database, container, cloud calls or commits. Independent review
and all runtime execution remain pending at freeze. There is no additional
outside-owned source change requested by this bounded correction.
