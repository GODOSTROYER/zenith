> Assembly note (wave 4): this migration was authored as version 42 and is registered as version 39 in `prod/compose` (aggregate `0023_platform_core.sql`). Read "42" below as 39; the file is now `0039_key_custody.ts`.

# PROD-OPS-05 and PROD-OPS-06: purpose-separated key custody, sensitive persistence minimization

Branch `prod/ops-05-06-w4`, base `c9a942d6`. Platform migration 39 only. Built without running any test: the
verifying machine runs everything below. Live cloud acceptance is deferred; nothing here calls a cloud API, a live
Temporal server or a live Postgres. Evidence is contract and local engine (PGlite, real file store, real
redactors and sealers).

## DEC-RETENTION gate

No retention policy is approved. `data-minimize` is a **dry run by default** (counts of candidates only). Deleting sealed result bodies needs `ZENITH_DATA_MINIMIZE_APPLY=1` plus an explicit `ZENITH_RESULT_RETENTION_HOURS`; no default window applies. Only `result` bodies are removed, never rows that DUR-07/08 receipts, the external-effect ledger, approvals or audit evidence depend on (receipts and the job row stay). The one-hour temporary `agent.agent_uploads` sweep stays active (no receipts or evidence exist for them). Wherever this document says results are removed or default 72 hours, read it as apply mode only.

## 1. What was built

### PROD-OPS-05 key custody

| Area | Files |
| --- | --- |
| Registry: purposes, roles, refusal, separation findings | `src/lib/keycustody/purposes.ts`, `src/lib/keycustody/registry.ts` |
| Durable records: key facts, retirement dates, re-wrap jobs (migration 39, 2 tables) | `src/lib/controlplane/db/migrations/0039_key_custody.ts` (registered in `index.ts`), `src/lib/keycustody/store.ts` |
| Durable re-wrap on the scheduler (`key-rewrap` critical job) | `src/lib/keycustody/rewrap-job.ts`, `src/lib/keycustody/product-db.ts`, `rewrapVaultStep` in `src/lib/secrets/rewrap.ts`, `src/lib/platform/critical-jobs.ts` |
| Operator diagnostics and codec diagnostic | `src/lib/keycustody/diagnostics.ts`, `scripts/key-custody.ts` |
| Start-up refusal and boot warning | `src/lib/keycustody/startup.ts`, `workers/execution/startup.ts`, `src/lib/platform/app.ts` |
| Consumers resolved through the registry | `src/lib/secrets/index.ts` (`vaultCipherFromEnv`), `src/lib/runners/seal.ts` (key ids, decrypt-only previous keys), `src/lib/machines/persistence.ts` (`machineResultSealer` previous roots), `src/lib/workflows/codec.ts` (dedicated `ZENITH_TEMPORAL_PAYLOAD_KEY`), `src/lib/runners/runtime.ts` (cache fingerprint) |
| Docs | `docs/platform/operations/KEY-CUSTODY.md` |

Key usage audit (vault rewrap, Temporal codec and mTLS, runner/release signing, plugin publisher keys, plan custody,
hosted backups, agent-link and invite sealing) is the table in `KEY-CUSTODY.md`. Findings that drove changes:
result sealing derived its key from the signing key and had no key ids or rotation; machine results had no
decrypt-only overlap; Temporal had no independent root; release keys were not checked for presence on the control
plane. Findings recorded but not changed: agent-link and invite sealing use `ZENITH_SECRET_KEY` directly with no
overlap (short-lived, fail closed), hosted backups have no decrypt-only list, plan custody owns its own rewrap.

### PROD-OPS-06 sensitive persistence

| Area | Files |
| --- | --- |
| Inventory of every table, sensitive column, artifact, log and telemetry sink, with class, protection, retention, assurance | `src/lib/sensitivedata/inventory.ts`, `scripts/sensitive-inventory.ts` |
| Encryption-at-rest checks for every sealed column | `src/lib/sensitivedata/at-rest.ts`, `scripts/sensitive-data-census.ts` |
| Minimization (`data-minimize` critical job) | `src/lib/sensitivedata/minimize.ts`, `scripts/data-minimize.ts`, `src/lib/platform/critical-jobs.ts` |
| Log sink redaction | `src/lib/log.ts` |
| Leak suite and inventory guard | `tests/security/persistence-leaks.test.ts`, `tests/security/sensitive-inventory.test.ts`, `tests/_support/security/persistence.ts` |
| Docs | `docs/platform/operations/SENSITIVE-DATA.md` |

Unnecessary persistence removed: sealed result bodies in `runner_jobs` and `machine_requests` after
`ZENITH_RESULT_RETENTION_HOURS` (default 72); expired `agent.agent_uploads` swept every tick; log fields and error
stacks now redacted before the sink. Not removed (reasons in `SENSITIVE-DATA.md`): immutable effect receipts,
plan custody tables, job and request log lines, evidence, events (retention is PROD-OPS-07, deletion awaits policy).

