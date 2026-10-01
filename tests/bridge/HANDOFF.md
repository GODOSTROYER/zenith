# WS-BRIDGE implementation handoff

## Branch and working tree

Branch `ws/bridge`, unchanged HEAD `3e01e6c`. All work in this continuation is
uncommitted, as requested. No commit, merge, stash, reset, checkout, install or
package changes were performed. No capability implementation, platform API,
fixed contract or LocalStack source/test was edited.

## Files and behavior

Added:

- `src/lib/bridge/deps.ts`: global injectable broker, workflow, readiness,
  workspace-scoped connection SQL/lookup, credential verification and browser
  proof ports. Heavy production clients are imported lazily.
- `src/lib/bridge/deploy.ts`: real-provider routing, dry-run policy decision,
  ids-only deploy/rollback proposals, product deployment projection and parking.
- `src/lib/bridge/lifecycle.ts`: claim/start, browser-only approval, approval
  signals, pre-start cancellation and running cancellation signals. Same-process
  concurrent starts share a promise; the broker claim and Temporal workflow id
  provide the cross-process fences. Grants are discarded, never persisted or
  returned. Startup failures settle failed; an ambiguous Temporal timeout settles
  uncertain and reports that whether a workflow started is unknown. The build
  flag is true only for managed git sources, matching the graph expander's build
  pipelines; non-sandbox blueprint sources are rejected by worker validation.
- `src/lib/bridge/projection.ts`: event sequences, status/terminal projection,
  skipped pending steps and conditional release of the product environment lease.
- `src/lib/bridge/guards.ts`: existing provider/connection/deletion/separation
  guards moved from the action file, keeping `deploy.ts` under 600 lines.
- `src/lib/actions/defs/connection-aws.ts`: strict keyless connection actions;
  matching platform/legacy ids, OIDC or random ExternalId assume-role mode,
  account/ARN/region/bucket validation, pending verification at creation,
  workspace-bound observe-role verification and updates to both records.
- Seven bridge test suites plus `tests/bridge/support.ts` and this handoff.

Modified:

- `src/lib/actions/defs/deploy.ts`: async route-aware refusal; ready, linked,
  verified providers propose through the broker and run workflows; the sandbox
  engine path, snapshot and stateful deletion guard remain. Approve/cancel route
  workflow rows to platform controls. Rollback (therefore promotion) uses
  `deployment.rollback` and the same deploy workflow, without `rollbackOf` or
  marking another deployment `rolling_back`.
- `src/lib/actions/defs/connection.ts`: directs keyless setup to `createAws`;
  legacy AWS creation stays explicitly Preview even when global readiness is true.
- `src/lib/actions/defs/index.ts`: registers `connection-aws`.
- `src/lib/providers/aws/provider.ts`: readiness-based availability/tagline,
  readiness probe and linked preflight with recorded verification (no STS call).
  Legacy engine execution, observation and discovery still refuse; text now
  distinguishes that adapter from the workflow/driver execution path.
- `src/lib/bridge/readiness.ts`: thrown probes cannot escape or expose error
  values; other prerequisite checks survive a failed probe. Credential config
  failures use fixed text. Unknown-provider detail does not reflect input text.
- `src/lib/engine/engine.ts`: the final rollback-repair loop in `resumeInFlight`
  now also skips workflow rows (the earlier handoff protected its main loop).
- `tests/capabilities/action-bridge.test.ts`: adds the two intentionally new
  connection actions to the explicit unmapped exclusion list. This is an existing
  registry test affected by the owned `defs/index.ts` change, covered by the
  brief's existing-test exception. No wildcard exclusion, gate or assertion was
  weakened; agents remain denied by the capability action bridge when unmapped.

The additive domain fields and planned workflow step table from the previous
commits were retained. Product approval policy and production separation remain
in force in addition to broker approval; only the product's existing sole-admin
exception remains, and its action audit summary is explicit. Broker separation
can still refuse that requester regardless of the product exception.

## Verification history (this continuation only)

