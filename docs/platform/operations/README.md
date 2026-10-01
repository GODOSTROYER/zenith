# Operating the platform control plane

Operator documentation for the control plane described in
[ARCHITECTURE.md](../ARCHITECTURE.md): how to deploy it, recover it, connect a
customer cloud, run its policy and read its costs. It covers the modules that
have merged. The modules still being built are listed below and **deliberately not
documented**: a page written before the code exists is a promise, and this
documentation does not make promises.

Written against branch `ws/docs`, merged with `platform/integration` at `e5c1518` (2026-10-01).

## Read this first: what is real

The pieces below are built and tested, and the web half is joined: the capability
broker calls the policy engine and writes the ledger behind `/api/platform/v1`. The
path from an approved operation to a cloud is not: nothing starts a workflow from
one, the execution worker's activities are stubs that fail with `not_implemented`,
no merged driver is registered by the application, and nothing has run against a real
AWS account, Temporal Cloud or a Docker build. Two integration gaps are recorded in
[DEPLOYING.md](DEPLOYING.md#status-what-actually-runs-on-this-branch): the session
middleware does not let the agent and bearer routes through, and the policy bundle is not
traced into serverless builds. Each page says which of its statements were verified and
which were not, and the capability matrix says, per driver operation, what evidence
stands behind it (today: every operation is `contract`, and no entry claims `real`).

## The guides

| Guide | For | Covers |
|---|---|---|
| [DEPLOYING.md](DEPLOYING.md) | Whoever runs the install | Topology, every environment variable per component, the platform database and its migrations, signing keys, Temporal (local, Cloud, self-hosted), the execution worker, what must never run on Vercel, first-install order |
| [RECOVERY.md](RECOVERY.md) | Whoever is on call | What state lives where and how to back it up, disaster recovery order, what happens to an operation when something crashes (`uncertain`, the reconciler, the reaper), leases and fence tokens, key rotation, migrating the schema forward, and what was rehearsed |
| [AWS-SETUP.md](AWS-SETUP.md) | The owner of a customer AWS account | What connecting an account creates, what Zenith can and cannot do in it, how narrow a session is, and how to revoke. Commands live in [`deploy/aws/README.md`](../../../deploy/aws/README.md) |
| [POLICY.md](POLICY.md) | Whoever tunes authorization | How a decision is made, the rules in summary, workspace parameters, autonomy levels 0 to 5, decision records, changing a rule and rebuilding the bundle |
| [COST.md](COST.md) | Whoever shows a number to a user | Estimates versus forecasts versus actuals (only estimates exist), what an estimate includes and excludes, the price catalog, its evidence classes and how to refresh it |
| [CAPABILITY-MATRIX.md](../CAPABILITY-MATRIX.md) | Anyone deciding what to trust | **Generated.** Provider by native type by operation, with the evidence level each driver declares, the observability sources and the capability catalog |

Reference material these guides lean on (not duplicated here):

| Document | What it is |
|---|---|
| [ARCHITECTURE.md](../ARCHITECTURE.md) | The control-plane design and its invariants |
| [CURRENT-STATE.md](../CURRENT-STATE.md) | The baseline audit the build started from |
| [EXECUTION-WORKER.md](../EXECUTION-WORKER.md) | Workflows, retries, leases, approval, cancellation, worker configuration |
| [DRIVER-CONVENTIONS.md](../DRIVER-CONVENTIONS.md) | How every provider's resource drivers must behave |
| [RUNNER-PROTOCOL.md](../RUNNER-PROTOCOL.md) | The wire protocol for `zenith-runner` and `zenithd` |
| [RUNNER.md](../RUNNER.md), [ZENITHD.md](../ZENITHD.md) | Operator guides for the two Go agents, written by the workstream that built them (not reviewed or verified here) |
| [`src/lib/credentials/OPERATIONS.md`](../../../src/lib/credentials/OPERATIONS.md) | The credential broker's environment, key generation, KMS and rotation |
| [`policy/README.md`](../../../policy/README.md) | Every policy rule, its condition and its reason code |
| [`docs/adr/`](../../adr/README.md) | The decisions, ADR-0001 to ADR-0016 |

## What is merged, and where it is documented

| Module | Code | Documented in |
|---|---|---|
| Capability broker and REST | `src/lib/capabilities/**`, `src/app/api/platform/v1/**` | [DEPLOYING.md](DEPLOYING.md#28-capability-broker-approvals-and-the-agent-routes), [POLICY.md](POLICY.md), [RECOVERY.md](RECOVERY.md#4-what-happens-to-an-operation-when-something-crashes). Joined to the store and the policy engine; not joined to the worker. No standalone guide (planned) |
| Runner and `zenithd` control-plane side | `src/lib/runners/**`, `src/app/api/platform/v1/runners/**`, `.../machines/**` | [DEPLOYING.md](DEPLOYING.md#status-what-actually-runs-on-this-branch), [RECOVERY.md](RECOVERY.md#44-runner-jobs). Gaps: the middleware allow list, no reaper timer, no activity enqueues |
| Control store | `src/lib/controlplane/**`, `scripts/platform/**`, `supabase/migrations/0014_platform_core.sql` | [DEPLOYING.md](DEPLOYING.md#3-the-platform-database), [RECOVERY.md](RECOVERY.md) |
| Credential broker and OIDC issuer | `src/lib/credentials/**`, `src/app/api/oidc/**`, `deploy/aws/**` | [`OPERATIONS.md`](../../../src/lib/credentials/OPERATIONS.md), [DEPLOYING.md](DEPLOYING.md#23-workload-identity-and-control-plane-signing), [AWS-SETUP.md](AWS-SETUP.md), [RECOVERY.md](RECOVERY.md#6-key-rotation) |
| OpenTofu engine | `src/lib/tofu/**` | [DEPLOYING.md](DEPLOYING.md#26-opentofu-engine), [ADR-0005](../../adr/0005-opentofu-hybrid.md) |
| Policy engine | `policy/**`, `src/lib/policy/**` | [POLICY.md](POLICY.md) |
| Resource model | `src/lib/resources/**` | [ADR-0003](../../adr/0003-resource-model-v2.md). A pure library with nothing to operate |
| Placement and cost | `src/lib/placement/**` | [COST.md](COST.md) |
| Observability fabric | `src/lib/observability/**` | [CAPABILITY-MATRIX.md](../CAPABILITY-MATRIX.md#observability-sources), [ADR-0011](../../adr/0011-observability-federated.md). Reads no environment variables; no operator guide yet (planned) |
| Temporal workflows and worker | `src/lib/workflows/**`, `workers/execution/**`, `docker/worker.Dockerfile` | [EXECUTION-WORKER.md](../EXECUTION-WORKER.md), [DEPLOYING.md](DEPLOYING.md#5-temporal) |
| Reconciliation controller | `src/lib/reconcile/**`, `src/app/api/internal/tick/reconcile/route.ts`, migration 2 | [DEPLOYING.md](DEPLOYING.md#29-reconciliation-tick), [RECOVERY.md](RECOVERY.md#45-what-to-do-with-an-uncertain-operation). Merged but not driven: no production ports are wired and no schedule calls the route |
| Go agents | `go/**`, `deploy/helm/zenith-runner/**`, `deploy/zenithd/**`, `docker/runner.Dockerfile`, `docker/zenithd.Dockerfile` | [RUNNER.md](../RUNNER.md), [ZENITHD.md](../ZENITHD.md). Their control-plane side is the row above |
| Resource drivers (AWS, GCP, Azure, OCI, Kubernetes, Zenith-managed) | `src/lib/providers/*/drivers/**` | [CAPABILITY-MATRIX.md](../CAPABILITY-MATRIX.md) (generated; every operation `contract`), [MANAGED-PLATFORM.md](../MANAGED-PLATFORM.md) for the managed provider. Merged; **registered by nothing** in the application; no operator guide of ours (planned) |
| Machine plane | `src/lib/machines/**`, `deploy/aws/ssm-documents/**` | [DEPLOYING.md](DEPLOYING.md#status-what-actually-runs-on-this-branch). Called by nothing outside the module; Azure Run Command and GCP OS management have no driver |
| Real execution activities | `src/lib/execution/**` | [DEPLOYING.md](DEPLOYING.md#status-what-actually-runs-on-this-branch), [EXECUTION-WORKER.md](../EXECUTION-WORKER.md). Written against ports; **the worker still registers the stubs** |
| Incident engine | `src/lib/incidents/**` | [ADR-0014](../../adr/0014-incident-engine.md). A library that reads no environment, takes its probes as injected ports and is called by nothing yet; no operator guide (planned) |
| Repository analysis | `src/lib/analysis/**` | Not part of the control plane's operation: it turns a repository snapshot into a proposed manifest. Reads no environment; nothing to operate |
| Platform UI components | `src/components/platform/**` | [README](../../../src/components/platform/README.md) in that folder. Presentational only (data and callbacks arrive as props); no page renders them yet |
| CI gates | `.github/workflows/ci.yml`, `.github/workflows/live-acceptance.yml`, `scripts/ci/**` | [DEPLOYING.md](DEPLOYING.md#9-what-was-and-was-not-verified); see "Where `real` evidence will come from" below |

## In progress, not documented here

These are being built in other workstreams. Until they merge, nothing on this
branch behaves the way a guide could describe, so there is no guide:

- the provider-level driver registration (nothing registers the merged AWS network
  drivers), the remaining AWS driver groups, and the Kubernetes, GCP, Azure, OCI and
  managed `zenith` provider sets
- starting a workflow from an approved operation, and wiring the real activities
  (`src/lib/execution`) and their ports into the worker
- application-level registration of the drivers (nothing calls any `register<Provider>Drivers`)
- repair: the reconcile workflow and the controller observe, diff and *propose*;
  nothing executes a repair, and the controller's production ports are not wired
- the REST connections route (the rest of `/api/platform/v1` has merged) and MCP v3
- the platform screens and pages (the presentational components have merged;
  nothing renders them)
- the real worker activities
- wiring the incident engine to real probes and to the broker

## Planned guides

Not written, because the module each describes is not merged. Names are
placeholders.

| Planned guide | Waits for |
|---|---|
| `MACHINES.md` | The machine plane once something calls it, and its AWS SSM and Kubernetes transports (the agent's own guide exists: ZENITHD.md) |
| `INCIDENTS.md` | The incident engine being wired to real probes, the broker and a route |
| `OBSERVABILITY.md` | Source configuration, partial answers and redaction, once sources are wired to a route |
| `CAPABILITY-BROKER.md` | A standalone guide to proposing, approving and executing once a workflow starts from an approved operation (today POLICY.md and DEPLOYING.md cover what exists), and MCP v3 |
| `GCP-SETUP.md`, `AZURE-SETUP.md`, `OCI-SETUP.md`, `KUBERNETES.md` | Their drivers being registered and a credential exchange verified against a real account (`deploy/gcp`, `deploy/azure`, `deploy/oci` hold the customer-side bootstrap, unreviewed here) |

## Commands these guides use

| Command | What it does | Guide |
|---|---|---|
| `npm run migrate:platform` (`-- --status`, `-- --dry-run`, `-- --url <uri>`) | Apply, inspect or preview platform schema migrations | [DEPLOYING.md](DEPLOYING.md#32-migrating) |
| `npm run platform:emit-sql` (`-- --check`) | Regenerate or check the Supabase SQL file | [DEPLOYING.md](DEPLOYING.md#32-migrating) |
| `npm run worker` | Run the execution worker (development) | [DEPLOYING.md](DEPLOYING.md#51-locally) |
| `temporal server start-dev --headless --port <p>` | A local Temporal | [DEPLOYING.md](DEPLOYING.md#51-locally) |
| `npm run policy:build`, `npm run policy:check` | Build, or verify, the policy bundle | [POLICY.md](POLICY.md#changing-a-rule) |
| `npx tsx scripts/docs/capability-matrix.ts` (`--check`) | Regenerate or check the capability matrix | [CAPABILITY-MATRIX.md](../CAPABILITY-MATRIX.md) |
| `npx vitest run tests/docs` | Check these docs against the code (see below) | this page |

## Where `real` evidence will come from

Every evidence level is a claim about a run. `real` means a live acceptance run
against a real provider account, and the only path to one in the repository is
`.github/workflows/live-acceptance.yml`: dispatch-only, gated by a protected GitHub
environment named `live-sandbox`, authenticating to AWS with GitHub's OIDC token and
no stored credential. It has **never been executed**: there is no sandbox AWS account
(ledger blocker B-AWS-LIVE), and the harness it calls, `scripts/acceptance/aws-live.ts`,
is not present on this branch. Until a run is recorded and linked, the capability
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
- **Stale by design.** Each page names the commit it was written against. When a
  module in the list above merges, its page is written then, not before.