### Behaviour changes to verified code (explicit)

- `vaultCipherFromEnv` now resolves keys through the registry and accepts `{ purpose }`. Messages and semantics are unchanged (tests/secrets/rewrap.test.ts must still pass).
- `createAesResultSealer` boxes gain an optional `kid`; id-less boxes still open. `createResultSealerFromEnv` keeps its refusals (still `RunnerConfigError`), and with an explicit `ZENITH_RUNNER_RESULT_KEY` the legacy signing-key derivation is kept decrypt-only (so results sealed before the explicit key still open).
- `machineResultSealer(secretKey, previousRoots?)` defaults previous roots to the vault previous list.
- `log.ts` redacts every string field and stack; Dates, Buffers and `toJSON` objects pass through as before; a cycle logs `[Circular]` instead of dropping all fields.
- The critical-job registry has two more jobs (`key-rewrap`, `data-minimize`), both `durableOnly`: a durable-only job that never ran does not make `criticalJobHealth().healthy` false (no Temporal scheduler installed); one that ran and went stale does. No cron fallback was added (tests/server/cron-housekeeping.test.ts pins the exact fallback list); the operator CLIs run the jobs under the same lease instead.
- Worker start-up now also refuses shared key material between purposes or a release private key on the control plane.

## 2. Acceptance mapping

PROD-OPS-05: "Production signing and vault/result/Temporal encryption rotation retain decrypt-only histories with
separated purposes and safe operator codec diagnostics."

| Clause | Implementation | Tests |
| --- | --- | --- |
| Explicit purpose per key; refusal outside purpose or role | `purposes.ts`, `KeyRing.materialFor/useKey` | `tests/keycustody/registry.test.ts` (purpose and role refusal, per-purpose config errors, not-built rings) |
| Separated purposes, no shared material | separation findings, start-up check | registry.test.ts (reuse, offline release key, signing key kid, plugin/attestation verify-only), `custodySeparationErrors` |
| Vault rotation keeps decrypt-only history | `vaultCipherFromEnv` through the ring | registry.test.ts (vault cipher parity, plan purpose), `tests/secrets/rewrap.test.ts` (existing) |
| Result rotation keeps decrypt-only history | `seal.ts` key ids, previous keys, legacy derivation | registry.test.ts (rotation, dropped key fails closed, legacy box, derived-key migration) |
| Machine artifacts and Temporal rotation | `machineResultSealer`, `codec.ts` | registry.test.ts (machine, Temporal id parity, dedicated key), existing `tests/workflows/codec*.test.ts` |
| Signing rotation | registry reports current/verify-only ids | registry.test.ts (control JWK + extra public JWKS, private member refused) |
| Retirement dates | `platform.key_custody_keys`, `setRetireAfter`, `markRetired` | `tests/keycustody/rewrap-job.test.ts` (store), diagnostics-cli.test.ts (overdue/scheduled/unscheduled/retired) |
| Rewrap jobs on the durable scheduler | `key-rewrap` in `MAINTENANCE_JOBS`/`CRITICAL_JOBS` (Temporal critical-maintenance activity), `keyRewrapPass`, `rewrapVaultStep` | rewrap-job.test.ts (batches, resume, idempotent, unreadable row, blocked file store, transient error, critical job run record, CLI `--run`) |
| Safe operator codec diagnostic | `scripts/key-custody.ts codec`, `inspectTemporalPayloads` | diagnostics-cli.test.ts (classification without decrypting; `--verify` prints counts only; no plaintext or key in output) |
| Key ids, purposes, ages, no material | `scripts/key-custody.ts diagnose`, `buildKeyReport` | diagnostics-cli.test.ts (no material in text or JSON, exit codes), registry.test.ts (inspect/JSON never carry material) |

PROD-OPS-06: "Protect unavoidable raw plans/state, minimize persistence and test leaks; no claim redaction catches
every unknown secret."

| Clause | Implementation | Tests |
| --- | --- | --- |
| Inventory of every table, column, artifact, log sink with classification and retention | `inventory.ts` | `sensitive-inventory.test.ts` (completeness both directions against all migrations, consistency rules) |
| Unavoidable raw plans/state protected | plan custody sealed under `enc:plan-artifacts` (DUR-C owns); plan files host-protected; census of sealed columns | sensitive-inventory.test.ts (secret/raw-plan must be sealed or host-protected), `atRestCensus` tests, existing `tests/security/plan-artifact-secrecy.test.ts` |
| Encryption-at-rest checks per sealed store | `at-rest.ts`, `scripts/sensitive-data-census.ts` | sensitive-inventory.test.ts (accepts ciphertext, rejects plain-looking values, census on PGlite), persistence-leaks.test.ts (census after seeding, PGlite lane) |
| Minimize persistence | `minimize.ts`, `data-minimize` job, `log.ts` | `tests/sensitivedata/minimize.test.ts` (window, limit, machine requests, uploads, receipts untouched, retry never echoes) |
| Leak tests through API, MCP/agent path, logs, evidence, telemetry, model-visible results | `persistence-leaks.test.ts` with runtime canaries | same file: vault, actions API, broker proposal, logs, telemetry, model results, Temporal payloads, events, evidence, connections, job logs and results |
| No claim that redaction catches every secret | classification vocabulary, characterization tests, docs | the `LIMIT (characterization)` tests; `SENSITIVE-DATA.md` |

