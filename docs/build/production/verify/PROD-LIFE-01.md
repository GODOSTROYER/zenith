# PROD-LIFE-01 Connection administration lifecycle

## J7 runner connections, 8 October 2026

J7 adds strict, identifier-only `mode: "runner"` creation for AWS, GCP, Azure,
OCI and Kubernetes to the existing browser-only POST `/api/platform/v1/connections`.
`connection.createRunner` is loaded by that route's lifecycle runner and uses
the existing action role enforcement, audit and idempotency machinery. It refuses
nonhuman, integration and nonadmin contexts and re-reads current membership.
Create and its platform event commit together. Registered runners must belong
to the workspace and be active; creation neither contacts a cloud nor verifies.

Verification checks registration, heartbeat freshness, the served protocol
window, the advertised job kind and credential custody. Required kinds are
`aws.http`, `tofu.run` (GCP/Azure), `oci.http`, and `k8s.http`. Verification holds
connection and runner row locks and checks the exact binding again before
recording state and its platform event in one transaction. A failed check records
`failed`; an event failure rolls back the status change. Rotation checks the
candidate using the same readiness function and rechecks it under locks at
promotion. Runner rotation adds `runnerId` while retaining the existing provider
access-field contracts; provider, mode, target identity and custody stay pinned.
Kubernetes runner rotation accepts only `runnerId`. Terminal revocation and retirement reuse the
existing repositories and runner service, including the shared-runner refusal.

With the production Postgres product store, runner verification also uses the
existing repository-issued verification capture and final guarded recording:
default product topology, exact native tuple and live membership are rechecked.
An unavailable capture is refused, never replaced by the contract/file-store
recording path. This production authority join requires the operated browser
lane; the file-mode SQL/handler contracts below do not exercise it.

**Evidence boundary:** a successful runner verification proves readiness of the
registered runner only. It does not prove cloud identity, connectivity, provider
permissions or deployment. GCP/Azure direct runner provider sessions and
Kubernetes runner broker/guest sessions remain explicitly refused by their
existing callers; J7 does not add transports or weaken execution guards. OCI
still has no product-provider mirror. Live cloud acceptance is deferred.

Changed/new files: `src/lib/connections/{schemas,service,runner,runner-action}.ts`,
`src/app/api/platform/v1/{connections/route,_lib/connections}.ts`,
`src/cli/main.ts`, `tests/connections/{runner-routes,runner-browser}.test.ts`,
`tests/cli/connections.test.ts`, this document and the LIFE-01 ledger row.
No migrations, SQL snapshots, dependencies or execution-core changes.

| Acceptance clause | J7 implementation and checks |
|---|---|
| Customer runner create/onboard | Browser-only POST with `CreateRunnerInput`; signed registration through real runner route and platform SQL in `runner-routes.test.ts`, all five provider shapes |
| Verify | `verifyRunnerReadiness`, scoped transactional recording; revoked/stale/protocol/kind/custody refusal cases; no provider broker calls |
| Rotate/revoke | Existing handlers and action auditing; staged/live distinction, failed and subsequently revoked candidates, immediate terminal revoke, shared and unused runner retirement |
| Human consent | Existing browser guard refuses all bearer/actor headers and foreign/missing Origin; identity outage, anonymous and role refusals; linked-human verify/revoke requires exact revoke confirmation |
| CLI initiates, browser confirms (T16) | CLI validates runner identifiers and returns the signed-in browser URL with exit 3, sends no request; Kubernetes handoff explains the separate deployer |
| UI/API/CLI operated join | Gated real OCI UI journey in `runner-browser.test.ts`, using CLI handoff, visible Save/Verify/Rotate/Promote/Revoke controls and independent GET readback; other runner UI modes require owner join below |
| Audit and replay | Exact platform event sequence/actor plus product audit; creation idempotency and platform event outage rollback |

### Mac commands

Use Node 22. Run each lane serially. PGlite/pure contract lane:

```sh
npx vitest run tests/connections/runner-routes.test.ts tests/connections/lifecycle.test.ts tests/connections/rotations-repo.test.ts tests/connections/runner-browser.test.ts tests/cli/connections.test.ts --no-file-parallelism --maxWorkers=2
```

Without native/browser env vars, the 32 PostgreSQL cases and one browser case
are skipped with their prerequisite named in the suite. They are never passes.
The PGlite and native route suites stub identity/linked-credential authority
responses and boot, use file-mode product membership/audit, and use actual
platform SQL plus signed runner registration. Native route results therefore
prove SQL/handler contracts, not Supabase Auth, PostgREST, pooler or the default
stack. No mocked fetch is represented as provider proof.

Native PostgreSQL lane (disposable local database only). Reuse the verifier's
owned PostgreSQL if available, or start this lean one-container profile:

