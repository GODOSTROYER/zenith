# Rolling upgrades, replay and rollback (PROD-OPS-03)

This is the operator contract for replacing API, execution worker and runner builds
while workflows are in flight, and for backing out. It describes what the code
enforces and what it cannot.

## The four compatibility surfaces

| Surface | Contract | Enforced by |
| --- | --- | --- |
| Temporal workflow code | Every `patched("<id>")` is registered in `src/lib/workflows/versioning.ts`; every committed recorded history replays against the current bundle; every registered workflow type has a recorded history. | `tests/workflows/versioning-audit.test.ts`, `tests/workflows/history-replay.test.ts`, fixtures in `tests/fixtures/workflow-histories` |
| Worker routing | Optional Temporal Worker Deployment versions: a build id per worker image, `auto_upgrade` or `pinned`. | `ZENITH_WORKER_VERSIONING` / `_DEPLOYMENT_NAME` / `_BUILD_ID`, `workers/execution/config.ts`, `run.ts`; `tests/workers/versioning-config.test.ts` |
| Platform schema | Within a release a migration is expand-only, so N-1 runs on schema N and rollback to N-1 stays possible. Contract migrations are refused unless registered (LIFE-10 approval reference plus the SQL hash) and confirmed by the operator. | `src/lib/controlplane/db/compat.ts`, called by `migratePlatformDb`; `tests/controlplane/migration-compat.test.ts` |
| Runner and machine protocol | The control plane serves protocol N and at most one N-1. Registration negotiates; anything outside the window gets `426 upgrade_required` naming the minimum. | `src/lib/runners/protocol-window.ts`, `types.ts` windows, `request-auth.ts`, `service.ts`; `tests/runners/protocol-window.test.ts` |
| MCP protocol | Already negotiated and bounded (supported and refused version lists) by UX-02. Not changed here. | `src/lib/agent-access/v3/protocol.ts` |

## Workflow versioning audit result

Patched branches today: `ecs-replica-repair-v1` (day-two), `durable-build-launch-v1` (deploy),
`reconcile-canonical-proposals-v1` (reconcile). No `deprecatePatch` is in use, so all three
are `active`: histories without the marker can still be running. Workflows added in wave 3
(`codingAgentRunWorkflow`, `teardownReviewWorkflow`, `reconcileSweepWorkflow`,
`criticalMaintenanceWorkflow`) are new types and carry no patches.

Rules for changing workflow code:

1. Reordering, adding or removing a command, or changing a timer for a workflow that may be
   running needs `patched("<id>-vN")` and an entry in `WORKFLOW_PATCHES` in the same change.
2. Add or extend a scenario in `tests/workflows/history-scenarios.ts` so a history carrying
   the new marker is recorded, then record it (below).
3. Remove a patch only after every workflow that started before it has closed or left
   retention: switch to `deprecatePatch`, set the registry status to `deprecated`, and keep
   the old fixtures only if their workflows can still exist.

### Recording histories

Fixtures are real histories exported from the real workflows on a local Temporal server with
scripted activities (so they prove determinism, not any cloud effect). They are frozen:
`MANIFEST.json` records a sha256 per file, the replay gate refuses a mismatch, and the
recorder never overwrites an existing file.

    ZENITH_RECORD_WORKFLOW_HISTORIES=1 npx vitest run tests/workflows/history-record.test.ts
    git add tests/fixtures/workflow-histories

`ZENITH_RECORD_OVERWRITE=1` replaces existing fixtures and is a reviewed act: it discards the
evidence that old histories still replay. Production histories exported with an encrypting
codec (PROD-OPS-05) must be replayed with that codec supplied; the committed fixtures are
recorded with the default codec and contain only synthetic ids.

## Worker versioning (build ids)

Off by default, because deployment-version routing needs a Temporal server with worker
deployments enabled (Temporal Cloud, or self-hosted with `system.enableDeploymentVersions`);
a server without it refuses the poll. To enable, set in the worker environment:

    ZENITH_WORKER_VERSIONING=auto_upgrade        # or pinned
    ZENITH_WORKER_DEPLOYMENT_NAME=zenith-execution
    ZENITH_WORKER_BUILD_ID=<worker image digest or release tag; no '.'>

- `auto_upgrade`: running workflows move to the current version. Safe only because the replay
  gate guards determinism. This is the rolling default.
- `pinned`: running workflows finish on the build that started them. Use for a release that is
  not replay compatible. Keep the old worker deployed until
  `temporal worker deployment describe-version --deployment-name <n> --build-id <old>` shows
  no pinned workflows.

The new version must be promoted after its workers are polling; the runbook does it with
`temporal worker deployment set-current-version` and rolls back by promoting the previous
build id. The worker logs `versioning`, `deployment` and `buildId` at startup.

## Schema: expand, roll, contract

1. Run the migration step (`platform-migrate`) with the NEW image first. It is expand-only,
   so the running N-1 API and workers keep working on it (`platformSchemaStatus().ahead`).
