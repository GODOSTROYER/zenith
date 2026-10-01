# Operating the platform control plane

Operator documentation for the control plane described in
[ARCHITECTURE.md](../ARCHITECTURE.md): how to deploy it, recover it, connect a
customer cloud, run its policy and read its costs. It describes current wiring
and records the remaining limits separately from live verification.

Written against branch `ws/docs-sync`, based on `platform/integration` at `e3ea61a` (2026-10-01).

## Read this first: what is real

`src/lib/platform/app.ts` composes the store, broker, drivers, runner queues and
reconciliation. `src/lib/platform/execution.ts` composes the activities the worker
registers; product deploys and MCP v3 dispatch workflows. Platform pages render
the components, bearer/signed-agent middleware paths are classified, and the
policy bundle is traced into serverless builds. The reconcile route is included
in the five-minute tick and cron passes run the runner-job reaper.

These are source-verified wiring claims, not a live-cloud acceptance run. No
driver or source has `real` evidence. A non-AWS verified connection, OCI platform
session, hosted Zenith substrate, readable plan approval artifact, or MCP cloud
read hook must not be inferred from driver registration alone. See the status
and limits in [DEPLOYING.md](DEPLOYING.md#status-what-actually-runs-on-this-branch).

## The guides

| Guide | For | Covers |
|---|---|---|
| [DEPLOYING.md](DEPLOYING.md) | Whoever runs the install | Topology, every environment variable per component, the platform database and its migrations, signing keys, Temporal (local, Cloud, self-hosted), the execution worker, what must never run on Vercel, first-install order |
| [RECOVERY.md](RECOVERY.md) | Whoever is on call | What state lives where and how to back it up, disaster recovery order, what happens to an operation when something crashes (`uncertain`, the reconciler, the reaper), leases and fence tokens, key rotation, migrating the schema forward, and what was rehearsed |
| [AWS-SETUP.md](AWS-SETUP.md) | The owner of a customer AWS account | What connecting an account creates, what Zenith can and cannot do in it, how narrow a session is, and how to revoke. Commands live in [`deploy/aws/README.md`](../../../deploy/aws/README.md) |
| [POLICY.md](POLICY.md) | Whoever tunes authorization | How a decision is made, the rules in summary, workspace parameters, autonomy levels 0 to 5, decision records, changing a rule and rebuilding the bundle |
| [COST.md](COST.md) | Whoever shows a number to a user | Estimates versus forecasts versus actuals (only estimates exist), what an estimate includes and excludes, the price catalog, its evidence classes and how to refresh it |
| [CAPABILITY-MATRIX.md](../CAPABILITY-MATRIX.md) | Anyone deciding what to trust | **Generated.** Provider by native type by operation, with the evidence level each driver declares, the observability sources and the capability catalog |

At this snapshot the committed matrix predates application driver registration
and fails its generation check. WS-DRIVER-FIX owns its regeneration and the stale
registration assertion in `tests/docs/capability-matrix.test.ts`. Until that sync
lands, use `src/lib/platform/drivers.ts` for registration wiring; the matrix's
old registration column does not describe the composed app. Evidence remains
`contract`, never live verification.

Reference material these guides lean on (not duplicated here):

| Document | What it is |
|---|---|
| [ARCHITECTURE.md](../ARCHITECTURE.md) | The control-plane design and its invariants |
| [CURRENT-STATE.md](../CURRENT-STATE.md) | The baseline audit the build started from |
| [EXECUTION-WORKER.md](../EXECUTION-WORKER.md) | Workflows, retries, leases, approval, cancellation, worker configuration |
| [CLI.md](../CLI.md), [MCP.md](../MCP.md) | Operator CLI, REST SDK, fifteen MCP v3 tools, browser approval and execution |
| [RUNNER-PROTOCOL-OCI.md](../RUNNER-PROTOCOL-OCI.md) | Opt-in `oci.http` signing proxy and its remaining session limits |
| [DRIVER-CONVENTIONS.md](../DRIVER-CONVENTIONS.md) | How every provider's resource drivers must behave |
| [RUNNER-PROTOCOL.md](../RUNNER-PROTOCOL.md) | The wire protocol for `zenith-runner` and `zenithd` |
| [RUNNER.md](../RUNNER.md), [ZENITHD.md](../ZENITHD.md) | Operator guides for the two Go agents, written by the workstream that built them (not reviewed or verified here) |
| [`src/lib/credentials/OPERATIONS.md`](../../../src/lib/credentials/OPERATIONS.md) | The credential broker's environment, key generation, KMS and rotation |
| [`policy/README.md`](../../../policy/README.md) | Every policy rule, its condition and its reason code |
| [`docs/adr/`](../../adr/README.md) | The decisions, ADR-0001 to ADR-0016 |

## What is merged, and where it is documented

| Module | Code | Documented in |
|---|---|---|
| Capability broker and REST | `src/lib/capabilities/**`, `src/app/api/platform/v1/**`, `src/lib/platform/broker.ts` | [DEPLOYING.md](DEPLOYING.md#28-capability-broker-approvals-and-the-agent-routes), [POLICY.md](POLICY.md), [MCP.md](../MCP.md). Worker policy and grant consumption use the execution broker |
| Runner and `zenithd` control-plane side | `src/lib/runners/**`, `src/app/api/platform/v1/runners/**`, `.../machines/**` | [DEPLOYING.md](DEPLOYING.md#status-what-actually-runs-on-this-branch), [RECOVERY.md](RECOVERY.md#44-runner-jobs). Signed middleware paths, AWS runner transport and cron reaper are wired |
| Control store | `src/lib/controlplane/**`, `scripts/platform/**`, `supabase/migrations/0014_platform_core.sql` | [DEPLOYING.md](DEPLOYING.md#3-the-platform-database), [RECOVERY.md](RECOVERY.md) |
| Credential broker and OIDC issuer | `src/lib/credentials/**`, `src/app/api/oidc/**`, `deploy/aws/**` | [`OPERATIONS.md`](../../../src/lib/credentials/OPERATIONS.md), [DEPLOYING.md](DEPLOYING.md#23-workload-identity-and-control-plane-signing), [AWS-SETUP.md](AWS-SETUP.md), [RECOVERY.md](RECOVERY.md#6-key-rotation) |
| OpenTofu engine | `src/lib/tofu/**` | [DEPLOYING.md](DEPLOYING.md#26-opentofu-engine), [ADR-0005](../../adr/0005-opentofu-hybrid.md) |
| Policy engine | `policy/**`, `src/lib/policy/**` | [POLICY.md](POLICY.md) |
| Resource model | `src/lib/resources/**` | [ADR-0003](../../adr/0003-resource-model-v2.md). A pure library with nothing to operate |
| Placement and cost | `src/lib/placement/**` | [COST.md](COST.md). REST, actions, MCP and `/platform/placement`; execution persists estimates |
| Observability fabric | `src/lib/observability/**` | [CAPABILITY-MATRIX.md](../CAPABILITY-MATRIX.md#observability-sources), [ADR-0011](../../adr/0011-observability-federated.md). Reads no environment variables; no operator guide yet (planned) |
| Temporal workflows and worker | `src/lib/workflows/**`, `workers/execution/**`, `docker/worker.Dockerfile` | [EXECUTION-WORKER.md](../EXECUTION-WORKER.md), [DEPLOYING.md](DEPLOYING.md#5-temporal) |
| Reconciliation controller | `src/lib/reconcile/**`, `src/lib/platform/reconcile.ts`, `src/app/api/internal/tick/reconcile/route.ts`, migration 2 | [DEPLOYING.md](DEPLOYING.md#29-reconciliation-tick), [RECOVERY.md](RECOVERY.md#45-what-to-do-with-an-uncertain-operation). Ports wired, tick scheduled; allowed repair proposals dispatch day-two workflows |
| Go agents | `go/**`, `deploy/helm/zenith-runner/**`, `deploy/zenithd/**`, `docker/runner.Dockerfile`, `docker/zenithd.Dockerfile` | [RUNNER.md](../RUNNER.md), [ZENITHD.md](../ZENITHD.md). Their control-plane side is the row above |
| Resource drivers (AWS, GCP, Azure, OCI, Kubernetes, Zenith-managed) | `src/lib/providers/*/drivers/**`, `src/lib/platform/drivers.ts` | [CAPABILITY-MATRIX.md](../CAPABILITY-MATRIX.md) (generated; contract evidence), [MANAGED-PLATFORM.md](../MANAGED-PLATFORM.md). Registered by `registerAllDrivers`; sessions still have provider-specific limits |
| Machine plane | `src/lib/machines/**`, `src/lib/execution/capability.ts`, `deploy/aws/ssm-documents/**` | [DEPLOYING.md](DEPLOYING.md#status-what-actually-runs-on-this-branch). Activity path exists but requires an injected machine port; default composition supplies none. Azure Run Command and GCP OS management have no transport driver |
| Execution activities | `src/lib/execution/**`, `src/lib/platform/execution.ts` | [DEPLOYING.md](DEPLOYING.md#6-the-execution-worker), [EXECUTION-WORKER.md](../EXECUTION-WORKER.md). Worker delegates to composed implementations; stubs are an explicit test factory |
| Incident engine | `src/lib/incidents/**` | [ADR-0014](../../adr/0014-incident-engine.md). A library that reads no environment, takes its probes as injected ports and is called by nothing yet; no operator guide (planned) |
| Repository analysis | `src/lib/analysis/**` | Not part of the control plane's operation: it turns a repository snapshot into a proposed manifest. Reads no environment; nothing to operate |
| Platform UI components | `src/components/platform/**`, `src/app/(product)/platform/**` | [Page wiring](../../../src/app/%28product%29/platform/README.md). Pages read broker-authorized stored state; missing observations and plan artifacts stay missing |
| CI gates | `.github/workflows/ci.yml`, `.github/workflows/live-acceptance.yml`, `scripts/ci/**` | [DEPLOYING.md](DEPLOYING.md#9-what-was-and-was-not-verified); see "Where `real` evidence will come from" below |

## Remaining integration limits

These limits are present in code; they are not promises about delivery dates:

- OCI platform ProviderSession integration and non-AWS runner sessions
  (`src/lib/platform/credentials.ts`); non-AWS connection verification is wired.
- The standalone REST connections route; AWS setup already uses the product's
  browser action adapter and page.
- A readable matching PlanView artifact for plan-bound UI approvals.
- MCP cloud-read and incident-investigator registration hooks.
- A timer for the standalone `reconcileOperations` ledger backstop. Runner-job
  reaping and environment reconciliation are already scheduled.
- Live provider/session/backend acceptance and a hosted Zenith substrate.

## Planned guides

Standalone guides not written yet. Existing coverage is linked above; a planned
guide does not imply its implementation is absent.

| Planned guide | Waits for |
|---|---|
| `MACHINES.md` | A consolidated guide to the wired machine plane and its transport permission limits (the agent's guide exists: ZENITHD.md) |
| `INCIDENTS.md` | The incident engine being wired to real probes, the broker and a route |
| `OBSERVABILITY.md` | Consolidated source configuration, partial answers and redaction; MCP registration remains unavailable |
| `CAPABILITY-BROKER.md` | Standalone coverage; POLICY.md, DEPLOYING.md and MCP.md already describe the wired path |
| `GCP-SETUP.md`, `AZURE-SETUP.md`, `OCI-SETUP.md`, `KUBERNETES.md` | Non-AWS identity verification and live acceptance (`deploy/gcp`, `deploy/azure`, `deploy/oci` hold customer-side bootstrap); drivers are registered |

## Commands these guides use

| Command | What it does | Guide |
|---|---|---|
| `npm run migrate:platform` (`-- --status`, `-- --dry-run`, `-- --url <uri>`) | Apply, inspect or preview platform schema migrations | [DEPLOYING.md](DEPLOYING.md#32-migrating) |
| `npm run platform:emit-sql` (`-- --check`) | Regenerate or check the Supabase SQL file | [DEPLOYING.md](DEPLOYING.md#32-migrating) |
| `npm run worker` | Run the execution worker (development) | [DEPLOYING.md](DEPLOYING.md#51-locally) |
| `temporal server start-dev --headless --port <p>` | A local Temporal | [DEPLOYING.md](DEPLOYING.md#51-locally) |
| `npm run policy:build`, `npm run policy:check` | Build, or verify, the policy bundle | [POLICY.md](POLICY.md#changing-a-rule) |
| `npx tsx scripts/docs/capability-matrix.ts` (`--check`) | Regenerate or check the capability matrix | [CAPABILITY-MATRIX.md](../CAPABILITY-MATRIX.md) |
| `npm run cli -- --help` | Run the CLI; commands and credential handling in [CLI.md](../CLI.md) | CLI.md |
| `npx vitest run --maxWorkers=2 tests/docs` | Check these docs against the code (see below) | this page |

## Where `real` evidence will come from

Every evidence level is a claim about a run. `real` means a live acceptance run
against a real provider account, and the only path to one in the repository is
`.github/workflows/live-acceptance.yml`: dispatch-only, gated by a protected GitHub
environment named `live-sandbox`, authenticating to AWS with GitHub's OIDC token and
no stored credential. It has **never been executed**: there is no sandbox AWS account
(ledger blocker B-AWS-LIVE). The harness it calls, `scripts/acceptance/aws-live.ts`
(scenarios A–J, see [ACCEPTANCE.md](../ACCEPTANCE.md)), has run only locally: Demo J's
planning chain and dry runs of A–I, never against a cloud. Until a run is recorded and linked, the capability
matrix has no `real` entry and `tests/docs/` fails if one appears.

## How these docs are kept honest

- **The matrix is generated**, from the driver registry, the observability
  evidence table and the capability catalog; it is never edited by hand.
- **`tests/docs/` checks the rest.** Every relative link and heading anchor under
  `docs/platform/` must resolve; every file path these guides name in code spans
  must exist; every environment variable the modules read must appear in
  [DEPLOYING.md](DEPLOYING.md#2-environment-variables) and every variable named
  there must exist in the code; the policy rule counts, the price catalog counts and
  the cost engine's included and excluded lists on these pages must equal what the
  code says now; this page must list every guide in the folder; the statement above
  about the live-acceptance harness must match the filesystem; and no matrix entry
  may claim `real`. A change to the code that makes a page wrong fails the test,
  which is the point.
- **Verified versus reasoned.** A statement that was checked by running something
  says what was run. A statement reasoned from the code but not run is marked
  **reasoned**. Anything that needs a real cloud account, Temporal Cloud or a
  Docker build says it is not verified.
- **Source snapshot.** Each guide names its base commit. The wiring assertions
  must fail when the documented composition calls are removed. Historical run
  records remain dated; they are not rerun evidence for this snapshot.
