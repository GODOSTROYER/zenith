# Every observed skipped Vitest case

Original statuses remain skipped. A passing follow-up is separate evidence. Source guards identify reasons; source-only associations are not raw remote case identities. Separate-lane matches require identical test-file bytes, not necessarily identical production implementation; staging-only passes do not prove published behavior. Ordinals distinguish repeated parameterized titles.

Remote run has 399 skips in 72 files; raw remote assertion titles were not uploaded. See remote-skipped-files.json for all files and source associations. Do not substitute local titles for captured remote case identities.

## public-unit

364 skipped cases. Source 9e62a15.

### tests/acceptance/sample-app.test.ts

1 skipped cases. ZENITH_TEST_NETWORK=1 is required for the non-routable TCP timeout check. The default unit run disables this opt-in.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | acceptance fixture real Node HTTP app real non-routable TCP: /db times out and /health remains 200 (network opt-in required) | Not established in parsed lane correspondence |

### tests/agent-control-journal-fixes.test.ts

6 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 24 | postgres agent journal: lease, un-approve and the queue (live) refuses a finalize after the lease lapsed, and the row is resolved as uncertain, never as a success | fresh-uncovered-postgres |
| 25 | postgres agent journal: lease, un-approve and the queue (live) still finalizes while the lease holds | fresh-uncovered-postgres |
| 26 | postgres agent journal: lease, un-approve and the queue (live) withdraws an approval: phase, columns and document all go back, and it cannot be claimed | fresh-uncovered-postgres |
| 27 | postgres agent journal: lease, un-approve and the queue (live) refuses to withdraw a claimed, foreign, changed or unapproved operation, and changes nothing | fresh-uncovered-postgres |
| 28 | postgres agent journal: lease, un-approve and the queue (live) an un-approve racing a claim on two connections has exactly one winner, whichever gets the row first | fresh-uncovered-postgres |
| 29 | postgres agent journal: lease, un-approve and the queue (live) lists an uncertain operation in the review queue, read-only | fresh-uncovered-postgres |

### tests/agent-control-journal.test.ts

7 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 22 | postgres agent journal (live) two connections racing one claim: exactly one wins, the other sees the row unchanged | fresh-uncovered-postgres |
| 23 | postgres agent journal (live) a lease past its end reconciles to uncertain, and is never re-dispatched | fresh-uncovered-postgres |
| 24 | postgres agent journal (live) a finalize with a stale fence changes zero rows | fresh-uncovered-postgres |
| 25 | postgres agent journal (live) an application authority that moved during dispatch refuses to finalize | fresh-uncovered-postgres |
| 26 | postgres agent journal (live) (workspace, subject, request_key) is unique, so prepare is idempotent in the database | fresh-uncovered-postgres |
| 27 | postgres agent journal (live) claims, finalizes and reads back through the same interface the file store satisfies | fresh-uncovered-postgres |
| 28 | postgres agent journal (live) refuses every read and write until the schema ledger is what this build needs | fresh-uncovered-postgres |

### tests/agent-control/pg-contract.test.ts

16 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | AgentControlPostgres the claim gives one of two racing instances the operation and the other nothing | staging-supabase |
| 2 | AgentControlPostgres the claim leaves the loser a row to read rather than an error to interpret | staging-supabase |
| 3 | AgentControlPostgres the claim serialises a claim behind an open transaction and still yields one winner | staging-supabase |
| 4 | AgentControlPostgres the claim refuses to claim what the browser has not approved, or what expired while it waited | staging-supabase |
| 5 | AgentControlPostgres the claim refuses a claim whose reviewed digest or state fingerprint moved | staging-supabase |
| 6 | AgentControlPostgres the fence refuses a finalize carrying the fence of an earlier claim | staging-supabase |
| 7 | AgentControlPostgres the fence refuses a finalize after the lease has lapsed, and reconciliation then owns the row | staging-supabase |
| 8 | AgentControlPostgres the fence refuses a finalize whose authority moved while the action ran | staging-supabase |
| 9 | AgentControlPostgres the fence renews a lease only for the holder of the current fence | staging-supabase |
| 10 | AgentControlPostgres reconciliation turns an expired lease into uncertain once, and never back into a dispatch | staging-supabase |
| 11 | AgentControlPostgres reconciliation leaves a live lease alone | staging-supabase |
| 12 | AgentControlPostgres reconciliation expires a proposal nobody reviewed, without touching one that is running | staging-supabase |
| 13 | AgentControlPostgres the operation row makes an idempotent prepare a database fact | staging-supabase |
| 14 | AgentControlPostgres the operation row refuses a phase outside the eight the contract names | staging-supabase |
| 15 | AgentControlPostgres the operation row keeps an operation's events with it, and takes them when it goes | staging-supabase |
| 16 | AgentControlPostgres the indexes the reconciliation scan depends on keeps both partial indexes, with their WHERE clauses | staging-supabase |

### tests/agent-link/pg-contract.test.ts

14 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | AgentLinkPostgres credentials issues, verifies, revokes and then refuses ;  the whole lifetime of one bearer | staging-supabase |
| 2 | AgentLinkPostgres credentials refuses a credential whose expiry has passed, on the predicate and not on a caller's memory | staging-supabase |
| 3 | AgentLinkPostgres credentials refuses two credentials with one token hash | staging-supabase |
| 4 | AgentLinkPostgres credentials refuses a token hash that is not 64 hex characters, and a credential with no project | staging-supabase |
| 5 | AgentLinkPostgres the link code moves pending to approved exactly once, however many times the form is submitted | staging-supabase |
| 6 | AgentLinkPostgres the link code hands the secret back once and destroys it in the same statement | staging-supabase |
| 7 | AgentLinkPostgres the link code cannot read the secret back from a plain RETURNING, which is why the statement is shaped that way | staging-supabase |
| 8 | AgentLinkPostgres the link code gives two concurrent pollers one token between them | staging-supabase |
| 9 | AgentLinkPostgres the link code sweeps expired codes and destroys their secrets, and a second pass finds nothing | staging-supabase |
| 10 | AgentLinkPostgres the link code refuses a state outside the five the protocol names | staging-supabase |
| 11 | AgentLinkPostgres the durable rate limiter counts inside a window and starts the next one at one | staging-supabase |
| 12 | AgentLinkPostgres the durable rate limiter keeps one row per scope, key and window, and refuses a negative count | staging-supabase |
| 13 | AgentLinkPostgres the schema itself keeps row level security on with no policies, so only the service role reaches it | staging-supabase |
| 14 | AgentLinkPostgres the schema itself indexes the credential lookups the authorization path makes | staging-supabase |

### tests/bridge/steps.test.ts

1 skipped cases. The compatibility guard requires a hard-coded Z:/Projects/.../ws-act product-port.ts path that is absent. Current repository product-port exists. Root separately matched 23 phase/title rows; this does not change the one skipped test.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 3 | worker projection compatibility matches its title/phase table and row order | Not established in parsed lane correspondence |

### tests/cli/config.test.ts

1 skipped cases. This Windows inherited-ACL assertion runs only when process.platform is win32. The local report was produced on macOS ARM64.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 3 | private login config Windows refuses inherited ACLs that grant other identities access | Not established in parsed lane correspondence |

### tests/controlplane/executor.test.ts

1 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 20 | cross-engine shape identity PGlite and PostgreSQL return deeply equal rows for the same statement | staging-platform-postgres |

### tests/controlplane/migrations.test.ts

3 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 14 | migrator [postgres] concurrency and fail-closed open two migrators racing on an empty database converge: one applies, the other finds it done | Not established in parsed lane correspondence |
| 15 | migrator [postgres] concurrency and fail-closed open openPlatformDb({ kind: 'postgres' }) does not migrate unless asked, and a bare open sees the schema as behind | Not established in parsed lane correspondence |
| 16 | migrator [postgres] concurrency and fail-closed open BOOTSTRAP_SQL is idempotent | Not established in parsed lane correspondence |

### tests/controlplane/open.test.ts

2 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 15 | platformDb() against PostgreSQL opens a migrated database using ZENITH_PLATFORM_DB_URL, with the schema check passing | staging-platform-postgres |
| 16 | platformDb() against PostgreSQL fails CLOSED against an un-migrated database with the command to run, and does not cache the failure | staging-platform-postgres |

### tests/credentials/bootstrap-templates.test.ts

1 skipped cases. The skipped mock-provider template test requires ZENITH_TEST_TOFU and a detected binary, with provider initialization. It is distinct from ZENITH_TEST_TOFU_NETWORK.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 76 | OpenTofu module tofu init + validate + test (mock provider, offline after init) | Not established in parsed lane correspondence |

### tests/db/contract/alerts.test.ts

7 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | alerts on Postgres refuses a second standing rule for one (environment, kind) | Not established in parsed lane correspondence |
| 2 | alerts on Postgres round-trips an event through open and resolved | Not established in parsed lane correspondence |
| 3 | alerts on Postgres lets exactly one of two snapshots claim a pending row | Not established in parsed lane correspondence |
| 4 | alerts on Postgres reclaims a claim older than the lease and leaves a live one alone | Not established in parsed lane correspondence |
| 5 | alerts on Postgres refuses a second outbox row for one idempotency key | Not established in parsed lane correspondence |
| 6 | alerts on Postgres round-trips a security finding | Not established in parsed lane correspondence |
| 7 | alerts on Postgres round-trips a Navigator run | Not established in parsed lane correspondence |

### tests/db/contract/audit.test.ts

1 skipped cases. The scenario has an only-backend selector; the repeated FileStore instance is outside that scenario’s backend scope. Do not treat the FileStore repetition as an unexecuted universal backend promise.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 8 | audit contract ;  'FileStore' a retried append writes nothing twice | Not established in parsed lane correspondence |

### tests/db/contract/history.test.ts

7 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 8 | history contract ;  Postgres only seeds a second workspace to work in | Not established in parsed lane correspondence |
| 9 | history contract ;  Postgres only promotes the indexed columns and leaves them out of data | Not established in parsed lane correspondence |
| 10 | history contract ;  Postgres only reads a manifest back through the accessor with a cold cache | Not established in parsed lane correspondence |
| 11 | history contract ;  Postgres only assigns a dense seq per deployment across two instances | Not established in parsed lane correspondence |
| 12 | history contract ;  Postgres only refuses a write against a row another instance already moved | Not established in parsed lane correspondence |
| 13 | history contract ;  Postgres only bumps the change feed for the workspace a deployment belongs to | Not established in parsed lane correspondence |
| 14 | history contract ;  Postgres only keeps rows outside the snapshot's scope when it resets | Not established in parsed lane correspondence |

### tests/db/contract/workspace-sharing.test.ts