`npx tsc --noEmit`, in chronological order: clean; 1 error; clean; 5 errors;
1 error; clean; clean; clean; clean; clean. The intermediate errors were schema input
typing and new test fixture typing, all fixed. Final diagnostics: zero.

ESLint commands:

```text
npx eslint src/lib/bridge src/lib/engine/engine.ts src/lib/domain/types.ts src/lib/actions/defs/deploy.ts src/lib/actions/defs/promote.ts src/lib/actions/defs/connection.ts src/lib/actions/defs/connection-aws.ts src/lib/actions/defs/index.ts src/lib/providers/aws/provider.ts
npx eslint src/lib/bridge src/lib/engine/engine.ts src/lib/domain/types.ts src/lib/actions/defs/deploy.ts src/lib/actions/defs/promote.ts src/lib/actions/defs/connection.ts src/lib/actions/defs/connection-aws.ts src/lib/actions/defs/index.ts src/lib/providers/aws/provider.ts tests/bridge
npx eslint src/lib/bridge src/lib/engine/engine.ts src/lib/domain/types.ts src/lib/actions/defs/deploy.ts src/lib/actions/defs/promote.ts src/lib/actions/defs/connection.ts src/lib/actions/defs/connection-aws.ts src/lib/actions/defs/index.ts src/lib/providers/aws/provider.ts tests/bridge tests/capabilities/action-bridge.test.ts
```

First command: 1 run, 0 errors/0 warnings. Second: 2 runs, each 0 errors/0
warnings. Third: 2 runs, each 0 errors/0 warnings.

| Exact Vitest command | Runs in order: files; tests |
| --- | --- |
| `npx vitest run tests/bridge` | 2 passed/1 failed; 21 passed/2 failed. Then 4 passed/2 failed; 63 passed/16 failed. Then 7 passed/0 failed; 86 passed/0 failed. No skips. |
| `npx vitest run tests/bridge tests/engine tests/actions tests/providers` | 41 passed/2 failed; 549 passed/2 failed/7 skipped. Then 43 passed/0 failed; 551 passed/0 failed/7 skipped. Then 44 passed/0 failed; 558 passed/0 failed/7 skipped. Final: 44 passed/0 failed; 559 passed/0 failed/7 skipped. |
| `npx vitest run tests/capabilities/action-bridge.test.ts` | 1 passed/0 failed; 16 passed/0 failed. |
| `npx vitest run` (first full run) | 408 passed/2 failed/11 skipped files; 6438 passed/4 failed/288 skipped tests. One action-registry expectation fixed afterward; three pre-existing process timeouts below. |
| `npx vitest run tests/tofu/process.test.ts` (archived `1ebb6ec` in Temp) | Startup blocked by esbuild parent-directory access denial; 0 tests executed. |
| `npx vitest run tests/tofu/process.test.ts` (same archive temporarily under `tests/bridge/.baseline-1ebb6ec`) | 0 passed/1 failed file; 15 passed/3 failed/0 skipped tests. Exact same three timeout tests fail on the base commit. |
| `npx vitest run` (second full run, after registry test correction) | 409 passed/1 failed/11 skipped files; 6439 passed/3 failed/288 skipped tests. Only the same three pre-existing OpenTofu process termination timeouts fail. |
| `npx vitest run` (final full run, after build-flag cross-check) | 409 passed/1 failed/11 skipped files; 6440 passed/3 failed/288 skipped tests. All 87 bridge tests pass; only the same three baseline OpenTofu process termination timeouts fail. |

No environment-gated lane was enabled to turn a skip into a claimed live result.

`git diff --check` completed without whitespace errors on every executed check.
Git warns about line-ending normalization of the existing deploy action file.

Full-suite first-run log: `%TEMP%/zenith-ws-bridge-full.log`. Final-run log:
`%TEMP%/zenith-ws-bridge-full-final.log`. Final targeted log:
`%TEMP%/zenith-ws-bridge-targeted.log`. Base evidence:
`%TEMP%/zenith-ws-bridge-baseline-in-tree.log`.

