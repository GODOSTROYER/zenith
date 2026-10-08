# Clean-host restore, recovery epochs and operator continuation

Written against branch `prod/compose`, guide input at `443bfeaf537dd5d5324d33c84fc544ede0baa632`. Working-tree assembly; native and live acceptance remain unverified.

PROD-OPS-04. Built, not rehearsed against production: the rehearsal below runs on real PostgreSQL and a Temporal dev
server on one machine, and nothing here has been run against a hosted cluster, Temporal Cloud or a customer cloud.
Not verified live. Targets quoted anywhere in this page are provisional until PROD-OPS-01 records an accountable approval.

This page replaces the "restoring to an earlier point in time is not free" warning in [RECOVERY.md](RECOVERY.md) section
4.6 with a mechanism. RECOVERY.md still describes the stores, the crash model and key rotation; read it for those.

## What a restore breaks, and what the epoch does about it

A restore rewinds the database to a point in time. Everything that exists only to be single use or monotonic looks fresh
again (a consumed approval, a delivered intent, an accepted effect, a lease fence), while workers, Temporal histories and
cloud providers still remember the timeline that was lost. The **recovery epoch** is a monotonic counter in
`platform.recovery_epochs` (append-only) that every authority check includes:

| Check | What the epoch changes |
| --- | --- |
| Lease fences (`assertFence`, every fenced write, effect resolution, grants, plan custody) | A fence token carries its epoch (`epoch * 1e9 + 1` is the lowest token an acquire can hold). A bump expires every lease and lifts every counter, so a pre-restore token never equals a live fence. |
| Approvals (`consumeApprovals`, the approval count, `approvals.record`) | Only approvals stamped with the current epoch count. A restored approval, consumed or not in the lost timeline, never authorizes. |
| Execution claim (`claimForExecution`) | A pre-restore operation is refused (`recovery_epoch_stale`). A person reopens it, which opens a fresh approval round in the new epoch. |
| Durable intents (claim, settle, start adoption, approval-signal derivation) | Only current-epoch intents are claimable. A restored pending intent waits for a person. A claim taken before the restore cannot settle after it. |
| External effects | Restored `pending` effects become `uncertain` and stay so (never retried, only resolved by evidence under PROD-DUR-07). `accepted`, `uncertain` and `conflict` are untouched. A late provider receipt is recorded as evidence only. |
| Running operations, saved plan uses, grants, runner jobs, zenithd requests | Running operations become `uncertain`; claimed/dispatched plan uses become `uncertain`; every unconsumed grant is revoked; queued jobs are cancelled and claimed/running jobs closed as outcome-unknown, so a restored envelope cannot run twice. |

New rows are stamped by the database (`recovery_epoch` defaults to `platform.current_recovery_epoch()`), so no writer can
forget. In epoch 0 (no restore ever) every behaviour is identical to before.

**The limit, stated plainly.** Work that happened after the backup left no row in the restored database. The epoch cannot
replay it and cannot see it. The RPO window is therefore a window in which providers may hold changes the ledger does not
know about: after a restore, reconcile provider state for that window (drift observation, build listings) before trusting
the ledger. The restore report prints the window.

## Take a backup

```bash
# DIRECT connection (not the pooler) in ZENITH_PLATFORM_DB_URL or SUPABASE_DB_URL; pg_dump/pg_restore of the server's major version
npm run ops:recovery -- backup --out /backups/zenith-2026-10-07 \
  --product-store postgres --hosted-store postgres \
  --artifact-dir "$ZENITH_ARTIFACT_DIR" --temporal-namespace default --temporal-address temporal:7233
```

Product file store: `--product-dir <ZENITH_DATA> --quiesced` (stop the process first; it is single-writer). Hosted SQLite
store: take `npm run hosted:backup` first and pass `--hosted-bundle <file>`. A component that does not apply is declared
(`--hosted none:<why>`); one that applies but could not be captured is `skip:<why>` and a restore refuses it unless the
operator accepts that gap by name.

One `pg_dump` per database runs under an exported snapshot together with the row counts, the schema version and the
recovery epoch recorded in `MANIFEST.json`, so the dump and the facts the restore later checks describe the same instant
(`platform.snapshotAt`, what RPO is measured from). The manifest names every component (platform, agent, product, hosted,
source, plan artifacts, Temporal, artifacts, customer state, keys) as `captured`, `covered` (by which file), `referenced`,
`not_applicable` or `skipped`, lists each file's size and SHA-256, and carries a digest over itself. **Record the manifest
digest off-host.** No connection string, password or key material is ever written; key facts are purpose, key id and role.

`npm run ops:recovery -- verify --backup DIR` re-checks every file and the manifest digest at any time.

## Restore into a clean host

