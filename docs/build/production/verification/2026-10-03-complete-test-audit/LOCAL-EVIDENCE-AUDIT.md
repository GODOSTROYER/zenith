# Every local skipped test: reason and separate evidence

This audit reads retained reports. It ran no tests, compiler, service or provider operation. The fresh public run is exact 9e62a15; staging356 is separate unmerged source. Counts overlap across lanes and must never be summed. Assertion ordinals preserve repeated parameterized display names.

## Lane results

| Lane | Source | Files | Passed | Failed | Skipped |
|---|---|---:|---:|---:|---:|
| public-unit | 9e62a15 | 807 | 16462 | 0 | 364 |
| staging-unit | 356b7d0 | 812 | 16842 | 0 | 212 |
| staging-tofu | 356b7d0 | 122 | 3900 | 0 | 8 |
| staging-workflows | 356b7d0 | 45 | 1000 | 0 | 0 |
| staging-platform-postgres | 356b7d0 | 52 | 1532 | 0 | 0 |
| staging-supabase | 356b7d0 | 9 | 251 | 0 | 0 |
| staging-policy | 356b7d0 | 7 | 238 | 0 | 0 |
| fresh-uncovered-postgres | 9e62a15 | 5 | 153 | 0 | 0 |

Fresh unit: 807 files; 37 duplicate file/name groups, 74 extra occurrences, 25 affected files. No duplicate is deduplicated. Ancestor-suite headers are not file counts. Headers agree with actual assertion sums.

## Why the fresh 364 assertions were skipped

| Source-guard reason | Assertions |
|---|---:|
| Authorized live hosted-service fixture | 13 |
| Authorized private GitHub App fixture | 1 |
| Authorized public GitHub network fixture | 1 |
| Broken shell prerequisite detection | 13 |
| Different operating system | 1 |
| Disposable Kubernetes cluster opt-in | 7 |
| Explicit real-network opt-in | 1 |
| External mTLS acceptance opt-in | 2 |
| Intentionally different backend | 1 |
| Local Temporal server prerequisite | 117 |
| Missing executable alias | 6 |
| Nonportable stale path prerequisite | 1 |
| OpenTofu template test opt-in | 1 |
| Provider-schema network opt-in | 58 |
| Real PostgreSQL opt-in | 138 |
| Separate Temporal history opt-in | 2 |
| Separate real-OpenTofu removal opt-in | 1 |

Separate opt-in pass matches require a unique same file/fullName and unchanged test-file bytes. A canonical file association alone is not proof of a particular case. A matching pass does not change the original skipped outcome.

## Complete public-unit skip catalogue

### tests/acceptance/sample-app.test.ts (1 skipped)

Reason: **Explicit real-network opt-in**. ZENITH_TEST_NETWORK=1 is required for the non-routable TCP timeout check. The default unit run disables this opt-in.

Guard references: `9e62a15:tests/acceptance/sample-app.test.ts:10`; `9e62a15:tests/acceptance/sample-app.test.ts:14`; `9e62a15:tests/acceptance/sample-app.test.ts:26`

- Assertion 1: acceptance fixture real Node HTTP app real non-routable TCP: /db times out and /health remains 200 (network opt-in required). No separately matched unchanged-source pass in this audit.

### tests/agent-control-journal-fixes.test.ts (6 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `9e62a15:tests/agent-control-journal-fixes.test.ts:469`

- Assertion 24: postgres agent journal: lease, un-approve and the queue (live) refuses a finalize after the lease lapsed, and the row is resolved as uncertain, never as a success. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 25: postgres agent journal: lease, un-approve and the queue (live) still finalizes while the lease holds. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 26: postgres agent journal: lease, un-approve and the queue (live) withdraws an approval: phase, columns and document all go back, and it cannot be claimed. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 27: postgres agent journal: lease, un-approve and the queue (live) refuses to withdraw a claimed, foreign, changed or unapproved operation, and changes nothing. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 28: postgres agent journal: lease, un-approve and the queue (live) an un-approve racing a claim on two connections has exactly one winner, whichever gets the row first. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 29: postgres agent journal: lease, un-approve and the queue (live) lists an uncertain operation in the review queue, read-only. Separate unchanged-source pass: fresh-uncovered-postgres.

### tests/agent-control-journal.test.ts (7 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `9e62a15:tests/agent-control-journal.test.ts:122`; `9e62a15:tests/agent-control-journal.test.ts:132`; `9e62a15:tests/agent-control-journal.test.ts:336`

- Assertion 22: postgres agent journal (live) two connections racing one claim: exactly one wins, the other sees the row unchanged. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 23: postgres agent journal (live) a lease past its end reconciles to uncertain, and is never re-dispatched. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 24: postgres agent journal (live) a finalize with a stale fence changes zero rows. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 25: postgres agent journal (live) an application authority that moved during dispatch refuses to finalize. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 26: postgres agent journal (live) (workspace, subject, request_key) is unique, so prepare is idempotent in the database. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 27: postgres agent journal (live) claims, finalizes and reads back through the same interface the file store satisfies. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 28: postgres agent journal (live) refuses every read and write until the schema ledger is what this build needs. Separate unchanged-source pass: fresh-uncovered-postgres.

### tests/agent-control/pg-contract.test.ts (16 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `9e62a15:tests/agent-control/pg-contract.test.ts:43`; `9e62a15:tests/agent-control/pg-contract.test.ts:248`; `9e62a15:tests/agent-control/pg-contract.test.ts:465`

- Assertion 1: AgentControlPostgres the claim gives one of two racing instances the operation and the other nothing. Separate unchanged-source pass: staging-supabase.
- Assertion 2: AgentControlPostgres the claim leaves the loser a row to read rather than an error to interpret. Separate unchanged-source pass: staging-supabase.
- Assertion 3: AgentControlPostgres the claim serialises a claim behind an open transaction and still yields one winner. Separate unchanged-source pass: staging-supabase.
- Assertion 4: AgentControlPostgres the claim refuses to claim what the browser has not approved, or what expired while it waited. Separate unchanged-source pass: staging-supabase.
- Assertion 5: AgentControlPostgres the claim refuses a claim whose reviewed digest or state fingerprint moved. Separate unchanged-source pass: staging-supabase.
- Assertion 6: AgentControlPostgres the fence refuses a finalize carrying the fence of an earlier claim. Separate unchanged-source pass: staging-supabase.
- Assertion 7: AgentControlPostgres the fence refuses a finalize after the lease has lapsed, and reconciliation then owns the row. Separate unchanged-source pass: staging-supabase.
- Assertion 8: AgentControlPostgres the fence refuses a finalize whose authority moved while the action ran. Separate unchanged-source pass: staging-supabase.
- Assertion 9: AgentControlPostgres the fence renews a lease only for the holder of the current fence. Separate unchanged-source pass: staging-supabase.
- Assertion 10: AgentControlPostgres reconciliation turns an expired lease into uncertain once, and never back into a dispatch. Separate unchanged-source pass: staging-supabase.
- Assertion 11: AgentControlPostgres reconciliation leaves a live lease alone. Separate unchanged-source pass: staging-supabase.
- Assertion 12: AgentControlPostgres reconciliation expires a proposal nobody reviewed, without touching one that is running. Separate unchanged-source pass: staging-supabase.
- Assertion 13: AgentControlPostgres the operation row makes an idempotent prepare a database fact. Separate unchanged-source pass: staging-supabase.
- Assertion 14: AgentControlPostgres the operation row refuses a phase outside the eight the contract names. Separate unchanged-source pass: staging-supabase.
- Assertion 15: AgentControlPostgres the operation row keeps an operation's events with it, and takes them when it goes. Separate unchanged-source pass: staging-supabase.
- Assertion 16: AgentControlPostgres the indexes the reconciliation scan depends on keeps both partial indexes, with their WHERE clauses. Separate unchanged-source pass: staging-supabase.

### tests/agent-link/pg-contract.test.ts (14 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `9e62a15:tests/agent-link/pg-contract.test.ts:58`; `9e62a15:tests/agent-link/pg-contract.test.ts:223`; `9e62a15:tests/agent-link/pg-contract.test.ts:422`

- Assertion 1: AgentLinkPostgres credentials issues, verifies, revokes and then refuses ;  the whole lifetime of one bearer. Separate unchanged-source pass: staging-supabase.
- Assertion 2: AgentLinkPostgres credentials refuses a credential whose expiry has passed, on the predicate and not on a caller's memory. Separate unchanged-source pass: staging-supabase.
- Assertion 3: AgentLinkPostgres credentials refuses two credentials with one token hash. Separate unchanged-source pass: staging-supabase.
- Assertion 4: AgentLinkPostgres credentials refuses a token hash that is not 64 hex characters, and a credential with no project. Separate unchanged-source pass: staging-supabase.
- Assertion 5: AgentLinkPostgres the link code moves pending to approved exactly once, however many times the form is submitted. Separate unchanged-source pass: staging-supabase.
- Assertion 6: AgentLinkPostgres the link code hands the secret back once and destroys it in the same statement. Separate unchanged-source pass: staging-supabase.
- Assertion 7: AgentLinkPostgres the link code cannot read the secret back from a plain RETURNING, which is why the statement is shaped that way. Separate unchanged-source pass: staging-supabase.
- Assertion 8: AgentLinkPostgres the link code gives two concurrent pollers one token between them. Separate unchanged-source pass: staging-supabase.
- Assertion 9: AgentLinkPostgres the link code sweeps expired codes and destroys their secrets, and a second pass finds nothing. Separate unchanged-source pass: staging-supabase.
- Assertion 10: AgentLinkPostgres the link code refuses a state outside the five the protocol names. Separate unchanged-source pass: staging-supabase.
- Assertion 11: AgentLinkPostgres the durable rate limiter counts inside a window and starts the next one at one. Separate unchanged-source pass: staging-supabase.
- Assertion 12: AgentLinkPostgres the durable rate limiter keeps one row per scope, key and window, and refuses a negative count. Separate unchanged-source pass: staging-supabase.
- Assertion 13: AgentLinkPostgres the schema itself keeps row level security on with no policies, so only the service role reaches it. Separate unchanged-source pass: staging-supabase.
- Assertion 14: AgentLinkPostgres the schema itself indexes the credential lookups the authorization path makes. Separate unchanged-source pass: staging-supabase.

### tests/bridge/steps.test.ts (1 skipped)

Reason: **Nonportable stale path prerequisite**. The compatibility guard requires a hard-coded Z:/Projects/.../ws-act product-port.ts path that is absent. Current repository product-port exists. Root separately matched 23 phase/title rows; this does not change the one skipped test.

Guard references: `9e62a15:tests/bridge/steps.test.ts:19`; `9e62a15:tests/bridge/steps.test.ts:20`

- Assertion 3: worker projection compatibility matches its title/phase table and row order. No separately matched unchanged-source pass in this audit.

### tests/cli/config.test.ts (1 skipped)

Reason: **Different operating system**. This Windows inherited-ACL assertion runs only when process.platform is win32. The local report was produced on macOS ARM64.

Guard references: `9e62a15:tests/cli/config.test.ts:34`; `9e62a15:tests/cli/config.test.ts:40`; `9e62a15:tests/cli/config.test.ts:86`

- Assertion 3: private login config Windows refuses inherited ACLs that grant other identities access. No separately matched unchanged-source pass in this audit.

### tests/controlplane/executor.test.ts (1 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `9e62a15:tests/controlplane/executor.test.ts:277`

- Assertion 20: cross-engine shape identity PGlite and PostgreSQL return deeply equal rows for the same statement. Separate unchanged-source pass: staging-platform-postgres.

### tests/controlplane/migrations.test.ts (3 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `9e62a15:tests/controlplane/migrations.test.ts:338`

- Assertion 14: migrator [postgres] concurrency and fail-closed open two migrators racing on an empty database converge: one applies, the other finds it done. No separately matched unchanged-source pass in this audit.
- Assertion 15: migrator [postgres] concurrency and fail-closed open openPlatformDb({ kind: 'postgres' }) does not migrate unless asked, and a bare open sees the schema as behind. No separately matched unchanged-source pass in this audit.
- Assertion 16: migrator [postgres] concurrency and fail-closed open BOOTSTRAP_SQL is idempotent. No separately matched unchanged-source pass in this audit.

### tests/controlplane/open.test.ts (2 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `9e62a15:tests/controlplane/open.test.ts:202`

- Assertion 15: platformDb() against PostgreSQL opens a migrated database using ZENITH_PLATFORM_DB_URL, with the schema check passing. Separate unchanged-source pass: staging-platform-postgres.
- Assertion 16: platformDb() against PostgreSQL fails CLOSED against an un-migrated database with the command to run, and does not cache the failure. Separate unchanged-source pass: staging-platform-postgres.

### tests/credentials/bootstrap-templates.test.ts (1 skipped)

Reason: **OpenTofu template test opt-in**. The skipped mock-provider template test requires ZENITH_TEST_TOFU and a detected binary, with provider initialization. It is distinct from ZENITH_TEST_TOFU_NETWORK.

Guard references: `9e62a15:tests/credentials/bootstrap-templates.test.ts:654`

- Assertion 76: OpenTofu module tofu init + validate + test (mock provider, offline after init). No separately matched unchanged-source pass in this audit.

### tests/db/contract/alerts.test.ts (7 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `9e62a15:tests/db/contract/alerts.test.ts:35`; `9e62a15:tests/db/contract/alerts.test.ts:106`

- Assertion 1: alerts on Postgres refuses a second standing rule for one (environment, kind). No separately matched unchanged-source pass in this audit.
- Assertion 2: alerts on Postgres round-trips an event through open and resolved. No separately matched unchanged-source pass in this audit.
- Assertion 3: alerts on Postgres lets exactly one of two snapshots claim a pending row. No separately matched unchanged-source pass in this audit.
- Assertion 4: alerts on Postgres reclaims a claim older than the lease and leaves a live one alone. No separately matched unchanged-source pass in this audit.
- Assertion 5: alerts on Postgres refuses a second outbox row for one idempotency key. No separately matched unchanged-source pass in this audit.
- Assertion 6: alerts on Postgres round-trips a security finding. No separately matched unchanged-source pass in this audit.
- Assertion 7: alerts on Postgres round-trips a Navigator run. No separately matched unchanged-source pass in this audit.

### tests/db/contract/audit.test.ts (1 skipped)

Reason: **Intentionally different backend**. The scenario has an only-backend selector; the repeated FileStore instance is outside that scenario’s backend scope. Do not treat the FileStore repetition as an unexecuted universal backend promise.

Guard references: `9e62a15:tests/db/contract/audit.test.ts:212`

- Assertion 8: audit contract ;  'FileStore' a retried append writes nothing twice. No separately matched unchanged-source pass in this audit.

### tests/db/contract/history.test.ts (7 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `9e62a15:tests/db/contract/history.test.ts:245`

- Assertion 8: history contract ;  Postgres only seeds a second workspace to work in. No separately matched unchanged-source pass in this audit.
- Assertion 9: history contract ;  Postgres only promotes the indexed columns and leaves them out of data. No separately matched unchanged-source pass in this audit.
- Assertion 10: history contract ;  Postgres only reads a manifest back through the accessor with a cold cache. No separately matched unchanged-source pass in this audit.
- Assertion 11: history contract ;  Postgres only assigns a dense seq per deployment across two instances. No separately matched unchanged-source pass in this audit.
- Assertion 12: history contract ;  Postgres only refuses a write against a row another instance already moved. No separately matched unchanged-source pass in this audit.
- Assertion 13: history contract ;  Postgres only bumps the change feed for the workspace a deployment belongs to. No separately matched unchanged-source pass in this audit.
- Assertion 14: history contract ;  Postgres only keeps rows outside the snapshot's scope when it resets. No separately matched unchanged-source pass in this audit.

### tests/db/contract/workspace-sharing.test.ts (22 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `9e62a15:tests/db/contract/workspace-sharing.test.ts:11`; `9e62a15:tests/db/contract/workspace-sharing.test.ts:159`

- Assertion 1: WorkspaceSharingPostgres grants execute only to the service role, excluding PUBLIC, anon and authenticated. Separate unchanged-source pass: staging-supabase.
- Assertion 2: WorkspaceSharingPostgres keeps the owner present and administrative until ownership is transferred. Separate unchanged-source pass: staging-supabase.
- Assertion 3: WorkspaceSharingPostgres requires the owner for granting or managing admin access and transferring ownership. Separate unchanged-source pass: staging-supabase.
- Assertion 4: WorkspaceSharingPostgres uses actor identity rather than a claimed member email to authorize sharing. Separate unchanged-source pass: staging-supabase.
- Assertion 5: WorkspaceSharingPostgres allows admins to manage non-admin collaborators and lets non-owners leave. Separate unchanged-source pass: staging-supabase.
- Assertion 6: WorkspaceSharingPostgres rechecks a competing remover's authority after the owner demotes that admin. Separate unchanged-source pass: staging-supabase.
- Assertion 7: WorkspaceSharingPostgres rechecks a competing role change after the owner removes the acting admin. Separate unchanged-source pass: staging-supabase.
- Assertion 8: WorkspaceSharingPostgres protects the newly transferred owner against a competing removal. Separate unchanged-source pass: staging-supabase.
- Assertion 9: WorkspaceSharingPostgres refuses a second ownership transfer from the former owner after waiting for the first. Separate unchanged-source pass: staging-supabase.
- Assertion 10: WorkspaceSharingPostgres accepts a normalized matching email while refusing another signed-in identity's email. Separate unchanged-source pass: staging-supabase.
- Assertion 11: WorkspaceSharingPostgres rejects a revoked invitation even when a caller retained its former live state. Separate unchanged-source pass: staging-supabase.
- Assertion 12: WorkspaceSharingPostgres rechecks invitation revocation after a competing accept waits for the workspace lock. Separate unchanged-source pass: staging-supabase.
- Assertion 13: WorkspaceSharingPostgres renews an expired invitation on resend, while refusing to renew a revoked offer. Separate unchanged-source pass: staging-supabase.
- Assertion 14: WorkspaceSharingPostgres refuses expired invitations without creating membership. Separate unchanged-source pass: staging-supabase.
- Assertion 15: WorkspaceSharingPostgres does not restore access when an accepted invitation is replayed after removal. Separate unchanged-source pass: staging-supabase.
- Assertion 16: WorkspaceSharingPostgres preserves an existing member's role when accepting an older admin invitation. Separate unchanged-source pass: staging-supabase.
- Assertion 17: WorkspaceSharingPostgres revokes old pending offers when a member exits through remove-member. Separate unchanged-source pass: staging-supabase.
- Assertion 18: WorkspaceSharingPostgres revokes old pending offers when a member exits through leave. Separate unchanged-source pass: staging-supabase.
- Assertion 19: WorkspaceSharingPostgres commits an audit event with a role change and writes no event for a refused mutation. Separate unchanged-source pass: staging-supabase.
- Assertion 20: WorkspaceSharingPostgres lets a fresh invitation replace an expired pending offer without reviving the old one. Separate unchanged-source pass: staging-supabase.
- Assertion 21: WorkspaceSharingPostgres allows one pending invitation per normalized address and workspace under competing requests. Separate unchanged-source pass: staging-supabase.
- Assertion 22: WorkspaceSharingPostgres cannot use an invitation or membership id from a different workspace. Separate unchanged-source pass: staging-supabase.

### tests/execution/compile-refs-providers.test.ts (2 skipped)

Reason: **Provider-schema network opt-in**. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

Guard references: `9e62a15:tests/execution/compile-refs-providers.test.ts:180`

- Assertion 17: real AWS schema validation through the execution compiler (opt-in) runs tofu init -backend=false and tofu validate on production. Separate unchanged-source pass: staging-tofu.
- Assertion 18: real AWS schema validation through the execution compiler (opt-in) runs tofu init -backend=false and tofu validate on staging. Separate unchanged-source pass: staging-tofu.

### tests/execution/deletion-guards-real.test.ts (1 skipped)

Reason: **Separate real-OpenTofu removal opt-in**. ZENITH_TEST_DELETION_GUARDS_TOFU=1 and an available OpenTofu binary are required. The generic network provider opt-in alone does not enable this test.

Guard references: `9e62a15:tests/execution/deletion-guards-real.test.ts:16`; `9e62a15:tests/execution/deletion-guards-real.test.ts:20`

- Assertion 1: real tofu deploy removal (ZENITH_TEST_DELETION_GUARDS_TOFU=1) refuses unapproved stateful removal and applies the exact approved deletion. No separately matched unchanged-source pass in this audit.

### tests/execution/destroy-review-temporal.test.ts (1 skipped)

Reason: **Local Temporal server prerequisite**. An existing ZENITH_TEST_TEMPORAL_SERVER or explicit ZENITH_TEST_TEMPORAL_DOWNLOAD=1 is required. Downloads are disabled in default unit execution.

Guard references: `9e62a15:tests/execution/destroy-review-temporal.test.ts:20`; `9e62a15:tests/execution/destroy-review-temporal.test.ts:60`

- Assertion 1: Temporal read-only teardown review workflow records evidence and a pending proposal once, and preserves approval winning a refresh race without apply. No separately matched unchanged-source pass in this audit.

### tests/execution/destroy-review.test.ts (1 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `9e62a15:tests/execution/destroy-review.test.ts:261`

- Assertion 19: real Postgres destroy-review lane persists the first pending review with a readable PlanView. Separate unchanged-source pass: fresh-uncovered-postgres.

### tests/hosted/artifacts/storage-store.test.ts (2 skipped)

Reason: **Authorized live hosted-service fixture**. ZENITH_CONTRACT_POSTGRES=1, NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. The tracker branch also checks atomic functions. Disposable PostgreSQL contracts do not establish hosted bucket/data-service acceptance.

Guard references: `9e62a15:tests/hosted/artifacts/storage-store.test.ts:343`; `9e62a15:tests/hosted/artifacts/storage-store.test.ts:351`

- Assertion 11: StorageArtifactStore (live bucket) puts a bundle, reads it back byte for byte, and serves a range. No separately matched unchanged-source pass in this audit.
- Assertion 12: StorageArtifactStore (live bucket) removes everything it wrote. No separately matched unchanged-source pass in this audit.

### tests/hosted/data/pg-contract.live.test.ts (11 skipped)

Reason: **Authorized live hosted-service fixture**. ZENITH_CONTRACT_POSTGRES=1, NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. The tracker branch also checks atomic functions. Disposable PostgreSQL contracts do not establish hosted bucket/data-service acceptance.

Guard references: `9e62a15:tests/hosted/data/pg-contract.live.test.ts:42`; `9e62a15:tests/hosted/data/pg-contract.live.test.ts:85`; `9e62a15:tests/hosted/data/pg-contract.live.test.ts:139`; `9e62a15:tests/hosted/data/pg-contract.live.test.ts:339`

- Assertion 1: the tracker contract against real Postgres tables creates, reads back and pages the records it stored. No separately matched unchanged-source pass in this audit.
- Assertion 2: the tracker contract against real Postgres tables lets the first writer through and refuses the second with stale_version. No separately matched unchanged-source pass in this audit.
- Assertion 3: the tracker contract against real Postgres tables replays a retried write id instead of writing a second record. No separately matched unchanged-source pass in this audit.
- Assertion 4: the tracker contract against real Postgres tables refuses a record that would take the app past its storage ceiling, and writes nothing. No separately matched unchanged-source pass in this audit.
- Assertion 5: the tracker contract against real Postgres tables keeps one app's records out of another app's reach. No separately matched unchanged-source pass in this audit.
- Assertion 6: the tracker contract against real Postgres tables accounts storage as the same logical-byte figure the measure defines. No separately matched unchanged-source pass in this audit.
- Assertion 7: the tracker contract against real Postgres tables commits the record, the counter and the ledger row together. No separately matched unchanged-source pass in this audit.
- Assertion 8: the whole-app operations against real Postgres tables imports a bundle, skips ids already stored, and keeps the counter true. No separately matched unchanged-source pass in this audit.
- Assertion 9: the whole-app operations against real Postgres tables reports the logical integrity check, and it passes on rows it just wrote. No separately matched unchanged-source pass in this audit.
- Assertion 10: the whole-app operations against real Postgres tables empties the probe namespace and leaves the app's own rows alone. No separately matched unchanged-source pass in this audit.
- Assertion 11: the whole-app operations against real Postgres tables refuses to empty anything that is not a probe namespace. No separately matched unchanged-source pass in this audit.

### tests/machines/azure-scripts.test.ts (6 skipped)

Reason: **Missing executable alias**. The collector probes the literal python executable with -I. That alias was unavailable in this run although python3 exists. This is not an OS-wide Azure restriction and passing elsewhere is not Azure guest delivery proof.

Guard references: `9e62a15:tests/machines/azure-scripts.test.ts:13`; `9e62a15:tests/machines/azure-scripts.test.ts:34`

- Assertion 1: Azure fixed Python collector locally all semantic and argv collector programs compile. No separately matched unchanged-source pass in this audit.
- Assertion 2: Azure fixed Python collector locally metacharacters, quotes and newlines round-trip as argv data without a shell. No separately matched unchanged-source pass in this audit.
- Assertion 3: Azure fixed Python collector locally drains large output with bounded memory and a complete sub-4-KiB envelope. No separately matched unchanged-source pass in this audit.
- Assertion 4: Azure fixed Python collector locally child processes receive an explicit environment without collector secrets. No separately matched unchanged-source pass in this audit.
- Assertion 5: Azure fixed Python collector locally preserves the child's actual nonzero exit status. No separately matched unchanged-source pass in this audit.
- Assertion 6: Azure fixed Python collector locally terminates a timed-out command and marks its outcome. No separately matched unchanged-source pass in this audit.

### tests/machines/ssm-documents.test.ts (13 skipped)

Reason: **Broken shell prerequisite detection**. The native shell harness builds sh sh -s, which fails its probe. Root independently found sh -s succeeds. The thirteen guarded script assertions remain skipped; repair is still needed. FileRead also excludes Darwin, but the earlier broken probe already disables its cases.

Guard references: `9e62a15:tests/machines/ssm-documents.test.ts:318`; `9e62a15:tests/machines/ssm-documents.test.ts:326`; `9e62a15:tests/machines/ssm-documents.test.ts:363`; `9e62a15:tests/machines/ssm-documents.test.ts:395`; `9e62a15:tests/machines/ssm-documents.test.ts:463`; `9e62a15:tests/machines/ssm-documents.test.ts:482`; `9e62a15:tests/machines/ssm-documents.test.ts:492`

- Assertion 84: script behaviour: input validation (runs the real scripts under sh) refuses hostile units with exit 64 before touching systemctl. No separately matched unchanged-source pass in this audit.
- Assertion 85: script behaviour: input validation (runs the real scripts under sh) refuses to restart protected units with exit 65. No separately matched unchanged-source pass in this audit.
- Assertion 86: script behaviour: input validation (runs the real scripts under sh) enforces a restart allowlist baked into the document. No separately matched unchanged-source pass in this audit.
- Assertion 87: script behaviour: input validation (runs the real scripts under sh) an agent too old for ENV_VAR (empty variables) fails closed, naming the cause. No separately matched unchanged-source pass in this audit.
- Assertion 88: script behaviour: input validation (runs the real scripts under sh) validates numeric, enum and boolean parameters. No separately matched unchanged-source pass in this audit.
- Assertion 89: script behaviour: input validation (runs the real scripts under sh) refuses metadata names and malformed hosts in PortCheck and DnsCheck (exit 64/65, before any network tool). No separately matched unchanged-source pass in this audit.
- Assertion 90: script behaviour: input validation (runs the real scripts under sh) PortCheck refuses link-local and metadata addresses after resolution (skipped where getent is missing). No separately matched unchanged-source pass in this audit.
- Assertion 91: script behaviour: FileRead guards (real files in a private temp dir) reads an allowed regular file as base64 with size and truncation facts. No separately matched unchanged-source pass in this audit.
- Assertion 92: script behaviour: FileRead guards (real files in a private temp dir) caps output at 16384 bytes whatever maxBytes says, and reports truncation. No separately matched unchanged-source pass in this audit.
- Assertion 93: script behaviour: FileRead guards (real files in a private temp dir) refuses traversal, symlink escapes and secret-like names. No separately matched unchanged-source pass in this audit.
- Assertion 94: script behaviour: FileRead guards (real files in a private temp dir) a symlink may point at another allowed file, but not at an unlisted one. No separately matched unchanged-source pass in this audit.
- Assertion 95: script behaviour: FileRead guards (real files in a private temp dir) exact-file allowlist entries allow only that file. No separately matched unchanged-source pass in this audit.
- Assertion 96: script behaviour: FileRead guards (real files in a private temp dir) reports missing files and non-regular files. No separately matched unchanged-source pass in this audit.

### tests/platform/deploy-e2e.test.ts (6 skipped)

Reason: **Local Temporal server prerequisite**. The fixture needs a configured time-skipping server, installed Temporal CLI or explicit download permission. Source records Temporal CLI unavailable and downloads opt-in; this is a test-server prerequisite, not a cloud failure.

Guard references: `9e62a15:tests/platform/deploy-e2e.test.ts:143`; `9e62a15:tests/platform/deploy-e2e.test.ts:195`; `9e62a15:tests/platform/deploy-e2e.test.ts:225`; `9e62a15:tests/platform/deploy-e2e.test.ts:236`; `9e62a15:tests/platform/deploy-e2e.test.ts:245`; `9e62a15:tests/platform/deploy-e2e.test.ts:251`

- Assertion 1: composed deploy workflow (contract evidence) proposes through the bridge without a plan, records two browser rounds, signals, and resumes with a new fence. No separately matched unchanged-source pass in this audit.
- Assertion 2: composed deploy workflow (contract evidence) approves the plan as a browser human, deploys every step, and reads actual mocked steady state/health. No separately matched unchanged-source pass in this audit.
- Assertion 3: composed deploy workflow (contract evidence) denies a discovered public database before apply. No separately matched unchanged-source pass in this audit.
- Assertion 4: composed deploy workflow (contract evidence) a reject in the plan round halts without applying. No separately matched unchanged-source pass in this audit.
- Assertion 5: composed deploy workflow (contract evidence) a plan changed after plan approval fails before apply. No separately matched unchanged-source pass in this audit.
- Assertion 6: composed deploy workflow (contract evidence) loses its lease while apply is in flight and ends uncertain without retrying apply. No separately matched unchanged-source pass in this audit.

### tests/platform/source-bundle.test.ts (1 skipped)

Reason: **Authorized public GitHub network fixture**. ZENITH_TEST_SOURCE_GITHUB=1 plus an authorized repository and pinned 40-hex commit are required; ordinary mocked source tests do not replace this download check.

Guard references: `9e62a15:tests/platform/source-bundle.test.ts:296`; `9e62a15:tests/platform/source-bundle.test.ts:354`; `9e62a15:tests/platform/source-bundle.test.ts:406`; `9e62a15:tests/platform/source-bundle.test.ts:411`

- Assertion 78: live public GitHub source (opt-in network) downloads a pinned public commit into a source bundle. Separate unchanged-source pass: staging-workflows.

### tests/providers/aws/drivers/compute/assemble.test.ts (3 skipped)

Reason: **Provider-schema network opt-in**. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

Guard references: `9e62a15:tests/providers/aws/drivers/compute/assemble.test.ts:81`; `9e62a15:tests/providers/aws/drivers/compute/assemble.test.ts:83`

- Assertion 5: real `tofu validate` against hashicorp/aws 6.66.0 (network, plugin cache) accepts the whole compute graph (service, job, registry, build, static site, function, instance). Separate unchanged-source pass: staging-tofu.
- Assertion 6: real `tofu validate` against hashicorp/aws 6.66.0 (network, plugin cache) negative control: `validate` rejects an unknown argument, so the passes above are not vacuous. Separate unchanged-source pass: staging-tofu.
- Assertion 7: real `tofu validate` against hashicorp/aws 6.66.0 (network, plugin cache) accepts a service with a pinned public image, no secrets and no load balancer. Separate unchanged-source pass: staging-tofu.

### tests/providers/aws/drivers/data/assemble.test.ts (1 skipped)

Reason: **Provider-schema network opt-in**. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

Guard references: `9e62a15:tests/providers/aws/drivers/data/assemble.test.ts:94`; `9e62a15:tests/providers/aws/drivers/data/assemble.test.ts:96`

- Assertion 5: compiled data fragments validate against the real hashicorp/aws provider (network) tofu validate accepts the assembled workspace. Separate unchanged-source pass: staging-tofu.

### tests/providers/aws/drivers/e2e-compile.test.ts (2 skipped)

Reason: **Provider-schema network opt-in**. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

Guard references: `9e62a15:tests/providers/aws/drivers/e2e-compile.test.ts:111`

- Assertion 7: real OpenTofu AWS 6.66.0 schema validation (opt-in) initializes and validates the production workspace without a backend or cloud credentials. Separate unchanged-source pass: staging-tofu.
- Assertion 8: real OpenTofu AWS 6.66.0 schema validation (opt-in) initializes and validates the staging workspace without a backend or cloud credentials. Separate unchanged-source pass: staging-tofu.

### tests/providers/aws/drivers/messaging/assemble.test.ts (1 skipped)

Reason: **Provider-schema network opt-in**. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

Guard references: `9e62a15:tests/providers/aws/drivers/messaging/assemble.test.ts:116`

- Assertion 9: OpenTofu AWS 6.66.0 schema validation (requires binary/network) validates the complete SNS/EBS/EKS graph against the pinned provider. Separate unchanged-source pass: staging-tofu.

### tests/providers/aws/drivers/network/compile-graph.test.ts (6 skipped)

Reason: **Provider-schema network opt-in**. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

Guard references: `9e62a15:tests/providers/aws/drivers/network/compile-graph.test.ts:277`; `9e62a15:tests/providers/aws/drivers/network/compile-graph.test.ts:287`

- Assertion 22: tofu validate over the real aws 6.66.0 provider schema (gated: ZENITH_TEST_TOFU_NETWORK=1) the assembled fixture workspace validates. Separate unchanged-source pass: staging-tofu.
- Assertion 23: tofu validate over the real aws 6.66.0 provider schema (gated: ZENITH_TEST_TOFU_NETWORK=1) the validator has teeth: an unknown argument in a compiled resource makes the same workspace invalid. Separate unchanged-source pass: staging-tofu.
- Assertion 24: tofu validate over the real aws 6.66.0 provider schema (gated: ZENITH_TEST_TOFU_NETWORK=1) variant validates: single NAT. Separate unchanged-source pass: staging-tofu.
- Assertion 25: tofu validate over the real aws 6.66.0 provider schema (gated: ZENITH_TEST_TOFU_NETWORK=1) variant validates: no NAT. Separate unchanged-source pass: staging-tofu.
- Assertion 26: tofu validate over the real aws 6.66.0 provider schema (gated: ZENITH_TEST_TOFU_NETWORK=1) variant validates: manual certificate. Separate unchanged-source pass: staging-tofu.
- Assertion 27: tofu validate over the real aws 6.66.0 provider schema (gated: ZENITH_TEST_TOFU_NETWORK=1) variant validates: second TLS host with its own certificate. Separate unchanged-source pass: staging-tofu.

### tests/providers/aws/identity/trust.test.ts (1 skipped)

Reason: **Provider-schema network opt-in**. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

Guard references: `9e62a15:tests/providers/aws/identity/trust.test.ts:95`

- Assertion 14: IRSA pinned provider schema validates the new trust and OIDC provider with real tofu. Separate unchanged-source pass: staging-tofu.

### tests/providers/azure/deploy.test.ts (1 skipped)

Reason: **Provider-schema network opt-in**. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

Guard references: `9e62a15:tests/providers/azure/deploy.test.ts:105`; `9e62a15:tests/providers/azure/deploy.test.ts:107`

- Assertion 9: deploy/azure validates against the real azurerm 5.7.0 schema (network) tofu init (azurerm pinned to 5.7.0) and tofu validate succeed. Separate unchanged-source pass: staging-tofu.

### tests/providers/azure/identity/trust.test.ts (1 skipped)

Reason: **Provider-schema network opt-in**. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

Guard references: `9e62a15:tests/providers/azure/identity/trust.test.ts:48`

- Assertion 5: AKS trust pinned provider schema validates the new federation and issuer-only deployment with real tofu. Separate unchanged-source pass: staging-tofu.

### tests/providers/azure/mysql.test.ts (2 skipped)

Reason: **Provider-schema network opt-in**. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

Guard references: `9e62a15:tests/providers/azure/mysql.test.ts:132`

- Assertion 22: Azure MySQL real pinned tofu validate (network, no Azure account) accepts write-only bootstrap storage, ephemeral readback and HA=true. Separate unchanged-source pass: staging-tofu.
- Assertion 23: Azure MySQL real pinned tofu validate (network, no Azure account) accepts write-only bootstrap storage, ephemeral readback and HA=false. Separate unchanged-source pass: staging-tofu.

### tests/providers/azure/validate.test.ts (5 skipped)

Reason: **Provider-schema network opt-in**. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

Guard references: `9e62a15:tests/providers/azure/validate.test.ts:24`; `9e62a15:tests/providers/azure/validate.test.ts:48`

- Assertion 1: compiled Azure OpenTofu validates against the real azurerm 5.7.0 schema (network) built apps and jobs use a digest bootstrap and ignore release image/argv changes. Separate unchanged-source pass: staging-tofu.
- Assertion 2: compiled Azure OpenTofu validates against the real azurerm 5.7.0 schema (network) additional drivers, delegated subnets, ARM deployments, custom domains and Function host endpoints. Separate unchanged-source pass: staging-tofu.
- Assertion 3: compiled Azure OpenTofu validates against the real azurerm 5.7.0 schema (network) a full environment: landing zone, subnets, firewall, Container App + job, postgres HA, redis, storage, service bus, key vault, identity, registry, logs, DNS, managed certificate. Separate unchanged-source pass: staging-tofu.
- Assertion 4: compiled Azure OpenTofu validates against the real azurerm 5.7.0 schema (network) variants: no HA, a topic, a worker, a job without a schedule, an apex domain, a referenced Key Vault secret, deletion allowed, a single zone. Separate unchanged-source pass: staging-tofu.
- Assertion 5: compiled Azure OpenTofu validates against the real azurerm 5.7.0 schema (network) an environment with only a bucket and a queue plus the network that owns the resource group. Separate unchanged-source pass: staging-tofu.

### tests/providers/gcp/bootstrap.test.ts (1 skipped)

Reason: **Provider-schema network opt-in**. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

Guard references: `9e62a15:tests/providers/gcp/bootstrap.test.ts:144`; `9e62a15:tests/providers/gcp/bootstrap.test.ts:152`

- Assertion 14: tofu validate (network) initializes with the committed lockfile and validates against hashicorp/google 8.5.0. Separate unchanged-source pass: staging-tofu.

### tests/providers/gcp/identity/trust.test.ts (1 skipped)

Reason: **Provider-schema network opt-in**. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

Guard references: `9e62a15:tests/providers/gcp/identity/trust.test.ts:56`

- Assertion 10: GKE trust pinned provider schema validates the new GSA IAM binding with real tofu. Separate unchanged-source pass: staging-tofu.

### tests/providers/gcp/tofu-validate.test.ts (6 skipped)

Reason: **Provider-schema network opt-in**. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

Guard references: `9e62a15:tests/providers/gcp/tofu-validate.test.ts:40`; `9e62a15:tests/providers/gcp/tofu-validate.test.ts:64`

- Assertion 1: tofu validate against hashicorp/google 8.5.0 (network) accepts built services and jobs with digest bootstrap and narrow image/annotation ignore_changes paths. Separate unchanged-source pass: staging-tofu.
- Assertion 2: tofu validate against hashicorp/google 8.5.0 (network) accepts the full environment: network, data stores, identity, services, load balancer, dns, build. Separate unchanged-source pass: staging-tofu.
- Assertion 3: tofu validate against hashicorp/google 8.5.0 (network) accepts variants: no NAT, non-HA database, hourly redis backups, http-only load balancer, no backups, worker-only services. Separate unchanged-source pass: staging-tofu.
- Assertion 4: tofu validate against hashicorp/google 8.5.0 (network) accepts referenced nodes compiled to data sources. Separate unchanged-source pass: staging-tofu.
- Assertion 5: tofu validate against hashicorp/google 8.5.0 (network) control: validate rejects an invalid attribute, so the passes above mean something. Separate unchanged-source pass: staging-tofu.
- Assertion 6: tofu validate against hashicorp/google 8.5.0 (network) plans the whole environment offline with a fake token: every claimed resource is created, joined to its node, and no attribute is sensitive. Separate unchanged-source pass: staging-tofu.

### tests/providers/kubernetes/kind.test.ts (6 skipped)

Reason: **Disposable Kubernetes cluster opt-in**. ZENITH_TEST_KIND=1 and a disposable KUBECONFIG are required; release tests also require a pinned non-root release image. Dedicated kind reports are listed separately.

Guard references: `9e62a15:tests/providers/kubernetes/kind.test.ts:34`; `9e62a15:tests/providers/kubernetes/kind.test.ts:36`

- Assertion 1: kubernetes provider against a real cluster (kind) creates the namespace, policy and workload, then a second apply changes nothing. Separate unchanged-source pass: staging-kind.
- Assertion 2: kubernetes provider against a real cluster (kind) rolls out, and the drivers observe, verify and report runtime. Separate unchanged-source pass: staging-kind.
- Assertion 3: kubernetes provider against a real cluster (kind) refuses to touch a same-named object it does not own. Separate unchanged-source pass: staging-kind.
- Assertion 4: kubernetes provider against a real cluster (kind) restarts, scales and reads logs and events through the operations. Separate unchanged-source pass: staging-kind.
- Assertion 5: kubernetes provider against a real cluster (kind) deploys a new image, rolls back to the previous revision, and the pods follow. Separate unchanged-source pass: staging-kind.
- Assertion 6: kubernetes provider against a real cluster (kind) prunes what is no longer desired and never deletes the namespace. Separate unchanged-source pass: staging-kind.

### tests/providers/kubernetes/release-kind.test.ts (1 skipped)

Reason: **Disposable Kubernetes cluster opt-in**. ZENITH_TEST_KIND=1 and a disposable KUBECONFIG are required; release tests also require a pinned non-root release image. Dedicated kind reports are listed separately.

Guard references: `9e62a15:tests/providers/kubernetes/release-kind.test.ts:19`; `9e62a15:tests/providers/kubernetes/release-kind.test.ts:20`

- Assertion 1: Kubernetes release ports against a disposable kind cluster rolls out a pre-built digest, observes readiness and runs exactly one migration Job across retries. Separate unchanged-source pass: staging-kind.

### tests/providers/oci/mysql.test.ts (5 skipped)

Reason: **Provider-schema network opt-in**. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

Guard references: `9e62a15:tests/providers/oci/mysql.test.ts:107`

- Assertion 5: OCI MySQL real pinned tofu schema and persistence controls (network) validates the schema-only baseline and verifies the live password schema. Separate unchanged-source pass: staging-tofu.
- Assertion 6: OCI MySQL real pinned tofu schema and persistence controls (network) refuses persisting an ephemeral password through admin_password. Separate unchanged-source pass: staging-tofu.
- Assertion 7: OCI MySQL real pinned tofu schema and persistence controls (network) refuses persisting an ephemeral password through output. Separate unchanged-source pass: staging-tofu.
- Assertion 8: OCI MySQL real pinned tofu schema and persistence controls (network) rejects the unsupported MySQL property admin_password_wo in JSON configuration. Separate unchanged-source pass: staging-tofu.
- Assertion 9: OCI MySQL real pinned tofu schema and persistence controls (network) rejects the unsupported MySQL property zenith_not_a_mysql_argument in JSON configuration. Separate unchanged-source pass: staging-tofu.

### tests/providers/oci/validate.test.ts (5 skipped)

Reason: **Provider-schema network opt-in**. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

Guard references: `9e62a15:tests/providers/oci/validate.test.ts:23`; `9e62a15:tests/providers/oci/validate.test.ts:50`; `9e62a15:tests/providers/oci/validate.test.ts:149`

- Assertion 2: tofu validate against oracle/oci 9.7.1 (network) the private VM and enhanced OKE cluster/node pool validate. Separate unchanged-source pass: staging-tofu.
- Assertion 3: tofu validate against oracle/oci 9.7.1 (network) the whole web stack (network, LB, container instances, postgres, redis, bucket, queue, vault, identity, logs, dns) validates. Separate unchanged-source pass: staging-tofu.
- Assertion 4: tofu validate against oracle/oci 9.7.1 (network) the extended graph (host+path routing policy, container registry, block volume, no NAT, two zones) validates. Separate unchanged-source pass: staging-tofu.
- Assertion 5: tofu validate against oracle/oci 9.7.1 (network) negative control: a wrong argument in a compiled fragment makes validate fail (the gate has teeth). Separate unchanged-source pass: staging-tofu.
- Assertion 6: the customer bootstrap module (deploy/oci) validates against the locked provider (network) tofu validate accepts deploy/oci with its shipped lockfile. Separate unchanged-source pass: staging-tofu.

### tests/scripts/migrate-hosted-to-postgres.test.ts (3 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `9e62a15:tests/scripts/migrate-hosted-to-postgres.test.ts:593`

- Assertion 13: migrate-hosted-to-postgres ;  against the real Supabase project copies the control tables, verifies, and inserts nothing on a second run. Separate unchanged-source pass: staging-supabase.
- Assertion 14: migrate-hosted-to-postgres ;  against the real Supabase project copies the app's data, verifies, and inserts nothing on a second run. Separate unchanged-source pass: staging-supabase.
- Assertion 15: migrate-hosted-to-postgres ;  against the real Supabase project leaves no contract- rows behind. Separate unchanged-source pass: staging-supabase.

### tests/secrets/rewrap.test.ts (1 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `9e62a15:tests/secrets/rewrap.test.ts:362`

- Assertion 57: real Postgres vault re-wrap commits product rows and audit together, then resumes idempotently. Separate unchanged-source pass: fresh-uncovered-postgres.

### tests/security/workflow-history.test.ts (2 skipped)

Reason: **Separate Temporal history opt-in**. ZENITH_SEC_TEMPORAL=1 is required for these actual history checks, with a local test server. This flag is separate from ordinary Temporal suite enablement.

Guard references: `9e62a15:tests/security/workflow-history.test.ts:15`; `9e62a15:tests/security/workflow-history.test.ts:53`; `9e62a15:tests/security/workflow-history.test.ts:54`

- Assertion 9: real Temporal history (opt-in; fake activities) ids/digests-only inputs and fake activity results leave synthetic node specs outside history. Separate unchanged-source pass: staging-workflows.
- Assertion 10: real Temporal history (opt-in; fake activities) SEC-F12: runtime node-spec extras are absent from actual durable history. Separate unchanged-source pass: staging-workflows.

### tests/sources/github-live.test.ts (1 skipped)

Reason: **Authorized private GitHub App fixture**. ZENITH_TEST_SOURCE_GITHUB_APP=1 plus app configuration, repository binding and a pinned commit are required. Store-only GitHub tests do not prove private App token/download acceptance.

Guard references: `9e62a15:tests/sources/github-live.test.ts:7`

- Assertion 1: private GitHub App source (opt-in network) downloads the bound repository at a pinned commit with an ephemeral scoped token. No separately matched unchanged-source pass in this audit.

### tests/sources/github-store.test.ts (10 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `9e62a15:tests/sources/github-store.test.ts:72`

- Assertion 11: GitHub source Postgres store (opt-in) persists only identifiers and proof digests, and resolves bindings by workspace. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 12: GitHub source Postgres store (opt-in) refuses a changed callback workspace without consuming the legitimate intent. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 13: GitHub source Postgres store (opt-in) refuses a changed callback actor without consuming the legitimate intent. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 14: GitHub source Postgres store (opt-in) refuses a changed callback browser without consuming the legitimate intent. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 15: GitHub source Postgres store (opt-in) refuses a changed callback state without consuming the legitimate intent. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 16: GitHub source Postgres store (opt-in) refuses expired intents at both transitions using database time. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 17: GitHub source Postgres store (opt-in) allows only one racing setup and one racing OAuth callback. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 18: GitHub source Postgres store (opt-in) stores hashed state/proof and never lets an install callback skip OAuth. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 19: GitHub source Postgres store (opt-in) rejects stale/racing bind intents rather than overwriting another admin's binding. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 20: GitHub source Postgres store (opt-in) validates identifiers and numeric IDs without reflecting malicious data. Separate unchanged-source pass: fresh-uncovered-postgres.

### tests/tofu/backends.test.ts (4 skipped)

Reason: **Provider-schema network opt-in**. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

Guard references: `9e62a15:tests/tofu/backends.test.ts:126`

- Assertion 20: real backend block validation (network gate, no cloud calls) aws: tofu init -backend=false then tofu validate. Separate unchanged-source pass: staging-tofu.
- Assertion 21: real backend block validation (network gate, no cloud calls) gcp: tofu init -backend=false then tofu validate. Separate unchanged-source pass: staging-tofu.
- Assertion 22: real backend block validation (network gate, no cloud calls) azure: tofu init -backend=false then tofu validate. Separate unchanged-source pass: staging-tofu.
- Assertion 23: real backend block validation (network gate, no cloud calls) oci: tofu init -backend=false then tofu validate. Separate unchanged-source pass: staging-tofu.

### tests/tofu/destroy-real.test.ts (2 skipped)

Reason: **Provider-schema network opt-in**. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

Guard references: `9e62a15:tests/tofu/destroy-real.test.ts:11`; `9e62a15:tests/tofu/destroy-real.test.ts:13`

- Assertion 1: real tofu destroy (ZENITH_TEST_TOFU_NETWORK=1) creates, reviews and destroys builtin state through verified apply. Separate unchanged-source pass: staging-tofu.
- Assertion 2: real tofu destroy (ZENITH_TEST_TOFU_NETWORK=1) creates, reviews and destroys random state through verified apply. Separate unchanged-source pass: staging-tofu.

### tests/tofu/ephemeral-network.test.ts (5 skipped)

Reason: **Provider-schema network opt-in**. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

Guard references: `9e62a15:tests/tofu/ephemeral-network.test.ts:56`

- Assertion 1: real ephemeral resources (network) validates the supported random_password ephemeral schema. Separate unchanged-source pass: staging-tofu.
- Assertion 2: real ephemeral resources (network) rejects persisting a sensitive ephemeral password via output. Separate unchanged-source pass: staging-tofu.
- Assertion 3: real ephemeral resources (network) rejects persisting a sensitive ephemeral password via resource. Separate unchanged-source pass: staging-tofu.
- Assertion 4: real ephemeral resources (network) evaluates a password-dependent condition and keeps generated values out of plan views and state. Separate unchanged-source pass: staging-tofu.
- Assertion 5: real ephemeral resources (network) fails a password-dependent condition without disclosing the generated value. Separate unchanged-source pass: staging-tofu.

### tests/tofu/network.test.ts (4 skipped)

Reason: **Provider-schema network opt-in**. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

Guard references: `9e62a15:tests/tofu/network.test.ts:23`; `9e62a15:tests/tofu/network.test.ts:35`; `9e62a15:tests/tofu/network.test.ts:120`

- Assertion 1: real provider install through the committed lockfile (network) installs hashicorp/random into an empty plugin cache with -lockfile=readonly, then plans and applies a digest-verified plan. Separate unchanged-source pass: staging-tofu.
- Assertion 2: real provider install through the committed lockfile (network) refuses to init when the lockfile does not cover the required provider or carries the wrong hashes. Separate unchanged-source pass: staging-tofu.
- Assertion 3: real provider install through the committed lockfile (network) reproduces the committed lock block for hashicorp/random with `tofu providers lock`. Separate unchanged-source pass: staging-tofu.
- Assertion 4: AWS provider blocks validate against the real provider schema (network, ~160 MB first run) accepts providers.tf.json (region + default_tags), the s3 backend block shape, and typical resource JSON. Separate unchanged-source pass: staging-tofu.

### tests/waitlist/pg-contract.test.ts (38 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `9e62a15:tests/waitlist/pg-contract.test.ts:13`; `9e62a15:tests/waitlist/pg-contract.test.ts:208`

- Assertion 1: WaitlistPostgres lets only Supabase Auth invoke the signup hook and read admitted email/status columns. Separate unchanged-source pass: staging-supabase.
- Assertion 2: WaitlistPostgres rejects absent/queued signups identically and admits the email only after operator admission. Separate unchanged-source pass: staging-supabase.
- Assertion 3: WaitlistPostgres normalizes duplicate joins and preserves the original answers, position and admission. Separate unchanged-source pass: staging-supabase.
- Assertion 4: WaitlistPostgres enforces email 254, occupation 120 and use-case 2000 boundaries in PostgreSQL. Separate unchanged-source pass: staging-supabase.
- Assertion 5: WaitlistPostgres accepts email alone and persists bounded optional profile answers. Separate unchanged-source pass: staging-supabase.
- Assertion 6: WaitlistPostgres lists stable FIFO pages with global counts and admits the oldest queued positions. Separate unchanged-source pass: staging-supabase.
- Assertion 7: WaitlistPostgres refuses an admission count of 0 without changing the queue. Separate unchanged-source pass: staging-supabase.
- Assertion 8: WaitlistPostgres refuses an admission count of -1 without changing the queue. Separate unchanged-source pass: staging-supabase.
- Assertion 9: WaitlistPostgres refuses an admission count of 1001 without changing the queue. Separate unchanged-source pass: staging-supabase.
- Assertion 10: WaitlistPostgres refuses an admission count of null without changing the queue. Separate unchanged-source pass: staging-supabase.
- Assertion 11: WaitlistPostgres accepts both count boundaries and never fills a batch with already admitted users. Separate unchanged-source pass: staging-supabase.
- Assertion 12: WaitlistPostgres replays UUID requests exactly and rejects changed count or actor without admitting more. Separate unchanged-source pass: staging-supabase.
- Assertion 13: WaitlistPostgres persists empty batches so replay cannot admit a later join. Separate unchanged-source pass: staging-supabase.
- Assertion 14: WaitlistPostgres deduplicates simultaneous case-varied joins on independent connections. Separate unchanged-source pass: staging-supabase.
- Assertion 15: WaitlistPostgres serializes overlapping batches into disjoint consecutive FIFO admissions. Separate unchanged-source pass: staging-supabase.
- Assertion 16: WaitlistPostgres replays a concurrently retried request instead of admitting a second batch. Separate unchanged-source pass: staging-supabase.
- Assertion 17: WaitlistPostgres waits for an earlier joining transaction before admitting the queue. Separate unchanged-source pass: staging-supabase.
- Assertion 18: WaitlistPostgres persists an actor-bound FIFO preview without changing the queue. Separate unchanged-source pass: staging-supabase.
- Assertion 19: WaitlistPostgres validates preview modes, counts and exact unique selected IDs. Separate unchanged-source pass: staging-supabase.
- Assertion 20: WaitlistPostgres captures all queued IDs beyond display/count limits and excludes later arrivals. Separate unchanged-source pass: staging-supabase.
- Assertion 21: WaitlistPostgres waits for an in-flight join when creating a preview and locks later joins out of its snapshot. Separate unchanged-source pass: staging-supabase.
- Assertion 22: WaitlistPostgres serializes overlapping snapshots and admits each captured queued entry only once. Separate unchanged-source pass: staging-supabase.
- Assertion 23: WaitlistPostgres replays concurrent preview requests exactly and consumes a preview only once. Separate unchanged-source pass: staging-supabase.
- Assertion 24: WaitlistPostgres rejects another operator, missing previews and expired unused previews without admissions. Separate unchanged-source pass: staging-supabase.
- Assertion 25: WaitlistPostgres prevents request-key reuse across legacy admission and selected previews. Separate unchanged-source pass: staging-supabase.
- Assertion 26: WaitlistPostgres prevents request-key reuse across legacy admission and next previews. Separate unchanged-source pass: staging-supabase.
- Assertion 27: WaitlistPostgres prevents request-key reuse across legacy admission and all previews. Separate unchanged-source pass: staging-supabase.
- Assertion 28: WaitlistPostgres persists zero-count previews and batches without admitting later arrivals. Separate unchanged-source pass: staging-supabase.
- Assertion 29: WaitlistPostgres records newest-first exact admission history including overlap and legacy batches. Separate unchanged-source pass: staging-supabase.
- Assertion 30: WaitlistPostgres returns immutable saved history details and null for an unknown request. Separate unchanged-source pass: staging-supabase.
- Assertion 31: WaitlistPostgres paginates immutable history rows with bounded pages and validates offsets. Separate unchanged-source pass: staging-supabase.
- Assertion 32: WaitlistPostgres filters literal profile text with cursor-independent matched counts and global totals. Separate unchanged-source pass: staging-supabase.
- Assertion 33: WaitlistPostgres grants only service_role the waitlist RPCs, tables and queue sequence. Separate unchanged-source pass: staging-supabase.
- Assertion 34: WaitlistPostgres refuses direct reads, writes and RPC invocation as anon. Separate unchanged-source pass: staging-supabase.
- Assertion 35: WaitlistPostgres refuses direct reads, writes and RPC invocation as authenticated. Separate unchanged-source pass: staging-supabase.
- Assertion 36: WaitlistPostgres refuses direct reads, writes and RPC invocation as supabase_auth_admin. Separate unchanged-source pass: staging-supabase.
- Assertion 37: WaitlistPostgres enforces RLS even with temporary browser SELECT grants and rolls those grants back. Separate unchanged-source pass: staging-supabase.
- Assertion 38: WaitlistPostgres enforces the rate-limit quota and resets an expired counter as service_role. Separate unchanged-source pass: staging-supabase.

### tests/workflows/approval-time.test.ts (3 skipped)

Reason: **Local Temporal server prerequisite**. The shared serverSuite tries an existing local CLI or configured time-skipping server; downloads require explicit permission. Required Temporal lanes fail rather than skip when unavailable. Default unit lacks these enabled server prerequisites.

Guard references: `9e62a15:tests/workflows/approval-time.test.ts:14`; `9e62a15:tests/workflows/approval-time.test.ts:17`

- Assertion 1: approval window (time-skipping server) an approval that never arrives expires the operation after 24 hours and applies nothing. Separate unchanged-source pass: staging-workflows.
- Assertion 2: approval window (time-skipping server) an approval recorded without a signal is still noticed by the periodic re-check. Separate unchanged-source pass: staging-workflows.
- Assertion 3: a worker that goes silent mid-apply (time-skipping server) the heartbeat timeout ends the operation `uncertain`; the apply is not replayed. Separate unchanged-source pass: staging-workflows.

### tests/workflows/client.test.ts (12 skipped)

Reason: **Local Temporal server prerequisite**. The shared serverSuite tries an existing local CLI or configured time-skipping server; downloads require explicit permission. Required Temporal lanes fail rather than skip when unavailable. Default unit lacks these enabled server prerequisites.

Guard references: `9e62a15:tests/workflows/client.test.ts:29`; `9e62a15:tests/workflows/client.test.ts:31`; `9e62a15:tests/workflows/client.test.ts:188`; `9e62a15:tests/workflows/client.test.ts:283`; `9e62a15:tests/workflows/client.test.ts:308`

- Assertion 2: startDeploy is idempotent on the operation id a real accepted start can complete after its response times out, and its operation id still prevents another execution. Separate unchanged-source pass: staging-workflows.
- Assertion 3: startDeploy is idempotent on the operation id a duplicate start while running returns the same execution, and only one workflow runs. Separate unchanged-source pass: staging-workflows.
- Assertion 4: startDeploy is idempotent on the operation id a duplicate start after completion returns the finished execution and does not run it again. Separate unchanged-source pass: staging-workflows.
- Assertion 5: startDeploy is idempotent on the operation id different operations get different workflow ids and runs. Separate unchanged-source pass: staging-workflows.
- Assertion 6: the other start functions startDayTwo and startRemediation start `op-<operationId>` workflows and are idempotent. Separate unchanged-source pass: staging-workflows.
- Assertion 7: the other start functions startReconcile runs one pass per environment at a time, and a finished pass does not block the next. Separate unchanged-source pass: staging-workflows.
- Assertion 8: signals and queries signalApproval and cancelOperation report `not_found` for an unknown operation instead of throwing. Separate unchanged-source pass: staging-workflows.
- Assertion 9: signals and queries getProgress returns live progress, then the final progress, and null for an unknown operation. Separate unchanged-source pass: staging-workflows.
- Assertion 10: signals and queries getProgress does not hang when the worker has gone away: it fails fast with a typed error. Separate unchanged-source pass: staging-workflows.
- Assertion 11: signals and queries cancelOperation asks a running operation to stop. Separate unchanged-source pass: staging-workflows.
- Assertion 14: workflowClient and temporalAvailable reports available for the suite's own server, and a missing namespace as namespace_not_found. Separate unchanged-source pass: staging-workflows.
- Assertion 16: workflowClient and temporalAvailable workflowClient shares one connection per config, does not cache a failed connect, and never echoes the API key. Separate unchanged-source pass: staging-workflows.

### tests/workflows/codec-replay.test.ts (2 skipped)

Reason: **Local Temporal server prerequisite**. The shared serverSuite tries an existing local CLI or configured time-skipping server; downloads require explicit permission. Required Temporal lanes fail rather than skip when unavailable. Default unit lacks these enabled server prerequisites.

Guard references: `9e62a15:tests/workflows/codec-replay.test.ts:15`; `9e62a15:tests/workflows/codec-replay.test.ts:27`

- Assertion 1: codec histories on local Temporal (ZENITH_TEST_TEMPORAL=1) encrypts workflow/activity payloads, supports queries/signals and replays with retained keys. Separate unchanged-source pass: staging-workflows.
- Assertion 2: codec histories on local Temporal (ZENITH_TEST_TEMPORAL=1) replays a legacy plaintext history with an encrypted converter. Separate unchanged-source pass: staging-workflows.

### tests/workflows/deploy.test.ts (38 skipped)

Reason: **Local Temporal server prerequisite**. The shared serverSuite tries an existing local CLI or configured time-skipping server; downloads require explicit permission. Required Temporal lanes fail rather than skip when unavailable. Default unit lacks these enabled server prerequisites.

Guard references: `9e62a15:tests/workflows/deploy.test.ts:15`; `9e62a15:tests/workflows/deploy.test.ts:17`

- Assertion 1: deploy: happy path runs every step in order, records progress, and releases the lease. Separate unchanged-source pass: staging-workflows.
- Assertion 2: deploy: happy path skips the build when the manifest pins images. Separate unchanged-source pass: staging-workflows.
- Assertion 3: deploy: happy path answers the progress query while running and after it finishes. Separate unchanged-source pass: staging-workflows.
- Assertion 4: deploy: happy path carries no credential-shaped keys in any activity input or result. Separate unchanged-source pass: staging-workflows.
- Assertion 5: deploy: validation and policy stops on an invalid desired state before taking the lease. Separate unchanged-source pass: staging-workflows.
- Assertion 6: deploy: validation and policy policy deny fails the operation with the reasons and never applies. Separate unchanged-source pass: staging-workflows.
- Assertion 7: deploy: validation and policy a pre-approved proposal whose policy now requires approval still waits. Separate unchanged-source pass: staging-workflows.
- Assertion 8: deploy: approval waits without a lease, then continues on signal + approval with a fresh lease. Separate unchanged-source pass: staging-workflows.
- Assertion 9: deploy: approval takes an approval that already exists on the spot: no wait, no awaiting_approval flicker, the lease is kept. Separate unchanged-source pass: staging-workflows.
- Assertion 10: deploy: approval a rejected approval fails the operation and applies nothing. Separate unchanged-source pass: staging-workflows.
- Assertion 11: deploy: approval a signal with no decision recorded does not proceed. Separate unchanged-source pass: staging-workflows.
- Assertion 12: deploy: approval a plan that changed during the approval wait is caught by final_plan and never applied. Separate unchanged-source pass: staging-workflows.
- Assertion 13: deploy: plan changed plan_changed at final_plan fails with a re-approval message; apply is never called. Separate unchanged-source pass: staging-workflows.
- Assertion 14: deploy: plan changed a re-plan whose digest differs is refused even if the activity did not throw. Separate unchanged-source pass: staging-workflows.
- Assertion 15: deploy: lease loss and mutating-step failures LeaseLost during apply -> uncertain, and the release is still attempted. Separate unchanged-source pass: staging-workflows.
- Assertion 16: deploy: lease loss and mutating-step failures the lease expiring between steps after an apply -> uncertain, no further mutation. Separate unchanged-source pass: staging-workflows.
- Assertion 17: deploy: lease loss and mutating-step failures a lease lost before anything mutated is a plain failure. Separate unchanged-source pass: staging-workflows.
- Assertion 18: deploy: lease loss and mutating-step failures a busy environment fails cleanly without acting. Separate unchanged-source pass: staging-workflows.
- Assertion 19: deploy: lease loss and mutating-step failures an unclassified apply error is one attempt and ends uncertain (never replayed). Separate unchanged-source pass: staging-workflows.
- Assertion 20: deploy: lease loss and mutating-step failures an apply that ran to a clean failure is failed, with the partial-apply note. Separate unchanged-source pass: staging-workflows.
- Assertion 21: deploy: lease loss and mutating-step failures an unclassified deploy error is uncertain and later steps do not run. Separate unchanged-source pass: staging-workflows.
- Assertion 22: deploy: lease loss and mutating-step failures an unclassified migrate error is uncertain and later steps do not run. Separate unchanged-source pass: staging-workflows.
- Assertion 23: deploy: lease loss and mutating-step failures a build that fails after the apply is failed, and says the apply stays. Separate unchanged-source pass: staging-workflows.
- Assertion 24: deploy: verification failed infrastructure verification -> failed, changes stay applied. Separate unchanged-source pass: staging-workflows.
- Assertion 25: deploy: verification inconclusive application verification -> uncertain, not success. Separate unchanged-source pass: staging-workflows.
- Assertion 26: deploy: verification a failed observation does not undo a verified deployment. Separate unchanged-source pass: staging-workflows.
- Assertion 27: deploy: retries and bookkeeping a transient read failure is retried and the deploy still succeeds. Separate unchanged-source pass: staging-workflows.
- Assertion 28: deploy: retries and bookkeeping a read that keeps failing exhausts 5 attempts, then fails without mutating. Separate unchanged-source pass: staging-workflows.
- Assertion 29: deploy: retries and bookkeeping a progress-projection failure does not abort the deploy. Separate unchanged-source pass: staging-workflows.
- Assertion 30: deploy: retries and bookkeeping the terminal status write is retried until it lands. Separate unchanged-source pass: staging-workflows.
- Assertion 31: deploy: retries and bookkeeping a stub activity fails the operation immediately with a clear reason. Separate unchanged-source pass: staging-workflows.
- Assertion 32: deploy: retries and bookkeeping redacts credential-shaped text from error messages before they are recorded. Separate unchanged-source pass: staging-workflows.
- Assertion 33: deploy: cancellation a cancel signal during deploy cancels the activity, marks cancelled, releases the lease, destroys nothing. Separate unchanged-source pass: staging-workflows.
- Assertion 34: deploy: cancellation Temporal-level cancellation behaves the same as the cancel signal. Separate unchanged-source pass: staging-workflows.
- Assertion 35: deploy: cancellation cancelling during a read step (before any lease) cancels cleanly with no release. Separate unchanged-source pass: staging-workflows.
- Assertion 36: deploy: cancellation cancelling while awaiting approval cancels; the lease was already released for the wait. Separate unchanged-source pass: staging-workflows.
- Assertion 37: deploy: cancellation a cancel signal sent to a workflow that already finished is reported, not thrown. Separate unchanged-source pass: staging-workflows.
- Assertion 38: deploy: workflow failure surface if the terminal status cannot be written at all, the workflow itself fails loudly. Separate unchanged-source pass: staging-workflows.

### tests/workflows/destroy-replay.test.ts (6 skipped)

Reason: **Local Temporal server prerequisite**. The shared serverSuite tries an existing local CLI or configured time-skipping server; downloads require explicit permission. Required Temporal lanes fail rather than skip when unavailable. Default unit lacks these enabled server prerequisites.

Guard references: `9e62a15:tests/workflows/destroy-replay.test.ts:12`; `9e62a15:tests/workflows/destroy-replay.test.ts:22`

- Assertion 1: real destroy workflow histories (ZENITH_TEST_TEMPORAL=1) happy runs and replays against the current definitions. Separate unchanged-source pass: staging-workflows.
- Assertion 2: real destroy workflow histories (ZENITH_TEST_TEMPORAL=1) plan_changed runs and replays against the current definitions. Separate unchanged-source pass: staging-workflows.
- Assertion 3: real destroy workflow histories (ZENITH_TEST_TEMPORAL=1) lease_lost runs and replays against the current definitions. Separate unchanged-source pass: staging-workflows.
- Assertion 4: real destroy workflow histories (ZENITH_TEST_TEMPORAL=1) approval_reject runs and replays against the current definitions. Separate unchanged-source pass: staging-workflows.
- Assertion 5: real destroy workflow histories (ZENITH_TEST_TEMPORAL=1) unknown_absence runs and replays against the current definitions. Separate unchanged-source pass: staging-workflows.
- Assertion 6: real destroy workflow histories (ZENITH_TEST_TEMPORAL=1) preserves and replays the deploy command sequence. Separate unchanged-source pass: staging-workflows.

### tests/workflows/ecs-replica-repair.test.ts (11 skipped)

Reason: **Local Temporal server prerequisite**. The shared serverSuite tries an existing local CLI or configured time-skipping server; downloads require explicit permission. Required Temporal lanes fail rather than skip when unavailable. Default unit lacks these enabled server prerequisites.

Guard references: `9e62a15:tests/workflows/ecs-replica-repair.test.ts:7`; `9e62a15:tests/workflows/ecs-replica-repair.test.ts:9`

- Assertion 1: requires concrete plan approval, then exact final plan and one saved-plan apply. Separate unchanged-source pass: staging-workflows.
- Assertion 2: policy allow alone cannot authorize the concrete repair. Separate unchanged-source pass: staging-workflows.
- Assertion 3: moved final plan refuses apply and requires a new review. Separate unchanged-source pass: staging-workflows.
- Assertion 4: an unclassified apply response is uncertain and is never retried. Separate unchanged-source pass: staging-workflows.
- Assertion 5: lost fence after entering apply preserves uncertainty without compensation. Separate unchanged-source pass: staging-workflows.
- Assertion 6: cancellation after entering apply remains blocking uncertainty (browser-signal). Separate unchanged-source pass: staging-workflows.
- Assertion 7: cancellation after entering apply remains blocking uncertainty (temporal-cancel). Separate unchanged-source pass: staging-workflows.
- Assertion 8: pre-write cancellation stays cancelled without an apply attempt. Separate unchanged-source pass: staging-workflows.
- Assertion 9: a classified cancelled halt after an apply attempt remains uncertain. Separate unchanged-source pass: staging-workflows.
- Assertion 10: pre-repair cancellation history keeps its legacy terminal classification on replay. Separate unchanged-source pass: staging-workflows.
- Assertion 11: histories recorded by the pre-repair day-two workflow replay through the legacy branch. Separate unchanged-source pass: staging-workflows.

### tests/workflows/mtls-live.test.ts (2 skipped)

Reason: **External mTLS acceptance opt-in**. ZENITH_TEST_TEMPORAL_MTLS=1 and an authorized external namespace, address and certificate/key files are required. Disposable local Temporal does not prove external mTLS.

Guard references: `9e62a15:tests/workflows/mtls-live.test.ts:7`; `9e62a15:tests/workflows/mtls-live.test.ts:9`

- Assertion 1: external Temporal mTLS (ZENITH_TEST_TEMPORAL_MTLS=1) web transport authenticates and reads the configured namespace. No separately matched unchanged-source pass in this audit.
- Assertion 2: external Temporal mTLS (ZENITH_TEST_TEMPORAL_MTLS=1) worker transport authenticates and reads the configured namespace. No separately matched unchanged-source pass in this audit.

### tests/workflows/operations.test.ts (28 skipped)

Reason: **Local Temporal server prerequisite**. The shared serverSuite tries an existing local CLI or configured time-skipping server; downloads require explicit permission. Required Temporal lanes fail rather than skip when unavailable. Default unit lacks these enabled server prerequisites.

Guard references: `9e62a15:tests/workflows/operations.test.ts:12`; `9e62a15:tests/workflows/operations.test.ts:14`

- Assertion 1: day-two workflow runs lease -> policy -> execute -> verify -> finalize -> release and marks succeeded. Separate unchanged-source pass: staging-workflows.
- Assertion 2: day-two workflow re-checks policy and a deny stops it before anything runs. Separate unchanged-source pass: staging-workflows.
- Assertion 3: day-two workflow waits for approval without a lease, then runs under a fresh one. Separate unchanged-source pass: staging-workflows.
- Assertion 4: day-two workflow a rejected approval fails it and executes nothing. Separate unchanged-source pass: staging-workflows.
- Assertion 5: day-two workflow a capability that reports failure is failed, and is never retried. Separate unchanged-source pass: staging-workflows.
- Assertion 6: day-two workflow an unclassified execution error is one attempt and ends uncertain. Separate unchanged-source pass: staging-workflows.
- Assertion 7: day-two workflow a lost lease during execution is uncertain. Separate unchanged-source pass: staging-workflows.
- Assertion 8: day-two workflow failed verification -> failed, recorded, not retried, not rolled back. Separate unchanged-source pass: staging-workflows.
- Assertion 9: day-two workflow inconclusive verification -> uncertain. Separate unchanged-source pass: staging-workflows.
- Assertion 10: day-two workflow cancelling during execution cancels the activity, marks cancelled and releases the lease. Separate unchanged-source pass: staging-workflows.
- Assertion 11: remediation workflow runs lease -> policy -> execute -> verify -> finalize -> release and marks succeeded. Separate unchanged-source pass: staging-workflows.
- Assertion 12: remediation workflow re-checks policy and a deny stops it before anything runs. Separate unchanged-source pass: staging-workflows.
- Assertion 13: remediation workflow waits for approval without a lease, then runs under a fresh one. Separate unchanged-source pass: staging-workflows.
- Assertion 14: remediation workflow a rejected approval fails it and executes nothing. Separate unchanged-source pass: staging-workflows.
- Assertion 15: remediation workflow a capability that reports failure is failed, and is never retried. Separate unchanged-source pass: staging-workflows.
- Assertion 16: remediation workflow an unclassified execution error is one attempt and ends uncertain. Separate unchanged-source pass: staging-workflows.
- Assertion 17: remediation workflow a lost lease during execution is uncertain. Separate unchanged-source pass: staging-workflows.
- Assertion 18: remediation workflow failed verification -> failed, recorded, not retried, not rolled back. Separate unchanged-source pass: staging-workflows.
- Assertion 19: remediation workflow inconclusive verification -> uncertain. Separate unchanged-source pass: staging-workflows.
- Assertion 20: remediation workflow cancelling during execution cancels the activity, marks cancelled and releases the lease. Separate unchanged-source pass: staging-workflows.
- Assertion 21: remediation workflow: never re-runs a failed remediation is not retried by the workflow, whatever the failure. Separate unchanged-source pass: staging-workflows.
- Assertion 22: reconcile workflow takes the reconcile lease, observes, reports the counts and releases. Separate unchanged-source pass: staging-workflows.
- Assertion 23: reconcile workflow allowAutoRepair requests canonical proposal consideration without a workflow execution bypass. Separate unchanged-source pass: staging-workflows.
- Assertion 24: reconcile workflow no drift with auto-repair allowed reports nothing to repair. Separate unchanged-source pass: staging-workflows.
- Assertion 25: reconcile workflow another pass holding the lease means this one is skipped, without observing. Separate unchanged-source pass: staging-workflows.
- Assertion 26: reconcile workflow a patched history rejects an old count-only activity response instead of claiming repair consideration. Separate unchanged-source pass: staging-workflows.
- Assertion 27: reconcile workflow an observation failure is reported as a failed pass, and the lease is still released. Separate unchanged-source pass: staging-workflows.
- Assertion 28: reconcile workflow cancelling the workflow releases the lease and cancels the observation. Separate unchanged-source pass: staging-workflows.

### tests/workflows/reconcile.test.ts (2 skipped)

Reason: **Local Temporal server prerequisite**. The shared serverSuite tries an existing local CLI or configured time-skipping server; downloads require explicit permission. Required Temporal lanes fail rather than skip when unavailable. Default unit lacks these enabled server prerequisites.

Guard references: `9e62a15:tests/workflows/reconcile.test.ts:19`; `9e62a15:tests/workflows/reconcile.test.ts:22`

- Assertion 1: canonical reconciliation through the real Temporal SDK persists an observation and broker proposal under the same real fence, without bypassing human approval. Separate unchanged-source pass: staging-workflows.
- Assertion 2: canonical reconciliation through the real Temporal SDK records the exact pre-patch workflow and replays its original command/result branch. Separate unchanged-source pass: staging-workflows.

### tests/workflows/replay.test.ts (7 skipped)

Reason: **Local Temporal server prerequisite**. The shared serverSuite tries an existing local CLI or configured time-skipping server; downloads require explicit permission. Required Temporal lanes fail rather than skip when unavailable. Default unit lacks these enabled server prerequisites.

Guard references: `9e62a15:tests/workflows/replay.test.ts:26`; `9e62a15:tests/workflows/replay.test.ts:28`

- Assertion 1: replaying histories recorded by the current workflows deploy: happy path. Separate unchanged-source pass: staging-workflows.
- Assertion 2: replaying histories recorded by the current workflows deploy: approval wait, signal, and a second lease. Separate unchanged-source pass: staging-workflows.
- Assertion 3: replaying histories recorded by the current workflows deploy: a failure path (lease lost during apply). Separate unchanged-source pass: staging-workflows.
- Assertion 4: replaying histories recorded by the current workflows deploy: cancellation mid-flight. Separate unchanged-source pass: staging-workflows.
- Assertion 5: replaying histories recorded by the current workflows deploy: retried reads (activity attempts do not disturb replay). Separate unchanged-source pass: staging-workflows.
- Assertion 6: replaying histories recorded by the current workflows day-two, remediation and reconcile. Separate unchanged-source pass: staging-workflows.
- Assertion 7: the replay check has teeth the same history is rejected by a workflow that schedules its activities in a different order. Separate unchanged-source pass: staging-workflows.

### tests/workflows/worker.test.ts (1 skipped)

Reason: **Local Temporal server prerequisite**. The shared serverSuite tries an existing local CLI or configured time-skipping server; downloads require explicit permission. Required Temporal lanes fail rather than skip when unavailable. Default unit lacks these enabled server prerequisites.

Guard references: `9e62a15:tests/workflows/worker.test.ts:22`; `9e62a15:tests/workflows/worker.test.ts:128`

- Assertion 16: rolling replacement of the execution worker a draining worker lets the running activity finish once; the next worker completes the workflow. Separate unchanged-source pass: staging-workflows.

## Complete staging-unit skip catalogue

### tests/acceptance/sample-app.test.ts (1 skipped)

Reason: **Explicit real-network opt-in**. ZENITH_TEST_NETWORK=1 is required for the non-routable TCP timeout check. The default unit run disables this opt-in.

Guard references: `356b7d0:tests/acceptance/sample-app.test.ts:10`; `356b7d0:tests/acceptance/sample-app.test.ts:14`; `356b7d0:tests/acceptance/sample-app.test.ts:26`

- Assertion 1: acceptance fixture real Node HTTP app real non-routable TCP: /db times out and /health remains 200 (network opt-in required). No separately matched unchanged-source pass in this audit.

### tests/agent-control-journal-fixes.test.ts (6 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `356b7d0:tests/agent-control-journal-fixes.test.ts:469`

- Assertion 24: postgres agent journal: lease, un-approve and the queue (live) refuses a finalize after the lease lapsed, and the row is resolved as uncertain, never as a success. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 25: postgres agent journal: lease, un-approve and the queue (live) still finalizes while the lease holds. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 26: postgres agent journal: lease, un-approve and the queue (live) withdraws an approval: phase, columns and document all go back, and it cannot be claimed. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 27: postgres agent journal: lease, un-approve and the queue (live) refuses to withdraw a claimed, foreign, changed or unapproved operation, and changes nothing. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 28: postgres agent journal: lease, un-approve and the queue (live) an un-approve racing a claim on two connections has exactly one winner, whichever gets the row first. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 29: postgres agent journal: lease, un-approve and the queue (live) lists an uncertain operation in the review queue, read-only. Separate unchanged-source pass: fresh-uncovered-postgres.

### tests/agent-control-journal.test.ts (7 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `356b7d0:tests/agent-control-journal.test.ts:122`; `356b7d0:tests/agent-control-journal.test.ts:132`; `356b7d0:tests/agent-control-journal.test.ts:336`

- Assertion 22: postgres agent journal (live) two connections racing one claim: exactly one wins, the other sees the row unchanged. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 23: postgres agent journal (live) a lease past its end reconciles to uncertain, and is never re-dispatched. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 24: postgres agent journal (live) a finalize with a stale fence changes zero rows. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 25: postgres agent journal (live) an application authority that moved during dispatch refuses to finalize. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 26: postgres agent journal (live) (workspace, subject, request_key) is unique, so prepare is idempotent in the database. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 27: postgres agent journal (live) claims, finalizes and reads back through the same interface the file store satisfies. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 28: postgres agent journal (live) refuses every read and write until the schema ledger is what this build needs. Separate unchanged-source pass: fresh-uncovered-postgres.

### tests/agent-control/pg-contract.test.ts (16 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `356b7d0:tests/agent-control/pg-contract.test.ts:43`; `356b7d0:tests/agent-control/pg-contract.test.ts:248`; `356b7d0:tests/agent-control/pg-contract.test.ts:465`

- Assertion 1: AgentControlPostgres the claim gives one of two racing instances the operation and the other nothing. Separate unchanged-source pass: staging-supabase.
- Assertion 2: AgentControlPostgres the claim leaves the loser a row to read rather than an error to interpret. Separate unchanged-source pass: staging-supabase.
- Assertion 3: AgentControlPostgres the claim serialises a claim behind an open transaction and still yields one winner. Separate unchanged-source pass: staging-supabase.
- Assertion 4: AgentControlPostgres the claim refuses to claim what the browser has not approved, or what expired while it waited. Separate unchanged-source pass: staging-supabase.
- Assertion 5: AgentControlPostgres the claim refuses a claim whose reviewed digest or state fingerprint moved. Separate unchanged-source pass: staging-supabase.
- Assertion 6: AgentControlPostgres the fence refuses a finalize carrying the fence of an earlier claim. Separate unchanged-source pass: staging-supabase.
- Assertion 7: AgentControlPostgres the fence refuses a finalize after the lease has lapsed, and reconciliation then owns the row. Separate unchanged-source pass: staging-supabase.
- Assertion 8: AgentControlPostgres the fence refuses a finalize whose authority moved while the action ran. Separate unchanged-source pass: staging-supabase.
- Assertion 9: AgentControlPostgres the fence renews a lease only for the holder of the current fence. Separate unchanged-source pass: staging-supabase.
- Assertion 10: AgentControlPostgres reconciliation turns an expired lease into uncertain once, and never back into a dispatch. Separate unchanged-source pass: staging-supabase.
- Assertion 11: AgentControlPostgres reconciliation leaves a live lease alone. Separate unchanged-source pass: staging-supabase.
- Assertion 12: AgentControlPostgres reconciliation expires a proposal nobody reviewed, without touching one that is running. Separate unchanged-source pass: staging-supabase.
- Assertion 13: AgentControlPostgres the operation row makes an idempotent prepare a database fact. Separate unchanged-source pass: staging-supabase.
- Assertion 14: AgentControlPostgres the operation row refuses a phase outside the eight the contract names. Separate unchanged-source pass: staging-supabase.
- Assertion 15: AgentControlPostgres the operation row keeps an operation's events with it, and takes them when it goes. Separate unchanged-source pass: staging-supabase.
- Assertion 16: AgentControlPostgres the indexes the reconciliation scan depends on keeps both partial indexes, with their WHERE clauses. Separate unchanged-source pass: staging-supabase.

### tests/agent-link/pg-contract.test.ts (14 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `356b7d0:tests/agent-link/pg-contract.test.ts:58`; `356b7d0:tests/agent-link/pg-contract.test.ts:223`; `356b7d0:tests/agent-link/pg-contract.test.ts:422`

- Assertion 1: AgentLinkPostgres credentials issues, verifies, revokes and then refuses ;  the whole lifetime of one bearer. Separate unchanged-source pass: staging-supabase.
- Assertion 2: AgentLinkPostgres credentials refuses a credential whose expiry has passed, on the predicate and not on a caller's memory. Separate unchanged-source pass: staging-supabase.
- Assertion 3: AgentLinkPostgres credentials refuses two credentials with one token hash. Separate unchanged-source pass: staging-supabase.
- Assertion 4: AgentLinkPostgres credentials refuses a token hash that is not 64 hex characters, and a credential with no project. Separate unchanged-source pass: staging-supabase.
- Assertion 5: AgentLinkPostgres the link code moves pending to approved exactly once, however many times the form is submitted. Separate unchanged-source pass: staging-supabase.
- Assertion 6: AgentLinkPostgres the link code hands the secret back once and destroys it in the same statement. Separate unchanged-source pass: staging-supabase.
- Assertion 7: AgentLinkPostgres the link code cannot read the secret back from a plain RETURNING, which is why the statement is shaped that way. Separate unchanged-source pass: staging-supabase.
- Assertion 8: AgentLinkPostgres the link code gives two concurrent pollers one token between them. Separate unchanged-source pass: staging-supabase.
- Assertion 9: AgentLinkPostgres the link code sweeps expired codes and destroys their secrets, and a second pass finds nothing. Separate unchanged-source pass: staging-supabase.
- Assertion 10: AgentLinkPostgres the link code refuses a state outside the five the protocol names. Separate unchanged-source pass: staging-supabase.
- Assertion 11: AgentLinkPostgres the durable rate limiter counts inside a window and starts the next one at one. Separate unchanged-source pass: staging-supabase.
- Assertion 12: AgentLinkPostgres the durable rate limiter keeps one row per scope, key and window, and refuses a negative count. Separate unchanged-source pass: staging-supabase.
- Assertion 13: AgentLinkPostgres the schema itself keeps row level security on with no policies, so only the service role reaches it. Separate unchanged-source pass: staging-supabase.
- Assertion 14: AgentLinkPostgres the schema itself indexes the credential lookups the authorization path makes. Separate unchanged-source pass: staging-supabase.

### tests/bridge/steps.test.ts (1 skipped)

Reason: **Nonportable stale path prerequisite**. The compatibility guard requires a hard-coded Z:/Projects/.../ws-act product-port.ts path that is absent. Current repository product-port exists. Root separately matched 23 phase/title rows; this does not change the one skipped test.

Guard references: `356b7d0:tests/bridge/steps.test.ts:19`; `356b7d0:tests/bridge/steps.test.ts:20`

- Assertion 3: worker projection compatibility matches its title/phase table and row order. No separately matched unchanged-source pass in this audit.

### tests/cli/config.test.ts (1 skipped)

Reason: **Different operating system**. This Windows inherited-ACL assertion runs only when process.platform is win32. The local report was produced on macOS ARM64.

Guard references: `356b7d0:tests/cli/config.test.ts:34`; `356b7d0:tests/cli/config.test.ts:40`; `356b7d0:tests/cli/config.test.ts:86`

- Assertion 3: private login config Windows refuses inherited ACLs that grant other identities access. No separately matched unchanged-source pass in this audit.

### tests/controlplane/executor.test.ts (1 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `356b7d0:tests/controlplane/executor.test.ts:277`

- Assertion 20: cross-engine shape identity PGlite and PostgreSQL return deeply equal rows for the same statement. Separate unchanged-source pass: staging-platform-postgres.

### tests/controlplane/migrations.test.ts (4 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `356b7d0:tests/controlplane/migrations.test.ts:350`

- Assertion 14: migrator [postgres] concurrency and fail-closed open schema 6 emitted hardening upgrades through the canonical migrator under a distinct owner with RLS, role isolation and immutable artifacts. Separate unchanged-source pass: staging-platform-postgres.
- Assertion 15: migrator [postgres] concurrency and fail-closed open two migrators racing on an empty database converge: one applies, the other finds it done. Separate unchanged-source pass: staging-platform-postgres.
- Assertion 16: migrator [postgres] concurrency and fail-closed open openPlatformDb({ kind: 'postgres' }) does not migrate unless asked, and a bare open sees the schema as behind. Separate unchanged-source pass: staging-platform-postgres.
- Assertion 17: migrator [postgres] concurrency and fail-closed open BOOTSTRAP_SQL is idempotent. Separate unchanged-source pass: staging-platform-postgres.

### tests/controlplane/open.test.ts (2 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `356b7d0:tests/controlplane/open.test.ts:202`

- Assertion 15: platformDb() against PostgreSQL opens a migrated database using ZENITH_PLATFORM_DB_URL, with the schema check passing. Separate unchanged-source pass: staging-platform-postgres.
- Assertion 16: platformDb() against PostgreSQL fails CLOSED against an un-migrated database with the command to run, and does not cache the failure. Separate unchanged-source pass: staging-platform-postgres.

### tests/db/contract/alerts.test.ts (7 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `356b7d0:tests/db/contract/alerts.test.ts:35`; `356b7d0:tests/db/contract/alerts.test.ts:106`

- Assertion 1: alerts on Postgres refuses a second standing rule for one (environment, kind). No separately matched unchanged-source pass in this audit.
- Assertion 2: alerts on Postgres round-trips an event through open and resolved. No separately matched unchanged-source pass in this audit.
- Assertion 3: alerts on Postgres lets exactly one of two snapshots claim a pending row. No separately matched unchanged-source pass in this audit.
- Assertion 4: alerts on Postgres reclaims a claim older than the lease and leaves a live one alone. No separately matched unchanged-source pass in this audit.
- Assertion 5: alerts on Postgres refuses a second outbox row for one idempotency key. No separately matched unchanged-source pass in this audit.
- Assertion 6: alerts on Postgres round-trips a security finding. No separately matched unchanged-source pass in this audit.
- Assertion 7: alerts on Postgres round-trips a Navigator run. No separately matched unchanged-source pass in this audit.

### tests/db/contract/audit.test.ts (1 skipped)

Reason: **Intentionally different backend**. The scenario has an only-backend selector; the repeated FileStore instance is outside that scenario’s backend scope. Do not treat the FileStore repetition as an unexecuted universal backend promise.

Guard references: `356b7d0:tests/db/contract/audit.test.ts:212`

- Assertion 8: audit contract ;  'FileStore' a retried append writes nothing twice. No separately matched unchanged-source pass in this audit.

### tests/db/contract/history.test.ts (7 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `356b7d0:tests/db/contract/history.test.ts:245`

- Assertion 8: history contract ;  Postgres only seeds a second workspace to work in. No separately matched unchanged-source pass in this audit.
- Assertion 9: history contract ;  Postgres only promotes the indexed columns and leaves them out of data. No separately matched unchanged-source pass in this audit.
- Assertion 10: history contract ;  Postgres only reads a manifest back through the accessor with a cold cache. No separately matched unchanged-source pass in this audit.
- Assertion 11: history contract ;  Postgres only assigns a dense seq per deployment across two instances. No separately matched unchanged-source pass in this audit.
- Assertion 12: history contract ;  Postgres only refuses a write against a row another instance already moved. No separately matched unchanged-source pass in this audit.
- Assertion 13: history contract ;  Postgres only bumps the change feed for the workspace a deployment belongs to. No separately matched unchanged-source pass in this audit.
- Assertion 14: history contract ;  Postgres only keeps rows outside the snapshot's scope when it resets. No separately matched unchanged-source pass in this audit.

### tests/db/contract/workspace-sharing.test.ts (22 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `356b7d0:tests/db/contract/workspace-sharing.test.ts:11`; `356b7d0:tests/db/contract/workspace-sharing.test.ts:159`

- Assertion 1: WorkspaceSharingPostgres grants execute only to the service role, excluding PUBLIC, anon and authenticated. Separate unchanged-source pass: staging-supabase.
- Assertion 2: WorkspaceSharingPostgres keeps the owner present and administrative until ownership is transferred. Separate unchanged-source pass: staging-supabase.
- Assertion 3: WorkspaceSharingPostgres requires the owner for granting or managing admin access and transferring ownership. Separate unchanged-source pass: staging-supabase.
- Assertion 4: WorkspaceSharingPostgres uses actor identity rather than a claimed member email to authorize sharing. Separate unchanged-source pass: staging-supabase.
- Assertion 5: WorkspaceSharingPostgres allows admins to manage non-admin collaborators and lets non-owners leave. Separate unchanged-source pass: staging-supabase.
- Assertion 6: WorkspaceSharingPostgres rechecks a competing remover's authority after the owner demotes that admin. Separate unchanged-source pass: staging-supabase.
- Assertion 7: WorkspaceSharingPostgres rechecks a competing role change after the owner removes the acting admin. Separate unchanged-source pass: staging-supabase.
- Assertion 8: WorkspaceSharingPostgres protects the newly transferred owner against a competing removal. Separate unchanged-source pass: staging-supabase.
- Assertion 9: WorkspaceSharingPostgres refuses a second ownership transfer from the former owner after waiting for the first. Separate unchanged-source pass: staging-supabase.
- Assertion 10: WorkspaceSharingPostgres accepts a normalized matching email while refusing another signed-in identity's email. Separate unchanged-source pass: staging-supabase.
- Assertion 11: WorkspaceSharingPostgres rejects a revoked invitation even when a caller retained its former live state. Separate unchanged-source pass: staging-supabase.
- Assertion 12: WorkspaceSharingPostgres rechecks invitation revocation after a competing accept waits for the workspace lock. Separate unchanged-source pass: staging-supabase.
- Assertion 13: WorkspaceSharingPostgres renews an expired invitation on resend, while refusing to renew a revoked offer. Separate unchanged-source pass: staging-supabase.
- Assertion 14: WorkspaceSharingPostgres refuses expired invitations without creating membership. Separate unchanged-source pass: staging-supabase.
- Assertion 15: WorkspaceSharingPostgres does not restore access when an accepted invitation is replayed after removal. Separate unchanged-source pass: staging-supabase.
- Assertion 16: WorkspaceSharingPostgres preserves an existing member's role when accepting an older admin invitation. Separate unchanged-source pass: staging-supabase.
- Assertion 17: WorkspaceSharingPostgres revokes old pending offers when a member exits through remove-member. Separate unchanged-source pass: staging-supabase.
- Assertion 18: WorkspaceSharingPostgres revokes old pending offers when a member exits through leave. Separate unchanged-source pass: staging-supabase.
- Assertion 19: WorkspaceSharingPostgres commits an audit event with a role change and writes no event for a refused mutation. Separate unchanged-source pass: staging-supabase.
- Assertion 20: WorkspaceSharingPostgres lets a fresh invitation replace an expired pending offer without reviving the old one. Separate unchanged-source pass: staging-supabase.
- Assertion 21: WorkspaceSharingPostgres allows one pending invitation per normalized address and workspace under competing requests. Separate unchanged-source pass: staging-supabase.
- Assertion 22: WorkspaceSharingPostgres cannot use an invitation or membership id from a different workspace. Separate unchanged-source pass: staging-supabase.

### tests/execution/apply.test.ts (5 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `356b7d0:tests/execution/apply.test.ts:319`

- Assertion 21: dispatch current authority [postgres] refuses expired approval after fresh replan and before durable dispatch. Separate unchanged-source pass: staging-platform-postgres.
- Assertion 22: dispatch current authority [postgres] refuses revoked approver role after fresh replan and before durable dispatch. Separate unchanged-source pass: staging-platform-postgres.
- Assertion 23: dispatch current authority [postgres] refuses new policy denial after fresh replan and before durable dispatch. Separate unchanged-source pass: staging-platform-postgres.
- Assertion 24: dispatch current authority [postgres] refuses expiry after authority check after fresh replan and before durable dispatch. Separate unchanged-source pass: staging-platform-postgres.
- Assertion 25: dispatch current authority [postgres] refuses expiry during role lookup after fresh replan and before durable dispatch. Separate unchanged-source pass: staging-platform-postgres.

### tests/execution/deletion-guards-real.test.ts (1 skipped)

Reason: **Separate real-OpenTofu removal opt-in**. ZENITH_TEST_DELETION_GUARDS_TOFU=1 and an available OpenTofu binary are required. The generic network provider opt-in alone does not enable this test.

Guard references: `356b7d0:tests/execution/deletion-guards-real.test.ts:15`; `356b7d0:tests/execution/deletion-guards-real.test.ts:19`

- Assertion 1: real tofu deploy removal (ZENITH_TEST_DELETION_GUARDS_TOFU=1) refuses unapproved stateful removal and applies the exact approved deletion. No separately matched unchanged-source pass in this audit.

### tests/execution/destroy-review.test.ts (2 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `356b7d0:tests/execution/destroy-review.test.ts:273`; `356b7d0:tests/execution/destroy-review.test.ts:285`

- Assertion 19: real Postgres destroy-review lane persists the first pending review with a readable PlanView. Separate unchanged-source pass: staging-platform-postgres.
- Assertion 20: undecided teardown supersession [postgres] an independent partial approval wins the operation lock and prevents refresh cancellation without revoking grants. Separate unchanged-source pass: staging-platform-postgres.

### tests/hosted/artifacts/storage-store.test.ts (2 skipped)

Reason: **Authorized live hosted-service fixture**. ZENITH_CONTRACT_POSTGRES=1, NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. The tracker branch also checks atomic functions. Disposable PostgreSQL contracts do not establish hosted bucket/data-service acceptance.

Guard references: `356b7d0:tests/hosted/artifacts/storage-store.test.ts:343`; `356b7d0:tests/hosted/artifacts/storage-store.test.ts:351`

- Assertion 11: StorageArtifactStore (live bucket) puts a bundle, reads it back byte for byte, and serves a range. No separately matched unchanged-source pass in this audit.
- Assertion 12: StorageArtifactStore (live bucket) removes everything it wrote. No separately matched unchanged-source pass in this audit.

### tests/hosted/data/pg-contract.live.test.ts (11 skipped)

Reason: **Authorized live hosted-service fixture**. ZENITH_CONTRACT_POSTGRES=1, NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. The tracker branch also checks atomic functions. Disposable PostgreSQL contracts do not establish hosted bucket/data-service acceptance.

Guard references: `356b7d0:tests/hosted/data/pg-contract.live.test.ts:42`; `356b7d0:tests/hosted/data/pg-contract.live.test.ts:85`; `356b7d0:tests/hosted/data/pg-contract.live.test.ts:139`; `356b7d0:tests/hosted/data/pg-contract.live.test.ts:339`

- Assertion 1: the tracker contract against real Postgres tables creates, reads back and pages the records it stored. No separately matched unchanged-source pass in this audit.
- Assertion 2: the tracker contract against real Postgres tables lets the first writer through and refuses the second with stale_version. No separately matched unchanged-source pass in this audit.
- Assertion 3: the tracker contract against real Postgres tables replays a retried write id instead of writing a second record. No separately matched unchanged-source pass in this audit.
- Assertion 4: the tracker contract against real Postgres tables refuses a record that would take the app past its storage ceiling, and writes nothing. No separately matched unchanged-source pass in this audit.
- Assertion 5: the tracker contract against real Postgres tables keeps one app's records out of another app's reach. No separately matched unchanged-source pass in this audit.
- Assertion 6: the tracker contract against real Postgres tables accounts storage as the same logical-byte figure the measure defines. No separately matched unchanged-source pass in this audit.
- Assertion 7: the tracker contract against real Postgres tables commits the record, the counter and the ledger row together. No separately matched unchanged-source pass in this audit.
- Assertion 8: the whole-app operations against real Postgres tables imports a bundle, skips ids already stored, and keeps the counter true. No separately matched unchanged-source pass in this audit.
- Assertion 9: the whole-app operations against real Postgres tables reports the logical integrity check, and it passes on rows it just wrote. No separately matched unchanged-source pass in this audit.
- Assertion 10: the whole-app operations against real Postgres tables empties the probe namespace and leaves the app's own rows alone. No separately matched unchanged-source pass in this audit.
- Assertion 11: the whole-app operations against real Postgres tables refuses to empty anything that is not a probe namespace. No separately matched unchanged-source pass in this audit.

### tests/machines/azure-scripts.test.ts (6 skipped)

Reason: **Missing executable alias**. The collector probes the literal python executable with -I. That alias was unavailable in this run although python3 exists. This is not an OS-wide Azure restriction and passing elsewhere is not Azure guest delivery proof.

Guard references: `356b7d0:tests/machines/azure-scripts.test.ts:13`; `356b7d0:tests/machines/azure-scripts.test.ts:34`

- Assertion 1: Azure fixed Python collector locally all semantic and argv collector programs compile. No separately matched unchanged-source pass in this audit.
- Assertion 2: Azure fixed Python collector locally metacharacters, quotes and newlines round-trip as argv data without a shell. No separately matched unchanged-source pass in this audit.
- Assertion 3: Azure fixed Python collector locally drains large output with bounded memory and a complete sub-4-KiB envelope. No separately matched unchanged-source pass in this audit.
- Assertion 4: Azure fixed Python collector locally child processes receive an explicit environment without collector secrets. No separately matched unchanged-source pass in this audit.
- Assertion 5: Azure fixed Python collector locally preserves the child's actual nonzero exit status. No separately matched unchanged-source pass in this audit.
- Assertion 6: Azure fixed Python collector locally terminates a timed-out command and marks its outcome. No separately matched unchanged-source pass in this audit.

### tests/machines/ssm-documents.test.ts (13 skipped)

Reason: **Broken shell prerequisite detection**. The native shell harness builds sh sh -s, which fails its probe. Root independently found sh -s succeeds. The thirteen guarded script assertions remain skipped; repair is still needed. FileRead also excludes Darwin, but the earlier broken probe already disables its cases.

Guard references: `356b7d0:tests/machines/ssm-documents.test.ts:318`; `356b7d0:tests/machines/ssm-documents.test.ts:326`; `356b7d0:tests/machines/ssm-documents.test.ts:363`; `356b7d0:tests/machines/ssm-documents.test.ts:395`; `356b7d0:tests/machines/ssm-documents.test.ts:463`; `356b7d0:tests/machines/ssm-documents.test.ts:482`; `356b7d0:tests/machines/ssm-documents.test.ts:492`

- Assertion 84: script behaviour: input validation (runs the real scripts under sh) refuses hostile units with exit 64 before touching systemctl. No separately matched unchanged-source pass in this audit.
- Assertion 85: script behaviour: input validation (runs the real scripts under sh) refuses to restart protected units with exit 65. No separately matched unchanged-source pass in this audit.
- Assertion 86: script behaviour: input validation (runs the real scripts under sh) enforces a restart allowlist baked into the document. No separately matched unchanged-source pass in this audit.
- Assertion 87: script behaviour: input validation (runs the real scripts under sh) an agent too old for ENV_VAR (empty variables) fails closed, naming the cause. No separately matched unchanged-source pass in this audit.
- Assertion 88: script behaviour: input validation (runs the real scripts under sh) validates numeric, enum and boolean parameters. No separately matched unchanged-source pass in this audit.
- Assertion 89: script behaviour: input validation (runs the real scripts under sh) refuses metadata names and malformed hosts in PortCheck and DnsCheck (exit 64/65, before any network tool). No separately matched unchanged-source pass in this audit.
- Assertion 90: script behaviour: input validation (runs the real scripts under sh) PortCheck refuses link-local and metadata addresses after resolution (skipped where getent is missing). No separately matched unchanged-source pass in this audit.
- Assertion 91: script behaviour: FileRead guards (real files in a private temp dir) reads an allowed regular file as base64 with size and truncation facts. No separately matched unchanged-source pass in this audit.
- Assertion 92: script behaviour: FileRead guards (real files in a private temp dir) caps output at 16384 bytes whatever maxBytes says, and reports truncation. No separately matched unchanged-source pass in this audit.
- Assertion 93: script behaviour: FileRead guards (real files in a private temp dir) refuses traversal, symlink escapes and secret-like names. No separately matched unchanged-source pass in this audit.
- Assertion 94: script behaviour: FileRead guards (real files in a private temp dir) a symlink may point at another allowed file, but not at an unlisted one. No separately matched unchanged-source pass in this audit.
- Assertion 95: script behaviour: FileRead guards (real files in a private temp dir) exact-file allowlist entries allow only that file. No separately matched unchanged-source pass in this audit.
- Assertion 96: script behaviour: FileRead guards (real files in a private temp dir) reports missing files and non-regular files. No separately matched unchanged-source pass in this audit.

### tests/platform/source-bundle.test.ts (1 skipped)

Reason: **Authorized public GitHub network fixture**. ZENITH_TEST_SOURCE_GITHUB=1 plus an authorized repository and pinned 40-hex commit are required; ordinary mocked source tests do not replace this download check.

Guard references: `356b7d0:tests/platform/source-bundle.test.ts:296`; `356b7d0:tests/platform/source-bundle.test.ts:354`; `356b7d0:tests/platform/source-bundle.test.ts:406`; `356b7d0:tests/platform/source-bundle.test.ts:411`

- Assertion 78: live public GitHub source (opt-in network) downloads a pinned public commit into a source bundle. Separate unchanged-source pass: staging-workflows.

### tests/providers/kubernetes/kind.test.ts (6 skipped)

Reason: **Disposable Kubernetes cluster opt-in**. ZENITH_TEST_KIND=1 and a disposable KUBECONFIG are required; release tests also require a pinned non-root release image. Dedicated kind reports are listed separately.

Guard references: `356b7d0:tests/providers/kubernetes/kind.test.ts:34`; `356b7d0:tests/providers/kubernetes/kind.test.ts:36`

- Assertion 1: kubernetes provider against a real cluster (kind) creates the namespace, policy and workload, then a second apply changes nothing. Separate unchanged-source pass: staging-kind.
- Assertion 2: kubernetes provider against a real cluster (kind) rolls out, and the drivers observe, verify and report runtime. Separate unchanged-source pass: staging-kind.
- Assertion 3: kubernetes provider against a real cluster (kind) refuses to touch a same-named object it does not own. Separate unchanged-source pass: staging-kind.
- Assertion 4: kubernetes provider against a real cluster (kind) restarts, scales and reads logs and events through the operations. Separate unchanged-source pass: staging-kind.
- Assertion 5: kubernetes provider against a real cluster (kind) deploys a new image, rolls back to the previous revision, and the pods follow. Separate unchanged-source pass: staging-kind.
- Assertion 6: kubernetes provider against a real cluster (kind) prunes what is no longer desired and never deletes the namespace. Separate unchanged-source pass: staging-kind.

### tests/providers/kubernetes/release-kind.test.ts (1 skipped)

Reason: **Disposable Kubernetes cluster opt-in**. ZENITH_TEST_KIND=1 and a disposable KUBECONFIG are required; release tests also require a pinned non-root release image. Dedicated kind reports are listed separately.

Guard references: `356b7d0:tests/providers/kubernetes/release-kind.test.ts:19`; `356b7d0:tests/providers/kubernetes/release-kind.test.ts:20`

- Assertion 1: Kubernetes release ports against a disposable kind cluster rolls out a pre-built digest, observes readiness and runs exactly one migration Job across retries. Separate unchanged-source pass: staging-kind.

### tests/scripts/migrate-hosted-to-postgres.test.ts (3 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `356b7d0:tests/scripts/migrate-hosted-to-postgres.test.ts:593`

- Assertion 13: migrate-hosted-to-postgres ;  against the real Supabase project copies the control tables, verifies, and inserts nothing on a second run. Separate unchanged-source pass: staging-supabase.
- Assertion 14: migrate-hosted-to-postgres ;  against the real Supabase project copies the app's data, verifies, and inserts nothing on a second run. Separate unchanged-source pass: staging-supabase.
- Assertion 15: migrate-hosted-to-postgres ;  against the real Supabase project leaves no contract- rows behind. Separate unchanged-source pass: staging-supabase.

### tests/secrets/rewrap.test.ts (1 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `356b7d0:tests/secrets/rewrap.test.ts:362`

- Assertion 57: real Postgres vault re-wrap commits product rows and audit together, then resumes idempotently. Separate unchanged-source pass: fresh-uncovered-postgres.

### tests/security/plan-artifact-secrecy.test.ts (1 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `356b7d0:tests/security/plan-artifact-secrecy.test.ts:19`

- Assertion 1: encrypted plan artifact secrecy [postgres] sensitive read-only originals persist only ciphertext; key rotation, tenant domains and tampering fail closed. Separate unchanged-source pass: staging-platform-postgres.

### tests/security/workflow-history.test.ts (2 skipped)

Reason: **Separate Temporal history opt-in**. ZENITH_SEC_TEMPORAL=1 is required for these actual history checks, with a local test server. This flag is separate from ordinary Temporal suite enablement.

Guard references: `356b7d0:tests/security/workflow-history.test.ts:15`; `356b7d0:tests/security/workflow-history.test.ts:53`; `356b7d0:tests/security/workflow-history.test.ts:54`

- Assertion 9: real Temporal history (opt-in; fake activities) ids/digests-only inputs and fake activity results leave synthetic node specs outside history. Separate unchanged-source pass: staging-workflows.
- Assertion 10: real Temporal history (opt-in; fake activities) SEC-F12: runtime node-spec extras are absent from actual durable history. Separate unchanged-source pass: staging-workflows.

### tests/sources/github-live.test.ts (1 skipped)

Reason: **Authorized private GitHub App fixture**. ZENITH_TEST_SOURCE_GITHUB_APP=1 plus app configuration, repository binding and a pinned commit are required. Store-only GitHub tests do not prove private App token/download acceptance.

Guard references: `356b7d0:tests/sources/github-live.test.ts:7`

- Assertion 1: private GitHub App source (opt-in network) downloads the bound repository at a pinned commit with an ephemeral scoped token. No separately matched unchanged-source pass in this audit.

### tests/sources/github-store.test.ts (10 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `356b7d0:tests/sources/github-store.test.ts:72`

- Assertion 11: GitHub source Postgres store (opt-in) persists only identifiers and proof digests, and resolves bindings by workspace. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 12: GitHub source Postgres store (opt-in) refuses a changed callback workspace without consuming the legitimate intent. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 13: GitHub source Postgres store (opt-in) refuses a changed callback actor without consuming the legitimate intent. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 14: GitHub source Postgres store (opt-in) refuses a changed callback browser without consuming the legitimate intent. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 15: GitHub source Postgres store (opt-in) refuses a changed callback state without consuming the legitimate intent. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 16: GitHub source Postgres store (opt-in) refuses expired intents at both transitions using database time. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 17: GitHub source Postgres store (opt-in) allows only one racing setup and one racing OAuth callback. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 18: GitHub source Postgres store (opt-in) stores hashed state/proof and never lets an install callback skip OAuth. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 19: GitHub source Postgres store (opt-in) rejects stale/racing bind intents rather than overwriting another admin's binding. Separate unchanged-source pass: fresh-uncovered-postgres.
- Assertion 20: GitHub source Postgres store (opt-in) validates identifiers and numeric IDs without reflecting malicious data. Separate unchanged-source pass: fresh-uncovered-postgres.

### tests/tofu/plan-artifact-handoff.test.ts (8 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `356b7d0:tests/tofu/plan-artifact-handoff.test.ts:73`; `356b7d0:tests/tofu/plan-artifact-handoff.test.ts:94`; `356b7d0:tests/tofu/plan-artifact-handoff.test.ts:111`

- Assertion 1: authenticated original cross-worker handoff [postgres] producer exits and loses its directory; another worker applies ORIGINAL bytes after a separate fresh check, then destroys. Separate unchanged-source pass: staging-platform-postgres.
- Assertion 2: authenticated original cross-worker handoff [postgres] fresh semantic drift refuses before dispatch and has no original/fresh fallback. Separate unchanged-source pass: staging-platform-postgres.
- Assertion 3: authenticated original cross-worker handoff [postgres] source/config/backend/address-map/lock/tool and operation swaps refuse before mutation. Separate unchanged-source pass: staging-platform-postgres.
- Assertion 4: authenticated original cross-worker handoff [postgres] tampering with the original after inspection refuses before apply and preserves uncertainty after dispatch. Separate unchanged-source pass: staging-platform-postgres.
- Assertion 5: authenticated original cross-worker handoff [postgres] source review completes, browser human approval is consumed, and destination destroys the associated ORIGINAL. Separate unchanged-source pass: staging-platform-postgres.
- Assertion 6: authenticated original cross-worker handoff [postgres] restore into a fresh PostgreSQL store with matching keys preserves the original; missing keys refuse. Separate unchanged-source pass: staging-platform-postgres.
- Assertion 7: authenticated original cross-worker handoff [postgres] fake cipher authority and arbitrary runner handles cannot mint production admission. Separate unchanged-source pass: staging-platform-postgres.
- Assertion 8: authenticated original cross-worker handoff [postgres] stale original state serial refuses even when independent fresh semantic plan is unchanged, with no fallback. Separate unchanged-source pass: staging-platform-postgres.

### tests/waitlist/pg-contract.test.ts (38 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `356b7d0:tests/waitlist/pg-contract.test.ts:13`; `356b7d0:tests/waitlist/pg-contract.test.ts:208`

- Assertion 1: WaitlistPostgres lets only Supabase Auth invoke the signup hook and read admitted email/status columns. Separate unchanged-source pass: staging-supabase.
- Assertion 2: WaitlistPostgres rejects absent/queued signups identically and admits the email only after operator admission. Separate unchanged-source pass: staging-supabase.
- Assertion 3: WaitlistPostgres normalizes duplicate joins and preserves the original answers, position and admission. Separate unchanged-source pass: staging-supabase.
- Assertion 4: WaitlistPostgres enforces email 254, occupation 120 and use-case 2000 boundaries in PostgreSQL. Separate unchanged-source pass: staging-supabase.
- Assertion 5: WaitlistPostgres accepts email alone and persists bounded optional profile answers. Separate unchanged-source pass: staging-supabase.
- Assertion 6: WaitlistPostgres lists stable FIFO pages with global counts and admits the oldest queued positions. Separate unchanged-source pass: staging-supabase.
- Assertion 7: WaitlistPostgres refuses an admission count of 0 without changing the queue. Separate unchanged-source pass: staging-supabase.
- Assertion 8: WaitlistPostgres refuses an admission count of -1 without changing the queue. Separate unchanged-source pass: staging-supabase.
- Assertion 9: WaitlistPostgres refuses an admission count of 1001 without changing the queue. Separate unchanged-source pass: staging-supabase.
- Assertion 10: WaitlistPostgres refuses an admission count of null without changing the queue. Separate unchanged-source pass: staging-supabase.
- Assertion 11: WaitlistPostgres accepts both count boundaries and never fills a batch with already admitted users. Separate unchanged-source pass: staging-supabase.
- Assertion 12: WaitlistPostgres replays UUID requests exactly and rejects changed count or actor without admitting more. Separate unchanged-source pass: staging-supabase.
- Assertion 13: WaitlistPostgres persists empty batches so replay cannot admit a later join. Separate unchanged-source pass: staging-supabase.
- Assertion 14: WaitlistPostgres deduplicates simultaneous case-varied joins on independent connections. Separate unchanged-source pass: staging-supabase.
- Assertion 15: WaitlistPostgres serializes overlapping batches into disjoint consecutive FIFO admissions. Separate unchanged-source pass: staging-supabase.
- Assertion 16: WaitlistPostgres replays a concurrently retried request instead of admitting a second batch. Separate unchanged-source pass: staging-supabase.
- Assertion 17: WaitlistPostgres waits for an earlier joining transaction before admitting the queue. Separate unchanged-source pass: staging-supabase.
- Assertion 18: WaitlistPostgres persists an actor-bound FIFO preview without changing the queue. Separate unchanged-source pass: staging-supabase.
- Assertion 19: WaitlistPostgres validates preview modes, counts and exact unique selected IDs. Separate unchanged-source pass: staging-supabase.
- Assertion 20: WaitlistPostgres captures all queued IDs beyond display/count limits and excludes later arrivals. Separate unchanged-source pass: staging-supabase.
- Assertion 21: WaitlistPostgres waits for an in-flight join when creating a preview and locks later joins out of its snapshot. Separate unchanged-source pass: staging-supabase.
- Assertion 22: WaitlistPostgres serializes overlapping snapshots and admits each captured queued entry only once. Separate unchanged-source pass: staging-supabase.
- Assertion 23: WaitlistPostgres replays concurrent preview requests exactly and consumes a preview only once. Separate unchanged-source pass: staging-supabase.
- Assertion 24: WaitlistPostgres rejects another operator, missing previews and expired unused previews without admissions. Separate unchanged-source pass: staging-supabase.
- Assertion 25: WaitlistPostgres prevents request-key reuse across legacy admission and selected previews. Separate unchanged-source pass: staging-supabase.
- Assertion 26: WaitlistPostgres prevents request-key reuse across legacy admission and next previews. Separate unchanged-source pass: staging-supabase.
- Assertion 27: WaitlistPostgres prevents request-key reuse across legacy admission and all previews. Separate unchanged-source pass: staging-supabase.
- Assertion 28: WaitlistPostgres persists zero-count previews and batches without admitting later arrivals. Separate unchanged-source pass: staging-supabase.
- Assertion 29: WaitlistPostgres records newest-first exact admission history including overlap and legacy batches. Separate unchanged-source pass: staging-supabase.
- Assertion 30: WaitlistPostgres returns immutable saved history details and null for an unknown request. Separate unchanged-source pass: staging-supabase.
- Assertion 31: WaitlistPostgres paginates immutable history rows with bounded pages and validates offsets. Separate unchanged-source pass: staging-supabase.
- Assertion 32: WaitlistPostgres filters literal profile text with cursor-independent matched counts and global totals. Separate unchanged-source pass: staging-supabase.
- Assertion 33: WaitlistPostgres grants only service_role the waitlist RPCs, tables and queue sequence. Separate unchanged-source pass: staging-supabase.
- Assertion 34: WaitlistPostgres refuses direct reads, writes and RPC invocation as anon. Separate unchanged-source pass: staging-supabase.
- Assertion 35: WaitlistPostgres refuses direct reads, writes and RPC invocation as authenticated. Separate unchanged-source pass: staging-supabase.
- Assertion 36: WaitlistPostgres refuses direct reads, writes and RPC invocation as supabase_auth_admin. Separate unchanged-source pass: staging-supabase.
- Assertion 37: WaitlistPostgres enforces RLS even with temporary browser SELECT grants and rolls those grants back. Separate unchanged-source pass: staging-supabase.
- Assertion 38: WaitlistPostgres enforces the rate-limit quota and resets an expired counter as service_role. Separate unchanged-source pass: staging-supabase.

### tests/workflows/codec-replay.test.ts (2 skipped)

Reason: **Local Temporal server prerequisite**. The shared serverSuite tries an existing local CLI or configured time-skipping server; downloads require explicit permission. Required Temporal lanes fail rather than skip when unavailable. Default unit lacks these enabled server prerequisites.

Guard references: `356b7d0:tests/workflows/codec-replay.test.ts:15`; `356b7d0:tests/workflows/codec-replay.test.ts:27`

- Assertion 1: codec histories on local Temporal (ZENITH_TEST_TEMPORAL=1) encrypts workflow/activity payloads, supports queries/signals and replays with retained keys. Separate unchanged-source pass: staging-workflows.
- Assertion 2: codec histories on local Temporal (ZENITH_TEST_TEMPORAL=1) replays a legacy plaintext history with an encrypted converter. Separate unchanged-source pass: staging-workflows.

### tests/workflows/destroy-replay.test.ts (6 skipped)

Reason: **Local Temporal server prerequisite**. The shared serverSuite tries an existing local CLI or configured time-skipping server; downloads require explicit permission. Required Temporal lanes fail rather than skip when unavailable. Default unit lacks these enabled server prerequisites.

Guard references: `356b7d0:tests/workflows/destroy-replay.test.ts:12`; `356b7d0:tests/workflows/destroy-replay.test.ts:22`

- Assertion 1: real destroy workflow histories (ZENITH_TEST_TEMPORAL=1) happy runs and replays against the current definitions. Separate unchanged-source pass: staging-workflows.
- Assertion 2: real destroy workflow histories (ZENITH_TEST_TEMPORAL=1) plan_changed runs and replays against the current definitions. Separate unchanged-source pass: staging-workflows.
- Assertion 3: real destroy workflow histories (ZENITH_TEST_TEMPORAL=1) lease_lost runs and replays against the current definitions. Separate unchanged-source pass: staging-workflows.
- Assertion 4: real destroy workflow histories (ZENITH_TEST_TEMPORAL=1) approval_reject runs and replays against the current definitions. Separate unchanged-source pass: staging-workflows.
- Assertion 5: real destroy workflow histories (ZENITH_TEST_TEMPORAL=1) unknown_absence runs and replays against the current definitions. Separate unchanged-source pass: staging-workflows.
- Assertion 6: real destroy workflow histories (ZENITH_TEST_TEMPORAL=1) preserves and replays the deploy command sequence. Separate unchanged-source pass: staging-workflows.

### tests/workflows/mtls-live.test.ts (2 skipped)

Reason: **External mTLS acceptance opt-in**. ZENITH_TEST_TEMPORAL_MTLS=1 and an authorized external namespace, address and certificate/key files are required. Disposable local Temporal does not prove external mTLS.

Guard references: `356b7d0:tests/workflows/mtls-live.test.ts:7`; `356b7d0:tests/workflows/mtls-live.test.ts:9`

- Assertion 1: external Temporal mTLS (ZENITH_TEST_TEMPORAL_MTLS=1) web transport authenticates and reads the configured namespace. No separately matched unchanged-source pass in this audit.
- Assertion 2: external Temporal mTLS (ZENITH_TEST_TEMPORAL_MTLS=1) worker transport authenticates and reads the configured namespace. No separately matched unchanged-source pass in this audit.

## Complete staging-tofu skip catalogue

### tests/tofu/plan-artifact-handoff.test.ts (8 skipped)

Reason: **Real PostgreSQL opt-in**. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

Guard references: `356b7d0:tests/tofu/plan-artifact-handoff.test.ts:73`; `356b7d0:tests/tofu/plan-artifact-handoff.test.ts:94`; `356b7d0:tests/tofu/plan-artifact-handoff.test.ts:111`

- Assertion 1: authenticated original cross-worker handoff [postgres] producer exits and loses its directory; another worker applies ORIGINAL bytes after a separate fresh check, then destroys. Separate unchanged-source pass: staging-platform-postgres.
- Assertion 2: authenticated original cross-worker handoff [postgres] fresh semantic drift refuses before dispatch and has no original/fresh fallback. Separate unchanged-source pass: staging-platform-postgres.
- Assertion 3: authenticated original cross-worker handoff [postgres] source/config/backend/address-map/lock/tool and operation swaps refuse before mutation. Separate unchanged-source pass: staging-platform-postgres.
- Assertion 4: authenticated original cross-worker handoff [postgres] tampering with the original after inspection refuses before apply and preserves uncertainty after dispatch. Separate unchanged-source pass: staging-platform-postgres.
- Assertion 5: authenticated original cross-worker handoff [postgres] source review completes, browser human approval is consumed, and destination destroys the associated ORIGINAL. Separate unchanged-source pass: staging-platform-postgres.
- Assertion 6: authenticated original cross-worker handoff [postgres] restore into a fresh PostgreSQL store with matching keys preserves the original; missing keys refuse. Separate unchanged-source pass: staging-platform-postgres.
- Assertion 7: authenticated original cross-worker handoff [postgres] fake cipher authority and arbitrary runner handles cannot mint production admission. Separate unchanged-source pass: staging-platform-postgres.
- Assertion 8: authenticated original cross-worker handoff [postgres] stale original state serial refuses even when independent fresh semantic plan is unchanged, with no fallback. Separate unchanged-source pass: staging-platform-postgres.

## All per-file and domain counts

### public-unit: domain counts

| Domain | Passed | Failed | Skipped |
|---|---:|---:|---:|
| acceptance | 211 | 0 | 1 |
| actions | 359 | 0 | 0 |
| agent-access | 26 | 0 | 0 |
| agent-control | 0 | 0 | 16 |
| agent-control-advance.test.ts | 5 | 0 | 0 |
| agent-control-capabilities.test.ts | 13 | 0 | 0 |
| agent-control-coordinator.test.ts | 13 | 0 | 0 |
| agent-control-journal-fixes.test.ts | 23 | 0 | 6 |
| agent-control-journal.test.ts | 21 | 0 | 7 |
| agent-control-oauth.test.ts | 15 | 0 | 0 |
| agent-control-rate-limit.test.ts | 8 | 0 | 0 |
| agent-control-reconcile.test.ts | 5 | 0 | 0 |
| agent-control-upload.test.ts | 5 | 0 | 0 |
| agent-journey.test.ts | 15 | 0 | 0 |
| agent-link | 0 | 0 | 14 |
| agent-link-authority.test.ts | 27 | 0 | 0 |
| agent-link-protocol.test.ts | 16 | 0 | 0 |
| agent-link-routes.test.ts | 26 | 0 | 0 |
| agent-serverless-routes.test.ts | 26 | 0 | 0 |
| agent-v3 | 284 | 0 | 0 |
| agent-waitlist.test.ts | 7 | 0 | 0 |
| alerts | 141 | 0 | 0 |
| analysis | 352 | 0 | 0 |
| api | 198 | 0 | 0 |
| auth | 211 | 0 | 0 |
| bridge | 124 | 0 | 1 |
| capabilities | 383 | 0 | 0 |
| ci | 489 | 0 | 0 |
| cli | 120 | 0 | 1 |
| client | 30 | 0 | 0 |
| controlplane | 252 | 0 | 6 |
| cost | 18 | 0 | 0 |
| credentials | 296 | 0 | 1 |
| db | 110 | 0 | 37 |
| deploy | 62 | 0 | 0 |
| docs | 109 | 0 | 0 |
| drift | 8 | 0 | 0 |
| engine | 45 | 0 | 0 |
| execution | 588 | 0 | 5 |
| hosted | 1061 | 0 | 13 |
| hosted-spike | 85 | 0 | 0 |
| importers | 14 | 0 | 0 |
| incidents | 262 | 0 | 0 |
| logsim | 6 | 0 | 0 |
| machines | 581 | 0 | 19 |
| middleware | 66 | 0 | 0 |
| navigator | 152 | 0 | 0 |
| observability | 496 | 0 | 0 |
| placement | 139 | 0 | 0 |
| platform | 317 | 0 | 7 |
| platform-ui | 147 | 0 | 0 |
| policy | 238 | 0 | 0 |
| providers | 4330 | 0 | 48 |
| reconcile | 223 | 0 | 0 |
| resources | 448 | 0 | 0 |
| runners | 321 | 0 | 0 |
| screens | 1058 | 0 | 0 |
| scripts | 43 | 0 | 3 |
| secrets | 107 | 0 | 1 |
| security | 281 | 0 | 2 |
| server | 48 | 0 | 0 |
| shell | 62 | 0 | 0 |
| sources | 62 | 0 | 11 |
| spatial | 8 | 0 | 0 |
| tofu | 458 | 0 | 15 |
| ui | 67 | 0 | 0 |
| waitlist | 405 | 0 | 38 |
| workers | 28 | 0 | 0 |
| workflows | 308 | 0 | 112 |

### public-unit: every test file

| File ordinal | File | Passed | Failed | Skipped |
|---:|---|---:|---:|---:|
| 1 | tests/agent-control-advance.test.ts | 5 | 0 | 0 |
| 2 | tests/agent-control-capabilities.test.ts | 13 | 0 | 0 |
| 3 | tests/agent-control-coordinator.test.ts | 13 | 0 | 0 |
| 4 | tests/agent-control-journal-fixes.test.ts | 23 | 0 | 6 |
| 5 | tests/agent-control-journal.test.ts | 21 | 0 | 7 |
| 6 | tests/agent-control-oauth.test.ts | 15 | 0 | 0 |
| 7 | tests/agent-control-rate-limit.test.ts | 8 | 0 | 0 |
| 8 | tests/agent-control-reconcile.test.ts | 5 | 0 | 0 |
| 9 | tests/agent-control-upload.test.ts | 5 | 0 | 0 |
| 10 | tests/agent-journey.test.ts | 15 | 0 | 0 |
| 11 | tests/agent-link-authority.test.ts | 27 | 0 | 0 |
| 12 | tests/agent-link-protocol.test.ts | 16 | 0 | 0 |
| 13 | tests/agent-link-routes.test.ts | 26 | 0 | 0 |
| 14 | tests/agent-serverless-routes.test.ts | 26 | 0 | 0 |
| 15 | tests/agent-waitlist.test.ts | 7 | 0 | 0 |
| 16 | tests/acceptance/catalogue.test.ts | 12 | 0 | 0 |
| 17 | tests/acceptance/cleanup.test.ts | 11 | 0 | 0 |
| 18 | tests/acceptance/clients.test.ts | 20 | 0 | 0 |
| 19 | tests/acceptance/evidence.test.ts | 7 | 0 | 0 |
| 20 | tests/acceptance/lifecycle.test.ts | 2 | 0 | 0 |
| 21 | tests/acceptance/packaged-worker.test.ts | 107 | 0 | 0 |
| 22 | tests/acceptance/runner.test.ts | 7 | 0 | 0 |
| 23 | tests/acceptance/safety.test.ts | 24 | 0 | 0 |
| 24 | tests/acceptance/sample-app.test.ts | 4 | 0 | 1 |
| 25 | tests/acceptance/scenario-j.test.ts | 3 | 0 | 0 |
| 26 | tests/acceptance/scenario-live.test.ts | 5 | 0 | 0 |
| 27 | tests/acceptance/tofu-destroy.test.ts | 9 | 0 | 0 |
| 28 | tests/agent-access/journal-tenancy.test.ts | 26 | 0 | 0 |
| 29 | tests/actions/audit-boundary.test.ts | 6 | 0 | 0 |
| 30 | tests/actions/connection-env-isolation.test.ts | 38 | 0 | 0 |
| 31 | tests/actions/deploy-approve-separation.test.ts | 9 | 0 | 0 |
| 32 | tests/actions/deploy-isolation.test.ts | 20 | 0 | 0 |
| 33 | tests/actions/deploy.test.ts | 5 | 0 | 0 |
| 34 | tests/actions/env-lifecycle.test.ts | 13 | 0 | 0 |
| 35 | tests/actions/env-teardown.test.ts | 11 | 0 | 0 |
| 36 | tests/actions/guarantees.test.ts | 13 | 0 | 0 |
| 37 | tests/actions/hosted.test.ts | 14 | 0 | 0 |
| 38 | tests/actions/idempotency.test.ts | 10 | 0 | 0 |
| 39 | tests/actions/import-resources.test.ts | 8 | 0 | 0 |
| 40 | tests/actions/import-secret-isolation.test.ts | 2 | 0 | 0 |
| 41 | tests/actions/manifest-navigator-isolation.test.ts | 21 | 0 | 0 |
| 42 | tests/actions/manifest-v2-consumers.test.ts | 5 | 0 | 0 |
| 43 | tests/actions/manifest-v2.test.ts | 14 | 0 | 0 |
| 44 | tests/actions/placement.test.ts | 11 | 0 | 0 |
| 45 | tests/actions/plan-throws.test.ts | 1 | 0 | 0 |
| 46 | tests/actions/provider-honesty.test.ts | 4 | 0 | 0 |
| 47 | tests/actions/roles-workspace.test.ts | 4 | 0 | 0 |
| 48 | tests/actions/roles.test.ts | 10 | 0 | 0 |
| 49 | tests/actions/security-alerts-isolation.test.ts | 48 | 0 | 0 |
| 50 | tests/actions/security-reopen.test.ts | 5 | 0 | 0 |
| 51 | tests/actions/stateful-deletion-rollback.test.ts | 7 | 0 | 0 |
| 52 | tests/actions/stateful-deletion.test.ts | 4 | 0 | 0 |
| 53 | tests/actions/system-edits.test.ts | 6 | 0 | 0 |
| 54 | tests/actions/system.test.ts | 19 | 0 | 0 |
| 55 | tests/actions/workspace-isolation.test.ts | 44 | 0 | 0 |
| 56 | tests/actions/workspace.test.ts | 7 | 0 | 0 |
| 57 | tests/agent-control/pg-contract.test.ts | 0 | 0 | 16 |
| 58 | tests/agent-link/pg-contract.test.ts | 0 | 0 | 14 |
| 59 | tests/agent-v3/adapters.test.ts | 6 | 0 | 0 |
| 60 | tests/agent-v3/auth.test.ts | 4 | 0 | 0 |
| 61 | tests/agent-v3/catalog.test.ts | 20 | 0 | 0 |
| 62 | tests/agent-v3/envelope.test.ts | 30 | 0 | 0 |
| 63 | tests/agent-v3/execute.test.ts | 18 | 0 | 0 |
| 64 | tests/agent-v3/oauth-metadata.test.ts | 36 | 0 | 0 |
| 65 | tests/agent-v3/observability-wired.test.ts | 4 | 0 | 0 |
| 66 | tests/agent-v3/placement-transport.test.ts | 8 | 0 | 0 |
| 67 | tests/agent-v3/placement.test.ts | 6 | 0 | 0 |
| 68 | tests/agent-v3/principal.test.ts | 8 | 0 | 0 |
| 69 | tests/agent-v3/propose.test.ts | 20 | 0 | 0 |
| 70 | tests/agent-v3/read.test.ts | 24 | 0 | 0 |
| 71 | tests/agent-v3/route.test.ts | 36 | 0 | 0 |
| 72 | tests/agent-v3/schemas.test.ts | 17 | 0 | 0 |
| 73 | tests/agent-v3/sdk.test.ts | 19 | 0 | 0 |
| 74 | tests/agent-v3/tenancy.test.ts | 28 | 0 | 0 |
| 75 | tests/alerts/alerts.test.ts | 13 | 0 | 0 |
| 76 | tests/alerts/delivery.test.ts | 44 | 0 | 0 |
| 77 | tests/alerts/migrate-alert-secrets.test.ts | 9 | 0 | 0 |
| 78 | tests/alerts/outbox.test.ts | 18 | 0 | 0 |
| 79 | tests/alerts/webhook-policy.test.ts | 57 | 0 | 0 |
| 80 | tests/analysis/analyze.test.ts | 61 | 0 | 0 |
| 81 | tests/analysis/detection.test.ts | 92 | 0 | 0 |
| 82 | tests/analysis/hostile.test.ts | 45 | 0 | 0 |
| 83 | tests/analysis/propose.test.ts | 60 | 0 | 0 |
| 84 | tests/analysis/scale.test.ts | 2 | 0 | 0 |
| 85 | tests/analysis/snapshot.test.ts | 36 | 0 | 0 |
| 86 | tests/analysis/units.test.ts | 56 | 0 | 0 |
| 87 | tests/api/account-delete.test.ts | 19 | 0 | 0 |
| 88 | tests/api/account-export.test.ts | 6 | 0 | 0 |
| 89 | tests/api/account-profile.test.ts | 6 | 0 | 0 |
| 90 | tests/api/account-sessions.test.ts | 3 | 0 | 0 |
| 91 | tests/api/actions-idempotency-commit.test.ts | 5 | 0 | 0 |
| 92 | tests/api/bootstrap-redaction.test.ts | 6 | 0 | 0 |
| 93 | tests/api/bootstrap.test.ts | 4 | 0 | 0 |
| 94 | tests/api/internal-cron.test.ts | 27 | 0 | 0 |
| 95 | tests/api/me.test.ts | 5 | 0 | 0 |
| 96 | tests/api/observe-isolation.test.ts | 19 | 0 | 0 |
| 97 | tests/api/postgres-request-boundary.test.ts | 4 | 0 | 0 |
| 98 | tests/api/project-stream.test.ts | 5 | 0 | 0 |
| 99 | tests/api/serverless-flush.test.ts | 3 | 0 | 0 |
| 100 | tests/api/slug-scoping.test.ts | 9 | 0 | 0 |
| 101 | tests/api/workspace-sharing.test.ts | 59 | 0 | 0 |
| 102 | tests/auth/callback.test.ts | 28 | 0 | 0 |
| 103 | tests/auth/destination.test.ts | 26 | 0 | 0 |
| 104 | tests/auth/hosted-membership.test.ts | 6 | 0 | 0 |
| 105 | tests/auth/identity-link-sdk.test.ts | 1 | 0 | 0 |
| 106 | tests/auth/identity-link.test.ts | 7 | 0 | 0 |
| 107 | tests/auth/membership.test.ts | 12 | 0 | 0 |
| 108 | tests/auth/middleware.test.ts | 13 | 0 | 0 |
| 109 | tests/auth/oauth-redirect.test.ts | 11 | 0 | 0 |
| 110 | tests/auth/oauth.test.ts | 13 | 0 | 0 |
| 111 | tests/auth/session-middleware.test.ts | 20 | 0 | 0 |
| 112 | tests/auth/signout-destination.test.ts | 6 | 0 | 0 |
| 113 | tests/auth/workspace-sharing.test.ts | 47 | 0 | 0 |
| 114 | tests/auth/workspace-stream-access.test.ts | 8 | 0 | 0 |
| 115 | tests/auth/workspaces.test.ts | 13 | 0 | 0 |
| 116 | tests/bridge/aws-readiness.test.ts | 3 | 0 | 0 |
| 117 | tests/bridge/connection-aws.test.ts | 40 | 0 | 0 |
| 118 | tests/bridge/deploy-bridge.test.ts | 45 | 0 | 0 |
| 119 | tests/bridge/deps.test.ts | 3 | 0 | 0 |
| 120 | tests/bridge/engine-workflow-owned.test.ts | 6 | 0 | 0 |
| 121 | tests/bridge/readiness.test.ts | 15 | 0 | 0 |
| 122 | tests/bridge/steps.test.ts | 2 | 0 | 1 |
| 123 | tests/bridge/teardown-session.test.ts | 10 | 0 | 0 |
| 124 | tests/capabilities/action-bridge.test.ts | 16 | 0 | 0 |
| 125 | tests/capabilities/approvals.test.ts | 41 | 0 | 0 |
| 126 | tests/capabilities/autonomy.test.ts | 23 | 0 | 0 |
| 127 | tests/capabilities/broker.test.ts | 66 | 0 | 0 |
| 128 | tests/capabilities/destroy-propose.test.ts | 11 | 0 | 0 |
| 129 | tests/capabilities/destroy-review-mcp.test.ts | 6 | 0 | 0 |
| 130 | tests/capabilities/execution.test.ts | 64 | 0 | 0 |
| 131 | tests/capabilities/platform.test.ts | 15 | 0 | 0 |
| 132 | tests/capabilities/product-adapters.test.ts | 14 | 0 | 0 |
| 133 | tests/capabilities/routes.test.ts | 50 | 0 | 0 |
| 134 | tests/capabilities/store-contract.test.ts | 57 | 0 | 0 |
| 135 | tests/capabilities/tenancy.test.ts | 20 | 0 | 0 |
| 136 | tests/cli/bin.test.ts | 3 | 0 | 0 |
| 137 | tests/cli/commands.test.ts | 24 | 0 | 0 |
| 138 | tests/cli/config.test.ts | 15 | 0 | 1 |
| 139 | tests/cli/failures.test.ts | 68 | 0 | 0 |
| 140 | tests/cli/follow.test.ts | 10 | 0 | 0 |
| 141 | tests/cost/pricing.test.ts | 18 | 0 | 0 |
| 142 | tests/controlplane/approvals.test.ts | 15 | 0 | 0 |
| 143 | tests/controlplane/execution-ledger.test.ts | 16 | 0 | 0 |
| 144 | tests/controlplane/executor.test.ts | 19 | 0 | 1 |
| 145 | tests/controlplane/grants.test.ts | 7 | 0 | 0 |
| 146 | tests/controlplane/lease-hang.test.ts | 1 | 0 | 0 |
| 147 | tests/controlplane/leases.test.ts | 13 | 0 | 0 |
| 148 | tests/controlplane/migrations.test.ts | 13 | 0 | 3 |
| 149 | tests/controlplane/open.test.ts | 14 | 0 | 2 |
| 150 | tests/controlplane/operations.test.ts | 29 | 0 | 0 |
| 151 | tests/controlplane/read-jobs.test.ts | 16 | 0 | 0 |
| 152 | tests/controlplane/runners.test.ts | 26 | 0 | 0 |
| 153 | tests/controlplane/secrets.test.ts | 34 | 0 | 0 |
| 154 | tests/controlplane/services.test.ts | 19 | 0 | 0 |
| 155 | tests/controlplane/state.test.ts | 26 | 0 | 0 |
| 156 | tests/controlplane/tenancy.test.ts | 4 | 0 | 0 |
| 157 | tests/credentials/bootstrap-templates.test.ts | 75 | 0 | 1 |
| 158 | tests/credentials/broker-aws.test.ts | 59 | 0 | 0 |
| 159 | tests/credentials/error-names.test.ts | 13 | 0 | 0 |
| 160 | tests/credentials/grants.test.ts | 14 | 0 | 0 |
| 161 | tests/credentials/oidc.test.ts | 15 | 0 | 0 |
| 162 | tests/credentials/redact.test.ts | 14 | 0 | 0 |
| 163 | tests/credentials/session-policy.test.ts | 21 | 0 | 0 |
| 164 | tests/credentials/signing.test.ts | 24 | 0 | 0 |
| 165 | tests/credentials/workload-boundary.test.ts | 4 | 0 | 0 |
| 166 | tests/db/async-repository.test.ts | 9 | 0 | 0 |
| 167 | tests/db/audit-batch.test.ts | 10 | 0 | 0 |
| 168 | tests/db/manifest-v2.test.ts | 3 | 0 | 0 |
| 169 | tests/db/manifests.test.ts | 10 | 0 | 0 |
| 170 | tests/db/pg-settings-guard.test.ts | 8 | 0 | 0 |
| 171 | tests/db/rsc-scope.test.ts | 13 | 0 | 0 |
| 172 | tests/db/snapshot-isolation.test.ts | 7 | 0 | 0 |
| 173 | tests/db/store-facade.test.ts | 4 | 0 | 0 |
| 174 | tests/db/store.test.ts | 10 | 0 | 0 |
| 175 | tests/deploy/installation.test.ts | 62 | 0 | 0 |
| 176 | tests/docs/capability-matrix.test.ts | 29 | 0 | 0 |
| 177 | tests/docs/links.test.ts | 8 | 0 | 0 |
| 178 | tests/docs/operator-docs.test.ts | 58 | 0 | 0 |
| 179 | tests/docs/security-status.test.ts | 14 | 0 | 0 |
| 180 | tests/drift/compute.test.ts | 8 | 0 | 0 |
| 181 | tests/client/poll.test.ts | 6 | 0 | 0 |
| 182 | tests/client/stream-fallback.test.ts | 3 | 0 | 0 |
| 183 | tests/engine/environment-lease.test.ts | 7 | 0 | 0 |
| 184 | tests/engine/manifest-v2.test.ts | 1 | 0 | 0 |
| 185 | tests/engine/postgres-scheduler.test.ts | 10 | 0 | 0 |
| 186 | tests/engine/rollback-origin.test.ts | 14 | 0 | 0 |
| 187 | tests/engine/serverless-boot.test.ts | 4 | 0 | 0 |
| 188 | tests/engine/state-machine.test.ts | 3 | 0 | 0 |
| 189 | tests/engine/step-deadline.test.ts | 2 | 0 | 0 |
| 190 | tests/engine/tick-async.test.ts | 4 | 0 | 0 |
| 191 | tests/hosted-spike/cloudflare-preflight.test.ts | 84 | 0 | 0 |
| 192 | tests/hosted-spike/sqlite-feasibility.test.ts | 1 | 0 | 0 |
| 193 | tests/execution/apply.test.ts | 18 | 0 | 0 |
| 194 | tests/execution/aws-bootstrap-context.test.ts | 4 | 0 | 0 |
| 195 | tests/execution/capability-clouds.test.ts | 12 | 0 | 0 |
| 196 | tests/execution/capability.test.ts | 12 | 0 | 0 |
| 197 | tests/execution/compile-refs-providers.test.ts | 16 | 0 | 2 |
| 198 | tests/execution/compile-refs.test.ts | 50 | 0 | 0 |
| 199 | tests/execution/deletion-guards-clouds.test.ts | 18 | 0 | 0 |
| 200 | tests/execution/deletion-guards-real.test.ts | 0 | 0 | 1 |
| 201 | tests/execution/deletion-guards.test.ts | 27 | 0 | 0 |
| 202 | tests/execution/destroy-providers.test.ts | 18 | 0 | 0 |
| 203 | tests/execution/destroy-review-temporal.test.ts | 0 | 0 | 1 |
| 204 | tests/execution/destroy-review.test.ts | 18 | 0 | 1 |
| 205 | tests/execution/destroy.test.ts | 21 | 0 | 0 |
| 206 | tests/execution/ecs-replica-repair.test.ts | 57 | 0 | 0 |
| 207 | tests/execution/journey.test.ts | 3 | 0 | 0 |
| 208 | tests/execution/ledger-approval.test.ts | 5 | 0 | 0 |
| 209 | tests/execution/machines.test.ts | 14 | 0 | 0 |
| 210 | tests/execution/manifest-release.test.ts | 12 | 0 | 0 |
| 211 | tests/execution/plan.test.ts | 26 | 0 | 0 |
| 212 | tests/execution/platform.test.ts | 23 | 0 | 0 |
| 213 | tests/execution/policy-delete.test.ts | 12 | 0 | 0 |
| 214 | tests/execution/prober.test.ts | 80 | 0 | 0 |
| 215 | tests/execution/product-port.test.ts | 26 | 0 | 0 |
| 216 | tests/execution/release.test.ts | 29 | 0 | 0 |
| 217 | tests/execution/secrets-azure.test.ts | 6 | 0 | 0 |
| 218 | tests/execution/secrets-kubernetes.test.ts | 3 | 0 | 0 |
| 219 | tests/execution/secrets.test.ts | 16 | 0 | 0 |
| 220 | tests/execution/steps.test.ts | 20 | 0 | 0 |
| 221 | tests/execution/validate.test.ts | 13 | 0 | 0 |
| 222 | tests/execution/verify.test.ts | 29 | 0 | 0 |
| 223 | tests/importers/compose.test.ts | 8 | 0 | 0 |
| 224 | tests/importers/merge.test.ts | 6 | 0 | 0 |
| 225 | tests/incidents/acceptance.test.ts | 15 | 0 | 0 |
| 226 | tests/incidents/determinism.test.ts | 13 | 0 | 0 |
| 227 | tests/incidents/healthy.test.ts | 7 | 0 | 0 |
| 228 | tests/incidents/hostile.test.ts | 20 | 0 | 0 |
| 229 | tests/incidents/probes.test.ts | 8 | 0 | 0 |
| 230 | tests/incidents/remediation.test.ts | 15 | 0 | 0 |
| 231 | tests/incidents/rules.test.ts | 20 | 0 | 0 |
| 232 | tests/incidents/scenarios.test.ts | 33 | 0 | 0 |
| 233 | tests/incidents/signatures.test.ts | 67 | 0 | 0 |
| 234 | tests/incidents/traverse.test.ts | 16 | 0 | 0 |
| 235 | tests/incidents/units.test.ts | 20 | 0 | 0 |
| 236 | tests/incidents/unknowns.test.ts | 28 | 0 | 0 |
| 237 | tests/logsim/health-history.test.ts | 6 | 0 | 0 |
| 238 | tests/middleware/platform-bearer.test.ts | 66 | 0 | 0 |
| 239 | tests/hosted/config.test.ts | 17 | 0 | 0 |
| 240 | tests/hosted/edge.test.ts | 8 | 0 | 0 |
| 241 | tests/navigator/executor.test.ts | 18 | 0 | 0 |
| 242 | tests/navigator/gimbal-state.test.ts | 25 | 0 | 0 |
| 243 | tests/navigator/llm.test.ts | 5 | 0 | 0 |
| 244 | tests/navigator/planner.test.ts | 5 | 0 | 0 |
| 245 | tests/navigator/planning.test.ts | 11 | 0 | 0 |
| 246 | tests/navigator/server-actions.test.ts | 39 | 0 | 0 |
| 247 | tests/navigator/verification.test.ts | 15 | 0 | 0 |
| 248 | tests/ci/apply-platform-migrations.test.ts | 14 | 0 | 0 |
| 249 | tests/ci/assert-lane-report.test.ts | 88 | 0 | 0 |
| 250 | tests/ci/dependency-remediation.test.ts | 8 | 0 | 0 |
| 251 | tests/ci/evidence-sanitizer.test.ts | 105 | 0 | 0 |
| 252 | tests/ci/gate-manifest.test.ts | 56 | 0 | 0 |
| 253 | tests/ci/lane-report.test.ts | 23 | 0 | 0 |
| 254 | tests/ci/lockfile-integrity.test.ts | 18 | 0 | 0 |
| 255 | tests/ci/platform-coverage.test.ts | 25 | 0 | 0 |
| 256 | tests/ci/platform-schema-verifier.test.ts | 22 | 0 | 0 |
| 257 | tests/ci/postgres-lane-report.test.ts | 8 | 0 | 0 |
| 258 | tests/ci/release-gates.test.ts | 97 | 0 | 0 |
| 259 | tests/ci/security-audit.test.ts | 25 | 0 | 0 |
| 260 | tests/machines/args.test.ts | 137 | 0 | 0 |
| 261 | tests/machines/azure-run-command.test.ts | 53 | 0 | 0 |
| 262 | tests/machines/azure-scripts.test.ts | 0 | 0 | 6 |
| 263 | tests/machines/dispatcher.test.ts | 5 | 0 | 0 |
| 264 | tests/machines/gcp-os-management.test.ts | 38 | 0 | 0 |
| 265 | tests/machines/go-results.test.ts | 19 | 0 | 0 |
| 266 | tests/machines/kubernetes-server.test.ts | 11 | 0 | 0 |
| 267 | tests/machines/kubernetes.test.ts | 50 | 0 | 0 |
| 268 | tests/machines/persistence.test.ts | 14 | 0 | 0 |
| 269 | tests/machines/service.test.ts | 41 | 0 | 0 |
| 270 | tests/machines/sessions.test.ts | 12 | 0 | 0 |
| 271 | tests/machines/ssm-documents.test.ts | 83 | 0 | 13 |
| 272 | tests/machines/ssm-parse.test.ts | 19 | 0 | 0 |
| 273 | tests/machines/ssm-transport.test.ts | 60 | 0 | 0 |
| 274 | tests/machines/zenithd.test.ts | 39 | 0 | 0 |
| 275 | tests/placement/catalog.test.ts | 16 | 0 | 0 |
| 276 | tests/placement/components.test.ts | 7 | 0 | 0 |
| 277 | tests/placement/cost.test.ts | 34 | 0 | 0 |
| 278 | tests/placement/latency.test.ts | 9 | 0 | 0 |
| 279 | tests/placement/recommend-connections.test.ts | 2 | 0 | 0 |
| 280 | tests/placement/recommend-route.test.ts | 6 | 0 | 0 |
| 281 | tests/placement/recommend.test.ts | 15 | 0 | 0 |
| 282 | tests/placement/resource-graph-integration.test.ts | 2 | 0 | 0 |
| 283 | tests/placement/solver.test.ts | 48 | 0 | 0 |
| 284 | tests/platform/agent-ports.test.ts | 15 | 0 | 0 |
| 285 | tests/platform/composition.test.ts | 11 | 0 | 0 |
| 286 | tests/platform/credentials-verification.test.ts | 78 | 0 | 0 |
| 287 | tests/platform/deploy-e2e.test.ts | 10 | 0 | 6 |
| 288 | tests/platform/ecs-replica-repair-grants.test.ts | 7 | 0 | 0 |
| 289 | tests/platform/housekeeping.test.ts | 14 | 0 | 0 |
| 290 | tests/platform/machine-composition.test.ts | 6 | 0 | 0 |
| 291 | tests/platform/oci-sessions.test.ts | 31 | 0 | 0 |
| 292 | tests/platform/plan-approval-routes.test.ts | 9 | 0 | 0 |
| 293 | tests/platform/plan-approval.test.ts | 11 | 0 | 0 |
| 294 | tests/platform/release-multi.test.ts | 5 | 0 | 0 |
| 295 | tests/platform/release.test.ts | 8 | 0 | 0 |
| 296 | tests/platform/secret-grants.test.ts | 14 | 0 | 0 |
| 297 | tests/platform/source-bundle-azure.test.ts | 10 | 0 | 0 |
| 298 | tests/platform/source-bundle-composition.test.ts | 7 | 0 | 0 |
| 299 | tests/platform/source-bundle-github.test.ts | 4 | 0 | 0 |
| 300 | tests/platform/source-bundle.test.ts | 77 | 0 | 1 |
| 301 | tests/policy/bundle.test.ts | 8 | 0 | 0 |
| 302 | tests/policy/defaults.test.ts | 22 | 0 | 0 |
| 303 | tests/policy/delete.test.ts | 21 | 0 | 0 |
| 304 | tests/policy/engine.test.ts | 70 | 0 | 0 |
| 305 | tests/policy/parity.test.ts | 1 | 0 | 0 |
| 306 | tests/policy/plan-facts.test.ts | 44 | 0 | 0 |
| 307 | tests/policy/scenarios.test.ts | 72 | 0 | 0 |
| 308 | tests/platform-ui/freshness.test.ts | 4 | 0 | 0 |
| 309 | tests/platform-ui/reads-and-loaders.test.ts | 56 | 0 | 0 |
| 310 | tests/reconcile/activity.test.ts | 9 | 0 | 0 |
| 311 | tests/reconcile/boundary.test.ts | 7 | 0 | 0 |
| 312 | tests/reconcile/core.test.ts | 40 | 0 | 0 |
| 313 | tests/reconcile/desired-value-boundary.test.ts | 4 | 0 | 0 |
| 314 | tests/reconcile/dispatch.test.ts | 6 | 0 | 0 |
| 315 | tests/reconcile/observe.test.ts | 2 | 0 | 0 |
| 316 | tests/reconcile/pass.test.ts | 20 | 0 | 0 |
| 317 | tests/reconcile/platform.test.ts | 58 | 0 | 0 |
| 318 | tests/reconcile/repair.test.ts | 38 | 0 | 0 |
| 319 | tests/reconcile/route.test.ts | 8 | 0 | 0 |
| 320 | tests/reconcile/scheduler.test.ts | 18 | 0 | 0 |
| 321 | tests/reconcile/support.test.ts | 13 | 0 | 0 |
| 322 | tests/resources/aws-expansion.test.ts | 280 | 0 | 0 |
| 323 | tests/resources/drift.test.ts | 32 | 0 | 0 |
| 324 | tests/resources/expand.test.ts | 72 | 0 | 0 |
| 325 | tests/resources/kubernetes-namespace.test.ts | 8 | 0 | 0 |
| 326 | tests/resources/manifest-v2.test.ts | 21 | 0 | 0 |
| 327 | tests/resources/native-types.test.ts | 8 | 0 | 0 |
| 328 | tests/resources/purity.test.ts | 6 | 0 | 0 |
| 329 | tests/resources/spec-conformance.test.ts | 8 | 0 | 0 |
| 330 | tests/resources/upgrade.test.ts | 13 | 0 | 0 |
| 331 | tests/runners/admin-routes.test.ts | 13 | 0 | 0 |
| 332 | tests/runners/aws-transport.test.ts | 19 | 0 | 0 |
| 333 | tests/runners/dispatch.test.ts | 25 | 0 | 0 |
| 334 | tests/runners/e2e-platform-store.test.ts | 8 | 0 | 0 |
| 335 | tests/runners/isolation.test.ts | 12 | 0 | 0 |
| 336 | tests/runners/oci-contract.test.ts | 4 | 0 | 0 |
| 337 | tests/runners/oci-payload.test.ts | 46 | 0 | 0 |
| 338 | tests/runners/paths.test.ts | 3 | 0 | 0 |
| 339 | tests/runners/poll.test.ts | 16 | 0 | 0 |
| 340 | tests/runners/read-jobs.test.ts | 40 | 0 | 0 |
| 341 | tests/runners/registration.test.ts | 14 | 0 | 0 |
| 342 | tests/runners/request-auth.test.ts | 18 | 0 | 0 |
| 343 | tests/runners/results.test.ts | 22 | 0 | 0 |
| 344 | tests/runners/runtime.test.ts | 5 | 0 | 0 |
| 345 | tests/runners/signing.test.ts | 14 | 0 | 0 |
| 346 | tests/runners/store-contract.test.ts | 44 | 0 | 0 |
| 347 | tests/runners/tofu-dispatch.test.ts | 18 | 0 | 0 |
| 348 | tests/providers/localstack-observe.test.ts | 11 | 0 | 0 |
| 349 | tests/providers/localstack-teardown.test.ts | 19 | 0 | 0 |
| 350 | tests/providers/observe.test.ts | 9 | 0 | 0 |
| 351 | tests/providers/terraform-injection.test.ts | 30 | 0 | 0 |
| 352 | tests/providers/terraform-labels.test.ts | 6 | 0 | 0 |
| 353 | tests/providers/terraform-lb-names.test.ts | 14 | 0 | 0 |
| 354 | tests/providers/terraform.test.ts | 34 | 0 | 0 |
| 355 | tests/observability/aws-events.test.ts | 21 | 0 | 0 |
| 356 | tests/observability/cloudwatch-logs.test.ts | 38 | 0 | 0 |
| 357 | tests/observability/cloudwatch-metrics.test.ts | 32 | 0 | 0 |
| 358 | tests/observability/escape.test.ts | 61 | 0 | 0 |
| 359 | tests/observability/evidence.test.ts | 3 | 0 | 0 |
| 360 | tests/observability/fabric.test.ts | 34 | 0 | 0 |
| 361 | tests/observability/factory.test.ts | 10 | 0 | 0 |
| 362 | tests/observability/health.test.ts | 47 | 0 | 0 |
| 363 | tests/observability/kubernetes-wired.test.ts | 2 | 0 | 0 |
| 364 | tests/observability/kubernetes.test.ts | 30 | 0 | 0 |
| 365 | tests/observability/loki.test.ts | 31 | 0 | 0 |
| 366 | tests/observability/metadata-hosts.test.ts | 14 | 0 | 0 |
| 367 | tests/observability/oci-signals.test.ts | 71 | 0 | 0 |
| 368 | tests/observability/prometheus.test.ts | 29 | 0 | 0 |
| 369 | tests/observability/providers-wired.test.ts | 6 | 0 | 0 |
| 370 | tests/observability/query.test.ts | 22 | 0 | 0 |
| 371 | tests/observability/redact.test.ts | 28 | 0 | 0 |
| 372 | tests/observability/sandbox-logsim.test.ts | 4 | 0 | 0 |
| 373 | tests/observability/sandbox.test.ts | 13 | 0 | 0 |
| 374 | tests/screens/activity-rows.test.ts | 13 | 0 | 0 |
| 375 | tests/screens/auth-messages.test.ts | 10 | 0 | 0 |
| 376 | tests/screens/deploy-helpers.test.ts | 17 | 0 | 0 |
| 377 | tests/screens/deploy-history-window.test.ts | 2 | 0 | 0 |
| 378 | tests/screens/deployment-state.test.ts | 4 | 0 | 0 |
| 379 | tests/screens/editor-helpers.test.ts | 13 | 0 | 0 |
| 380 | tests/screens/inspector-logic.test.ts | 19 | 0 | 0 |
| 381 | tests/screens/landing-metadata.test.ts | 5 | 0 | 0 |
| 382 | tests/screens/landing-scenario.test.ts | 9 | 0 | 0 |
| 383 | tests/screens/landing-state.test.ts | 6 | 0 | 0 |
| 384 | tests/screens/local-starter.test.ts | 2 | 0 | 0 |
| 385 | tests/screens/map-graph-model.test.ts | 4 | 0 | 0 |
| 386 | tests/screens/map-layout.test.ts | 4 | 0 | 0 |
| 387 | tests/screens/map-viewport.test.ts | 4 | 0 | 0 |
| 388 | tests/screens/observe-log-selection.test.ts | 3 | 0 | 0 |
| 389 | tests/screens/onboarding-progress.test.ts | 9 | 0 | 0 |
| 390 | tests/screens/overview-page.test.ts | 9 | 0 | 0 |
| 391 | tests/screens/overview-rows.test.ts | 13 | 0 | 0 |
| 392 | tests/screens/revision-direction.test.ts | 1 | 0 | 0 |
| 393 | tests/screens/sample-compose.test.ts | 2 | 0 | 0 |
| 394 | tests/screens/security-finding-shape.test.ts | 4 | 0 | 0 |
| 395 | tests/screens/security-rows.test.ts | 12 | 0 | 0 |
| 396 | tests/scripts/migrate-hosted-to-postgres.test.ts | 12 | 0 | 3 |
| 397 | tests/scripts/migrate.test.ts | 5 | 0 | 0 |
| 398 | tests/scripts/runtime-admission.test.ts | 26 | 0 | 0 |
| 399 | tests/server/appwire-admission.test.ts | 26 | 0 | 0 |
| 400 | tests/server/appwire-errors.test.ts | 9 | 0 | 0 |
| 401 | tests/server/appwire-policy-bundle.test.ts | 7 | 0 | 0 |
| 402 | tests/server/cron-housekeeping.test.ts | 6 | 0 | 0 |
| 403 | tests/secrets/namespacing.test.ts | 14 | 0 | 0 |
| 404 | tests/secrets/resolver.test.ts | 15 | 0 | 0 |
| 405 | tests/secrets/rewrap.test.ts | 56 | 0 | 1 |
| 406 | tests/secrets/secret-writer-bootstrap.test.ts | 3 | 0 | 0 |
| 407 | tests/secrets/store.test.ts | 19 | 0 | 0 |
| 408 | tests/spatial/rehearsal-model.test.ts | 5 | 0 | 0 |
| 409 | tests/sources/github-app.test.ts | 20 | 0 | 0 |
| 410 | tests/sources/github-callback.test.ts | 21 | 0 | 0 |
| 411 | tests/sources/github-live.test.ts | 0 | 0 | 1 |
| 412 | tests/sources/github-migrations.test.ts | 6 | 0 | 0 |
| 413 | tests/sources/github-runtime.test.ts | 5 | 0 | 0 |
| 414 | tests/sources/github-store.test.ts | 10 | 0 | 10 |
| 415 | tests/ui/foreign-tokens.test.ts | 2 | 0 | 0 |
| 416 | tests/ui/log-search.test.ts | 5 | 0 | 0 |
| 417 | tests/ui/theme-contrast.test.ts | 4 | 0 | 0 |
| 418 | tests/shell/activity-target.test.ts | 10 | 0 | 0 |
| 419 | tests/tofu/backends.test.ts | 19 | 0 | 4 |
| 420 | tests/tofu/destroy-real.test.ts | 0 | 0 | 2 |
| 421 | tests/tofu/destroy-runner.test.ts | 4 | 0 | 0 |
| 422 | tests/tofu/destroy.test.ts | 65 | 0 | 0 |
| 423 | tests/tofu/driver-expressions.test.ts | 1 | 0 | 0 |
| 424 | tests/tofu/ephemeral-network.test.ts | 0 | 0 | 5 |
| 425 | tests/tofu/ephemeral.test.ts | 44 | 0 | 0 |
| 426 | tests/tofu/hcl-template-real.test.ts | 2 | 0 | 0 |
| 427 | tests/tofu/hcl-template.test.ts | 141 | 0 | 0 |
| 428 | tests/tofu/network.test.ts | 0 | 0 | 4 |
| 429 | tests/tofu/plan-lock.test.ts | 1 | 0 | 0 |
| 430 | tests/tofu/plan-view-sensitive.test.ts | 1 | 0 | 0 |
| 431 | tests/tofu/plan.test.ts | 36 | 0 | 0 |
| 432 | tests/tofu/process.test.ts | 18 | 0 | 0 |
| 433 | tests/tofu/providers.test.ts | 8 | 0 | 0 |
| 434 | tests/tofu/runner.test.ts | 19 | 0 | 0 |
| 435 | tests/tofu/security-hardening.test.ts | 20 | 0 | 0 |
| 436 | tests/tofu/workspace-expressions.test.ts | 50 | 0 | 0 |
| 437 | tests/tofu/workspace.test.ts | 29 | 0 | 0 |
| 438 | tests/security/agent-credentials.test.ts | 12 | 0 | 0 |
| 439 | tests/security/audit-secret-leakage.test.ts | 5 | 0 | 0 |
| 440 | tests/security/controlplane-sql-scoping.test.ts | 5 | 0 | 0 |
| 441 | tests/security/credential-boundaries.test.ts | 7 | 0 | 0 |
| 442 | tests/security/digest-canonical.test.ts | 22 | 0 | 0 |
| 443 | tests/security/driver-inert.test.ts | 7 | 0 | 0 |
| 444 | tests/security/image-pins.test.ts | 31 | 0 | 0 |
| 445 | tests/security/mcp-secret-leakage.test.ts | 4 | 0 | 0 |
| 446 | tests/security/mcp-v1-tenant-isolation.test.ts | 16 | 0 | 0 |
| 447 | tests/security/mcp-v2-tenant-isolation.test.ts | 20 | 0 | 0 |
| 448 | tests/security/policy-invariants.test.ts | 31 | 0 | 0 |
| 449 | tests/security/reconcile-value-boundaries.test.ts | 4 | 0 | 0 |
| 450 | tests/security/redaction-coverage.test.ts | 9 | 0 | 0 |
| 451 | tests/security/request-error-logging.test.ts | 2 | 0 | 0 |
| 452 | tests/security/runtime-sanity.test.ts | 4 | 0 | 0 |
| 453 | tests/security/signal-boundaries.test.ts | 6 | 0 | 0 |
| 454 | tests/security/ssrf-address-oracle.test.ts | 5 | 0 | 0 |
| 455 | tests/security/store-value-boundaries.test.ts | 1 | 0 | 0 |
| 456 | tests/security/support.test.ts | 27 | 0 | 0 |
| 457 | tests/security/tofu-runner-env.test.ts | 7 | 0 | 0 |
| 458 | tests/security/tofu-secrets.test.ts | 14 | 0 | 0 |
| 459 | tests/security/tofu-workspace-injection.test.ts | 34 | 0 | 0 |
| 460 | tests/security/workflow-history.test.ts | 8 | 0 | 2 |
| 461 | tests/waitlist/access.test.ts | 43 | 0 | 0 |
| 462 | tests/waitlist/admin-api.test.ts | 118 | 0 | 0 |
| 463 | tests/waitlist/admin-file.test.ts | 44 | 0 | 0 |
| 464 | tests/waitlist/admin-postgres.test.ts | 47 | 0 | 0 |
| 465 | tests/waitlist/api.test.ts | 67 | 0 | 0 |
| 466 | tests/waitlist/enforcement.test.ts | 9 | 0 | 0 |
| 467 | tests/waitlist/file-repository.test.ts | 44 | 0 | 0 |
| 468 | tests/waitlist/pg-contract.test.ts | 0 | 0 | 38 |
| 469 | tests/workflows/approval-time.test.ts | 0 | 0 | 3 |
| 470 | tests/workflows/caller-payloads.test.ts | 6 | 0 | 0 |
| 471 | tests/workflows/client.test.ts | 4 | 0 | 12 |
| 472 | tests/workflows/codec-replay.test.ts | 0 | 0 | 2 |
| 473 | tests/workflows/codec-wiring.test.ts | 24 | 0 | 0 |
| 474 | tests/workflows/codec.test.ts | 45 | 0 | 0 |
| 475 | tests/workflows/config.test.ts | 28 | 0 | 0 |
| 476 | tests/workflows/deploy.test.ts | 0 | 0 | 38 |
| 477 | tests/workflows/destroy-replay.test.ts | 0 | 0 | 6 |
| 478 | tests/workflows/destroy.test.ts | 11 | 0 | 0 |
| 479 | tests/workflows/ecs-replica-repair.test.ts | 0 | 0 | 11 |
| 480 | tests/workflows/failures.test.ts | 42 | 0 | 0 |
| 481 | tests/workflows/mtls-config.test.ts | 29 | 0 | 0 |
| 482 | tests/workflows/mtls-live.test.ts | 0 | 0 | 2 |
| 483 | tests/workflows/operations.test.ts | 0 | 0 | 28 |
| 484 | tests/workflows/payload-boundary.test.ts | 52 | 0 | 0 |
| 485 | tests/workflows/reconcile.test.ts | 0 | 0 | 2 |
| 486 | tests/workflows/replay.test.ts | 0 | 0 | 7 |
| 487 | tests/workflows/sandbox.test.ts | 52 | 0 | 0 |
| 488 | tests/workflows/worker.test.ts | 15 | 0 | 1 |
| 489 | tests/workers/health.test.ts | 11 | 0 | 0 |
| 490 | tests/workers/plan-janitor.test.ts | 14 | 0 | 0 |
| 491 | tests/workers/worker-health-wiring.test.ts | 3 | 0 | 0 |
| 492 | tests/credentials/aws/bootstrap-context.test.ts | 57 | 0 | 0 |
| 493 | tests/db/contract/alerts.test.ts | 0 | 0 | 7 |
| 494 | tests/db/contract/audit.test.ts | 7 | 0 | 1 |
| 495 | tests/db/contract/history.test.ts | 7 | 0 | 7 |
| 496 | tests/db/contract/secrets.test.ts | 9 | 0 | 0 |
| 497 | tests/db/contract/store-contract.test.ts | 13 | 0 | 0 |
| 498 | tests/db/contract/workspace-sharing.test.ts | 0 | 0 | 22 |
| 499 | tests/hosted/acceptance/gate-01-source-to-app.test.ts | 13 | 0 | 0 |
| 500 | tests/hosted/acceptance/gate-02-second-identity.test.ts | 8 | 0 | 0 |
| 501 | tests/hosted/acceptance/gate-03-denial-matrix.test.ts | 14 | 0 | 0 |
| 502 | tests/hosted/acceptance/gate-04-broker-roles.test.ts | 8 | 0 | 0 |
| 503 | tests/hosted/acceptance/gate-05-boundaries.test.ts | 13 | 0 | 0 |
| 504 | tests/hosted/acceptance/gate-06-quotas-and-limits.test.ts | 8 | 0 | 0 |
| 505 | tests/hosted/acceptance/gate-07-durability.test.ts | 6 | 0 | 0 |
| 506 | tests/hosted/acceptance/gate-08-compatible-update.test.ts | 6 | 0 | 0 |
| 507 | tests/hosted/acceptance/gate-09-failed-candidate.test.ts | 7 | 0 | 0 |
| 508 | tests/hosted/acceptance/gate-10-restore.test.ts | 8 | 0 | 0 |
| 509 | tests/hosted/acceptance/gate-11-health-and-logs.test.ts | 8 | 0 | 0 |
| 510 | tests/hosted/acceptance/gate-12-browser-flow.test.ts | 11 | 0 | 0 |
| 511 | tests/hosted/access/delivery.test.ts | 7 | 0 | 0 |
| 512 | tests/hosted/access/grants.test.ts | 18 | 0 | 0 |
| 513 | tests/hosted/access/invites-expiry.test.ts | 8 | 0 | 0 |
| 514 | tests/hosted/access/invites.test.ts | 10 | 0 | 0 |
| 515 | tests/hosted/access/routes.test.ts | 14 | 0 | 0 |
| 516 | tests/hosted/access/sessions.test.ts | 19 | 0 | 0 |
| 517 | tests/hosted/build/docker-reap.test.ts | 12 | 0 | 0 |
| 518 | tests/hosted/build/pipeline.test.ts | 2 | 0 | 0 |
| 519 | tests/hosted/build/recipe-image.test.ts | 7 | 0 | 0 |
| 520 | tests/hosted/build/recipe-local.test.ts | 26 | 0 | 0 |
| 521 | tests/hosted/build/runners-isolated.test.ts | 38 | 0 | 0 |
| 522 | tests/hosted/backup/create-restore.test.ts | 7 | 0 | 0 |
| 523 | tests/hosted/backup/reconcile.test.ts | 4 | 0 | 0 |
| 524 | tests/hosted/backup/reopen.test.ts | 6 | 0 | 0 |
| 525 | tests/hosted/backup/targets.test.ts | 14 | 0 | 0 |
| 526 | tests/hosted/artifacts/storage-store.test.ts | 10 | 0 | 2 |
| 527 | tests/hosted/artifacts/store.test.ts | 29 | 0 | 0 |
| 528 | tests/hosted/events/record.test.ts | 10 | 0 | 0 |
| 529 | tests/hosted/events/scorecard.test.ts | 11 | 0 | 0 |
| 530 | tests/hosted/data/conflict.test.ts | 5 | 0 | 0 |
| 531 | tests/hosted/data/d1-backend.test.ts | 13 | 0 | 0 |
| 532 | tests/hosted/data/idempotency.test.ts | 10 | 0 | 0 |
| 533 | tests/hosted/data/isolation.test.ts | 15 | 0 | 0 |
| 534 | tests/hosted/data/ops-parity.test.ts | 7 | 0 | 0 |
| 535 | tests/hosted/data/pg-backend.test.ts | 21 | 0 | 0 |
| 536 | tests/hosted/data/pg-contract.live.test.ts | 0 | 0 | 11 |
| 537 | tests/hosted/data/quota.test.ts | 9 | 0 | 0 |
| 538 | tests/hosted/data/schema.test.ts | 17 | 0 | 0 |
| 539 | tests/hosted/data/store.test.ts | 39 | 0 | 0 |
| 540 | tests/hosted/authority/access.test.ts | 15 | 0 | 0 |
| 541 | tests/hosted/authority/backup.test.ts | 3 | 0 | 0 |
| 542 | tests/hosted/authority/busy.test.ts | 2 | 0 | 0 |
| 543 | tests/hosted/authority/events.test.ts | 9 | 0 | 0 |
| 544 | tests/hosted/authority/jobs.test.ts | 11 | 0 | 0 |
| 545 | tests/hosted/authority/open.test.ts | 8 | 0 | 0 |
| 546 | tests/hosted/authority/outbox-fence.test.ts | 2 | 0 | 0 |
| 547 | tests/hosted/authority/outbox.test.ts | 6 | 0 | 0 |
| 548 | tests/hosted/authority/pg-schema-check.test.ts | 9 | 0 | 0 |
| 549 | tests/hosted/authority/pg-tx.test.ts | 15 | 0 | 0 |
| 550 | tests/hosted/authority/tx.test.ts | 10 | 0 | 0 |
| 551 | tests/hosted/gateway/admission.test.ts | 16 | 0 | 0 |
| 552 | tests/hosted/gateway/artifacts.test.ts | 15 | 0 | 0 |
| 553 | tests/hosted/gateway/broker.test.ts | 18 | 0 | 0 |
| 554 | tests/hosted/gateway/guard.test.ts | 16 | 0 | 0 |
| 555 | tests/hosted/gateway/journey.test.ts | 7 | 0 | 0 |
| 556 | tests/hosted/gateway/policy.test.ts | 16 | 0 | 0 |
| 557 | tests/hosted/gateway/reserved.test.ts | 13 | 0 | 0 |
| 558 | tests/hosted/gateway/session.test.ts | 9 | 0 | 0 |
| 559 | tests/hosted/health/health.test.ts | 7 | 0 | 0 |
| 560 | tests/hosted/release/activation.test.ts | 4 | 0 | 0 |
| 561 | tests/hosted/release/admission.test.ts | 10 | 0 | 0 |
| 562 | tests/hosted/release/apps.test.ts | 7 | 0 | 0 |
| 563 | tests/hosted/release/publish-real.test.ts | 4 | 0 | 0 |
| 564 | tests/hosted/release/resume.test.ts | 1 | 0 | 0 |
| 565 | tests/hosted/release/rollback.test.ts | 4 | 0 | 0 |
| 566 | tests/hosted/release/routes.test.ts | 13 | 0 | 0 |
| 567 | tests/hosted/release/runner.test.ts | 6 | 0 | 0 |
| 568 | tests/hosted/release/single-flight.test.ts | 3 | 0 | 0 |
| 569 | tests/hosted/release/suspend.test.ts | 4 | 0 | 0 |
| 570 | tests/hosted/runtime/cloudflare.test.ts | 22 | 0 | 0 |
| 571 | tests/hosted/runtime/local.test.ts | 19 | 0 | 0 |
| 572 | tests/hosted/runtime/workers.test.ts | 19 | 0 | 0 |
| 573 | tests/hosted/export/roundtrip.test.ts | 9 | 0 | 0 |
| 574 | tests/hosted/source/validate.test.ts | 52 | 0 | 0 |
| 575 | tests/hosted/tracker-app/api.test.ts | 16 | 0 | 0 |
| 576 | tests/hosted/tracker-app/build.test.ts | 5 | 0 | 0 |
| 577 | tests/hosted/tracker-app/contract.test.ts | 8 | 0 | 0 |
| 578 | tests/providers/aws/secret-writer.test.ts | 19 | 0 | 0 |
| 579 | tests/hosted/usage/outbox-handlers.test.ts | 5 | 0 | 0 |
| 580 | tests/hosted/usage/spending.test.ts | 10 | 0 | 0 |
| 581 | tests/hosted/quota/body.test.ts | 12 | 0 | 0 |
| 582 | tests/hosted/quota/counters.test.ts | 9 | 0 | 0 |
| 583 | tests/providers/gcp/bootstrap.test.ts | 13 | 0 | 1 |
| 584 | tests/providers/gcp/build-gcp.test.ts | 21 | 0 | 0 |
| 585 | tests/providers/gcp/compile.test.ts | 64 | 0 | 0 |
| 586 | tests/providers/gcp/credentials.test.ts | 41 | 0 | 0 |
| 587 | tests/providers/gcp/data-network.test.ts | 18 | 0 | 0 |
| 588 | tests/providers/gcp/dns-ownership.test.ts | 24 | 0 | 0 |
| 589 | tests/providers/gcp/firewall-network.test.ts | 10 | 0 | 0 |
| 590 | tests/providers/gcp/iam-read-credentials.test.ts | 10 | 0 | 0 |
| 591 | tests/providers/gcp/naming.test.ts | 16 | 0 | 0 |
| 592 | tests/providers/gcp/observability.test.ts | 18 | 0 | 0 |
| 593 | tests/providers/gcp/operations.test.ts | 30 | 0 | 0 |
| 594 | tests/providers/gcp/read.test.ts | 306 | 0 | 0 |
| 595 | tests/providers/gcp/release.test.ts | 40 | 0 | 0 |
| 596 | tests/providers/gcp/runtime.test.ts | 21 | 0 | 0 |
| 597 | tests/providers/gcp/secret-writer.test.ts | 7 | 0 | 0 |
| 598 | tests/providers/gcp/tofu-validate.test.ts | 0 | 0 | 6 |
| 599 | tests/providers/oci/allowlist-observability.test.ts | 12 | 0 | 0 |
| 600 | tests/providers/oci/allowlist.test.ts | 21 | 0 | 0 |
| 601 | tests/providers/oci/compile.test.ts | 60 | 0 | 0 |
| 602 | tests/providers/oci/discover.test.ts | 7 | 0 | 0 |
| 603 | tests/providers/oci/dns-ownership.test.ts | 33 | 0 | 0 |
| 604 | tests/providers/oci/failure-modes.test.ts | 208 | 0 | 0 |
| 605 | tests/providers/oci/more.test.ts | 72 | 0 | 0 |
| 606 | tests/providers/oci/mysql.test.ts | 4 | 0 | 5 |
| 607 | tests/providers/oci/naming-evidence.test.ts | 14 | 0 | 0 |
| 608 | tests/providers/oci/operations.test.ts | 19 | 0 | 0 |
| 609 | tests/providers/oci/release.test.ts | 60 | 0 | 0 |
| 610 | tests/providers/oci/static-checks.test.ts | 36 | 0 | 0 |
| 611 | tests/providers/oci/transport.test.ts | 69 | 0 | 0 |
| 612 | tests/providers/oci/validate.test.ts | 1 | 0 | 5 |
| 613 | tests/providers/oci/world.test.ts | 6 | 0 | 0 |
| 614 | tests/providers/zenith/apply.test.ts | 21 | 0 | 0 |
| 615 | tests/providers/zenith/deploy.test.ts | 14 | 0 | 0 |
| 616 | tests/providers/zenith/drivers.test.ts | 67 | 0 | 0 |
| 617 | tests/providers/zenith/export.test.ts | 19 | 0 | 0 |
| 618 | tests/providers/zenith/identity-wiring.test.ts | 18 | 0 | 0 |
| 619 | tests/providers/zenith/isolation.test.ts | 52 | 0 | 0 |
| 620 | tests/providers/zenith/k8s-contract.test.ts | 19 | 0 | 0 |
| 621 | tests/providers/zenith/neon.test.ts | 53 | 0 | 0 |
| 622 | tests/providers/zenith/render.test.ts | 53 | 0 | 0 |
| 623 | tests/providers/zenith/substrate.test.ts | 48 | 0 | 0 |
| 624 | tests/providers/zenith/teardown-neon.test.ts | 13 | 0 | 0 |
| 625 | tests/providers/zenith/teardown.test.ts | 41 | 0 | 0 |
| 626 | tests/providers/zenith/tenancy.test.ts | 30 | 0 | 0 |
| 627 | tests/providers/zenith/tls-api.test.ts | 10 | 0 | 0 |
| 628 | tests/providers/zenith/tls.test.ts | 22 | 0 | 0 |
| 629 | tests/providers/zenith/vault-runtime.test.ts | 12 | 0 | 0 |
| 630 | tests/providers/kubernetes/apply.test.ts | 30 | 0 | 0 |
| 631 | tests/providers/kubernetes/drivers.test.ts | 41 | 0 | 0 |
| 632 | tests/providers/kubernetes/fields.test.ts | 9 | 0 | 0 |
| 633 | tests/providers/kubernetes/identity-apply.test.ts | 30 | 0 | 0 |
| 634 | tests/providers/kubernetes/identity-render.test.ts | 42 | 0 | 0 |
| 635 | tests/providers/kubernetes/kind.test.ts | 0 | 0 | 6 |
| 636 | tests/providers/kubernetes/naming-util.test.ts | 16 | 0 | 0 |
| 637 | tests/providers/kubernetes/ops.test.ts | 37 | 0 | 0 |
| 638 | tests/providers/kubernetes/prune.test.ts | 14 | 0 | 0 |
| 639 | tests/providers/kubernetes/release-kind.test.ts | 0 | 0 | 1 |
| 640 | tests/providers/kubernetes/release.test.ts | 33 | 0 | 0 |
| 641 | tests/providers/kubernetes/render.test.ts | 44 | 0 | 0 |
| 642 | tests/providers/kubernetes/rollout.test.ts | 22 | 0 | 0 |
| 643 | tests/providers/kubernetes/session.test.ts | 25 | 0 | 0 |
| 644 | tests/providers/kubernetes/teardown.test.ts | 43 | 0 | 0 |
| 645 | tests/screens/platform/approval-eligibility.test.ts | 41 | 0 | 0 |
| 646 | tests/screens/platform/aws-connection-validation.test.ts | 51 | 0 | 0 |
| 647 | tests/screens/platform/client-safety.test.ts | 77 | 0 | 0 |
| 648 | tests/screens/platform/event-sentences.test.ts | 52 | 0 | 0 |
| 649 | tests/screens/platform/investigation-model.test.ts | 6 | 0 | 0 |
| 650 | tests/screens/platform/plan-values.test.ts | 11 | 0 | 0 |
| 651 | tests/screens/platform/policy-language.test.ts | 8 | 0 | 0 |
| 652 | tests/screens/platform/price-evidence.test.ts | 11 | 0 | 0 |
| 653 | tests/screens/platform/resource-state-model.test.ts | 25 | 0 | 0 |
| 654 | tests/screens/platform/text-helpers.test.ts | 29 | 0 | 0 |
| 655 | tests/providers/azure/arm.test.ts | 12 | 0 | 0 |
| 656 | tests/providers/azure/build-digest.test.ts | 23 | 0 | 0 |
| 657 | tests/providers/azure/compile-drivers.test.ts | 26 | 0 | 0 |
| 658 | tests/providers/azure/compile.test.ts | 14 | 0 | 0 |
| 659 | tests/providers/azure/credentials.test.ts | 60 | 0 | 0 |
| 660 | tests/providers/azure/deploy.test.ts | 8 | 0 | 1 |
| 661 | tests/providers/azure/dns-ownership.test.ts | 27 | 0 | 0 |
| 662 | tests/providers/azure/helpers.test.ts | 14 | 0 | 0 |
| 663 | tests/providers/azure/more-compile.test.ts | 68 | 0 | 0 |
| 664 | tests/providers/azure/more-observe.test.ts | 70 | 0 | 0 |
| 665 | tests/providers/azure/mysql.test.ts | 21 | 0 | 2 |
| 666 | tests/providers/azure/observability.test.ts | 11 | 0 | 0 |
| 667 | tests/providers/azure/observe.test.ts | 58 | 0 | 0 |
| 668 | tests/providers/azure/operations.test.ts | 15 | 0 | 0 |
| 669 | tests/providers/azure/registry.test.ts | 3 | 0 | 0 |
| 670 | tests/providers/azure/release-journal.test.ts | 10 | 0 | 0 |
| 671 | tests/providers/azure/release.test.ts | 37 | 0 | 0 |
| 672 | tests/providers/azure/source-binding.test.ts | 7 | 0 | 0 |
| 673 | tests/providers/azure/source-storage.test.ts | 36 | 0 | 0 |
| 674 | tests/providers/azure/static-checks.test.ts | 21 | 0 | 0 |
| 675 | tests/providers/azure/validate.test.ts | 1 | 0 | 5 |
| 676 | tests/hosted/authority/contract/access.test.ts | 17 | 0 | 0 |
| 677 | tests/hosted/authority/contract/contract.test.ts | 26 | 0 | 0 |
| 678 | tests/hosted/authority/contract/ledgers.test.ts | 12 | 0 | 0 |
| 679 | tests/hosted/authority/contract/release.test.ts | 18 | 0 | 0 |
| 680 | tests/providers/aws/drivers/contract.test.ts | 53 | 0 | 0 |
| 681 | tests/providers/aws/drivers/e2e-compile.test.ts | 6 | 0 | 2 |
| 682 | tests/providers/aws/identity/trust.test.ts | 13 | 0 | 1 |
| 683 | tests/providers/gcp/identity/trust.test.ts | 9 | 0 | 1 |
| 684 | tests/providers/azure/identity/trust.test.ts | 4 | 0 | 1 |
| 685 | tests/providers/aws/drivers/compute/assemble.test.ts | 4 | 0 | 3 |
| 686 | tests/providers/aws/drivers/compute/codebuild.test.ts | 81 | 0 | 0 |
| 687 | tests/providers/aws/drivers/compute/ecr.test.ts | 19 | 0 | 0 |
| 688 | tests/providers/aws/drivers/compute/ecs-compile.test.ts | 51 | 0 | 0 |
| 689 | tests/providers/aws/drivers/compute/ecs-operations.test.ts | 52 | 0 | 0 |
| 690 | tests/providers/aws/drivers/compute/ecs-read.test.ts | 35 | 0 | 0 |
| 691 | tests/providers/aws/drivers/compute/ecs-replica-repair-read.test.ts | 26 | 0 | 0 |
| 692 | tests/providers/aws/drivers/compute/ecs-scheduled-read.test.ts | 32 | 0 | 0 |
| 693 | tests/providers/aws/drivers/compute/family-boundary.test.ts | 40 | 0 | 0 |
| 694 | tests/providers/aws/drivers/compute/lambda-ec2.test.ts | 37 | 0 | 0 |
| 695 | tests/providers/aws/drivers/compute/registry.test.ts | 7 | 0 | 0 |
| 696 | tests/providers/aws/drivers/compute/static-site.test.ts | 34 | 0 | 0 |
| 697 | tests/providers/aws/drivers/compute/support.test.ts | 94 | 0 | 0 |
| 698 | tests/providers/aws/drivers/compute/workload-boundary.test.ts | 57 | 0 | 0 |
| 699 | tests/providers/aws/drivers/eks/eks-cluster.test.ts | 37 | 0 | 0 |
| 700 | tests/providers/aws/drivers/eks/eks-policy.test.ts | 4 | 0 | 0 |
| 701 | tests/providers/aws/drivers/eks/eks-reads.test.ts | 101 | 0 | 0 |
| 702 | tests/providers/aws/drivers/messaging/assemble.test.ts | 8 | 0 | 1 |
| 703 | tests/providers/aws/drivers/messaging/sns-observe.test.ts | 77 | 0 | 0 |
| 704 | tests/providers/aws/drivers/messaging/sns-topic.test.ts | 43 | 0 | 0 |
| 705 | tests/providers/aws/drivers/data/assemble.test.ts | 4 | 0 | 1 |
| 706 | tests/providers/aws/drivers/data/contract.test.ts | 11 | 0 | 0 |
| 707 | tests/providers/aws/drivers/data/elasticache.test.ts | 25 | 0 | 0 |
| 708 | tests/providers/aws/drivers/data/iam-role.test.ts | 68 | 0 | 0 |
| 709 | tests/providers/aws/drivers/data/log-group.test.ts | 24 | 0 | 0 |
| 710 | tests/providers/aws/drivers/data/rds-compile.test.ts | 34 | 0 | 0 |
| 711 | tests/providers/aws/drivers/data/rds-read.test.ts | 42 | 0 | 0 |
| 712 | tests/providers/aws/drivers/data/s3-bucket.test.ts | 21 | 0 | 0 |
| 713 | tests/providers/aws/drivers/data/secret.test.ts | 24 | 0 | 0 |
| 714 | tests/providers/aws/drivers/data/sqs-queue.test.ts | 20 | 0 | 0 |
| 715 | tests/providers/aws/drivers/data/support.test.ts | 14 | 0 | 0 |
| 716 | tests/providers/aws/drivers/storage/ebs-volume.test.ts | 42 | 0 | 0 |
| 717 | tests/providers/aws/drivers/network/alb.test.ts | 51 | 0 | 0 |
| 718 | tests/providers/aws/drivers/network/compile-graph.test.ts | 21 | 0 | 6 |
| 719 | tests/providers/aws/drivers/network/contract.test.ts | 19 | 0 | 0 |
| 720 | tests/providers/aws/drivers/network/dns-acm.test.ts | 40 | 0 | 0 |
| 721 | tests/providers/aws/drivers/network/firewall.test.ts | 41 | 0 | 0 |
| 722 | tests/providers/aws/drivers/network/shared.test.ts | 37 | 0 | 0 |
| 723 | tests/providers/aws/drivers/network/subnet.test.ts | 15 | 0 | 0 |
| 724 | tests/providers/aws/drivers/network/vpc.test.ts | 30 | 0 | 0 |
| 725 | tests/client/bootstrap-backoff.test.tsx | 2 | 0 | 0 |
| 726 | tests/client/navigator-poll-budget.test.tsx | 5 | 0 | 0 |
| 727 | tests/client/read-cancellation.test.tsx | 3 | 0 | 0 |
| 728 | tests/client/stream-url-switch.test.tsx | 3 | 0 | 0 |
| 729 | tests/client/use-json.test.tsx | 8 | 0 | 0 |
| 730 | tests/api/preview-outcomes.test.tsx | 18 | 0 | 0 |
| 731 | tests/navigator/gimbal-character.test.tsx | 7 | 0 | 0 |
| 732 | tests/navigator/gimbal-renderer.test.tsx | 13 | 0 | 0 |
| 733 | tests/navigator/recorded-receipt.test.tsx | 5 | 0 | 0 |
| 734 | tests/navigator/run-history.test.tsx | 1 | 0 | 0 |
| 735 | tests/navigator/run-panel.test.tsx | 3 | 0 | 0 |
| 736 | tests/navigator/step-card.test.tsx | 5 | 0 | 0 |
| 737 | tests/platform-ui/interactions.test.tsx | 25 | 0 | 0 |
| 738 | tests/platform-ui/pages.test.tsx | 14 | 0 | 0 |
| 739 | tests/platform-ui/teardown-page.test.tsx | 3 | 0 | 0 |
| 740 | tests/platform-ui/teardown.test.tsx | 45 | 0 | 0 |
| 741 | tests/screens/account-identities.test.tsx | 22 | 0 | 0 |
| 742 | tests/screens/account-page.test.tsx | 9 | 0 | 0 |
| 743 | tests/screens/account-password.test.tsx | 18 | 0 | 0 |
| 744 | tests/screens/activity-page.test.tsx | 2 | 0 | 0 |
| 745 | tests/screens/auth-form.test.tsx | 17 | 0 | 0 |
| 746 | tests/screens/deploy-history-page.test.tsx | 5 | 0 | 0 |
| 747 | tests/screens/deploy-output-labels.test.tsx | 5 | 0 | 0 |
| 748 | tests/screens/deploy-uncertainty.test.tsx | 10 | 0 | 0 |
| 749 | tests/screens/integrations-control.test.tsx | 19 | 0 | 0 |
| 750 | tests/screens/landing-chapters.test.tsx | 10 | 0 | 0 |
| 751 | tests/screens/landing-cta.test.tsx | 4 | 0 | 0 |
| 752 | tests/screens/landing-header.test.tsx | 8 | 0 | 0 |
| 753 | tests/screens/landing-hero-cta.test.tsx | 2 | 0 | 0 |
| 754 | tests/screens/landing-waitlist.test.tsx | 6 | 0 | 0 |
| 755 | tests/screens/manifest-v2-inspector.test.tsx | 4 | 0 | 0 |
| 756 | tests/screens/map-keyboard.test.tsx | 1 | 0 | 0 |
| 757 | tests/screens/navigation-transitions.test.tsx | 11 | 0 | 0 |
| 758 | tests/screens/onboarding-controls.test.tsx | 6 | 0 | 0 |
| 759 | tests/screens/onboarding-flow.test.tsx | 5 | 0 | 0 |
| 760 | tests/screens/plan-role.test.tsx | 4 | 0 | 0 |
| 761 | tests/screens/project-grid.test.tsx | 13 | 0 | 0 |
| 762 | tests/screens/revision-history.test.tsx | 3 | 0 | 0 |
| 763 | tests/screens/run-action-refresh.test.tsx | 5 | 0 | 0 |
| 764 | tests/screens/signup-page.test.tsx | 3 | 0 | 0 |
| 765 | tests/screens/toast-project-identity.test.tsx | 8 | 0 | 0 |
| 766 | tests/screens/workspace-access-page.test.tsx | 7 | 0 | 0 |
| 767 | tests/screens/workspace-guide.test.tsx | 3 | 0 | 0 |
| 768 | tests/screens/workspace-invite.test.tsx | 10 | 0 | 0 |
| 769 | tests/screens/workspace-sharing.test.tsx | 12 | 0 | 0 |
| 770 | tests/shell/activity-bell.test.tsx | 9 | 0 | 0 |
| 771 | tests/shell/command-palette.test.tsx | 29 | 0 | 0 |
| 772 | tests/shell/context-summary.test.tsx | 3 | 0 | 0 |
| 773 | tests/shell/project-environment.test.tsx | 3 | 0 | 0 |
| 774 | tests/shell/workbench.test.tsx | 8 | 0 | 0 |
| 775 | tests/spatial/change-rehearsal.test.tsx | 3 | 0 | 0 |
| 776 | tests/waitlist/admin-entry.test.tsx | 7 | 0 | 0 |
| 777 | tests/waitlist/ui.test.tsx | 26 | 0 | 0 |
| 778 | tests/ui/callout.test.tsx | 5 | 0 | 0 |
| 779 | tests/ui/popover.test.tsx | 11 | 0 | 0 |
| 780 | tests/ui/table.test.tsx | 12 | 0 | 0 |
| 781 | tests/ui/theme-toggle.test.tsx | 6 | 0 | 0 |
| 782 | tests/ui/toast-persistence.test.tsx | 13 | 0 | 0 |
| 783 | tests/ui/workbench-controls.test.tsx | 9 | 0 | 0 |
| 784 | tests/hosted/tracker-app/app.test.tsx | 16 | 0 | 0 |
| 785 | tests/screens/settings/environment-health.test.tsx | 3 | 0 | 0 |
| 786 | tests/screens/apps/accept.test.tsx | 5 | 0 | 0 |
| 787 | tests/screens/apps/app-detail.test.tsx | 7 | 0 | 0 |
| 788 | tests/screens/apps/apps-list.test.tsx | 8 | 0 | 0 |
| 789 | tests/screens/apps/audience.test.tsx | 5 | 0 | 0 |
| 790 | tests/screens/apps/job-progress.test.tsx | 4 | 0 | 0 |
| 791 | tests/screens/apps/limits-health.test.tsx | 11 | 0 | 0 |
| 792 | tests/screens/apps/new-app.test.tsx | 6 | 0 | 0 |
| 793 | tests/screens/apps/publish-gating.test.tsx | 13 | 0 | 0 |
| 794 | tests/screens/apps/releases.test.tsx | 5 | 0 | 0 |
| 795 | tests/screens/platform/accessibility-and-honesty.test.tsx | 66 | 0 | 0 |
| 796 | tests/screens/platform/approval-card.test.tsx | 30 | 0 | 0 |
| 797 | tests/screens/platform/autonomy-control.test.tsx | 15 | 0 | 0 |
| 798 | tests/screens/platform/aws-connection-flow.test.tsx | 1 | 0 | 0 |
| 799 | tests/screens/platform/aws-connection-setup.test.tsx | 24 | 0 | 0 |
| 800 | tests/screens/platform/cost-and-placement.test.tsx | 28 | 0 | 0 |
| 801 | tests/screens/platform/drift-list.test.tsx | 16 | 0 | 0 |
| 802 | tests/screens/platform/investigation-view.test.tsx | 19 | 0 | 0 |
| 803 | tests/screens/platform/operation-timeline.test.tsx | 29 | 0 | 0 |
| 804 | tests/screens/platform/plan-changes-table.test.tsx | 17 | 0 | 0 |
| 805 | tests/screens/platform/policy-decision-panel.test.tsx | 10 | 0 | 0 |
| 806 | tests/screens/platform/resource-state.test.tsx | 23 | 0 | 0 |
| 807 | tests/screens/platform/teardown-review.test.tsx | 5 | 0 | 0 |

### staging-unit: domain counts

| Domain | Passed | Failed | Skipped |
|---|---:|---:|---:|
| acceptance | 211 | 0 | 1 |
| actions | 359 | 0 | 0 |
| agent-access | 26 | 0 | 0 |
| agent-control | 0 | 0 | 16 |
| agent-control-advance.test.ts | 5 | 0 | 0 |
| agent-control-capabilities.test.ts | 13 | 0 | 0 |
| agent-control-coordinator.test.ts | 13 | 0 | 0 |
| agent-control-journal-fixes.test.ts | 23 | 0 | 6 |
| agent-control-journal.test.ts | 21 | 0 | 7 |
| agent-control-oauth.test.ts | 15 | 0 | 0 |
| agent-control-rate-limit.test.ts | 8 | 0 | 0 |
| agent-control-reconcile.test.ts | 5 | 0 | 0 |
| agent-control-upload.test.ts | 5 | 0 | 0 |
| agent-journey.test.ts | 15 | 0 | 0 |
| agent-link | 0 | 0 | 14 |
| agent-link-authority.test.ts | 27 | 0 | 0 |
| agent-link-protocol.test.ts | 16 | 0 | 0 |
| agent-link-routes.test.ts | 26 | 0 | 0 |
| agent-serverless-routes.test.ts | 26 | 0 | 0 |
| agent-v3 | 284 | 0 | 0 |
| agent-waitlist.test.ts | 7 | 0 | 0 |
| alerts | 141 | 0 | 0 |
| analysis | 352 | 0 | 0 |
| api | 198 | 0 | 0 |
| auth | 211 | 0 | 0 |
| bridge | 124 | 0 | 1 |
| capabilities | 383 | 0 | 0 |
| ci | 661 | 0 | 0 |
| cli | 120 | 0 | 1 |
| client | 30 | 0 | 0 |
| controlplane | 263 | 0 | 7 |
| cost | 18 | 0 | 0 |
| credentials | 297 | 0 | 0 |
| db | 110 | 0 | 37 |
| deploy | 62 | 0 | 0 |
| docs | 109 | 0 | 0 |
| drift | 8 | 0 | 0 |
| engine | 45 | 0 | 0 |
| execution | 595 | 0 | 8 |
| hosted | 1061 | 0 | 13 |
| hosted-spike | 85 | 0 | 0 |
| importers | 14 | 0 | 0 |
| incidents | 262 | 0 | 0 |
| logsim | 6 | 0 | 0 |
| machines | 581 | 0 | 19 |
| middleware | 66 | 0 | 0 |
| navigator | 152 | 0 | 0 |
| observability | 496 | 0 | 0 |
| placement | 139 | 0 | 0 |
| platform | 338 | 0 | 1 |
| platform-ui | 147 | 0 | 0 |
| policy | 238 | 0 | 0 |
| providers | 4371 | 0 | 7 |
| reconcile | 223 | 0 | 0 |
| resources | 448 | 0 | 0 |
| runners | 321 | 0 | 0 |
| screens | 1058 | 0 | 0 |
| scripts | 43 | 0 | 3 |
| secrets | 107 | 0 | 1 |
| security | 281 | 0 | 3 |
| server | 48 | 0 | 0 |
| shell | 62 | 0 | 0 |
| sources | 62 | 0 | 11 |
| spatial | 8 | 0 | 0 |
| tofu | 473 | 0 | 8 |
| ui | 67 | 0 | 0 |
| waitlist | 405 | 0 | 38 |
| workers | 35 | 0 | 0 |
| workflows | 413 | 0 | 10 |

### staging-unit: every test file

| File ordinal | File | Passed | Failed | Skipped |
|---:|---|---:|---:|---:|
| 1 | tests/agent-control-advance.test.ts | 5 | 0 | 0 |
| 2 | tests/agent-control-capabilities.test.ts | 13 | 0 | 0 |
| 3 | tests/agent-control-coordinator.test.ts | 13 | 0 | 0 |
| 4 | tests/agent-control-journal-fixes.test.ts | 23 | 0 | 6 |
| 5 | tests/agent-control-journal.test.ts | 21 | 0 | 7 |
| 6 | tests/agent-control-oauth.test.ts | 15 | 0 | 0 |
| 7 | tests/agent-control-rate-limit.test.ts | 8 | 0 | 0 |
| 8 | tests/agent-control-reconcile.test.ts | 5 | 0 | 0 |
| 9 | tests/agent-control-upload.test.ts | 5 | 0 | 0 |
| 10 | tests/agent-journey.test.ts | 15 | 0 | 0 |
| 11 | tests/agent-link-authority.test.ts | 27 | 0 | 0 |
| 12 | tests/agent-link-protocol.test.ts | 16 | 0 | 0 |
| 13 | tests/agent-link-routes.test.ts | 26 | 0 | 0 |
| 14 | tests/agent-serverless-routes.test.ts | 26 | 0 | 0 |
| 15 | tests/agent-waitlist.test.ts | 7 | 0 | 0 |
| 16 | tests/acceptance/catalogue.test.ts | 12 | 0 | 0 |
| 17 | tests/acceptance/cleanup.test.ts | 11 | 0 | 0 |
| 18 | tests/acceptance/clients.test.ts | 20 | 0 | 0 |
| 19 | tests/acceptance/evidence.test.ts | 7 | 0 | 0 |
| 20 | tests/acceptance/lifecycle.test.ts | 2 | 0 | 0 |
| 21 | tests/acceptance/packaged-worker.test.ts | 107 | 0 | 0 |
| 22 | tests/acceptance/runner.test.ts | 7 | 0 | 0 |
| 23 | tests/acceptance/safety.test.ts | 24 | 0 | 0 |
| 24 | tests/acceptance/sample-app.test.ts | 4 | 0 | 1 |
| 25 | tests/acceptance/scenario-j.test.ts | 3 | 0 | 0 |
| 26 | tests/acceptance/scenario-live.test.ts | 5 | 0 | 0 |
| 27 | tests/acceptance/tofu-destroy.test.ts | 9 | 0 | 0 |
| 28 | tests/actions/audit-boundary.test.ts | 6 | 0 | 0 |
| 29 | tests/actions/connection-env-isolation.test.ts | 38 | 0 | 0 |
| 30 | tests/actions/deploy-approve-separation.test.ts | 9 | 0 | 0 |
| 31 | tests/actions/deploy-isolation.test.ts | 20 | 0 | 0 |
| 32 | tests/actions/deploy.test.ts | 5 | 0 | 0 |
| 33 | tests/actions/env-lifecycle.test.ts | 13 | 0 | 0 |
| 34 | tests/actions/env-teardown.test.ts | 11 | 0 | 0 |
| 35 | tests/actions/guarantees.test.ts | 13 | 0 | 0 |
| 36 | tests/actions/hosted.test.ts | 14 | 0 | 0 |
| 37 | tests/actions/idempotency.test.ts | 10 | 0 | 0 |
| 38 | tests/actions/import-resources.test.ts | 8 | 0 | 0 |
| 39 | tests/actions/import-secret-isolation.test.ts | 2 | 0 | 0 |
| 40 | tests/actions/manifest-navigator-isolation.test.ts | 21 | 0 | 0 |
| 41 | tests/actions/manifest-v2-consumers.test.ts | 5 | 0 | 0 |
| 42 | tests/actions/manifest-v2.test.ts | 14 | 0 | 0 |
| 43 | tests/actions/placement.test.ts | 11 | 0 | 0 |
| 44 | tests/actions/plan-throws.test.ts | 1 | 0 | 0 |
| 45 | tests/actions/provider-honesty.test.ts | 4 | 0 | 0 |
| 46 | tests/actions/roles-workspace.test.ts | 4 | 0 | 0 |
| 47 | tests/actions/roles.test.ts | 10 | 0 | 0 |
| 48 | tests/actions/security-alerts-isolation.test.ts | 48 | 0 | 0 |
| 49 | tests/actions/security-reopen.test.ts | 5 | 0 | 0 |
| 50 | tests/actions/stateful-deletion-rollback.test.ts | 7 | 0 | 0 |
| 51 | tests/actions/stateful-deletion.test.ts | 4 | 0 | 0 |
| 52 | tests/actions/system-edits.test.ts | 6 | 0 | 0 |
| 53 | tests/actions/system.test.ts | 19 | 0 | 0 |
| 54 | tests/actions/workspace-isolation.test.ts | 44 | 0 | 0 |
| 55 | tests/actions/workspace.test.ts | 7 | 0 | 0 |
| 56 | tests/agent-access/journal-tenancy.test.ts | 26 | 0 | 0 |
| 57 | tests/agent-control/pg-contract.test.ts | 0 | 0 | 16 |
| 58 | tests/agent-link/pg-contract.test.ts | 0 | 0 | 14 |
| 59 | tests/agent-v3/adapters.test.ts | 6 | 0 | 0 |
| 60 | tests/agent-v3/auth.test.ts | 4 | 0 | 0 |
| 61 | tests/agent-v3/catalog.test.ts | 20 | 0 | 0 |
| 62 | tests/agent-v3/envelope.test.ts | 30 | 0 | 0 |
| 63 | tests/agent-v3/execute.test.ts | 18 | 0 | 0 |
| 64 | tests/agent-v3/oauth-metadata.test.ts | 36 | 0 | 0 |
| 65 | tests/agent-v3/observability-wired.test.ts | 4 | 0 | 0 |
| 66 | tests/agent-v3/placement-transport.test.ts | 8 | 0 | 0 |
| 67 | tests/agent-v3/placement.test.ts | 6 | 0 | 0 |
| 68 | tests/agent-v3/principal.test.ts | 8 | 0 | 0 |
| 69 | tests/agent-v3/propose.test.ts | 20 | 0 | 0 |
| 70 | tests/agent-v3/read.test.ts | 24 | 0 | 0 |
| 71 | tests/agent-v3/route.test.ts | 36 | 0 | 0 |
| 72 | tests/agent-v3/schemas.test.ts | 17 | 0 | 0 |
| 73 | tests/agent-v3/sdk.test.ts | 19 | 0 | 0 |
| 74 | tests/agent-v3/tenancy.test.ts | 28 | 0 | 0 |
| 75 | tests/alerts/alerts.test.ts | 13 | 0 | 0 |
| 76 | tests/alerts/delivery.test.ts | 44 | 0 | 0 |
| 77 | tests/alerts/migrate-alert-secrets.test.ts | 9 | 0 | 0 |
| 78 | tests/alerts/outbox.test.ts | 18 | 0 | 0 |
| 79 | tests/alerts/webhook-policy.test.ts | 57 | 0 | 0 |
| 80 | tests/analysis/analyze.test.ts | 61 | 0 | 0 |
| 81 | tests/analysis/detection.test.ts | 92 | 0 | 0 |
| 82 | tests/analysis/hostile.test.ts | 45 | 0 | 0 |
| 83 | tests/analysis/propose.test.ts | 60 | 0 | 0 |
| 84 | tests/analysis/scale.test.ts | 2 | 0 | 0 |
| 85 | tests/analysis/snapshot.test.ts | 36 | 0 | 0 |
| 86 | tests/analysis/units.test.ts | 56 | 0 | 0 |
| 87 | tests/api/account-delete.test.ts | 19 | 0 | 0 |
| 88 | tests/api/account-export.test.ts | 6 | 0 | 0 |
| 89 | tests/api/account-profile.test.ts | 6 | 0 | 0 |
| 90 | tests/api/account-sessions.test.ts | 3 | 0 | 0 |
| 91 | tests/api/actions-idempotency-commit.test.ts | 5 | 0 | 0 |
| 92 | tests/api/bootstrap-redaction.test.ts | 6 | 0 | 0 |
| 93 | tests/api/bootstrap.test.ts | 4 | 0 | 0 |
| 94 | tests/api/internal-cron.test.ts | 27 | 0 | 0 |
| 95 | tests/api/me.test.ts | 5 | 0 | 0 |
| 96 | tests/api/observe-isolation.test.ts | 19 | 0 | 0 |
| 97 | tests/api/postgres-request-boundary.test.ts | 4 | 0 | 0 |
| 98 | tests/api/project-stream.test.ts | 5 | 0 | 0 |
| 99 | tests/api/serverless-flush.test.ts | 3 | 0 | 0 |
| 100 | tests/api/slug-scoping.test.ts | 9 | 0 | 0 |
| 101 | tests/api/workspace-sharing.test.ts | 59 | 0 | 0 |
| 102 | tests/auth/callback.test.ts | 28 | 0 | 0 |
| 103 | tests/auth/destination.test.ts | 26 | 0 | 0 |
| 104 | tests/auth/hosted-membership.test.ts | 6 | 0 | 0 |
| 105 | tests/auth/identity-link-sdk.test.ts | 1 | 0 | 0 |
| 106 | tests/auth/identity-link.test.ts | 7 | 0 | 0 |
| 107 | tests/auth/membership.test.ts | 12 | 0 | 0 |
| 108 | tests/auth/middleware.test.ts | 13 | 0 | 0 |
| 109 | tests/auth/oauth-redirect.test.ts | 11 | 0 | 0 |
| 110 | tests/auth/oauth.test.ts | 13 | 0 | 0 |
| 111 | tests/auth/session-middleware.test.ts | 20 | 0 | 0 |
| 112 | tests/auth/signout-destination.test.ts | 6 | 0 | 0 |
| 113 | tests/auth/workspace-sharing.test.ts | 47 | 0 | 0 |
| 114 | tests/auth/workspace-stream-access.test.ts | 8 | 0 | 0 |
| 115 | tests/auth/workspaces.test.ts | 13 | 0 | 0 |
| 116 | tests/capabilities/action-bridge.test.ts | 16 | 0 | 0 |
| 117 | tests/capabilities/approvals.test.ts | 41 | 0 | 0 |
| 118 | tests/capabilities/autonomy.test.ts | 23 | 0 | 0 |
| 119 | tests/capabilities/broker.test.ts | 66 | 0 | 0 |
| 120 | tests/capabilities/destroy-propose.test.ts | 11 | 0 | 0 |
| 121 | tests/capabilities/destroy-review-mcp.test.ts | 6 | 0 | 0 |
| 122 | tests/capabilities/execution.test.ts | 64 | 0 | 0 |
| 123 | tests/capabilities/platform.test.ts | 15 | 0 | 0 |
| 124 | tests/capabilities/product-adapters.test.ts | 14 | 0 | 0 |
| 125 | tests/capabilities/routes.test.ts | 50 | 0 | 0 |
| 126 | tests/capabilities/store-contract.test.ts | 57 | 0 | 0 |
| 127 | tests/capabilities/tenancy.test.ts | 20 | 0 | 0 |
| 128 | tests/cli/bin.test.ts | 3 | 0 | 0 |
| 129 | tests/cli/commands.test.ts | 24 | 0 | 0 |
| 130 | tests/cli/config.test.ts | 15 | 0 | 1 |
| 131 | tests/cli/failures.test.ts | 68 | 0 | 0 |
| 132 | tests/cli/follow.test.ts | 10 | 0 | 0 |
| 133 | tests/ci/apply-platform-migrations.test.ts | 14 | 0 | 0 |
| 134 | tests/ci/assert-lane-report.test.ts | 92 | 0 | 0 |
| 135 | tests/ci/dependency-remediation.test.ts | 8 | 0 | 0 |
| 136 | tests/ci/evidence-sanitizer.test.ts | 105 | 0 | 0 |
| 137 | tests/ci/gate-manifest.test.ts | 56 | 0 | 0 |
| 138 | tests/ci/lane-report.test.ts | 23 | 0 | 0 |
| 139 | tests/ci/lockfile-integrity.test.ts | 18 | 0 | 0 |
| 140 | tests/ci/platform-coverage.test.ts | 25 | 0 | 0 |
| 141 | tests/ci/platform-schema-verifier.test.ts | 22 | 0 | 0 |
| 142 | tests/ci/postgres-lane-report.test.ts | 8 | 0 | 0 |
| 143 | tests/ci/release-gates.test.ts | 97 | 0 | 0 |
| 144 | tests/ci/security-audit.test.ts | 78 | 0 | 0 |
| 145 | tests/ci/security-exceptions.test.ts | 115 | 0 | 0 |
| 146 | tests/client/poll.test.ts | 6 | 0 | 0 |
| 147 | tests/client/stream-fallback.test.ts | 3 | 0 | 0 |
| 148 | tests/cost/pricing.test.ts | 18 | 0 | 0 |
| 149 | tests/controlplane/approvals.test.ts | 15 | 0 | 0 |
| 150 | tests/controlplane/execution-ledger.test.ts | 16 | 0 | 0 |
| 151 | tests/controlplane/executor.test.ts | 19 | 0 | 1 |
| 152 | tests/controlplane/grants.test.ts | 7 | 0 | 0 |
| 153 | tests/controlplane/lease-hang.test.ts | 1 | 0 | 0 |
| 154 | tests/controlplane/leases.test.ts | 13 | 0 | 0 |
| 155 | tests/controlplane/migrations.test.ts | 13 | 0 | 4 |
| 156 | tests/controlplane/open.test.ts | 14 | 0 | 2 |
| 157 | tests/controlplane/operations.test.ts | 29 | 0 | 0 |
| 158 | tests/controlplane/plan-artifacts.test.ts | 11 | 0 | 0 |
| 159 | tests/controlplane/read-jobs.test.ts | 16 | 0 | 0 |
| 160 | tests/controlplane/runners.test.ts | 26 | 0 | 0 |
| 161 | tests/controlplane/secrets.test.ts | 34 | 0 | 0 |
| 162 | tests/controlplane/services.test.ts | 19 | 0 | 0 |
| 163 | tests/controlplane/state.test.ts | 26 | 0 | 0 |
| 164 | tests/controlplane/tenancy.test.ts | 4 | 0 | 0 |
| 165 | tests/credentials/bootstrap-templates.test.ts | 76 | 0 | 0 |
| 166 | tests/credentials/broker-aws.test.ts | 59 | 0 | 0 |
| 167 | tests/credentials/error-names.test.ts | 13 | 0 | 0 |
| 168 | tests/credentials/grants.test.ts | 14 | 0 | 0 |
| 169 | tests/credentials/oidc.test.ts | 15 | 0 | 0 |
| 170 | tests/credentials/redact.test.ts | 14 | 0 | 0 |
| 171 | tests/credentials/session-policy.test.ts | 21 | 0 | 0 |
| 172 | tests/credentials/signing.test.ts | 24 | 0 | 0 |
| 173 | tests/credentials/workload-boundary.test.ts | 4 | 0 | 0 |
| 174 | tests/deploy/installation.test.ts | 62 | 0 | 0 |
| 175 | tests/db/async-repository.test.ts | 9 | 0 | 0 |
| 176 | tests/db/audit-batch.test.ts | 10 | 0 | 0 |
| 177 | tests/db/manifest-v2.test.ts | 3 | 0 | 0 |
| 178 | tests/db/manifests.test.ts | 10 | 0 | 0 |
| 179 | tests/db/pg-settings-guard.test.ts | 8 | 0 | 0 |
| 180 | tests/db/rsc-scope.test.ts | 13 | 0 | 0 |
| 181 | tests/db/snapshot-isolation.test.ts | 7 | 0 | 0 |
| 182 | tests/db/store-facade.test.ts | 4 | 0 | 0 |
| 183 | tests/db/store.test.ts | 10 | 0 | 0 |
| 184 | tests/docs/capability-matrix.test.ts | 29 | 0 | 0 |
| 185 | tests/docs/links.test.ts | 8 | 0 | 0 |
| 186 | tests/docs/operator-docs.test.ts | 58 | 0 | 0 |
| 187 | tests/docs/security-status.test.ts | 14 | 0 | 0 |
| 188 | tests/drift/compute.test.ts | 8 | 0 | 0 |
| 189 | tests/engine/environment-lease.test.ts | 7 | 0 | 0 |
| 190 | tests/engine/manifest-v2.test.ts | 1 | 0 | 0 |
| 191 | tests/engine/postgres-scheduler.test.ts | 10 | 0 | 0 |
| 192 | tests/engine/rollback-origin.test.ts | 14 | 0 | 0 |
| 193 | tests/engine/serverless-boot.test.ts | 4 | 0 | 0 |
| 194 | tests/engine/state-machine.test.ts | 3 | 0 | 0 |
| 195 | tests/engine/step-deadline.test.ts | 2 | 0 | 0 |
| 196 | tests/engine/tick-async.test.ts | 4 | 0 | 0 |
| 197 | tests/hosted-spike/cloudflare-preflight.test.ts | 84 | 0 | 0 |
| 198 | tests/hosted-spike/sqlite-feasibility.test.ts | 1 | 0 | 0 |
| 199 | tests/execution/apply.test.ts | 20 | 0 | 5 |
| 200 | tests/execution/aws-bootstrap-context.test.ts | 4 | 0 | 0 |
| 201 | tests/execution/capability-clouds.test.ts | 12 | 0 | 0 |
| 202 | tests/execution/capability.test.ts | 12 | 0 | 0 |
| 203 | tests/execution/compile-refs-providers.test.ts | 18 | 0 | 0 |
| 204 | tests/execution/compile-refs.test.ts | 50 | 0 | 0 |
| 205 | tests/execution/deletion-guards-clouds.test.ts | 18 | 0 | 0 |
| 206 | tests/execution/deletion-guards-real.test.ts | 0 | 0 | 1 |
| 207 | tests/execution/deletion-guards.test.ts | 27 | 0 | 0 |
| 208 | tests/execution/destroy-providers.test.ts | 18 | 0 | 0 |
| 209 | tests/execution/destroy-review-temporal.test.ts | 1 | 0 | 0 |
| 210 | tests/execution/destroy-review.test.ts | 19 | 0 | 2 |
| 211 | tests/execution/destroy.test.ts | 22 | 0 | 0 |
| 212 | tests/execution/ecs-replica-repair.test.ts | 57 | 0 | 0 |
| 213 | tests/execution/journey.test.ts | 3 | 0 | 0 |
| 214 | tests/execution/ledger-approval.test.ts | 5 | 0 | 0 |
| 215 | tests/execution/machines.test.ts | 14 | 0 | 0 |
| 216 | tests/execution/manifest-release.test.ts | 12 | 0 | 0 |
| 217 | tests/execution/plan.test.ts | 26 | 0 | 0 |
| 218 | tests/execution/platform.test.ts | 23 | 0 | 0 |
| 219 | tests/execution/policy-delete.test.ts | 12 | 0 | 0 |
| 220 | tests/execution/prober.test.ts | 80 | 0 | 0 |
| 221 | tests/execution/product-port.test.ts | 26 | 0 | 0 |
| 222 | tests/execution/release.test.ts | 29 | 0 | 0 |
| 223 | tests/execution/secrets-azure.test.ts | 6 | 0 | 0 |
| 224 | tests/execution/secrets-kubernetes.test.ts | 3 | 0 | 0 |
| 225 | tests/execution/secrets.test.ts | 16 | 0 | 0 |
| 226 | tests/execution/steps.test.ts | 20 | 0 | 0 |
| 227 | tests/execution/validate.test.ts | 13 | 0 | 0 |
| 228 | tests/execution/verify.test.ts | 29 | 0 | 0 |
| 229 | tests/hosted/config.test.ts | 17 | 0 | 0 |
| 230 | tests/hosted/edge.test.ts | 8 | 0 | 0 |
| 231 | tests/bridge/aws-readiness.test.ts | 3 | 0 | 0 |
| 232 | tests/bridge/connection-aws.test.ts | 40 | 0 | 0 |
| 233 | tests/bridge/deploy-bridge.test.ts | 45 | 0 | 0 |
| 234 | tests/bridge/deps.test.ts | 3 | 0 | 0 |
| 235 | tests/bridge/engine-workflow-owned.test.ts | 6 | 0 | 0 |
| 236 | tests/bridge/readiness.test.ts | 15 | 0 | 0 |
| 237 | tests/bridge/steps.test.ts | 2 | 0 | 1 |
| 238 | tests/bridge/teardown-session.test.ts | 10 | 0 | 0 |
| 239 | tests/importers/compose.test.ts | 8 | 0 | 0 |
| 240 | tests/importers/merge.test.ts | 6 | 0 | 0 |
| 241 | tests/logsim/health-history.test.ts | 6 | 0 | 0 |
| 242 | tests/incidents/acceptance.test.ts | 15 | 0 | 0 |
| 243 | tests/incidents/determinism.test.ts | 13 | 0 | 0 |
| 244 | tests/incidents/healthy.test.ts | 7 | 0 | 0 |
| 245 | tests/incidents/hostile.test.ts | 20 | 0 | 0 |
| 246 | tests/incidents/probes.test.ts | 8 | 0 | 0 |
| 247 | tests/incidents/remediation.test.ts | 15 | 0 | 0 |
| 248 | tests/incidents/rules.test.ts | 20 | 0 | 0 |
| 249 | tests/incidents/scenarios.test.ts | 33 | 0 | 0 |
| 250 | tests/incidents/signatures.test.ts | 67 | 0 | 0 |
| 251 | tests/incidents/traverse.test.ts | 16 | 0 | 0 |
| 252 | tests/incidents/units.test.ts | 20 | 0 | 0 |
| 253 | tests/incidents/unknowns.test.ts | 28 | 0 | 0 |
| 254 | tests/middleware/platform-bearer.test.ts | 66 | 0 | 0 |
| 255 | tests/navigator/executor.test.ts | 18 | 0 | 0 |
| 256 | tests/navigator/gimbal-state.test.ts | 25 | 0 | 0 |
| 257 | tests/navigator/llm.test.ts | 5 | 0 | 0 |
| 258 | tests/navigator/planner.test.ts | 5 | 0 | 0 |
| 259 | tests/navigator/planning.test.ts | 11 | 0 | 0 |
| 260 | tests/navigator/server-actions.test.ts | 39 | 0 | 0 |
| 261 | tests/navigator/verification.test.ts | 15 | 0 | 0 |
| 262 | tests/observability/aws-events.test.ts | 21 | 0 | 0 |
| 263 | tests/observability/cloudwatch-logs.test.ts | 38 | 0 | 0 |
| 264 | tests/observability/cloudwatch-metrics.test.ts | 32 | 0 | 0 |
| 265 | tests/observability/escape.test.ts | 61 | 0 | 0 |
| 266 | tests/observability/evidence.test.ts | 3 | 0 | 0 |
| 267 | tests/observability/fabric.test.ts | 34 | 0 | 0 |
| 268 | tests/observability/factory.test.ts | 10 | 0 | 0 |
| 269 | tests/observability/health.test.ts | 47 | 0 | 0 |
| 270 | tests/observability/kubernetes-wired.test.ts | 2 | 0 | 0 |
| 271 | tests/observability/kubernetes.test.ts | 30 | 0 | 0 |
| 272 | tests/observability/loki.test.ts | 31 | 0 | 0 |
| 273 | tests/observability/metadata-hosts.test.ts | 14 | 0 | 0 |
| 274 | tests/observability/oci-signals.test.ts | 71 | 0 | 0 |
| 275 | tests/observability/prometheus.test.ts | 29 | 0 | 0 |
| 276 | tests/observability/providers-wired.test.ts | 6 | 0 | 0 |
| 277 | tests/observability/query.test.ts | 22 | 0 | 0 |
| 278 | tests/observability/redact.test.ts | 28 | 0 | 0 |
| 279 | tests/observability/sandbox-logsim.test.ts | 4 | 0 | 0 |
| 280 | tests/observability/sandbox.test.ts | 13 | 0 | 0 |
| 281 | tests/placement/catalog.test.ts | 16 | 0 | 0 |
| 282 | tests/placement/components.test.ts | 7 | 0 | 0 |
| 283 | tests/placement/cost.test.ts | 34 | 0 | 0 |
| 284 | tests/placement/latency.test.ts | 9 | 0 | 0 |
| 285 | tests/placement/recommend-connections.test.ts | 2 | 0 | 0 |
| 286 | tests/placement/recommend-route.test.ts | 6 | 0 | 0 |
| 287 | tests/placement/recommend.test.ts | 15 | 0 | 0 |
| 288 | tests/placement/resource-graph-integration.test.ts | 2 | 0 | 0 |
| 289 | tests/placement/solver.test.ts | 48 | 0 | 0 |
| 290 | tests/platform-ui/freshness.test.ts | 4 | 0 | 0 |
| 291 | tests/platform-ui/reads-and-loaders.test.ts | 56 | 0 | 0 |
| 292 | tests/policy/bundle.test.ts | 8 | 0 | 0 |
| 293 | tests/policy/defaults.test.ts | 22 | 0 | 0 |
| 294 | tests/policy/delete.test.ts | 21 | 0 | 0 |
| 295 | tests/policy/engine.test.ts | 70 | 0 | 0 |
| 296 | tests/policy/parity.test.ts | 1 | 0 | 0 |
| 297 | tests/policy/plan-facts.test.ts | 44 | 0 | 0 |
| 298 | tests/policy/scenarios.test.ts | 72 | 0 | 0 |
| 299 | tests/platform/agent-ports.test.ts | 15 | 0 | 0 |
| 300 | tests/platform/composition.test.ts | 15 | 0 | 0 |
| 301 | tests/platform/credentials-verification.test.ts | 78 | 0 | 0 |
| 302 | tests/platform/deploy-e2e.test.ts | 18 | 0 | 0 |
| 303 | tests/platform/ecs-replica-repair-grants.test.ts | 7 | 0 | 0 |
| 304 | tests/platform/housekeeping.test.ts | 14 | 0 | 0 |
| 305 | tests/platform/machine-composition.test.ts | 6 | 0 | 0 |
| 306 | tests/platform/oci-sessions.test.ts | 31 | 0 | 0 |
| 307 | tests/platform/plan-approval-routes.test.ts | 9 | 0 | 0 |
| 308 | tests/platform/plan-approval.test.ts | 19 | 0 | 0 |
| 309 | tests/platform/release-multi.test.ts | 5 | 0 | 0 |
| 310 | tests/platform/release.test.ts | 8 | 0 | 0 |
| 311 | tests/platform/secret-grants.test.ts | 14 | 0 | 0 |
| 312 | tests/platform/source-bundle-azure.test.ts | 10 | 0 | 0 |
| 313 | tests/platform/source-bundle-composition.test.ts | 8 | 0 | 0 |
| 314 | tests/platform/source-bundle-github.test.ts | 4 | 0 | 0 |
| 315 | tests/platform/source-bundle.test.ts | 77 | 0 | 1 |
| 316 | tests/providers/localstack-observe.test.ts | 11 | 0 | 0 |
| 317 | tests/providers/localstack-teardown.test.ts | 19 | 0 | 0 |
| 318 | tests/providers/observe.test.ts | 9 | 0 | 0 |
| 319 | tests/providers/terraform-injection.test.ts | 30 | 0 | 0 |
| 320 | tests/providers/terraform-labels.test.ts | 6 | 0 | 0 |
| 321 | tests/providers/terraform-lb-names.test.ts | 14 | 0 | 0 |
| 322 | tests/providers/terraform.test.ts | 34 | 0 | 0 |
| 323 | tests/machines/args.test.ts | 137 | 0 | 0 |
| 324 | tests/machines/azure-run-command.test.ts | 53 | 0 | 0 |
| 325 | tests/machines/azure-scripts.test.ts | 0 | 0 | 6 |
| 326 | tests/machines/dispatcher.test.ts | 5 | 0 | 0 |
| 327 | tests/machines/gcp-os-management.test.ts | 38 | 0 | 0 |
| 328 | tests/machines/go-results.test.ts | 19 | 0 | 0 |
| 329 | tests/machines/kubernetes-server.test.ts | 11 | 0 | 0 |
| 330 | tests/machines/kubernetes.test.ts | 50 | 0 | 0 |
| 331 | tests/machines/persistence.test.ts | 14 | 0 | 0 |
| 332 | tests/machines/service.test.ts | 41 | 0 | 0 |
| 333 | tests/machines/sessions.test.ts | 12 | 0 | 0 |
| 334 | tests/machines/ssm-documents.test.ts | 83 | 0 | 13 |
| 335 | tests/machines/ssm-parse.test.ts | 19 | 0 | 0 |
| 336 | tests/machines/ssm-transport.test.ts | 60 | 0 | 0 |
| 337 | tests/machines/zenithd.test.ts | 39 | 0 | 0 |
| 338 | tests/reconcile/activity.test.ts | 9 | 0 | 0 |
| 339 | tests/reconcile/boundary.test.ts | 7 | 0 | 0 |
| 340 | tests/reconcile/core.test.ts | 40 | 0 | 0 |
| 341 | tests/reconcile/desired-value-boundary.test.ts | 4 | 0 | 0 |
| 342 | tests/reconcile/dispatch.test.ts | 6 | 0 | 0 |
| 343 | tests/reconcile/observe.test.ts | 2 | 0 | 0 |
| 344 | tests/reconcile/pass.test.ts | 20 | 0 | 0 |
| 345 | tests/reconcile/platform.test.ts | 58 | 0 | 0 |
| 346 | tests/reconcile/repair.test.ts | 38 | 0 | 0 |
| 347 | tests/reconcile/route.test.ts | 8 | 0 | 0 |
| 348 | tests/reconcile/scheduler.test.ts | 18 | 0 | 0 |
| 349 | tests/reconcile/support.test.ts | 13 | 0 | 0 |
| 350 | tests/resources/aws-expansion.test.ts | 280 | 0 | 0 |
| 351 | tests/resources/drift.test.ts | 32 | 0 | 0 |
| 352 | tests/resources/expand.test.ts | 72 | 0 | 0 |
| 353 | tests/resources/kubernetes-namespace.test.ts | 8 | 0 | 0 |
| 354 | tests/resources/manifest-v2.test.ts | 21 | 0 | 0 |
| 355 | tests/resources/native-types.test.ts | 8 | 0 | 0 |
| 356 | tests/resources/purity.test.ts | 6 | 0 | 0 |
| 357 | tests/resources/spec-conformance.test.ts | 8 | 0 | 0 |
| 358 | tests/resources/upgrade.test.ts | 13 | 0 | 0 |
| 359 | tests/runners/admin-routes.test.ts | 13 | 0 | 0 |
| 360 | tests/runners/aws-transport.test.ts | 19 | 0 | 0 |
| 361 | tests/runners/dispatch.test.ts | 25 | 0 | 0 |
| 362 | tests/runners/e2e-platform-store.test.ts | 8 | 0 | 0 |
| 363 | tests/runners/isolation.test.ts | 12 | 0 | 0 |
| 364 | tests/runners/oci-contract.test.ts | 4 | 0 | 0 |
| 365 | tests/runners/oci-payload.test.ts | 46 | 0 | 0 |
| 366 | tests/runners/paths.test.ts | 3 | 0 | 0 |
| 367 | tests/runners/poll.test.ts | 16 | 0 | 0 |
| 368 | tests/runners/read-jobs.test.ts | 40 | 0 | 0 |
| 369 | tests/runners/registration.test.ts | 14 | 0 | 0 |
| 370 | tests/runners/request-auth.test.ts | 18 | 0 | 0 |
| 371 | tests/runners/results.test.ts | 22 | 0 | 0 |
| 372 | tests/runners/runtime.test.ts | 5 | 0 | 0 |
| 373 | tests/runners/signing.test.ts | 14 | 0 | 0 |
| 374 | tests/runners/store-contract.test.ts | 44 | 0 | 0 |
| 375 | tests/runners/tofu-dispatch.test.ts | 18 | 0 | 0 |
| 376 | tests/scripts/migrate-hosted-to-postgres.test.ts | 12 | 0 | 3 |
| 377 | tests/scripts/migrate.test.ts | 5 | 0 | 0 |
| 378 | tests/scripts/runtime-admission.test.ts | 26 | 0 | 0 |
| 379 | tests/secrets/namespacing.test.ts | 14 | 0 | 0 |
| 380 | tests/secrets/resolver.test.ts | 15 | 0 | 0 |
| 381 | tests/secrets/rewrap.test.ts | 56 | 0 | 1 |
| 382 | tests/secrets/secret-writer-bootstrap.test.ts | 3 | 0 | 0 |
| 383 | tests/secrets/store.test.ts | 19 | 0 | 0 |
| 384 | tests/security/agent-credentials.test.ts | 12 | 0 | 0 |
| 385 | tests/security/audit-secret-leakage.test.ts | 5 | 0 | 0 |
| 386 | tests/security/controlplane-sql-scoping.test.ts | 5 | 0 | 0 |
| 387 | tests/security/credential-boundaries.test.ts | 7 | 0 | 0 |
| 388 | tests/security/digest-canonical.test.ts | 22 | 0 | 0 |
| 389 | tests/security/driver-inert.test.ts | 7 | 0 | 0 |
| 390 | tests/security/image-pins.test.ts | 31 | 0 | 0 |
| 391 | tests/security/mcp-secret-leakage.test.ts | 4 | 0 | 0 |
| 392 | tests/security/mcp-v1-tenant-isolation.test.ts | 16 | 0 | 0 |
| 393 | tests/security/mcp-v2-tenant-isolation.test.ts | 20 | 0 | 0 |
| 394 | tests/security/plan-artifact-secrecy.test.ts | 0 | 0 | 1 |
| 395 | tests/security/policy-invariants.test.ts | 31 | 0 | 0 |
| 396 | tests/security/reconcile-value-boundaries.test.ts | 4 | 0 | 0 |
| 397 | tests/security/redaction-coverage.test.ts | 9 | 0 | 0 |
| 398 | tests/security/request-error-logging.test.ts | 2 | 0 | 0 |
| 399 | tests/security/runtime-sanity.test.ts | 4 | 0 | 0 |
| 400 | tests/security/signal-boundaries.test.ts | 6 | 0 | 0 |
| 401 | tests/security/ssrf-address-oracle.test.ts | 5 | 0 | 0 |
| 402 | tests/security/store-value-boundaries.test.ts | 1 | 0 | 0 |
| 403 | tests/security/support.test.ts | 27 | 0 | 0 |
| 404 | tests/security/tofu-runner-env.test.ts | 7 | 0 | 0 |
| 405 | tests/security/tofu-secrets.test.ts | 14 | 0 | 0 |
| 406 | tests/security/tofu-workspace-injection.test.ts | 34 | 0 | 0 |
| 407 | tests/security/workflow-history.test.ts | 8 | 0 | 2 |
| 408 | tests/server/appwire-admission.test.ts | 26 | 0 | 0 |
| 409 | tests/server/appwire-errors.test.ts | 9 | 0 | 0 |
| 410 | tests/server/appwire-policy-bundle.test.ts | 7 | 0 | 0 |
| 411 | tests/server/cron-housekeeping.test.ts | 6 | 0 | 0 |
| 412 | tests/sources/github-app.test.ts | 20 | 0 | 0 |
| 413 | tests/sources/github-callback.test.ts | 21 | 0 | 0 |
| 414 | tests/sources/github-live.test.ts | 0 | 0 | 1 |
| 415 | tests/sources/github-migrations.test.ts | 6 | 0 | 0 |
| 416 | tests/sources/github-runtime.test.ts | 5 | 0 | 0 |
| 417 | tests/sources/github-store.test.ts | 10 | 0 | 10 |
| 418 | tests/spatial/rehearsal-model.test.ts | 5 | 0 | 0 |
| 419 | tests/shell/activity-target.test.ts | 10 | 0 | 0 |
| 420 | tests/tofu/backends.test.ts | 23 | 0 | 0 |
| 421 | tests/tofu/destroy-real.test.ts | 2 | 0 | 0 |
| 422 | tests/tofu/destroy-runner.test.ts | 4 | 0 | 0 |
| 423 | tests/tofu/destroy.test.ts | 65 | 0 | 0 |
| 424 | tests/tofu/driver-expressions.test.ts | 1 | 0 | 0 |
| 425 | tests/tofu/ephemeral-network.test.ts | 5 | 0 | 0 |
| 426 | tests/tofu/ephemeral.test.ts | 44 | 0 | 0 |
| 427 | tests/tofu/hcl-template-real.test.ts | 2 | 0 | 0 |
| 428 | tests/tofu/hcl-template.test.ts | 141 | 0 | 0 |
| 429 | tests/tofu/network.test.ts | 4 | 0 | 0 |
| 430 | tests/tofu/plan-artifact-handoff.test.ts | 0 | 0 | 8 |
| 431 | tests/tofu/plan-lock.test.ts | 1 | 0 | 0 |
| 432 | tests/tofu/plan-view-sensitive.test.ts | 1 | 0 | 0 |
| 433 | tests/tofu/plan.test.ts | 36 | 0 | 0 |
| 434 | tests/tofu/process.test.ts | 18 | 0 | 0 |
| 435 | tests/tofu/providers.test.ts | 8 | 0 | 0 |
| 436 | tests/tofu/runner.test.ts | 19 | 0 | 0 |
| 437 | tests/tofu/security-hardening.test.ts | 20 | 0 | 0 |
| 438 | tests/tofu/workspace-expressions.test.ts | 50 | 0 | 0 |
| 439 | tests/tofu/workspace.test.ts | 29 | 0 | 0 |
| 440 | tests/ui/foreign-tokens.test.ts | 2 | 0 | 0 |
| 441 | tests/ui/log-search.test.ts | 5 | 0 | 0 |
| 442 | tests/ui/theme-contrast.test.ts | 4 | 0 | 0 |
| 443 | tests/screens/activity-rows.test.ts | 13 | 0 | 0 |
| 444 | tests/screens/auth-messages.test.ts | 10 | 0 | 0 |
| 445 | tests/screens/deploy-helpers.test.ts | 17 | 0 | 0 |
| 446 | tests/screens/deploy-history-window.test.ts | 2 | 0 | 0 |
| 447 | tests/screens/deployment-state.test.ts | 4 | 0 | 0 |
| 448 | tests/screens/editor-helpers.test.ts | 13 | 0 | 0 |
| 449 | tests/screens/inspector-logic.test.ts | 19 | 0 | 0 |
| 450 | tests/screens/landing-metadata.test.ts | 5 | 0 | 0 |
| 451 | tests/screens/landing-scenario.test.ts | 9 | 0 | 0 |
| 452 | tests/screens/landing-state.test.ts | 6 | 0 | 0 |
| 453 | tests/screens/local-starter.test.ts | 2 | 0 | 0 |
| 454 | tests/screens/map-graph-model.test.ts | 4 | 0 | 0 |
| 455 | tests/screens/map-layout.test.ts | 4 | 0 | 0 |
| 456 | tests/screens/map-viewport.test.ts | 4 | 0 | 0 |
| 457 | tests/screens/observe-log-selection.test.ts | 3 | 0 | 0 |
| 458 | tests/screens/onboarding-progress.test.ts | 9 | 0 | 0 |
| 459 | tests/screens/overview-page.test.ts | 9 | 0 | 0 |
| 460 | tests/screens/overview-rows.test.ts | 13 | 0 | 0 |
| 461 | tests/screens/revision-direction.test.ts | 1 | 0 | 0 |
| 462 | tests/screens/sample-compose.test.ts | 2 | 0 | 0 |
| 463 | tests/screens/security-finding-shape.test.ts | 4 | 0 | 0 |
| 464 | tests/screens/security-rows.test.ts | 12 | 0 | 0 |
| 465 | tests/workers/health.test.ts | 11 | 0 | 0 |
| 466 | tests/workers/plan-artifact-startup.test.ts | 4 | 0 | 0 |
| 467 | tests/workers/plan-janitor.test.ts | 14 | 0 | 0 |
| 468 | tests/workers/worker-health-wiring.test.ts | 6 | 0 | 0 |
| 469 | tests/waitlist/access.test.ts | 43 | 0 | 0 |
| 470 | tests/waitlist/admin-api.test.ts | 118 | 0 | 0 |
| 471 | tests/waitlist/admin-file.test.ts | 44 | 0 | 0 |
| 472 | tests/waitlist/admin-postgres.test.ts | 47 | 0 | 0 |
| 473 | tests/waitlist/api.test.ts | 67 | 0 | 0 |
| 474 | tests/waitlist/enforcement.test.ts | 9 | 0 | 0 |
| 475 | tests/waitlist/file-repository.test.ts | 44 | 0 | 0 |
| 476 | tests/waitlist/pg-contract.test.ts | 0 | 0 | 38 |
| 477 | tests/workflows/approval-time.test.ts | 3 | 0 | 0 |
| 478 | tests/workflows/caller-payloads.test.ts | 6 | 0 | 0 |
| 479 | tests/workflows/client.test.ts | 16 | 0 | 0 |
| 480 | tests/workflows/codec-replay.test.ts | 0 | 0 | 2 |
| 481 | tests/workflows/codec-wiring.test.ts | 27 | 0 | 0 |
| 482 | tests/workflows/codec.test.ts | 45 | 0 | 0 |
| 483 | tests/workflows/config.test.ts | 28 | 0 | 0 |
| 484 | tests/workflows/deploy.test.ts | 38 | 0 | 0 |
| 485 | tests/workflows/destroy-replay.test.ts | 0 | 0 | 6 |
| 486 | tests/workflows/destroy.test.ts | 11 | 0 | 0 |
| 487 | tests/workflows/ecs-replica-repair.test.ts | 11 | 0 | 0 |
| 488 | tests/workflows/failures.test.ts | 42 | 0 | 0 |
| 489 | tests/workflows/mtls-config.test.ts | 29 | 0 | 0 |
| 490 | tests/workflows/mtls-live.test.ts | 0 | 0 | 2 |
| 491 | tests/workflows/operations.test.ts | 28 | 0 | 0 |
| 492 | tests/workflows/payload-boundary.test.ts | 52 | 0 | 0 |
| 493 | tests/workflows/reconcile.test.ts | 2 | 0 | 0 |
| 494 | tests/workflows/replay.test.ts | 7 | 0 | 0 |
| 495 | tests/workflows/sandbox.test.ts | 52 | 0 | 0 |
| 496 | tests/workflows/worker.test.ts | 16 | 0 | 0 |
| 497 | tests/credentials/aws/bootstrap-context.test.ts | 57 | 0 | 0 |
| 498 | tests/db/contract/alerts.test.ts | 0 | 0 | 7 |
| 499 | tests/db/contract/audit.test.ts | 7 | 0 | 1 |
| 500 | tests/db/contract/history.test.ts | 7 | 0 | 7 |
| 501 | tests/db/contract/secrets.test.ts | 9 | 0 | 0 |
| 502 | tests/db/contract/store-contract.test.ts | 13 | 0 | 0 |
| 503 | tests/db/contract/workspace-sharing.test.ts | 0 | 0 | 22 |
| 504 | tests/hosted/acceptance/gate-01-source-to-app.test.ts | 13 | 0 | 0 |
| 505 | tests/hosted/acceptance/gate-02-second-identity.test.ts | 8 | 0 | 0 |
| 506 | tests/hosted/acceptance/gate-03-denial-matrix.test.ts | 14 | 0 | 0 |
| 507 | tests/hosted/acceptance/gate-04-broker-roles.test.ts | 8 | 0 | 0 |
| 508 | tests/hosted/acceptance/gate-05-boundaries.test.ts | 13 | 0 | 0 |
| 509 | tests/hosted/acceptance/gate-06-quotas-and-limits.test.ts | 8 | 0 | 0 |
| 510 | tests/hosted/acceptance/gate-07-durability.test.ts | 6 | 0 | 0 |
| 511 | tests/hosted/acceptance/gate-08-compatible-update.test.ts | 6 | 0 | 0 |
| 512 | tests/hosted/acceptance/gate-09-failed-candidate.test.ts | 7 | 0 | 0 |
| 513 | tests/hosted/acceptance/gate-10-restore.test.ts | 8 | 0 | 0 |
| 514 | tests/hosted/acceptance/gate-11-health-and-logs.test.ts | 8 | 0 | 0 |
| 515 | tests/hosted/acceptance/gate-12-browser-flow.test.ts | 11 | 0 | 0 |
| 516 | tests/hosted/artifacts/storage-store.test.ts | 10 | 0 | 2 |
| 517 | tests/hosted/artifacts/store.test.ts | 29 | 0 | 0 |
| 518 | tests/hosted/access/delivery.test.ts | 7 | 0 | 0 |
| 519 | tests/hosted/access/grants.test.ts | 18 | 0 | 0 |
| 520 | tests/hosted/access/invites-expiry.test.ts | 8 | 0 | 0 |
| 521 | tests/hosted/access/invites.test.ts | 10 | 0 | 0 |
| 522 | tests/hosted/access/routes.test.ts | 14 | 0 | 0 |
| 523 | tests/hosted/access/sessions.test.ts | 19 | 0 | 0 |
| 524 | tests/hosted/backup/create-restore.test.ts | 7 | 0 | 0 |
| 525 | tests/hosted/backup/reconcile.test.ts | 4 | 0 | 0 |
| 526 | tests/hosted/backup/reopen.test.ts | 6 | 0 | 0 |
| 527 | tests/hosted/backup/targets.test.ts | 14 | 0 | 0 |
| 528 | tests/hosted/build/docker-reap.test.ts | 12 | 0 | 0 |
| 529 | tests/hosted/build/pipeline.test.ts | 2 | 0 | 0 |
| 530 | tests/hosted/build/recipe-image.test.ts | 7 | 0 | 0 |
| 531 | tests/hosted/build/recipe-local.test.ts | 26 | 0 | 0 |
| 532 | tests/hosted/build/runners-isolated.test.ts | 38 | 0 | 0 |
| 533 | tests/hosted/authority/access.test.ts | 15 | 0 | 0 |
| 534 | tests/hosted/authority/backup.test.ts | 3 | 0 | 0 |
| 535 | tests/hosted/authority/busy.test.ts | 2 | 0 | 0 |
| 536 | tests/hosted/authority/events.test.ts | 9 | 0 | 0 |
| 537 | tests/hosted/authority/jobs.test.ts | 11 | 0 | 0 |
| 538 | tests/hosted/authority/open.test.ts | 8 | 0 | 0 |
| 539 | tests/hosted/authority/outbox-fence.test.ts | 2 | 0 | 0 |
| 540 | tests/hosted/authority/outbox.test.ts | 6 | 0 | 0 |
| 541 | tests/hosted/authority/pg-schema-check.test.ts | 9 | 0 | 0 |
| 542 | tests/hosted/authority/pg-tx.test.ts | 15 | 0 | 0 |
| 543 | tests/hosted/authority/tx.test.ts | 10 | 0 | 0 |
| 544 | tests/hosted/export/roundtrip.test.ts | 9 | 0 | 0 |
| 545 | tests/hosted/events/record.test.ts | 10 | 0 | 0 |
| 546 | tests/hosted/events/scorecard.test.ts | 11 | 0 | 0 |
| 547 | tests/hosted/gateway/admission.test.ts | 16 | 0 | 0 |
| 548 | tests/hosted/gateway/artifacts.test.ts | 15 | 0 | 0 |
| 549 | tests/hosted/gateway/broker.test.ts | 18 | 0 | 0 |
| 550 | tests/hosted/gateway/guard.test.ts | 16 | 0 | 0 |
| 551 | tests/hosted/gateway/journey.test.ts | 7 | 0 | 0 |
| 552 | tests/hosted/gateway/policy.test.ts | 16 | 0 | 0 |
| 553 | tests/hosted/gateway/reserved.test.ts | 13 | 0 | 0 |
| 554 | tests/hosted/gateway/session.test.ts | 9 | 0 | 0 |
| 555 | tests/hosted/data/conflict.test.ts | 5 | 0 | 0 |
| 556 | tests/hosted/data/d1-backend.test.ts | 13 | 0 | 0 |
| 557 | tests/hosted/data/idempotency.test.ts | 10 | 0 | 0 |
| 558 | tests/hosted/data/isolation.test.ts | 15 | 0 | 0 |
| 559 | tests/hosted/data/ops-parity.test.ts | 7 | 0 | 0 |
| 560 | tests/hosted/data/pg-backend.test.ts | 21 | 0 | 0 |
| 561 | tests/hosted/data/pg-contract.live.test.ts | 0 | 0 | 11 |
| 562 | tests/hosted/data/quota.test.ts | 9 | 0 | 0 |
| 563 | tests/hosted/data/schema.test.ts | 17 | 0 | 0 |
| 564 | tests/hosted/data/store.test.ts | 39 | 0 | 0 |
| 565 | tests/hosted/health/health.test.ts | 7 | 0 | 0 |
| 566 | tests/hosted/quota/body.test.ts | 12 | 0 | 0 |
| 567 | tests/hosted/quota/counters.test.ts | 9 | 0 | 0 |
| 568 | tests/hosted/release/activation.test.ts | 4 | 0 | 0 |
| 569 | tests/hosted/release/admission.test.ts | 10 | 0 | 0 |
| 570 | tests/hosted/release/apps.test.ts | 7 | 0 | 0 |
| 571 | tests/hosted/release/publish-real.test.ts | 4 | 0 | 0 |
| 572 | tests/hosted/release/resume.test.ts | 1 | 0 | 0 |
| 573 | tests/hosted/release/rollback.test.ts | 4 | 0 | 0 |
| 574 | tests/hosted/release/routes.test.ts | 13 | 0 | 0 |
| 575 | tests/hosted/release/runner.test.ts | 6 | 0 | 0 |
| 576 | tests/hosted/release/single-flight.test.ts | 3 | 0 | 0 |
| 577 | tests/hosted/release/suspend.test.ts | 4 | 0 | 0 |
| 578 | tests/hosted/source/validate.test.ts | 52 | 0 | 0 |
| 579 | tests/hosted/usage/outbox-handlers.test.ts | 5 | 0 | 0 |
| 580 | tests/hosted/usage/spending.test.ts | 10 | 0 | 0 |
| 581 | tests/hosted/tracker-app/api.test.ts | 16 | 0 | 0 |
| 582 | tests/hosted/tracker-app/build.test.ts | 5 | 0 | 0 |
| 583 | tests/hosted/tracker-app/contract.test.ts | 8 | 0 | 0 |
| 584 | tests/hosted/runtime/cloudflare.test.ts | 22 | 0 | 0 |
| 585 | tests/hosted/runtime/local.test.ts | 19 | 0 | 0 |
| 586 | tests/hosted/runtime/workers.test.ts | 19 | 0 | 0 |
| 587 | tests/providers/aws/secret-writer.test.ts | 19 | 0 | 0 |
| 588 | tests/providers/azure/arm.test.ts | 12 | 0 | 0 |
| 589 | tests/providers/azure/build-digest.test.ts | 23 | 0 | 0 |
| 590 | tests/providers/azure/compile-drivers.test.ts | 26 | 0 | 0 |
| 591 | tests/providers/azure/compile.test.ts | 14 | 0 | 0 |
| 592 | tests/providers/azure/credentials.test.ts | 60 | 0 | 0 |
| 593 | tests/providers/azure/deploy.test.ts | 9 | 0 | 0 |
| 594 | tests/providers/azure/dns-ownership.test.ts | 27 | 0 | 0 |
| 595 | tests/providers/azure/helpers.test.ts | 14 | 0 | 0 |
| 596 | tests/providers/azure/more-compile.test.ts | 68 | 0 | 0 |
| 597 | tests/providers/azure/more-observe.test.ts | 70 | 0 | 0 |
| 598 | tests/providers/azure/mysql.test.ts | 23 | 0 | 0 |
| 599 | tests/providers/azure/observability.test.ts | 11 | 0 | 0 |
| 600 | tests/providers/azure/observe.test.ts | 58 | 0 | 0 |
| 601 | tests/providers/azure/operations.test.ts | 15 | 0 | 0 |
| 602 | tests/providers/azure/registry.test.ts | 3 | 0 | 0 |
| 603 | tests/providers/azure/release-journal.test.ts | 10 | 0 | 0 |
| 604 | tests/providers/azure/release.test.ts | 37 | 0 | 0 |
| 605 | tests/providers/azure/source-binding.test.ts | 7 | 0 | 0 |
| 606 | tests/providers/azure/source-storage.test.ts | 36 | 0 | 0 |
| 607 | tests/providers/azure/static-checks.test.ts | 21 | 0 | 0 |
| 608 | tests/providers/azure/validate.test.ts | 6 | 0 | 0 |
| 609 | tests/providers/kubernetes/apply.test.ts | 30 | 0 | 0 |
| 610 | tests/providers/kubernetes/drivers.test.ts | 41 | 0 | 0 |
| 611 | tests/providers/kubernetes/fields.test.ts | 9 | 0 | 0 |
| 612 | tests/providers/kubernetes/identity-apply.test.ts | 30 | 0 | 0 |
| 613 | tests/providers/kubernetes/identity-render.test.ts | 42 | 0 | 0 |
| 614 | tests/providers/kubernetes/kind.test.ts | 0 | 0 | 6 |
| 615 | tests/providers/kubernetes/naming-util.test.ts | 16 | 0 | 0 |
| 616 | tests/providers/kubernetes/ops.test.ts | 37 | 0 | 0 |
| 617 | tests/providers/kubernetes/prune.test.ts | 14 | 0 | 0 |
| 618 | tests/providers/kubernetes/release-kind.test.ts | 0 | 0 | 1 |
| 619 | tests/providers/kubernetes/release.test.ts | 33 | 0 | 0 |
| 620 | tests/providers/kubernetes/render.test.ts | 44 | 0 | 0 |
| 621 | tests/providers/kubernetes/rollout.test.ts | 22 | 0 | 0 |
| 622 | tests/providers/kubernetes/session.test.ts | 25 | 0 | 0 |
| 623 | tests/providers/kubernetes/teardown.test.ts | 43 | 0 | 0 |
| 624 | tests/providers/oci/allowlist-observability.test.ts | 12 | 0 | 0 |
| 625 | tests/providers/oci/allowlist.test.ts | 21 | 0 | 0 |
| 626 | tests/providers/oci/compile.test.ts | 60 | 0 | 0 |
| 627 | tests/providers/oci/discover.test.ts | 7 | 0 | 0 |
| 628 | tests/providers/oci/dns-ownership.test.ts | 33 | 0 | 0 |
| 629 | tests/providers/oci/failure-modes.test.ts | 208 | 0 | 0 |
| 630 | tests/providers/oci/more.test.ts | 72 | 0 | 0 |
| 631 | tests/providers/oci/mysql.test.ts | 9 | 0 | 0 |
| 632 | tests/providers/oci/naming-evidence.test.ts | 14 | 0 | 0 |
| 633 | tests/providers/oci/operations.test.ts | 19 | 0 | 0 |
| 634 | tests/providers/oci/release.test.ts | 60 | 0 | 0 |
| 635 | tests/providers/oci/static-checks.test.ts | 36 | 0 | 0 |
| 636 | tests/providers/oci/transport.test.ts | 69 | 0 | 0 |
| 637 | tests/providers/oci/validate.test.ts | 6 | 0 | 0 |
| 638 | tests/providers/oci/world.test.ts | 6 | 0 | 0 |
| 639 | tests/providers/zenith/apply.test.ts | 21 | 0 | 0 |
| 640 | tests/providers/zenith/deploy.test.ts | 14 | 0 | 0 |
| 641 | tests/providers/zenith/drivers.test.ts | 67 | 0 | 0 |
| 642 | tests/providers/zenith/export.test.ts | 19 | 0 | 0 |
| 643 | tests/providers/zenith/identity-wiring.test.ts | 18 | 0 | 0 |
| 644 | tests/providers/zenith/isolation.test.ts | 52 | 0 | 0 |
| 645 | tests/providers/zenith/k8s-contract.test.ts | 19 | 0 | 0 |
| 646 | tests/providers/zenith/neon.test.ts | 53 | 0 | 0 |
| 647 | tests/providers/zenith/render.test.ts | 53 | 0 | 0 |
| 648 | tests/providers/zenith/substrate.test.ts | 48 | 0 | 0 |
| 649 | tests/providers/zenith/teardown-neon.test.ts | 13 | 0 | 0 |
| 650 | tests/providers/zenith/teardown.test.ts | 41 | 0 | 0 |
| 651 | tests/providers/zenith/tenancy.test.ts | 30 | 0 | 0 |
| 652 | tests/providers/zenith/tls-api.test.ts | 10 | 0 | 0 |
| 653 | tests/providers/zenith/tls.test.ts | 22 | 0 | 0 |
| 654 | tests/providers/zenith/vault-runtime.test.ts | 12 | 0 | 0 |
| 655 | tests/providers/gcp/bootstrap.test.ts | 14 | 0 | 0 |
| 656 | tests/providers/gcp/build-gcp.test.ts | 21 | 0 | 0 |
| 657 | tests/providers/gcp/compile.test.ts | 64 | 0 | 0 |
| 658 | tests/providers/gcp/credentials.test.ts | 41 | 0 | 0 |
| 659 | tests/providers/gcp/data-network.test.ts | 18 | 0 | 0 |
| 660 | tests/providers/gcp/dns-ownership.test.ts | 24 | 0 | 0 |
| 661 | tests/providers/gcp/firewall-network.test.ts | 10 | 0 | 0 |
| 662 | tests/providers/gcp/iam-read-credentials.test.ts | 10 | 0 | 0 |
| 663 | tests/providers/gcp/naming.test.ts | 16 | 0 | 0 |
| 664 | tests/providers/gcp/observability.test.ts | 18 | 0 | 0 |
| 665 | tests/providers/gcp/operations.test.ts | 30 | 0 | 0 |
| 666 | tests/providers/gcp/read.test.ts | 306 | 0 | 0 |
| 667 | tests/providers/gcp/release.test.ts | 40 | 0 | 0 |
| 668 | tests/providers/gcp/runtime.test.ts | 21 | 0 | 0 |
| 669 | tests/providers/gcp/secret-writer.test.ts | 7 | 0 | 0 |
| 670 | tests/providers/gcp/tofu-validate.test.ts | 6 | 0 | 0 |
| 671 | tests/screens/platform/approval-eligibility.test.ts | 41 | 0 | 0 |
| 672 | tests/screens/platform/aws-connection-validation.test.ts | 51 | 0 | 0 |
| 673 | tests/screens/platform/client-safety.test.ts | 77 | 0 | 0 |
| 674 | tests/screens/platform/event-sentences.test.ts | 52 | 0 | 0 |
| 675 | tests/screens/platform/investigation-model.test.ts | 6 | 0 | 0 |
| 676 | tests/screens/platform/plan-values.test.ts | 11 | 0 | 0 |
| 677 | tests/screens/platform/policy-language.test.ts | 8 | 0 | 0 |
| 678 | tests/screens/platform/price-evidence.test.ts | 11 | 0 | 0 |
| 679 | tests/screens/platform/resource-state-model.test.ts | 25 | 0 | 0 |
| 680 | tests/screens/platform/text-helpers.test.ts | 29 | 0 | 0 |
| 681 | tests/hosted/authority/contract/access.test.ts | 17 | 0 | 0 |
| 682 | tests/hosted/authority/contract/contract.test.ts | 26 | 0 | 0 |
| 683 | tests/hosted/authority/contract/ledgers.test.ts | 12 | 0 | 0 |
| 684 | tests/hosted/authority/contract/release.test.ts | 18 | 0 | 0 |
| 685 | tests/providers/aws/identity/trust.test.ts | 14 | 0 | 0 |
| 686 | tests/providers/aws/drivers/contract.test.ts | 53 | 0 | 0 |
| 687 | tests/providers/aws/drivers/e2e-compile.test.ts | 8 | 0 | 0 |
| 688 | tests/providers/azure/identity/trust.test.ts | 5 | 0 | 0 |
| 689 | tests/providers/gcp/identity/trust.test.ts | 10 | 0 | 0 |
| 690 | tests/providers/aws/drivers/compute/assemble.test.ts | 7 | 0 | 0 |
| 691 | tests/providers/aws/drivers/compute/codebuild.test.ts | 81 | 0 | 0 |
| 692 | tests/providers/aws/drivers/compute/ecr.test.ts | 19 | 0 | 0 |
| 693 | tests/providers/aws/drivers/compute/ecs-compile.test.ts | 51 | 0 | 0 |
| 694 | tests/providers/aws/drivers/compute/ecs-operations.test.ts | 52 | 0 | 0 |
| 695 | tests/providers/aws/drivers/compute/ecs-read.test.ts | 35 | 0 | 0 |
| 696 | tests/providers/aws/drivers/compute/ecs-replica-repair-read.test.ts | 26 | 0 | 0 |
| 697 | tests/providers/aws/drivers/compute/ecs-scheduled-read.test.ts | 32 | 0 | 0 |
| 698 | tests/providers/aws/drivers/compute/family-boundary.test.ts | 40 | 0 | 0 |
| 699 | tests/providers/aws/drivers/compute/lambda-ec2.test.ts | 37 | 0 | 0 |
| 700 | tests/providers/aws/drivers/compute/registry.test.ts | 7 | 0 | 0 |
| 701 | tests/providers/aws/drivers/compute/static-site.test.ts | 34 | 0 | 0 |
| 702 | tests/providers/aws/drivers/compute/support.test.ts | 94 | 0 | 0 |
| 703 | tests/providers/aws/drivers/compute/workload-boundary.test.ts | 57 | 0 | 0 |
| 704 | tests/providers/aws/drivers/messaging/assemble.test.ts | 9 | 0 | 0 |
| 705 | tests/providers/aws/drivers/messaging/sns-observe.test.ts | 77 | 0 | 0 |
| 706 | tests/providers/aws/drivers/messaging/sns-topic.test.ts | 43 | 0 | 0 |
| 707 | tests/providers/aws/drivers/data/assemble.test.ts | 5 | 0 | 0 |
| 708 | tests/providers/aws/drivers/data/contract.test.ts | 11 | 0 | 0 |
| 709 | tests/providers/aws/drivers/data/elasticache.test.ts | 25 | 0 | 0 |
| 710 | tests/providers/aws/drivers/data/iam-role.test.ts | 68 | 0 | 0 |
| 711 | tests/providers/aws/drivers/data/log-group.test.ts | 24 | 0 | 0 |
| 712 | tests/providers/aws/drivers/data/rds-compile.test.ts | 34 | 0 | 0 |
| 713 | tests/providers/aws/drivers/data/rds-read.test.ts | 42 | 0 | 0 |
| 714 | tests/providers/aws/drivers/data/s3-bucket.test.ts | 21 | 0 | 0 |
| 715 | tests/providers/aws/drivers/data/secret.test.ts | 24 | 0 | 0 |
| 716 | tests/providers/aws/drivers/data/sqs-queue.test.ts | 20 | 0 | 0 |
| 717 | tests/providers/aws/drivers/data/support.test.ts | 14 | 0 | 0 |
| 718 | tests/providers/aws/drivers/network/alb.test.ts | 51 | 0 | 0 |
| 719 | tests/providers/aws/drivers/network/compile-graph.test.ts | 27 | 0 | 0 |
| 720 | tests/providers/aws/drivers/network/contract.test.ts | 19 | 0 | 0 |
| 721 | tests/providers/aws/drivers/network/dns-acm.test.ts | 40 | 0 | 0 |
| 722 | tests/providers/aws/drivers/network/firewall.test.ts | 41 | 0 | 0 |
| 723 | tests/providers/aws/drivers/network/shared.test.ts | 37 | 0 | 0 |
| 724 | tests/providers/aws/drivers/network/subnet.test.ts | 15 | 0 | 0 |
| 725 | tests/providers/aws/drivers/network/vpc.test.ts | 30 | 0 | 0 |
| 726 | tests/providers/aws/drivers/eks/eks-cluster.test.ts | 37 | 0 | 0 |
| 727 | tests/providers/aws/drivers/eks/eks-policy.test.ts | 4 | 0 | 0 |
| 728 | tests/providers/aws/drivers/eks/eks-reads.test.ts | 101 | 0 | 0 |
| 729 | tests/providers/aws/drivers/storage/ebs-volume.test.ts | 42 | 0 | 0 |
| 730 | tests/api/preview-outcomes.test.tsx | 18 | 0 | 0 |
| 731 | tests/client/bootstrap-backoff.test.tsx | 2 | 0 | 0 |
| 732 | tests/client/navigator-poll-budget.test.tsx | 5 | 0 | 0 |
| 733 | tests/client/read-cancellation.test.tsx | 3 | 0 | 0 |
| 734 | tests/client/stream-url-switch.test.tsx | 3 | 0 | 0 |
| 735 | tests/client/use-json.test.tsx | 8 | 0 | 0 |
| 736 | tests/platform-ui/interactions.test.tsx | 25 | 0 | 0 |
| 737 | tests/platform-ui/pages.test.tsx | 14 | 0 | 0 |
| 738 | tests/platform-ui/teardown-page.test.tsx | 3 | 0 | 0 |
| 739 | tests/platform-ui/teardown.test.tsx | 45 | 0 | 0 |
| 740 | tests/navigator/gimbal-character.test.tsx | 7 | 0 | 0 |
| 741 | tests/navigator/gimbal-renderer.test.tsx | 13 | 0 | 0 |
| 742 | tests/navigator/recorded-receipt.test.tsx | 5 | 0 | 0 |
| 743 | tests/navigator/run-history.test.tsx | 1 | 0 | 0 |
| 744 | tests/navigator/run-panel.test.tsx | 3 | 0 | 0 |
| 745 | tests/navigator/step-card.test.tsx | 5 | 0 | 0 |
| 746 | tests/screens/account-identities.test.tsx | 22 | 0 | 0 |
| 747 | tests/screens/account-page.test.tsx | 9 | 0 | 0 |
| 748 | tests/screens/account-password.test.tsx | 18 | 0 | 0 |
| 749 | tests/screens/activity-page.test.tsx | 2 | 0 | 0 |
| 750 | tests/screens/auth-form.test.tsx | 17 | 0 | 0 |
| 751 | tests/screens/deploy-history-page.test.tsx | 5 | 0 | 0 |
| 752 | tests/screens/deploy-output-labels.test.tsx | 5 | 0 | 0 |
| 753 | tests/screens/deploy-uncertainty.test.tsx | 10 | 0 | 0 |
| 754 | tests/screens/integrations-control.test.tsx | 19 | 0 | 0 |
| 755 | tests/screens/landing-chapters.test.tsx | 10 | 0 | 0 |
| 756 | tests/screens/landing-cta.test.tsx | 4 | 0 | 0 |
| 757 | tests/screens/landing-header.test.tsx | 8 | 0 | 0 |
| 758 | tests/screens/landing-hero-cta.test.tsx | 2 | 0 | 0 |
| 759 | tests/screens/landing-waitlist.test.tsx | 6 | 0 | 0 |
| 760 | tests/screens/manifest-v2-inspector.test.tsx | 4 | 0 | 0 |
| 761 | tests/screens/map-keyboard.test.tsx | 1 | 0 | 0 |
| 762 | tests/screens/navigation-transitions.test.tsx | 11 | 0 | 0 |
| 763 | tests/screens/onboarding-controls.test.tsx | 6 | 0 | 0 |
| 764 | tests/screens/onboarding-flow.test.tsx | 5 | 0 | 0 |
| 765 | tests/screens/plan-role.test.tsx | 4 | 0 | 0 |
| 766 | tests/screens/project-grid.test.tsx | 13 | 0 | 0 |
| 767 | tests/screens/revision-history.test.tsx | 3 | 0 | 0 |
| 768 | tests/screens/run-action-refresh.test.tsx | 5 | 0 | 0 |
| 769 | tests/screens/signup-page.test.tsx | 3 | 0 | 0 |
| 770 | tests/screens/toast-project-identity.test.tsx | 8 | 0 | 0 |
| 771 | tests/screens/workspace-access-page.test.tsx | 7 | 0 | 0 |
| 772 | tests/screens/workspace-guide.test.tsx | 3 | 0 | 0 |
| 773 | tests/screens/workspace-invite.test.tsx | 10 | 0 | 0 |
| 774 | tests/screens/workspace-sharing.test.tsx | 12 | 0 | 0 |
| 775 | tests/shell/activity-bell.test.tsx | 9 | 0 | 0 |
| 776 | tests/shell/command-palette.test.tsx | 29 | 0 | 0 |
| 777 | tests/shell/context-summary.test.tsx | 3 | 0 | 0 |
| 778 | tests/shell/project-environment.test.tsx | 3 | 0 | 0 |
| 779 | tests/shell/workbench.test.tsx | 8 | 0 | 0 |
| 780 | tests/ui/callout.test.tsx | 5 | 0 | 0 |
| 781 | tests/ui/popover.test.tsx | 11 | 0 | 0 |
| 782 | tests/ui/table.test.tsx | 12 | 0 | 0 |
| 783 | tests/ui/theme-toggle.test.tsx | 6 | 0 | 0 |
| 784 | tests/ui/toast-persistence.test.tsx | 13 | 0 | 0 |
| 785 | tests/ui/workbench-controls.test.tsx | 9 | 0 | 0 |
| 786 | tests/waitlist/admin-entry.test.tsx | 7 | 0 | 0 |
| 787 | tests/waitlist/ui.test.tsx | 26 | 0 | 0 |
| 788 | tests/spatial/change-rehearsal.test.tsx | 3 | 0 | 0 |
| 789 | tests/hosted/tracker-app/app.test.tsx | 16 | 0 | 0 |
| 790 | tests/screens/apps/accept.test.tsx | 5 | 0 | 0 |
| 791 | tests/screens/apps/app-detail.test.tsx | 7 | 0 | 0 |
| 792 | tests/screens/apps/apps-list.test.tsx | 8 | 0 | 0 |
| 793 | tests/screens/apps/audience.test.tsx | 5 | 0 | 0 |
| 794 | tests/screens/apps/job-progress.test.tsx | 4 | 0 | 0 |
| 795 | tests/screens/apps/limits-health.test.tsx | 11 | 0 | 0 |
| 796 | tests/screens/apps/new-app.test.tsx | 6 | 0 | 0 |
| 797 | tests/screens/apps/publish-gating.test.tsx | 13 | 0 | 0 |
| 798 | tests/screens/apps/releases.test.tsx | 5 | 0 | 0 |
| 799 | tests/screens/settings/environment-health.test.tsx | 3 | 0 | 0 |
| 800 | tests/screens/platform/accessibility-and-honesty.test.tsx | 66 | 0 | 0 |
| 801 | tests/screens/platform/approval-card.test.tsx | 30 | 0 | 0 |
| 802 | tests/screens/platform/autonomy-control.test.tsx | 15 | 0 | 0 |
| 803 | tests/screens/platform/aws-connection-flow.test.tsx | 1 | 0 | 0 |
| 804 | tests/screens/platform/aws-connection-setup.test.tsx | 24 | 0 | 0 |
| 805 | tests/screens/platform/cost-and-placement.test.tsx | 28 | 0 | 0 |
| 806 | tests/screens/platform/drift-list.test.tsx | 16 | 0 | 0 |
| 807 | tests/screens/platform/investigation-view.test.tsx | 19 | 0 | 0 |
| 808 | tests/screens/platform/operation-timeline.test.tsx | 29 | 0 | 0 |
| 809 | tests/screens/platform/plan-changes-table.test.tsx | 17 | 0 | 0 |
| 810 | tests/screens/platform/policy-decision-panel.test.tsx | 10 | 0 | 0 |
| 811 | tests/screens/platform/resource-state.test.tsx | 23 | 0 | 0 |
| 812 | tests/screens/platform/teardown-review.test.tsx | 5 | 0 | 0 |

### staging-tofu: domain counts

| Domain | Passed | Failed | Skipped |
|---|---:|---:|---:|
| execution | 21 | 0 | 0 |
| providers | 3351 | 0 | 0 |
| security | 55 | 0 | 0 |
| tofu | 473 | 0 | 8 |

### staging-tofu: every test file

| File ordinal | File | Passed | Failed | Skipped |
|---:|---|---:|---:|---:|
| 1 | tests/execution/compile-refs-providers.test.ts | 18 | 0 | 0 |
| 2 | tests/execution/journey.test.ts | 3 | 0 | 0 |
| 3 | tests/security/tofu-runner-env.test.ts | 7 | 0 | 0 |
| 4 | tests/security/tofu-secrets.test.ts | 14 | 0 | 0 |
| 5 | tests/security/tofu-workspace-injection.test.ts | 34 | 0 | 0 |
| 6 | tests/tofu/backends.test.ts | 23 | 0 | 0 |
| 7 | tests/tofu/destroy-real.test.ts | 2 | 0 | 0 |
| 8 | tests/tofu/destroy-runner.test.ts | 4 | 0 | 0 |
| 9 | tests/tofu/destroy.test.ts | 65 | 0 | 0 |
| 10 | tests/tofu/driver-expressions.test.ts | 1 | 0 | 0 |
| 11 | tests/tofu/ephemeral-network.test.ts | 5 | 0 | 0 |
| 12 | tests/tofu/ephemeral.test.ts | 44 | 0 | 0 |
| 13 | tests/tofu/hcl-template-real.test.ts | 2 | 0 | 0 |
| 14 | tests/tofu/hcl-template.test.ts | 141 | 0 | 0 |
| 15 | tests/tofu/network.test.ts | 4 | 0 | 0 |
| 16 | tests/tofu/plan-artifact-handoff.test.ts | 0 | 0 | 8 |
| 17 | tests/tofu/plan-lock.test.ts | 1 | 0 | 0 |
| 18 | tests/tofu/plan-view-sensitive.test.ts | 1 | 0 | 0 |
| 19 | tests/tofu/plan.test.ts | 36 | 0 | 0 |
| 20 | tests/tofu/process.test.ts | 18 | 0 | 0 |
| 21 | tests/tofu/providers.test.ts | 8 | 0 | 0 |
| 22 | tests/tofu/runner.test.ts | 19 | 0 | 0 |
| 23 | tests/tofu/security-hardening.test.ts | 20 | 0 | 0 |
| 24 | tests/tofu/workspace-expressions.test.ts | 50 | 0 | 0 |
| 25 | tests/tofu/workspace.test.ts | 29 | 0 | 0 |
| 26 | tests/providers/azure/arm.test.ts | 12 | 0 | 0 |
| 27 | tests/providers/azure/build-digest.test.ts | 23 | 0 | 0 |
| 28 | tests/providers/azure/compile-drivers.test.ts | 26 | 0 | 0 |
| 29 | tests/providers/azure/compile.test.ts | 14 | 0 | 0 |
| 30 | tests/providers/azure/credentials.test.ts | 60 | 0 | 0 |
| 31 | tests/providers/azure/deploy.test.ts | 9 | 0 | 0 |
| 32 | tests/providers/azure/dns-ownership.test.ts | 27 | 0 | 0 |
| 33 | tests/providers/azure/helpers.test.ts | 14 | 0 | 0 |
| 34 | tests/providers/azure/more-compile.test.ts | 68 | 0 | 0 |
| 35 | tests/providers/azure/more-observe.test.ts | 70 | 0 | 0 |
| 36 | tests/providers/azure/mysql.test.ts | 23 | 0 | 0 |
| 37 | tests/providers/azure/observability.test.ts | 11 | 0 | 0 |
| 38 | tests/providers/azure/observe.test.ts | 58 | 0 | 0 |
| 39 | tests/providers/azure/operations.test.ts | 15 | 0 | 0 |
| 40 | tests/providers/azure/registry.test.ts | 3 | 0 | 0 |
| 41 | tests/providers/azure/release-journal.test.ts | 10 | 0 | 0 |
| 42 | tests/providers/azure/release.test.ts | 37 | 0 | 0 |
| 43 | tests/providers/azure/source-binding.test.ts | 7 | 0 | 0 |
| 44 | tests/providers/azure/source-storage.test.ts | 36 | 0 | 0 |
| 45 | tests/providers/azure/static-checks.test.ts | 21 | 0 | 0 |
| 46 | tests/providers/azure/validate.test.ts | 6 | 0 | 0 |
| 47 | tests/providers/gcp/bootstrap.test.ts | 14 | 0 | 0 |
| 48 | tests/providers/gcp/build-gcp.test.ts | 21 | 0 | 0 |
| 49 | tests/providers/gcp/compile.test.ts | 64 | 0 | 0 |
| 50 | tests/providers/gcp/credentials.test.ts | 41 | 0 | 0 |
| 51 | tests/providers/gcp/data-network.test.ts | 18 | 0 | 0 |
| 52 | tests/providers/gcp/dns-ownership.test.ts | 24 | 0 | 0 |
| 53 | tests/providers/gcp/firewall-network.test.ts | 10 | 0 | 0 |
| 54 | tests/providers/gcp/iam-read-credentials.test.ts | 10 | 0 | 0 |
| 55 | tests/providers/gcp/naming.test.ts | 16 | 0 | 0 |
| 56 | tests/providers/gcp/observability.test.ts | 18 | 0 | 0 |
| 57 | tests/providers/gcp/operations.test.ts | 30 | 0 | 0 |
| 58 | tests/providers/gcp/read.test.ts | 306 | 0 | 0 |
| 59 | tests/providers/gcp/release.test.ts | 40 | 0 | 0 |
| 60 | tests/providers/gcp/runtime.test.ts | 21 | 0 | 0 |
| 61 | tests/providers/gcp/secret-writer.test.ts | 7 | 0 | 0 |
| 62 | tests/providers/gcp/tofu-validate.test.ts | 6 | 0 | 0 |
| 63 | tests/providers/oci/allowlist-observability.test.ts | 12 | 0 | 0 |
| 64 | tests/providers/oci/allowlist.test.ts | 21 | 0 | 0 |
| 65 | tests/providers/oci/compile.test.ts | 60 | 0 | 0 |
| 66 | tests/providers/oci/discover.test.ts | 7 | 0 | 0 |
| 67 | tests/providers/oci/dns-ownership.test.ts | 33 | 0 | 0 |
| 68 | tests/providers/oci/failure-modes.test.ts | 208 | 0 | 0 |
| 69 | tests/providers/oci/more.test.ts | 72 | 0 | 0 |
| 70 | tests/providers/oci/mysql.test.ts | 9 | 0 | 0 |
| 71 | tests/providers/oci/naming-evidence.test.ts | 14 | 0 | 0 |
| 72 | tests/providers/oci/operations.test.ts | 19 | 0 | 0 |
| 73 | tests/providers/oci/release.test.ts | 60 | 0 | 0 |
| 74 | tests/providers/oci/static-checks.test.ts | 36 | 0 | 0 |
| 75 | tests/providers/oci/transport.test.ts | 69 | 0 | 0 |
| 76 | tests/providers/oci/validate.test.ts | 6 | 0 | 0 |
| 77 | tests/providers/oci/world.test.ts | 6 | 0 | 0 |
| 78 | tests/providers/aws/identity/trust.test.ts | 14 | 0 | 0 |
| 79 | tests/providers/aws/drivers/contract.test.ts | 53 | 0 | 0 |
| 80 | tests/providers/aws/drivers/e2e-compile.test.ts | 8 | 0 | 0 |
| 81 | tests/providers/azure/identity/trust.test.ts | 5 | 0 | 0 |
| 82 | tests/providers/gcp/identity/trust.test.ts | 10 | 0 | 0 |
| 83 | tests/providers/aws/drivers/compute/assemble.test.ts | 7 | 0 | 0 |
| 84 | tests/providers/aws/drivers/compute/codebuild.test.ts | 81 | 0 | 0 |
| 85 | tests/providers/aws/drivers/compute/ecr.test.ts | 19 | 0 | 0 |
| 86 | tests/providers/aws/drivers/compute/ecs-compile.test.ts | 51 | 0 | 0 |
| 87 | tests/providers/aws/drivers/compute/ecs-operations.test.ts | 52 | 0 | 0 |
| 88 | tests/providers/aws/drivers/compute/ecs-read.test.ts | 35 | 0 | 0 |
| 89 | tests/providers/aws/drivers/compute/ecs-replica-repair-read.test.ts | 26 | 0 | 0 |
| 90 | tests/providers/aws/drivers/compute/ecs-scheduled-read.test.ts | 32 | 0 | 0 |
| 91 | tests/providers/aws/drivers/compute/family-boundary.test.ts | 40 | 0 | 0 |
| 92 | tests/providers/aws/drivers/compute/lambda-ec2.test.ts | 37 | 0 | 0 |
| 93 | tests/providers/aws/drivers/compute/registry.test.ts | 7 | 0 | 0 |
| 94 | tests/providers/aws/drivers/compute/static-site.test.ts | 34 | 0 | 0 |
| 95 | tests/providers/aws/drivers/compute/support.test.ts | 94 | 0 | 0 |
| 96 | tests/providers/aws/drivers/compute/workload-boundary.test.ts | 57 | 0 | 0 |
| 97 | tests/providers/aws/drivers/eks/eks-cluster.test.ts | 37 | 0 | 0 |
| 98 | tests/providers/aws/drivers/eks/eks-policy.test.ts | 4 | 0 | 0 |
| 99 | tests/providers/aws/drivers/eks/eks-reads.test.ts | 101 | 0 | 0 |
| 100 | tests/providers/aws/drivers/network/alb.test.ts | 51 | 0 | 0 |
| 101 | tests/providers/aws/drivers/network/compile-graph.test.ts | 27 | 0 | 0 |
| 102 | tests/providers/aws/drivers/network/contract.test.ts | 19 | 0 | 0 |
| 103 | tests/providers/aws/drivers/network/dns-acm.test.ts | 40 | 0 | 0 |
| 104 | tests/providers/aws/drivers/network/firewall.test.ts | 41 | 0 | 0 |
| 105 | tests/providers/aws/drivers/network/shared.test.ts | 37 | 0 | 0 |
| 106 | tests/providers/aws/drivers/network/subnet.test.ts | 15 | 0 | 0 |
| 107 | tests/providers/aws/drivers/network/vpc.test.ts | 30 | 0 | 0 |
| 108 | tests/providers/aws/drivers/data/assemble.test.ts | 5 | 0 | 0 |
| 109 | tests/providers/aws/drivers/data/contract.test.ts | 11 | 0 | 0 |
| 110 | tests/providers/aws/drivers/data/elasticache.test.ts | 25 | 0 | 0 |
| 111 | tests/providers/aws/drivers/data/iam-role.test.ts | 68 | 0 | 0 |
| 112 | tests/providers/aws/drivers/data/log-group.test.ts | 24 | 0 | 0 |
| 113 | tests/providers/aws/drivers/data/rds-compile.test.ts | 34 | 0 | 0 |
| 114 | tests/providers/aws/drivers/data/rds-read.test.ts | 42 | 0 | 0 |
| 115 | tests/providers/aws/drivers/data/s3-bucket.test.ts | 21 | 0 | 0 |
| 116 | tests/providers/aws/drivers/data/secret.test.ts | 24 | 0 | 0 |
| 117 | tests/providers/aws/drivers/data/sqs-queue.test.ts | 20 | 0 | 0 |
| 118 | tests/providers/aws/drivers/data/support.test.ts | 14 | 0 | 0 |
| 119 | tests/providers/aws/drivers/messaging/assemble.test.ts | 9 | 0 | 0 |
| 120 | tests/providers/aws/drivers/messaging/sns-observe.test.ts | 77 | 0 | 0 |
| 121 | tests/providers/aws/drivers/messaging/sns-topic.test.ts | 43 | 0 | 0 |
| 122 | tests/providers/aws/drivers/storage/ebs-volume.test.ts | 42 | 0 | 0 |

### staging-workflows: domain counts

| Domain | Passed | Failed | Skipped |
|---|---:|---:|---:|
| execution | 57 | 0 | 0 |
| platform | 339 | 0 | 0 |
| platform-ui | 147 | 0 | 0 |
| providers | 26 | 0 | 0 |
| security | 10 | 0 | 0 |
| workflows | 421 | 0 | 0 |

### staging-workflows: every test file

| File ordinal | File | Passed | Failed | Skipped |
|---:|---|---:|---:|---:|
| 1 | tests/platform-ui/interactions.test.tsx | 25 | 0 | 0 |
| 2 | tests/platform-ui/pages.test.tsx | 14 | 0 | 0 |
| 3 | tests/platform-ui/teardown-page.test.tsx | 3 | 0 | 0 |
| 4 | tests/platform-ui/teardown.test.tsx | 45 | 0 | 0 |
| 5 | tests/execution/ecs-replica-repair.test.ts | 57 | 0 | 0 |
| 6 | tests/platform-ui/freshness.test.ts | 4 | 0 | 0 |
| 7 | tests/platform-ui/reads-and-loaders.test.ts | 56 | 0 | 0 |
| 8 | tests/platform/agent-ports.test.ts | 15 | 0 | 0 |
| 9 | tests/platform/composition.test.ts | 15 | 0 | 0 |
| 10 | tests/platform/credentials-verification.test.ts | 78 | 0 | 0 |
| 11 | tests/platform/deploy-e2e.test.ts | 18 | 0 | 0 |
| 12 | tests/platform/ecs-replica-repair-grants.test.ts | 7 | 0 | 0 |
| 13 | tests/platform/housekeeping.test.ts | 14 | 0 | 0 |
| 14 | tests/platform/machine-composition.test.ts | 6 | 0 | 0 |
| 15 | tests/platform/oci-sessions.test.ts | 31 | 0 | 0 |
| 16 | tests/platform/plan-approval-routes.test.ts | 9 | 0 | 0 |
| 17 | tests/platform/plan-approval.test.ts | 19 | 0 | 0 |
| 18 | tests/platform/release-multi.test.ts | 5 | 0 | 0 |
| 19 | tests/platform/release.test.ts | 8 | 0 | 0 |
| 20 | tests/platform/secret-grants.test.ts | 14 | 0 | 0 |
| 21 | tests/platform/source-bundle-azure.test.ts | 10 | 0 | 0 |
| 22 | tests/platform/source-bundle-composition.test.ts | 8 | 0 | 0 |
| 23 | tests/platform/source-bundle-github.test.ts | 4 | 0 | 0 |
| 24 | tests/platform/source-bundle.test.ts | 78 | 0 | 0 |
| 25 | tests/security/workflow-history.test.ts | 10 | 0 | 0 |
| 26 | tests/workflows/approval-time.test.ts | 3 | 0 | 0 |
| 27 | tests/workflows/caller-payloads.test.ts | 6 | 0 | 0 |
| 28 | tests/workflows/client.test.ts | 16 | 0 | 0 |
| 29 | tests/workflows/codec-replay.test.ts | 2 | 0 | 0 |
| 30 | tests/workflows/codec-wiring.test.ts | 27 | 0 | 0 |
| 31 | tests/workflows/codec.test.ts | 45 | 0 | 0 |
| 32 | tests/workflows/config.test.ts | 28 | 0 | 0 |
| 33 | tests/workflows/deploy.test.ts | 38 | 0 | 0 |
| 34 | tests/workflows/destroy-replay.test.ts | 6 | 0 | 0 |
| 35 | tests/workflows/destroy.test.ts | 11 | 0 | 0 |
| 36 | tests/workflows/ecs-replica-repair.test.ts | 11 | 0 | 0 |
| 37 | tests/workflows/failures.test.ts | 42 | 0 | 0 |
| 38 | tests/workflows/mtls-config.test.ts | 29 | 0 | 0 |
| 39 | tests/workflows/operations.test.ts | 28 | 0 | 0 |
| 40 | tests/workflows/payload-boundary.test.ts | 52 | 0 | 0 |
| 41 | tests/workflows/reconcile.test.ts | 2 | 0 | 0 |
| 42 | tests/workflows/replay.test.ts | 7 | 0 | 0 |
| 43 | tests/workflows/sandbox.test.ts | 52 | 0 | 0 |
| 44 | tests/workflows/worker.test.ts | 16 | 0 | 0 |
| 45 | tests/providers/aws/drivers/compute/ecs-replica-repair-read.test.ts | 26 | 0 | 0 |

### staging-platform-postgres: domain counts

| Domain | Passed | Failed | Skipped |
|---|---:|---:|---:|
| capabilities | 522 | 0 | 0 |
| controlplane | 478 | 0 | 0 |
| execution | 46 | 0 | 0 |
| platform | 40 | 0 | 0 |
| reconcile | 116 | 0 | 0 |
| runners | 321 | 0 | 0 |
| security | 1 | 0 | 0 |
| tofu | 8 | 0 | 0 |

### staging-platform-postgres: every test file

| File ordinal | File | Passed | Failed | Skipped |
|---:|---|---:|---:|---:|
| 1 | tests/capabilities/action-bridge.test.ts | 22 | 0 | 0 |
| 2 | tests/capabilities/approvals.test.ts | 61 | 0 | 0 |
| 3 | tests/capabilities/autonomy.test.ts | 33 | 0 | 0 |
| 4 | tests/capabilities/broker.test.ts | 99 | 0 | 0 |
| 5 | tests/capabilities/destroy-propose.test.ts | 11 | 0 | 0 |
| 6 | tests/capabilities/destroy-review-mcp.test.ts | 6 | 0 | 0 |
| 7 | tests/capabilities/execution.test.ts | 96 | 0 | 0 |
| 8 | tests/capabilities/platform.test.ts | 15 | 0 | 0 |
| 9 | tests/capabilities/product-adapters.test.ts | 14 | 0 | 0 |
| 10 | tests/capabilities/routes.test.ts | 50 | 0 | 0 |
| 11 | tests/capabilities/store-contract.test.ts | 85 | 0 | 0 |
| 12 | tests/capabilities/tenancy.test.ts | 30 | 0 | 0 |
| 13 | tests/controlplane/approvals.test.ts | 30 | 0 | 0 |
| 14 | tests/controlplane/execution-ledger.test.ts | 32 | 0 | 0 |
| 15 | tests/controlplane/executor.test.ts | 37 | 0 | 0 |
| 16 | tests/controlplane/grants.test.ts | 14 | 0 | 0 |
| 17 | tests/controlplane/lease-hang.test.ts | 1 | 0 | 0 |
| 18 | tests/controlplane/leases.test.ts | 26 | 0 | 0 |
| 19 | tests/controlplane/migrations.test.ts | 26 | 0 | 0 |
| 20 | tests/controlplane/open.test.ts | 16 | 0 | 0 |
| 21 | tests/controlplane/operations.test.ts | 59 | 0 | 0 |
| 22 | tests/controlplane/plan-artifacts.test.ts | 26 | 0 | 0 |
| 23 | tests/controlplane/read-jobs.test.ts | 30 | 0 | 0 |
| 24 | tests/controlplane/runners.test.ts | 52 | 0 | 0 |
| 25 | tests/controlplane/secrets.test.ts | 34 | 0 | 0 |
| 26 | tests/controlplane/services.test.ts | 38 | 0 | 0 |
| 27 | tests/controlplane/state.test.ts | 52 | 0 | 0 |
| 28 | tests/controlplane/tenancy.test.ts | 5 | 0 | 0 |
| 29 | tests/execution/apply.test.ts | 25 | 0 | 0 |
| 30 | tests/execution/destroy-review.test.ts | 21 | 0 | 0 |
| 31 | tests/reconcile/platform.test.ts | 116 | 0 | 0 |
| 32 | tests/runners/admin-routes.test.ts | 13 | 0 | 0 |
| 33 | tests/runners/aws-transport.test.ts | 19 | 0 | 0 |
| 34 | tests/runners/dispatch.test.ts | 25 | 0 | 0 |
| 35 | tests/runners/e2e-platform-store.test.ts | 8 | 0 | 0 |
| 36 | tests/runners/isolation.test.ts | 12 | 0 | 0 |
| 37 | tests/runners/oci-contract.test.ts | 4 | 0 | 0 |
| 38 | tests/runners/oci-payload.test.ts | 46 | 0 | 0 |
| 39 | tests/runners/paths.test.ts | 3 | 0 | 0 |
| 40 | tests/runners/poll.test.ts | 16 | 0 | 0 |
| 41 | tests/runners/read-jobs.test.ts | 40 | 0 | 0 |
| 42 | tests/runners/registration.test.ts | 14 | 0 | 0 |
| 43 | tests/runners/request-auth.test.ts | 18 | 0 | 0 |
| 44 | tests/runners/results.test.ts | 22 | 0 | 0 |
| 45 | tests/runners/runtime.test.ts | 5 | 0 | 0 |
| 46 | tests/runners/signing.test.ts | 14 | 0 | 0 |
| 47 | tests/runners/store-contract.test.ts | 44 | 0 | 0 |
| 48 | tests/runners/tofu-dispatch.test.ts | 18 | 0 | 0 |
| 49 | tests/platform/ecs-replica-repair-grants.test.ts | 13 | 0 | 0 |
| 50 | tests/platform/plan-approval.test.ts | 27 | 0 | 0 |
| 51 | tests/security/plan-artifact-secrecy.test.ts | 1 | 0 | 0 |
| 52 | tests/tofu/plan-artifact-handoff.test.ts | 8 | 0 | 0 |

### staging-supabase: domain counts

| Domain | Passed | Failed | Skipped |
|---|---:|---:|---:|
| agent-control | 16 | 0 | 0 |
| agent-link | 14 | 0 | 0 |
| db | 22 | 0 | 0 |
| hosted | 146 | 0 | 0 |
| scripts | 15 | 0 | 0 |
| waitlist | 38 | 0 | 0 |

### staging-supabase: every test file

| File ordinal | File | Passed | Failed | Skipped |
|---:|---|---:|---:|---:|
| 1 | tests/agent-control/pg-contract.test.ts | 16 | 0 | 0 |
| 2 | tests/agent-link/pg-contract.test.ts | 14 | 0 | 0 |
| 3 | tests/scripts/migrate-hosted-to-postgres.test.ts | 15 | 0 | 0 |
| 4 | tests/waitlist/pg-contract.test.ts | 38 | 0 | 0 |
| 5 | tests/db/contract/workspace-sharing.test.ts | 22 | 0 | 0 |
| 6 | tests/hosted/authority/contract/access.test.ts | 34 | 0 | 0 |
| 7 | tests/hosted/authority/contract/contract.test.ts | 52 | 0 | 0 |
| 8 | tests/hosted/authority/contract/ledgers.test.ts | 24 | 0 | 0 |
| 9 | tests/hosted/authority/contract/release.test.ts | 36 | 0 | 0 |

### staging-policy: domain counts

| Domain | Passed | Failed | Skipped |
|---|---:|---:|---:|
| policy | 238 | 0 | 0 |

### staging-policy: every test file

| File ordinal | File | Passed | Failed | Skipped |
|---:|---|---:|---:|---:|
| 1 | tests/policy/bundle.test.ts | 8 | 0 | 0 |
| 2 | tests/policy/defaults.test.ts | 22 | 0 | 0 |
| 3 | tests/policy/delete.test.ts | 21 | 0 | 0 |
| 4 | tests/policy/engine.test.ts | 70 | 0 | 0 |
| 5 | tests/policy/parity.test.ts | 1 | 0 | 0 |
| 6 | tests/policy/plan-facts.test.ts | 44 | 0 | 0 |
| 7 | tests/policy/scenarios.test.ts | 72 | 0 | 0 |

### fresh-uncovered-postgres: domain counts

| Domain | Passed | Failed | Skipped |
|---|---:|---:|---:|
| agent-control-journal-fixes.test.ts | 29 | 0 | 0 |
| agent-control-journal.test.ts | 28 | 0 | 0 |
| execution | 19 | 0 | 0 |
| secrets | 57 | 0 | 0 |
| sources | 20 | 0 | 0 |

### fresh-uncovered-postgres: every test file

| File ordinal | File | Passed | Failed | Skipped |
|---:|---|---:|---:|---:|
| 1 | tests/agent-control-journal-fixes.test.ts | 29 | 0 | 0 |
| 2 | tests/agent-control-journal.test.ts | 28 | 0 | 0 |
| 3 | tests/execution/destroy-review.test.ts | 19 | 0 | 0 |
| 4 | tests/secrets/rewrap.test.ts | 57 | 0 | 0 |
| 5 | tests/sources/github-store.test.ts | 20 | 0 | 0 |

## Native Go

Go output has 232 top-level passing tests and 541 passing subtests, with 11 passing package events. These are different levels, not additive independent scenarios. Six packages contain no test files; these are not six skipped test cases. Some package results are cached.

- `github.com/GODOSTROYER/zenith/go/internal/machine/ops/TestRealSystemctlAndJournalctl`: === RUN   TestRealSystemctlAndJournalctl; network_test.go:123: set ZENITH_TEST_SYSTEMD=1 on a host running systemd to run against real systemctl/journalctl; --- SKIP: TestRealSystemctlAndJournalctl (0.00s)
- `github.com/GODOSTROYER/zenith/go/internal/machine/ops/TestDisksComeFromRealFilesystemsOnly`: === RUN   TestDisksComeFromRealFilesystemsOnly; procfs_test.go:183: statfs is Linux only; --- SKIP: TestDisksComeFromRealFilesystemsOnly (0.00s)
- `github.com/GODOSTROYER/zenith/go/internal/machine/ops/TestProcfsAgainstTheRealHost`: === RUN   TestProcfsAgainstTheRealHost; procfs_test.go:219: needs Linux /proc; --- SKIP: TestProcfsAgainstTheRealHost (0.00s)

## Canonical backend precision

| Lane | Overall passing assertions | Required groups | Sum of group assertions |
|---|---:|---:|---:|
| staging-platform-postgres | 1532 | 70 | 449 |
| staging-supabase | 251 | 9 | 166 |
| staging-tofu | 3900 | 27 | 88 |
| staging-workflows | 1000 | 44 | 853 |
| staging-policy | 238 | 7 | 238 |

The required group sums can overlap. Overall PostgreSQL-lane totals do not assert every fixture used an actual PostgreSQL backend. Report and lock/gate hashes were independently compared with committed staging bytes; execution/host state is retained root evidence.

## Every discoverable failed local raw Vitest report

### prod-durable-artifact-postgres-root-contracts

Observed headers: {"numPassedTests": 1517, "numFailedTests": 11, "numPendingTests": 5, "numTotalTests": 1533}. Historical result; current status is assessed separately.

- tests/controlplane/migrations.test.ts assertion 23: migrator [postgres] concurrency and fail-closed open schema 6 emitted hardening upgrades through the canonical migrator under a distinct owner with RLS, role isolation and immutable artifacts. Exact unique same-name staging pass: False. Last file change at staging: 15e4453cdcf8dfd5ac83aa71b6d3c20e6ecf7b5a Preserve approved OpenTofu plans across execution workers. This commit index is not a proof that it alone fixed the failure.
- tests/controlplane/tenancy.test.ts assertion 1: completeness guard every repository function is classified: swept, a workspace-bound write, or exempt with a reason. Exact unique same-name staging pass: True. Last file change at staging: 15e4453cdcf8dfd5ac83aa71b6d3c20e6ecf7b5a Preserve approved OpenTofu plans across execution workers. This commit index is not a proof that it alone fixed the failure.
- tests/execution/apply.test.ts assertion 21: dispatch current authority [postgres] refuses expired approval after fresh replan and before durable dispatch. Exact unique same-name staging pass: False. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/execution/apply.test.ts assertion 22: dispatch current authority [postgres] refuses revoked approver role after fresh replan and before durable dispatch. Exact unique same-name staging pass: False. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/execution/apply.test.ts assertion 23: dispatch current authority [postgres] refuses new policy denial after fresh replan and before durable dispatch. Exact unique same-name staging pass: False. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/execution/apply.test.ts assertion 24: dispatch current authority [postgres] refuses expiry after authority check after fresh replan and before durable dispatch. Exact unique same-name staging pass: False. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/execution/apply.test.ts assertion 25: dispatch current authority [postgres] refuses expiry during role lookup after fresh replan and before durable dispatch. Exact unique same-name staging pass: False. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/tofu/plan-artifact-handoff.test.ts assertion 1: authenticated original cross-worker handoff [postgres] producer exits and loses its directory; another worker applies ORIGINAL bytes after a separate fresh check, then destroys. Exact unique same-name staging pass: False. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/tofu/plan-artifact-handoff.test.ts assertion 4: authenticated original cross-worker handoff [postgres] tampering with the original after inspection refuses before apply and preserves uncertainty after dispatch. Exact unique same-name staging pass: False. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/tofu/plan-artifact-handoff.test.ts assertion 5: authenticated original cross-worker handoff [postgres] source review completes, browser human approval is consumed, and destination destroys the associated ORIGINAL. Exact unique same-name staging pass: False. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/tofu/plan-artifact-handoff.test.ts assertion 6: authenticated original cross-worker handoff [postgres] restore into a fresh PostgreSQL store with matching keys preserves the original; missing keys refuse. Exact unique same-name staging pass: False. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.

### prod-durable-corrections-real-pg-root-contracts

Observed headers: {"numPassedTests": 1527, "numFailedTests": 5, "numPendingTests": 0, "numTotalTests": 1532}. Historical result; current status is assessed separately.

- tests/execution/apply.test.ts assertion 21: dispatch current authority [postgres] refuses expired approval after fresh replan and before durable dispatch. Exact unique same-name staging pass: False. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/execution/apply.test.ts assertion 22: dispatch current authority [postgres] refuses revoked approver role after fresh replan and before durable dispatch. Exact unique same-name staging pass: False. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/execution/apply.test.ts assertion 23: dispatch current authority [postgres] refuses new policy denial after fresh replan and before durable dispatch. Exact unique same-name staging pass: False. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/execution/apply.test.ts assertion 24: dispatch current authority [postgres] refuses expiry after authority check after fresh replan and before durable dispatch. Exact unique same-name staging pass: False. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/execution/apply.test.ts assertion 25: dispatch current authority [postgres] refuses expiry during role lookup after fresh replan and before durable dispatch. Exact unique same-name staging pass: False. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.

### prod-durable-full-root-unit

Observed headers: {"numPassedTests": 16588, "numFailedTests": 70, "numPendingTests": 212, "numTotalTests": 16870}. Historical result; current status is assessed separately.

- tests/ci/assert-lane-report.test.ts assertion 41: platform-postgres real-engine report gate accepts evidence only when every required scenario passed. Exact unique same-name staging pass: True. Last file change at staging: cd60f8bec935cf0e8287d27849e23ca2637482d2 Update strict gate fixtures for durable plan migration. This commit index is not a proof that it alone fixed the failure.
- tests/ci/assert-lane-report.test.ts assertion 50: platform-postgres real-engine report gate normalizes Windows and POSIX path separators. Exact unique same-name staging pass: True. Last file change at staging: cd60f8bec935cf0e8287d27849e23ca2637482d2 Update strict gate fixtures for durable plan migration. This commit index is not a proof that it alone fixed the failure.
- tests/ci/evidence-sanitizer.test.ts assertion 1: sanitized evidence boundary exports count-only requirement evidence bound to commit, dependencies, source and environment. Exact unique same-name staging pass: True. Last file change at staging: cd60f8bec935cf0e8287d27849e23ca2637482d2 Update strict gate fixtures for durable plan migration. This commit index is not a proof that it alone fixed the failure.
- tests/ci/evidence-sanitizer.test.ts assertion 5: sanitized evidence boundary does not trust summary totals from a malformed report. Exact unique same-name staging pass: True. Last file change at staging: cd60f8bec935cf0e8287d27849e23ca2637482d2 Update strict gate fixtures for durable plan migration. This commit index is not a proof that it alone fixed the failure.
- tests/ci/evidence-sanitizer.test.ts assertion 7: sanitized evidence boundary preserves a failed command observation when a later validation sees passing assertions. Exact unique same-name staging pass: True. Last file change at staging: cd60f8bec935cf0e8287d27849e23ca2637482d2 Update strict gate fixtures for durable plan migration. This commit index is not a proof that it alone fixed the failure.
- tests/ci/evidence-sanitizer.test.ts assertion 36: sanitized evidence boundary never treats report-only validation as observed execution, and CI can require its receipt. Exact unique same-name staging pass: True. Last file change at staging: cd60f8bec935cf0e8287d27849e23ca2637482d2 Update strict gate fixtures for durable plan migration. This commit index is not a proof that it alone fixed the failure.
- tests/ci/evidence-sanitizer.test.ts assertion 78: sanitized evidence boundary reports installed and locked versions independently instead of treating expectations as measurements. Exact unique same-name staging pass: True. Last file change at staging: cd60f8bec935cf0e8287d27849e23ca2637482d2 Update strict gate fixtures for durable plan migration. This commit index is not a proof that it alone fixed the failure.
- tests/ci/gate-manifest.test.ts assertion 9: canonical gate manifest covers direct PG-only suites and each parameterized backend suite independently. Exact unique same-name staging pass: True. Last file change at staging: cd60f8bec935cf0e8287d27849e23ca2637482d2 Update strict gate fixtures for durable plan migration. This commit index is not a proof that it alone fixed the failure.
- tests/ci/gate-manifest.test.ts assertion 10: canonical gate manifest requires both the fresh/reapply/checksum/rollback/emitted-SQL migrator and PostgreSQL concurrency suites. Exact unique same-name staging pass: False. Last file change at staging: cd60f8bec935cf0e8287d27849e23ca2637482d2 Update strict gate fixtures for durable plan migration. This commit index is not a proof that it alone fixed the failure.
- tests/ci/gate-manifest.test.ts assertion 11: canonical gate manifest rejects pglite replacement of the real fresh migration suite even when concurrency passed. Exact unique same-name staging pass: True. Last file change at staging: cd60f8bec935cf0e8287d27849e23ca2637482d2 Update strict gate fixtures for durable plan migration. This commit index is not a proof that it alone fixed the failure.
- tests/ci/gate-manifest.test.ts assertion 12: canonical gate manifest rejects skipped replacement of the real fresh migration suite even when concurrency passed. Exact unique same-name staging pass: True. Last file change at staging: cd60f8bec935cf0e8287d27849e23ca2637482d2 Update strict gate fixtures for durable plan migration. This commit index is not a proof that it alone fixed the failure.
- tests/ci/gate-manifest.test.ts assertion 17: mandatory ECS replica repair gates preserves every existing PostgreSQL requirement ID and binds new IDs to the exact outer suite. Exact unique same-name staging pass: False. Last file change at staging: cd60f8bec935cf0e8287d27849e23ca2637482d2 Update strict gate fixtures for durable plan migration. This commit index is not a proof that it alone fixed the failure.
- tests/ci/platform-coverage.test.ts assertion 20: platform suite coverage checks every network-gated file and the actual gated suite titles. Exact unique same-name staging pass: True. Last file change at staging: cd60f8bec935cf0e8287d27849e23ca2637482d2 Update strict gate fixtures for durable plan migration. This commit index is not a proof that it alone fixed the failure.
- tests/ci/release-gates.test.ts assertion 40: downloaded tools are checksum-verified before anything touches them has a pinned URL, output name and sha256 for every curl in every workflow, and no others. Exact unique same-name staging pass: True. Last file change at staging: cd60f8bec935cf0e8287d27849e23ca2637482d2 Update strict gate fixtures for durable plan migration. This commit index is not a proof that it alone fixed the failure.
- tests/execution/aws-bootstrap-context.test.ts assertion 1: deployment and destroy workspaces bind the saved suffix into reviewed plan digests. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/execution/deletion-guards.test.ts assertion 18: normal deploy deletion guards does not require destructive approval for a stateless deletion. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/execution/destroy-review-temporal.test.ts assertion 1: Temporal read-only teardown review workflow records evidence and a pending proposal once, and preserves approval winning a refresh race without apply. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/execution/ecs-replica-repair.test.ts assertion 45: existing plan/apply activity integration uses saved-plan apply and exact readback, with no generic native dispatch or zero-probe clearance. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/execution/ecs-replica-repair.test.ts assertion 46: existing plan/apply activity integration refuses missing human approval before invoking saved-plan apply. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/execution/ecs-replica-repair.test.ts assertion 47: existing plan/apply activity integration retains uncertainty after one apply when all three verification appends fail. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/execution/ecs-replica-repair.test.ts assertion 48: existing plan/apply activity integration refuses a mismatched verification receipt after apply (workspace). Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/execution/ecs-replica-repair.test.ts assertion 49: existing plan/apply activity integration refuses a mismatched verification receipt after apply (operation). Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/execution/ecs-replica-repair.test.ts assertion 50: existing plan/apply activity integration refuses a mismatched verification receipt after apply (kind). Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/execution/ecs-replica-repair.test.ts assertion 51: existing plan/apply activity integration refuses a mismatched verification receipt after apply (digest). Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/execution/ecs-replica-repair.test.ts assertion 52: existing plan/apply activity integration refuses a mismatched verification receipt after apply (simulated). Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/execution/ecs-replica-repair.test.ts assertion 53: existing plan/apply activity integration refuses a mismatched verification receipt after apply (summary). Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/execution/ecs-replica-repair.test.ts assertion 54: existing plan/apply activity integration preserves uncertainty after an attempted apply (readback). Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/execution/ecs-replica-repair.test.ts assertion 55: existing plan/apply activity integration preserves uncertainty after an attempted apply (lost-response). Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/execution/ecs-replica-repair.test.ts assertion 56: existing plan/apply activity integration preserves uncertainty after an attempted apply (nonzero-exit). Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/execution/ecs-replica-repair.test.ts assertion 57: existing plan/apply activity integration preserves uncertainty after an attempted apply (fence). Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/platform/deploy-e2e.test.ts assertion 1: composed deploy workflow (contract evidence) proposes through the bridge without a plan, records two browser rounds, signals, and resumes with a new fence. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/platform/deploy-e2e.test.ts assertion 2: composed deploy workflow (contract evidence) approves the plan as a browser human, deploys every step, and reads actual mocked steady state/health. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/platform/deploy-e2e.test.ts assertion 3: composed deploy workflow (contract evidence) denies a discovered public database before apply. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/platform/deploy-e2e.test.ts assertion 4: composed deploy workflow (contract evidence) a reject in the plan round halts without applying. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/platform/deploy-e2e.test.ts assertion 5: composed deploy workflow (contract evidence) a plan changed after plan approval fails before apply. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/platform/deploy-e2e.test.ts assertion 6: composed deploy workflow (contract evidence) loses its lease while apply is in flight and ends uncertain without retrying apply. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/platform/deploy-e2e.test.ts assertion 7: composed activities against local stores (no Temporal fallback) refuses infrastructure verification when an application identity carries ZenithWorkloadBoundary. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/platform/deploy-e2e.test.ts assertion 8: composed activities against local stores (no Temporal fallback) refuses infrastructure verification when an application identity carries ZenithBuildBoundary. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/platform/deploy-e2e.test.ts assertion 9: composed activities against local stores (no Temporal fallback) runs a real bridge proposal and two browser rounds through the complete activity chain (gateway is fake). Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/platform/deploy-e2e.test.ts assertion 10: composed activities against local stores (no Temporal fallback) refuses a changed final plan after the second browser approval and never applies. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/platform/deploy-e2e.test.ts assertion 11: composed activities against local stores (no Temporal fallback) runs the complete deploy activity chain with real policy, credentials and driver reads. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/platform/deploy-e2e.test.ts assertion 12: composed activities against local stores (no Temporal fallback) evaluates a public database plan as deny without any apply call. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/platform/deploy-e2e.test.ts assertion 13: composed activities against local stores (no Temporal fallback) maps a lost apply fence to a non-retryable LeaseLost and permits only uncertain finalization. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/platform/deploy-e2e.test.ts assertion 14: composed activities against local stores (no Temporal fallback) atomically reaps runner and machine jobs, marks owning operations uncertain, and audits once. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/platform/deploy-e2e.test.ts assertion 15: composed activities against local stores (no Temporal fallback) resolves platform repair resource ids only through the owning workspace/environment chain. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/platform/deploy-e2e.test.ts assertion 16: composed activities against local stores (no Temporal fallback) refuses grants after a human approver loses their required role. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/platform/machine-composition.test.ts assertion 1: default machine composition supplies a machine port lazily and honors explicit overrides. Exact unique same-name staging pass: True. Last file change at staging: b5254a73ddd4bd9ca959d810c5af36b126208590 machines: default composition supplies a provider-dispatched machine port (AWS SSM, Azure Run Command, GCP read-only, zenithd) behind the existing gates (Codex WS-MACHINE-PORT). This commit index is not a proof that it alone fixed the failure.
- tests/platform/machine-composition.test.ts assertion 2: default machine composition reads only tenant-scoped observations and reports unknown resources as null. Exact unique same-name staging pass: True. Last file change at staging: b5254a73ddd4bd9ca959d810c5af36b126208590 machines: default composition supplies a provider-dispatched machine port (AWS SSM, Azure Run Command, GCP read-only, zenithd) behind the existing gates (Codex WS-MACHINE-PORT). This commit index is not a proof that it alone fixed the failure.
- tests/platform/machine-composition.test.ts assertion 3: default machine composition runs AWS fixed documents inside the observe session and replays without another SDK call. Exact unique same-name staging pass: True. Last file change at staging: b5254a73ddd4bd9ca959d810c5af36b126208590 machines: default composition supplies a provider-dispatched machine port (AWS SSM, Azure Run Command, GCP read-only, zenithd) behind the existing gates (Codex WS-MACHINE-PORT). This commit index is not a proof that it alone fixed the failure.
- tests/platform/machine-composition.test.ts assertion 4: default machine composition runs Azure mutations with deploy grants and persists only sealed redacted output. Exact unique same-name staging pass: True. Last file change at staging: b5254a73ddd4bd9ca959d810c5af36b126208590 machines: default composition supplies a provider-dispatched machine port (AWS SSM, Azure Run Command, GCP read-only, zenithd) behind the existing gates (Codex WS-MACHINE-PORT). This commit index is not a proof that it alone fixed the failure.
- tests/platform/machine-composition.test.ts assertion 5: default machine composition uses GCP read-only cached inventory and refuses mutations before obtaining credentials. Exact unique same-name staging pass: True. Last file change at staging: b5254a73ddd4bd9ca959d810c5af36b126208590 machines: default composition supplies a provider-dispatched machine port (AWS SSM, Azure Run Command, GCP read-only, zenithd) behind the existing gates (Codex WS-MACHINE-PORT). This commit index is not a proof that it alone fixed the failure.
- tests/platform/machine-composition.test.ts assertion 6: default machine composition resolves unique registered bindings and dispatches a signed zenithd request exactly once. Exact unique same-name staging pass: True. Last file change at staging: b5254a73ddd4bd9ca959d810c5af36b126208590 machines: default composition supplies a provider-dispatched machine port (AWS SSM, Azure Run Command, GCP read-only, zenithd) behind the existing gates (Codex WS-MACHINE-PORT). This commit index is not a proof that it alone fixed the failure.
- tests/platform/source-bundle-composition.test.ts assertion 1: source-bundle execution wiring provides a source port using the platform resource store by default. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/platform/source-bundle-composition.test.ts assertion 2: source-bundle execution wiring keeps an explicit sourceBundle override authoritative. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/platform/source-bundle-composition.test.ts assertion 3: source-bundle execution wiring forwards the download configuration and preserves resource overrides. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/platform/source-bundle-composition.test.ts assertion 4: source-bundle execution wiring uses the injected resource store with the activity's workspace and environment. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/platform/source-bundle-composition.test.ts assertion 5: source-bundle execution wiring composes Azure preparation, stored-source reading and the SQL launch journal by default. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/platform/source-bundle-composition.test.ts assertion 6: source-bundle execution wiring uses the trusted connection binding without a source resolver override through ACR launch. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/platform/source-bundle-composition.test.ts assertion 7: source-bundle execution wiring refuses an Azure environment without a binding in the composed preparation port. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/security/controlplane-sql-scoping.test.ts assertion 5: control-store repositories: workspace scoping is present in every function that touches a tenant table SQL that carries a tenant id takes it as a bound parameter, never by string concatenation. Exact unique same-name staging pass: True. Last file change at staging: cb346a78fd1c5dca1fb28fc7aef8ce963422ccad security: getForSystem reviewed as the execution worker's only unscoped operation lookup, callers pinned; ledger: WS-SEC-LEAKS integrated. This commit index is not a proof that it alone fixed the failure.
- tests/workers/worker-health-wiring.test.ts assertion 1: worker health lifecycle wiring stays unready until polling with a loaded policy, probes live connections, drains unready and closes resources. Exact unique same-name staging pass: True. Last file change at staging: cd60f8bec935cf0e8287d27849e23ca2637482d2 Update strict gate fixtures for durable plan migration. This commit index is not a proof that it alone fixed the failure.
- tests/workflows/codec-wiring.test.ts assertion 18: execution worker process codec wiring passes mTLS files to NativeConnection.connect and keeps ready logs and worker payloads safe. Exact unique same-name staging pass: True. Last file change at staging: cd60f8bec935cf0e8287d27849e23ca2637482d2 Update strict gate fixtures for durable plan migration. This commit index is not a proof that it alone fixed the failure.
- tests/workflows/codec-wiring.test.ts assertion 21: execution worker process codec wiring attaches the same decrypt-compatible codec to Worker.create without changing other options. Exact unique same-name staging pass: True. Last file change at staging: cd60f8bec935cf0e8287d27849e23ca2637482d2 Update strict gate fixtures for durable plan migration. This commit index is not a proof that it alone fixed the failure.
- tests/sources/github-migrations.test.ts assertion 1: GitHub source platform migration 6 [PGlite] pins the append-only version and checksum, with compatibility SQL owned by the migration. Exact unique same-name staging pass: True. Last file change at staging: cd60f8bec935cf0e8287d27849e23ca2637482d2 Update strict gate fixtures for durable plan migration. This commit index is not a proof that it alone fixed the failure.
- tests/sources/github-migrations.test.ts assertion 2: GitHub source platform migration 6 [PGlite] normal fresh migration provides both source tables and usable workspace bindings. Exact unique same-name staging pass: True. Last file change at staging: cd60f8bec935cf0e8287d27849e23ca2637482d2 Update strict gate fixtures for durable plan migration. This commit index is not a proof that it alone fixed the failure.
- tests/sources/github-migrations.test.ts assertion 3: GitHub source platform migration 6 [PGlite] adopts manually installed tables without losing rows via platform migrator. Exact unique same-name staging pass: True. Last file change at staging: cd60f8bec935cf0e8287d27849e23ca2637482d2 Update strict gate fixtures for durable plan migration. This commit index is not a proof that it alone fixed the failure.
- tests/sources/github-migrations.test.ts assertion 4: GitHub source platform migration 6 [PGlite] adopts manually installed tables without losing rows via emitted SQL. Exact unique same-name staging pass: True. Last file change at staging: cd60f8bec935cf0e8287d27849e23ca2637482d2 Update strict gate fixtures for durable plan migration. This commit index is not a proof that it alone fixed the failure.
- tests/tofu/destroy.test.ts assertion 1: digest-bound destroy engine plans -destroy without the state lock, masks sensitive echoes and keeps the binary server-side. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/tofu/destroy.test.ts assertion 4: digest-bound destroy engine does not change the normal planning flags. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.
- tests/tofu/runner.test.ts assertion 5: tofu lifecycle on terraform_data (real tofu 1.12.5, local backend) keeps the plan file only where the caller says, mode 0600, and never in the result text. Exact unique same-name staging pass: True. Last file change at staging: c121f89e1e4a200096abe12f8268e3c6acdbddf0 Keep approved plans immutable during replan and worker dispatch. This commit index is not a proof that it alone fixed the failure.

### prod-platform-pg16-contracts

Observed headers: {"numPassedTests": 1323, "numFailedTests": 1, "numPendingTests": 0, "numTotalTests": 1324}. Historical result; current status is assessed separately.

- tests/runners/aws-transport.test.ts assertion 19: the credential broker's runner transport (RunnerAwsTransportFactory) clamps the runner grant to the session's expiry and refuses a connection that names no runner. Exact unique same-name staging pass: False. Last file change at staging: e9ee01f4dd87f6dda2ad7c734e079fc444d09aed Compare runner grant expiry with captured session deadline. This commit index is not a proof that it alone fixed the failure.

## Native failure recovery

- github.com/GODOSTROYER/zenith/go/internal/agent/TestNextKeysArePinnedAndPersisted: later native name pass True; c355eee and integration356b7d0; failed-save durable trust before publish correction; no failed native output strings exported.
- github.com/GODOSTROYER/zenith/go/internal/agent/(package): later native name pass True; c355eee and integration356b7d0; failed-save durable trust before publish correction; no failed native output strings exported.

## Remaining boundaries

- The staging full gate remains failed solely at the dependency audit: five package entries for GHSA-vfj7-8cjw-p6xm. The reviewed exception mechanism is inactive, and passing implementation lanes do not clear that audit.
- The 153-assertion actual PostgreSQL follow-up is separate; root matched 25 formerly skipped public cases at unchanged unique source identities and confirmed owned container/image cleanup. It is not 153 new unique unit assertions.
- Supported kind provider6 and release1 passed locally. They do not prove managed clusters, NetworkPolicy enforcement or persistent-data recovery.
- AMD64 and ARM64 packaged startup/readiness/outage/refusal/shutdown passed at staging356. Shutdown had no in-flight activity; this does not establish full deployment or external mTLS.
- Guest267 TS contracts and CI102 synthetic report contracts are unmerged. Six Linux target vet/build/test-compile steps passed; native Linux file-write runtime, mounted fixtures, ACLs, crash/fsync behavior and actual filesystem goldens remain unexecuted.
- The historical partial cleanup diagnostic was79 passed/1 failed, followed by a seven-case retry. This is not a complete80-case success or proof that destructive cleanup authority exists.
- Remote/public file-count differences are tool and environment specific:41 additional local OpenTofu/OPA passes minus6 remote Python-alias collector passes gives35 net. Fresh364 skips are not a subset of remote399; no remote case IDs were invented.
- No product source changed during this audit. Inputs were hashed before/after; missing raw historical records cannot support invented failure names or dates.

## Final follow-up and historical identity clarification

The separate exact-public Python-alias follow-up passed6/0/0 with unchanged collector source and removed its temporary alias. Original unit six skips remain. This raises separately matched unchanged-source coverage to 305 of the364 public skips, and 164 of the212 staging skips. The remainder are not matched to separate unchanged-source passes in this audit; this is a correspondence limit, not a test failure count.

The70 historic durable unit failures have68 unique same-file/display-name passing matches in staging. Two gate-manifest titles changed and lack retained stable case IDs, so their exact identity closure is unproved even though the corrected file passed. Integrated correction commits are c121f89/f3a5c0a for core and cd60f8b/b0cba69 for gate fixtures. Each historical record separately indexes last file change without claiming that commit alone caused the fix.

- prod-durable-artifact-postgres-root-contracts: {'laterExactNamePassed': 11}. All original failed names and ordinals remain in JSON; dedicated PostgreSQL passes are now included in these later matches.
- prod-durable-corrections-real-pg-root-contracts: {'laterExactNamePassed': 5}. All original failed names and ordinals remain in JSON; dedicated PostgreSQL passes are now included in these later matches.
- prod-durable-full-root-unit: {'laterExactNamePassed': 70}. All original failed names and ordinals remain in JSON; dedicated PostgreSQL passes are now included in these later matches.
- prod-platform-pg16-contracts: {'noLaterExactNamePassMatched': 1}. All original failed names and ordinals remain in JSON; dedicated PostgreSQL passes are now included in these later matches.

No nested or unavailable historic raw reports are invented. Top-level local raw report discovery includes four failed reports. The cleanup79/1 diagnostic and seven-case retry stay separate; complete80/0 proof and legitimate destructive cleanup authority remain absent.
