# PROD-OPS-07 Configurable non-destructive retention

Status: built and typechecked, NOT run (build-only worker). Branch `prod/ops-07-w5`, migration 45.
DEC-RETENTION is pending: nothing is deleted by default, and the default policy retains everything forever.

## 1. What was built

Library `src/lib/retention/`:
- `classes.ts` data classes and hard invariants. Four archivable/prunable classes only (`runner_job_logs`, `machine_request_logs`, `resource_observations`, `drift_reports`); `NEVER_PRUNABLE` lists the protected tables (operations, approvals, events/audit, evidence, receipts, effect ledger, idempotency and nonce replay records, authority, custody, job and request rows, mixed run ledgers, holds, archive manifests). `assertPrunableClass` runs before any statement is built.
- `policy.ts` policy schema + loader (`ZENITH_RETENTION_POLICY_FILE` or inline `ZENITH_RETENTION_POLICY`, both set is refused; invalid policy means retain everything). Per class `archiveAfterDays` / `pruneAfterDays`, per-workspace overrides, optional `approval` (DEC-RETENTION) record. Protected names and unknown classes are refused with the reason; `pruneAfterDays` requires an earlier-or-equal `archiveAfterDays`. `retentionApplyGate(env, load)` copies the OPS-06 gating shape: `ZENITH_RETENTION_APPLY=1` AND an approval record in a valid policy.
- `store.ts` eligibility SQL (settled parent, keep-latest, hold predicate), legal holds (create/release/list under an advisory lock), archive records, `previewRetention` dry run.
- `archive.ts` archive target from env (`ZENITH_RETENTION_ARCHIVE_TARGET=filesystem|s3` with `_DIR` / `_S3_BUCKET` / `_S3_ENDPOINT`, reusing `FilesystemTarget`/`S3Target`), `archiveBatch` (copy only, sealed with the backup AES-GCM crypto under `ZENITH_BACKUP_KEY`, workspace-prefixed content-derived key, readback + unseal + digest compare before recording) and `pruneArchive` (re-verifies the object, deletes only manifest ids, re-checks age, settled parent, keep-latest and holds inside the DELETE under the holds lock).
- `job.ts` `retentionPass`: per-workspace window candidate query, bounded batches, archive then (only with gate open) prune.
- `overview.ts` read model shared by the API and page.

Wiring (reachable):
- `src/lib/platform/critical-jobs.ts`: new durable critical job `data-retention` (registry + `MAINTENANCE_JOBS`), so the Temporal critical-maintenance schedule runs it; `scripts/data-retention.ts` is the cron-less operator trigger under the same lease.
- `GET /api/admin/ops/retention` overview + dry-run preview; `POST /api/admin/ops/retention/preview` preview of a candidate policy (never stored); `GET|POST|DELETE /api/admin/ops/retention/holds`. All platform-operator only (`ZENITH_OPS_ADMIN_IDS`), same-origin for writes.
- Page `/admin/retention` (operator only): status cards, per-class dry-run table, sample rows that would be pruned, hold list with place/release, recent archives, never-removed list. No nav link was added to the waitlist-owner shell (different audience); open it by URL.
- Migration `0045_retention.ts` registered in `migrations/index.ts`.

No change to OPS-06 `minimize.ts`; the retention gate mirrors its pattern and is independent of `ZENITH_DATA_MINIMIZE_APPLY`.

## 2. Acceptance mapping

| Clause | Implementation | Tests |
|---|---|---|
| Policy schema per OPS-06 class, windows, defaults retain forever, loaded from config | `policy.ts`, `classes.ts` | `tests/retention/retention.test.ts` "policy schema and gate" |
| Durable archive job, copy to tenant object storage with integrity manifest and readback, source untouched unless apply gate | `archive.ts`, `job.ts`, critical job `data-retention` | "archive: copy only, sealed, read back" (sealed object, manifest digest, corrupt/lost/failed target records nothing, idempotent) |
| Legal holds tenant/resource/time scoped block archive-delete and prune | `store.ts` (`classSql().held`, `pruneSql`, holds lock), migration 45 | "legal holds" (tenant, job, operation, time range, other class, release, immutability, other tenant) |
| Dry-run preview API/page with counts per class and what would be pruned | `previewRetention`, routes, `/admin/retention` | "dry-run preview", `tests/retention/admin-routes.test.ts` "overview and preview" |
| Hard invariants: active operations, audit, approvals, receipts, effect ledger, replay records never prunable | `NEVER_PRUNABLE`, `assertPrunableClass`, settled-parent and keep-latest SQL, policy refusal | "hard invariants" (statement tables, refusal of every protected name, gate-open run leaves protected tables and unsettled job logs untouched) |
| Deletion gated (DEC-RETENTION pending) | `retentionApplyGate`, `pruneArchive` throws without gate | "opens the delete gate only with...", "deletes nothing without the gate...", "pruneArchive cannot be called without the apply gate" |
| Prune only archived data | prune by verified-manifest ids, re-verified at prune time | "refuses to prune when the archive object can no longer be verified", late-row survival |