2. Roll workers, then the API. An N build against an N-1 schema fails closed with
   `schema_behind` until step 1 ran.
3. Roll back by redeploying the previous images. The database is not reverted; expand-only is
   what makes that safe.
4. A contract change (drop, rename, type change, NOT NULL on an existing column, validated
   constraint, revoke, RLS change on an existing table, or anything the classifier does not
   recognise) ships in a LATER release, after N-1 is gone, as an entry in
   `CONTRACT_MIGRATION_APPROVALS` with the LIFE-10 approval reference and the sha256 of its
   exact SQL, applied with `ZENITH_ALLOW_CONTRACT_MIGRATIONS=<version>` to state the previous
   release is drained. Either alone is refused. After it, image rollback is refused by the
   runbook.

The baseline is derived, never a constant: `migratePlatformDb` (Postgres, or ZENITH_ENFORCE_EXPAND_ONLY=1) holds every migration above the highest version already applied to the live database to the rule, and CI uses ZENITH_COMPAT_BASELINE_VERSION (the previous release highest version) or the registry highest. Migrations
up to it are grandfathered. The release manager raises it to the highest shipped version at each
release cut. Statements on tables created in the same migration are exempt (no old code can
see them). The classifier is conservative text analysis, not a SQL parser; `create or replace
function` is treated as expand, so a function whose behaviour N-1 code depends on must be
versioned by name.

## Runner and machine protocol

`RUNNER_PROTOCOL_WINDOW` and `MACHINE_PROTOCOL_WINDOW` in `src/lib/runners/types.ts` are the
explicit windows (`current` plus at most one `previous`). Both are on v1 today, so the N-1 list
is empty and the window logic is exercised in tests with synthetic windows. To ship v2: add the
v2 signing and envelope code, set `current` to v2 and `previous` to `[v1]`; agents that offer
`[v2, v1]` register on v2, v1-only agents register on v1 and are told
(`protocolDeprecated: true`); a control plane that later drops v1 refuses their next signed
request with `426` and the Go agent exits 4 (`ExitUpgradeRequired`). Registration negotiates
before the single-use token is consumed, so a refused agent keeps its token. Agents built
before this change send no list and are treated as the v1 baseline. The Go agent now offers
`[its protocol]` and rejects a control plane that selects another one.

Self-update of runners (signed release channel, staged update, automatic rollback) is MACH-04
and is unchanged.

## The runbook script

`scripts/ops/rolling-upgrade.mjs` (`npm run ops:upgrade -- ...`):

    # print the plan (dry run is the default; nothing that changes state runs)
    npm run ops:upgrade -- plan --topology compose --env-file <install.env> \
      --api-image reg/api@sha256:... --worker-image reg/worker@sha256:... --migration-image reg/migrate@sha256:...
    # execute
    npm run ops:upgrade -- upgrade --topology compose ... --execute
    # back out using the state file the upgrade wrote
    npm run ops:upgrade -- rollback --topology compose --state .upgrade-state/upgrade-<ts>.json --execute

Compose uses `deploy/self-hosted/compose.yml` (the worker has an 11 minute `stop_grace_period`,
which is the drain window). Kubernetes mode needs `--namespace`, `--migration-job <manifest>`
and, if names differ, `--api-deployment`, `--worker-deployment` and container names; this
repository ships no API or worker Deployment manifests, so none are assumed. Every new image
must be a digest reference. With versioning on for compose, `worker.env` must already carry
the matching `ZENITH_WORKER_VERSIONING` and `ZENITH_WORKER_BUILD_ID` or the script refuses
before replacing the worker.

The final step asks Temporal for workflows reporting a failing workflow task
(`TemporalReportedProblems`), which is where nondeterminism shows up as a stuck workflow. A
server without that search attribute reports `UNVERIFIED`, never a pass.

## Rolling a worker back across a patch

New histories carry markers old code has never seen. Temporal does not promise old code can
replay them, so do not assume a plain image rollback is safe once a new worker has advanced
workflows past a new patch. Either run with `pinned` (the old build keeps its own workflows
and the new build keeps the new ones) or roll back only while no workflow has passed the new
patch. This is documented, not tested: the upgrade rehearsal asserts old to new only.

## What this does not prove

- Real-server worker deployment routing (`set-current-version`, pinned drain) is not run by any
  committed test; it needs a Temporal server with deployments enabled. The configuration, the
  option mapping and the runbook commands are covered; the server behaviour is not.
- The compose and kubectl steps are unit-tested as plans and by a dry run; executing them needs
  Docker or a cluster and is the operational rehearsal below.
- The committed fixtures use scripted activities. Replay protects workflow determinism only.

## Operational rehearsal checklist (verifier machine with Docker)

1. Start the default compose topology on image A. Start two long approvals.
2. `plan`, then `upgrade --execute` to image B (expand migration, worker, API).
3. Confirm both approvals still resolve, the schema is current, and the verify step reports no
   workflow problems.
4. `rollback --execute` to image A and confirm the same.