22 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | WorkspaceSharingPostgres grants execute only to the service role, excluding PUBLIC, anon and authenticated | staging-supabase |
| 2 | WorkspaceSharingPostgres keeps the owner present and administrative until ownership is transferred | staging-supabase |
| 3 | WorkspaceSharingPostgres requires the owner for granting or managing admin access and transferring ownership | staging-supabase |
| 4 | WorkspaceSharingPostgres uses actor identity rather than a claimed member email to authorize sharing | staging-supabase |
| 5 | WorkspaceSharingPostgres allows admins to manage non-admin collaborators and lets non-owners leave | staging-supabase |
| 6 | WorkspaceSharingPostgres rechecks a competing remover's authority after the owner demotes that admin | staging-supabase |
| 7 | WorkspaceSharingPostgres rechecks a competing role change after the owner removes the acting admin | staging-supabase |
| 8 | WorkspaceSharingPostgres protects the newly transferred owner against a competing removal | staging-supabase |
| 9 | WorkspaceSharingPostgres refuses a second ownership transfer from the former owner after waiting for the first | staging-supabase |
| 10 | WorkspaceSharingPostgres accepts a normalized matching email while refusing another signed-in identity's email | staging-supabase |
| 11 | WorkspaceSharingPostgres rejects a revoked invitation even when a caller retained its former live state | staging-supabase |
| 12 | WorkspaceSharingPostgres rechecks invitation revocation after a competing accept waits for the workspace lock | staging-supabase |
| 13 | WorkspaceSharingPostgres renews an expired invitation on resend, while refusing to renew a revoked offer | staging-supabase |
| 14 | WorkspaceSharingPostgres refuses expired invitations without creating membership | staging-supabase |
| 15 | WorkspaceSharingPostgres does not restore access when an accepted invitation is replayed after removal | staging-supabase |
| 16 | WorkspaceSharingPostgres preserves an existing member's role when accepting an older admin invitation | staging-supabase |
| 17 | WorkspaceSharingPostgres revokes old pending offers when a member exits through remove-member | staging-supabase |
| 18 | WorkspaceSharingPostgres revokes old pending offers when a member exits through leave | staging-supabase |
| 19 | WorkspaceSharingPostgres commits an audit event with a role change and writes no event for a refused mutation | staging-supabase |
| 20 | WorkspaceSharingPostgres lets a fresh invitation replace an expired pending offer without reviving the old one | staging-supabase |
| 21 | WorkspaceSharingPostgres allows one pending invitation per normalized address and workspace under competing requests | staging-supabase |
| 22 | WorkspaceSharingPostgres cannot use an invitation or membership id from a different workspace | staging-supabase |

### tests/execution/compile-refs-providers.test.ts

2 skipped cases. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 17 | real AWS schema validation through the execution compiler (opt-in) runs tofu init -backend=false and tofu validate on production | staging-tofu |
| 18 | real AWS schema validation through the execution compiler (opt-in) runs tofu init -backend=false and tofu validate on staging | staging-tofu |

### tests/execution/deletion-guards-real.test.ts

1 skipped cases. ZENITH_TEST_DELETION_GUARDS_TOFU=1 and an available OpenTofu binary are required. The generic network provider opt-in alone does not enable this test.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | real tofu deploy removal (ZENITH_TEST_DELETION_GUARDS_TOFU=1) refuses unapproved stateful removal and applies the exact approved deletion | Not established in parsed lane correspondence |

### tests/execution/destroy-review-temporal.test.ts

1 skipped cases. An existing ZENITH_TEST_TEMPORAL_SERVER or explicit ZENITH_TEST_TEMPORAL_DOWNLOAD=1 is required. Downloads are disabled in default unit execution.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | Temporal read-only teardown review workflow records evidence and a pending proposal once, and preserves approval winning a refresh race without apply | Not established in parsed lane correspondence |

### tests/execution/destroy-review.test.ts

1 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 19 | real Postgres destroy-review lane persists the first pending review with a readable PlanView | fresh-uncovered-postgres |

### tests/hosted/artifacts/storage-store.test.ts

2 skipped cases. ZENITH_CONTRACT_POSTGRES=1, NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. The tracker branch also checks atomic functions. Disposable PostgreSQL contracts do not establish hosted bucket/data-service acceptance.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 11 | StorageArtifactStore (live bucket) puts a bundle, reads it back byte for byte, and serves a range | Not established in parsed lane correspondence |
| 12 | StorageArtifactStore (live bucket) removes everything it wrote | Not established in parsed lane correspondence |

### tests/hosted/data/pg-contract.live.test.ts

11 skipped cases. ZENITH_CONTRACT_POSTGRES=1, NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. The tracker branch also checks atomic functions. Disposable PostgreSQL contracts do not establish hosted bucket/data-service acceptance.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | the tracker contract against real Postgres tables creates, reads back and pages the records it stored | Not established in parsed lane correspondence |
| 2 | the tracker contract against real Postgres tables lets the first writer through and refuses the second with stale_version | Not established in parsed lane correspondence |
| 3 | the tracker contract against real Postgres tables replays a retried write id instead of writing a second record | Not established in parsed lane correspondence |
| 4 | the tracker contract against real Postgres tables refuses a record that would take the app past its storage ceiling, and writes nothing | Not established in parsed lane correspondence |
| 5 | the tracker contract against real Postgres tables keeps one app's records out of another app's reach | Not established in parsed lane correspondence |
| 6 | the tracker contract against real Postgres tables accounts storage as the same logical-byte figure the measure defines | Not established in parsed lane correspondence |
| 7 | the tracker contract against real Postgres tables commits the record, the counter and the ledger row together | Not established in parsed lane correspondence |
| 8 | the whole-app operations against real Postgres tables imports a bundle, skips ids already stored, and keeps the counter true | Not established in parsed lane correspondence |
| 9 | the whole-app operations against real Postgres tables reports the logical integrity check, and it passes on rows it just wrote | Not established in parsed lane correspondence |
| 10 | the whole-app operations against real Postgres tables empties the probe namespace and leaves the app's own rows alone | Not established in parsed lane correspondence |
| 11 | the whole-app operations against real Postgres tables refuses to empty anything that is not a probe namespace | Not established in parsed lane correspondence |

### tests/machines/azure-scripts.test.ts

6 skipped cases. The collector probes the literal python executable with -I. That alias was unavailable in this run although python3 exists. This is not an OS-wide Azure restriction and passing elsewhere is not Azure guest delivery proof.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | Azure fixed Python collector locally all semantic and argv collector programs compile | azure-python-followup |
| 2 | Azure fixed Python collector locally metacharacters, quotes and newlines round-trip as argv data without a shell | azure-python-followup |
| 3 | Azure fixed Python collector locally drains large output with bounded memory and a complete sub-4-KiB envelope | azure-python-followup |
| 4 | Azure fixed Python collector locally child processes receive an explicit environment without collector secrets | azure-python-followup |
| 5 | Azure fixed Python collector locally preserves the child's actual nonzero exit status | azure-python-followup |
| 6 | Azure fixed Python collector locally terminates a timed-out command and marks its outcome | azure-python-followup |

### tests/machines/ssm-documents.test.ts

13 skipped cases. The native shell harness builds sh sh -s, which fails its probe. Root independently found sh -s succeeds. The thirteen guarded script assertions remain skipped; repair is still needed. FileRead also excludes Darwin, but the earlier broken probe already disables its cases.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 84 | script behaviour: input validation (runs the real scripts under sh) refuses hostile units with exit 64 before touching systemctl | Not established in parsed lane correspondence |
| 85 | script behaviour: input validation (runs the real scripts under sh) refuses to restart protected units with exit 65 | Not established in parsed lane correspondence |
| 86 | script behaviour: input validation (runs the real scripts under sh) enforces a restart allowlist baked into the document | Not established in parsed lane correspondence |
| 87 | script behaviour: input validation (runs the real scripts under sh) an agent too old for ENV_VAR (empty variables) fails closed, naming the cause | Not established in parsed lane correspondence |
| 88 | script behaviour: input validation (runs the real scripts under sh) validates numeric, enum and boolean parameters | Not established in parsed lane correspondence |
| 89 | script behaviour: input validation (runs the real scripts under sh) refuses metadata names and malformed hosts in PortCheck and DnsCheck (exit 64/65, before any network tool) | Not established in parsed lane correspondence |
| 90 | script behaviour: input validation (runs the real scripts under sh) PortCheck refuses link-local and metadata addresses after resolution (skipped where getent is missing) | Not established in parsed lane correspondence |
| 91 | script behaviour: FileRead guards (real files in a private temp dir) reads an allowed regular file as base64 with size and truncation facts | Not established in parsed lane correspondence |
| 92 | script behaviour: FileRead guards (real files in a private temp dir) caps output at 16384 bytes whatever maxBytes says, and reports truncation | Not established in parsed lane correspondence |
| 93 | script behaviour: FileRead guards (real files in a private temp dir) refuses traversal, symlink escapes and secret-like names | Not established in parsed lane correspondence |
| 94 | script behaviour: FileRead guards (real files in a private temp dir) a symlink may point at another allowed file, but not at an unlisted one | Not established in parsed lane correspondence |
| 95 | script behaviour: FileRead guards (real files in a private temp dir) exact-file allowlist entries allow only that file | Not established in parsed lane correspondence |
| 96 | script behaviour: FileRead guards (real files in a private temp dir) reports missing files and non-regular files | Not established in parsed lane correspondence |

### tests/platform/deploy-e2e.test.ts

6 skipped cases. The fixture needs a configured time-skipping server, installed Temporal CLI or explicit download permission. Source records Temporal CLI unavailable and downloads opt-in; this is a test-server prerequisite, not a cloud failure.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | composed deploy workflow (contract evidence) proposes through the bridge without a plan, records two browser rounds, signals, and resumes with a new fence | Not established in parsed lane correspondence |
| 2 | composed deploy workflow (contract evidence) approves the plan as a browser human, deploys every step, and reads actual mocked steady state/health | Not established in parsed lane correspondence |
| 3 | composed deploy workflow (contract evidence) denies a discovered public database before apply | Not established in parsed lane correspondence |
| 4 | composed deploy workflow (contract evidence) a reject in the plan round halts without applying | Not established in parsed lane correspondence |
| 5 | composed deploy workflow (contract evidence) a plan changed after plan approval fails before apply | Not established in parsed lane correspondence |
| 6 | composed deploy workflow (contract evidence) loses its lease while apply is in flight and ends uncertain without retrying apply | Not established in parsed lane correspondence |

### tests/platform/source-bundle.test.ts

1 skipped cases. ZENITH_TEST_SOURCE_GITHUB=1 plus an authorized repository and pinned 40-hex commit are required; ordinary mocked source tests do not replace this download check.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 78 | live public GitHub source (opt-in network) downloads a pinned public commit into a source bundle | staging-workflows |

### tests/providers/aws/drivers/compute/assemble.test.ts

3 skipped cases. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 5 | real `tofu validate` against hashicorp/aws 6.66.0 (network, plugin cache) accepts the whole compute graph (service, job, registry, build, static site, function, instance) | staging-tofu |
| 6 | real `tofu validate` against hashicorp/aws 6.66.0 (network, plugin cache) negative control: `validate` rejects an unknown argument, so the passes above are not vacuous | staging-tofu |
| 7 | real `tofu validate` against hashicorp/aws 6.66.0 (network, plugin cache) accepts a service with a pinned public image, no secrets and no load balancer | staging-tofu |

### tests/providers/aws/drivers/data/assemble.test.ts

1 skipped cases. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 5 | compiled data fragments validate against the real hashicorp/aws provider (network) tofu validate accepts the assembled workspace | staging-tofu |

