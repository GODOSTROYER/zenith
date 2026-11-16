# PROD-LIFE-01 Connection administration lifecycle

## J7 UI and registry follow-up, 8 October 2026

Base: `9738d00b`, the orchestrator's committed J7 packet. The owner explicitly
expanded J7 to finish the connection UI, CLI confirmation page and central
registry joins. This section supersedes the original packet's UI/registry join
and browser instructions below. Historical command receipts remain intact.

The requested runner lifecycle build is complete. No requirement is marked
verified. AWS, GCP, Azure, OCI and Kubernetes have identifier-only customer
runner forms with explicit custody; GCP/Azure preserve their native WIF choice.
All runner cards rotate their runner binding, preserve staged access until
promotion, verify readiness and require an exact id for terminal revocation.
Inputs are labelled, provider buttons expose selection, and results/errors
use status/alert roles and the existing UI components.

Runner CLI creation and rotate/promote/abort hand off the exact validated draft
to `/platform/connections/confirm#...`, with a selected CLI workspace bound
when provided. A fragment stays out of HTTP requests and access logs. Opening
the page performs no mutation. The current browser role and workspace govern
confirmation; missing/revoked/stale targets are refused. Review must be checked
explicitly, revocation also requires typing the id, and a changed fragment
clears consent and ignores an earlier request's eventual answer.

`connection.createRunner` now loads centrally. The shared lifecycle plans show
human confirmation for access changes and describe runner verification's actual
scope. Mutation actions stay unmapped for agent execution and refuse Navigator
and integration contexts. The generic action HTTP endpoint uses the existing
browser guard for createRunner/rotate/promote/abort, as the REST routes do.

`connection.proposeRunner` supplies an unapproved identifier-only review draft,
including in Navigator read-only plan mode. MCP v3 exposes it through the new
`zenith_plan_runner_connection` read tool and `connection.plan` capability.
The real broker checks current membership, project grant, plan scope, plugin
allowlist and policy before invoking this fixed non-mutating registry helper.
Model-supplied target action ids are never executed. It creates no connection,
durable operation, approval or execution grant. Normal read policy audit events
remain. Human confirmation calls the existing lifecycle endpoints; there is no
agent execution adapter, credential fallback or new approval subsystem.

### File manifest and scope expansion

33 files changed or added. The following minimal files outside the original
runner/route/CLI paths are included under the owner's follow-up authorization:

| File | Change and reason |
|---|---|
| `src/app/(product)/platform/connections/connection-admin.tsx` | Five runner forms, custody, runner rotation, accurate verification scope, semantic result feedback |
| `src/app/(product)/platform/connections/confirm/page.tsx` (new) | Current-session workspace/role/connection loader for browser review |
| `src/app/(product)/platform/connections/confirm/confirmation.tsx` (new) | Exact inert draft review, explicit consent, role/state refusal, exact lifecycle calls |
| `tests/screens/platform/runner-connections.test.tsx` (new) | Five-provider form/lifecycle DOM contracts |
| `tests/screens/platform/runner-confirmation.test.tsx` (new) | Confirmation, stale draft, role/workspace and refusal DOM contracts |
| `src/lib/actions/defs/index.ts` | Central runner action registration |
| `src/lib/actions/defs/connection-lifecycle.ts` | Runner readiness preview and access-change confirmation metadata |
| `src/app/api/actions/[actionId]/route.ts` | Same browser-only boundary for central access-changing actions |
| `src/lib/capabilities/catalog.ts` | Read-only `connection.plan` capability |
| `src/lib/capabilities/action-bridge.ts` | Only the read-only proposal maps for agents |
| `src/lib/agent-access/v3/connection-schema.ts` (new) | Strict MCP outer action/target draft input |
| `src/lib/agent-access/v3/tools/connections.ts` (new) | Policy-scoped central draft helper and browser URL |
| `src/lib/agent-access/v3/tools/index.ts` | Semantic tool dispatcher registration |
| `src/lib/agent-access/v3/contract.ts` | Tool name and explicit human-confirmation instructions |
| `src/lib/agent-access/v3/catalog.ts` | Discoverable plan-scope tool, schema and read hints |
| `tests/agent-v3/runner-connections.test.ts` (new) | Real broker/signer draft, scope, policy, plugin, secret and authority contracts |
| `tests/agent-v3/catalog.test.ts` | Exact additive tool inventory and plan-scope discovery |
| `tests/agent-v3/golden/catalog.json` | Pin new tool/version/digest; existing tool digests unchanged |
| `tests/agent-v3/support.ts` | Valid project-scoped args for the new tool |
| `tests/agent-v3/tenancy.test.ts` | Exercise each tool's declared target dimensions, retaining all existing environment checks |
| `tests/capabilities/action-bridge.test.ts` | Exact agent-refused mutation inventory includes createRunner |
| `docs/platform/MCP.md` | Generated catalog and draft/human confirmation contract |

