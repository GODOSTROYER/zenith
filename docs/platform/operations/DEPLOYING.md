# Deploying the platform control plane

How the pieces of the platform control plane fit together, what each one needs
in its environment, and how to run them. This is for whoever operates a Zenith
install; the design is in [ARCHITECTURE.md](../ARCHITECTURE.md) and the ADRs.

Written against branch `ws/docs-sync-2`, based on `ws/integrate-w6` at `3c1fa66` (2026-10-01). Everything
here is checked against the code on that branch; anything that is not verified
live says so, and the last section collects them.

## Status: what actually runs on this branch

The control plane is being built in several workstreams. Read this table before
the rest of the page, because a component that is "deployed" is not necessarily
doing work yet.

| Component | State on this branch |
|---|---|
| Platform control store (Postgres `platform` schema, PGlite locally) | Opened by the broker/routes, migration script and worker (`workers/execution/startup.ts`). The worker requires explicit configuration and checks schema before polling. `src/lib/platform/app.ts` composes the shared runtime only for an explicitly configured store. Real Postgres tests are gated by `ZENITH_TEST_PLATFORM_PG_URL`; not run in this sync. |
| Credential broker and OIDC issuer | Built with contract tests using mocks. The Next app serves the two public routes (`/api/oidc/jwks`, `/api/oidc/.well-known/openid-configuration`), and the control signing key signs capability grants. No live AWS STS or KMS verification is recorded. |
| OpenTofu engine (`src/lib/tofu`) | Worker composition supplies `planWorkspace` and `applyVerifiedPlan` in `src/lib/platform/execution.ts`. State backend selection is provider-specific (section 2.14). No live-cloud backend/apply was verified in this sync. |
| Policy engine (`policy/`, `src/lib/policy`) | Broker and worker execution broker load the committed bundle. `src/lib/platform/broker.ts` supplies plan facts/cost to worker policy evaluation. `next.config.ts` traces the bundle and the worker Dockerfile copies it (section 2.7); neither deployment was built here. |
| Capability broker and REST `/api/platform/v1` (`src/lib/capabilities`, `src/app/api/platform/v1`) | Merged and tested. Routes: `capabilities/check` and `propose`; `operations` (list, get, events, approve, reject, cancel); `environments/[id]/autonomy`; `workspace/policy`. Approve, reject and the two admin settings are **browser-only**: any `Authorization` header is refused, the identity is verified live and the `Origin` must match (section 2.8). Integrations call with a `za_` bearer. **Over REST** an `infrastructure.apply` or `infrastructure.destroy` capability proposal is always denied `plan_required`, because the reviewed plan can only come from the execution side. The browser approval route can deliver approval through the deploy/destroy bridge and start an approved destroy workflow. Integration bearer calls and runner/`zenithd` calls pass the session middleware only on their classified paths (section 2.8). |
| Runner and `zenithd` control-plane side (`src/lib/runners`, routes under `runners/*` and `machines/*`) | Signed authentication, replay protection, queues and sealed results are wired. AWS runner sessions use `src/lib/runners/aws-runner-transport.ts`; machine execution uses `src/lib/execution/capability.ts`. Cron passes call `platformRunnerReaperPass` in `src/lib/platform/app.ts`. `oci.http` is wired in dispatch and the Go executor; no live transport acceptance is claimed. |
| Resource model, placement and cost, observability | Worker composition supplies cost and observability ports. Placement is exposed by REST, actions, MCP and `/platform/placement` (COST.md). Legacy cost screens keep the older pricing table. App composition registers the MCP cloud-read hook through `src/lib/platform/agent-ports.ts`; OCI signals use the registered runner (OCI-SIGNALS.md). |
| Incident engine, repository analysis and platform UI | App composition registers the MCP investigator with tenant-scoped read ports (`src/lib/platform/agent-ports.ts`). Repository analysis remains a library. Platform pages render stored resources, drift/incidents, operations, policy, AWS setup, placement and teardown. Stored incidents do not prove fresh investigation. |
| Temporal workflows, client and execution worker | `workers/execution/worker.ts` opens the store and calls `createActivities`, which delegates to `composeExecutionActivities` in `src/lib/platform/execution.ts`. Product deploy bridge and MCP v3 start workflows. `createStubActivities` is an explicit test factory, never a production fallback. Startup requirements are section 6.2; this wiring has not been live-cloud verified. |
| Reconciliation controller (`src/lib/reconcile`, migration 2, `POST /api/internal/tick/reconcile`) | `ensurePlatformApp` registers `wireReconcilePorts`; the route boots composition after cron authentication. `.github/workflows/tick.yml` includes reconcile every five minutes. The controller observes and proposes repairs; allowed proposals dispatch day-two workflows through `src/lib/platform/reconcile.ts`. Unsupported execution can still fail. See section 2.9. |
| `zenith-runner` and `zenithd` (Go, `go/`, Helm chart, Dockerfiles) | Built by another workstream, with their own operator guides: [RUNNER.md](../RUNNER.md) and [ZENITHD.md](../ZENITHD.md). The control-plane side is the row above, with the gaps listed there. I did not run or verify the agents. |
| Machine plane (`src/lib/machines`) | Default composition supplies the `machines` port: workspace-scoped observations select AWS SSM fixed documents, Azure managed Run Command or read-only GCP Compute/OS Inventory; a uniquely bound, active registered machine selects the signed `zenithd` queue. Cloud calls use the operation's credential-broker session and existing policy/approval gates; `machine.exec` remains an admin-approved escape hatch. GCP guest mutations require `zenithd`. Kubernetes guest execution still requires an injected credential resolver. No live transport was verified. See [AWS-SETUP.md](AWS-SETUP.md) for customer permissions. |
| Provider drivers | `src/lib/platform/drivers.ts` calls all six provider registrars; evidence remains contract-only. `src/lib/platform/credentials.ts` verifies GCP, Azure and Kubernetes connections; OCI verification checks runner registration only, and OCI sessions require that runner. Runner modes for other non-AWS providers remain refused. A hosted managed substrate is not verified ([MANAGED-PLATFORM.md](../MANAGED-PLATFORM.md)). |
| Environment teardown | Browser admin action `env.teardown` consumes trusted recorded destroy evidence, proposes for approval and starts the destroy workflow after browser approval. The first destroy-review trigger and matching readable approval artifact remain entry-point gaps; see [TEARDOWN.md](TEARDOWN.md). |
| Builds from source | Default source preparation uploads canonical ZIP to customer S3 for AWS CodeBuild, or tar.gz to GCS for GCP Cloud Build. Azure ACR adapters require injected source wiring; default composition refuses. See [BUILDS.md](BUILDS.md). |
| Connections and approvals | `/platform/connections/aws` saves/verifies via its browser action adapter. No standalone `/api/platform/v1/connections` route exists. `/platform/operations/[id]` renders review; plan-bound approval stays disabled without a readable matching PlanView artifact. See `src/app/(product)/platform/README.md`. |

Machine dispatch stores an immutable, tenant-scoped evidence marker before contacting
the transport. Repeated completed requests replay a sealed result; a competing,
interrupted or unreadable request is uncertain and is never dispatched again. An
operation id cannot be reused with changed arguments, target, simulation mode or
budgets. Local grant, constraint and argument checks still run on every retry.
Outputs are bounded and redacted; evidence summaries exclude file contents, log
lines and DNS answers. Escape-hatch output is retained as a sealed artifact in the
existing idempotency store, referenced by `blobRef`, rather than placed in summaries
or workflow history. Replay results and artifacts use a separate HKDF domain of
`ZENITH_SECRET_KEY`; rotating that key makes older artifacts unreadable. The cache
may be pruned after 30 days; the dispatch marker remains and prevents re-execution.
An operator must reconcile an uncertain operation and submit a newly authorized
operation to try again. Sandbox transports remain explicitly simulated.