### tests/providers/aws/drivers/e2e-compile.test.ts

2 skipped cases. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 7 | real OpenTofu AWS 6.66.0 schema validation (opt-in) initializes and validates the production workspace without a backend or cloud credentials | staging-tofu |
| 8 | real OpenTofu AWS 6.66.0 schema validation (opt-in) initializes and validates the staging workspace without a backend or cloud credentials | staging-tofu |

### tests/providers/aws/drivers/messaging/assemble.test.ts

1 skipped cases. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 9 | OpenTofu AWS 6.66.0 schema validation (requires binary/network) validates the complete SNS/EBS/EKS graph against the pinned provider | staging-tofu |

### tests/providers/aws/drivers/network/compile-graph.test.ts

6 skipped cases. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 22 | tofu validate over the real aws 6.66.0 provider schema (gated: ZENITH_TEST_TOFU_NETWORK=1) the assembled fixture workspace validates | staging-tofu |
| 23 | tofu validate over the real aws 6.66.0 provider schema (gated: ZENITH_TEST_TOFU_NETWORK=1) the validator has teeth: an unknown argument in a compiled resource makes the same workspace invalid | staging-tofu |
| 24 | tofu validate over the real aws 6.66.0 provider schema (gated: ZENITH_TEST_TOFU_NETWORK=1) variant validates: single NAT | staging-tofu |
| 25 | tofu validate over the real aws 6.66.0 provider schema (gated: ZENITH_TEST_TOFU_NETWORK=1) variant validates: no NAT | staging-tofu |
| 26 | tofu validate over the real aws 6.66.0 provider schema (gated: ZENITH_TEST_TOFU_NETWORK=1) variant validates: manual certificate | staging-tofu |
| 27 | tofu validate over the real aws 6.66.0 provider schema (gated: ZENITH_TEST_TOFU_NETWORK=1) variant validates: second TLS host with its own certificate | staging-tofu |

### tests/providers/aws/identity/trust.test.ts

1 skipped cases. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 14 | IRSA pinned provider schema validates the new trust and OIDC provider with real tofu | staging-tofu |

### tests/providers/azure/deploy.test.ts

1 skipped cases. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 9 | deploy/azure validates against the real azurerm 5.7.0 schema (network) tofu init (azurerm pinned to 5.7.0) and tofu validate succeed | staging-tofu |

### tests/providers/azure/identity/trust.test.ts

1 skipped cases. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 5 | AKS trust pinned provider schema validates the new federation and issuer-only deployment with real tofu | staging-tofu |

### tests/providers/azure/mysql.test.ts

2 skipped cases. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 22 | Azure MySQL real pinned tofu validate (network, no Azure account) accepts write-only bootstrap storage, ephemeral readback and HA=true | staging-tofu |
| 23 | Azure MySQL real pinned tofu validate (network, no Azure account) accepts write-only bootstrap storage, ephemeral readback and HA=false | staging-tofu |

### tests/providers/azure/validate.test.ts

5 skipped cases. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | compiled Azure OpenTofu validates against the real azurerm 5.7.0 schema (network) built apps and jobs use a digest bootstrap and ignore release image/argv changes | staging-tofu |
| 2 | compiled Azure OpenTofu validates against the real azurerm 5.7.0 schema (network) additional drivers, delegated subnets, ARM deployments, custom domains and Function host endpoints | staging-tofu |
| 3 | compiled Azure OpenTofu validates against the real azurerm 5.7.0 schema (network) a full environment: landing zone, subnets, firewall, Container App + job, postgres HA, redis, storage, service bus, key vault, identity, registry, logs, DNS, managed certificate | staging-tofu |
| 4 | compiled Azure OpenTofu validates against the real azurerm 5.7.0 schema (network) variants: no HA, a topic, a worker, a job without a schedule, an apex domain, a referenced Key Vault secret, deletion allowed, a single zone | staging-tofu |
| 5 | compiled Azure OpenTofu validates against the real azurerm 5.7.0 schema (network) an environment with only a bucket and a queue plus the network that owns the resource group | staging-tofu |

### tests/providers/gcp/bootstrap.test.ts

1 skipped cases. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 14 | tofu validate (network) initializes with the committed lockfile and validates against hashicorp/google 8.5.0 | staging-tofu |

### tests/providers/gcp/identity/trust.test.ts

1 skipped cases. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 10 | GKE trust pinned provider schema validates the new GSA IAM binding with real tofu | staging-tofu |

### tests/providers/gcp/tofu-validate.test.ts

6 skipped cases. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | tofu validate against hashicorp/google 8.5.0 (network) accepts built services and jobs with digest bootstrap and narrow image/annotation ignore_changes paths | staging-tofu |
| 2 | tofu validate against hashicorp/google 8.5.0 (network) accepts the full environment: network, data stores, identity, services, load balancer, dns, build | staging-tofu |
| 3 | tofu validate against hashicorp/google 8.5.0 (network) accepts variants: no NAT, non-HA database, hourly redis backups, http-only load balancer, no backups, worker-only services | staging-tofu |
| 4 | tofu validate against hashicorp/google 8.5.0 (network) accepts referenced nodes compiled to data sources | staging-tofu |
| 5 | tofu validate against hashicorp/google 8.5.0 (network) control: validate rejects an invalid attribute, so the passes above mean something | staging-tofu |
| 6 | tofu validate against hashicorp/google 8.5.0 (network) plans the whole environment offline with a fake token: every claimed resource is created, joined to its node, and no attribute is sensitive | staging-tofu |

### tests/providers/kubernetes/kind.test.ts

6 skipped cases. ZENITH_TEST_KIND=1 and a disposable KUBECONFIG are required; release tests also require a pinned non-root release image. Dedicated kind reports are listed separately.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | kubernetes provider against a real cluster (kind) creates the namespace, policy and workload, then a second apply changes nothing | staging-kind |
| 2 | kubernetes provider against a real cluster (kind) rolls out, and the drivers observe, verify and report runtime | staging-kind |
| 3 | kubernetes provider against a real cluster (kind) refuses to touch a same-named object it does not own | staging-kind |
| 4 | kubernetes provider against a real cluster (kind) restarts, scales and reads logs and events through the operations | staging-kind |
| 5 | kubernetes provider against a real cluster (kind) deploys a new image, rolls back to the previous revision, and the pods follow | staging-kind |
| 6 | kubernetes provider against a real cluster (kind) prunes what is no longer desired and never deletes the namespace | staging-kind |

### tests/providers/kubernetes/release-kind.test.ts

1 skipped cases. ZENITH_TEST_KIND=1 and a disposable KUBECONFIG are required; release tests also require a pinned non-root release image. Dedicated kind reports are listed separately.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | Kubernetes release ports against a disposable kind cluster rolls out a pre-built digest, observes readiness and runs exactly one migration Job across retries | staging-kind |

### tests/providers/oci/mysql.test.ts

5 skipped cases. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 5 | OCI MySQL real pinned tofu schema and persistence controls (network) validates the schema-only baseline and verifies the live password schema | staging-tofu |
| 6 | OCI MySQL real pinned tofu schema and persistence controls (network) refuses persisting an ephemeral password through admin_password | staging-tofu |
| 7 | OCI MySQL real pinned tofu schema and persistence controls (network) refuses persisting an ephemeral password through output | staging-tofu |
| 8 | OCI MySQL real pinned tofu schema and persistence controls (network) rejects the unsupported MySQL property admin_password_wo in JSON configuration | staging-tofu |
| 9 | OCI MySQL real pinned tofu schema and persistence controls (network) rejects the unsupported MySQL property zenith_not_a_mysql_argument in JSON configuration | staging-tofu |

### tests/providers/oci/validate.test.ts

5 skipped cases. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 2 | tofu validate against oracle/oci 9.7.1 (network) the private VM and enhanced OKE cluster/node pool validate | staging-tofu |
| 3 | tofu validate against oracle/oci 9.7.1 (network) the whole web stack (network, LB, container instances, postgres, redis, bucket, queue, vault, identity, logs, dns) validates | staging-tofu |
| 4 | tofu validate against oracle/oci 9.7.1 (network) the extended graph (host+path routing policy, container registry, block volume, no NAT, two zones) validates | staging-tofu |
| 5 | tofu validate against oracle/oci 9.7.1 (network) negative control: a wrong argument in a compiled fragment makes validate fail (the gate has teeth) | staging-tofu |
| 6 | the customer bootstrap module (deploy/oci) validates against the locked provider (network) tofu validate accepts deploy/oci with its shipped lockfile | staging-tofu |

### tests/scripts/migrate-hosted-to-postgres.test.ts

3 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 13 | migrate-hosted-to-postgres ;  against the real Supabase project copies the control tables, verifies, and inserts nothing on a second run | staging-supabase |
| 14 | migrate-hosted-to-postgres ;  against the real Supabase project copies the app's data, verifies, and inserts nothing on a second run | staging-supabase |
| 15 | migrate-hosted-to-postgres ;  against the real Supabase project leaves no contract- rows behind | staging-supabase |

### tests/secrets/rewrap.test.ts

1 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 57 | real Postgres vault re-wrap commits product rows and audit together, then resumes idempotently | fresh-uncovered-postgres |

### tests/security/workflow-history.test.ts

2 skipped cases. ZENITH_SEC_TEMPORAL=1 is required for these actual history checks, with a local test server. This flag is separate from ordinary Temporal suite enablement.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 9 | real Temporal history (opt-in; fake activities) ids/digests-only inputs and fake activity results leave synthetic node specs outside history | staging-workflows |
| 10 | real Temporal history (opt-in; fake activities) SEC-F12: runtime node-spec extras are absent from actual durable history | staging-workflows |

### tests/sources/github-live.test.ts

1 skipped cases. ZENITH_TEST_SOURCE_GITHUB_APP=1 plus app configuration, repository binding and a pinned commit are required. Store-only GitHub tests do not prove private App token/download acceptance.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | private GitHub App source (opt-in network) downloads the bound repository at a pinned commit with an ephemeral scoped token | Not established in parsed lane correspondence |

### tests/sources/github-store.test.ts

10 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 11 | GitHub source Postgres store (opt-in) persists only identifiers and proof digests, and resolves bindings by workspace | fresh-uncovered-postgres |
| 12 | GitHub source Postgres store (opt-in) refuses a changed callback workspace without consuming the legitimate intent | fresh-uncovered-postgres |
| 13 | GitHub source Postgres store (opt-in) refuses a changed callback actor without consuming the legitimate intent | fresh-uncovered-postgres |
| 14 | GitHub source Postgres store (opt-in) refuses a changed callback browser without consuming the legitimate intent | fresh-uncovered-postgres |
| 15 | GitHub source Postgres store (opt-in) refuses a changed callback state without consuming the legitimate intent | fresh-uncovered-postgres |
| 16 | GitHub source Postgres store (opt-in) refuses expired intents at both transitions using database time | fresh-uncovered-postgres |
| 17 | GitHub source Postgres store (opt-in) allows only one racing setup and one racing OAuth callback | fresh-uncovered-postgres |
| 18 | GitHub source Postgres store (opt-in) stores hashed state/proof and never lets an install callback skip OAuth | fresh-uncovered-postgres |
| 19 | GitHub source Postgres store (opt-in) rejects stale/racing bind intents rather than overwriting another admin's binding | fresh-uncovered-postgres |
| 20 | GitHub source Postgres store (opt-in) validates identifiers and numeric IDs without reflecting malicious data | fresh-uncovered-postgres |