Original-scope files and required acceptance documentation:

| File | Change |
|---|---|
| `src/lib/connections/handoff.ts` (new) | Shared strict draft validation, bounded fragment roundtrip and deterministic REST mapping |
| `src/lib/connections/runner-action.ts` | Central read-only draft definition and human-only create plan |
| `src/cli/main.ts` | Exact local draft handoff with optional workspace binding; no submission |
| `tests/cli/connections.test.ts` | All five provider and lifecycle URL roundtrips, exact input/workspace, exit 3, no requests |
| `tests/connections/runner-inputs.ts` (new) | Shared public identifier fixtures and UI view factory |
| `tests/connections/runner-action-registry.test.ts` (new) | Actual central registration, Navigator/integration refusal and inert plans |
| `tests/connections/runner-routes.test.ts` | Direct generic action lifecycle and browser-guard contracts, both SQL lanes |
| `tests/connections/runner-browser.test.ts` | Real gated all-five-provider CLI confirmation and ordinary form journeys |
| `docs/platform/CLI.md` | Exact browser handoff and readiness scope |
| `docs/build/production/ledger.json` | LIFE-01 stays implementation_complete_verification_pending; joins completed, operated evidence pending |
| `docs/build/production/verify/PROD-LIFE-01.md` | This manifest, receipts and verifier instructions |

No dependency, migration, aggregate SQL, execution-core or Wave 5 changes.
No deviation from the expanded handoff. All changes remain uncommitted for
the orchestrator. The J1/J2 startup integration remains a verifier prerequisite.

### Follow-up Windows command receipts

Every shell prepended `C:\Users\user\.local\sdk\node22` to PATH. The following
are the exact validation commands; attempts overlap and must not be summed.
Latest distinct cases: **295 passed, 0 failed, 42 gated** across 16 files.
The 42 gates are 37 native PostgreSQL cases and five real browser cases.

```sh
# F1
npx vitest run tests/screens/platform/runner-connections.test.tsx tests/screens/platform/runner-confirmation.test.tsx tests/cli/connections.test.ts --no-file-parallelism --maxWorkers=2
# F2
npx vitest run tests/agent-v3/runner-connections.test.ts tests/agent-v3/catalog.test.ts tests/agent-v3/read.test.ts tests/agent-v3/schemas.test.ts tests/agent-v3/tenancy.test.ts tests/agent-v3/scope-catalog.test.ts tests/capabilities/action-bridge.test.ts tests/connections/runner-action-registry.test.ts --no-file-parallelism --maxWorkers=2
# F3
npx vitest run tests/agent-v3/runner-connections.test.ts tests/connections/runner-routes.test.ts tests/connections/lifecycle.test.ts tests/connections/runner-browser.test.ts --no-file-parallelism --maxWorkers=2
# F4
npx vitest run tests/screens/platform/runner-connections.test.tsx tests/screens/platform/runner-confirmation.test.tsx tests/cli/connections.test.ts tests/agent-v3/runner-connections.test.ts --no-file-parallelism --maxWorkers=2
# F5
npx vitest run tests/agent-v3/runner-connections.test.ts tests/agent-v3/catalog.test.ts tests/agent-v3/read.test.ts tests/agent-v3/schemas.test.ts tests/agent-v3/tenancy.test.ts tests/agent-v3/scope-catalog.test.ts tests/capabilities/action-bridge.test.ts tests/connections/runner-action-registry.test.ts tests/agent-v3/protocol.test.ts tests/agent-v3/sdk.test.ts --no-file-parallelism --maxWorkers=2
# F6
npx vitest run tests/connections/runner-routes.test.ts tests/connections/lifecycle.test.ts tests/connections/runner-browser.test.ts --no-file-parallelism --maxWorkers=2
```

