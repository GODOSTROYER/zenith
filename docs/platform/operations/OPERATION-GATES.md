# Required operation gates

Written against branch `ws/prod-operation-gates-20261003`, based on required operation gate input at `dc40ee9ad590640c78659796c9b932436ea1e426` (2026-10-03). This source-input pin does not establish runtime acceptance of the additive changes or live-provider behavior. Exact integrated verification remains separate.

The canonical manifest adds two mandatory lanes. Each CI matrix item starts its own fresh PostgreSQL 16.15 service and runs serially; neither item shares a database or a Temporal frontend with another job.

| Lane | Committed required cases | Engine and fixture scope |
| --- | --- | --- |
| `reconciliation` | 14 scheduler + 12 worker composition = 26 | Actual owned durable Temporal and PostgreSQL. Product membership ports and selected controller behavior are explicit models inside the real SQL/worker contract. |
| `workflow-intents` | 20 SQL + 2 tombstone privilege + 53 final authority + 27 PostgreSQL/Temporal + 21 wire models + 3 guards + 15 historical replay = 141 | The first 102 cases require actual PostgreSQL; the transport cases use independent real Temporal connections. The 21 raw response models and three guards are supplemental. Historical replay uses actual Temporal with existing scripted activities. |

Every case has a literal title, file and, where applicable, exact suite ancestry in `scripts/ci/gate-manifest.mjs`. Requirements survive missing test source. Missing, failed, skipped, pending, zero or malformed evidence fails the lane; a passing model cannot satisfy an actual scenario. PostgreSQL-labelled SQL cases cannot be replaced by PGlite. The validator and immutable execution receipt are the existing canonical gate implementation.

`platform-postgres` retains all existing suites and discovery, and additionally pins the same 75 intent SQL/privilege/authority cases plus 21 current-membership cases. The membership suite performs actual SQL/OPA/signing with a modeled product membership read; it does not prove a deployed product directory. `ZENITH_TEST_WORKFLOW_START_REQUIRED=1` and `ZENITH_TEST_DEFAULT_CURRENT_MEMBERSHIP_REQUIRED=1` make missing PostgreSQL a startup failure. The existing whole-suite discovery remains additional coverage when those files are present.

The ordinary `workflows` lane excludes exactly the external mTLS file, the CodeBuild PostgreSQL authority file and `start-intent.test.ts`. The two ordinary exclusions are required in `platform-postgres` and `workflow-intents`, respectively. Local replay remains mandatory in both its original workflow lane and the explicit 15-case intent replay set. External mTLS remains the sole separately recorded, unverified external acceptance group.

Use Node 22.23.3 and `npm ci --ignore-scripts`. Set `ZENITH_TEST_PLATFORM_PG_URL` to a fresh, explicitly owned loopback PostgreSQL 16.15 database. Intent privilege tests also require owned scratch `CREATEDB` and test-role administration. Apply the registered canonical migrations, including migration 12, before execution:

```sh
bash scripts/ci/apply-platform-migrations.sh
node scripts/ci/run-gate.mjs reconciliation --run
node scripts/ci/run-gate.mjs reconciliation --validate .data-ci-lane/reconciliation-lane.json --require-execution
node scripts/ci/run-gate.mjs workflow-intents --run
node scripts/ci/run-gate.mjs workflow-intents --validate .data-ci-lane/workflow-intents-lane.json --require-execution
```

Run the lanes against separate fresh databases. Reconciliation composition deliberately refuses a database containing unrelated operations or reconcile state. The local URL, binaries and disposable resources are operator-owned prerequisites, not permission to touch an existing application database.

CI copies the existing checksum-verified Temporal CLI 1.9.1 installer and exports `ZENITH_TEST_TEMPORAL_CLI`. New scheduler/outbox cases create their own persistent local dev servers. `reconciliation` forbids SDK downloads. `workflow-intents` retains `ZENITH_TEST_TEMPORAL_DOWNLOAD=1` solely for unchanged historical destroy replay, which uses the SDK time-skipping server. A local run may provide the existing `ZENITH_TEST_TEMPORAL_SERVER` binary/cache instead. Required replay startup/download failures fail the gate; no skip or model fallback is admitted.

Committed `policy/dist/policy.wasm` and its manifest are checked before execution and by the canonical in-process loader. The existing policy job still rebuilds the bundle and checks parity; these jobs need no additional OPA binary. CI unconditionally applies migrations, executes, independently revalidates with `--require-execution`, and uploads only the exact sanitized evidence file even after failure. Missing evidence fails upload. Raw reports, environment inventories, receipt sidecars, provider output and secrets are not uploaded.

Source preparation does not establish runtime acceptance. Registry/emitted SQL, frozen scheduler/outbox/current-membership imports and exact combined PostgreSQL/Temporal receipts are integration prerequisites owned by the root lane. These gates do not establish provider quiescence or authorize cleanup.