### tests/tofu/backends.test.ts

4 skipped cases. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 20 | real backend block validation (network gate, no cloud calls) aws: tofu init -backend=false then tofu validate | staging-tofu |
| 21 | real backend block validation (network gate, no cloud calls) gcp: tofu init -backend=false then tofu validate | staging-tofu |
| 22 | real backend block validation (network gate, no cloud calls) azure: tofu init -backend=false then tofu validate | staging-tofu |
| 23 | real backend block validation (network gate, no cloud calls) oci: tofu init -backend=false then tofu validate | staging-tofu |

### tests/tofu/destroy-real.test.ts

2 skipped cases. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | real tofu destroy (ZENITH_TEST_TOFU_NETWORK=1) creates, reviews and destroys builtin state through verified apply | staging-tofu |
| 2 | real tofu destroy (ZENITH_TEST_TOFU_NETWORK=1) creates, reviews and destroys random state through verified apply | staging-tofu |

### tests/tofu/ephemeral-network.test.ts

5 skipped cases. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | real ephemeral resources (network) validates the supported random_password ephemeral schema | staging-tofu |
| 2 | real ephemeral resources (network) rejects persisting a sensitive ephemeral password via output | staging-tofu |
| 3 | real ephemeral resources (network) rejects persisting a sensitive ephemeral password via resource | staging-tofu |
| 4 | real ephemeral resources (network) evaluates a password-dependent condition and keeps generated values out of plan views and state | staging-tofu |
| 5 | real ephemeral resources (network) fails a password-dependent condition without disclosing the generated value | staging-tofu |

### tests/tofu/network.test.ts

4 skipped cases. ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | real provider install through the committed lockfile (network) installs hashicorp/random into an empty plugin cache with -lockfile=readonly, then plans and applies a digest-verified plan | staging-tofu |
| 2 | real provider install through the committed lockfile (network) refuses to init when the lockfile does not cover the required provider or carries the wrong hashes | staging-tofu |
| 3 | real provider install through the committed lockfile (network) reproduces the committed lock block for hashicorp/random with `tofu providers lock` | staging-tofu |
| 4 | AWS provider blocks validate against the real provider schema (network, ~160 MB first run) accepts providers.tf.json (region + default_tags), the s3 backend block shape, and typical resource JSON | staging-tofu |

### tests/waitlist/pg-contract.test.ts

38 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | WaitlistPostgres lets only Supabase Auth invoke the signup hook and read admitted email/status columns | staging-supabase |
| 2 | WaitlistPostgres rejects absent/queued signups identically and admits the email only after operator admission | staging-supabase |
| 3 | WaitlistPostgres normalizes duplicate joins and preserves the original answers, position and admission | staging-supabase |
| 4 | WaitlistPostgres enforces email 254, occupation 120 and use-case 2000 boundaries in PostgreSQL | staging-supabase |
| 5 | WaitlistPostgres accepts email alone and persists bounded optional profile answers | staging-supabase |
| 6 | WaitlistPostgres lists stable FIFO pages with global counts and admits the oldest queued positions | staging-supabase |
| 7 | WaitlistPostgres refuses an admission count of 0 without changing the queue | staging-supabase |
| 8 | WaitlistPostgres refuses an admission count of -1 without changing the queue | staging-supabase |
| 9 | WaitlistPostgres refuses an admission count of 1001 without changing the queue | staging-supabase |
| 10 | WaitlistPostgres refuses an admission count of null without changing the queue | staging-supabase |
| 11 | WaitlistPostgres accepts both count boundaries and never fills a batch with already admitted users | staging-supabase |
| 12 | WaitlistPostgres replays UUID requests exactly and rejects changed count or actor without admitting more | staging-supabase |
| 13 | WaitlistPostgres persists empty batches so replay cannot admit a later join | staging-supabase |
| 14 | WaitlistPostgres deduplicates simultaneous case-varied joins on independent connections | staging-supabase |
| 15 | WaitlistPostgres serializes overlapping batches into disjoint consecutive FIFO admissions | staging-supabase |
| 16 | WaitlistPostgres replays a concurrently retried request instead of admitting a second batch | staging-supabase |
| 17 | WaitlistPostgres waits for an earlier joining transaction before admitting the queue | staging-supabase |
| 18 | WaitlistPostgres persists an actor-bound FIFO preview without changing the queue | staging-supabase |
| 19 | WaitlistPostgres validates preview modes, counts and exact unique selected IDs | staging-supabase |
| 20 | WaitlistPostgres captures all queued IDs beyond display/count limits and excludes later arrivals | staging-supabase |
| 21 | WaitlistPostgres waits for an in-flight join when creating a preview and locks later joins out of its snapshot | staging-supabase |
| 22 | WaitlistPostgres serializes overlapping snapshots and admits each captured queued entry only once | staging-supabase |
| 23 | WaitlistPostgres replays concurrent preview requests exactly and consumes a preview only once | staging-supabase |
| 24 | WaitlistPostgres rejects another operator, missing previews and expired unused previews without admissions | staging-supabase |
| 25 | WaitlistPostgres prevents request-key reuse across legacy admission and selected previews | staging-supabase |
| 26 | WaitlistPostgres prevents request-key reuse across legacy admission and next previews | staging-supabase |
| 27 | WaitlistPostgres prevents request-key reuse across legacy admission and all previews | staging-supabase |
| 28 | WaitlistPostgres persists zero-count previews and batches without admitting later arrivals | staging-supabase |
| 29 | WaitlistPostgres records newest-first exact admission history including overlap and legacy batches | staging-supabase |
| 30 | WaitlistPostgres returns immutable saved history details and null for an unknown request | staging-supabase |
| 31 | WaitlistPostgres paginates immutable history rows with bounded pages and validates offsets | staging-supabase |
| 32 | WaitlistPostgres filters literal profile text with cursor-independent matched counts and global totals | staging-supabase |
| 33 | WaitlistPostgres grants only service_role the waitlist RPCs, tables and queue sequence | staging-supabase |
| 34 | WaitlistPostgres refuses direct reads, writes and RPC invocation as anon | staging-supabase |
| 35 | WaitlistPostgres refuses direct reads, writes and RPC invocation as authenticated | staging-supabase |
| 36 | WaitlistPostgres refuses direct reads, writes and RPC invocation as supabase_auth_admin | staging-supabase |
| 37 | WaitlistPostgres enforces RLS even with temporary browser SELECT grants and rolls those grants back | staging-supabase |
| 38 | WaitlistPostgres enforces the rate-limit quota and resets an expired counter as service_role | staging-supabase |

### tests/workflows/approval-time.test.ts

3 skipped cases. The shared serverSuite tries an existing local CLI or configured time-skipping server; downloads require explicit permission. Required Temporal lanes fail rather than skip when unavailable. Default unit lacks these enabled server prerequisites.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | approval window (time-skipping server) an approval that never arrives expires the operation after 24 hours and applies nothing | staging-workflows |
| 2 | approval window (time-skipping server) an approval recorded without a signal is still noticed by the periodic re-check | staging-workflows |
| 3 | a worker that goes silent mid-apply (time-skipping server) the heartbeat timeout ends the operation `uncertain`; the apply is not replayed | staging-workflows |

### tests/workflows/client.test.ts

12 skipped cases. The shared serverSuite tries an existing local CLI or configured time-skipping server; downloads require explicit permission. Required Temporal lanes fail rather than skip when unavailable. Default unit lacks these enabled server prerequisites.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 2 | startDeploy is idempotent on the operation id a real accepted start can complete after its response times out, and its operation id still prevents another execution | staging-workflows |
| 3 | startDeploy is idempotent on the operation id a duplicate start while running returns the same execution, and only one workflow runs | staging-workflows |
| 4 | startDeploy is idempotent on the operation id a duplicate start after completion returns the finished execution and does not run it again | staging-workflows |
| 5 | startDeploy is idempotent on the operation id different operations get different workflow ids and runs | staging-workflows |
| 6 | the other start functions startDayTwo and startRemediation start `op-<operationId>` workflows and are idempotent | staging-workflows |
| 7 | the other start functions startReconcile runs one pass per environment at a time, and a finished pass does not block the next | staging-workflows |
| 8 | signals and queries signalApproval and cancelOperation report `not_found` for an unknown operation instead of throwing | staging-workflows |
| 9 | signals and queries getProgress returns live progress, then the final progress, and null for an unknown operation | staging-workflows |
| 10 | signals and queries getProgress does not hang when the worker has gone away: it fails fast with a typed error | staging-workflows |
| 11 | signals and queries cancelOperation asks a running operation to stop | staging-workflows |
| 14 | workflowClient and temporalAvailable reports available for the suite's own server, and a missing namespace as namespace_not_found | staging-workflows |
| 16 | workflowClient and temporalAvailable workflowClient shares one connection per config, does not cache a failed connect, and never echoes the API key | staging-workflows |

### tests/workflows/codec-replay.test.ts

2 skipped cases. The shared serverSuite tries an existing local CLI or configured time-skipping server; downloads require explicit permission. Required Temporal lanes fail rather than skip when unavailable. Default unit lacks these enabled server prerequisites.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | codec histories on local Temporal (ZENITH_TEST_TEMPORAL=1) encrypts workflow/activity payloads, supports queries/signals and replays with retained keys | staging-workflows |
| 2 | codec histories on local Temporal (ZENITH_TEST_TEMPORAL=1) replays a legacy plaintext history with an encrypted converter | staging-workflows |

### tests/workflows/deploy.test.ts

