# Agent outcome receipts

An agent can finish an accepted provider request after the control plane has stopped waiting. The signed result endpoint now retains that outcome as permanent encrypted evidence. A cancelled or timed-out job stays terminal, and its operation stays uncertain. Receipt acknowledgement authorizes neither replay nor cleanup.

## Protocol and persistence

The existing result route verifies Ed25519 over the request path, timestamp, nonce and exact body digest against the currently active registered agent, then checks the URL agent. The result body supplies no workspace, agent key, approval flag or authority proof. A revoked agent's result request remains refused. The service parses a closed outcome schema and bounds JSON depth, node count and UTF-8 size to the existing 16 MiB result limit; validation errors do not quote arbitrary keys or values.

The store checks the authenticated current key and original assignment again in one transaction. It locks the active agent with `FOR SHARE`, then its workspace-scoped original job with `FOR UPDATE`, matching revocation's agent-before-job order. It derives eligibility from the locked row after waits. Only an originally claimed/running job is eligible; queued, expired and cancelled-before-claim work cannot mint evidence. Runner and machine queues follow the same contract.

| Locked projection | First authenticated outcome |
| --- | --- |
| claimed or running | Insert immutable receipt and perform the existing active settlement atomically. |
| cancelled or timed_out with original claim | Insert immutable late evidence; leave every job and operation projection field unchanged. |
| queued, expired, cancelled without claim, definitive terminal without receipt | Refuse; do not fabricate earlier evidence. |
| Existing receipt, exact logical digest/assignment/current key | Acknowledge idempotently; preserve the first ciphertext/time, with no repeated transition/event. |
| Existing receipt, different logical outcome | Conflict 409; the original evidence permanently wins. |

The logical SHA-256 digest uses canonical parsed JSON, including status, timing, exit code, result and error. Object key order does not change it; different reported timing/error/data does. Receipt identity is workspace + agent kind + job. It also retains original operation/kind/capability, envelope digest, current agent-key digest, original DB claim time and DB receipt time. These bounded identifiers/statuses/digests are the only clear metadata. Keep the journal and its logical fingerprints private; a digest is not a redaction guarantee for predictable data.

The full outcome, including raw error and resource URLs, is AES-256-GCM sealed before persistence under `workspace|agentKind|job|agentId|agentKeyDigest|envelopeDigest|effect-receipt:v1` AAD. The service derives these associations from the authenticated identity and immutable original assignment; the store independently derives the retained key/envelope hashes under its current-agent and original-job locks. Result bodies cannot supply these associations. Decryption using substituted tenant/job/agent/key/envelope metadata fails authentication. No raw result/log/error/URL is stored in the receipt or emitted in its acknowledgement. Existing active-job result AAD and redacted error projection remain compatible with the historical awaiter. Late evidence never replaces those projections. Historical completion events are emitted only for a newly settled active job; the receipt itself is the durable audit record for late evidence. An auxiliary completion-event sink failure cannot roll back a committed receipt.

Migration 11 creates the tenant-indexed receipt table, enables RLS, revokes anon/authenticated access and conditionally resets service_role privileges to SELECT/INSERT. Both the canonical migration and aggregate emitter explicitly revoke inherited UPDATE/DELETE privileges. Immutable-row triggers independently refuse changes and removal. Composite job FKs prevent deletion of the original assignment while evidence is retained. Additional queue triggers preserve assignment/envelope fields and the first non-null claim timestamp. Retrying delivery cannot alter ciphertext, recreate a writer, release a barrier or reopen a grant/job/operation. A rolled-back transaction retains neither a receipt nor an active settlement; lost acknowledgement after commit retains the first receipt for a new signed retry.

## Integration and verification

Migration 11 is registered after migrations 8/9/10, with regenerated aggregate SQL and table/role/owner inventories. Canonical gates require 40 named receipt cases on actual PostgreSQL and both fresh and same-owner schema 6 privilege upgrade cases. A worker deployed without the receipt schema fails storage rather than falling back to file/memory or silently discarding the outcome.

`tests/runners/late-effect-receipts.test.ts` runs both agent kinds on memory, PGlite and opt-in actual PostgreSQL (`ZENITH_TEST_PLATFORM_PG_URL`). Only PostgreSQL uses independent physical pools. Mandatory cases include active success, cancelled-after-claim/running, timeout, exact and divergent retries, never-claimed/expired refusal, current revoked identity, foreign assignment, signature/schema refusal, rollback, committed lost acknowledgement, audit delivery failure, encrypted AAD/key binding, immutable DB records and an observed PG job-lock waiter where cancellation wins. No mocked DB supplies acceptance evidence. Database fixtures use the canonical migrator and assert its complete registered schema; integrated acceptance also requires the aggregate SQL route.

The acknowledgement-loss case injects a throw after the actual store commit and verifies a fresh signed retry. It checks the commit/response boundary; it is not a process-kill or real HTTP-disconnect rehearsal. The rollback case uses a real database transaction. Worker/process crash and network-disconnect runtime evidence remain pending.

Normal result and dispatch suites now assert encrypted late evidence and an unchanged cancelled projection. The first timeout waiter returns `timed_out`; a later waiter reads `cancelled` with `uncertain: true`, never the late reported success. Neighbouring normal result/dispatch/authentication suites remain required. Exact-candidate real PostgreSQL, aggregate SQL and combined runtime gates remain necessary before integration acceptance; source review and compiler success alone do not establish them.

## Limits

An authenticated agent report establishes what that active agent reported. It does not independently prove provider terminal state, absence of a surviving child, complete historical writer/session inventory or shared cleanup quiescence. Current-key authentication is mandatory; revocation cannot retract a provider write. Previously rejected/discarded outcomes are not reconstructed, and pre-migration assignment provenance is not upgraded into cryptographic history by the new triggers.

The existing result sealer uses one configured or derived key, with no old-key keyring. Losing/rotating that key can make historical ciphertext unreadable; this contract adds no privileged fallback or synthetic plaintext recovery. The row/digests remain retained, and an exact retry can still acknowledge its committed identity without replacing the original ciphertext. Key custody/backup and provider-specific fresh resolution remain separate work. The memory implementation is a local/test semantic model; production durability requires canonical PostgreSQL authority.
