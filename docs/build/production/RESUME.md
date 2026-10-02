# Production continuation

Source baseline: `codex/wave8-integration-2026-10-02` at
`37be7340536ccb68ae4bb49294e8ab3799d1f01b`. Staging is
`codex/production-2026-10-02`. Preserve descendants, existing work and identity;
never reset to the historical checkpoint or reapply completed wave-8 patches.
Read `ledger.json`, generated `REQUIREMENTS.md`, `../../LIMITATIONS.md`,
`../../platform/ACCEPTANCE.md` and relevant source. Historical wave evidence is
in `../verification/2026-10-02-wave8.{md,json}`.

## Verified pushed baseline

Run `36971241225` at `2c9d6fa1ee5821d6b90fef4b8aab08a9ba32352a`
is observed terminal green: all14 jobs passed. Unit16095P0F384S;
canonical postgres251,platformPostgres1327,policy238,tofu3874,workflows861
all0F0S. All required groups and12receiptbindings match in every lane, retaining
observed schema2 exit0. Smoke/Gimbal actually ran; mandatory complete locked
audit0. Go race11testedpackages pass, individualcasecounts not emitted;
TypeScript/Go machine interoperability19P0F0S. See `ci-36971241225.md` and
its exact sanitized artifacts. Prior red/cancelled run reports remain preserved.
Later local integrations are not covered by that green commit.

Ledger:78stable requirements,6verified,13inprogress,59planned. Allfour
release states remain false. CI05 wider gate/case manifest coverage, fresh
production browser composition and externally authorized acceptance stay open.

## Integrated local work

Workflow-start safeguards `7d75b21` are integrated by `dde1298`. Root105P0F0S
includes actual isolated Temporal accepted-start/lost-response/late-completion
and idempotent duplicate refusal plus real networkOpenTofu. Fulltypecheck/lint,
Go226top+539subP0F3Linux-onlyMacS, fresh canonicalPostgres1327P0F0S and
freshkindprovider6/6+release1/1 pass; owned dependencies removed. Preserve the
writer and recorded plan round; uncertain cannot mean failed or permit another
start. Durable outbox/recoveryepochs/operator continuation remain separate.
See `workflow-start-recovery-2026-10-02.md`.

Packaged worker harness `bbf50fc` is integrated by `e2a5c4f`. Root120P0F0S,
fulltypecheck/lint/realOpenTofu/Go and freshkind6+1 pass; cluster deleted.
Source review closed temporary-secret build-context, source-hash, evidence
whitelist, refusal-exit and ownership-cleanup gaps. One fixture correction
preserves all assertions; failed run remains private. Actual fresh perarchitecture
startup on combined source is still pending. Earlier nativeARM64 scoped retry
passed, but current AMD64 emulated run failed before proving worker refusal;
separate ownership-verified cleanup removed leftovers. Keep both failures and
native/emulated limits. File product fixtures, empty reconciliation, signed
no-target read refusal, sentinels and idle shutdown are not cloud mutation,
executable plan handoff, production product/Temporal or default API proof.
Source hashing explicitly does not establish an immutable context snapshot.

## Active isolated work

Worktrees live under `/Users/saivedanthava/.codex/zenith-production/worktrees`.
Root owns review, verification, integration and ledger; only one heavy process
may run on this8GB host. Workers are source-only unless root grants an exclusive
slot. Do not start tests during another worker's npm/Docker/database checks.

- `canonical-repair`:30 frozen paths. Canonical HTTP/Temporal core under the
  existing heartbeat/fenced lease, history patch/replay, uncertain conflicts and
  honest unsupported handling. Shared pure `repair-recipes.ts` admits only
  managed AWS ECS replica-only drift; it grants nothing. First root compiler
  caught two stale signatures/SDK fixture defects; corrected public/test type
  reuse and valid subnet fixture need full root rerun. Freeze manifestSHA
  `c2755db18fe0950f4d35fe57057599350587aabfa930e05878de5a7d6e5ac987`.
- `ecs-replica-repair`:24 frozen paths, with the new locked SDK. Exact fullenvironment
  saved plan, immutable owned target/binding, browser current-plan approval,
  read-only initial grants, complete unique tag lookup, autoscaler refusal,
  durable readback receipt and uncertainty after mutation cancellation. All100
  prepared cases unrun. Pinned SDK3.1121.0 lock update and private fresh
  DarwinARM64 installation passed; mandatory complete audit0. Exclusive slot
  released. Shared contract lives in the pure resource layer. Root checks,
  manifest inclusion and live proof remain pending. Shared contract SHA
  `58f37f3fa05cb92426853f31a2c8a77fb16b342defa3d535ee72d6783634df2b`.

Next on this Mac, with the exclusive slot free:

```sh
python3 /Users/saivedanthava/.codex/zenith-production/check_candidate.py prod-canonical-repair-resource-root /Users/saivedanthava/.codex/zenith-production/worktrees/canonical-repair tests/reconcile tests/resources tests/workflows/reconcile.test.ts tests/workflows/operations.test.ts tests/execution/verify.test.ts
```

Then root fresh PostgreSQL/kind, review and merge only passing exact source.
Independently compile/test ECS against private locked dependencies, audit and
real engines; add required replay/suites to canonical manifest. Actual packaged
runs on combined source are serial and opt-in:

```sh
ZENITH_PACKAGED_WORKER_ACCEPTANCE=1 node scripts/acceptance/packaged-worker.mjs --platform linux/amd64
ZENITH_PACKAGED_WORKER_ACCEPTANCE=1 node scripts/acceptance/packaged-worker.mjs --platform linux/arm64
```

Verify ownership cleanup after every run. Publish only sanitized evidence;
raw logs/inventories/diagnostics remain private outside Git. Local helpers/logs
are not automatically present on a different machine. Re-run full gate, push
normally and observe the whole resulting run before calling newer source green.

## Operator boundaries

Every new source, integration and evidence commit uses Saivedant Hava
`<saivedant169@gmail.com>` as author and committer on this Mac; no trailers,
force push, history rewrite or secret-scanning bypass. GitHub auth is
`saivedant169`. No LocalStack or unrelated services. Disposable local test
Postgres/Temporal/kind and actual execution-worker startup are authorized;
use only dedicated kubeconfig and delete all owned resources.

API/server startup remains restricted pending the already-requested narrow
approval. Dedicated AWS sandbox access/region/budget also remain pending. Never
put secrets in chat. Live accounts/budgets, destructive audit retention,
payment accounts/terms and production signoff require operator decisions.
Continue unblocked work; a missing decision is a visible release blocker.

Update `ledger.json`, render with `node scripts/build/production-ledger.mjs`,
then run its `--check`. Preserve historical ledger/evidence. Finish the whole
production program beyond this green baseline; report implementation, sandbox,
pilot and production approval separately without unattended-work claims.