38 skipped cases. The shared serverSuite tries an existing local CLI or configured time-skipping server; downloads require explicit permission. Required Temporal lanes fail rather than skip when unavailable. Default unit lacks these enabled server prerequisites.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | deploy: happy path runs every step in order, records progress, and releases the lease | staging-workflows |
| 2 | deploy: happy path skips the build when the manifest pins images | staging-workflows |
| 3 | deploy: happy path answers the progress query while running and after it finishes | staging-workflows |
| 4 | deploy: happy path carries no credential-shaped keys in any activity input or result | staging-workflows |
| 5 | deploy: validation and policy stops on an invalid desired state before taking the lease | staging-workflows |
| 6 | deploy: validation and policy policy deny fails the operation with the reasons and never applies | staging-workflows |
| 7 | deploy: validation and policy a pre-approved proposal whose policy now requires approval still waits | staging-workflows |
| 8 | deploy: approval waits without a lease, then continues on signal + approval with a fresh lease | staging-workflows |
| 9 | deploy: approval takes an approval that already exists on the spot: no wait, no awaiting_approval flicker, the lease is kept | staging-workflows |
| 10 | deploy: approval a rejected approval fails the operation and applies nothing | staging-workflows |
| 11 | deploy: approval a signal with no decision recorded does not proceed | staging-workflows |
| 12 | deploy: approval a plan that changed during the approval wait is caught by final_plan and never applied | staging-workflows |
| 13 | deploy: plan changed plan_changed at final_plan fails with a re-approval message; apply is never called | staging-workflows |
| 14 | deploy: plan changed a re-plan whose digest differs is refused even if the activity did not throw | staging-workflows |
| 15 | deploy: lease loss and mutating-step failures LeaseLost during apply -> uncertain, and the release is still attempted | staging-workflows |
| 16 | deploy: lease loss and mutating-step failures the lease expiring between steps after an apply -> uncertain, no further mutation | staging-workflows |
| 17 | deploy: lease loss and mutating-step failures a lease lost before anything mutated is a plain failure | staging-workflows |
| 18 | deploy: lease loss and mutating-step failures a busy environment fails cleanly without acting | staging-workflows |
| 19 | deploy: lease loss and mutating-step failures an unclassified apply error is one attempt and ends uncertain (never replayed) | staging-workflows |
| 20 | deploy: lease loss and mutating-step failures an apply that ran to a clean failure is failed, with the partial-apply note | staging-workflows |
| 21 | deploy: lease loss and mutating-step failures an unclassified deploy error is uncertain and later steps do not run | staging-workflows |
| 22 | deploy: lease loss and mutating-step failures an unclassified migrate error is uncertain and later steps do not run | staging-workflows |
| 23 | deploy: lease loss and mutating-step failures a build that fails after the apply is failed, and says the apply stays | staging-workflows |
| 24 | deploy: verification failed infrastructure verification -> failed, changes stay applied | staging-workflows |
| 25 | deploy: verification inconclusive application verification -> uncertain, not success | staging-workflows |
| 26 | deploy: verification a failed observation does not undo a verified deployment | staging-workflows |
| 27 | deploy: retries and bookkeeping a transient read failure is retried and the deploy still succeeds | staging-workflows |
| 28 | deploy: retries and bookkeeping a read that keeps failing exhausts 5 attempts, then fails without mutating | staging-workflows |
| 29 | deploy: retries and bookkeeping a progress-projection failure does not abort the deploy | staging-workflows |
| 30 | deploy: retries and bookkeeping the terminal status write is retried until it lands | staging-workflows |
| 31 | deploy: retries and bookkeeping a stub activity fails the operation immediately with a clear reason | staging-workflows |
| 32 | deploy: retries and bookkeeping redacts credential-shaped text from error messages before they are recorded | staging-workflows |
| 33 | deploy: cancellation a cancel signal during deploy cancels the activity, marks cancelled, releases the lease, destroys nothing | staging-workflows |
| 34 | deploy: cancellation Temporal-level cancellation behaves the same as the cancel signal | staging-workflows |
| 35 | deploy: cancellation cancelling during a read step (before any lease) cancels cleanly with no release | staging-workflows |
| 36 | deploy: cancellation cancelling while awaiting approval cancels; the lease was already released for the wait | staging-workflows |
| 37 | deploy: cancellation a cancel signal sent to a workflow that already finished is reported, not thrown | staging-workflows |
| 38 | deploy: workflow failure surface if the terminal status cannot be written at all, the workflow itself fails loudly | staging-workflows |

### tests/workflows/destroy-replay.test.ts

6 skipped cases. The shared serverSuite tries an existing local CLI or configured time-skipping server; downloads require explicit permission. Required Temporal lanes fail rather than skip when unavailable. Default unit lacks these enabled server prerequisites.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | real destroy workflow histories (ZENITH_TEST_TEMPORAL=1) happy runs and replays against the current definitions | staging-workflows |
| 2 | real destroy workflow histories (ZENITH_TEST_TEMPORAL=1) plan_changed runs and replays against the current definitions | staging-workflows |
| 3 | real destroy workflow histories (ZENITH_TEST_TEMPORAL=1) lease_lost runs and replays against the current definitions | staging-workflows |
| 4 | real destroy workflow histories (ZENITH_TEST_TEMPORAL=1) approval_reject runs and replays against the current definitions | staging-workflows |
| 5 | real destroy workflow histories (ZENITH_TEST_TEMPORAL=1) unknown_absence runs and replays against the current definitions | staging-workflows |
| 6 | real destroy workflow histories (ZENITH_TEST_TEMPORAL=1) preserves and replays the deploy command sequence | staging-workflows |

### tests/workflows/ecs-replica-repair.test.ts

11 skipped cases. The shared serverSuite tries an existing local CLI or configured time-skipping server; downloads require explicit permission. Required Temporal lanes fail rather than skip when unavailable. Default unit lacks these enabled server prerequisites.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | requires concrete plan approval, then exact final plan and one saved-plan apply | staging-workflows |
| 2 | policy allow alone cannot authorize the concrete repair | staging-workflows |
| 3 | moved final plan refuses apply and requires a new review | staging-workflows |
| 4 | an unclassified apply response is uncertain and is never retried | staging-workflows |
| 5 | lost fence after entering apply preserves uncertainty without compensation | staging-workflows |
| 6 | cancellation after entering apply remains blocking uncertainty (browser-signal) | staging-workflows |
| 7 | cancellation after entering apply remains blocking uncertainty (temporal-cancel) | staging-workflows |
| 8 | pre-write cancellation stays cancelled without an apply attempt | staging-workflows |
| 9 | a classified cancelled halt after an apply attempt remains uncertain | staging-workflows |
| 10 | pre-repair cancellation history keeps its legacy terminal classification on replay | staging-workflows |
| 11 | histories recorded by the pre-repair day-two workflow replay through the legacy branch | staging-workflows |

### tests/workflows/mtls-live.test.ts

2 skipped cases. ZENITH_TEST_TEMPORAL_MTLS=1 and an authorized external namespace, address and certificate/key files are required. Disposable local Temporal does not prove external mTLS.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | external Temporal mTLS (ZENITH_TEST_TEMPORAL_MTLS=1) web transport authenticates and reads the configured namespace | Not established in parsed lane correspondence |
| 2 | external Temporal mTLS (ZENITH_TEST_TEMPORAL_MTLS=1) worker transport authenticates and reads the configured namespace | Not established in parsed lane correspondence |

### tests/workflows/operations.test.ts

28 skipped cases. The shared serverSuite tries an existing local CLI or configured time-skipping server; downloads require explicit permission. Required Temporal lanes fail rather than skip when unavailable. Default unit lacks these enabled server prerequisites.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | day-two workflow runs lease -> policy -> execute -> verify -> finalize -> release and marks succeeded | staging-workflows |
| 2 | day-two workflow re-checks policy and a deny stops it before anything runs | staging-workflows |
| 3 | day-two workflow waits for approval without a lease, then runs under a fresh one | staging-workflows |
| 4 | day-two workflow a rejected approval fails it and executes nothing | staging-workflows |
| 5 | day-two workflow a capability that reports failure is failed, and is never retried | staging-workflows |
| 6 | day-two workflow an unclassified execution error is one attempt and ends uncertain | staging-workflows |
| 7 | day-two workflow a lost lease during execution is uncertain | staging-workflows |
| 8 | day-two workflow failed verification -> failed, recorded, not retried, not rolled back | staging-workflows |
| 9 | day-two workflow inconclusive verification -> uncertain | staging-workflows |
| 10 | day-two workflow cancelling during execution cancels the activity, marks cancelled and releases the lease | staging-workflows |
| 11 | remediation workflow runs lease -> policy -> execute -> verify -> finalize -> release and marks succeeded | staging-workflows |
| 12 | remediation workflow re-checks policy and a deny stops it before anything runs | staging-workflows |
| 13 | remediation workflow waits for approval without a lease, then runs under a fresh one | staging-workflows |
| 14 | remediation workflow a rejected approval fails it and executes nothing | staging-workflows |
| 15 | remediation workflow a capability that reports failure is failed, and is never retried | staging-workflows |
| 16 | remediation workflow an unclassified execution error is one attempt and ends uncertain | staging-workflows |
| 17 | remediation workflow a lost lease during execution is uncertain | staging-workflows |
| 18 | remediation workflow failed verification -> failed, recorded, not retried, not rolled back | staging-workflows |
| 19 | remediation workflow inconclusive verification -> uncertain | staging-workflows |
| 20 | remediation workflow cancelling during execution cancels the activity, marks cancelled and releases the lease | staging-workflows |
| 21 | remediation workflow: never re-runs a failed remediation is not retried by the workflow, whatever the failure | staging-workflows |
| 22 | reconcile workflow takes the reconcile lease, observes, reports the counts and releases | staging-workflows |
| 23 | reconcile workflow allowAutoRepair requests canonical proposal consideration without a workflow execution bypass | staging-workflows |
| 24 | reconcile workflow no drift with auto-repair allowed reports nothing to repair | staging-workflows |
| 25 | reconcile workflow another pass holding the lease means this one is skipped, without observing | staging-workflows |
| 26 | reconcile workflow a patched history rejects an old count-only activity response instead of claiming repair consideration | staging-workflows |
| 27 | reconcile workflow an observation failure is reported as a failed pass, and the lease is still released | staging-workflows |
| 28 | reconcile workflow cancelling the workflow releases the lease and cancels the observation | staging-workflows |

### tests/workflows/reconcile.test.ts

2 skipped cases. The shared serverSuite tries an existing local CLI or configured time-skipping server; downloads require explicit permission. Required Temporal lanes fail rather than skip when unavailable. Default unit lacks these enabled server prerequisites.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | canonical reconciliation through the real Temporal SDK persists an observation and broker proposal under the same real fence, without bypassing human approval | staging-workflows |
| 2 | canonical reconciliation through the real Temporal SDK records the exact pre-patch workflow and replays its original command/result branch | staging-workflows |

### tests/workflows/replay.test.ts

7 skipped cases. The shared serverSuite tries an existing local CLI or configured time-skipping server; downloads require explicit permission. Required Temporal lanes fail rather than skip when unavailable. Default unit lacks these enabled server prerequisites.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | replaying histories recorded by the current workflows deploy: happy path | staging-workflows |
| 2 | replaying histories recorded by the current workflows deploy: approval wait, signal, and a second lease | staging-workflows |
| 3 | replaying histories recorded by the current workflows deploy: a failure path (lease lost during apply) | staging-workflows |
| 4 | replaying histories recorded by the current workflows deploy: cancellation mid-flight | staging-workflows |
| 5 | replaying histories recorded by the current workflows deploy: retried reads (activity attempts do not disturb replay) | staging-workflows |
| 6 | replaying histories recorded by the current workflows day-two, remediation and reconcile | staging-workflows |
| 7 | the replay check has teeth the same history is rejected by a workflow that schedules its activities in a different order | staging-workflows |

### tests/workflows/worker.test.ts

1 skipped cases. The shared serverSuite tries an existing local CLI or configured time-skipping server; downloads require explicit permission. Required Temporal lanes fail rather than skip when unavailable. Default unit lacks these enabled server prerequisites.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 16 | rolling replacement of the execution worker a draining worker lets the running activity finish once; the next worker completes the workflow | staging-workflows |

## staging-unit

212 skipped cases. Source 356b7d0.

### tests/acceptance/sample-app.test.ts