The baseline archive was obtained with read-only `git archive 1ebb6ec` and shared
existing dependencies, without changing a checkout. Its temporary in-tree copy
was moved to `%TEMP%/zenith-ws-bridge-baseline-verified-1ebb6ec` before the final
full run. The sandbox rejected recursive deletion, so cleanup used a checked,
reversible native PowerShell move instead. The first Temp extraction and zip
also remain in Temp; none is part of the proposed changes.

## Limits, assumptions and integration asks

- No real AWS account, STS session, production authentication, Postgres contract
  lane, real Temporal worker, Docker or WSL was exercised. Connection repository
  tests use actual PGlite; verification and workflow transports are explicitly
  fake. Real-service/network tests remain behind their existing gates. The full
  workflow lane also reports its unavailable Temporal test-server download.
- The three out-of-scope `tests/tofu/process.test.ts` failures are timeout,
  grandchild-tree termination and AbortSignal termination on Windows. Each hits
  the unchanged 20-second test deadline, including on `1ebb6ec`. The runner uses
  `taskkill`; the precise reason it fails to terminate in this sandbox is not
  established. Nothing in that module or its tests was changed.
- Readiness checks configuration/server reachability and this process's driver
  registry, not live credential validity, complete driver coverage or a worker
  polling the queue. AWS remains Preview unless every readiness check is true.
  No AWS driver registration was added to this branch. A split web/worker install
  must import drivers in the web process or adopt another attestation contract.
- `ActionContext`/`RequestState` lack an authenticated browser marker carrying
  header/origin and fresh identity checks. The bridge uses the specified
  structural guard: route scope, matching signed-in member, no integration or
  non-user actor, with local-only self-hosted demo support. The orchestrator
  should add a server-minted browser proof to `buildCtx`/`route` and pass that
  through the action context; current code does not claim REST-level live proof.
- Bootstrap caches provider projections by registry identity/size. Its owned
  worker must stop memoizing dynamic availability/tagline (or include readiness
  in the key). Otherwise the shell may show stale Preview until restart.
- The bridge still claims before workflow start with holder
  `workflow:<operationId>` and a five-minute claim lease, per the handoff. If no
  worker polls, the ledger reconciler may mark the operation uncertain. Letting
  the worker claim after start is a proposed integration improvement, not applied.
- Platform and legacy connection creation/verification span two stores. A
  product-store flush failure after the platform write can leave an unlinked
  platform row; there is no cross-store transaction contract. Reconcile such rows
  rather than assuming creation was atomic across stores.
- Verify `deployment.rollback` is accepted by ws-act's activities and the AWS
  credential/session-policy capability narrowing. The worker reuses the deploy
  workflow and resolves the shared legacy/platform connection id.
- Required environment families: `ZENITH_PLATFORM_DB[_URL]`,
  `ZENITH_TEMPORAL_ADDRESS|NAMESPACE|API_KEY|TLS`,
  `ZENITH_CONTROL_SIGNING_JWK|KMS_KEY_ID`,
  `ZENITH_OIDC_SIGNING_JWK|KMS_KEY_ID`, `ZENITH_OIDC_ISSUER`.
  `ZENITH_PLATFORM_BROKER_MEMORY` must be unset for readiness.

## Deviations from the handoff

No recorded execution, ownership, approval or rollback decision was reversed.
The inherited never-throw readiness guarantee and all-loop engine ownership
invariant required the fixes described above. Guard extraction keeps the action
file within the brief's size guideline. The plan uses the permitted connection-id
placeholder; actual subject and random ExternalId are returned only after
creation, so a plan never asks the customer to trust a throwaway random value.
The StepName union's textual order differs from the worker display order at
`execute_capability`; tests verify exact union membership and the actual worker
table's order/titles/phases, preserving the handoff's product-port contract.

No new broker/fixed-contract change is required to compile this implementation.
Browser proof, bootstrap caching, driver registration/attestation and worker
rollback acceptance remain orchestrator integration work outside owned paths.