The execution path is composed, but no live-cloud success is recorded. Configure
the worker and a verified connection before dispatching; a started workflow is
not proof of a changed or healthy environment. Poll recorded status and events,
and preserve `unknown`, `unavailable` and `uncertain` outcomes.

## 1. Topology

```
 browser / REST / MCP / CLI
            |
            v
 +----------------------------+          +---------------------------+
 | web / API control plane    |  start / |  Temporal                 |
 | Next.js (Vercel or a Node  |  signal  |  Cloud or self-hosted;    |
 | host)                      |--------->|  `temporal server         |
 |  - /api/oidc/*             |  query   |  start-dev` locally       |
 |  - broker, /api/platform/v1 |          +-------------+-------------+
 |  - Temporal client         |                        | polls
 +-------------+--------------+                        v
               |                          +---------------------------+
               |  SQL (pooler)            | execution worker          |
               v                          | long-running container    |
 +----------------------------+           |  - workflows (sandbox)    |
 | platform Postgres          |<----------|  - composed activities   |
 | schema `platform`          |   SQL     |  - tofu binary            |
 +----------------------------+           +------+-------------+------+
                                                 |             |
                              brokered provider session        | provider state
                                                 v             v
                                        customer cloud / cluster
```

| Component | Runs on | State it holds | Talks to |
|---|---|---|---|
| Web / API control plane | Vercel or any Node host | Reads the product store; reads and writes the platform store | platform Postgres; Temporal start, signal and query via the deploy bridge and MCP adapters |
| Execution worker | A long-running container built from `docker/worker.Dockerfile` | Private local binary plans in `ZENITH_WORKER_PLAN_DIR`; ledger state is in Postgres | Temporal, platform/product stores, cloud APIs, provider downloads and customer state storage |
| Temporal | Temporal Cloud, self-hosted, or `temporal server start-dev` locally | Payloads encrypted by the client/worker codec; ids, visibility and default failure text are outside that encryption | The web app and the worker |
| Platform Postgres | Supabase (Supavisor transaction pooler) or any Postgres 16 | Schema `platform`: operations, leases, approvals, decisions, resources, connections | Web and worker |
| `zenith-runner`, `zenithd` (optional) | Customer VPC / VMs | Identity, replay cache, local saved plans/audit; see [RUNNER.md](../RUNNER.md) and [ZENITHD.md](../ZENITHD.md) | Outbound to the control plane and locally authorized cloud APIs |

### What must never run on Vercel

**The execution worker.** It is a process that polls Temporal continuously and
runs `tofu plan` and `tofu apply` for tens of minutes as child processes (the
workflow allows an apply up to 60 minutes, see [EXECUTION-WORKER.md](../EXECUTION-WORKER.md#retries-timeouts-heartbeats)).
A request-scoped serverless function can do neither. The worker is built as a
container for that reason.

Also keep off a serverless host:

- **PGlite as the platform store.** With no platform database URL set, the store
  defaults to PGlite on the local filesystem (`<ZENITH_DATA>/platform-pg`); on a
  serverless instance that is neither durable nor shared between instances. On
  Vercel set `ZENITH_PLATFORM_DB_URL` (or `SUPABASE_DB_URL`) explicitly.
- **The `tofu` binary and provider downloads.** Planning and applying belong to
  the worker, never to a route.

What may run on Vercel: the web app, the OIDC routes, and the Temporal *client*
(start / signal / query), which needs the Node runtime (not edge) and is already
listed in `serverExternalPackages` in `next.config.ts`.

## 2. Environment variables

### 2.1 How they are read

Configuration is read at the entry points below. Composition also reads the
secret key and plan directory. Validation reports variable names and fixed
guidance rather than secret values; it does not verify live provider readiness:

| Concern | The one reader | Also validated at boot by `env()`? |
|---|---|---|
| Platform store | `platformDbConfigFromEnv` in `src/lib/controlplane/db/open.ts` | Yes: `ZENITH_PLATFORM_DB*` are in the schema in `src/lib/env.ts` |
| Workload identity and signing keys | `loadCredentialsConfig` in `src/lib/credentials/config.ts` | Declared in `env.ts` but left loose there; the loader validates |
| Temporal connection | `temporalConfigFromEnv` in `src/lib/workflows/config.ts` | No |
| Execution worker | `executionWorkerConfigFromEnv` in `workers/execution/config.ts` | No |
| Execution composition and startup | `derivePlanFingerprintKey` in `src/lib/platform/execution.ts`, `workers/execution/startup.ts` and `workers/execution/worker.ts` | Startup validates its required inputs before polling |
| OpenTofu binary and plugin cache | `resolveTofuBinary` (`src/lib/tofu/binary.ts`) and `TofuRunner` (`src/lib/tofu/runner.ts`) | No |
| Policy bundle path | `DEFAULT_POLICY_WASM` and `ZENITH_POLICY_WASM` in `src/lib/policy/engine.ts` | No |
| Broker store selection | `defaultStore` and `isMemoryStoreEnabled` in `src/lib/capabilities/platform.ts` | No |
| Browser origin for approvals | `src/app/api/platform/v1/_lib/browser.ts` | No |
| Runner result sealing key | `createResultSealerFromEnv` in `src/lib/runners/seal.ts` | No |
| Zenith-managed provider substrate | `readSubstrateConfig` in `src/lib/providers/zenith/substrate.ts` | No |

A variable that `env()` validates makes the **product** refuse to start when it
is malformed, even on an install that never uses the platform. Conversely, the
Temporal, worker, tofu and policy variables are checked only when their module
is used.

A variable is consumed when the named path runs. The tables describe readers,
not evidence that a production process has run with that configuration.

### 2.2 Platform store

| Variable | Default | Secret | Consumed on this branch | Meaning |
|---|---|---|---|---|
| `ZENITH_PLATFORM_DB` | `postgres` when a URL is set, otherwise `pglite` | no | app composition, broker/runner routes, worker, migrations, tests | `pglite` or `postgres`. Naming `postgres` without a URL is an error that says which variable to set. |
| `ZENITH_PLATFORM_DB_URL` | falls back to `SUPABASE_DB_URL` | **yes** (carries the password) | app composition, broker/runner routes, worker, migrations, tests | `postgres://` or `postgresql://` URI. For Supavisor use its transaction-pooler URI (port 6543); prepared statements are disabled and the store uses no session state or advisory locks. Pooler/TLS operation is not verified here. |
| `ZENITH_PLATFORM_DB_MAX` | `5` | no | same | Connection pool size, integer 1 to 100. Postgres only. |
| `ZENITH_DATA` | `<cwd>/.data` | no | same | PGlite files live in `<ZENITH_DATA>/platform-pg`. One process per directory: PGlite has no cross-process locking. |
| `SUPABASE_DB_URL` | unset | **yes** | the product store, and as the fallback above | Supabase's own name for the same connection string. |

In a production build (`NODE_ENV=production`) the broker **refuses** to use a store that
was not configured explicitly (no `ZENITH_PLATFORM_DB`, no URL): it answers
`platform_store_unavailable` instead of defaulting to a PGlite directory on the host's
disk. Local development still defaults to PGlite.

The code sets no `ssl` option on the connection. If your database requires TLS,
put it in the URL (for example `?sslmode=require`); the driver reads it from
there. This was not exercised against a TLS-only server here.

### 2.3 Workload identity and control-plane signing

Full reference, including what each key is for and how to rotate it:
[`src/lib/credentials/OPERATIONS.md`](../../../src/lib/credentials/OPERATIONS.md).
Summary:

| Variable | Secret | Needed where | Meaning |
|---|---|---|---|
| `ZENITH_OIDC_ISSUER` | no | every process that **mints** tokens (the worker) and, unless the request origin is right, the web app | Issuer URL, for example `https://app.example.com/api/oidc`. https only (http for localhost). Customers pin this URL in their IAM OIDC provider, so **changing it means every connected account must redeploy its bootstrap stack**. |
| `ZENITH_OIDC_SIGNING_JWK` | **yes** | see below | RS256 private JWK, JSON or base64 of JSON. |
| `ZENITH_OIDC_KMS_KEY_ID` | no | see below | AWS KMS key id, ARN or alias (RSA_2048 or larger, `SIGN_VERIFY`). Use this in production: the private key never leaves KMS. |
| `ZENITH_OIDC_EXTRA_PUBLIC_JWKS` | no | wherever the JWKS is served | Extra **public** keys to publish during rotation. A private key here is refused. |
| `ZENITH_CONTROL_SIGNING_JWK` | **yes** | the signer of grants and jobs (web / broker) | Ed25519 private JWK. Signs capability grants, runner jobs and machine requests. |
| `ZENITH_CONTROL_KMS_KEY_ID` | no | same | KMS alternative for the control key. **Not verified against real KMS** (Ed25519 via `ED25519_SHA_512`). |
| `ZENITH_CONTROL_EXTRA_PUBLIC_JWKS` | no | every **verifier** (the worker, runners) | Extra public Ed25519 keys accepted when verifying grants. A verifier needs the signer's public key: either the signer configuration or this. |
| `AWS_REGION` / `AWS_DEFAULT_REGION` | no | KMS signers | Region hint for the default KMS client when the key id is not an ARN. |

Rules the loader enforces: setting both the JWK and the KMS variable for the same
key family is an error; the OIDC key must be RS256 and the control key Ed25519,
so one cannot be loaded as the other; a private member in an `EXTRA_PUBLIC`
value is rejected outright.

Two placement consequences that follow from the code, not from a preference:

1. **The JWKS route needs a signer.** `GET /api/oidc/jwks` publishes the signing
   key's public half, derived from the configured signer. With no signer
   configured it answers `503 oidc_not_configured`. There is no public-key-only
   configuration for the OIDC key. So the process that serves the route (the web
   app) needs `ZENITH_OIDC_SIGNING_JWK` (a private key on the web host) **or**
   `ZENITH_OIDC_KMS_KEY_ID` with permission to call `kms:GetPublicKey` (no private
   key on the web host; this is the reason to prefer KMS).
2. **Token minting happens in the worker.** The credential broker runs inside
   activities, so the worker also needs the OIDC signer and `ZENITH_OIDC_ISSUER`
   (the minter has no request to derive the origin from).

The AWS SDK's default credential chain supplies the credentials for KMS calls
(`KMSClient` is built with only a region), and for `aws_assume_role` connections
the broker calls STS with Zenith's own default chain. Neither path has been run
against a real account.

### 2.4 Temporal

Read by `temporalConfigFromEnv`, for **both** the web app's client and the worker.

| Variable | Default | Secret | Meaning |
|---|---|---|---|
| `ZENITH_TEMPORAL_ADDRESS` | `localhost:7233` | no | Frontend `host:port`. |
| `ZENITH_TEMPORAL_NAMESPACE` | `default` | no | Namespace. Must already exist. |
| `ZENITH_TEMPORAL_API_KEY` | unset | **yes** | Temporal Cloud API key. Setting it forces TLS. Never logged; `describeTemporalConfig` reports only "set" or "unset". |
| `ZENITH_TEMPORAL_TLS` | `false` | no | `true` or `1` forces TLS without an API key, with the SDK's default TLS settings. There is no option for a custom CA or for client certificates (mTLS is not wired). |

Payload encryption uses the shared `ZENITH_SECRET_KEY` and decrypt-only
`ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS`, documented in the worker table below.
Both the web client and worker configure the codec in `src/lib/workflows/codec.ts`;
production client creation refuses a missing key. See section 5.3 for rotation.

### 2.5 Execution worker

Read by `executionWorkerConfigFromEnv`. Details and defaults:
[EXECUTION-WORKER.md](../EXECUTION-WORKER.md#configuration).

| Variable | Default | Meaning |
|---|---|---|
| `ZENITH_WORKER_TASK_QUEUE` | `zenith-execution` | Task queue to poll. **Leave it alone.** The control plane's client starts workflows on the constant `zenith-execution`; there is no environment variable on the client side, so a worker polling another queue would never receive anything. |
| `ZENITH_WORKER_MAX_CONCURRENT_ACTIVITIES` | `8` | Parallel activities **per replica** (1 to 1000). Each `tofu` plan or apply spawns provider processes; lower this before you let the kernel kill one mid-apply. |
| `ZENITH_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS` | `40` | Parallel workflow tasks (1 to 1000). |
| `ZENITH_WORKER_SHUTDOWN_GRACE_MS` | `600000` | How long running activities may finish after SIGTERM before they are cancelled. Set the container's stop timeout **above** this. |
| `ZENITH_WORKER_HEARTBEAT_THROTTLE_MS` | `10000` | Longest gap between heartbeats reaching Temporal; bounds how long a cancel takes to reach a running activity (100 to 60000). |
| `ZENITH_WORKER_WORKFLOW_BUNDLE` | unset | Path to a prebuilt workflow bundle. The image sets it to `/app/dist/execution/workflow-bundle.js`; unset, the worker bundles the TypeScript at start-up (development). |
| `ZENITH_WORKER_LOG_LEVEL` | `INFO` | `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`. |
| `ZENITH_WORKER_HEALTH_LOG_INTERVAL_MS` | `60000` | Period of the `health` log line; `0` disables. The HTTP endpoints are on `ZENITH_WORKER_HEALTH_PORT`. |
| `ZENITH_WORKER_IDENTITY` | `zenith-exec-<host>-<pid>` (sanitised, at most 64 characters) | Worker identity shown in Temporal and used in every lease holder: 1-64 letters, digits, `.`, `_` or `-`; any other explicit value is refused at startup. |
| `ZENITH_WORKER_HEALTH_PORT` | `9464` | Loopback port for `/healthz` (process up) and `/readyz` (Temporal, platform store, policy bundle, drivers). |
| `ZENITH_WORKER_PLAN_MAX_AGE_HOURS` | `24` | The plan janitor deletes binary plans of terminal operations older than this; plans of active operations are never touched. |
| `ZENITH_WORKER_PLAN_DIR` | `<ZENITH_DATA or .data>/platform-plans` | Worker-local binary plan directory, resolved to an absolute path and created with mode `0700`. Keep it private; binary plans may contain secrets. Cross-replica filesystem access and Windows ACL equivalence are not verified. |
| `ZENITH_SECRET_KEY` | unset | **Secret**, required: 64 hex characters. `derivePlanFingerprintKey` uses HKDF-SHA256 with `zenith.tofu.plan.fingerprint.v1`; there is no public default. The key also protects product vault secrets and encrypts Temporal workflow payloads (AES-256-GCM, HKDF info `zenith.temporal.payload.v1`); give the web app and cooperating workers the same key and back it up separately. |
| `ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS` | unset | **Secret**, optional: a JSON array of earlier 64-hex `ZENITH_SECRET_KEY` values. Payloads carry a key id; after rotating `ZENITH_SECRET_KEY`, list the old keys here (on the web app and every worker) so workflow histories written under them still decode. A malformed value is refused at startup. |

### 2.6 OpenTofu engine

The Azure machine transport supplies `ZENITH_ARGV_B64` (protected, base64 JSON
argv), `ZENITH_CWD` (protected working directory) and `ZENITH_TIMEOUT_SEC`
(bounded execution time) as per-command guest parameters. They are internal
inputs to the fixed collector, not operator configuration on the control plane
or worker. Request values remain data; they are never interpolated into a script.

| Variable | Default | Meaning |
|---|---|---|
| `ZENITH_TOFU_BIN` | `tofu` found on `PATH` | Absolute path to the binary. The runner refuses any binary whose `tofu version -json` is not exactly the pinned `1.12.5` (`TOFU_VERSION` in `src/lib/tofu/types.ts`). The worker image installs 1.12.5 at `/usr/local/bin/tofu`, checksum-verified at build time. |
| `ZENITH_TOFU_PLUGIN_CACHE` | `<os tmp>/zenith-tofu-plugin-cache` | Absolute path of the shared provider plugin cache. The image's default lands in `/tmp`, which is lost whenever the container is replaced, so every new container re-downloads providers (the lockfile script notes about 160 MB per platform for the AWS provider). Pointing this at a persistent volume avoids that; this recommendation has not been tried. |

These are read from the **worker's** environment, but the child `tofu` process
never sees them: the runner builds the child environment from an
allowlist (`src/lib/tofu/env.ts`), and refuses `ZENITH_*`, `TF_CLI_ARGS*`,
`TF_LOG*`, `TF_VAR_*` and `TF_REATTACH_PROVIDERS` from any session or extra
configuration. No `ZENITH_*` variable, database URL or signing key can reach a
provider plugin.

The worker needs outbound HTTPS to `registry.opentofu.org` and the hosts the
registry points to for provider packages. `tofu init` runs with
`-lockfile=readonly`, so only the exact builds in the committed lockfiles
(`src/lib/tofu/locks/*.terraform.lock.hcl`) install.

The runner's own default wall-clock limit per command is 30 minutes
(`DEFAULT_LIMITS` in `src/lib/tofu/runner.ts`) while the workflow allows an apply
activity 60 minutes. The composed apply activity (`src/lib/execution/apply.ts`)
does not override that limit: long applies can be cut at 30 minutes and must
retain an uncertain outcome.

#### Ephemeral database credentials

`TofuFragment.ephemeral` is assembled as an `ephemeral` block in
`src/lib/tofu/workspace.ts`; temporary addresses never join state-backed resource
plans. A sensitive attribute alone is not a safe password sink. Azure MySQL
fresh creation uses ephemeral `random_password`, Key Vault `value_wo` and an
ephemeral Key Vault read feeding `administrator_password_wo`. The stored secret
is reused on retries/replacement and only its reference/version is exported
(`src/lib/providers/azure/drivers/data/mysql-bootstrap.ts`). Password values
are designed to stay out of OpenTofu plans/state; no live database apply was
verified in this sync.

AWS RDS uses service-managed master credentials (`manage_master_user_password`)
and exports only the Secrets Manager reference
(`src/lib/providers/aws/drivers/data/rds-compile.ts`). GCP Cloud SQL and Azure
Postgres use IAM/Entra authentication without a configured password
(`src/lib/providers/gcp/drivers/data/cloud-sql-instance.ts`,
`src/lib/providers/azure/drivers/data/postgres.ts`). Do not replace these paths
with literal password attributes or read a secret into a persistent data block.

OCI MySQL **creation remains disabled**: pinned `oracle/oci` 9.7.1 accepts
`admin_password` but has no proven `admin_password_wo` or provider-side Vault
reference. Fetching a Vault bundle into that attribute would persist the secret.
The driver has observe/runtime/verify/discover only and no compile method
(`src/lib/providers/oci/drivers/data/mysql.ts`). Gated provider-schema and
plan/state checks, rather than a suffix or mocked fixture alone, must prove a
safe path before creation can be enabled.

### 2.7 Policy engine

| Variable | Default | Meaning |
|---|---|---|
| `ZENITH_POLICY_WASM` | `<cwd>/policy/dist/policy.wasm` | Path of the compiled bundle. A missing, empty or tampered bundle makes `loadPolicyEngine()` reject with `PolicyLoadError`; callers must treat that as "deny everything". |

How the bundle ships:

- `next.config.ts` traces `policy/dist/**` into every route that evaluates policy
  (`outputFileTracingIncludes`), so a serverless build carries the bundle and its
  manifest. Checked by `tests/server/appwire-policy-bundle.test.ts`; no Vercel build
  has been run.
- `docker/worker.Dockerfile` copies `policy/dist/` into the worker's runtime image at
  the path the engine resolves, so the `evaluatePolicy` activity loads the same bundle.
  Not built with Docker here.
- Either way `ZENITH_POLICY_WASM` overrides the path; a missing or tampered bundle still
  makes the broker refuse everything (`policy_unavailable`), never allow.

### 2.8 Capability broker, approvals and the agent routes

| Variable | Default | Secret | Meaning |
|---|---|---|---|
| `ZENITH_PLATFORM_BROKER_MEMORY` | unset | no | `1` makes the broker use a per-process in-memory store. Tests and local development **only**: state is lost on restart and two instances share nothing. Never set it in production. Without it the broker uses the platform store and answers `platform_store_unavailable` when it cannot open it; it never falls back to memory silently. |
| `ZENITH_PLATFORM_ORIGIN` | `ZENITH_AGENT_ORIGIN`, then the request's own origin | no | The exact origin a browser approval, rejection or admin-setting request must come from: the `Origin` header must equal it (no prefix, no subdomain, not `null`) and `Sec-Fetch-Site`, when the browser sends it, must be `same-origin`. Set it to your public origin in production. |
| `ZENITH_RUNNER_RESULT_KEY` | derived from `ZENITH_CONTROL_SIGNING_JWK` | **yes** | base64url, 32 bytes. Seals runner and `zenithd` job results at rest (AES-256-GCM, bound to the workspace and job id), because a result can carry exactly what must never be stored in the clear (an AWS response body, a plan with sensitive values). Unset, the key is derived (HKDF-SHA256) from the private scalar of the local control signing JWK; with a KMS-backed control signer it **must** be set. Whoever opens results, an activity in the worker, needs the same key as the routes that seal them. Rotating it, or the signing key it was derived from, makes results still in flight unreadable; their operations end `uncertain`. |

Identity is not new configuration: browsers use the product's Supabase setup
([RUNNING.md](../../RUNNING.md#supabase-auth-and-test-accounts)), and integration
callers use the product's `za_` credentials, verified against its credential authority
on every request, so revocation is immediate. The broker signs grants with the control
signing key (section 2.3).

What the broker enforces beyond the Rego rules, from `src/lib/capabilities/evaluate.ts`
(guards that only tighten): `plan_required` (an `infrastructure.apply` or `destroy`
without the reviewed plan from the execution side is denied) and `agent_autonomy_too_low`
(an agent cannot create a mutating proposal in an environment below autonomy 2).
A policy engine that cannot load, or a stored workspace policy that does not validate, is
`policy_unavailable`: refused, never allowed. See [POLICY.md](POLICY.md).

### 2.9 Reconciliation tick

The controller itself reads no environment except one development switch; the route
that drives it is gated like every other tick route.

| Variable | Default | Secret | Meaning |
|---|---|---|---|
| `CRON_SECRET` | unset | **yes** | Bearer token for `/api/internal/tick/*` (the product's name for it; see [RUNNING.md](../../RUNNING.md#environment-variables)). Unset, the route answers 503 and runs nothing; a wrong bearer is 401. |
| `ZENITH_RECONCILE_MEMORY` | unset | no | `1` runs the pass against an in-memory backend that is empty unless something seeded it. Local development and route smoke tests only: nothing is durable. |

`src/lib/platform/app.ts` registers the production ports with
`wireReconcilePorts`. The route calls `ensurePlatformCron` after verifying its
bearer, so an unconfigured or incompatible store still yields
`platform_store_unavailable`; it never reports an unobserved fleet as healthy.

`.github/workflows/tick.yml` sends authenticated POSTs every five minutes,
including `/api/internal/tick/reconcile`. Set the repository's `CRON_SECRET`
to the same secret as the deployment, and use its dispatch `base_url` input
for a different origin. `vercel.json` only schedules the daily keepalive; a
long-lived host still needs to arrange reconcile POSTs. Scheduled Actions run
on the default branch; this configuration is not proof that a tick ran live.

The ordinary cron passes also call `platformRunnerReaperPass`, which expires
runner/machine jobs and marks their owning operations uncertain in a transaction.
The ledger backstop `reconcileOperations` (overdue proposals expire, lapsed running operations
become uncertain) runs in the leased housekeeping pass (`src/lib/platform/housekeeping.ts`),
triggered by the jobs tick with `?housekeeping=1`, together with idempotency-key and nonce pruning.

Reconciliation is paced by a backoff ladder (5, 15, 60, then 180
minutes while nothing changes; open drift never backs off past 60 minutes and an
open incident never past 15), with deterministic jitter and a per-pass budget of
about 20 seconds and at most a bounded number of environments; sandbox
environments and environments with no verified connection are not reconciled.
That is from `src/lib/reconcile/scheduler.ts` and `pass.ts`; none of it has run
against a fleet.

Repair proposals go through broker policy and approval. Allowed repairs call
`startDayTwo` in `src/lib/platform/reconcile.ts`; the controller itself performs
no mutation. Dispatch is not a successful repair: the execution capability path
can refuse unsupported work. The separate Temporal reconcile workflow remains
observe-only (`allowAutoRepair` reports `not_implemented`).

### 2.10 Tooling only (not runtime)

| Variable | Used by | Meaning |
|---|---|---|
| `ZENITH_OPA_BIN` | `npm run policy:build`, `policy:check` | Path to the OPA binary. Must be exactly 1.19.1. Default: `opa` on `PATH`. |

### 2.11 Modules that read no environment

The resource model (`src/lib/resources`), placement and cost (`src/lib/placement`),
the observability fabric (`src/lib/observability`), the incident engine
(`src/lib/incidents`), repository analysis (`src/lib/analysis`) and the merged AWS
network drivers (`src/lib/providers/aws/drivers`) read no environment variables.
Observability sources receive their clients and endpoints as arguments from the
broker session; the price catalog is a bundled JSON file.

### 2.12 Which component needs what

| Variable group | Web / API | Worker | Migration script |
|---|---|---|---|
| Platform store (`ZENITH_PLATFORM_DB*`, `ZENITH_DATA`) | yes | yes, explicitly configured | yes |
| OIDC issuer and signer | yes (serves the JWKS; needs a signer) | yes (mints tokens) | no |
| Control signing key | yes (signs grants/jobs) | yes, usable signer required at startup and for activity grants | no |
| Temporal connection | yes (client) | yes | no |
| `ZENITH_WORKER_*` | no | yes | no |
| Tofu variables | no | yes | no |
| Reconciliation tick (`CRON_SECRET`, `ZENITH_RECONCILE_MEMORY`) | yes (the route) | no | no |
| Policy bundle | yes (broker) | yes (execution broker) | no |
| `ZENITH_PLATFORM_BROKER_MEMORY` | development only | no | no |
| `ZENITH_PLATFORM_ORIGIN` | yes (browser approvals) | no | no |
| `ZENITH_RUNNER_RESULT_KEY` | yes (seals results) | yes, when an activity awaits runner jobs (opens them; must match) | no |
| `ZENITH_SECRET_KEY` | yes (product vault and Temporal payloads) | yes (plan fingerprints, vault and Temporal payloads) | no |
| `ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS` | when decrypting retained Temporal histories | same key set as the client | no |

### 2.13 Zenith-managed provider substrate

The `zenith` provider (`src/lib/providers/zenith`) reads **25 `ZENITH_MANAGED_*`
variables** in one function, `readSubstrateConfig`, and nothing else in that provider
reads the environment. They describe the platform's own cluster and services, not a
customer's. The authoritative table, with which are required and what each default is,
is [MANAGED-PLATFORM.md](../MANAGED-PLATFORM.md#configuration-zenith_managed_). Credentials
are `vault:` references, resolved at call time; an inline value (a PEM block, a kubeconfig
document) is refused by name. A missing required value makes the substrate
`configured: false` naming every missing variable, and a malformed one names the variable and
the problem; it never starts half-configured.

| Group | Variables |
|---|---|
| Cluster (required: server, kubeconfig reference, app domain) | `ZENITH_MANAGED_CLUSTER_SERVER`, `ZENITH_MANAGED_KUBECONFIG_REF`, `ZENITH_MANAGED_APP_DOMAIN`, `ZENITH_MANAGED_CLUSTER_CA_DATA`, `ZENITH_MANAGED_REGION` |
| Gateway and TLS | `ZENITH_MANAGED_GATEWAY_MODE`, `ZENITH_MANAGED_GATEWAY_CLASS`, `ZENITH_MANAGED_GATEWAY_NAMESPACE`, `ZENITH_MANAGED_GATEWAY_NAME`, `ZENITH_MANAGED_GATEWAY_LISTENER`, `ZENITH_MANAGED_INGRESS_CLASS`, `ZENITH_MANAGED_CLUSTER_ISSUER`, `ZENITH_MANAGED_INTERNAL_CIDRS` |
| Registry and object storage (optional) | `ZENITH_MANAGED_REGISTRY`, `ZENITH_MANAGED_OBJECT_STORAGE_ENDPOINT`, `ZENITH_MANAGED_OBJECT_STORAGE_BUCKET`, `ZENITH_MANAGED_OBJECT_STORAGE_PREFIX`, `ZENITH_MANAGED_OBJECT_STORAGE_REGION`, `ZENITH_MANAGED_OBJECT_STORAGE_CREDENTIAL_REF` |
| Managed database (optional) | `ZENITH_MANAGED_DB_PROVIDER`, `ZENITH_MANAGED_DB_API_BASE`, `ZENITH_MANAGED_DB_API_KEY_REF`, `ZENITH_MANAGED_DB_REGION`, `ZENITH_MANAGED_DB_ORG_ID`, `ZENITH_MANAGED_DB_EGRESS` |

The managed drivers are registered with the Kubernetes toolkit by
`src/lib/platform/drivers.ts`. Registration does not create a hosted cluster or
open a managed session: the platform credential contract has no `zenith` config.
No hosted substrate or tenant serving is verified here.

### 2.14 Customer state backends

`src/lib/execution/compile.ts` calls `backendForConnection` in
`src/lib/tofu/backends.ts`. Store these non-secret bootstrap identifiers on the
workspace's platform connection; credentials come only from the session/runner
environment and must never be written in backend configuration.

| Provider | Backend and required connection fields | State location / limit |
|---|---|---|
| AWS | `s3`: `stateBucket`, connection `region`; optional `stateKmsKeyArn` | Existing key remains `zenith/<workspace>/<environment>/terraform.tfstate`. Uses state locking; the optional KMS ARN configures OpenTofu state/plan encryption. |
| GCP | `gcs`: `stateBucket`; optional `stateKmsKey` | Prefix `zenith/<workspace>/<environment>`; the default workspace object is `default.tfstate`, not `terraform.tfstate`. |
| Azure | `azurerm`: `stateStorageAccount`, `stateContainer` | Key `zenith/<workspace>/<environment>/terraform.tfstate`; Entra auth, CLI auth disabled, OIDC enabled for OIDC connections. |
| OCI | S3-compatible: `stateBucket`, `stateNamespace`, connection `region` | Oracle-only endpoint `https://<namespace>.compat.objectstorage.<region>.oraclecloud.com`, path style and compatibility flags; no AWS KMS. Customer S3 secret key stays on the runner. Native principals used by `oci.http` cannot authenticate this backend. Platform OCI sessions go through the runner (`oci.http`), never through control-plane credentials. |
| Kubernetes | No automatic durable backend | An explicit execution backend override is required; no local fallback is silently selected. |

Unsafe scope segments, foreign-workspace connections, missing fields and
unsupported providers are refused. `src/lib/tofu/backend-config.ts` rejects
credential fields and arbitrary OCI endpoints. Provision and back up the state
storage before dispatching; backend locking, encryption and restore against
live providers are **not verified** here.

### 2.15 Operator CLI

`npm run cli -- --help` runs the existing `src/cli/bin.ts` entry point;
`package.json` also declares `bin.zenith`. See [CLI.md](../CLI.md) for login,
operation/event polling, proposal/check, browser approval links and exact-digest
execution. `ZENITH_URL`, `ZENITH_TOKEN` (**secret**) and `ZENITH_WORKSPACE` are
CLI-only inputs; no implicit server URL is selected. Approval happens in the
browser, never from a token or a yes in chat. MCP v3 has fifteen tools; its
complete catalog and scopes are in [MCP.md](../MCP.md#tool-catalog).

`ZENITH_CLI_ACL_PATH` and `ZENITH_CLI_ACL_ACTION` are internal variables passed
to the CLI's fixed Windows ACL helper (`src/cli/config.ts`). The CLI assigns
them itself; they are not operator configuration or authentication material.

## 3. The platform database

### 3.1 Choosing

| Where | Use | Migrations |
|---|---|---|
| Local development and tests | PGlite (Postgres compiled to WebAssembly, in process). Nothing to install. | Applied automatically when it opens. |
| Production and anything shared | PostgreSQL 16 through the pooler. | **You** apply them. The application never runs DDL against Postgres. |

### 3.2 Migrating

```bash
npm run migrate:platform                 # apply pending migrations
npm run migrate:platform -- --status     # print the ledger; exit 1 unless current
npm run migrate:platform -- --dry-run    # list what would be applied
npm run migrate:platform -- --url postgres://...   # target this database, not the environment's
```

The target is decided exactly as the application decides it (the variables in
section 2.2), and `.env.local` is read when present. The connection string is
never printed, only host, port and database name. Exit codes: 0 ok, 1 not
current or refused, 2 usage error.

What makes this safe to run from CI and by hand, at the same time if need be:
each migration and its ledger row (`platform.schema_migrations`: version, name,
checksum) commit in one transaction under a table lock, so two migrators
serialise and the loser finds the work done. A migration whose recorded checksum
differs from the code is refused (`schema_tampered`): shipped migrations are
never edited, a change is a new migration.

If you would rather apply SQL yourself (the Supabase SQL editor, `psql`), apply
`supabase/migrations/0014_platform_core.sql`. It is **generated** from the
TypeScript migrations by `npm run platform:emit-sql` (`-- --check` fails when it
is out of date; a test enforces byte equality). It is idempotent, writes the same
ledger rows with the same checksums (so the TypeScript migrator recognises it as
applied), turns row level security on for every table with no policies, and
revokes `anon` and `authenticated`. **`platform` must never be added to the Data
API's exposed schemas.**

Five migrations exist today: `core` (1), `reconcile` (2), `machine_requests` (3,
the `zenithd` request queue), `approval_rounds` (4: a plan-level approval after
execution starts opens a new approval round, so the same human can review again once
per round while earlier decisions stay as immutable history) and `read_jobs` (5:
runner read jobs, such as OCI log and metric reads, that belong to no operation and
store a NULL operation). A database that applied the emitted SQL before a later
migration landed is behind and the application refuses to use it until you re-apply
the file or run `npm run migrate:platform`.

The emitted file keeps one name as migrations are added; it grows. If you apply
migrations through the Supabase CLI's migration history, which records an applied
file by its version number and will not re-run a changed file, use
`npm run migrate:platform` (ledger-based) or apply the file by hand for any
schema version after the first. The emitted file holds all five
migrations, so a database that applied it before migration 2, 3, 4 or 5 landed is exactly
this case. I did not exercise it through the Supabase CLI.

### 3.3 What the application does about the schema

On first use of a Postgres store, `platformDb()` calls `assertPlatformSchemaCurrent`
once. If the ledger is missing or a migration is pending it **fails closed** with
the command to run ("Nothing was read or written"). A database *ahead* of the
build (a newer deploy already migrated) is accepted, because refusing would break
every rolling deploy. The order that follows: **migrate first, then roll out the
new application**; an older build keeps working against a newer, additive schema.
Older code rolling back after a migration is safe only as long as migrations stay
additive; there are no down migrations.

### 3.4 Retention

Resource observations keep the latest 100 per resource; drift reports keep the
latest 50 per environment. The leased housekeeping pass
(`src/lib/platform/housekeeping.ts`) prunes expired idempotency keys and old
request nonces and runs `reconcileOperations`. The jobs tick with
`?housekeeping=1` and the in-process slow scheduler call it
(`src/lib/server/cron.ts`, `.github/workflows/tick.yml`). Repository pruning uses
`FOR UPDATE SKIP LOCKED` and rechecks expiry before deletion, so a refreshed
replay record is not removed (`src/lib/controlplane/db/repos/idempotency.ts`,
`src/lib/controlplane/db/repos/nonces.ts`). The worker's separate plan janitor
removes eligible old local binary plans (section 6.2). Nothing prunes events,
evidence, operations, approvals, policy decisions, grants or runner jobs; capacity
and audit retention for those tables remain operator responsibilities.

## 4. Signing keys

Generate them as described in
[`src/lib/credentials/OPERATIONS.md`](../../../src/lib/credentials/OPERATIONS.md#generating-keys)
(one `tsx` one-liner per key; KMS commands for production). Then:

- store the private JSON in the platform's secret manager or your host's
  encrypted environment, never in the repository, a manifest, a chat or a ticket;
- give the web app and the worker the variables in section 2.3 as that table
  says;
- confirm the public endpoints from outside:

```bash
curl -s https://<host>/api/oidc/.well-known/openid-configuration | jq .
curl -s https://<host>/api/oidc/jwks | jq '.keys[] | {kid, alg, kty}'
```

Both paths are public by design and are allowed through the session middleware in
`src/middleware.ts` on this branch. A `401` or a login redirect there would stop
AWS from creating or using the OIDC provider.

Rotation is in [RECOVERY.md](RECOVERY.md#6-key-rotation).

## 5. Temporal

### 5.1 Locally

```powershell
# 1. a local Temporal: in-memory, no UI
temporal server start-dev --headless --port 7233

# 2. the worker, from the repo root (reads .env.local if present)
$env:ZENITH_TEMPORAL_ADDRESS = "127.0.0.1:7233"
npm run worker
```

If something else on your machine already listens on 7233, pick another port and
give the same address to the worker and to the app. The dev server keeps history
**in memory**: stopping it loses every workflow. Add `--db-filename <path>` to
keep it in a file.

Before this command, supply the configuration in section 6.2, run the migrations
and select a spare Temporal port (do not reuse another project's server). A
ready worker prints `execution worker ready`, then a health line every minute.
It registers composed activities; a workflow may invoke external APIs. No
worker/cloud run is claimed by this docs sync.

### 5.2 In production

| | Temporal Cloud | Self-hosted |
|---|---|---|
| What you set | `ZENITH_TEMPORAL_ADDRESS=<namespace>.<account>.tmprl.cloud:7233`, `ZENITH_TEMPORAL_NAMESPACE=<namespace>.<account>`, `ZENITH_TEMPORAL_API_KEY` | `ZENITH_TEMPORAL_ADDRESS` (and `ZENITH_TEMPORAL_TLS=true` if the frontend serves TLS with a publicly trusted certificate) |
| Authentication | API key only; it forces TLS. mTLS is not wired. | None in this configuration: no API key and no client certificates. Put it on a private network. |
| History | Held by Temporal; retention is a namespace setting. | Held in the database you run under it. Backing that up is yours. |
| What was verified | Nothing live. There is no Cloud account on the build machine; the option shapes follow the SDK's documented API-key and TLS options. | The dev server, locally. No production-shaped cluster. |
| Cost of operating | A subscription. | A cluster and its database to run, patch and back up. ADR-0009 names a Postgres-native engine as the fallback if this proves disproportionate. |

### 5.3 Payload encryption and rotation

`src/lib/workflows/codec.ts` encrypts complete protobuf payloads and their
original metadata with **AES-256-GCM**, a fresh nonce and an HKDF-derived key.
Both `src/lib/workflows/client.ts` and `workers/execution/worker.ts` configure
`temporalDataConverterFromEnv`. Use the same 64-hex `ZENITH_SECRET_KEY` and
previous-key set on clients and workers. Production refuses missing/invalid
keys; development clients without a key can read/write plaintext, but worker
startup still requires the key. Legacy plaintext histories remain readable.

Set `ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS` to a private JSON array of previous
64-hex keys. New writes use only the current key; previous keys decrypt retained
histories. Coordinate clients and workers during a key change, retaining all
keys needed for active workflows, retries, replay and archives. Removing a key
makes its payloads unreadable; histories are not automatically re-encrypted.
Changing this shared key also affects the product vault and plan fingerprints;
the Temporal previous-key option does not migrate either. See
[RECOVERY.md](RECOVERY.md#6-key-rotation) before rotating.

Workflow ids, task queues, visibility/search attributes and default failure
messages/stack traces are outside payload encryption. Keep the ids-only and
redaction contracts: no credentials, secret values, plan files or raw provider
responses in workflow history. No UI/CLI codec server is supplied. Live Temporal
Cloud acceptance and encrypted production recovery were not run here; the
implementation and local replay gate are described in
[EXECUTION-WORKER.md](../EXECUTION-WORKER.md#payload-encryption).

## 6. The execution worker

### 6.1 Image

```bash
docker build -f docker/worker.Dockerfile -t zenith-execution-worker .
```

Node 22.16 (base image pinned by tag and digest), OpenTofu 1.12.5 (pinned by
version and SHA-256; the build fails on an empty or wrong checksum), the bundled
worker and a prebuilt workflow bundle. It runs as a non-root user and exposes
loopback health probes (section 6.2); external connections are to Temporal, the
database and the clouds. It uses `tini`
as PID 1 so SIGTERM reaches the worker and orphaned provider processes are
reaped.

**Status: written and command-checked, never built.** Docker is not available on
the machine it was authored on. The esbuild bundle command, the workflow-bundle
build and `node dist/execution/worker.cjs` booting against a Temporal dev server
were run; `docker build`, the `apt` and OpenTofu downloads inside it, the Linux
`@swc/core` binding and `npm ci --omit=dev` from the Dockerfile were not.

### 6.2 Running it

- Before polling, `workers/execution/startup.ts` requires an explicit
  `ZENITH_TEMPORAL_ADDRESS`, a valid 64-hex `ZENITH_SECRET_KEY`, a usable control
  signer (`ZENITH_CONTROL_SIGNING_JWK` or `ZENITH_CONTROL_KMS_KEY_ID`) and an
  explicitly configured platform store. It opens that store and checks schema;
  missing/behind/incompatible schema produces fixed guidance to run
  `npm run migrate:platform`. No stub fallback is registered.
- Supply the OIDC issuer/signer for federated sessions, matching runner result
  sealing keys where needed, the policy bundle and product-store configuration.
  Secrets arrive at run time; none is baked into the image. Startup does not
  verify cloud deploy permissions or every provider session.
- `ZENITH_WORKER_IDENTITY` is optional: the default (`zenith-exec-<host>-<pid>`) already satisfies
  the lease-holder rule (1–64 letters, digits, dots, underscores or hyphens). Set a stable value
  if you want the same identity across restarts; an invalid value stops the worker at startup.
- Read-only root filesystem works with `/tmp` and `/var/lib/zenith` writable
  (OpenTofu working directories and the plugin cache go to the temp directory).
- Stop timeout: set the orchestrator's stop timeout (Kubernetes
  `terminationGracePeriodSeconds`, Docker `--stop-timeout`) **above**
  `ZENITH_WORKER_SHUTDOWN_GRACE_MS`, or the worker is killed in the middle of an
  activity. On SIGTERM the worker stops polling and lets running activities
  finish for that long, then cancels them; a second signal exits immediately.
- Replicas: workers poll the same task queue; one queue serves every tenant.
  Binary plans live in `ZENITH_WORKER_PLAN_DIR` and later activities may run on
  another replica. Shared plan access and replica failover are not verified;
  do not infer safe multi-replica operation from workflow durability alone.
- **The product store.** The composed activities (`src/lib/execution`) read an
  operation's context from the product store and write the deployment projection back
  (`createProductPort`). So a worker that runs them needs the product store as the web app
  does: `ZENITH_STORE=postgres` with the Supabase keys ([RUNNING.md](../../RUNNING.md#running-on-vercel-with-postgres)).
  The file store is single-writer and cannot be shared between the web app and a worker.
  (From the port's header; not exercised.)
- Memory: `tofu` plans and applies are memory-hungry. The worker doc's rule of
  thumb of about 1 GiB per concurrent activity is an unmeasured guess.
- Health: `workers/execution/health.ts` listens on `127.0.0.1`, default port
  `9464` (`ZENITH_WORKER_HEALTH_PORT`). `/healthz` returns 200 for process
  liveness; `/readyz` returns 200 only when Temporal and the store are reachable,
  policy is loaded and all six providers have registered drivers, otherwise 503.
  Checks are bounded to two seconds and return only `ok`, `unavailable` or
  `unknown`, never configuration or raw errors. Readiness does not verify cloud
  permissions. Probe from inside the container; a remote pod probe cannot reach
  this loopback listener. JSON health logs and Temporal pollers remain useful.
- Plans: `src/lib/execution/plan-janitor.ts` runs immediately and every five
  minutes, scanning at most 100 entries per pass. Only regular digest-named
  `.tfplan` files older than `ZENITH_WORKER_PLAN_MAX_AGE_HOURS` (default 24) whose
  **every** known owner is terminal can be removed. Unowned/active plans and
  symlinks are retained; store failures cannot authorize deletion. Ownership
  and file metadata are rechecked, but plan producers do not take the janitor
  lease, so the last writer/unlink race and replica sharing remain unverified.

What happens when a worker dies mid-operation is in
[RECOVERY.md](RECOVERY.md#4-what-happens-to-an-operation-when-something-crashes).

## 7. The web / API control plane

- The Next app serves `/api/oidc/*` and `/api/platform/v1/*` (the broker and the
  agent routes; section 1 and the status table list them) and `/api/agent/v3/mcp`
  (MCP v3, [MCP.md](../MCP.md)). `/platform` provides operations,
  environments/resources/drift/incidents, workspace policy, AWS connection setup
  and placement. Reads show persisted evidence and timestamps; refresh does not
  claim a fresh cloud read. See `src/app/(product)/platform/README.md`.
- **How the agent and integration routes get past the session middleware.** Browser
  routes (approve, reject, autonomy and policy writes, runner/machine administration)
  need a signed-in session, which the middleware enforces. Runner and `zenithd` calls
  (registration, poll, heartbeat, result, logs) are let through by exact path
  (`src/lib/runners/paths.ts`) and authenticate with their request signature.
  Integration calls are let through only for the exact method/path pairs classified
  `bearer-capable` in `src/app/api/platform/v1/_lib/bearer-paths.ts`, and only with a
  `Bearer` header; the route then verifies the `za_` credential before waitlist
  admission or any tenant read. A new route fails `tests/middleware` until it is
  classified. From tests; not reproduced against a live Supabase.
- Set `ZENITH_PLATFORM_ORIGIN` (or `ZENITH_AGENT_ORIGIN`) to your public origin:
  approvals demand an exact `Origin` match, and the fallback is the request's own origin.
- The broker needs a platform database URL in production (section 2.2), the control
  signing key (section 2.3) and the policy bundle (section 2.7).
- Route handlers that start or signal workflows must declare the Node runtime
  (`export const runtime = "nodejs"`); the Temporal client is a gRPC client.
- `@temporalio/client`, `@temporalio/worker`, `@electric-sql/pglite` and
  `@open-policy-agent/opa-wasm` are in `serverExternalPackages` already.
- The web app does not need the `tofu` binary, the worker variables, or
  `ZENITH_TOFU_*`.

## 8. Order of operations for a first install

1. Create the platform database; apply migrations (`npm run migrate:platform`,
   or the emitted SQL). Check with `-- --status`.
2. Generate the OIDC and control keys; store them as secrets (KMS for OIDC in
   production).
3. Deploy the web app with the variables in section 2.12 (including a platform
   database URL, the control signing key and `ZENITH_PLATFORM_ORIGIN`); verify the two
   OIDC URLs from outside. Bundle tracing and classified middleware paths are
   implemented (sections 2.7 and 7); deployment behavior remains unverified here.
4. Stand up Temporal (Cloud namespace, or your cluster) and confirm the namespace
   exists.
5. Build and run the worker; confirm `execution worker ready` and pollers in
   Temporal.
6. Connect a customer AWS account in `/platform/connections/aws`:
   [AWS-SETUP.md](AWS-SETUP.md). This uses the browser action adapter; observe-role
   identity verification does not verify deploy permissions.
7. Configure authenticated reconcile ticks (section 2.9), then review placement
   and any operation in the browser before dispatch. Missing matching plan
   artifacts keep plan-bound UI approval disabled.

## 9. What was and was not verified

Historical WS-DOCS run record (before this sync, Windows 11, Node 24.19;
not rerun or independently verified here):

- `npm run migrate:platform` and `-- --status` against an empty PGlite directory
  (migrations 1 and 2 applied; migration 3 landed afterwards and was exercised only by the
  repository's own suites; status current) and
  `npm run platform:emit-sql -- --check`.
- `npm run policy:check`: OPA 1.19.1, 205 of 205 Rego tests pass and the committed
  bundle matches a fresh build.
- `temporal server start-dev --headless` on a spare port and `npm run worker`
  against it: the worker compiled its workflows (with the esbuild fallback, because
  the `@swc/core` native binding does not load here), reported `execution worker
  ready` and kept logging `health` with state `RUNNING`.
- The migration ledger, leases, operations and `reconcileOperations` against a
  real PostgreSQL 16.15 (see [RECOVERY.md](RECOVERY.md#8-what-was-rehearsed)).
- The old worker boot record predates composition and used stub activities;
  it does not verify the current execution path.

This sync checks current wiring by reading the composition modules, worker,
cron, UI, placement and backend code and running `tests/docs` as recorded in the
handoff report. The drift assertions pin those calls and configuration fields.
No worker, provider API, migration, policy compiler or deployment was run here.

Written but **not run by me**: the platform CI lanes in `.github/workflows/ci.yml`
(`policy`, `tofu`, `go`, `workflows`, `platform-postgres`, `ledger`,
`supply-chain`) and `.github/workflows/live-acceptance.yml`. The lane that applies
the platform migrations with the production migrator and runs the control-store
suites with `ZENITH_TEST_PLATFORM_PG_URL` set is `platform-postgres`; it targets a
bare PostgreSQL 16.15 container, so it says nothing about Supabase's role graph,
PostgREST or pooler. `live-acceptance.yml` is dispatch-only and has never been
executed (no sandbox AWS account exists); until it has, nothing is `real`.

**Not verified**, and stated once here instead of hedged everywhere:

- Anything against a real AWS account: STS `AssumeRoleWithWebIdentity`, KMS
  `Sign` and `GetPublicKey` (Ed25519 in particular), IAM accepting Zenith's
  tokens, the bootstrap template applied for real.
- Temporal Cloud and API-key authentication; mTLS (not built); a production-shaped
  self-hosted cluster.
- `docker build` of the worker image; SIGTERM handling on Linux; behaviour of the
  worker under load.
- A TLS-only Postgres (the `sslmode` note in section 2.2); the Supabase CLI
  history note in section 3.2.
- The recommendation to put `ZENITH_TOFU_PLUGIN_CACHE` on a persistent volume.
- A Vercel deployment of any of this: no Vercel build was run for these modules.
- The REST routes over HTTP against a real Supabase identity provider, the
  integration bearer path, and the runner and `zenithd` registration and poll flow
  end to end with the Go agents.