1 skipped cases. ZENITH_TEST_NETWORK=1 is required for the non-routable TCP timeout check. The default unit run disables this opt-in.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | acceptance fixture real Node HTTP app real non-routable TCP: /db times out and /health remains 200 (network opt-in required) | Not established in parsed lane correspondence |

### tests/agent-control-journal-fixes.test.ts

6 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 24 | postgres agent journal: lease, un-approve and the queue (live) refuses a finalize after the lease lapsed, and the row is resolved as uncertain, never as a success | fresh-uncovered-postgres |
| 25 | postgres agent journal: lease, un-approve and the queue (live) still finalizes while the lease holds | fresh-uncovered-postgres |
| 26 | postgres agent journal: lease, un-approve and the queue (live) withdraws an approval: phase, columns and document all go back, and it cannot be claimed | fresh-uncovered-postgres |
| 27 | postgres agent journal: lease, un-approve and the queue (live) refuses to withdraw a claimed, foreign, changed or unapproved operation, and changes nothing | fresh-uncovered-postgres |
| 28 | postgres agent journal: lease, un-approve and the queue (live) an un-approve racing a claim on two connections has exactly one winner, whichever gets the row first | fresh-uncovered-postgres |
| 29 | postgres agent journal: lease, un-approve and the queue (live) lists an uncertain operation in the review queue, read-only | fresh-uncovered-postgres |

### tests/agent-control-journal.test.ts

7 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 22 | postgres agent journal (live) two connections racing one claim: exactly one wins, the other sees the row unchanged | fresh-uncovered-postgres |
| 23 | postgres agent journal (live) a lease past its end reconciles to uncertain, and is never re-dispatched | fresh-uncovered-postgres |
| 24 | postgres agent journal (live) a finalize with a stale fence changes zero rows | fresh-uncovered-postgres |
| 25 | postgres agent journal (live) an application authority that moved during dispatch refuses to finalize | fresh-uncovered-postgres |
| 26 | postgres agent journal (live) (workspace, subject, request_key) is unique, so prepare is idempotent in the database | fresh-uncovered-postgres |
| 27 | postgres agent journal (live) claims, finalizes and reads back through the same interface the file store satisfies | fresh-uncovered-postgres |
| 28 | postgres agent journal (live) refuses every read and write until the schema ledger is what this build needs | fresh-uncovered-postgres |

### tests/agent-control/pg-contract.test.ts

16 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | AgentControlPostgres the claim gives one of two racing instances the operation and the other nothing | staging-supabase |
| 2 | AgentControlPostgres the claim leaves the loser a row to read rather than an error to interpret | staging-supabase |
| 3 | AgentControlPostgres the claim serialises a claim behind an open transaction and still yields one winner | staging-supabase |
| 4 | AgentControlPostgres the claim refuses to claim what the browser has not approved, or what expired while it waited | staging-supabase |
| 5 | AgentControlPostgres the claim refuses a claim whose reviewed digest or state fingerprint moved | staging-supabase |
| 6 | AgentControlPostgres the fence refuses a finalize carrying the fence of an earlier claim | staging-supabase |
| 7 | AgentControlPostgres the fence refuses a finalize after the lease has lapsed, and reconciliation then owns the row | staging-supabase |
| 8 | AgentControlPostgres the fence refuses a finalize whose authority moved while the action ran | staging-supabase |
| 9 | AgentControlPostgres the fence renews a lease only for the holder of the current fence | staging-supabase |
| 10 | AgentControlPostgres reconciliation turns an expired lease into uncertain once, and never back into a dispatch | staging-supabase |
| 11 | AgentControlPostgres reconciliation leaves a live lease alone | staging-supabase |
| 12 | AgentControlPostgres reconciliation expires a proposal nobody reviewed, without touching one that is running | staging-supabase |
| 13 | AgentControlPostgres the operation row makes an idempotent prepare a database fact | staging-supabase |
| 14 | AgentControlPostgres the operation row refuses a phase outside the eight the contract names | staging-supabase |
| 15 | AgentControlPostgres the operation row keeps an operation's events with it, and takes them when it goes | staging-supabase |
| 16 | AgentControlPostgres the indexes the reconciliation scan depends on keeps both partial indexes, with their WHERE clauses | staging-supabase |

### tests/agent-link/pg-contract.test.ts

14 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | AgentLinkPostgres credentials issues, verifies, revokes and then refuses ;  the whole lifetime of one bearer | staging-supabase |
| 2 | AgentLinkPostgres credentials refuses a credential whose expiry has passed, on the predicate and not on a caller's memory | staging-supabase |
| 3 | AgentLinkPostgres credentials refuses two credentials with one token hash | staging-supabase |
| 4 | AgentLinkPostgres credentials refuses a token hash that is not 64 hex characters, and a credential with no project | staging-supabase |
| 5 | AgentLinkPostgres the link code moves pending to approved exactly once, however many times the form is submitted | staging-supabase |
| 6 | AgentLinkPostgres the link code hands the secret back once and destroys it in the same statement | staging-supabase |
| 7 | AgentLinkPostgres the link code cannot read the secret back from a plain RETURNING, which is why the statement is shaped that way | staging-supabase |
| 8 | AgentLinkPostgres the link code gives two concurrent pollers one token between them | staging-supabase |
| 9 | AgentLinkPostgres the link code sweeps expired codes and destroys their secrets, and a second pass finds nothing | staging-supabase |
| 10 | AgentLinkPostgres the link code refuses a state outside the five the protocol names | staging-supabase |
| 11 | AgentLinkPostgres the durable rate limiter counts inside a window and starts the next one at one | staging-supabase |
| 12 | AgentLinkPostgres the durable rate limiter keeps one row per scope, key and window, and refuses a negative count | staging-supabase |
| 13 | AgentLinkPostgres the schema itself keeps row level security on with no policies, so only the service role reaches it | staging-supabase |
| 14 | AgentLinkPostgres the schema itself indexes the credential lookups the authorization path makes | staging-supabase |

### tests/bridge/steps.test.ts

1 skipped cases. The compatibility guard requires a hard-coded Z:/Projects/.../ws-act product-port.ts path that is absent. Current repository product-port exists. Root separately matched 23 phase/title rows; this does not change the one skipped test.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 3 | worker projection compatibility matches its title/phase table and row order | Not established in parsed lane correspondence |

### tests/cli/config.test.ts

1 skipped cases. This Windows inherited-ACL assertion runs only when process.platform is win32. The local report was produced on macOS ARM64.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 3 | private login config Windows refuses inherited ACLs that grant other identities access | Not established in parsed lane correspondence |

### tests/controlplane/executor.test.ts

1 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 20 | cross-engine shape identity PGlite and PostgreSQL return deeply equal rows for the same statement | staging-platform-postgres |

### tests/controlplane/migrations.test.ts

4 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 14 | migrator [postgres] concurrency and fail-closed open schema 6 emitted hardening upgrades through the canonical migrator under a distinct owner with RLS, role isolation and immutable artifacts | staging-platform-postgres |
| 15 | migrator [postgres] concurrency and fail-closed open two migrators racing on an empty database converge: one applies, the other finds it done | staging-platform-postgres |
| 16 | migrator [postgres] concurrency and fail-closed open openPlatformDb({ kind: 'postgres' }) does not migrate unless asked, and a bare open sees the schema as behind | staging-platform-postgres |
| 17 | migrator [postgres] concurrency and fail-closed open BOOTSTRAP_SQL is idempotent | staging-platform-postgres |

### tests/controlplane/open.test.ts

2 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 15 | platformDb() against PostgreSQL opens a migrated database using ZENITH_PLATFORM_DB_URL, with the schema check passing | staging-platform-postgres |
| 16 | platformDb() against PostgreSQL fails CLOSED against an un-migrated database with the command to run, and does not cache the failure | staging-platform-postgres |

### tests/db/contract/alerts.test.ts

7 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | alerts on Postgres refuses a second standing rule for one (environment, kind) | Not established in parsed lane correspondence |
| 2 | alerts on Postgres round-trips an event through open and resolved | Not established in parsed lane correspondence |
| 3 | alerts on Postgres lets exactly one of two snapshots claim a pending row | Not established in parsed lane correspondence |
| 4 | alerts on Postgres reclaims a claim older than the lease and leaves a live one alone | Not established in parsed lane correspondence |
| 5 | alerts on Postgres refuses a second outbox row for one idempotency key | Not established in parsed lane correspondence |
| 6 | alerts on Postgres round-trips a security finding | Not established in parsed lane correspondence |
| 7 | alerts on Postgres round-trips a Navigator run | Not established in parsed lane correspondence |

### tests/db/contract/audit.test.ts

1 skipped cases. The scenario has an only-backend selector; the repeated FileStore instance is outside that scenario’s backend scope. Do not treat the FileStore repetition as an unexecuted universal backend promise.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 8 | audit contract ;  'FileStore' a retried append writes nothing twice | Not established in parsed lane correspondence |

### tests/db/contract/history.test.ts

7 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 8 | history contract ;  Postgres only seeds a second workspace to work in | Not established in parsed lane correspondence |
| 9 | history contract ;  Postgres only promotes the indexed columns and leaves them out of data | Not established in parsed lane correspondence |
| 10 | history contract ;  Postgres only reads a manifest back through the accessor with a cold cache | Not established in parsed lane correspondence |
| 11 | history contract ;  Postgres only assigns a dense seq per deployment across two instances | Not established in parsed lane correspondence |
| 12 | history contract ;  Postgres only refuses a write against a row another instance already moved | Not established in parsed lane correspondence |
| 13 | history contract ;  Postgres only bumps the change feed for the workspace a deployment belongs to | Not established in parsed lane correspondence |
| 14 | history contract ;  Postgres only keeps rows outside the snapshot's scope when it resets | Not established in parsed lane correspondence |

### tests/db/contract/workspace-sharing.test.ts

22 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | WorkspaceSharingPostgres grants execute only to the service role, excluding PUBLIC, anon and authenticated | staging-supabase |
| 2 | WorkspaceSharingPostgres keeps the owner present and administrative until ownership is transferred | staging-supabase |
| 3 | WorkspaceSharingPostgres requires the owner for granting or managing admin access and transferring ownership | staging-supabase |
| 4 | WorkspaceSharingPostgres uses actor identity rather than a claimed member email to authorize sharing | staging-supabase |
| 5 | WorkspaceSharingPostgres allows admins to manage non-admin collaborators and lets non-owners leave | staging-supabase |
| 6 | WorkspaceSharingPostgres rechecks a competing remover's authority after the owner demotes that admin | staging-supabase |
| 7 | WorkspaceSharingPostgres rechecks a competing role change after the owner removes the acting admin | staging-supabase |
| 8 | WorkspaceSharingPostgres protects the newly transferred owner against a competing removal | staging-supabase |
| 9 | WorkspaceSharingPostgres refuses a second ownership transfer from the former owner after waiting for the first | staging-supabase |
| 10 | WorkspaceSharingPostgres accepts a normalized matching email while refusing another signed-in identity's email | staging-supabase |
| 11 | WorkspaceSharingPostgres rejects a revoked invitation even when a caller retained its former live state | staging-supabase |
| 12 | WorkspaceSharingPostgres rechecks invitation revocation after a competing accept waits for the workspace lock | staging-supabase |
| 13 | WorkspaceSharingPostgres renews an expired invitation on resend, while refusing to renew a revoked offer | staging-supabase |
| 14 | WorkspaceSharingPostgres refuses expired invitations without creating membership | staging-supabase |
| 15 | WorkspaceSharingPostgres does not restore access when an accepted invitation is replayed after removal | staging-supabase |
| 16 | WorkspaceSharingPostgres preserves an existing member's role when accepting an older admin invitation | staging-supabase |
| 17 | WorkspaceSharingPostgres revokes old pending offers when a member exits through remove-member | staging-supabase |
| 18 | WorkspaceSharingPostgres revokes old pending offers when a member exits through leave | staging-supabase |
| 19 | WorkspaceSharingPostgres commits an audit event with a role change and writes no event for a refused mutation | staging-supabase |
| 20 | WorkspaceSharingPostgres lets a fresh invitation replace an expired pending offer without reviving the old one | staging-supabase |
| 21 | WorkspaceSharingPostgres allows one pending invitation per normalized address and workspace under competing requests | staging-supabase |
| 22 | WorkspaceSharingPostgres cannot use an invitation or membership id from a different workspace | staging-supabase |