## 3. Verification commands (verifying machine)

Node 22. The migration must be applied: PGlite suites migrate in process. Assemble migrations 30-41 first if the
verifier merges branches (the migrator itself tolerates the gap; only `tests/controlplane/migrations.test.ts` needs
contiguity).

```
npx vitest run tests/keycustody tests/sensitivedata tests/security/sensitive-inventory.test.ts tests/security/persistence-leaks.test.ts
# expected: all pass; `LIMIT (characterization)` cases pass by asserting the limit exists.
# optional second lane for the leak suite and controlplane harness:
ZENITH_TEST_PLATFORM_PG_URL=postgres://... npx vitest run tests/security/persistence-leaks.test.ts

# behaviour that must not regress
npx vitest run tests/secrets tests/runners tests/machines tests/workflows/codec.test.ts tests/workflows/codec-wiring.test.ts \
  tests/workflows/critical-schedule.test.ts tests/platform tests/server tests/security tests/controlplane tests/capabilities
npx vitest run tests/docs/operator-docs.test.ts   # fails until the DEPLOYING.md rows below are added (see section 4)

# CLI smoke (no database): ids, purposes, roles only
npx tsx scripts/key-custody.ts diagnose --no-db
npx tsx scripts/sensitive-inventory.ts --only unreviewed
# with a Postgres platform store and migration 39 applied
npx tsx --env-file-if-exists=.env.local scripts/key-custody.ts sync
npx tsx --env-file-if-exists=.env.local scripts/key-custody.ts rewrap --workspace <id> --run
npx tsx --env-file-if-exists=.env.local scripts/sensitive-data-census.ts
npx tsx --env-file-if-exists=.env.local scripts/data-minimize.ts
```

Typecheck and lint were run on this branch (`npx tsc --noEmit -p .`, `npx eslint` on the changed files); no test was run.

## 4. Known gaps, risks, and shared-file updates for the orchestrator

Shared-file updates (not touched here):

1. **Migrations inventory**: version 39 `key_custody`: tables `platform.key_custody_keys` (system-level, no `workspace_id`, non-secret key facts) and `platform.key_rewrap_jobs` (workspace-owned). RLS enabled, `anon`/`authenticated` revoked, `service_role` select/insert/update, following 0021/0022. Regenerate `supabase/migrations/0021_platform_core.sql` via emit-sql, update DEPLOYING.md migration list and `tests/controlplane/migrations.test.ts` as usual.
2. **Tenancy classification**: the store functions live in `src/lib/keycustody/store.ts`, deliberately outside `src/lib/controlplane/db/repos/`, so `tests/controlplane/tenancy.test.ts` and `tests/security/controlplane-sql-scoping.test.ts` (which scan `repos/*.ts`) do not see them; they were not added to `repos/index.ts`. Classification if you prefer to move them: `recordKeys`, `listKeys`, `setRetireAfter`, `markRetired`, `claimRewrapJob` (exempt: system key facts / system scheduler claim, every returned row carries its workspace and later calls use it), `enqueueRewrapJob`, `advanceRewrapJob`, `finishRewrapJob`, `getRewrapJob`, `listRewrapJobs(workspaceId)` (workspace-bound; the no-workspace form is the operator system view), `rewrapBacklog` (system counts).
3. **DEPLOYING.md variable rows** (`tests/docs/operator-docs.test.ts` requires every `ZENITH_*` name in `src/lib/runners`, `src/lib/workflows`, etc. to be documented): `ZENITH_RUNNER_RESULT_PREVIOUS_KEYS` (JSON array of 32-byte base64url keys, decrypt-only), `ZENITH_TEMPORAL_PAYLOAD_KEY` (64 hex, dedicated Temporal payload root; client and worker must agree; old root goes into `ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS`). `ZENITH_RESULT_RETENTION_HOURS` (1 to 720, no default for deletion; also needs ZENITH_DATA_MINIMIZE_APPLY=1) is read in `src/lib/sensitivedata`, outside the checked roots, but should be documented with them. Also update the `ZENITH_RUNNER_RESULT_KEY` row (rotation now has a previous list and key ids) and add `docs/platform/operations/README.md` rows for `KEY-CUSTODY.md` and `SENSITIVE-DATA.md`.
4. **Critical jobs**: two new jobs (`key-rewrap`, `data-minimize`) ride the existing `criticalMaintenanceWorkflow`; the workflow result validation checks only the original six keys, so no workflow contract change. Add them to any gate manifest or status documentation that lists critical jobs. `tests/workflows/critical-schedule.test.ts` fixtures need no change.
5. **Inventory guard after merge**: wave-3 tables (DUR-01..08, OBS-01, MACH-02/06, UX-02, LIFE-07) add platform tables. `tests/security/sensitive-inventory.test.ts` will fail until each new table and sensitive-looking column has an entry in `src/lib/sensitivedata/inventory.ts` (the failure lists them). This is the intended guard; the assembler or the wave owners add entries.
6. **LIMITATIONS.md**: suggested lines are in section 5.