## 3. Verification commands (other machine)

```
export PATH="/c/Users/user/.local/sdk/node22:$PATH"
npx vitest run tests/retention
npx vitest run tests/platform/critical-jobs.test.ts tests/sensitivedata tests/security tests/controlplane/migrations.test.ts
npx tsc --noEmit -p . && npx eslint src/lib/retention src/app/api/admin/ops/retention src/app/admin/retention scripts/data-retention.ts tests/retention
```
Expected: all pass on PGlite; no env vars needed (keys are generated at runtime, archive target is a temp directory). Not run by the worker. Things most likely to need a fix on first run: SQL typing of the tuple comparisons `(timestamptz, bigint|text) >= (...)` and `make_interval(days => case ...)` in `job.ts`/`store.ts` on PGlite; `jsonb_exists($n::jsonb, text)`; the `delete ... using` alias form in `pruneSql`; `pg_advisory_xact_lock` on PGlite; the Postgres-lane run of the same tests (`ZENITH_TEST_PLATFORM_PG_URL`) was not added (these tests use PGlite only).

Live check (manual, not counted): `ZENITH_RETENTION_ARCHIVE_TARGET=s3` against LocalStack with a policy file, run `npx tsx --env-file-if-exists=.env.local scripts/data-retention.ts`, confirm sealed objects under `retention/<workspace>/<class>/`.

## 4. Gaps, assumptions, shared-file updates for the assembler

Known gaps:
- "Tenant-owned object storage" is one operator-configured bucket/directory per install with workspace-prefixed keys, sealed with the install backup key. Per-tenant buckets and per-tenant keys are not implemented.
- Archive restore tooling is not built (objects are sealed JSON with a manifest and can be opened with the backup crypto helper). Archiving is not a backup of the protected tables.
- The dry-run preview counts with full-table scans per workspace (bounded to 100 workspaces) and recorded-time columns are not all indexed; acceptable for operator use, would need indexes at large scale.
- Archive coverage is a per-(workspace, class) watermark; a row committed late with an older recorded time than the watermark is never archived and therefore never pruned (safe failure).
- Archive key rotation: pruning refuses an archive sealed under a different key id than the current `ZENITH_BACKUP_KEY` (it stays unpruned).
- The page is operator-gated but not linked from the existing admin nav.
- Other classes from the OPS-06 inventory (events, evidence, runbook audit, etc.) are deliberately outside retention; they stay retain-forever until a future decision.

Shared-file updates the orchestrator must make:
- Migrations inventory / emit-sql / supabase migration for version 45 (`platform.legal_holds`, `platform.retention_archives`); versions 42-44 belong to siblings.
- `src/lib/sensitivedata/inventory.ts`: classify `platform.legal_holds` (classification `personal-data`: created_by/released_by actor ids, free-text reason; retention `ledger`) and `platform.retention_archives` (`operational`; object key, digests, row id range; retention `ledger`). Update the `Retention` note of `runner_job_logs`, `machine_request_logs`, `resource_observations`, `drift_reports` to "archive then prune per PROD-OPS-07 policy; default retain forever". Updating `agent_effect_receipts` and ledger tables is unnecessary (still never pruned).
- Tenancy classification for `tenancy.test.ts` / SQL scoping (functions live in `src/lib/retention/store.ts`, not exported through `controlplane/db/repos`): `createHold`, `releaseHold` (when workspaceId given), `archiveWatermark`, `recordArchive`, `markPruned`, `deferArchive` WORKSPACE-BOUND; `listHolds`/`listArchives`/`archivesToPrune`/`previewRetention`/`pruneSql`/`classSql` SYSTEM operator reads or statement builders (counts and ids only). `releaseHold` without workspaceId is an operator-wide release by id.
- Gate manifest: add `tests/retention/**` to the relevant lane; ledger/LIMITATIONS: DEC-RETENTION still pending, mechanism built.
- `docs/platform/operations/DEPLOYING.md` and `docs/platform/operations/SENSITIVE-DATA.md`: document the new env vars (`ZENITH_RETENTION_POLICY_FILE`, `ZENITH_RETENTION_POLICY`, `ZENITH_RETENTION_APPLY`, `ZENITH_RETENTION_ARCHIVE_TARGET`, `ZENITH_RETENTION_ARCHIVE_DIR`, `ZENITH_RETENTION_ARCHIVE_S3_BUCKET`, `ZENITH_RETENTION_ARCHIVE_S3_ENDPOINT`) and the `data-retention` job/CLI. Any tick-status test that enumerates `CRITICAL_JOB_NAMES` should expect the new durable-only job.