### tests/execution/apply.test.ts

5 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 21 | dispatch current authority [postgres] refuses expired approval after fresh replan and before durable dispatch | staging-platform-postgres |
| 22 | dispatch current authority [postgres] refuses revoked approver role after fresh replan and before durable dispatch | staging-platform-postgres |
| 23 | dispatch current authority [postgres] refuses new policy denial after fresh replan and before durable dispatch | staging-platform-postgres |
| 24 | dispatch current authority [postgres] refuses expiry after authority check after fresh replan and before durable dispatch | staging-platform-postgres |
| 25 | dispatch current authority [postgres] refuses expiry during role lookup after fresh replan and before durable dispatch | staging-platform-postgres |

### tests/execution/deletion-guards-real.test.ts

1 skipped cases. ZENITH_TEST_DELETION_GUARDS_TOFU=1 and an available OpenTofu binary are required. The generic network provider opt-in alone does not enable this test.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | real tofu deploy removal (ZENITH_TEST_DELETION_GUARDS_TOFU=1) refuses unapproved stateful removal and applies the exact approved deletion | Not established in parsed lane correspondence |

### tests/execution/destroy-review.test.ts

2 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 19 | real Postgres destroy-review lane persists the first pending review with a readable PlanView | staging-platform-postgres |
| 20 | undecided teardown supersession [postgres] an independent partial approval wins the operation lock and prevents refresh cancellation without revoking grants | staging-platform-postgres |

### tests/hosted/artifacts/storage-store.test.ts

2 skipped cases. ZENITH_CONTRACT_POSTGRES=1, NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. The tracker branch also checks atomic functions. Disposable PostgreSQL contracts do not establish hosted bucket/data-service acceptance.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 11 | StorageArtifactStore (live bucket) puts a bundle, reads it back byte for byte, and serves a range | Not established in parsed lane correspondence |
| 12 | StorageArtifactStore (live bucket) removes everything it wrote | Not established in parsed lane correspondence |

### tests/hosted/data/pg-contract.live.test.ts

11 skipped cases. ZENITH_CONTRACT_POSTGRES=1, NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. The tracker branch also checks atomic functions. Disposable PostgreSQL contracts do not establish hosted bucket/data-service acceptance.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | the tracker contract against real Postgres tables creates, reads back and pages the records it stored | Not established in parsed lane correspondence |
| 2 | the tracker contract against real Postgres tables lets the first writer through and refuses the second with stale_version | Not established in parsed lane correspondence |
| 3 | the tracker contract against real Postgres tables replays a retried write id instead of writing a second record | Not established in parsed lane correspondence |
| 4 | the tracker contract against real Postgres tables refuses a record that would take the app past its storage ceiling, and writes nothing | Not established in parsed lane correspondence |
| 5 | the tracker contract against real Postgres tables keeps one app's records out of another app's reach | Not established in parsed lane correspondence |
| 6 | the tracker contract against real Postgres tables accounts storage as the same logical-byte figure the measure defines | Not established in parsed lane correspondence |
| 7 | the tracker contract against real Postgres tables commits the record, the counter and the ledger row together | Not established in parsed lane correspondence |
| 8 | the whole-app operations against real Postgres tables imports a bundle, skips ids already stored, and keeps the counter true | Not established in parsed lane correspondence |
| 9 | the whole-app operations against real Postgres tables reports the logical integrity check, and it passes on rows it just wrote | Not established in parsed lane correspondence |
| 10 | the whole-app operations against real Postgres tables empties the probe namespace and leaves the app's own rows alone | Not established in parsed lane correspondence |
| 11 | the whole-app operations against real Postgres tables refuses to empty anything that is not a probe namespace | Not established in parsed lane correspondence |

### tests/machines/azure-scripts.test.ts

6 skipped cases. The collector probes the literal python executable with -I. That alias was unavailable in this run although python3 exists. This is not an OS-wide Azure restriction and passing elsewhere is not Azure guest delivery proof.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | Azure fixed Python collector locally all semantic and argv collector programs compile | azure-python-followup |
| 2 | Azure fixed Python collector locally metacharacters, quotes and newlines round-trip as argv data without a shell | azure-python-followup |
| 3 | Azure fixed Python collector locally drains large output with bounded memory and a complete sub-4-KiB envelope | azure-python-followup |
| 4 | Azure fixed Python collector locally child processes receive an explicit environment without collector secrets | azure-python-followup |
| 5 | Azure fixed Python collector locally preserves the child's actual nonzero exit status | azure-python-followup |
| 6 | Azure fixed Python collector locally terminates a timed-out command and marks its outcome | azure-python-followup |

### tests/machines/ssm-documents.test.ts

13 skipped cases. The native shell harness builds sh sh -s, which fails its probe. Root independently found sh -s succeeds. The thirteen guarded script assertions remain skipped; repair is still needed. FileRead also excludes Darwin, but the earlier broken probe already disables its cases.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 84 | script behaviour: input validation (runs the real scripts under sh) refuses hostile units with exit 64 before touching systemctl | Not established in parsed lane correspondence |
| 85 | script behaviour: input validation (runs the real scripts under sh) refuses to restart protected units with exit 65 | Not established in parsed lane correspondence |
| 86 | script behaviour: input validation (runs the real scripts under sh) enforces a restart allowlist baked into the document | Not established in parsed lane correspondence |
| 87 | script behaviour: input validation (runs the real scripts under sh) an agent too old for ENV_VAR (empty variables) fails closed, naming the cause | Not established in parsed lane correspondence |
| 88 | script behaviour: input validation (runs the real scripts under sh) validates numeric, enum and boolean parameters | Not established in parsed lane correspondence |
| 89 | script behaviour: input validation (runs the real scripts under sh) refuses metadata names and malformed hosts in PortCheck and DnsCheck (exit 64/65, before any network tool) | Not established in parsed lane correspondence |
| 90 | script behaviour: input validation (runs the real scripts under sh) PortCheck refuses link-local and metadata addresses after resolution (skipped where getent is missing) | Not established in parsed lane correspondence |
| 91 | script behaviour: FileRead guards (real files in a private temp dir) reads an allowed regular file as base64 with size and truncation facts | Not established in parsed lane correspondence |
| 92 | script behaviour: FileRead guards (real files in a private temp dir) caps output at 16384 bytes whatever maxBytes says, and reports truncation | Not established in parsed lane correspondence |
| 93 | script behaviour: FileRead guards (real files in a private temp dir) refuses traversal, symlink escapes and secret-like names | Not established in parsed lane correspondence |
| 94 | script behaviour: FileRead guards (real files in a private temp dir) a symlink may point at another allowed file, but not at an unlisted one | Not established in parsed lane correspondence |
| 95 | script behaviour: FileRead guards (real files in a private temp dir) exact-file allowlist entries allow only that file | Not established in parsed lane correspondence |
| 96 | script behaviour: FileRead guards (real files in a private temp dir) reports missing files and non-regular files | Not established in parsed lane correspondence |

### tests/platform/source-bundle.test.ts

1 skipped cases. ZENITH_TEST_SOURCE_GITHUB=1 plus an authorized repository and pinned 40-hex commit are required; ordinary mocked source tests do not replace this download check.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 78 | live public GitHub source (opt-in network) downloads a pinned public commit into a source bundle | staging-workflows |

### tests/providers/kubernetes/kind.test.ts

6 skipped cases. ZENITH_TEST_KIND=1 and a disposable KUBECONFIG are required; release tests also require a pinned non-root release image. Dedicated kind reports are listed separately.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | kubernetes provider against a real cluster (kind) creates the namespace, policy and workload, then a second apply changes nothing | staging-kind |
| 2 | kubernetes provider against a real cluster (kind) rolls out, and the drivers observe, verify and report runtime | staging-kind |
| 3 | kubernetes provider against a real cluster (kind) refuses to touch a same-named object it does not own | staging-kind |
| 4 | kubernetes provider against a real cluster (kind) restarts, scales and reads logs and events through the operations | staging-kind |
| 5 | kubernetes provider against a real cluster (kind) deploys a new image, rolls back to the previous revision, and the pods follow | staging-kind |
| 6 | kubernetes provider against a real cluster (kind) prunes what is no longer desired and never deletes the namespace | staging-kind |

### tests/providers/kubernetes/release-kind.test.ts

1 skipped cases. ZENITH_TEST_KIND=1 and a disposable KUBECONFIG are required; release tests also require a pinned non-root release image. Dedicated kind reports are listed separately.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | Kubernetes release ports against a disposable kind cluster rolls out a pre-built digest, observes readiness and runs exactly one migration Job across retries | staging-kind |

### tests/scripts/migrate-hosted-to-postgres.test.ts

3 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 13 | migrate-hosted-to-postgres ;  against the real Supabase project copies the control tables, verifies, and inserts nothing on a second run | staging-supabase |
| 14 | migrate-hosted-to-postgres ;  against the real Supabase project copies the app's data, verifies, and inserts nothing on a second run | staging-supabase |
| 15 | migrate-hosted-to-postgres ;  against the real Supabase project leaves no contract- rows behind | staging-supabase |

### tests/secrets/rewrap.test.ts

1 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 57 | real Postgres vault re-wrap commits product rows and audit together, then resumes idempotently | fresh-uncovered-postgres |

### tests/security/plan-artifact-secrecy.test.ts

1 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | encrypted plan artifact secrecy [postgres] sensitive read-only originals persist only ciphertext; key rotation, tenant domains and tampering fail closed | staging-platform-postgres |

### tests/security/workflow-history.test.ts

2 skipped cases. ZENITH_SEC_TEMPORAL=1 is required for these actual history checks, with a local test server. This flag is separate from ordinary Temporal suite enablement.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 9 | real Temporal history (opt-in; fake activities) ids/digests-only inputs and fake activity results leave synthetic node specs outside history | staging-workflows |
| 10 | real Temporal history (opt-in; fake activities) SEC-F12: runtime node-spec extras are absent from actual durable history | staging-workflows |

### tests/sources/github-live.test.ts