Stop every actor first (workers, runners, the web app's operation routes). The runbook only ever writes into an **empty**
database; it never overwrites.

```bash
export RESTORE_TARGET_URL='postgres://â€¦/zenith_restored'   # DIRECT url of the EMPTY target; never a CLI argument
npm run ops:recovery -- restore --backup /backups/zenith-2026-10-07 --target-url-env RESTORE_TARGET_URL \
  --run-id restore-2026-10-07-a --actor "alice@example.com" --reason "region loss" --report /backups/restore-report.json \
  --confirm-customer-state --incident-at 2026-10-07T09:41:00Z --observed-epoch 0 \
  --product-data-dir /srv/zenith/data --hosted-bundle-out /srv/zenith/hosted-backup.zbk \
  --temporal-namespace default --temporal-address temporal:7233 --terminate-temporal
```

| Step | Passes when | Refuses when |
| --- | --- | --- |
| verify | the manifest digest and every file's size and SHA-256 match | anything is missing, resized or edited |
| gates | every component is captured, covered, not applicable, or explicitly accepted (`--accept-skipped <id>`); customer state confirmed (`--confirm-customer-state`: Zenith never holds it, confirm the bucket's versioning is intact) | a component is skipped and not accepted, the manifest omits a component, a captured product store has no `--product-data-dir` |
| keys | this host's key registry (OPS-05) already holds every key id the backup needs | any is missing (ids are named, never values): sealed data is unreadable without them |
| empty | the target holds none of the stores being restored | it does, unless this very `--run-id` already bumped the epoch (an idempotent re-run) |
| restore | one atomic `pg_restore --single-transaction --exit-on-error` | any error (nothing is left half restored) |
| migrate | the restored schema is brought forward to this build | a contract migration without approval |
| facts | restored row counts equal the counts recorded under the snapshot | any differs |
| epoch | the epoch is bumped (idempotent per `--run-id`) and the work list opened | n/a |
| temporal | open `op-*` / `reconcile-*` workflows are terminated (`--terminate-temporal`) | the CLI fails; otherwise handed to a person |

The hosted sealed bundle is **handed off**: restore it with `npm run hosted:restore` (it reconciles revocations and leaves
apps recovering), then `npm run hosted:reopen`. `--observed-epoch` is the highest epoch the lost system reached if you know
it (the new epoch is one past the highest of the database, the manifest and this value). The report
(`RESTORE-REPORT` JSON at `--report`) lists every step, the epoch bump counts, the RPO and RTO and what still needs a person.

If the target role differs from the source (for example Supabase roles), add `--no-privileges` and re-apply the emitted
platform SQL as described in RECOVERY.md section 2.1.

## Operator continuation: decide every in-flight item

The bump opens one **recovery item** per operation, intent and external effect that was in flight in the restored data.
Nothing resumes on a timer; a person decides each, bound to the exact state they reviewed.

| Item | Allowed decisions |
| --- | --- |
| Operation that was `running` (now `uncertain`) | `keep_uncertain` (acknowledge). It is never resumed; a new proposal is a new authorization. |
| Operation that was proposed, awaiting approval, approved or queued | `resume` reopens it with a fresh approval round in the new epoch (someone must approve again; refused if a workflow start was already attempted, if effects are unresolved, or if it expired). `abandon` cancels it. |
| Pending durable intent | `resume` re-stamps it so the relay may deliver it (delivery is idempotent by intent id); `abandon` supersedes it. |
| External effect | `keep_uncertain` only. Resolve it with the evidence-bound flow (`POST /api/platform/v1/effects/:id/resolve`). |

```bash
npm run ops:recovery -- status [--workspace W]                    # epoch, items opened/decided/pending
npm run ops:recovery -- continue list --workspace W --state pending
npm run ops:recovery -- continue resume --workspace W --item ri_â€¦ --binding <digest> --actor alice --reason "reviewed"
```

The same decisions are available to a signed-in workspace admin in the browser:
`GET /api/platform/v1/recovery` (epoch, items, `bindingDigest`, reasons a resume would be refused) and
`POST /api/platform/v1/recovery/items/:id/decide` (browser session only; an agent credential is refused). The CLI path is
the operator's break-glass with database credentials and is recorded as `operator:<name>`.

## RPO and RTO

Measured from recorded instants, never asserted. RPO = loss time minus `platform.snapshotAt` (without `--incident-at` the
report gives the backup age at restore start, an upper bound, and says so). RTO = fenced-and-verified time minus the loss
time (or the restore duration alone). `status` reports continuation: how long the person took to decide every item. Targets
(`ZENITH_RPO_TARGET_SECONDS`, `ZENITH_RTO_TARGET_SECONDS`) are compared and labelled provisional; with none set the verdict
is `no_targets`. PROD-OPS-01 hooks attach through `registerRecoveryMeasurementSink`; absent, the plain JSON report is the
record.

## Rehearse it

`tests/ops/recovery-rehearsal.test.ts` does the whole thing on real PostgreSQL (and a Temporal dev server when the CLI is
present): seed work in every state, back up, let the "lost timeline" consume an approval after the snapshot, restore into an
empty database, and prove the consumed approval cannot run, the pending effect stays uncertain, and a fresh approval in the
new epoch runs exactly once. See the verify document for the commands.