```sh
j7Container="zenith-j7-pg-$(date +%s)"
j7Password="$(openssl rand -hex 24)"
export POSTGRES_PASSWORD="$j7Password"
docker run -d --name "$j7Container" --label zenith.acceptance=j7 \
  --memory=384m --cpus=1 --shm-size=64m -p 127.0.0.1:5547:5432 \
  -e POSTGRES_PASSWORD -e POSTGRES_DB=zenith_runner postgres:16-alpine \
  -c shared_buffers=64MB -c max_connections=12
for attempt in $(seq 1 60); do
  docker exec "$j7Container" pg_isready -U postgres -d zenith_runner -q && break
  sleep 1
done
docker exec "$j7Container" psql -U postgres -d zenith_runner -v ON_ERROR_STOP=1 \
  -c 'create role anon nologin; create role authenticated nologin; create role service_role nologin;'
export ZENITH_TEST_PLATFORM_PG_URL="postgresql://postgres:$j7Password@127.0.0.1:5547/zenith_runner"
j7TestStatus=0
npx vitest run tests/connections/runner-routes.test.ts --no-file-parallelism --maxWorkers=2 || j7TestStatus=$?
unset ZENITH_TEST_PLATFORM_PG_URL POSTGRES_PASSWORD j7Password
docker rm -f "$j7Container"
test "$j7TestStatus" -eq 0
```

Expected: 33 PGlite plus 32 native cases pass, zero skipped/failed (the extra
PGlite case refuses a native verification capture on an embedded handle). Native
fixtures migrate this disposable database and clean only their generated
workspace rows. This lean lane has no TLS/pooler claim; use the default stack
lane for those acceptance clauses. No cloud service is required or called.

Operated browser lane: first start the J1 reduced-resource local stack and the
J2 owned runners, then sign in as its current workspace admin (AAL2 if J3
requires it). Export that **local test account's** Playwright storage state to a
private file. Keep two genuine registered runners advertising `oci.http` active
and heartbeating. Use their ids in a private identifier-only JSON file:

```json
{"input":{"provider":"oci","mode":"runner","runnerId":"<first registered id>","region":"us-ashburn-1","tenancyOcid":"<sandbox tenancy OCID>","compartmentOcid":"<sandbox compartment OCID>"},"nextRunnerId":"<second registered id>"}
```

```sh
export ZENITH_TEST_RUNNER_BROWSER=1
export ZENITH_TEST_BROWSER_BASE_URL=http://127.0.0.1:3000
export ZENITH_TEST_BROWSER_STORAGE_STATE=/private/path/local-admin-storage-state.json
export ZENITH_TEST_RUNNER_BROWSER_INPUT_FILE=/private/path/j7-runner-identifiers.json
export ZENITH_TEST_CHROMIUM_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
npx vitest run tests/connections/runner-browser.test.ts --no-file-parallelism --maxWorkers=2
```

Expected: one actual browser case passes with no skipped cases. Explicit gate
with missing prerequisites fails. The harness accepts only a loopback base URL,
uses the operated UI without route interception and makes no cloud call. Keep
browser execution serial on the 8 GB Mac; PostgreSQL needs only the 384 MiB
profile above, and the J1 stack must fit the verifier's 4 GiB Docker profile.
J1/J2 startup scripts are not in this base checkout; the orchestrator must merge
those jobs before this command is runnable. Browser UI acceptance is pending.

### Owner joins and open acceptance

- UI component ownership is outside J7. Update
  `src/app/(product)/platform/connections/connection-admin.tsx` to offer explicit
  runner mode for AWS/GCP/Azure/Kubernetes, validated by `CreateRunnerInput`,
  POST the full schema to the existing endpoint, and show `runnerId` as the only
  runner rotation field for every provider. Its general intro and Verify success
  title currently claim identity proof and must use the readiness scope instead.
  OCI's current form already reaches the tested lifecycle. Do not count the new
  provider UI choices as complete until this join and actual browser proof run.
- If exposing `connection.createRunner` through `/api/actions` as well as REST,
  import `connections/runner-action` in the central action definitions and add
  the id to the deliberately agent-unmapped inventory. The REST caller already
  loads it; the capability bridge must not offer it. J3 can apply its same
  step-up guard to this existing create route; J7 adds no alternate bearer path.
- The J2 runner/Kubernetes default journey, genuine identity authority and live
  accounts remain separate acceptance. No server/browser/cloud lane was run on
  this Windows builder. No new tables/store functions need inventory entries.
- Suggested/current ledger status: `implementation_complete_verification_pending`,
  retaining `state: in_progress` and noting the owner UI join and pending native,
  operated browser and live evidence. No requirement is promoted to verified.

The earlier sections below describe the original implementation and historical
evidence; this J7 section supersedes their runner-gap statements.

### Windows builder command receipts

Working tree based on `3a9de905`, Node `v22.23.3`. Every PowerShell invocation
prepended `C:\Users\user\.local\sdk\node22` to PATH. Results overlap; do not sum
these attempts or promote them to native/browser/cloud evidence.

Commands A and B:

```sh
# A (two attempts)
npx vitest run tests/connections/runner-routes.test.ts tests/connections/lifecycle.test.ts tests/cli/connections.test.ts --no-file-parallelism --maxWorkers=2
# B (two attempts)
npx vitest run tests/connections/runner-routes.test.ts tests/connections/lifecycle.test.ts tests/connections/rotations-repo.test.ts tests/connections/runner-browser.test.ts tests/cli/connections.test.ts --no-file-parallelism --maxWorkers=2
```