Example policy file (provisional windows, for evaluation only; a real policy needs the DEC-RETENTION decision):
```json
{ "version": 1,
  "classes": { "runner_job_logs": { "archiveAfterDays": 30, "pruneAfterDays": 90 } },
  "approval": { "decision": "DEC-RETENTION", "approvedBy": "<decider>", "approvedAt": "<ISO time>" } }
```
Omit `approval` (or leave `ZENITH_RETENTION_APPLY` unset) to archive without ever deleting.

## 5. Suggested ledger implementationStatus

"Built (mechanism): retention policy schema, sealed verified archive job, legal holds, dry-run preview API/page and never-prunable invariants; deletion gated on DEC-RETENTION approval plus ZENITH_RETENTION_APPLY=1, default retain forever; tests written, awaiting verification; per-tenant storage and restore tooling not built."

## 6. Follow-up: tenant destinations, restore tooling, nav (same migration 45, edited in place)

Built:
- Tenant-owned destinations (`src/lib/retention/destination.ts`, migration tables `platform.retention_destinations`, `archives.destination_id/label`). A workspace admin sets `PUT /api/workspace/retention-destination { environmentId, resourceAddress, credentialsRef }` (GET/DELETE too; admin role, same-origin). It reuses the LIFE-11 shape: an `object_store` resource of the workspace's environment (not `external`), credentials read through the brokered `createSecretResolver` path, the secret's bucket must equal the resource's bucket, and a marker is written and read back before acceptance. New archives of that workspace go to `s3://<bucket>/zenith-retention/`; with none configured they go to the operator bucket (fallback). A configured destination that stops resolving PAUSES archiving for that workspace (`destinationUnavailable` count) and never falls back to the operator bucket (that would move tenant data somewhere the tenant did not choose). Verify, restore and prune open the destination an archive was recorded in. Archives are still sealed with the install `ZENITH_BACKUP_KEY` (per-tenant keys not built).
- Restore tooling (`src/lib/retention/restore.ts`): `verifyArchive` (unseal, digest, count, id range, workspace) and `restoreArchive` (modes `staging` into schema `retention_stage_<suffix>`, or `source`; optional `rowIds`). Verification must pass first. Source restore is `INSERT ... ON CONFLICT DO NOTHING` (never overwrites an existing or newer row, idempotent), skips rows whose parent is gone (counted), inserts only the archive's workspace rows. Rows are read back and compared; every attempt incl. refusals is written to append-only `platform.retention_restores`. Surfaces: `scripts/retention-archive.ts list|verify|restore`, `GET /api/admin/ops/retention/archives`, `POST .../archives/:id/verify`, `POST .../archives/:id/restore` (operator only).
- Nav: `Data retention` link in the admin shell nav (`admin-shell.tsx`), shown only to platform operators (`ZENITH_OPS_ADMIN_IDS`) via `showRetention` from `admin/page.tsx`.

Tests: `tests/retention/restore-destination.test.ts` (verify/tamper/wrong key, staging and source restore, idempotence, never-overwrite, selective ids, parent-missing skip, refusals and audit, append-only audit, tenant destination validation, routing to tenant vs operator, no silent fallback, revoke, immutability), route cases appended to `tests/retention/admin-routes.test.ts`. Tenant bucket is an in-memory S3 client double under the real `S3ObjectStore`; not run by the worker.

PGlite/portable-SQL risks to check first (highest first):
1. `restore.ts`: `insert into t overriding system value select r.* from jsonb_populate_recordset(null::platform.t, $1::jsonb) r ... on conflict do nothing returning id::text` (identity override, record-set expansion, column order = table order) and staging `create table ... (like platform.t including defaults, primary key (id))`.
2. `job.ts`/`store.ts`: tuple comparison `(timestamptz, bigint|text) >= (...)`, `make_interval(days => case when jsonb_exists($3::jsonb, l.workspace_id) then ($3::jsonb ->> l.workspace_id)::int else $2::int end)`.
3. `store.ts` `pruneSql`: `delete from t l using parent p`; `pg_advisory_xact_lock(hashtext(...))`.
4. Migration trigger tuple comparisons (`is distinct from` on row constructors) in the guard functions.
Where it was easy the SQL avoids driver-specific array parameters (ids go as one JSON parameter through `jsonb_array_elements_text`).

Additional shared-file items: inventory classification for `platform.retention_destinations` (operational; vault reference, no secret; ledger) and `platform.retention_restores` (personal-data: actor id; immutable). Tenancy: destination functions are WORKSPACE-BOUND (`getActiveDestination`, `getDestination`, `createDestination`, `revokeDestination`); `listDestinations()` without workspace and `listArchives` are SYSTEM operator reads; restore statements are bound by the archive's workspace_id. New env: none beyond section 4; `scripts/retention-archive.ts` documented in its header.

Limits: no workspace-admin UI for the destination (API only); restore of a tenant archive after its destination is revoked works only while the credentials still resolve; the 500-row archive batches mean large restores are many objects; restore to `source` does not re-create deleted parents.