| Attempt | Passed | Failed | Skipped | Result |
|---|---:|---:|---:|---|
| F1 | 43 | 0 | 0 | Initial DOM and CLI contracts passed |
| F2 | 131 | 7 | 0 | New MCP fixture assumptions incorrect: omitted policy audit event and wrong existing scope/plugin error names |
| F3 | 78 | 6 | 42 | Remaining new fixture used an array instead of the harness's two workflow-start collections; SQL/route and lifecycle cases passed |
| F4 | 59 | 0 | 0 | Corrected MCP contracts plus DOM and all-five-provider CLI passed |
| F5 | 180 | 0 | 0 | Registry, broker, catalog, tenancy, protocol and SDK passed |
| F6 | 70 | 0 | 42 | Final PGlite/route/lifecycle passed; native/browser gates retained |

Expectation changes, each justified by the contract:

- The CLI's old generic URL assertions now require an exact confirmation
  fragment, input, selected workspace and no query. Exit 3 and zero-request
  assertions remain. Nonrunner guided creation retains its original URL check.
- Catalog count 16 becomes 17 and the golden/generated table adds only the new
  semantic tool. The exact registry refusal inventory adds createRunner; no
  execution mapping or existing gate is removed.
- The tenancy matrix takes dimensions from each declared target. Existing
  environment-scoped tools keep all three dimensions; the new strict
  project-scoped tool has no environment member.
- The older never-run browser case expected a disabled revoked card, but
  `listConnections` and the default page exclude revoked rows. It now proves
  terminal status by independent GET and exclusion from the operated active UI.
  The single-provider generic handoff check becomes an exact five-provider
  confirmation roundtrip, preserving create/verify/stage/promote/revoke checks.
- New MCP fixture assertions require the actual `policy.evaluated` read audit
  event, unchanged `insufficient_scope`/`plugin_capability_denied` error codes,
  and both empty `deploy`/`dayTwo` start collections. They still prove no
  operation proposal, approval or execution; suppressing audits would violate
  the requirement. These repairs change fixture assumptions, not production.

Lint (same 28 files on both full attempts):

```sh
npx eslint 'src/app/(product)/platform/connections/connection-admin.tsx' 'src/app/(product)/platform/connections/confirm/page.tsx' 'src/app/(product)/platform/connections/confirm/confirmation.tsx' 'src/app/api/actions/[actionId]/route.ts' src/cli/main.ts src/lib/actions/defs/index.ts src/lib/actions/defs/connection-lifecycle.ts src/lib/agent-access/v3/catalog.ts src/lib/agent-access/v3/contract.ts src/lib/agent-access/v3/connection-schema.ts src/lib/agent-access/v3/tools/index.ts src/lib/agent-access/v3/tools/connections.ts src/lib/capabilities/action-bridge.ts src/lib/capabilities/catalog.ts src/lib/connections/runner-action.ts src/lib/connections/handoff.ts tests/agent-v3/catalog.test.ts tests/agent-v3/support.ts tests/agent-v3/tenancy.test.ts tests/agent-v3/runner-connections.test.ts tests/capabilities/action-bridge.test.ts tests/cli/connections.test.ts tests/connections/runner-inputs.ts tests/connections/runner-action-registry.test.ts tests/connections/runner-browser.test.ts tests/connections/runner-routes.test.ts tests/screens/platform/runner-connections.test.tsx tests/screens/platform/runner-confirmation.test.tsx
# Final check after the browser harness type fix
npx eslint tests/connections/runner-browser.test.ts
```

Full lint first: 1 error, 0 warnings (unused previous target fixture import).
Corrected full lint: 0 errors, 0 warnings. Final harness lint: 0 errors,
0 warnings. No assertions were changed for lint.

```sh
bash Z:/Projects/Spawned.ai/zenith-wt/.resume/codex/tsc-serial.sh
```

Two serialized attempts only. First: exit 1, one TS2345 in the gated harness
because optional custody was passed to Playwright's selectOption. Normalized
the harness input to the existing local_only default, ensuring CLI/form exact
payload parity as well. Second: exit 0, zero diagnostics. No compiler or lock
bypass. Tests requiring servers or browsers did not run during typechecking.

Other commands:

```sh
node C:/Users/user/.agents/skills/impeccable/scripts/context.mjs --target 'src/app/(product)/platform/connections/connection-admin.tsx'
node C:/Users/user/.agents/skills/impeccable/scripts/detect.mjs --json 'src/app/(product)/platform/connections/connection-admin.tsx' 'src/app/(product)/platform/connections/confirm/confirmation.tsx' 'src/app/(product)/platform/connections/confirm/page.tsx'
npx --no-install tsx --tsconfig tsconfig.json C:/Users/user/AppData/Local/Temp/zenith-j7-catalog.ts
Remove-Item -LiteralPath 'C:\Users\user\AppData\Local\Temp\zenith-j7-catalog.ts'
git diff --check
```

Context inspection found the incumbent design and pre-existing product/config
schema drift, which this narrow join does not edit. Detector: exit 0, zero
findings (`[]`). Temporary catalog renderer: exit 0, 17 digests/table entries
generated, subsequently checked by F5; no package installation. Its first
PowerShell multiline `npx --no-install tsx --tsconfig tsconfig.json -e
$j7CatalogScript` attempt exited 0 but produced no artifact and is not generation
evidence. The same renderer was then executed from a temporary file. The file
is removed after use (cleanup exit 0). All three `git diff --check` invocations
passed, zero whitespace errors.

Read-only `git status --short`, `git log --oneline -10`, `git diff --stat`,
`git diff --numstat`, targeted `git diff`, `rg`, `rg --files`, and `Get-Content`
inspected requirements, skills and source. Filename probes for absent
connections/read test files, unmerged J1/J2 verification docs and runner docs
were corrected or recorded as unavailable; two malformed PowerShell read/rg
arguments were corrected. These probes are not verification cases.

### Exact Mac verifier commands and pending evidence

Node 22, one lane at a time. F4, F5 and F6 above are the exact pure/PGlite
commands to rerun in the merged checkout. Whole-repo typecheck on the Mac is
`npx tsc --noEmit -p .`; the Windows builder uses only the serializer above.

Native PostgreSQL: use the disposable one-container startup/role bootstrap
in the original J7 section below, with its 384 MiB memory limit, one CPU,
64 MiB shared_buffers and 12 connections. Keep its generated local password
private and never use a shared production database. Then run:

```sh
export ZENITH_TEST_PLATFORM_PG_URL="postgresql://postgres:$j7Password@127.0.0.1:5547/zenith_runner"
npx vitest run tests/connections/runner-routes.test.ts --no-file-parallelism --maxWorkers=2
unset ZENITH_TEST_PLATFORM_PG_URL
```

Expected: **75 passed, 0 failed, 0 skipped** (38 PGlite and 37 native). The native
lane still uses explicit product identity authority fixtures; it proves native
SQL/handler contracts, not operated Supabase Auth or default-stack behavior.
Windows result: **not run (needs PostgreSQL/Docker)**.

Browser: start the owner J1 lean app/Auth/product/platform stack, and the J2
genuine registered runner processes. The J1/J2 startup launcher/profile is not
present in this base and must be integrated before operated acceptance; do not
substitute the legacy full compose for the Mac's 4 GiB Docker budget. J7's join
interface is a loopback app URL, a current human admin storage state and the
following private identifier fixture. No live cloud service is needed or called.
Runner verification remains readiness evidence only.

Use two dedicated active, heartbeating registrations for each provider (two
shared registrations are also sufficient if they genuinely advertise every
required handler and match custody). Required advertisements: aws.http for AWS,
tofu.run for GCP/Azure, oci.http for OCI, k8s.http for Kubernetes. Match each
input's runnerCustody to the genuine registration. Do not seed registry rows or
intercept browser requests. Keep J2's actual local test credentials private.
If J2 has prepared private configurations and browser-issued one-time token
files, the real runner registration/start commands from the operator guide are:

```sh
# Run from the repository root with a private owned fixture directory.
# Reuse J2's built native ARM64 binary, or build locally without downloads:
GOTOOLCHAIN=local go -C go build -o "$j7Private/zenith-runner" ./cmd/zenith-runner
"$j7Private/zenith-runner" --config "$j7Private/first.yaml" check
"$j7Private/zenith-runner" --config "$j7Private/second.yaml" check
"$j7Private/zenith-runner" --config "$j7Private/first.yaml" register --token-file "$j7Private/first.token"
"$j7Private/zenith-runner" --config "$j7Private/second.yaml" register --token-file "$j7Private/second.token"
"$j7Private/zenith-runner" --config "$j7Private/first.yaml" run >"$j7Private/first.log" 2>&1 &
j7FirstPid=$!
"$j7Private/zenith-runner" --config "$j7Private/second.yaml" run >"$j7Private/second.log" 2>&1 &
j7SecondPid=$!
```

J2 owns configuration/bootstrap, enabled local job handlers and safe local
test credentials. Do not run these processes against a live cloud or shared
installation. Reuse existing dedicated registered processes if already running.
The lifecycle suite never dispatches a cloud job. Browser and these two small
native processes run serially with the lean app; kind, observability and extra
workers are not needed by this lifecycle/readiness harness. Stop only these
owned PIDs after verification (`kill "$j7FirstPid" "$j7SecondPid"`).

Export the actual signed-in local admin's Playwright storage state to a private
file, with any J3-required step-up satisfied. The browser fixture format is now
`{"cases": [{"input": {...CreateRunnerInput}, "nextRunnerId": "..."}, ...]}`,
exactly one case for each of aws/gcp/azure/oci/kubernetes, mode runner. Each
input holds the ordinary provider identifiers and its first registered runner
id; nextRunnerId must be another active registration. Optional custody defaults
to local_only. The shapes are published in `src/lib/connections/schemas.ts` and
the CLI guide; no secret, bearer or approval field belongs in this JSON.

```sh
export ZENITH_TEST_RUNNER_BROWSER=1
export ZENITH_TEST_BROWSER_BASE_URL=http://127.0.0.1:3000
export ZENITH_TEST_BROWSER_STORAGE_STATE="$j7Private/local-admin-storage-state.json"
export ZENITH_TEST_RUNNER_BROWSER_INPUT_FILE="$j7Private/j7-runner-identifiers.json"
export ZENITH_TEST_CHROMIUM_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
npx vitest run tests/connections/runner-browser.test.ts --no-file-parallelism --maxWorkers=2
unset ZENITH_TEST_RUNNER_BROWSER ZENITH_TEST_BROWSER_BASE_URL ZENITH_TEST_BROWSER_STORAGE_STATE ZENITH_TEST_RUNNER_BROWSER_INPUT_FILE ZENITH_TEST_CHROMIUM_PATH
```

Expected: **5 passed, 0 failed, 0 skipped**. Each real case proves CLI sends no
request, page load is inert, a human confirms exact creation, UI readiness
verification, staged rotation without early switching, verified promotion,
terminal revoke with independent readback, and ordinary provider form creation
with exact body and subsequent revocation. Explicit gate with missing inputs
fails; there are no route mocks, injected stores or fake browser identities.
Windows result: **not run (needs J1/J2/Auth/Chromium browser)**.

Default topology/pooler/real human-agent operation acceptance stays with J2 and
the Mac verifier. GCP/Azure/Kubernetes runner provider transports are still
explicitly refused by their existing callers; this join adds no execution
transport or cloud permission proof. Live cloud acceptance remains deferred by
the owner. The LIFE-01 ledger status remains
`implementation_complete_verification_pending` with state in_progress.

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

### Mac commands (original packet; follow-up above supersedes counts and browser input)

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

### Owner joins and open acceptance (historical; UI/registry joins completed above)

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


## Wave 6 final integration

Status remains `implementation_complete_verification_pending`. Node 22 only. Execute sequentially with Docker Desktop 4 GiB and one kind node; stop each heavy profile before starting another. Live acceptance stays deferred until separate owner approval.

```bash
node scripts/ci/wave6-gates.mjs --requirement PROD-LIFE-01 --print > /tmp/zenith-wave6-PROD-LIFE-01.commands.json
```

This prints the exact argv for each contract batch and required engine case, its gate names, private prerequisites, and its strict report-validation command. Set only the gates for the selected lane after preparing its owned fixture; a skip cannot satisfy that lane. Run each `argv` sequentially and then its `verify` argv. [Final integration setup and results](FINAL-INTEGRATION.md), [canonical inventory](../../../../scripts/ci/wave6-gates.json), [owner live runbook](../LIVE-ACCEPTANCE.md).