Commands C and D (after subsequent source fixes):

```sh
# C
npx vitest run tests/connections/runner-routes.test.ts tests/connections/runner-browser.test.ts --no-file-parallelism --maxWorkers=2
# D
npx vitest run tests/connections/runner-routes.test.ts --no-file-parallelism --maxWorkers=2 -t 'production verification capture'
```

| Attempt | Passed | Failed | Skipped | Result |
|---|---:|---:|---:|---|
| A initial | 68 | 6 | 28 | Failed: new fixtures incorrectly looked for `data.actorId` instead of `actor.id`, and supplied `text[]` for a JSONB capability column |
| A corrected | 77 | 0 | 31 | Passed; additional refusal/event-outage cases included |
| B initial | 86 | 0 | 33 | Passed; 32 native cases and one actual browser case gated |
| C | 32 | 0 | 33 | Passed after URL/browser fixture corrections; native/browser gates retained |
| D | 1 | 0 | 64 | Passed native-capture refusal on a genuine PGlite handle; 32 native gated and 32 other cases excluded by this explicit test-name filter |
| B final | 87 | 0 | 33 | Passed after the capture-refusal addition and type-only header-table correction; four files passed, one browser file gated |

The fixture repairs retained the actor and empty-capability assertions using
the actual repository schema. No existing test assertion/expectation was
changed or removed. Later source fixes preserve pre-existing provider access
rotation, return validation errors for malformed Kubernetes URLs, isolate the
browser CLI from saved user credentials, select OCI UI rows by their dedicated
runner ids, and preserve the production native verification capture.

Lint commands (all completed with zero errors and zero warnings):

```sh
# L1, once
npx eslint src/lib/connections/schemas.ts src/lib/connections/service.ts src/lib/connections/runner.ts src/lib/connections/runner-action.ts src/app/api/platform/v1/_lib/connections.ts src/app/api/platform/v1/connections/route.ts src/cli/main.ts tests/connections/runner-routes.test.ts tests/cli/connections.test.ts
# L2, three times as source/tests changed
npx eslint src/lib/connections/schemas.ts src/lib/connections/service.ts src/lib/connections/runner.ts src/lib/connections/runner-action.ts src/app/api/platform/v1/_lib/connections.ts src/app/api/platform/v1/connections/route.ts src/cli/main.ts tests/connections/runner-routes.test.ts tests/connections/runner-browser.test.ts tests/cli/connections.test.ts
# L3, after the type-only test table correction
npx eslint tests/connections/runner-routes.test.ts
```

Whole-repo typecheck, only through the mandated serializer:

```sh
bash Z:/Projects/Spawned.ai/zenith-wt/.resume/codex/tsc-serial.sh
```

First attempt: exit 1, one TS2345 diagnostic in the new refusal-header table.
Corrected its inferred optional-undefined union with an explicitly typed
`Record<string,string>[]`, preserving the exact test inputs/assertions.
Successor: exit 0, zero diagnostics, after the shared serializer wait.

`node --version` passed (`v22.23.3`); `git diff --check` passed on inspected
changes. Read-only `git status --short`, `git log --oneline -10`, `git diff`,
`Get-Content` and `rg` inspected requirements/source. Some filename probes had
no matching path and two `Get-CimInstance Win32_Process` diagnostic queries
were denied by the sandbox. Read-only `Get-Process` and lock-timestamp probes
confirmed activity on the shared builder. A final source inspection confirmed
the generic action endpoint uses cookie-based identity, with no platform-bearer
admission path; the new action itself refuses Navigator/integration contexts.
CLI HTTP fixtures were contract-only; no real
PostgreSQL, Temporal, kind, browser or cloud environment was started.

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
- Historical GCP/Azure/AWS runner create/verify gap: addressed for readiness by J7 above; direct provider transport and broader UI joins remain separate.
- Revoking cannot end provider sessions already minted (up to 15 minutes) nor remove customer trust; the answer lists the customer steps.
- AWS ExternalId rotation is zero-downtime only if the operator lists both ExternalIds in the role trust conditions during the window; Zenith states this, it cannot enforce it.
- `retirePreviousRunner`/`revokeRunner` now have direct route coverage with the platform runner store (J7 above).
- Genuine Postgres product-store bearer snapshots remain for the default-stack verifier. J7 calls the lifecycle handlers directly, with explicit identity-authority fixtures and actual platform SQL.
- Nothing here is live-cloud evidence. Tests were not run on this machine (build-only rule); typecheck and eslint were.

## 5. Suggested ledger implementationStatus

"implemented_unverified: create/verify/revoke/rotate for aws, gcp, azure, oci, kubernetes via UI, REST and CLI (create/rotate/promote browser-only; CLI hands off), staged zero-downtime rotation with candidate verification, immediate terminal revoke blocking all dispatch paths, platform events and audit, migration 22; contract + local_engine tests written, not yet run"