1 skipped cases. ZENITH_TEST_SOURCE_GITHUB_APP=1 plus app configuration, repository binding and a pinned commit are required. Store-only GitHub tests do not prove private App token/download acceptance.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | private GitHub App source (opt-in network) downloads the bound repository at a pinned commit with an ephemeral scoped token | Not established in parsed lane correspondence |

### tests/sources/github-store.test.ts

10 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 11 | GitHub source Postgres store (opt-in) persists only identifiers and proof digests, and resolves bindings by workspace | fresh-uncovered-postgres |
| 12 | GitHub source Postgres store (opt-in) refuses a changed callback workspace without consuming the legitimate intent | fresh-uncovered-postgres |
| 13 | GitHub source Postgres store (opt-in) refuses a changed callback actor without consuming the legitimate intent | fresh-uncovered-postgres |
| 14 | GitHub source Postgres store (opt-in) refuses a changed callback browser without consuming the legitimate intent | fresh-uncovered-postgres |
| 15 | GitHub source Postgres store (opt-in) refuses a changed callback state without consuming the legitimate intent | fresh-uncovered-postgres |
| 16 | GitHub source Postgres store (opt-in) refuses expired intents at both transitions using database time | fresh-uncovered-postgres |
| 17 | GitHub source Postgres store (opt-in) allows only one racing setup and one racing OAuth callback | fresh-uncovered-postgres |
| 18 | GitHub source Postgres store (opt-in) stores hashed state/proof and never lets an install callback skip OAuth | fresh-uncovered-postgres |
| 19 | GitHub source Postgres store (opt-in) rejects stale/racing bind intents rather than overwriting another admin's binding | fresh-uncovered-postgres |
| 20 | GitHub source Postgres store (opt-in) validates identifiers and numeric IDs without reflecting malicious data | fresh-uncovered-postgres |

### tests/tofu/plan-artifact-handoff.test.ts

8 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | authenticated original cross-worker handoff [postgres] producer exits and loses its directory; another worker applies ORIGINAL bytes after a separate fresh check, then destroys | staging-platform-postgres |
| 2 | authenticated original cross-worker handoff [postgres] fresh semantic drift refuses before dispatch and has no original/fresh fallback | staging-platform-postgres |
| 3 | authenticated original cross-worker handoff [postgres] source/config/backend/address-map/lock/tool and operation swaps refuse before mutation | staging-platform-postgres |
| 4 | authenticated original cross-worker handoff [postgres] tampering with the original after inspection refuses before apply and preserves uncertainty after dispatch | staging-platform-postgres |
| 5 | authenticated original cross-worker handoff [postgres] source review completes, browser human approval is consumed, and destination destroys the associated ORIGINAL | staging-platform-postgres |
| 6 | authenticated original cross-worker handoff [postgres] restore into a fresh PostgreSQL store with matching keys preserves the original; missing keys refuse | staging-platform-postgres |
| 7 | authenticated original cross-worker handoff [postgres] fake cipher authority and arbitrary runner handles cannot mint production admission | staging-platform-postgres |
| 8 | authenticated original cross-worker handoff [postgres] stale original state serial refuses even when independent fresh semantic plan is unchanged, with no fallback | staging-platform-postgres |

### tests/waitlist/pg-contract.test.ts

38 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | WaitlistPostgres lets only Supabase Auth invoke the signup hook and read admitted email/status columns | staging-supabase |
| 2 | WaitlistPostgres rejects absent/queued signups identically and admits the email only after operator admission | staging-supabase |
| 3 | WaitlistPostgres normalizes duplicate joins and preserves the original answers, position and admission | staging-supabase |
| 4 | WaitlistPostgres enforces email 254, occupation 120 and use-case 2000 boundaries in PostgreSQL | staging-supabase |
| 5 | WaitlistPostgres accepts email alone and persists bounded optional profile answers | staging-supabase |
| 6 | WaitlistPostgres lists stable FIFO pages with global counts and admits the oldest queued positions | staging-supabase |
| 7 | WaitlistPostgres refuses an admission count of 0 without changing the queue | staging-supabase |
| 8 | WaitlistPostgres refuses an admission count of -1 without changing the queue | staging-supabase |
| 9 | WaitlistPostgres refuses an admission count of 1001 without changing the queue | staging-supabase |
| 10 | WaitlistPostgres refuses an admission count of null without changing the queue | staging-supabase |
| 11 | WaitlistPostgres accepts both count boundaries and never fills a batch with already admitted users | staging-supabase |
| 12 | WaitlistPostgres replays UUID requests exactly and rejects changed count or actor without admitting more | staging-supabase |
| 13 | WaitlistPostgres persists empty batches so replay cannot admit a later join | staging-supabase |
| 14 | WaitlistPostgres deduplicates simultaneous case-varied joins on independent connections | staging-supabase |
| 15 | WaitlistPostgres serializes overlapping batches into disjoint consecutive FIFO admissions | staging-supabase |
| 16 | WaitlistPostgres replays a concurrently retried request instead of admitting a second batch | staging-supabase |
| 17 | WaitlistPostgres waits for an earlier joining transaction before admitting the queue | staging-supabase |
| 18 | WaitlistPostgres persists an actor-bound FIFO preview without changing the queue | staging-supabase |
| 19 | WaitlistPostgres validates preview modes, counts and exact unique selected IDs | staging-supabase |
| 20 | WaitlistPostgres captures all queued IDs beyond display/count limits and excludes later arrivals | staging-supabase |
| 21 | WaitlistPostgres waits for an in-flight join when creating a preview and locks later joins out of its snapshot | staging-supabase |
| 22 | WaitlistPostgres serializes overlapping snapshots and admits each captured queued entry only once | staging-supabase |
| 23 | WaitlistPostgres replays concurrent preview requests exactly and consumes a preview only once | staging-supabase |
| 24 | WaitlistPostgres rejects another operator, missing previews and expired unused previews without admissions | staging-supabase |
| 25 | WaitlistPostgres prevents request-key reuse across legacy admission and selected previews | staging-supabase |
| 26 | WaitlistPostgres prevents request-key reuse across legacy admission and next previews | staging-supabase |
| 27 | WaitlistPostgres prevents request-key reuse across legacy admission and all previews | staging-supabase |
| 28 | WaitlistPostgres persists zero-count previews and batches without admitting later arrivals | staging-supabase |
| 29 | WaitlistPostgres records newest-first exact admission history including overlap and legacy batches | staging-supabase |
| 30 | WaitlistPostgres returns immutable saved history details and null for an unknown request | staging-supabase |
| 31 | WaitlistPostgres paginates immutable history rows with bounded pages and validates offsets | staging-supabase |
| 32 | WaitlistPostgres filters literal profile text with cursor-independent matched counts and global totals | staging-supabase |
| 33 | WaitlistPostgres grants only service_role the waitlist RPCs, tables and queue sequence | staging-supabase |
| 34 | WaitlistPostgres refuses direct reads, writes and RPC invocation as anon | staging-supabase |
| 35 | WaitlistPostgres refuses direct reads, writes and RPC invocation as authenticated | staging-supabase |
| 36 | WaitlistPostgres refuses direct reads, writes and RPC invocation as supabase_auth_admin | staging-supabase |
| 37 | WaitlistPostgres enforces RLS even with temporary browser SELECT grants and rolls those grants back | staging-supabase |
| 38 | WaitlistPostgres enforces the rate-limit quota and resets an expired counter as service_role | staging-supabase |

### tests/workflows/codec-replay.test.ts

2 skipped cases. The shared serverSuite tries an existing local CLI or configured time-skipping server; downloads require explicit permission. Required Temporal lanes fail rather than skip when unavailable. Default unit lacks these enabled server prerequisites.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | codec histories on local Temporal (ZENITH_TEST_TEMPORAL=1) encrypts workflow/activity payloads, supports queries/signals and replays with retained keys | staging-workflows |
| 2 | codec histories on local Temporal (ZENITH_TEST_TEMPORAL=1) replays a legacy plaintext history with an encrypted converter | staging-workflows |

### tests/workflows/destroy-replay.test.ts

6 skipped cases. The shared serverSuite tries an existing local CLI or configured time-skipping server; downloads require explicit permission. Required Temporal lanes fail rather than skip when unavailable. Default unit lacks these enabled server prerequisites.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | real destroy workflow histories (ZENITH_TEST_TEMPORAL=1) happy runs and replays against the current definitions | staging-workflows |
| 2 | real destroy workflow histories (ZENITH_TEST_TEMPORAL=1) plan_changed runs and replays against the current definitions | staging-workflows |
| 3 | real destroy workflow histories (ZENITH_TEST_TEMPORAL=1) lease_lost runs and replays against the current definitions | staging-workflows |
| 4 | real destroy workflow histories (ZENITH_TEST_TEMPORAL=1) approval_reject runs and replays against the current definitions | staging-workflows |
| 5 | real destroy workflow histories (ZENITH_TEST_TEMPORAL=1) unknown_absence runs and replays against the current definitions | staging-workflows |
| 6 | real destroy workflow histories (ZENITH_TEST_TEMPORAL=1) preserves and replays the deploy command sequence | staging-workflows |

### tests/workflows/mtls-live.test.ts

2 skipped cases. ZENITH_TEST_TEMPORAL_MTLS=1 and an authorized external namespace, address and certificate/key files are required. Disposable local Temporal does not prove external mTLS.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | external Temporal mTLS (ZENITH_TEST_TEMPORAL_MTLS=1) web transport authenticates and reads the configured namespace | Not established in parsed lane correspondence |
| 2 | external Temporal mTLS (ZENITH_TEST_TEMPORAL_MTLS=1) worker transport authenticates and reads the configured namespace | Not established in parsed lane correspondence |

## staging-tofu

8 skipped cases. Source 356b7d0.

### tests/tofu/plan-artifact-handoff.test.ts

8 skipped cases. This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition.

| Case ordinal | Case | Separate unchanged-source pass |
| --- | --- | --- |
| 1 | authenticated original cross-worker handoff [postgres] producer exits and loses its directory; another worker applies ORIGINAL bytes after a separate fresh check, then destroys | staging-platform-postgres |
| 2 | authenticated original cross-worker handoff [postgres] fresh semantic drift refuses before dispatch and has no original/fresh fallback | staging-platform-postgres |
| 3 | authenticated original cross-worker handoff [postgres] source/config/backend/address-map/lock/tool and operation swaps refuse before mutation | staging-platform-postgres |
| 4 | authenticated original cross-worker handoff [postgres] tampering with the original after inspection refuses before apply and preserves uncertainty after dispatch | staging-platform-postgres |
| 5 | authenticated original cross-worker handoff [postgres] source review completes, browser human approval is consumed, and destination destroys the associated ORIGINAL | staging-platform-postgres |
| 6 | authenticated original cross-worker handoff [postgres] restore into a fresh PostgreSQL store with matching keys preserves the original; missing keys refuse | staging-platform-postgres |
| 7 | authenticated original cross-worker handoff [postgres] fake cipher authority and arbitrary runner handles cannot mint production admission | staging-platform-postgres |
| 8 | authenticated original cross-worker handoff [postgres] stale original state serial refuses even when independent fresh semantic plan is unchanged, with no fallback | staging-platform-postgres |