Hooks needed from plan-artifacts / custody internals (wave 3 DUR-C; not edited here):

- `planArtifactCipherFromEnv` may call `vaultCipherFromEnv(process.env, { purpose: "enc:plan-artifacts" })` instead of mapping its variables onto `ZENITH_SECRET_KEY`, so the registry owns the parsing and the previous-key overlap for plan custody. Its own separation checks can then be replaced by `KeyRing.violations()`.
- `platform.plan_artifacts.manifest` is plaintext next to the ciphertext (addresses and digests); the inventory marks it `unreviewed`. DUR-C should confirm it holds no values.
- A plan rewrap job kind (`enc:plan-artifacts`) is not implemented: `key_rewrap_jobs.purpose` is restricted to `enc:vault` in migration 39. Extending it needs a later migration owned by plan custody.
- The agent effect receipts (`sealed`, immutable by trigger) keep a sealed copy of every outcome forever under the result key; the retention policy (PROD-OPS-07) must decide how receipts age out, and removing a result key makes old receipts unreadable.

Things that may break first:

- `tests/docs/operator-docs.test.ts` until item 3 is done.
- `tests/controlplane/migrations.test.ts` until item 1 is done.
- `tests/security/sensitive-inventory.test.ts` once wave-3 tables land (item 5).
- The `inventory` completeness regexes read `create table ... (\n ... \n);` blocks; a migration that formats DDL differently would be missed (the test also asserts it finds the expected tables, so it cannot pass by reading nothing).
- `verifyOpaqueBytes` is heuristic (nonce plus tag length, not JSON, not mostly printable); it cannot prove encryption.
- The leak suite's Postgres lane scans every row of the shared `platform` schema; large shared databases make it slow.

Limitations not claimed away:

- Redaction and write guards are shape based. A secret with no recognisable shape sent to events, evidence, log lines, log fields or model results is stored or returned (pinned by the characterization tests). The only protection for such a secret is not sending it there.
- `public.*` legacy product tables, hosted app records and agent operation documents are inventoried from their migrations only (`unreviewed`, 25 columns, ratcheted); their protection is access control.
- Key ages come from first sight by a process, not key generation time. There is no HSM, no enforced rotation deadline, and no live KMS or Temporal Cloud acceptance.
- Backups (`ZENITH_BACKUP_KEY`) have no decrypt-only list; agent-link and invite sealing have no overlap.
- The durable re-wrap covers vault rows on the Postgres product store; the file store needs the quiesced `scripts/vault-rewrap.ts`; plan custody rewrap belongs to DUR-C; Temporal history cannot be re-wrapped, only kept readable.
- `live_sandbox` and `operational_rehearsal` evidence for both requirements is not produced here (live cloud acceptance is deferred; no key-rotation drill was run against a real Temporal namespace or KMS).

## 5. Suggested ledger text

- `PROD-OPS-05` implementationStatus: `built_unverified: key registry with per-key purpose and role, refusal outside purpose, decrypt-only histories for vault/result/machine/Temporal keys, durable key-rewrap critical job, retirement records (migration 39), operator diagnose and Temporal codec CLI; contract and local-engine tests written, not run; no live KMS, Temporal Cloud or rotation-drill evidence`
- `PROD-OPS-06` implementationStatus: `built_unverified: complete sensitive persistence inventory with a both-direction migration guard, at-rest census, data-minimize critical job, log redaction, and a runtime-canary leak suite across API, agent broker, logs, telemetry, model results, Temporal payloads and stores; characterization tests pin that unrecognised secrets are not caught; tests written, not run; no live evidence`
- LIMITATIONS.md: redaction and write guards recognise shapes only (an unknown secret in free-text stores, logs or model results is not removed); legacy product tables and hosted app data are inventoried but unreviewed and protected by access control; effect receipts retain a sealed copy of every outcome until PROD-OPS-07; backups, agent-link and invite sealing lack decrypt-only overlap.
