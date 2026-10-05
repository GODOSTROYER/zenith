# PROD-LIFE-01 Connection administration lifecycle

## 1. Summary of what was built

Audit first. Before this change: AWS and Kubernetes had create and verify actions, GCP/Azure/OCI had no create path at all, nothing could revoke or rotate a connection (the repo had an unused `connections.revoke`), `connection.disconnect` forgot the product row but left the platform trust record verified and dispatchable, there was no REST or CLI surface for any connection verb, and runner-backed connections had no lifecycle beyond the runner registry routes.

Now the five verbs (create, verify, revoke, rotate, plus promote/abort as the two halves of rotation) exist for AWS, GCP, Azure, OCI and Kubernetes through the UI, the action registry (`/api/actions`), REST and the CLI, behind one service.

Files (new):
- `src/lib/connections/schemas.ts`: strict identifier-only input contracts (create GCP/Azure/OCI, revoke, rotate, rotation ref) and `applyRotationPatch`, which can never change provider, mode or the pinned identity (account, project, tenant, subscription, tenancy, API server). Shared by UI, REST, actions and the CLI's local pre-check.
- `src/lib/connections/service.ts`: `createProviderConnection`, `verifyAnyConnection`, `revokeConnection`, `rotateConnection` (stage + verify candidate + optional promote), `promoteRotation`, `abortRotation`, `listConnections`, `describeConnection`, `previewRotation`.
- `src/lib/actions/defs/connection-lifecycle.ts`: actions `connection.createGcp|createAzure|createOci|verify|revoke|rotate|promoteRotation|abortRotation` (human, role re-read live; agents/Navigator/integration contexts refused; deliberately absent from the capability bridge like the other connection actions).
- `src/lib/controlplane/db/migrations/0022_connection_rotations.ts` (version 22): `platform.connection_rotations`.
- `src/lib/controlplane/db/repos/connection-rotations.ts`: `stage`, `get`, `getOpen`, `list`, `recordCandidateVerification`, `abort`, `promote`.
- `src/app/api/platform/v1/connections/**` (8 route methods) and `src/app/api/platform/v1/_lib/connections.ts`.
- `src/app/(product)/platform/connections/{page,connection-admin}.tsx`: lifecycle console.
- Tests: `tests/connections/lifecycle.test.ts`, `tests/connections/rotations-repo.test.ts`, `tests/cli/connections.test.ts`.

Files (edited): `repos/connections.ts` (`revokeAudited`, `appendLifecycleEvent`), `repos/index.ts`, `migrations/index.ts`, `controlplane/types.ts` (6 `connection.*` event types), `components/platform/event-sentences.ts`, `actions/defs/{connection,index}.ts` (disconnect now revokes the platform record first, and refuses to forget the product row if that cannot be recorded), `lib/platform/credentials.ts` (new `verifyCandidate` broker option, verification-only), `lib/bridge/deps.ts` (`providerBroker` dep), `lib/domain/types.ts` (`CloudConnection.revokedAt`), `lib/sdk/{client,types}.ts`, `cli/{main,input,output}.ts`, `_lib/bearer-paths.ts`, platform layout nav, settings `access.ts`/`shared.ts`, `docs/platform/CLI.md`, `tests/middleware/platform-bearer.test.ts` (new routes classified, inventory 48 to 56).

Design decisions:
- Revocation is the existing terminal `revoked` status, committed in one transaction with the audit event and with any open rotation discarded. Every session path already re-reads that status (platform broker, AWS broker, k8s/OCI admission, `executionRoute` requires `verified`, workflow-start authority requires `verified` and `revoked_at is null`). No cache, no fallback connection, no sandbox route. In-flight provider sessions already minted expire within 15 minutes; the result says so and lists the customer-side step.
- Rotation without downtime: the candidate is stored beside the live config and verified under the SAME connection id and workload subject (broker `verifyCandidate` for GCP/Azure/OCI/K8s; resolver substitution for AWS). Live access keeps serving; one transactional compare-and-swap promotes it (refused when revoked, when the live config changed since staging, when not verified, or when the verification is older than 60 minutes). Failed candidates can never be promoted.
- Runners: no runner key internals touched. OCI connections rotate by swapping `runnerId` to another active registered runner; `retirePreviousRunner`/`revokeRunner` call the existing `revokeAgent` and only when no other live connection uses that runner.
- CLI/REST trust model (flag for the orchestrator): `list/show/verify/revoke` accept a human-bound linked credential (acting as its human, role re-read live, revoke needs an explicit `confirm` equal to the id). `create/rotate/promote/abort` change what Zenith can reach and are browser-only (`browser-only` in bearer-paths); the CLI validates locally and hands off with exit 3, like `approve`. Flip one entry in `bearer-paths.ts` to change either decision.

## 2. Acceptance mapping

"Default create/onboard/verify/revoke/rotate flows work through UI/API/CLI for supported providers and customer runners."

| Clause | Implementation | Tests |
|---|---|---|
| create GCP/Azure/OCI (identifiers only, pending, trust values, creation event) | `connection.createGcp/Azure/Oci`, POST `/connections`, UI Connect panel, CLI create (validate + handoff). AWS/K8s keep `createAws`/`createKubernetes`. | `lifecycle.test.ts` create block; `connections.test.ts` handoff |
| onboard runner-backed (customer runner) | OCI create requires an active registered runner in the workspace; verify checks active, fresh, protocol, `oci.http`; runner registration stays the existing browser token flow | `lifecycle.test.ts` "OCI" cases |
| verify with readback | `connection.verify` (any provider; AWS/K8s delegate to their existing actions), POST `/{id}/verify`, UI Verify, CLI verify; records only if not revoked; says what was not proven | verify block |
| revoke blocks dispatch immediately | `connection.revoke`, `revokeAudited`; broker, `executionRoute`, authority read the status | revoke block ("blocks the very next dispatch", real broker `connection_revoked`, no cloud fetch) |
| rotate without downtime | `connection.rotate/promoteRotation/abortRotation`, REST, UI, migration 22, `applyRotationPatch` | rotate block (mid-rotation deploy session still works; failed candidate never promoted; stale/changed refused; AWS ExternalId; OCI runner) |
| audit events | product audit row by `runAction`; platform events `connection.created/verified/revoked/rotation_staged/rotated/rotation_aborted` written in the same transaction as the state change | "idempotent, audited, one event"; rotate events; `rotations-repo.test.ts` |
| tenancy | every repo function filters `workspace_id`; foreign id equals missing id | `rotations-repo.test.ts` first test; foreign-id test |
| no secrets | strict schemas, `assertNoSecretKeys`, ExternalId only in the one-time rotate answer and never in events | create rejection cases; "ExternalId ... never in events" |

## 3. Verification commands (other machine)

```
npx vitest run tests/connections tests/cli/connections.test.ts tests/middleware/platform-bearer.test.ts
npx vitest run tests/bridge/connection-aws.test.ts tests/bridge/connection-kubernetes.test.ts tests/actions/connection-env-isolation.test.ts tests/platform/credentials-verification.test.ts tests/cli
npx vitest run tests/controlplane/migrations.test.ts tests/controlplane/tenancy.test.ts tests/security/controlplane-sql-scoping.test.ts tests/capabilities/action-bridge.test.ts tests/docs/operator-docs.test.ts
npx tsc --noEmit -p . && npx eslint src/lib/connections src/app/api/platform/v1/connections src/cli
```
No env vars: PGlite plus the synthetic cloud fetch. Expected: all pass. The first three groups also need the assembler updates listed below.

## 4. Known gaps and shared-file updates for the orchestrator

- Migration 22 is registered after 20 (21 is another worker's). `emit.ts` hardening grant, `supabase/migrations/*` regeneration, `DEPLOYING.md` inventory row, `tests/controlplane/migrations.test.ts` table list: assembler.
- New store functions (tenancy classification; all take `workspaceId` and filter on it in SQL, none are system-scoped):
  `connectionRotations.stage|get|getOpen|list|recordCandidateVerification|abort|promote`, `connections.revokeAudited|appendLifecycleEvent`. New table `platform.connection_rotations` (tenant-owned, RLS enabled, service_role select/insert/update only). `tenancy.test.ts` and `controlplane-sql-scoping` need these rows.
- `tests/middleware/platform-bearer.test.ts` count (56) conflicts if another worker also adds platform routes; recompute at assembly.
- `tests/capabilities/action-bridge.test.ts`: I added the 8 new `connection.*` ids to its exact "deliberately unmapped (agent-refused)" list; merge with any other worker adding actions.
- OCI is not a product `ProviderId`, so an OCI connection exists only as a platform record (no product mirror, environments cannot select it through `env.setConnection`). Pre-existing; not widened here.
- GCP/Azure/AWS `runner` mode connections cannot be created or verified (the broker reports the transport unavailable); out of scope.
- Revoking cannot end provider sessions already minted (up to 15 minutes) nor remove customer trust; the answer lists the customer steps.
- AWS ExternalId rotation is zero-downtime only if the operator lists both ExternalIds in the role trust conditions during the window; Zenith states this, it cannot enforce it.
- `retirePreviousRunner`/`revokeRunner` call `revokeAgent` and are covered by the in-use check only through code review, not a test (the runner runtime needs its own harness).
- Bearer-route snapshot behavior on Postgres (member slice of the credential subject, product mirror via `save()`) was reasoned from `route()`, not exercised. No test calls the route handlers themselves (only wire/CLI and the inventory).
- Nothing here is live-cloud evidence. Tests were not run on this machine (build-only rule); typecheck and eslint were.

## 5. Suggested ledger implementationStatus

"implemented_unverified: create/verify/revoke/rotate for aws, gcp, azure, oci, kubernetes via UI, REST and CLI (create/rotate/promote browser-only; CLI hands off), staged zero-downtime rotation with candidate verification, immediate terminal revoke blocking all dispatch paths, platform events and audit, migration 22; contract + local_engine tests written, not yet run"
